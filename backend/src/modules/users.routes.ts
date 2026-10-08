import { Router, type Request } from 'express'
import type { Employee, Role, User } from '@prisma/client'
import { z } from 'zod'
import { istToday } from '../lib/dates.js'
import { ApiError, handler, ok } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { rateLimit } from '../lib/rateLimit.js'
import { hashPassword, requireSession, type Session } from '../platform/auth.js'
import { writeAudit } from '../platform/audit.js'
import { passwordProblem } from '../platform/password.js'
import { VISIBLE_ROLES, VISIBLE_ROLE_CODES } from '../platform/rbac/modules.js'
import type { RoleCode } from '../platform/rbac/matrix.js'

/**
 * USERS — logins, managed by Admin and Super Admin (Settings → Users).
 *   GET   /api/users                          users + employees without a login
 *   GET   /api/users/roles                    roles the caller may assign
 *   POST  /api/users                          new employee + login
 *   POST  /api/users/from-employee/:id        login for an existing employee
 *   PATCH /api/users/:id                      role / active
 *   POST  /api/users/:id/reset-password       temporary password
 *
 * The Super Admin is invisible to everyone else: never listed, a 404 as a
 * target, and its role is never offered.
 */
export const usersRouter = Router()

const SUPER_ADMIN: RoleCode = 'md'
const ADMIN_ROLES: RoleCode[] = ['md', 'hr_admin']

function requireAdmin(req: Request): Session {
  const s = requireSession(req)
  if (!ADMIN_ROLES.includes(s.roleCode)) throw ApiError.forbidden('Only Admin or Super Admin can manage users.')
  return s
}

const isSuper = (s: Session) => s.roleCode === SUPER_ADMIN

type UserWithRole = User & { role: Role; employee: Employee | null }

function userToApi(u: UserWithRole) {
  return {
    id: u.id,
    email: u.email,
    full_name: u.employee?.fullName ?? null,
    role: { id: u.role.id, code: u.role.code, name: u.role.name },
    is_active: u.isActive,
    last_login_at: u.lastLoginAt?.toISOString() ?? null,
    employee_id: u.employeeId,
    must_change_password: u.mustChangePassword,
  }
}

function checkTempPassword(pw: string) {
  const p = passwordProblem(pw)
  if (p) throw ApiError.badRequest(p, { temp_password: [p] })
}

async function assignableRole(s: Session, roleId: string): Promise<Role> {
  const role = await prisma.role.findUnique({ where: { id: roleId } })
  const allowed = role && !role.deletedAt && VISIBLE_ROLE_CODES.includes(role.code as RoleCode)
    && (role.code !== SUPER_ADMIN || isSuper(s))
  if (!allowed) throw ApiError.badRequest('Choose a valid role.', { role_id: ['Choose a valid role.'] })
  return role
}

async function visibleTarget(s: Session, id: string): Promise<UserWithRole> {
  const u = await prisma.user.findFirst({ where: { id, deletedAt: null }, include: { role: true, employee: true } })
  if (!u || (u.role.code === SUPER_ADMIN && !isSuper(s))) throw ApiError.notFound('User not found.')
  return u
}

async function assertEmailFree(email: string, exceptEmployeeId?: string) {
  const [user, employee] = await Promise.all([
    prisma.user.findFirst({ where: { email } }),
    prisma.employee.findFirst({ where: { email, ...(exceptEmployeeId ? { id: { not: exceptEmployeeId } } : {}) } }),
  ])
  if (user || employee) throw ApiError.conflict('email_taken', 'A user with this email already exists.')
}

async function nextEmployeeCode(): Promise<string> {
  let n = (await prisma.employee.count()) + 1
  for (;;) {
    const code = `AO-${String(n).padStart(4, '0')}`
    if (!(await prisma.employee.findUnique({ where: { employeeCode: code } }))) return code
    n += 1
  }
}

usersRouter.get('/', handler(async (req, res) => {
  const s = requireAdmin(req)
  const users = await prisma.user.findMany({
    where: { deletedAt: null, ...(isSuper(s) ? {} : { role: { code: { not: SUPER_ADMIN } } }) },
    include: { role: true, employee: true },
    orderBy: { createdAt: 'asc' },
  })
  const withoutLogin = await prisma.employee.findMany({
    where: { deletedAt: null, status: { not: 'inactive' }, user: { is: null } },
    orderBy: { fullName: 'asc' },
    select: { id: true, fullName: true, email: true },
  })
  ok(res, {
    items: users.map(userToApi),
    employees_without_login: withoutLogin.map((e) => ({ id: e.id, full_name: e.fullName, email: e.email })),
  })
}))

usersRouter.get('/roles', handler(async (req, res) => {
  const s = requireAdmin(req)
  const codes = VISIBLE_ROLES.map((r) => r.code).filter((c) => c !== SUPER_ADMIN || isSuper(s))
  const rows = await prisma.role.findMany({ where: { code: { in: codes }, deletedAt: null } })
  const order = new Map(codes.map((c, i) => [c, i]))
  rows.sort((a, b) => (order.get(a.code as RoleCode) ?? 0) - (order.get(b.code as RoleCode) ?? 0))
  ok(res, { items: rows.map((r) => ({ id: r.id, code: r.code, name: r.name })) })
}))

const createSchema = z.object({
  first_name: z.string().trim().min(1, 'Enter a first name.'),
  last_name: z.string().trim().min(1, 'Enter a last name.'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  phone: z.string().trim().optional(),
  joining_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').optional(),
  role_id: z.string().min(1, 'Choose a role.'),
  temp_password: z.string(),
})

usersRouter.post('/', handler(async (req, res) => {
  const s = requireAdmin(req)
  const parsed = createSchema.safeParse(req.body ?? {})
  if (!parsed.success) throw ApiError.badRequest('Check the highlighted fields.', parsed.error.flatten().fieldErrors)
  const b = parsed.data
  checkTempPassword(b.temp_password)
  const role = await assignableRole(s, b.role_id)
  await assertEmailFree(b.email)

  const org = await prisma.organisation.findFirstOrThrow({ where: { deletedAt: null } })
  const schedule = await prisma.workSchedule.findFirst({ where: { deletedAt: null } })
  if (!schedule) throw ApiError.unprocessable('no_work_schedule', 'Set up a work schedule before adding users.')
  const employeeCode = await nextEmployeeCode()

  const user = await prisma.$transaction(async (tx) => {
    const employee = await tx.employee.create({
      data: {
        organisationId: org.id, employeeCode,
        firstName: b.first_name, lastName: b.last_name, fullName: `${b.first_name} ${b.last_name}`,
        status: 'active', workScheduleId: schedule.id, email: b.email, phone: b.phone ?? '',
        joiningDate: b.joining_date ?? istToday(), weeklyCapacityHours: 40,
        createdBy: s.userId, updatedBy: s.userId,
      },
    })
    return tx.user.create({
      data: {
        organisationId: org.id, email: b.email, passwordHash: hashPassword(b.temp_password),
        roleId: role.id, employeeId: employee.id, mustChangePassword: true,
        createdBy: s.userId, updatedBy: s.userId,
      },
      include: { role: true, employee: true },
    })
  })
  await writeAudit({
    actorUserId: s.userId, action: 'user.created', entityType: 'User', entityId: user.id,
    after: { email: user.email, role: role.code, employee_id: user.employeeId }, req,
  })
  ok(res, { user: userToApi(user) }, 201)
}))

const loginSchema = z.object({ role_id: z.string().min(1, 'Choose a role.'), temp_password: z.string() })

usersRouter.post('/from-employee/:employeeId', handler(async (req, res) => {
  const s = requireAdmin(req)
  const parsed = loginSchema.safeParse(req.body ?? {})
  if (!parsed.success) throw ApiError.badRequest('Check the highlighted fields.', parsed.error.flatten().fieldErrors)
  checkTempPassword(parsed.data.temp_password)
  const role = await assignableRole(s, parsed.data.role_id)
  const employee = await prisma.employee.findFirst({
    where: { id: req.params.employeeId, deletedAt: null }, include: { user: true },
  })
  if (!employee) throw ApiError.notFound('Employee not found.')
  if (employee.user) throw ApiError.conflict('has_login', 'This employee already has a login.')
  const email = employee.email.trim().toLowerCase()
  await assertEmailFree(email, employee.id)

  const user = await prisma.user.create({
    data: {
      organisationId: employee.organisationId, email, passwordHash: hashPassword(parsed.data.temp_password),
      roleId: role.id, employeeId: employee.id, mustChangePassword: true,
      createdBy: s.userId, updatedBy: s.userId,
    },
    include: { role: true, employee: true },
  })
  await writeAudit({
    actorUserId: s.userId, action: 'user.created', entityType: 'User', entityId: user.id,
    after: { email, role: role.code, employee_id: employee.id }, req,
  })
  ok(res, { user: userToApi(user) }, 201)
}))

const patchSchema = z.object({ role_id: z.string().min(1).optional(), is_active: z.boolean().optional() })

usersRouter.patch('/:id', handler(async (req, res) => {
  const s = requireAdmin(req)
  const parsed = patchSchema.safeParse(req.body ?? {})
  if (!parsed.success) throw ApiError.badRequest('Check the highlighted fields.', parsed.error.flatten().fieldErrors)
  const target = await visibleTarget(s, req.params.id)
  if (target.id === s.userId) {
    throw ApiError.conflict('self', 'You cannot change your own role or deactivate yourself.')
  }

  const data: { roleId?: string; isActive?: boolean; sessionVersion?: { increment: number }; updatedBy: string } = { updatedBy: s.userId }
  let newRole: Role | null = null
  if (parsed.data.role_id && parsed.data.role_id !== target.roleId) {
    newRole = await assignableRole(s, parsed.data.role_id)
    data.roleId = newRole.id
  }
  if (parsed.data.is_active !== undefined && parsed.data.is_active !== target.isActive) {
    data.isActive = parsed.data.is_active
    // Deactivating ends every open session at once.
    if (!parsed.data.is_active) data.sessionVersion = { increment: 1 }
  }

  const user = await prisma.user.update({ where: { id: target.id }, data, include: { role: true, employee: true } })
  if (newRole) {
    await writeAudit({
      actorUserId: s.userId, action: 'user.role_changed', entityType: 'User', entityId: user.id,
      before: { role: target.role.code }, after: { role: newRole.code }, req,
    })
  }
  if (data.isActive !== undefined) {
    await writeAudit({
      actorUserId: s.userId, action: data.isActive ? 'user.activated' : 'user.deactivated',
      entityType: 'User', entityId: user.id, req,
    })
  }
  ok(res, { user: userToApi(user) })
}))

const resetSchema = z.object({ temp_password: z.string() })

usersRouter.post('/:id/reset-password', handler(async (req, res) => {
  const s = requireAdmin(req)
  if (!rateLimit(`pwreset:${s.userId}`, 10, 60_000)) throw ApiError.tooMany()
  const parsed = resetSchema.safeParse(req.body ?? {})
  if (!parsed.success) throw ApiError.badRequest('Enter a temporary password.', parsed.error.flatten().fieldErrors)
  checkTempPassword(parsed.data.temp_password)
  const target = await visibleTarget(s, req.params.id)
  if (target.id === s.userId) {
    throw ApiError.conflict('self_reset', 'Use Change password to change your own password.')
  }
  const user = await prisma.user.update({
    where: { id: target.id },
    data: {
      passwordHash: hashPassword(parsed.data.temp_password), mustChangePassword: true,
      sessionVersion: { increment: 1 }, updatedBy: s.userId,
    },
    include: { role: true, employee: true },
  })
  await writeAudit({
    actorUserId: s.userId, action: 'user.password_reset', entityType: 'User', entityId: user.id, req,
  })
  ok(res, { user: userToApi(user) })
}))
