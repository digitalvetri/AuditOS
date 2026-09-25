import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { istToday } from '../lib/dates.js'
import { can, requireSession, type Session } from '../platform/auth.js'
import { auditLogToApi, notificationToApi } from '../api/serialize.js'
import { expiringDocuments } from './documents.routes.js'
import type { Scope } from '../platform/rbac/matrix.js'

/**
 * PLATFORM SURFACES — notifications, audit log, dashboard aggregates (§8.9,
 * §6.2). These are Part 1 primitives that every module writes into.
 */
export const notificationsRouter = Router()
export const auditRouter = Router()
export const dashboardRouter = Router()

// ── Notifications ─────────────────────────────────────────────────────────
notificationsRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 20)))
  const [rows, total, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: session.userId }, orderBy: { createdAt: 'desc' }, take: limit,
    }),
    prisma.notification.count({ where: { userId: session.userId } }),
    prisma.notification.count({ where: { userId: session.userId, isRead: false } }),
  ])
  ok(res, { items: rows.map(notificationToApi), unread, total })
}))

notificationsRouter.patch('/:id/read', handler(async (req, res) => {
  const session = requireSession(req)
  const row = await prisma.notification.findUnique({ where: { id: req.params.id } })
  if (!row) throw ApiError.notFound('Notification not found.')
  if (row.userId !== session.userId) throw ApiError.forbidden()
  const updated = await prisma.notification.update({ where: { id: row.id }, data: { isRead: true } })
  ok(res, { notification: notificationToApi(updated) })
}))

notificationsRouter.post('/read-all', handler(async (req, res) => {
  const session = requireSession(req)
  await prisma.notification.updateMany({
    where: { userId: session.userId, isRead: false }, data: { isRead: true },
  })
  ok(res, { ok: true })
}))

// ── Audit log ─────────────────────────────────────────────────────────────
auditRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const q = z.object({
    entity_type: z.string().optional(),
    entity_id: z.string().optional(),
    action: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }).parse(req.query)

  const orgAudit = can(session, 'audit.read.all', 'organisation')
  const hrAudit = can(session, 'audit.read.hr', 'organisation')
  const finAudit = can(session, 'audit.read.finance', 'organisation')
  // Reading your own Employee activity is allowed at self scope; anything
  // else needs an audit grant.
  const ownScope =
    q.entity_type === 'Employee' && !!q.entity_id && q.entity_id === session.employeeId
  if (!orgAudit && !hrAudit && !finAudit && !ownScope) {
    throw ApiError.forbidden('Audit access required.')
  }

  const rows = await prisma.auditLog.findMany({
    where: {
      ...(q.entity_type ? { entityType: q.entity_type } : {}),
      ...(q.entity_id ? { entityId: q.entity_id } : {}),
      ...(q.action ? { action: q.action } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: q.limit,
  })
  ok(res, { items: rows.map(auditLogToApi), count: rows.length })
}))

// ── Dashboard ─────────────────────────────────────────────────────────────
function dashboardScope(session: Session): Scope {
  if (can(session, 'attendance.read', 'organisation')) return 'organisation'
  if (can(session, 'attendance.read', 'department')) return 'department'
  return 'self'
}

/**
 * The widget registry lives on the client (§6.2 — the Dashboard never imports
 * a module). The server returns the caller's role so the client registry can
 * filter; Part 2 modules registering widgets needs no server change.
 */
dashboardRouter.get('/widgets', handler(async (req, res) => {
  ok(res, { role: requireSession(req).roleCode })
}))

dashboardRouter.get('/departments', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = dashboardScope(session)
  if (scope === 'self') throw ApiError.forbidden()

  const today = istToday()
  const departments = await prisma.department.findMany({
    where: {
      deletedAt: null,
      ...(scope === 'department' ? { id: session.departmentId ?? '__none__' } : {}),
    },
    orderBy: { name: 'asc' },
  })
  const employees = await prisma.employee.findMany({
    where: { deletedAt: null, status: { not: 'inactive' } },
    select: { id: true, departmentId: true },
  })
  const attendance = await prisma.attendance.findMany({
    where: { date: today, deletedAt: null },
    select: { employeeId: true, status: true, checkInAt: true },
  })

  const items = departments.map((dept) => {
    const ids = new Set(employees.filter((e) => e.departmentId === dept.id).map((e) => e.id))
    const rows = attendance.filter((a) => ids.has(a.employeeId))
    const onLeave = rows.filter((r) => r.status === 'on_leave').length
    return {
      id: dept.id,
      name: dept.name,
      headcount: ids.size,
      present: rows.filter((r) => r.status === 'present' || r.status === 'late' || r.status === 'wfh').length,
      absent: ids.size - rows.filter((r) => r.checkInAt !== null).length - onLeave,
      on_leave: onLeave,
    }
  })
  ok(res, { items })
}))

dashboardRouter.get('/pending-actions', handler(async (req, res) => {
  const session = requireSession(req)
  const items: {
    kind: 'leave' | 'correction' | 'document_expiring' | 'expense'
    id: string
    title: string
    subtitle: string
    action_url: string
    created_at: string
  }[] = []

  const expDept = can(session, 'expense.approve', 'department')
  const expOrg = can(session, 'expense.approve', 'organisation')
  if (expDept || expOrg) {
    const stages = expOrg ? ['pending_manager', 'pending_finance', 'approved'] : ['pending_manager']
    const rows = await prisma.expense.findMany({
      where: {
        deletedAt: null, stage: { in: stages },
        ...(expOrg ? {} : { employee: { departmentId: session.departmentId ?? '__none__' } }),
      },
      include: { employee: true },
    })
    for (const e of rows) {
      items.push({
        kind: 'expense',
        id: e.id,
        title: `${e.employee.fullName} — ${e.title}`,
        subtitle: `${(e.amountPaise / 100).toLocaleString('en-IN')} · ${e.stage.replace('_', ' ')}`,
        action_url: e.stage === 'pending_manager' ? '/hrms/expenses?tab=team' : '/hrms/expenses?tab=finance',
        created_at: e.createdAt.toISOString(),
      })
    }
  }

  const leaveDept = can(session, 'leave.approve', 'department')
  const leaveOrg = can(session, 'leave.approve', 'organisation')
  if (leaveDept || leaveOrg) {
    const rows = await prisma.leaveRequest.findMany({
      where: {
        status: 'pending', deletedAt: null,
        ...(leaveOrg ? {} : { employee: { departmentId: session.departmentId ?? '__none__' } }),
      },
      include: { employee: true, leaveType: true },
    })
    for (const r of rows) {
      const awaitingHr = !!r.approverId
      // Stage two is HR/MD only; a department manager should not see it queued.
      if (awaitingHr && !leaveOrg) continue
      items.push({
        kind: 'leave',
        id: r.id,
        title: `${r.employee.fullName} — ${r.leaveType.name}`,
        subtitle: `${r.computedWorkingDays.toFixed(1)} day(s) · ${r.startDate} → ${r.endDate}`,
        action_url: '/hrms/leave?tab=queue',
        created_at: r.createdAt.toISOString(),
      })
    }
  }

  const corrDept = can(session, 'attendance.correct.approve', 'department')
  const corrOrg = can(session, 'attendance.correct.approve', 'organisation')
  if (corrDept || corrOrg) {
    const rows = await prisma.attendanceCorrection.findMany({
      where: {
        status: 'pending', deletedAt: null,
        ...(corrOrg ? {} : { employee: { departmentId: session.departmentId ?? '__none__' } }),
      },
      include: { employee: true },
    })
    for (const c of rows) {
      items.push({
        kind: 'correction',
        id: c.id,
        title: `${c.employee.fullName} — Attendance correction`,
        subtitle: `${c.date} · ${c.reason.slice(0, 40)}${c.reason.length > 40 ? '…' : ''}`,
        action_url: '/hrms/attendance?tab=corrections',
        created_at: c.createdAt.toISOString(),
      })
    }
  }

  for (const d of await expiringDocuments(session, 30)) {
    items.push({
      kind: 'document_expiring',
      id: d.id,
      title: `${d.employee_name} — ${d.name} expiring`,
      subtitle: `Expires ${d.expiry_date} (${d.days_left} day${d.days_left === 1 ? '' : 's'} left)`,
      action_url: '/hrms/documents?expiringWithinDays=30',
      // Sorted by soonest expiry alongside newest-first items.
      created_at: d.expiry_date,
    })
  }

  items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  ok(res, { items, count: items.length })
}))

dashboardRouter.get('/activity', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'audit.read.all', 'organisation') && !can(session, 'audit.read.hr', 'organisation')) {
    throw ApiError.forbidden()
  }
  const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 20 })
  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))]
  const actors = await prisma.user.findMany({
    where: { id: { in: actorIds } }, include: { employee: true },
  })
  const label = new Map(actors.map((a) => [a.id, a.employee?.fullName ?? a.email]))

  ok(res, {
    items: rows.map((r) => ({
      id: r.id,
      action: r.action,
      entity_type: r.entityType,
      entity_id: r.entityId,
      created_at: r.createdAt.toISOString(),
      actor_label: r.actorUserId ? (label.get(r.actorUserId) ?? 'system') : 'system',
    })),
  })
}))
