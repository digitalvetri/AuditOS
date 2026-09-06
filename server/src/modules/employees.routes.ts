import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { istToday } from '../lib/dates.js'
import { can, requireSession, type Session } from '../platform/auth.js'
import { writeAudit } from '../platform/audit.js'
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
    department_id: z.string().min(1),
    designation_id: z.string().min(1),
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
  }).safeParse(req.body ?? {})
  if (!body.success) {
    throw ApiError.badRequest(
      'first_name, last_name, email, department_id and designation_id are required.',
      body.error.flatten().fieldErrors,
    )
  }
  const b = body.data

  const org = await prisma.organisation.findFirstOrThrow({ where: { deletedAt: null } })
  const [defaultLocation, defaultSchedule] = await Promise.all([
    prisma.workLocation.findFirst({ where: { deletedAt: null, isActive: true } }),
    prisma.workSchedule.findFirst({ where: { deletedAt: null } }),
  ])
  const count = await prisma.employee.count()

  const row = await prisma.employee.create({
    data: {
      organisationId: org.id,
      employeeCode: b.employee_code ?? `AO-${String(count + 1).padStart(4, '0')}`,
      firstName: b.first_name,
      lastName: b.last_name,
      fullName: `${b.first_name} ${b.last_name}`,
      type: b.type ?? 'executive',
      status: b.status ?? 'probation',
      designationId: b.designation_id,
      departmentId: b.department_id,
      managerId: b.manager_id ?? null,
      workLocationId: b.work_location_id ?? defaultLocation?.id ?? '',
      workScheduleId: b.work_schedule_id ?? defaultSchedule?.id ?? '',
      email: b.email,
      phone: b.phone ?? '',
      joiningDate: b.joining_date ?? istToday(),
      noticePeriodDays: b.notice_period_days ?? 30,
      weeklyCapacityHours: b.weekly_capacity_hours ?? 40,
      createdBy: session.userId,
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'employee.created', entityType: 'Employee', entityId: row.id,
    after: { code: row.employeeCode, name: row.fullName }, req,
  })
  ok(res, { employee: employeeToApi(row) })
}))

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

  const [dept, designation, manager, location] = await Promise.all([
    prisma.department.findUnique({ where: { id: target.departmentId } }),
    prisma.designation.findUnique({ where: { id: target.designationId } }),
    target.managerId ? prisma.employee.findUnique({ where: { id: target.managerId } }) : null,
    prisma.workLocation.findUnique({ where: { id: target.workLocationId } }),
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
    },
  })
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
    const disallowed = keys.filter((k) => !(CONTACT_FIELDS as readonly string[]).includes(k))
    if (disallowed.length) {
      throw ApiError.unprocessable(
        'employment_fields_hr_only', 'Only HR/MD can update employment fields.', { disallowed },
      )
    }
  } else {
    const invalid = keys.filter((k) => !(HR_FIELDS as readonly string[]).includes(k))
    if (invalid.length) {
      throw ApiError.unprocessable('unknown_fields', 'Unknown fields in request.', { invalid })
    }
  }

  const data: Record<string, unknown> = { updatedBy: session.userId }
  for (const k of keys) data[COLUMN_OF[k]] = body[k]
  if ('first_name' in body || 'last_name' in body) {
    data.fullName = `${(body.first_name as string) ?? target.firstName} ${(body.last_name as string) ?? target.lastName}`
  }

  const updated = await prisma.employee.update({ where: { id: target.id }, data })
  await writeAudit({
    actorUserId: session.userId,
    action: isOwn && !canManage ? 'employee.self_contact_updated' : 'employee.updated',
    entityType: 'Employee', entityId: target.id,
    before: employeeToApi(target), after: employeeToApi(updated), req,
  })
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
    // Close open chat memberships so a deactivated person leaves conversations.
    await tx.chatMember.updateMany({ where: { employeeId: target.id, deletedAt: null }, data: { deletedAt: now } })
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
