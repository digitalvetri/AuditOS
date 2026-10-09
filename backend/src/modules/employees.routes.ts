import { randomInt } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { istToday } from '../lib/dates.js'
import { can, hashPassword, requireSession, type Session } from '../platform/auth.js'
import { passwordProblem } from '../platform/password.js'
import { assertCanAssignRole, assertCanManageLogin } from '../platform/roleRank.js'
import { writeAudit } from '../platform/audit.js'
import { notifyPermissionHolders } from '../platform/notify.js'
import { VISIBLE_ROLE_CODES } from '../platform/rbac/modules.js'
import type { RoleCode } from '../platform/rbac/matrix.js'
import {
  articledTrainingToApi, employeeDeptProjection, employeeFinanceProjection,
  employeeRef, employeeToApi,
} from '../api/serialize.js'

/**
 * EMPLOYEES + ARTICLED TRAINING (§8.1 / §9)
 *
 * Two rules carry most of the weight here:
 *   - The Finance projection (§5‡) is applied in the handler, never in the UI.
 *     Finance receives six fields and no others.
 *   - The self-edit allowlist (§5*) is contact fields only. Anything else
 *     from a non-HR caller is 422, not a silently ignored key.
 */
export const employeesRouter = Router()

type ReadScope = 'self' | 'department' | 'organisation' | 'finance'

function readScope(session: Session): ReadScope {
  if (can(session, 'employee.manage', 'organisation')) return 'organisation'
  if (can(session, 'employee.read', 'organisation')) return 'organisation'
  // Finance's restricted grant is a distinct scope so the handler knows to project.
  if (can(session, 'employee.read.restricted', 'organisation')) return 'finance'
  if (can(session, 'employee.read', 'department')) return 'department'
  return 'self'
}

const CONTACT_FIELDS = [
  'phone', 'address', 'emergency_contact_name', 'emergency_contact_phone', 'bank_account_masked',
] as const

/** What anyone may change on their own profile. Email and password are not here. */
const SELF_FIELDS = [...CONTACT_FIELDS, 'first_name', 'last_name'] as const

const HR_FIELDS = [
  ...CONTACT_FIELDS,
  'first_name', 'last_name', 'full_name', 'email', 'type', 'status',
  'designation_id', 'department_id', 'manager_id', 'work_location_id', 'work_schedule_id',
  'joining_date', 'exit_date', 'exit_reason', 'notice_period_days',
  'weekly_capacity_hours', 'photo_url',
] as const

/** snake_case request body → Prisma column names. One place, not per field. */
const COLUMN_OF: Record<string, string> = {
  phone: 'phone',
  address: 'address',
  emergency_contact_name: 'emergencyContactName',
  emergency_contact_phone: 'emergencyContactPhone',
  bank_account_masked: 'bankAccountMasked',
  first_name: 'firstName',
  last_name: 'lastName',
  full_name: 'fullName',
  email: 'email',
  type: 'type',
  status: 'status',
  designation_id: 'designationId',
  department_id: 'departmentId',
  manager_id: 'managerId',
  work_location_id: 'workLocationId',
  work_schedule_id: 'workScheduleId',
  joining_date: 'joiningDate',
  exit_date: 'exitDate',
  exit_reason: 'exitReason',
  notice_period_days: 'noticePeriodDays',
  weekly_capacity_hours: 'weeklyCapacityHours',
  photo_url: 'photoUrl',
}

async function todayAttendanceFor(employeeIds: string[]) {
  const rows = await prisma.attendance.findMany({
    where: { employeeId: { in: employeeIds }, date: istToday(), deletedAt: null },
  })
  return new Map(
    rows.map((a) => [
      a.employeeId,
      {
        status: a.status,
        check_in_at: a.checkInAt ? a.checkInAt.toISOString() : null,
        check_out_at: a.checkOutAt ? a.checkOutAt.toISOString() : null,
        worked_minutes: a.workedMinutes,
      },
    ]),
  )
}

type EmployeeRow = Awaited<ReturnType<typeof prisma.employee.findMany>>[number]

function project(scope: ReadScope, e: EmployeeRow, today: ReturnType<typeof todayAttendanceFor> extends Promise<infer M> ? M : never) {
  if (scope === 'finance') return employeeFinanceProjection(e)
  const base = scope === 'department' ? employeeDeptProjection(e) : employeeToApi(e)
  return { ...base, today_attendance: today.get(e.id) ?? null }
}

// GET /api/employees
employeesRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = readScope(session)
  const q = z.object({
    departmentId: z.string().optional(),
    designationId: z.string().optional(),
    type: z.string().optional(),
    status: z.string().optional(),
    managerId: z.string().optional(),
    joinedFrom: z.string().optional(),
    joinedTo: z.string().optional(),
    includeInactive: z.string().optional(),
    q: z.string().optional(),
  }).parse(req.query)

  if (q.joinedFrom && q.joinedTo && q.joinedFrom > q.joinedTo) {
    throw ApiError.unprocessable('invalid_range', 'joinedFrom must be on or before joinedTo.')
  }

  const where: Record<string, unknown> = {}
  if (scope === 'self') {
    if (!session.employeeId) return ok(res, { items: [], count: 0, scope })
    where.id = session.employeeId
  } else if (scope === 'department') {
    if (!session.departmentId) return ok(res, { items: [], count: 0, scope })
    where.departmentId = session.departmentId
  }

  // Soft-deleted / inactive rows are hidden unless HR or MD asks for them.
  const showInactive = q.includeInactive === 'true' && scope === 'organisation'
  if (!showInactive) {
    where.deletedAt = null
    where.status = { not: 'inactive' }
  }

  if (q.departmentId) where.departmentId = q.departmentId
  if (q.designationId) where.designationId = q.designationId
  if (q.type) where.type = q.type
  if (q.status) where.status = q.status
  if (q.managerId) where.managerId = q.managerId
  if (q.joinedFrom || q.joinedTo) {
    where.joiningDate = {
      ...(q.joinedFrom ? { gte: q.joinedFrom } : {}),
      ...(q.joinedTo ? { lte: q.joinedTo } : {}),
    }
  }
  if (q.q) {
    const term = q.q.trim()
    where.OR = [
      { fullName: { contains: term } },
      { email: { contains: term } },
      { employeeCode: { contains: term } },
    ]
  }

  const rows = await prisma.employee.findMany({ where, orderBy: { employeeCode: 'asc' } })
  const today = scope === 'finance' ? new Map() : await todayAttendanceFor(rows.map((r) => r.id))
  const items = rows.map((r) => project(scope, r, today))
  ok(res, { items, count: items.length, scope })
}))

// POST /api/employees — HR / MD
employeesRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'employee.manage', 'organisation')) {
    throw ApiError.forbidden('Only HR or MD can create employees.')
  }
  const body = z.object({
    first_name: z.string().min(1),
    last_name: z.string().min(1),
    email: z.string().email(),
    // Department + Designation were removed as concepts; FKs are nullable
    // in the Prisma schema and these are no longer required on create.
    department_id: z.string().optional(),
    designation_id: z.string().optional(),
    employee_code: z.string().optional(),
    type: z.string().optional(),
    status: z.string().optional(),
    manager_id: z.string().nullable().optional(),
    work_location_id: z.string().optional(),
    work_schedule_id: z.string().optional(),
    phone: z.string().optional(),
    joining_date: z.string().optional(),
    notice_period_days: z.number().optional(),
    weekly_capacity_hours: z.number().nullable().optional(),
    // The login created alongside; Super Admin is never handed out here.
    role_code: z.string().optional(),
    // Set by the admin, or generated when left blank.
    password: z.string().min(8, 'Password must be at least 8 characters.').max(128).optional(),
  }).safeParse(req.body ?? {})
  if (!body.success) {
    const fields = body.error.flatten().fieldErrors
    throw ApiError.badRequest(
      fields.password?.[0] ?? 'first_name, last_name and email are required.',
      body.error.flatten().fieldErrors,
    )
  }
  const b = body.data
  // Same rule as Settings → Users: letters and numbers, not just length.
  const typedProblem = b.password ? passwordProblem(b.password) : null
  if (typedProblem) throw ApiError.badRequest(typedProblem, { password: [typedProblem] })

  const email = b.email.trim().toLowerCase()
  const role = await assignableRole(b.role_code)
  // A Senior Associate may only hand out roles below their own.
  assertCanAssignRole(session, role.code)
  if (await prisma.user.findUnique({ where: { email } })) {
    throw ApiError.conflict('email_taken', 'A login with this email already exists.')
  }

  const org = await prisma.organisation.findFirstOrThrow({ where: { deletedAt: null } })
  const defaultSchedule = await prisma.workSchedule.findFirst({ where: { deletedAt: null } })
  const count = await prisma.employee.count()
  const password = b.password ?? generatePassword()

  // Employee and login together: an employee without a login can't sign in.
  const { row, login } = await prisma.$transaction(async (tx) => {
    const row = await tx.employee.create({
      data: {
        organisationId: org.id,
        employeeCode: b.employee_code ?? `AO-${String(count + 1).padStart(4, '0')}`,
        firstName: b.first_name,
        lastName: b.last_name,
        fullName: `${b.first_name} ${b.last_name}`,
        type: b.type ?? 'executive',
        status: b.status ?? 'probation',
        designationId: b.designation_id ?? null,
        departmentId: b.department_id ?? null,
        managerId: b.manager_id ?? null,
        workLocationId: b.work_location_id ?? null,
        workScheduleId: b.work_schedule_id ?? defaultSchedule?.id ?? '',
        email,
        phone: b.phone ?? '',
        joiningDate: b.joining_date ?? istToday(),
        noticePeriodDays: b.notice_period_days ?? 30,
        weeklyCapacityHours: b.weekly_capacity_hours ?? 40,
        createdBy: session.userId,
        updatedBy: session.userId,
      },
    })
    const login = await tx.user.create({
      data: {
        organisationId: org.id, email, passwordHash: hashPassword(password),
        // Admin-issued, so temporary: they choose their own at first sign-in.
        mustChangePassword: true,
        roleId: role.id, employeeId: row.id, createdBy: session.userId, updatedBy: session.userId,
      },
    })
    return { row, login }
  })
  await writeAudit({
    actorUserId: session.userId, action: 'employee.created', entityType: 'Employee', entityId: row.id,
    after: { code: row.employeeCode, name: row.fullName }, req,
  })
  // The password itself is never audited or stored in plain text.
  await writeAudit({
    actorUserId: session.userId, action: 'user.created', entityType: 'User', entityId: login.id,
    after: { email, role: role.code, employee_id: row.id }, req,
  })
  // Returned once so the admin can hand it over; it can't be fetched again.
  ok(res, {
    employee: employeeToApi(row),
    login: { email, role: role.name, password, generated: !b.password },
  })
}))

// PUT /api/employees/:id/password  { password?, role_code? }
// The admin sets (or resets) an employee's password; blank generates one.
// An employee with no login yet gets one here, with role_code (default
// Associate). Only a Super Admin may set a Super Admin's password.
employeesRouter.put('/:id/password', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'employee.manage', 'organisation')) {
    throw ApiError.forbidden('Only an Admin can set passwords.')
  }
  const body = z.object({
    password: z.string().min(8, 'Password must be at least 8 characters.').max(128).optional(),
    role_code: z.string().optional(),
  }).safeParse(req.body ?? {})
  if (!body.success) {
    const fields = body.error.flatten().fieldErrors
    throw ApiError.badRequest(fields.password?.[0] ?? 'Invalid password.', fields)
  }
  const typed = body.data.password ? passwordProblem(body.data.password) : null
  if (typed) throw ApiError.badRequest(typed, { password: [typed] })

  const target = await prisma.employee.findUnique({ where: { id: req.params.id } })
  if (!target || target.deletedAt) throw ApiError.notFound('Employee not found.')
  const existing = await prisma.user.findFirst({
    where: { employeeId: target.id, deletedAt: null }, include: { role: true },
  })
  // Only logins the caller outranks (Super Admin: only by a Super Admin). 404
  // rather than 403 so the hidden Super Admin is never confirmed to exist.
  if (existing) assertCanManageLogin(session, existing.role.code)

  const password = body.data.password ?? generatePassword()
  let login
  if (existing) {
    login = await prisma.user.update({
      where: { id: existing.id },
      // Temporary, and every open session of theirs ends (same as Settings → Users).
      data: {
        passwordHash: hashPassword(password), mustChangePassword: true,
        sessionVersion: { increment: 1 }, updatedBy: session.userId,
      },
      include: { role: true },
    })
  } else {
    const role = await assignableRole(body.data.role_code)
    assertCanAssignRole(session, role.code)
    const email = target.email.trim().toLowerCase()
    if (await prisma.user.findUnique({ where: { email } })) {
      throw ApiError.conflict('email_taken', 'Another login already uses this email.')
    }
    login = await prisma.user.create({
      data: {
        organisationId: target.organisationId, email, passwordHash: hashPassword(password),
        mustChangePassword: true,
        roleId: role.id, employeeId: target.id, createdBy: session.userId, updatedBy: session.userId,
      },
      include: { role: true },
    })
  }
  await writeAudit({
    actorUserId: session.userId, action: existing ? 'user.password_set' : 'user.created',
    entityType: 'User', entityId: login.id,
    after: { email: login.email, role: login.role.code, employee_id: target.id }, req,
  })
  ok(res, {
    created: !existing,
    login: { email: login.email, role: login.role.name, password, generated: !body.data.password },
  })
}))

/** A role a new login may be given; Super Admin is never handed out. */
async function assignableRole(code: string | undefined) {
  const roleCode = code ?? 'employee'
  const role = roleCode === 'md' || !VISIBLE_ROLE_CODES.includes(roleCode as RoleCode)
    ? null
    : await prisma.role.findFirst({ where: { code: roleCode, deletedAt: null } })
  if (!role) throw ApiError.badRequest('Pick a valid role.', { role_code: ['Pick a valid role.'] })
  return role
}

/** 12 characters without look-alikes (0/O, 1/l/I), so it can be read out. */
function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  for (;;) {
    let out = ''
    for (let i = 0; i < 12; i++) out += chars[randomInt(chars.length)]
    if (!passwordProblem(out)) return out // always letters and numbers
  }
}

// GET /api/employees/:id
employeesRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = readScope(session)
  const target = await prisma.employee.findUnique({ where: { id: req.params.id } })
  if (!target) throw ApiError.notFound('Employee not found.')

  const allowed =
    scope === 'organisation' || scope === 'finance' ||
    (scope === 'department' && session.departmentId === target.departmentId) ||
    (scope === 'self' && session.employeeId === target.id)
  if (!allowed) throw ApiError.forbidden()

  const [dept, designation, manager, location, login] = await Promise.all([
    target.departmentId ? prisma.department.findUnique({ where: { id: target.departmentId } }) : null,
    target.designationId ? prisma.designation.findUnique({ where: { id: target.designationId } }) : null,
    target.managerId ? prisma.employee.findUnique({ where: { id: target.managerId } }) : null,
    target.workLocationId ? prisma.workLocation.findUnique({ where: { id: target.workLocationId } }) : null,
    prisma.user.findFirst({ where: { employeeId: target.id, deletedAt: null }, include: { role: true } }),
  ])
  const today = scope === 'finance' ? new Map() : await todayAttendanceFor([target.id])

  ok(res, {
    employee: project(scope, target, today),
    // Reference joins are display labels — safe at every scope.
    refs: {
      department: dept ? { id: dept.id, name: dept.name } : null,
      designation: designation ? { id: designation.id, name: designation.name } : null,
      manager: employeeRef(manager),
      location: location ? { id: location.id, name: location.name } : null,
      role: login ? { id: login.role.id, code: login.role.code, name: login.role.name } : null,
    },
  })
}))

// PUT /api/employees/:id/role  { role_id }
// Moves the employee's login to another role (Super Admin … Intern). Settings
// managers only; nobody changes their own role, so a click can't lock them out.
employeesRouter.put('/:id/role', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'settings.manage', 'organisation')) throw ApiError.forbidden()
  const body = z.object({ role_id: z.string().min(1) }).safeParse(req.body ?? {})
  if (!body.success) throw ApiError.badRequest('role_id is required.')

  const login = await prisma.user.findFirst({
    where: { employeeId: req.params.id, deletedAt: null }, include: { role: true },
  })
  if (!login) throw ApiError.unprocessable('no_login', 'This employee has no login account.')
  if (login.id === session.userId) {
    throw ApiError.conflict('self_role', 'You cannot change your own role.')
  }
  // Only logins the caller outranks, and only to roles the caller may hand
  // out — never Super Admin unless the caller is one.
  assertCanManageLogin(session, login.role.code)
  const role = await prisma.role.findUnique({ where: { id: body.data.role_id } })
  if (!role || role.deletedAt || !VISIBLE_ROLE_CODES.includes(role.code as RoleCode)) {
    throw ApiError.notFound('Role not found.')
  }
  assertCanAssignRole(session, role.code)

  await prisma.user.update({ where: { id: login.id }, data: { roleId: role.id, updatedBy: session.userId } })
  await writeAudit({
    actorUserId: session.userId, action: 'user.role_changed', entityType: 'User', entityId: login.id,
    before: { role: login.role.code }, after: { role: role.code }, req,
  })
  ok(res, { role: { id: role.id, code: role.code, name: role.name } })
}))

// PATCH /api/employees/:id
employeesRouter.patch('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const target = await prisma.employee.findUnique({ where: { id: req.params.id } })
  if (!target) throw ApiError.notFound('Employee not found.')
  if (target.deletedAt) throw ApiError.conflict('inactive', 'This employee record is inactive.')

  const canManage = can(session, 'employee.manage', 'organisation')
  const isOwn = session.employeeId === target.id
  if (!canManage && !isOwn) {
    throw ApiError.forbidden('Only HR/MD or the employee themself can edit this record.')
  }

  const body = (req.body ?? {}) as Record<string, unknown>
  const keys = Object.keys(body)

  if (!canManage) {
    const disallowed = keys.filter((k) => !(SELF_FIELDS as readonly string[]).includes(k))
    if (disallowed.length) {
      throw ApiError.unprocessable(
        'employment_fields_hr_only', 'Only an Admin can change your email, password or employment details.', { disallowed },
      )
    }
  } else {
    const invalid = keys.filter((k) => !(HR_FIELDS as readonly string[]).includes(k))
    if (invalid.length) {
      throw ApiError.unprocessable('unknown_fields', 'Unknown fields in request.', { invalid })
    }
  }

  for (const k of ['first_name', 'last_name'] as const) {
    if (k in body && (typeof body[k] !== 'string' || !(body[k] as string).trim())) {
      throw ApiError.badRequest('First and last name are required.', { [k]: ['Required.'] })
    }
    if (k in body) body[k] = (body[k] as string).trim()
  }

  // The login signs in with this email, so it moves with the employee record.
  const login = await prisma.user.findFirst({
    where: { employeeId: target.id, deletedAt: null }, include: { role: true },
  })
  let newEmail: string | null = null
  if ('email' in body) {
    const parsed = z.string().email().safeParse(typeof body.email === 'string' ? body.email.trim() : body.email)
    if (!parsed.success) throw ApiError.badRequest('Enter a valid email.', { email: ['Enter a valid email.'] })
    body.email = parsed.data.toLowerCase()
    if (login && body.email !== login.email) {
      if (login.role.code === 'md' && session.roleCode !== 'md') {
        throw ApiError.forbidden("Only a Super Admin can change a Super Admin's email.")
      }
      if (await prisma.user.findUnique({ where: { email: body.email as string } })) {
        throw ApiError.conflict('email_taken', 'Another login already uses this email.')
      }
      newEmail = body.email as string
    }
  }

  const data: Record<string, unknown> = { updatedBy: session.userId }
  for (const k of keys) data[COLUMN_OF[k]] = body[k]
  if ('first_name' in body || 'last_name' in body) {
    data.fullName = `${(body.first_name as string) ?? target.firstName} ${(body.last_name as string) ?? target.lastName}`
  }

  const updated = await prisma.$transaction(async (tx) => {
    const emp = await tx.employee.update({ where: { id: target.id }, data })
    if (login && newEmail) {
      await tx.user.update({ where: { id: login.id }, data: { email: newEmail, updatedBy: session.userId } })
    }
    return emp
  })
  await writeAudit({
    actorUserId: session.userId,
    action: isOwn && !canManage ? 'employee.self_contact_updated' : 'employee.updated',
    entityType: 'Employee', entityId: target.id,
    before: employeeToApi(target), after: employeeToApi(updated), req,
  })
  // Someone renamed themselves: tell everyone who manages employees.
  if (isOwn && updated.fullName !== target.fullName) {
    await notifyPermissionHolders('employee.manage', {
      type: 'employee.name_changed', module: 'system', title: 'Profile name changed',
      body: `${target.fullName} changed their name to ${updated.fullName}.`,
      entityType: 'Employee', entityId: target.id, actionUrl: `/hrms/employees/${target.id}`,
    }, session.userId)
  }
  ok(res, { employee: employeeToApi(updated) })
}))

// POST /api/employees/:id/deactivate
employeesRouter.post('/:id/deactivate', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'employee.manage', 'organisation')) {
    throw ApiError.forbidden('Only HR or MD can deactivate.')
  }
  const target = await prisma.employee.findUnique({ where: { id: req.params.id } })
  if (!target) throw ApiError.notFound('Employee not found.')
  if (target.deletedAt) throw ApiError.conflict('already_inactive', 'Already inactive.')
  if (target.id === session.employeeId) {
    throw ApiError.unprocessable('self_deactivate', 'You cannot deactivate yourself.')
  }

  const now = new Date()
  const updated = await prisma.$transaction(async (tx) => {
    const emp = await tx.employee.update({
      where: { id: target.id },
      data: { status: 'inactive', deletedAt: now, updatedBy: session.userId },
    })
    // Session revocation: the linked login stops working immediately.
    await tx.user.updateMany({ where: { employeeId: target.id }, data: { isActive: false } })
    // Soft-leave every conversation: the person stops receiving chats, but
    // the history they contributed to stays intact.
    await tx.chatMember.updateMany({ where: { employeeId: target.id, leftAt: null }, data: { leftAt: now } })
    return emp
  })

  await writeAudit({
    actorUserId: session.userId, action: 'employee.deactivated', entityType: 'Employee', entityId: target.id,
    before: employeeToApi(target), after: employeeToApi(updated), req,
  })
  ok(res, { employee: employeeToApi(updated) })
}))

// GET /api/employees/:id/training
employeesRouter.get('/:id/training', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = readScope(session)
  const target = await prisma.employee.findUnique({ where: { id: req.params.id } })
  if (!target) throw ApiError.notFound('Employee not found.')

  const allowed =
    scope === 'organisation' ||
    (scope === 'department' && session.departmentId === target.departmentId) ||
    (scope === 'self' && session.employeeId === target.id)
  if (!allowed) throw ApiError.forbidden()

  // Genuinely does not exist for a non-Articled employee — 404, not empty 200.
  if (target.type !== 'articled') {
    throw new ApiError(404, 'not_articled', 'Training record only exists for Articled Assistants.')
  }
  const record = await prisma.articledTraining.findUnique({
    where: { employeeId: target.id }, include: { principal: true },
  })
  if (!record) throw ApiError.notFound('Training record not created yet.')

  ok(res, { training: articledTrainingToApi(record), principal: employeeRef(record.principal) })
}))

// PATCH /api/employees/:id/training
employeesRouter.patch('/:id/training', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'employee.manage', 'organisation')) {
    throw ApiError.forbidden('Only HR or MD can update training.')
  }
  const target = await prisma.employee.findUnique({ where: { id: req.params.id } })
  if (!target) throw ApiError.notFound('Employee not found.')
  if (target.type !== 'articled') {
    throw ApiError.unprocessable('not_articled', 'Training only applies to Articled Assistants.')
  }
  const b = z.object({
    icai_registration_no: z.string().optional(),
    principal_employee_id: z.string().optional(),
    training_start: z.string().optional(),
    training_end: z.string().optional(),
    current_year: z.number().int().min(1).max(3).optional(),
    stipend_slab: z.string().optional(),
    status: z.enum(['active', 'transferred', 'completed', 'terminated']).optional(),
  }).parse(req.body ?? {})

  const before = await prisma.articledTraining.findUnique({ where: { employeeId: target.id } })
  const data = {
    icaiRegistrationNo: b.icai_registration_no,
    principalEmployeeId: b.principal_employee_id,
    trainingStart: b.training_start,
    trainingEnd: b.training_end,
    currentYear: b.current_year,
    stipendSlab: b.stipend_slab,
    status: b.status,
  }
  if (!before && !b.principal_employee_id) {
    throw ApiError.badRequest('principal_employee_id is required to create a training record.')
  }

  const row = await prisma.articledTraining.upsert({
    where: { employeeId: target.id },
    update: { ...data, updatedBy: session.userId },
    create: {
      employeeId: target.id,
      icaiRegistrationNo: b.icai_registration_no ?? '',
      principalEmployeeId: b.principal_employee_id!,
      trainingStart: b.training_start ?? istToday(),
      trainingEnd: b.training_end ?? istToday(),
      currentYear: b.current_year ?? 1,
      stipendSlab: b.stipend_slab ?? '',
      status: b.status ?? 'active',
      createdBy: session.userId,
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'employee.training_updated',
    entityType: 'ArticledTraining', entityId: target.id,
    before: before ? articledTrainingToApi(before) : null, after: articledTrainingToApi(row), req,
  })
  ok(res, { training: articledTrainingToApi(row) })
}))
