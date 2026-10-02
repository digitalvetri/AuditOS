import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { daysBetween, enumerateDates, istToday } from '../lib/dates.js'
import { computeWorkingDays } from '../domain/leaveDays.js'
import { can, requireSession, type Session } from '../platform/auth.js'
import { writeAudit } from '../platform/audit.js'
import { notifyEmployee, notifyRole } from '../platform/notify.js'
import { employeeRef, holidayToApi, leaveRequestToApi, leaveTypeToApi } from '../api/serialize.js'
import type { Scope } from '../platform/rbac/matrix.js'

/**
 * LEAVE (§8.3 / §9)
 *
 * Approval routing:
 *   ≤ 5 days  manager approves → approved
 *   > 5 days  manager approves (approver_id set, still pending)
 *             → HR approves (hr_approver_id set) → approved
 *
 * On approval: balance is deducted and On Leave attendance rows are written
 * across the range. Cancelling a future approved leave restores both.
 */
export const leaveRouter = Router()

function viewScope(session: Session): Scope {
  if (can(session, 'leave.manage', 'organisation')) return 'organisation'
  if (can(session, 'leave.read', 'organisation')) return 'organisation'
  if (can(session, 'leave.approve', 'organisation')) return 'organisation'
  if (can(session, 'leave.read', 'department')) return 'department'
  if (can(session, 'leave.approve', 'department')) return 'department'
  return 'self'
}

type RequestRow = Awaited<ReturnType<typeof prisma.leaveRequest.findMany>>[number]

function stageOf(r: RequestRow): 'awaiting_manager' | 'awaiting_hr' | 'terminal' {
  if (r.status !== 'pending') return 'terminal'
  return r.approverId ? 'awaiting_hr' : 'awaiting_manager'
}

async function computeDays(employeeId: string, startDate: string, endDate: string, halfDay: boolean) {
  const employee = await prisma.employee.findUniqueOrThrow({
    where: { id: employeeId }, include: { workSchedule: true },
  })
  const holidays = await prisma.holiday.findMany({ where: { deletedAt: null }, select: { date: true } })
  return computeWorkingDays({
    startISO: startDate,
    endISO: endDate,
    halfDay,
    schedule: {
      workingDays: JSON.parse(employee.workSchedule.workingDaysJson) as number[],
      alternateSaturdayOff: employee.workSchedule.alternateSaturdayOff,
    },
    holidayDates: new Set(holidays.map((h) => h.date)),
  })
}

/** Approved leave writes On Leave attendance rows across the range. */
async function upsertOnLeaveRows(employeeId: string, startDate: string, endDate: string, actorUserId: string) {
  for (const date of enumerateDates(startDate, endDate)) {
    await prisma.attendance.upsert({
      where: { employeeId_date: { employeeId, date } },
      update: {
        checkInAt: null, checkOutAt: null,
        checkInLat: null, checkInLong: null, checkInAccuracyM: null,
        checkOutLat: null, checkOutLong: null, checkOutAccuracyM: null,
        checkInLocationId: null, checkOutLocationId: null,
        locationType: null, offSiteReason: null,
        workedMinutes: null, breakMinutes: null,
        status: 'on_leave', source: 'manual', deletedAt: null, updatedBy: actorUserId,
      },
      create: {
        employeeId, date, status: 'on_leave', source: 'manual',
        createdBy: actorUserId, updatedBy: actorUserId,
      },
    })
  }
}

async function removeOnLeaveRows(employeeId: string, startDate: string, endDate: string) {
  await prisma.attendance.deleteMany({
    where: { employeeId, date: { in: enumerateDates(startDate, endDate) }, status: 'on_leave' },
  })
}

// GET /api/leaves/holidays
leaveRouter.get('/holidays', handler(async (_req, res) => {
  const rows = await prisma.holiday.findMany({ where: { deletedAt: null }, orderBy: { date: 'asc' } })
  ok(res, { items: rows.map(holidayToApi) })
}))

// GET /api/leaves/balances/:employeeId
leaveRouter.get('/balances/:employeeId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = viewScope(session)
  const target = await prisma.employee.findUnique({ where: { id: req.params.employeeId } })
  if (!target) throw ApiError.forbidden()

  const allowed =
    scope === 'organisation' ||
    (scope === 'department' && session.departmentId === target.departmentId) ||
    (scope === 'self' && session.employeeId === target.id)
  if (!allowed) throw ApiError.forbidden()

  const [types, balances, pending] = await Promise.all([
    prisma.leaveType.findMany({ where: { deletedAt: null }, orderBy: { code: 'asc' } }),
    prisma.leaveBalance.findMany({ where: { employeeId: target.id } }),
    prisma.leaveRequest.findMany({
      where: { employeeId: target.id, status: 'pending', deletedAt: null },
      select: { leaveTypeId: true, computedWorkingDays: true },
    }),
  ])

  const pendingByType = new Map<string, number>()
  for (const p of pending) {
    pendingByType.set(p.leaveTypeId, (pendingByType.get(p.leaveTypeId) ?? 0) + p.computedWorkingDays)
  }

  ok(res, {
    items: types.map((t) => {
      const b = balances.find((x) => x.leaveTypeId === t.id)
      return {
        type: leaveTypeToApi(t),
        entitled: b?.entitled ?? 0,
        availed: b?.availed ?? 0,
        carried_forward: b?.carriedForward ?? 0,
        pending: pendingByType.get(t.id) ?? 0,
      }
    }),
  })
}))

// GET /api/leaves
leaveRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = viewScope(session)
  const q = z.object({
    employeeId: z.string().optional(),
    status: z.string().optional(),
    scope: z.string().optional(),
  }).parse(req.query)

  const where: Record<string, unknown> = { deletedAt: null }
  if (scope === 'self') {
    if (!session.employeeId) return ok(res, { items: [], count: 0 })
    where.employeeId = session.employeeId
  } else if (scope === 'department') {
    where.employee = { departmentId: session.departmentId ?? '__none__' }
  }

  if (q.employeeId) {
    const target = await prisma.employee.findUnique({ where: { id: q.employeeId } })
    if (!target) throw ApiError.forbidden()
    if (scope === 'self' && target.id !== session.employeeId) throw ApiError.forbidden()
    if (scope === 'department' && target.departmentId !== session.departmentId) throw ApiError.forbidden()
    where.employeeId = q.employeeId
  }
  if (q.status) where.status = q.status

  let rows = await prisma.leaveRequest.findMany({
    where, include: { employee: true, leaveType: true }, orderBy: { startDate: 'desc' },
  })

  if (q.scope === 'queue') {
    const canOrg = can(session, 'leave.approve', 'organisation')
    const canDept = can(session, 'leave.approve', 'department')
    rows = rows.filter((r) => {
      if (r.status !== 'pending') return false
      const stage = stageOf(r)
      if (stage === 'awaiting_manager') {
        if (canOrg) return true
        return canDept && r.employee.departmentId === session.departmentId
      }
      // Second-stage approval is HR/MD only.
      return stage === 'awaiting_hr' && canOrg
    })
  }

  const items = rows.map((r) => ({
    ...leaveRequestToApi(r),
    employee: employeeRef(r.employee),
    type: { id: r.leaveType.id, name: r.leaveType.name, code: r.leaveType.code },
    stage: stageOf(r),
  }))
  ok(res, { items, count: items.length })
}))

// GET /api/leaves/:id
leaveRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = viewScope(session)
  const row = await prisma.leaveRequest.findUnique({
    where: { id: req.params.id }, include: { employee: true, leaveType: true },
  })
  if (!row) throw ApiError.notFound('Leave request not found.')

  const allowed =
    scope === 'organisation' ||
    (scope === 'department' && session.departmentId === row.employee.departmentId) ||
    session.employeeId === row.employeeId
  if (!allowed) throw ApiError.forbidden()

  ok(res, {
    request: {
      ...leaveRequestToApi(row),
      employee: employeeRef(row.employee),
      type: leaveTypeToApi(row.leaveType),
      stage: stageOf(row),
    },
  })
}))

// POST /api/leaves — apply
leaveRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  if (!session.employeeId) throw ApiError.unprocessable('no_employee', 'This account has no employee record.')
  const employee = await prisma.employee.findUniqueOrThrow({ where: { id: session.employeeId } })

  const parsed = z.object({
    leave_type_id: z.string().min(1),
    start_date: z.string().min(1),
    end_date: z.string().min(1),
    half_day: z.boolean().optional(),
    reason: z.string().trim().min(1),
  }).safeParse(req.body ?? {})
  if (!parsed.success) {
    throw ApiError.badRequest('leave_type_id, start_date, end_date and reason are required.')
  }
  const { leave_type_id, start_date, end_date, reason } = parsed.data
  const half_day = parsed.data.half_day ?? false

  if (start_date > end_date) {
    throw ApiError.unprocessable('invalid_range', 'End date must be on or after start date.')
  }
  const type = await prisma.leaveType.findUnique({ where: { id: leave_type_id } })
  if (!type) throw new ApiError(400, 'unknown_type', 'Unknown leave type.')

  if (!type.accrueDuringProbation && employee.status === 'probation') {
    throw ApiError.unprocessable('probation', `${type.name} leave is not available during probation.`)
  }
  if (half_day && !type.halfDayAllowed) {
    throw ApiError.unprocessable('half_day_not_allowed', `${type.name} does not allow half-day.`)
  }
  if (half_day && start_date !== end_date) {
    throw ApiError.unprocessable('half_day_range', 'Half-day requests must be for a single date.')
  }

  const today = istToday()
  const daysUntilStart = daysBetween(today, start_date)
  if (daysUntilStart < 0 && type.minNoticeDays > 0) {
    throw ApiError.unprocessable('past_date', `${type.name} cannot be applied for past dates.`)
  }
  if (daysUntilStart >= 0 && daysUntilStart < type.minNoticeDays) {
    throw ApiError.unprocessable(
      'insufficient_notice', `${type.name} requires at least ${type.minNoticeDays} day(s) of notice.`,
    )
  }

  const overlap = await prisma.leaveRequest.findFirst({
    where: {
      employeeId: employee.id, deletedAt: null,
      status: { in: ['pending', 'approved'] },
      startDate: { lte: end_date }, endDate: { gte: start_date },
    },
  })
  if (overlap) {
    throw ApiError.conflict('overlap', 'You already have a leave request that overlaps these dates.')
  }

  const days = await computeDays(employee.id, start_date, end_date, half_day)
  if (!Number.isFinite(days) || days <= 0) {
    throw ApiError.unprocessable('no_working_days', 'Selected range contains no working days.')
  }

  // LOP is unlimited; everything else checks the balance net of pending days.
  if (type.code !== 'lop') {
    const balance = await prisma.leaveBalance.findFirst({
      where: { employeeId: employee.id, leaveTypeId: type.id },
    })
    const pendingRows = await prisma.leaveRequest.findMany({
      where: { employeeId: employee.id, leaveTypeId: type.id, status: 'pending', deletedAt: null },
      select: { computedWorkingDays: true },
    })
    const pending = pendingRows.reduce((s, r) => s + r.computedWorkingDays, 0)
    const available = (balance?.entitled ?? 0) + (balance?.carriedForward ?? 0) - (balance?.availed ?? 0)
    if (days > available - pending) {
      throw ApiError.unprocessable(
        'insufficient_balance',
        `Insufficient ${type.name} balance. Available ${(available - pending).toFixed(1)}, requested ${days.toFixed(1)}.`,
      )
    }
  }

  const row = await prisma.leaveRequest.create({
    data: {
      employeeId: employee.id,
      leaveTypeId: type.id,
      startDate: start_date,
      endDate: end_date,
      halfDay: half_day,
      computedWorkingDays: days,
      reason: reason.trim(),
      createdBy: session.userId,
      updatedBy: session.userId,
    },
  })

  await writeAudit({
    actorUserId: session.userId, action: 'leave.requested',
    entityType: 'LeaveRequest', entityId: row.id,
    after: { type: type.code, start_date, end_date, days }, req,
  })
  if (employee.managerId) {
    await notifyEmployee(employee.managerId, {
      type: 'leave.requested', module: 'leave',
      title: 'Leave request to review',
      body: `${employee.fullName} requested ${days.toFixed(1)} day(s) ${type.name} from ${start_date}.`,
      entityType: 'LeaveRequest', entityId: row.id, actionUrl: '/hrms/leave?tab=queue',
    })
  }

  ok(res, {
    request: { ...leaveRequestToApi(row), type: leaveTypeToApi(type), stage: stageOf(row) },
  })
}))

// POST /api/leaves/:id/approve
leaveRouter.post('/:id/approve', handler(async (req, res) => {
  const session = requireSession(req)
  const row = await prisma.leaveRequest.findUnique({
    where: { id: req.params.id }, include: { employee: true, leaveType: true },
  })
  if (!row) throw ApiError.notFound('Leave request not found.')
  if (row.status !== 'pending') throw ApiError.conflict('not_pending', 'This request is no longer pending.')

  const canOrg = can(session, 'leave.approve', 'organisation')
  const canDept = can(session, 'leave.approve', 'department')
  if (!canOrg && !canDept) throw ApiError.forbidden()

  const stage = stageOf(row)
  const now = new Date()
  let becameApproved = false
  let updated = row

  if (stage === 'awaiting_manager') {
    const isManager = row.employee.managerId === session.employeeId
    if (!isManager && !canOrg) {
      throw ApiError.forbidden('Only the reporting manager (or HR/MD) can approve at this stage.')
    }
    becameApproved = row.computedWorkingDays <= 5
    updated = await prisma.leaveRequest.update({
      where: { id: row.id },
      data: {
        approverId: session.userId,
        updatedBy: session.userId,
        ...(becameApproved ? { status: 'approved', approvedAt: now } : {}),
      },
      include: { employee: true, leaveType: true },
    })
  } else {
    // Second stage — HR/MD only.
    if (!canOrg) throw ApiError.forbidden('Only HR or MD can complete this approval.')
    becameApproved = true
    updated = await prisma.leaveRequest.update({
      where: { id: row.id },
      data: { hrApproverId: session.userId, status: 'approved', approvedAt: now, updatedBy: session.userId },
      include: { employee: true, leaveType: true },
    })
  }

  if (becameApproved) {
    if (row.leaveType.code !== 'lop') {
      const balance = await prisma.leaveBalance.findFirst({
        where: { employeeId: row.employeeId, leaveTypeId: row.leaveTypeId },
      })
      if (balance) {
        await prisma.leaveBalance.update({
          where: { id: balance.id },
          data: { availed: balance.availed + row.computedWorkingDays },
        })
      }
    }
    await upsertOnLeaveRows(row.employeeId, row.startDate, row.endDate, session.userId)
  }

  await writeAudit({
    actorUserId: session.userId,
    action: becameApproved ? 'leave.approved' : 'leave.manager_approved',
    entityType: 'LeaveRequest', entityId: row.id,
    before: { status: row.status, approver_id: row.approverId },
    after: { became_approved: becameApproved, stage }, req,
  })

  if (becameApproved) {
    await notifyEmployee(row.employeeId, {
      type: 'leave.approved', module: 'leave', title: 'Leave approved',
      body: `Your ${row.leaveType.name} for ${row.startDate} to ${row.endDate} was approved.`,
      entityType: 'LeaveRequest', entityId: row.id, actionUrl: '/hrms/leave',
    })
  } else {
    await notifyRole('hr_admin', {
      type: 'leave.escalated', module: 'leave', title: 'Leave awaiting HR approval',
      body: `${row.employee.fullName} — ${row.computedWorkingDays.toFixed(1)} day(s), manager approved.`,
      entityType: 'LeaveRequest', entityId: row.id, actionUrl: '/hrms/leave?tab=queue',
    })
  }

  ok(res, {
    request: {
      ...leaveRequestToApi(updated),
      employee: employeeRef(updated.employee),
      type: leaveTypeToApi(updated.leaveType),
      stage: stageOf(updated),
    },
  })
}))

// POST /api/leaves/:id/reject
leaveRouter.post('/:id/reject', handler(async (req, res) => {
  const session = requireSession(req)
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
  if (!reason) throw ApiError.badRequest('A reason for rejection is required.')

  const row = await prisma.leaveRequest.findUnique({
    where: { id: req.params.id }, include: { employee: true, leaveType: true },
  })
  if (!row) throw ApiError.notFound('Leave request not found.')
  if (row.status !== 'pending') throw ApiError.conflict('not_pending', 'This request is no longer pending.')

  const canOrg = can(session, 'leave.approve', 'organisation')
  const canDept = can(session, 'leave.approve', 'department')
  const isManager = row.employee.managerId === session.employeeId
  const permitted = canOrg || (stageOf(row) === 'awaiting_manager' && canDept && isManager)
  if (!permitted) throw ApiError.forbidden()

  const updated = await prisma.leaveRequest.update({
    where: { id: row.id },
    data: { status: 'rejected', rejectionReason: reason, updatedBy: session.userId },
    include: { employee: true, leaveType: true },
  })

  await writeAudit({
    actorUserId: session.userId, action: 'leave.rejected',
    entityType: 'LeaveRequest', entityId: row.id, after: { reason }, req,
  })
  await notifyEmployee(row.employeeId, {
    type: 'leave.rejected', module: 'leave', title: 'Leave rejected',
    body: `Your leave for ${row.startDate} to ${row.endDate} was rejected: ${reason}`,
    entityType: 'LeaveRequest', entityId: row.id, actionUrl: '/hrms/leave',
  })

  ok(res, {
    request: {
      ...leaveRequestToApi(updated),
      employee: employeeRef(updated.employee),
      type: leaveTypeToApi(updated.leaveType),
      stage: stageOf(updated),
    },
  })
}))

// POST /api/leaves/:id/cancel
leaveRouter.post('/:id/cancel', handler(async (req, res) => {
  const session = requireSession(req)
  const row = await prisma.leaveRequest.findUnique({
    where: { id: req.params.id }, include: { employee: true, leaveType: true },
  })
  if (!row) throw ApiError.notFound('Leave request not found.')
  if (row.employeeId !== session.employeeId) {
    throw ApiError.forbidden('Only the requester can cancel a leave.')
  }
  if (row.status === 'cancelled' || row.status === 'rejected') {
    throw ApiError.conflict('already_terminal', 'This request is already closed.')
  }
  if (row.status === 'approved' && row.startDate <= istToday()) {
    throw ApiError.unprocessable('past_leave', 'An approved leave that has started cannot be cancelled.')
  }

  const wasApproved = row.status === 'approved'
  const updated = await prisma.leaveRequest.update({
    where: { id: row.id },
    data: { status: 'cancelled', updatedBy: session.userId },
    include: { employee: true, leaveType: true },
  })

  if (wasApproved) {
    if (row.leaveType.code !== 'lop') {
      const balance = await prisma.leaveBalance.findFirst({
        where: { employeeId: row.employeeId, leaveTypeId: row.leaveTypeId },
      })
      if (balance) {
        await prisma.leaveBalance.update({
          where: { id: balance.id },
          data: { availed: Math.max(0, balance.availed - row.computedWorkingDays) },
        })
      }
    }
    await removeOnLeaveRows(row.employeeId, row.startDate, row.endDate)
  }

  await writeAudit({
    actorUserId: session.userId, action: 'leave.cancelled',
    entityType: 'LeaveRequest', entityId: row.id,
    before: { status: row.status }, after: { was_approved: wasApproved, restored: wasApproved }, req,
  })

  ok(res, {
    request: {
      ...leaveRequestToApi(updated),
      employee: employeeRef(updated.employee),
      type: leaveTypeToApi(updated.leaveType),
      stage: stageOf(updated),
    },
  })
}))
