import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { istToday } from '../lib/dates.js'
import { can, requireSession, type Session } from '../platform/auth.js'
import { auditLogToApi, notificationToApi } from '../api/serialize.js'
import { expiringDocuments } from './documents.routes.js'
import { canApproveCorrection, canApproveExpense, canApproveLeave } from './dashboard-approvable.js'
import type { Scope } from '../platform/rbac/matrix.js'
import { pushPublicKey } from '../platform/push.js'
import { USER_LABEL_SELECT, userLabel } from '../platform/userLabel.js'

/**
 * PLATFORM SURFACES — notifications, audit log, dashboard aggregates (§8.9,
 * §6.2). These are Part 1 primitives that every module writes into.
 */
export const notificationsRouter = Router()
export const auditRouter = Router()
export const dashboardRouter = Router()

// ── Notifications ─────────────────────────────────────────────────────────
/**
 * Default list hides items that are currently snoozed (snoozedUntil > now).
 * Pass ?include_snoozed=1 to show everything — the UI uses this for a
 * "Snoozed" filter so an operator can review what they put off.
 *
 * `unread` is the useful counter for the bell badge — it counts items
 * that are both unread AND not currently snoozed, matching what's visible.
 */
notificationsRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 20)))
  const includeSnoozed = String(req.query.include_snoozed ?? '') === '1'
  const now = new Date()
  const visibleWhere = includeSnoozed
    ? { userId: session.userId }
    : { userId: session.userId, OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] }
  const [rows, total, unread, snoozedCount] = await Promise.all([
    prisma.notification.findMany({
      where: visibleWhere, orderBy: { createdAt: 'desc' }, take: limit,
    }),
    prisma.notification.count({ where: { userId: session.userId } }),
    prisma.notification.count({
      where: {
        userId: session.userId, isRead: false,
        OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
      },
    }),
    prisma.notification.count({
      where: { userId: session.userId, snoozedUntil: { gt: now } },
    }),
  ])
  ok(res, { items: rows.map(notificationToApi), unread, total, snoozed: snoozedCount })
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

/**
 * POST /:id/snooze with body { until: ISO datetime }
 *
 * Hides the notification until the given moment. The row stays in the
 * database so it reappears when the time passes, and the "Snoozed" filter
 * can surface it in the meantime.
 */
notificationsRouter.post('/:id/snooze', handler(async (req, res) => {
  const session = requireSession(req)
  const row = await prisma.notification.findUnique({ where: { id: req.params.id } })
  if (!row) throw ApiError.notFound('Notification not found.')
  if (row.userId !== session.userId) throw ApiError.forbidden()
  const b = (req.body ?? {}) as Record<string, unknown>
  if (typeof b.until !== 'string') throw ApiError.badRequest('until (ISO datetime) is required.')
  const until = new Date(b.until)
  if (Number.isNaN(until.getTime())) throw ApiError.badRequest('until is not a valid ISO datetime.')
  if (until.getTime() <= Date.now()) {
    throw ApiError.badRequest('until must be in the future — to clear a snooze, use /unsnooze instead.')
  }
  const updated = await prisma.notification.update({
    where: { id: row.id }, data: { snoozedUntil: until },
  })
  ok(res, { notification: notificationToApi(updated) })
}))

notificationsRouter.post('/:id/unsnooze', handler(async (req, res) => {
  const session = requireSession(req)
  const row = await prisma.notification.findUnique({ where: { id: req.params.id } })
  if (!row) throw ApiError.notFound('Notification not found.')
  if (row.userId !== session.userId) throw ApiError.forbidden()
  const updated = await prisma.notification.update({
    where: { id: row.id }, data: { snoozedUntil: null },
  })
  ok(res, { notification: notificationToApi(updated) })
}))

// ── Web Push subscriptions ─────────────────────────────────────────────────
notificationsRouter.get('/push/key', handler(async (_req, res) => {
  ok(res, { public_key: pushPublicKey() })
}))

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
})

notificationsRouter.post('/push/subscribe', handler(async (req, res) => {
  const session = requireSession(req)
  const parsed = subscriptionSchema.safeParse(req.body ?? {})
  if (!parsed.success) throw ApiError.badRequest('Invalid push subscription.', parsed.error.flatten().fieldErrors)
  const { endpoint, keys } = parsed.data
  const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 300) || null
  // Upsert by endpoint: on a shared machine the browser keeps one endpoint,
  // so it moves to whoever is signed in now.
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { endpoint, p256dh: keys.p256dh, auth: keys.auth, userId: session.userId, userAgent },
    update: { p256dh: keys.p256dh, auth: keys.auth, userId: session.userId, userAgent },
  })
  ok(res, { ok: true })
}))

notificationsRouter.post('/push/unsubscribe', handler(async (req, res) => {
  const session = requireSession(req)
  const endpoint = z.object({ endpoint: z.string().max(2000) }).parse(req.body ?? {}).endpoint
  await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: session.userId } })
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

  // The Super Admin is invisible to everyone else: hide what it did and what
  // was done to it (including failed sign-ins, which record the typed email).
  // Its older sign-in/out rows (no longer written) stay hidden from everyone.
  const hidden = session.roleCode === 'md' ? [] : await prisma.user.findMany({
    where: { role: { code: 'md' } }, select: { id: true, email: true },
  })
  const hiddenIds = hidden.flatMap((u) => [u.id, u.email])
  const rows = await prisma.auditLog.findMany({
    where: {
      NOT: [
        { action: { in: ['auth.login', 'auth.logout'] }, actor: { role: { code: 'md' } } },
        ...(hiddenIds.length
          ? [{ actorUserId: { in: hiddenIds } }, { entityType: 'User', entityId: { in: hiddenIds } }]
          : []),
      ],
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
    where: { deletedAt: null, status: { not: 'inactive' }, excludeFromHr: false },
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
    /** True when this viewer can approve it in one click (same rules as the approve endpoint). */
    approvable: boolean
  }[] = []
  const rights = (dept: boolean, org: boolean) => ({
    employeeId: session.employeeId ?? null, departmentId: session.departmentId ?? null, dept, org,
  })

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
        action_url: e.stage === 'pending_manager' ? '/hrms/accounts/expenses?tab=team' : '/hrms/accounts/expenses?tab=finance',
        created_at: e.createdAt.toISOString(),
        approvable: canApproveExpense(rights(expDept, expOrg), { stage: e.stage, employeeDepartmentId: e.employee.departmentId }),
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
        approvable: canApproveLeave(rights(leaveDept, leaveOrg), { awaitingHr, employeeManagerId: r.employee.managerId }),
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
        approvable: canApproveCorrection(rights(corrDept, corrOrg), { employeeDepartmentId: c.employee.departmentId }),
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
      approvable: false,
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
  // Everyone's sign-ins and sign-outs show; failed attempts don't (no actor,
  // and the email may be anyone's). The Super Admin's own trail never shows.
  const rows = await prisma.auditLog.findMany({
    where: {
      action: { not: 'auth.login_failed' },
      OR: [{ actorUserId: null }, { actor: { role: { code: { not: 'md' } } } }],
    },
    orderBy: { createdAt: 'desc' }, take: 20,
  })
  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))]
  const actors = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: USER_LABEL_SELECT })
  const label = new Map(actors.map((a) => [a.id, userLabel(a)]))

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
