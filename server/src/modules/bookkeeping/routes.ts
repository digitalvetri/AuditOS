import { Router } from 'express'
import multer from 'multer'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import {
  assertCanSeeClient, clientScopeWhere, requireWorkstation,
} from '../../platform/workstation/scope.js'
import { employeeMap } from '../../api/workstation.serialize.js'
import { body, FieldErrors } from '../workstation/validate.js'
import {
  BILLING_FREQUENCIES, DELIVERABLE_STATUSES, DELIVERABLE_TYPES,
  DOCREQ_STATUSES, DOCUMENT_TYPES, ENGAGEMENT_STATUSES, IMPORT_KINDS,
  IMPORT_SOURCES, MONTH_ABBREVS, PENDING_CATEGORIES, PENDING_STATUSES,
  PERIOD_STATUSES, PRIORITIES, TASK_CATEGORIES, TASK_STATUSES,
  WORKFLOW_STEPS, periodLabel,
} from './validate.js'
import {
  createPeriodWithTasks, currentStageByPeriod, overviewTiles, progressByPeriod,
  progressFrom, recomputeOpenPeriodsForEngagement, today, writeBkActivity,
} from './service.js'
import {
  activityToApi, deliverableToApi, documentRequestToApi,
  engagementToApi, importToApi, pendingItemToApi, periodToApi, taskToApi,
  workflowStageToApi,
} from './serialize.js'
import { bookkeepingImportStorage, importStorageKey } from './storage.js'
import { validateImport } from './imports.js'
import { parseTrialBalanceCsv } from './parsers/trialBalance.js'
import { classify, loadLedgerGroups } from './ledgerGroups.js'
import { reportsForPeriod } from './reports.js'

/**
 * BOOKKEEPING SERVICE.
 *
 * The service-management layer: engagements, monthly periods, checklists,
 * tasks, chased documents and deliverables. It deliberately holds no ledger
 * figures — every accounting number belongs to Books, and `books_org_id` on
 * a client row is the handoff that opens it.
 */
export const bookkeepingRouter = Router()

const READ = ['workstation.service.read', 'workstation.service.manage'] as const
const MANAGE = ['workstation.service.manage'] as const

const q = (req: { query: Record<string, unknown> }, key: string) =>
  (typeof req.query[key] === 'string' && req.query[key] !== '' ? (req.query[key] as string) : null)

/** Books is opened by client — one set of books per client (BooksOrganisation.clientId). */
async function booksOrgIdFor(clientIds: string[]): Promise<Map<string, string>> {
  if (clientIds.length === 0) return new Map()
  const rows = await prisma.booksOrganisation.findMany({
    where: { clientId: { in: clientIds } },
    select: { id: true, clientId: true },
  })
  return new Map(rows.flatMap((r) => (r.clientId ? [[r.clientId, r.id] as const] : [])))
}

// ── Overview ──────────────────────────────────────────────────────────────
// GET /api/bookkeeping/overview?tile=&client_id=&employee_id=&stage=&status=&group=
//
// Answers "what needs doing?" — spec §6.1. The tile counts are ALWAYS the
// unfiltered aggregates over the caller's visible clients (they're the
// entry points for filters, not the results of one). The `rows` array is
// filtered by the query params so tile-click and table-row can never
// disagree — clicking a tile just sets `?tile=` and re-renders the same
// endpoint response with the same tile counts.
bookkeepingRouter.get('/overview', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)
  const clientFilter = 'clientId' in where
    ? { engagement: { clientId: (where as { clientId: { in: string[] } }).clientId } }
    : {}

  const tile = q(req, 'tile')            // overdue | blocked | due_soon | review | closed
  const group = q(req, 'group') ?? 'period'   // period (default) | task
  const clientId = q(req, 'client_id')
  const employeeId = q(req, 'employee_id')
  const stageSlug = q(req, 'stage')
  const statusFilter = q(req, 'status')
  const search = q(req, 'q')

  const t = today()
  const dueSoonEnd = (() => {
    const [y, m, d] = t.split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1, d + 7))
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
  })()
  const monthStart = (() => {
    const now = new Date()
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
  })()

  const tiles = await overviewTiles(where)

  if (group === 'task') {
    // Group-by-task: one row per task matching the filters. This is what
    // the retired "Tasks" tab used to look like. Capped at 200 rows;
    // real-world lists will grow past this and the follow-up will paginate.
    const rows = await prisma.bookkeepingTask.findMany({
      where: {
        ...alive, ...where,
        stageId: { not: null },
        ...(tile === 'overdue' ? { dueDate: { lt: t }, status: { notIn: ['completed', 'cancelled'] } } : {}),
        ...(tile === 'blocked' ? { status: 'blocked' } : {}),
        ...(tile === 'due_soon' ? { dueDate: { gte: t, lte: dueSoonEnd }, status: { notIn: ['completed', 'cancelled'] } } : {}),
        ...(tile === 'review' ? { period: { status: 'under_review' } } : {}),
        ...(tile === 'closed' ? { period: { status: 'completed', completedDate: { gte: new Date(monthStart) } } } : {}),
        ...(clientId ? { clientId } : {}),
        ...(employeeId ? { assignedEmployeeId: employeeId } : {}),
        ...(stageSlug ? { stage: { slug: stageSlug } } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(search ? { title: { contains: search, mode: 'insensitive' as const } } : {}),
      },
      include: { client: true, period: true, stage: true },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    })
    const m = await employeeMap(rows.map((r) => r.assignedEmployeeId))
    ok(res, {
      tiles,
      group: 'task',
      rows: rows.map((r) => taskToApi(r, m)),
      count: rows.length,
      scope,
    })
    return
  }

  // Group-by-period (default): one row per open period. Each row carries
  // the "current stage" (earliest incomplete stage task) and how many of
  // this period's tasks are blocked, so a reviewer can see WHERE a period
  // is stuck at a glance.
  const perTileFilter: Record<string, unknown> = tile === 'closed'
    ? { status: 'completed', completedDate: { gte: new Date(monthStart) } }
    : tile === 'review'
      ? { status: 'under_review' }
      : tile === 'due_soon'
        ? { dueDate: { gte: t, lte: dueSoonEnd }, status: { not: 'completed' } }
        : { status: { not: 'completed' } }

  const periods = await prisma.bookkeepingPeriod.findMany({
    where: {
      ...alive, ...clientFilter, ...perTileFilter,
      ...(clientId ? { engagement: { clientId } } : {}),
      ...(employeeId ? { assignedEmployeeId: employeeId } : {}),
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(search ? { engagement: { client: { companyName: { contains: search, mode: 'insensitive' as const } } } } : {}),
    },
    include: { engagement: { include: { client: true } } },
    orderBy: [{ dueDate: 'asc' }],
    take: 100,
  })
  const prog = await progressByPeriod(periods.map((p) => p.id))
  const m = await employeeMap(periods.map((p) => p.assignedEmployeeId))
  const stageByPeriod = await currentStageByPeriod(where)

  // Post-filter for tiles that need a per-period aggregate (overdue,
  // blocked, and stage=) — those cannot be expressed as a single Prisma
  // where clause without a subquery per row.
  const rows = periods
    .map((p) => {
      const cs = stageByPeriod.get(p.id)
      return {
        ...periodToApi(p, m, prog.get(p.id)),
        current_stage: cs
          ? { id: cs.stageId, slug: cs.stageSlug, name: cs.stageName, sequence: cs.stageSequence }
          : null,
        blocked_count: cs?.blockedCount ?? 0,
      }
    })
    .filter((r) => {
      if (tile === 'blocked' && r.blocked_count === 0) return false
      if (tile === 'overdue' && !(r.due_date && r.due_date < t)) return false
      if (stageSlug && r.current_stage?.slug !== stageSlug) return false
      return true
    })

  ok(res, {
    tiles,
    group: 'period',
    rows,
    count: rows.length,
    scope,
  })
}))

// ── Clients ───────────────────────────────────────────────────────────────
//
// GET /api/bookkeeping/clients/grid?fy=YYYY&employee_id=&q=
//
// The period grid (spec §6.2). Clients down, twelve calendar months across,
// one cell per client-period. This is the screen that makes silent drift
// visible: a client three months behind that nobody noticed shows up as a
// row of unmarked cells.
//
// Indian FY: April → March. `?fy=2026` renders April 2026 through March
// 2027. Default is the FY containing today.
//
// Declared BEFORE `/clients` so Express's path matcher does not treat
// `grid` as a clientId (`:clientId` catch-alls are the trap this router
// has already been bitten by elsewhere).
bookkeepingRouter.get('/clients/grid', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)

  const fyQuery = q(req, 'fy')
  const now = new Date()
  const currentFy = now.getUTCMonth() >= 3 // April is index 3
    ? now.getUTCFullYear()
    : now.getUTCFullYear() - 1
  const fy = fyQuery && /^\d{4}$/.test(fyQuery) ? Number(fyQuery) : currentFy
  const fyLabel = `${fy}-${String((fy + 1) % 100).padStart(2, '0')}`

  // Twelve months, Apr…Mar, each carrying its calendar year.
  const months: { year: number; month: number; label: string }[] = []
  for (let i = 0; i < 12; i++) {
    const monthIndex = 4 + i    // 4 = Apr, 15 → wraps to Mar
    const year = fy + Math.floor((monthIndex - 1) / 12)
    const month = ((monthIndex - 1) % 12) + 1
    months.push({ year, month, label: MONTH_ABBREVS[month - 1] })
  }

  const employeeId = q(req, 'employee_id')
  const search = q(req, 'q')

  const engagements = await prisma.bookkeepingEngagement.findMany({
    where: {
      ...alive, ...where,
      ...(employeeId ? { assignedEmployeeId: employeeId } : {}),
      ...(search ? { client: { companyName: { contains: search, mode: 'insensitive' } } } : {}),
    },
    include: { client: true },
    orderBy: { client: { companyName: 'asc' } },
  })
  const engagementIds = engagements.map((e) => e.id)

  // ONE query for every period in the twelve-month window across every
  // visible engagement. Fanned out into cells client-side in JS. This is
  // deliberately not N+1 — a firm's book is small enough for the whole
  // grid to fit on one read.
  const yearsInWindow = Array.from(new Set(months.map((m) => m.year)))
  const t = today()
  const periods = engagementIds.length === 0 ? [] : await prisma.bookkeepingPeriod.findMany({
    where: {
      ...alive,
      engagementId: { in: engagementIds },
      year: { in: yearsInWindow },
    },
    select: {
      id: true, engagementId: true, year: true, month: true,
      status: true, dueDate: true,
    },
  })

  const byEngagementMonth = new Map<string, typeof periods[number]>()
  for (const p of periods) byEngagementMonth.set(`${p.engagementId}-${p.year}-${p.month}`, p)

  const m = await employeeMap(engagements.map((e) => e.assignedEmployeeId))

  const rows = engagements.map((e) => ({
    client_id: e.clientId,
    client_name: e.client?.companyName ?? null,
    client_code: e.client?.clientCode ?? null,
    engagement_id: e.id,
    owner: e.assignedEmployeeId ? m.get(e.assignedEmployeeId) ?? null : null,
    cells: months.map((mo) => {
      const p = byEngagementMonth.get(`${e.id}-${mo.year}-${mo.month}`)
      if (!p) {
        return { year: mo.year, month: mo.month, period_id: null, status: null, is_overdue: false }
      }
      const isOverdue = p.status !== 'completed' && Boolean(p.dueDate && p.dueDate < t)
      return {
        year: mo.year, month: mo.month,
        period_id: p.id, status: p.status, is_overdue: isOverdue,
      }
    }),
  }))

  ok(res, { fy, fy_label: fyLabel, months, rows, scope })
}))

// GET /api/bookkeeping/clients
bookkeepingRouter.get('/clients', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)

  const status = q(req, 'status')
  const employeeId = q(req, 'employee_id')
  const search = q(req, 'q')

  const rows = await prisma.bookkeepingEngagement.findMany({
    where: {
      ...alive, ...where,
      ...(status ? { status } : {}),
      ...(employeeId ? { assignedEmployeeId: employeeId } : {}),
      ...(search ? { client: { companyName: { contains: search, mode: 'insensitive' } } } : {}),
    },
    include: { client: true, periods: { orderBy: [{ year: 'desc' }, { month: 'desc' }], take: 1 } },
    orderBy: [{ nextDueDate: 'asc' }],
  })

  const m = await employeeMap(rows.map((r) => r.assignedEmployeeId))
  const books = await booksOrgIdFor(rows.map((r) => r.clientId))

  // Pending-item counts for the whole page in one query, not one per row.
  const counts = await prisma.bookkeepingPendingItem.groupBy({
    by: ['clientId'],
    where: { ...alive, clientId: { in: rows.map((r) => r.clientId) }, status: { notIn: ['resolved', 'received'] } },
    _count: { _all: true },
  })
  const pending = new Map(counts.map((c) => [c.clientId, c._count._all]))

  ok(res, {
    items: rows.map((r) => {
      const current = r.periods[0] ?? null
      return {
        ...engagementToApi(r, m),
        current_period: current ? periodLabel(current.year, current.month) : null,
        current_period_id: current?.id ?? null,
        current_period_status: current?.status ?? null,
        pending_items: pending.get(r.clientId) ?? 0,
        books_org_id: books.get(r.clientId) ?? null,
      }
    }),
    count: rows.length,
    scope,
  })
}))

// GET /api/bookkeeping/clients/:clientId
bookkeepingRouter.get('/clients/:clientId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const clientId = req.params.clientId
  await assertCanSeeClient(session, scope, clientId)

  const engagement = await prisma.bookkeepingEngagement.findFirst({
    where: { ...alive, clientId },
    include: {
      client: true,
      periods: { where: alive, orderBy: [{ year: 'desc' }, { month: 'desc' }] },
    },
  })
  if (!engagement) throw ApiError.notFound('This client has no bookkeeping engagement yet.')

  const prog = await progressByPeriod(engagement.periods.map((p) => p.id))
  const m = await employeeMap([
    engagement.assignedEmployeeId,
    ...engagement.periods.map((p) => p.assignedEmployeeId),
  ])
  const books = await booksOrgIdFor([clientId])
  const stages = await prisma.bookkeepingWorkflowStage.findMany({
    where: { isActive: true }, orderBy: { sequence: 'asc' },
  })

  ok(res, {
    engagement: engagementToApi(engagement, m),
    periods: engagement.periods.map((p) => periodToApi(p, m, prog.get(p.id))),
    books_org_id: books.get(clientId) ?? null,
    workflow_stages: stages.map(workflowStageToApi),
    // Legacy string[] view retained for one release so old clients keep rendering.
    workflow_steps: WORKFLOW_STEPS,
  })
}))

// GET /api/bookkeeping/clients/:clientId/activity
bookkeepingRouter.get('/clients/:clientId/activity', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  await assertCanSeeClient(session, scope, req.params.clientId)
  const rows = await prisma.bookkeepingActivity.findMany({
    where: { clientId: req.params.clientId },
    include: { period: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  ok(res, { items: rows.map(activityToApi), count: rows.length })
}))

// ── Engagements ───────────────────────────────────────────────────────────
// POST /api/bookkeeping/engagements
bookkeepingRouter.post('/engagements', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const b = body(req)
  const f = new FieldErrors()

  const clientId = f.str('client_id', b.client_id)
  const serviceStartDate = f.date('service_start_date', b.service_start_date, true)
  const assignedEmployeeId = f.str('assigned_employee_id', b.assigned_employee_id)
  const billingFrequency = f.oneOf('billing_frequency', b.billing_frequency ?? 'monthly', BILLING_FREQUENCIES)
  const dueOffsetDaysRaw = b.due_offset_days === undefined ? 5 : Number(b.due_offset_days)
  if (!Number.isInteger(dueOffsetDaysRaw) || dueOffsetDaysRaw < 0 || dueOffsetDaysRaw > 60) {
    f.add('due_offset_days', 'Enter a whole number of days between 0 and 60.')
  }
  const nextDueDate = f.date('next_due_date', b.next_due_date, false)
  const notes = f.str('notes', b.notes, { required: false, max: 2000 })
  f.throwIfAny()

  await assertCanSeeClient(session, scope, clientId!)
  const client = await prisma.client.findFirst({ where: { ...alive, id: clientId! } })
  if (!client) throw ApiError.notFound('Client not found.')

  const dupe = await prisma.bookkeepingEngagement.findFirst({ where: { clientId: clientId! } })
  if (dupe) throw ApiError.conflict('engagement_exists', 'This client already has a bookkeeping engagement.')

  const row = await prisma.bookkeepingEngagement.create({
    data: {
      clientId: clientId!, serviceStartDate: serviceStartDate!, assignedEmployeeId: assignedEmployeeId!,
      billingFrequency: billingFrequency!, dueOffsetDays: dueOffsetDaysRaw,
      nextDueDate: nextDueDate ?? null, notes: notes ?? null,
      createdBy: session.userId,
    },
    include: { client: true },
  })

  await writeAudit({
    actorUserId: session.userId, action: 'bookkeeping.engagement.create',
    entityType: 'BookkeepingEngagement', entityId: row.id, after: row, req,
  })
  await writeBkActivity({
    clientId: row.clientId, actorUserId: session.userId,
    action: 'Engagement created', detail: `Bookkeeping engagement opened (${row.billingFrequency}).`,
  })

  const m = await employeeMap([row.assignedEmployeeId])
  ok(res, engagementToApi(row, m), 201)
}))

// PATCH /api/bookkeeping/engagements/:id
bookkeepingRouter.patch('/engagements/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const before = await prisma.bookkeepingEngagement.findFirst({ where: { ...alive, id: req.params.id } })
  if (!before) throw ApiError.notFound('Engagement not found.')
  await assertCanSeeClient(session, scope, before.clientId)

  const b = body(req)
  const f = new FieldErrors()
  const data: Record<string, unknown> = {}
  if (b.status !== undefined) data.status = f.oneOf('status', b.status, ENGAGEMENT_STATUSES)
  if (b.assigned_employee_id !== undefined) data.assignedEmployeeId = f.str('assigned_employee_id', b.assigned_employee_id)
  if (b.billing_frequency !== undefined) data.billingFrequency = f.oneOf('billing_frequency', b.billing_frequency, BILLING_FREQUENCIES)
  if (b.due_offset_days !== undefined) {
    const n = Number(b.due_offset_days)
    if (!Number.isInteger(n) || n < 0 || n > 60) {
      f.add('due_offset_days', 'Enter a whole number of days between 0 and 60.')
    } else {
      data.dueOffsetDays = n
    }
  }
  if (b.next_due_date !== undefined) data.nextDueDate = f.date('next_due_date', b.next_due_date, false) ?? null
  if (b.notes !== undefined) data.notes = f.str('notes', b.notes, { required: false, max: 2000 }) ?? null
  f.throwIfAny()

  const row = await prisma.bookkeepingEngagement.update({
    where: { id: before.id },
    data: { ...data, updatedBy: session.userId },
    include: { client: true },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'bookkeeping.engagement.update',
    entityType: 'BookkeepingEngagement', entityId: row.id, before, after: row, req,
  })
  if (data.status && data.status !== before.status) {
    await writeBkActivity({
      clientId: row.clientId, actorUserId: session.userId,
      action: 'Engagement status changed', detail: `${before.status} → ${row.status}`,
    })
  }
  // If the frequency or the turnaround changed, every open period's due date
  // is now stale — recompute in the same request so the UI never renders a
  // date that disagrees with the config that just wrote it.
  const dueOffsetChanged = data.dueOffsetDays !== undefined && data.dueOffsetDays !== before.dueOffsetDays
  const frequencyChanged = data.billingFrequency !== undefined && data.billingFrequency !== before.billingFrequency
  if (dueOffsetChanged || frequencyChanged) {
    const summary = await recomputeOpenPeriodsForEngagement(prisma, row.id)
    if (summary.periodsMoved > 0 || summary.tasksMoved > 0) {
      await writeBkActivity({
        clientId: row.clientId, actorUserId: session.userId,
        action: 'Due dates recomputed',
        detail: `${summary.periods} open period(s); ${summary.periodsMoved} period due date(s) and ${summary.tasksMoved} task due date(s) moved to reflect ${dueOffsetChanged ? `dueOffsetDays ${before.dueOffsetDays} → ${row.dueOffsetDays}` : `frequency ${before.billingFrequency} → ${row.billingFrequency}`}.`,
      })
    }
  }
  const m = await employeeMap([row.assignedEmployeeId])
  ok(res, engagementToApi(row, m))
}))

// ── Periods ───────────────────────────────────────────────────────────────
// GET /api/bookkeeping/periods
bookkeepingRouter.get('/periods', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)
  const clientFilter = 'clientId' in where ? { engagement: { clientId: (where as { clientId: { in: string[] } }).clientId } } : {}

  const status = q(req, 'status')
  const clientId = q(req, 'client_id')
  const employeeId = q(req, 'employee_id')

  const rows = await prisma.bookkeepingPeriod.findMany({
    where: {
      ...alive, ...clientFilter,
      ...(status ? { status } : {}),
      ...(clientId ? { engagement: { clientId } } : {}),
      ...(employeeId ? { assignedEmployeeId: employeeId } : {}),
    },
    include: { engagement: { include: { client: true } } },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
  })
  const prog = await progressByPeriod(rows.map((r) => r.id))
  const m = await employeeMap(rows.map((r) => r.assignedEmployeeId))
  ok(res, { items: rows.map((r) => periodToApi(r, m, prog.get(r.id))), count: rows.length, scope })
}))

// GET /api/bookkeeping/periods/:id
bookkeepingRouter.get('/periods/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const row = await prisma.bookkeepingPeriod.findFirst({
    where: { ...alive, id: req.params.id },
    include: {
      engagement: { include: { client: true } },
      tasks: {
        where: alive,
        include: { client: true, stage: true },
        orderBy: [{ stage: { sequence: 'asc' } }, { createdAt: 'asc' }],
      },
      pendingItems: { where: alive, include: { client: true } },
      documentRequests: { where: alive, include: { client: true, clientDocument: true } },
      deliverables: { where: alive, include: { client: true, clientDocument: true } },
      imports: { orderBy: { importedAt: 'desc' } },
    },
  })
  if (!row) throw ApiError.notFound('Period not found.')
  await assertCanSeeClient(session, scope, row.engagement.clientId)

  const stages = await prisma.bookkeepingWorkflowStage.findMany({
    where: { isActive: true }, orderBy: { sequence: 'asc' },
  })

  const m = await employeeMap([
    row.assignedEmployeeId,
    ...row.tasks.map((t) => t.assignedEmployeeId),
    ...row.tasks.map((t) => t.completedByEmployeeId),
    ...row.pendingItems.map((p) => p.assignedEmployeeId),
    ...row.deliverables.flatMap((d) => [d.preparedByEmployeeId, d.reviewedByEmployeeId]),
    ...row.imports.map((i) => i.importedByEmployeeId),
  ])

  ok(res, {
    period: periodToApi(row, m, progressFrom(row.tasks)),
    tasks: row.tasks.map((t) => taskToApi(t, m)),
    pending_items: row.pendingItems.map((p) => pendingItemToApi(p, m)),
    document_requests: row.documentRequests.map((d) => documentRequestToApi(d, m)),
    deliverables: row.deliverables.map((d) => deliverableToApi(d, m)),
    imports: row.imports.map((i) => importToApi(i, m)),
    workflow_stages: stages.map(workflowStageToApi),
    // Legacy view kept for one release so old clients still render.
    workflow_steps: WORKFLOW_STEPS,
  })
}))

// POST /api/bookkeeping/periods
bookkeepingRouter.post('/periods', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const b = body(req)
  const f = new FieldErrors()
  const engagementId = f.str('engagement_id', b.engagement_id)
  const year = typeof b.year === 'number' ? b.year : Number(b.year)
  const month = typeof b.month === 'number' ? b.month : Number(b.month)
  if (!Number.isInteger(year) || year < 2000 || year > 2100) f.add('year', 'Enter a valid year.')
  if (!Number.isInteger(month) || month < 1 || month > 12) f.add('month', 'Enter a month from 1 to 12.')
  const dueDate = f.date('due_date', b.due_date, false)
  const assignedEmployeeId = f.str('assigned_employee_id', b.assigned_employee_id, { required: false })
  f.throwIfAny()

  const engagement = await prisma.bookkeepingEngagement.findFirst({ where: { ...alive, id: engagementId! } })
  if (!engagement) throw ApiError.notFound('Engagement not found.')
  await assertCanSeeClient(session, scope, engagement.clientId)

  const row = await createPeriodWithTasks(prisma, {
    engagementId: engagementId!, clientId: engagement.clientId, year, month,
    dueDate: dueDate ?? null,
    assignedEmployeeId: assignedEmployeeId ?? engagement.assignedEmployeeId,
    createdBy: session.userId,
  })

  await writeAudit({
    actorUserId: session.userId, action: 'bookkeeping.period.create',
    entityType: 'BookkeepingPeriod', entityId: row.id, after: row, req,
  })
  await writeBkActivity({
    clientId: engagement.clientId, periodId: row.id, actorUserId: session.userId,
    action: 'Period opened', detail: `${periodLabel(year, month)} opened with ${row.tasks.length} workflow tasks.`,
  })

  const m = await employeeMap([row.assignedEmployeeId])
  ok(res, periodToApi(row, m, progressFrom([])), 201)
}))

// PATCH /api/bookkeeping/periods/:id
bookkeepingRouter.patch('/periods/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const before = await prisma.bookkeepingPeriod.findFirst({
    where: { ...alive, id: req.params.id }, include: { engagement: true },
  })
  if (!before) throw ApiError.notFound('Period not found.')
  await assertCanSeeClient(session, scope, before.engagement.clientId)

  const b = body(req)
  const f = new FieldErrors()
  const data: Record<string, unknown> = {}
  if (b.status !== undefined) data.status = f.oneOf('status', b.status, PERIOD_STATUSES)
  if (b.due_date !== undefined) data.dueDate = f.date('due_date', b.due_date, false) ?? null
  if (b.assigned_employee_id !== undefined) data.assignedEmployeeId = f.str('assigned_employee_id', b.assigned_employee_id, { required: false }) ?? null
  if (b.notes !== undefined) data.notes = f.str('notes', b.notes, { required: false, max: 2000 }) ?? null
  f.throwIfAny()

  // Completing a month stamps the date; reopening it clears the stamp, so the
  // column never claims a completion that was undone.
  if (data.status === 'completed') data.completedDate = new Date()
  else if (data.status && before.status === 'completed') data.completedDate = null

  const row = await prisma.bookkeepingPeriod.update({
    where: { id: before.id },
    data: { ...data, updatedBy: session.userId },
    include: { engagement: { include: { client: true } } },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'bookkeeping.period.update',
    entityType: 'BookkeepingPeriod', entityId: row.id, before, after: row, req,
  })
  if (data.status && data.status !== before.status) {
    await writeBkActivity({
      clientId: before.engagement.clientId, periodId: row.id, actorUserId: session.userId,
      action: 'Period status changed', detail: `${periodLabel(row.year, row.month)}: ${before.status} → ${row.status}`,
    })
  }
  const prog = await progressByPeriod([row.id])
  const m = await employeeMap([row.assignedEmployeeId])
  ok(res, periodToApi(row, m, prog.get(row.id)))
}))

// PATCH /api/bookkeeping/checklist-items/:id
//
// The standalone checklist is gone: every checkbox in Monthly Work is now a
// checkbox on the underlying stage task, and the correct call is
// `PATCH /api/bookkeeping/tasks/:id`. This stub returns 410 Gone so that any
// old client left in the wild fails loudly (with a message pointing at the
// new endpoint) rather than silently 404-ing.
bookkeepingRouter.patch('/checklist-items/:id', handler(async (_req, _res) => {
  throw new ApiError(
    410,
    'checklist_removed',
    'Checklist items were folded into tasks — update the underlying task via PATCH /api/bookkeeping/tasks/:id.',
  )
}))

// ── Tasks ─────────────────────────────────────────────────────────────────
bookkeepingRouter.get('/tasks', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)
  const search = q(req, 'q')
  const due = q(req, 'due')

  const rows = await prisma.bookkeepingTask.findMany({
    where: {
      ...alive, ...where,
      ...(q(req, 'status') ? { status: q(req, 'status')! } : {}),
      ...(q(req, 'priority') ? { priority: q(req, 'priority')! } : {}),
      ...(q(req, 'category') ? { category: q(req, 'category')! } : {}),
      ...(q(req, 'client_id') ? { clientId: q(req, 'client_id')! } : {}),
      ...(q(req, 'period_id') ? { periodId: q(req, 'period_id')! } : {}),
      ...(q(req, 'employee_id') ? { assignedEmployeeId: q(req, 'employee_id')! } : {}),
      ...(due === 'overdue' ? { dueDate: { lt: today() }, status: { notIn: ['completed', 'cancelled'] } } : {}),
      ...(search ? { OR: [
        { title: { contains: search, mode: 'insensitive' as const } },
        { description: { contains: search, mode: 'insensitive' as const } },
      ] } : {}),
    },
    include: { client: true, period: true, stage: true },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
  })
  const m = await employeeMap(rows.map((r) => r.assignedEmployeeId))
  ok(res, { items: rows.map((r) => taskToApi(r, m)), count: rows.length, scope })
}))

bookkeepingRouter.post('/tasks', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const b = body(req)
  const f = new FieldErrors()
  const clientId = f.str('client_id', b.client_id)
  const title = f.str('title', b.title, { max: 200 })
  const category = f.oneOf('category', b.category ?? 'other', TASK_CATEGORIES)
  const priority = f.oneOf('priority', b.priority ?? 'medium', PRIORITIES)
  const assignedEmployeeId = f.str('assigned_employee_id', b.assigned_employee_id)
  const dueDate = f.date('due_date', b.due_date, false)
  const description = f.str('description', b.description, { required: false, max: 2000 })
  const periodId = f.str('period_id', b.period_id, { required: false })
  f.throwIfAny()
  await assertCanSeeClient(session, scope, clientId!)

  const row = await prisma.bookkeepingTask.create({
    data: {
      clientId: clientId!, periodId: periodId ?? null, title: title!, description: description ?? null,
      category: category!, priority: priority!, assignedEmployeeId: assignedEmployeeId!,
      dueDate: dueDate ?? null, createdById: session.userId,
    },
    include: { client: true, period: true, stage: true },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'bookkeeping.task.create',
    entityType: 'BookkeepingTask', entityId: row.id, after: row, req,
  })
  await writeBkActivity({
    clientId: row.clientId, periodId: row.periodId, actorUserId: session.userId,
    action: 'Task created', detail: row.title,
  })
  const m = await employeeMap([row.assignedEmployeeId])
  ok(res, taskToApi(row, m), 201)
}))

bookkeepingRouter.get('/tasks/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const row = await prisma.bookkeepingTask.findFirst({
    where: { ...alive, id: req.params.id }, include: { client: true, period: true, stage: true },
  })
  if (!row) throw ApiError.notFound('Task not found.')
  await assertCanSeeClient(session, scope, row.clientId)
  const m = await employeeMap([row.assignedEmployeeId, row.completedByEmployeeId])
  ok(res, taskToApi(row, m))
}))

bookkeepingRouter.patch('/tasks/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const before = await prisma.bookkeepingTask.findFirst({ where: { ...alive, id: req.params.id } })
  if (!before) throw ApiError.notFound('Task not found.')
  await assertCanSeeClient(session, scope, before.clientId)

  const b = body(req)
  const f = new FieldErrors()
  const data: Record<string, unknown> = {}
  if (b.title !== undefined) data.title = f.str('title', b.title, { max: 200 })
  if (b.description !== undefined) data.description = f.str('description', b.description, { required: false, max: 2000 }) ?? null
  if (b.status !== undefined) data.status = f.oneOf('status', b.status, TASK_STATUSES)
  if (b.category !== undefined) data.category = f.oneOf('category', b.category, TASK_CATEGORIES)
  if (b.priority !== undefined) data.priority = f.oneOf('priority', b.priority, PRIORITIES)
  if (b.assigned_employee_id !== undefined) data.assignedEmployeeId = f.str('assigned_employee_id', b.assigned_employee_id)
  if (b.due_date !== undefined) data.dueDate = f.date('due_date', b.due_date, false) ?? null
  if (b.notes !== undefined) data.notes = f.str('notes', b.notes, { required: false, max: 2000 }) ?? null
  f.throwIfAny()

  if (data.status === 'completed') {
    data.completedAt = new Date()
    data.completedByEmployeeId = session.employeeId ?? null
  } else if (data.status && before.status === 'completed') {
    data.completedAt = null
    data.completedByEmployeeId = null
  }

  const row = await prisma.bookkeepingTask.update({
    where: { id: before.id }, data, include: { client: true, period: true, stage: true },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'bookkeeping.task.update',
    entityType: 'BookkeepingTask', entityId: row.id, before, after: row, req,
  })
  if (data.status && data.status !== before.status) {
    await writeBkActivity({
      clientId: row.clientId, periodId: row.periodId, actorUserId: session.userId,
      action: 'Task status changed', detail: `${row.title}: ${before.status} → ${row.status}`,
    })
  }
  const m = await employeeMap([row.assignedEmployeeId, row.completedByEmployeeId])
  ok(res, taskToApi(row, m))
}))

// ── Pending items ─────────────────────────────────────────────────────────
bookkeepingRouter.get('/pending-items', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)
  const search = q(req, 'q')

  const rows = await prisma.bookkeepingPendingItem.findMany({
    where: {
      ...alive, ...where,
      ...(q(req, 'status') ? { status: q(req, 'status')! } : {}),
      ...(q(req, 'priority') ? { priority: q(req, 'priority')! } : {}),
      ...(q(req, 'category') ? { category: q(req, 'category')! } : {}),
      ...(q(req, 'client_id') ? { clientId: q(req, 'client_id')! } : {}),
      ...(q(req, 'period_id') ? { periodId: q(req, 'period_id')! } : {}),
      ...(q(req, 'due') === 'overdue' ? { dueDate: { lt: today() }, status: { notIn: ['resolved', 'received'] } } : {}),
      ...(search ? { title: { contains: search, mode: 'insensitive' as const } } : {}),
    },
    include: { client: true, period: true },
    orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
  })
  const m = await employeeMap(rows.map((r) => r.assignedEmployeeId))
  ok(res, { items: rows.map((r) => pendingItemToApi(r, m)), count: rows.length, scope })
}))

bookkeepingRouter.post('/pending-items', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const b = body(req)
  const f = new FieldErrors()
  const clientId = f.str('client_id', b.client_id)
  const title = f.str('title', b.title, { max: 200 })
  const category = f.oneOf('category', b.category ?? 'other', PENDING_CATEGORIES)
  const priority = f.oneOf('priority', b.priority ?? 'medium', PRIORITIES)
  const dueDate = f.date('due_date', b.due_date, false)
  const periodId = f.str('period_id', b.period_id, { required: false })
  const assignedEmployeeId = f.str('assigned_employee_id', b.assigned_employee_id, { required: false })
  const description = f.str('description', b.description, { required: false, max: 2000 })
  f.throwIfAny()
  await assertCanSeeClient(session, scope, clientId!)

  const row = await prisma.bookkeepingPendingItem.create({
    data: {
      clientId: clientId!, periodId: periodId ?? null, title: title!, description: description ?? null,
      category: category!, priority: priority!, requestedDate: today(),
      dueDate: dueDate ?? null, assignedEmployeeId: assignedEmployeeId ?? null, createdById: session.userId,
    },
    include: { client: true, period: true },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'bookkeeping.pending_item.create',
    entityType: 'BookkeepingPendingItem', entityId: row.id, after: row, req,
  })
  await writeBkActivity({
    clientId: row.clientId, periodId: row.periodId, actorUserId: session.userId,
    action: 'Pending item raised', detail: row.title,
  })
  const m = await employeeMap([row.assignedEmployeeId])
  ok(res, pendingItemToApi(row, m), 201)
}))

bookkeepingRouter.patch('/pending-items/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const before = await prisma.bookkeepingPendingItem.findFirst({ where: { ...alive, id: req.params.id } })
  if (!before) throw ApiError.notFound('Pending item not found.')
  await assertCanSeeClient(session, scope, before.clientId)

  const b = body(req)
  const f = new FieldErrors()
  const data: Record<string, unknown> = {}
  if (b.title !== undefined) data.title = f.str('title', b.title, { max: 200 })
  if (b.status !== undefined) data.status = f.oneOf('status', b.status, PENDING_STATUSES)
  if (b.category !== undefined) data.category = f.oneOf('category', b.category, PENDING_CATEGORIES)
  if (b.priority !== undefined) data.priority = f.oneOf('priority', b.priority, PRIORITIES)
  if (b.due_date !== undefined) data.dueDate = f.date('due_date', b.due_date, false) ?? null
  if (b.assigned_employee_id !== undefined) data.assignedEmployeeId = f.str('assigned_employee_id', b.assigned_employee_id, { required: false }) ?? null
  if (b.notes !== undefined) data.notes = f.str('notes', b.notes, { required: false, max: 2000 }) ?? null
  f.throwIfAny()

  if (data.status === 'resolved') data.resolvedDate = new Date()
  else if (data.status && before.status === 'resolved') data.resolvedDate = null

  const row = await prisma.bookkeepingPendingItem.update({
    where: { id: before.id }, data, include: { client: true, period: true },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'bookkeeping.pending_item.update',
    entityType: 'BookkeepingPendingItem', entityId: row.id, before, after: row, req,
  })
  if (data.status && data.status !== before.status) {
    await writeBkActivity({
      clientId: row.clientId, periodId: row.periodId, actorUserId: session.userId,
      action: 'Pending item updated', detail: `${row.title}: ${before.status} → ${row.status}`,
    })
  }
  const m = await employeeMap([row.assignedEmployeeId])
  ok(res, pendingItemToApi(row, m))
}))

// ── Document requests ─────────────────────────────────────────────────────
bookkeepingRouter.get('/document-requests', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)
  const search = q(req, 'q')

  const rows = await prisma.bookkeepingDocumentRequest.findMany({
    where: {
      ...alive, ...where,
      ...(q(req, 'status') ? { status: q(req, 'status')! } : {}),
      ...(q(req, 'document_type') ? { documentType: q(req, 'document_type')! } : {}),
      ...(q(req, 'client_id') ? { clientId: q(req, 'client_id')! } : {}),
      ...(q(req, 'period_id') ? { periodId: q(req, 'period_id')! } : {}),
      ...(search ? { description: { contains: search, mode: 'insensitive' as const } } : {}),
    },
    include: { client: true, period: true, clientDocument: true },
    orderBy: [{ dueDate: 'asc' }, { requestedAt: 'desc' }],
  })
  ok(res, { items: rows.map((r) => documentRequestToApi(r, new Map())), count: rows.length, scope })
}))

bookkeepingRouter.post('/document-requests', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const b = body(req)
  const f = new FieldErrors()
  const clientId = f.str('client_id', b.client_id)
  const documentType = f.oneOf('document_type', b.document_type, DOCUMENT_TYPES)
  const description = f.str('description', b.description, { required: false, max: 2000 })
  const dueDate = f.date('due_date', b.due_date, false)
  const periodId = f.str('period_id', b.period_id, { required: false })
  f.throwIfAny()
  await assertCanSeeClient(session, scope, clientId!)

  const row = await prisma.bookkeepingDocumentRequest.create({
    data: {
      clientId: clientId!, periodId: periodId ?? null, documentType: documentType!,
      description: description ?? null, dueDate: dueDate ?? null, requestedById: session.userId,
    },
    include: { client: true, period: true, clientDocument: true },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'bookkeeping.document_request.create',
    entityType: 'BookkeepingDocumentRequest', entityId: row.id, after: row, req,
  })
  await writeBkActivity({
    clientId: row.clientId, periodId: row.periodId, actorUserId: session.userId,
    action: 'Document requested', detail: row.documentType.replace(/_/g, ' '),
  })
  ok(res, documentRequestToApi(row, new Map()), 201)
}))

bookkeepingRouter.patch('/document-requests/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const before = await prisma.bookkeepingDocumentRequest.findFirst({ where: { ...alive, id: req.params.id } })
  if (!before) throw ApiError.notFound('Document request not found.')
  await assertCanSeeClient(session, scope, before.clientId)

  const b = body(req)
  const f = new FieldErrors()
  const data: Record<string, unknown> = {}
  if (b.status !== undefined) data.status = f.oneOf('status', b.status, DOCREQ_STATUSES)
  if (b.description !== undefined) data.description = f.str('description', b.description, { required: false, max: 2000 }) ?? null
  if (b.due_date !== undefined) data.dueDate = f.date('due_date', b.due_date, false) ?? null
  if (b.client_document_id !== undefined) data.clientDocumentId = f.str('client_document_id', b.client_document_id, { required: false }) ?? null
  f.throwIfAny()

  // Linking a real ClientDocument is what "received" means — storage stays in
  // the existing Documents module, this row only records the ask.
  if (data.clientDocumentId) {
    const doc = await prisma.clientDocument.findFirst({
      where: { ...alive, id: data.clientDocumentId as string, clientId: before.clientId },
    })
    if (!doc) throw ApiError.badRequest('That document does not belong to this client.')
    data.receivedAt = new Date()
    if (!data.status) data.status = 'received'
  }

  const row = await prisma.bookkeepingDocumentRequest.update({
    where: { id: before.id }, data,
    include: { client: true, period: true, clientDocument: true },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'bookkeeping.document_request.update',
    entityType: 'BookkeepingDocumentRequest', entityId: row.id, before, after: row, req,
  })
  if (data.status && data.status !== before.status) {
    await writeBkActivity({
      clientId: row.clientId, periodId: row.periodId, actorUserId: session.userId,
      action: 'Document request updated', detail: `${row.documentType.replace(/_/g, ' ')}: ${before.status} → ${row.status}`,
    })
  }
  ok(res, documentRequestToApi(row, new Map()))
}))

// ── Imports (the financial data layer, spec §5 / §6.4) ────────────────────
//
// Every file the firm pulls into a period lands here. Two blocking
// validations (period + company) run BEFORE the row lands as `imported`;
// a mismatch produces a `rejected_*` row with the reason on it so the UI
// can render "▍ Rejected: <why>" instead of pretending the file wasn't
// uploaded. Files are always stored — a reviewer needs to see WHAT was
// refused, not just the fact of a refusal.
//
// Row-level parsing (populating rowCount + BookkeepingLedgerBalance) is
// added by later PRs per kind. This route stops at the metadata contract.

const IMPORT_MAX_MB = 25
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMPORT_MAX_MB * 1024 * 1024, files: 1 },
})

// POST /api/bookkeeping/imports  (multipart/form-data)
//   file                     the uploaded file
//   period_id                target period
//   kind                     trial_balance | day_book | outstandings | bank_statement
//   source                   upload | email | agent   (default 'upload')
//   company_name_in_file     what the file says the company is
//   period_from_in_file      'YYYY-MM-DD' the file starts at
//   period_to_in_file        'YYYY-MM-DD' the file ends at
bookkeepingRouter.post('/imports',
  (req, res, next) => {
    importUpload.single('file')(req, res, (err: unknown) => {
      if (!err) return next()
      const code = (err as { code?: string }).code
      if (code === 'LIMIT_FILE_SIZE') {
        return next(ApiError.unprocessable('too_large', `File is larger than the ${IMPORT_MAX_MB} MB limit.`))
      }
      next(ApiError.badRequest('Upload could not be read.'))
    })
  },
  handler(async (req, res) => {
    const session = requireSession(req)
    const scope = requireWorkstation(session, ...MANAGE)

    const b = body(req)
    const f = new FieldErrors()
    const periodId = f.str('period_id', b.period_id)
    const kind = f.oneOf('kind', b.kind, IMPORT_KINDS)
    const source = f.oneOf('source', b.source ?? 'upload', IMPORT_SOURCES)
    const companyNameInFile = f.str('company_name_in_file', b.company_name_in_file, { max: 300 })
    const periodFromInFile = f.date('period_from_in_file', b.period_from_in_file, true)
    const periodToInFile = f.date('period_to_in_file', b.period_to_in_file, true)
    f.throwIfAny()

    const file = req.file
    if (!file) throw ApiError.unprocessable('empty', 'Choose a file to upload.')
    if (file.size === 0) throw ApiError.unprocessable('empty', 'The uploaded file is empty.')

    const period = await prisma.bookkeepingPeriod.findFirst({
      where: { ...alive, id: periodId! },
      include: { engagement: { include: { client: true } } },
    })
    if (!period) throw ApiError.notFound('Period not found.')
    await assertCanSeeClient(session, scope, period.engagement.clientId)

    // The period must have periodStart/periodEnd populated by PR-2's
    // generator; without those we cannot run the period check. In practice
    // the seed backfill has already filled them for every row.
    if (!period.periodStart || !period.periodEnd) {
      throw ApiError.unprocessable(
        'period_window_missing',
        'This period has no start/end date. Reopen it or update the engagement so a window is derived.',
      )
    }

    const outcome = validateImport({
      clientCompanyName: period.engagement.client?.companyName ?? '',
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      companyNameInFile: companyNameInFile!,
      periodFromInFile: periodFromInFile!,
      periodToInFile: periodToInFile!,
      periodLabel: periodLabel(period.year, period.month),
    })

    // Create the row FIRST — its id is part of the storage key so a
    // failed write leaves no orphan file — then store the file, then
    // update the row with the storagePath. If storage fails, roll the
    // row back to `parse_failed` with the reason.
    const importRow = await prisma.bookkeepingImport.create({
      data: {
        periodId: period.id,
        clientId: period.engagement.clientId,
        kind: kind!,
        source: source!,
        originalFilename: file.originalname,
        storagePath: '',            // filled below
        fileSize: file.size,
        mimeType: file.mimetype || 'application/octet-stream',
        companyNameInFile: companyNameInFile!,
        periodFromInFile: periodFromInFile!,
        periodToInFile: periodToInFile!,
        status: outcome.status,
        errorDetail: outcome.reason,
        importedByEmployeeId: session.employeeId ?? null,
      },
    })

    const key = importStorageKey({
      periodId: period.id,
      importId: importRow.id,
      originalFilename: file.originalname,
    })
    try {
      await bookkeepingImportStorage.put(key, file.buffer)
    } catch (err) {
      await prisma.bookkeepingImport.update({
        where: { id: importRow.id },
        data: { status: 'parse_failed', errorDetail: `Could not store the uploaded file: ${err instanceof Error ? err.message : String(err)}` },
      })
      throw ApiError.unprocessable('storage_failed', 'The file could not be saved.')
    }

    let stored = await prisma.bookkeepingImport.update({
      where: { id: importRow.id },
      data: { storagePath: key },
    })

    // Trial balances parse INTO BookkeepingLedgerBalance so the Reports
    // tab has numbers to render. Other kinds land their file today and
    // wait for their per-kind parser in a follow-up PR. A parser failure
    // never invalidates the file — the row moves to parse_failed with the
    // reason, and the file is retained for a reviewer.
    if (outcome.status === 'imported' && kind === 'trial_balance') {
      try {
        const text = file.buffer.toString('utf8')
        const parsed = parseTrialBalanceCsv(text)
        const groups = await loadLedgerGroups(prisma)
        await prisma.$transaction([
          prisma.bookkeepingLedgerBalance.deleteMany({ where: { importId: stored.id } }),
          prisma.bookkeepingLedgerBalance.createMany({
            data: parsed.rows.map((r) => {
              const cls = classify(groups, r.parentGroup)
              return {
                importId: stored.id,
                ledgerName: r.ledgerName,
                parentGroup: r.parentGroup,
                category: cls.category,
                subtype: cls.subtype,
                openingPaise: r.openingPaise,
                debitPaise: r.debitPaise,
                creditPaise: r.creditPaise,
                closingPaise: r.closingPaise,
                raw: r.raw,
              }
            }),
          }),
        ])
        stored = await prisma.bookkeepingImport.update({
          where: { id: stored.id },
          data: { rowCount: parsed.rowCount },
        })
      } catch (err) {
        stored = await prisma.bookkeepingImport.update({
          where: { id: stored.id },
          data: {
            status: 'parse_failed',
            errorDetail: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }

    await writeAudit({
      actorUserId: session.userId, action: 'bookkeeping.import.create',
      entityType: 'BookkeepingImport', entityId: stored.id, after: stored, req,
    })
    await writeBkActivity({
      clientId: period.engagement.clientId, periodId: period.id, actorUserId: session.userId,
      action: `Import ${stored.status}`,
      detail: `${kind!.replace(/_/g, ' ')} · ${file.originalname}${stored.errorDetail ? ` — ${stored.errorDetail}` : ''}`,
    })

    const m = await employeeMap([stored.importedByEmployeeId])
    ok(res, importToApi(stored, m), 201)
  }),
)

// GET /api/bookkeeping/periods/:id/reports
//
// The Reports tab (spec §6.5). All five reports are derived from the
// latest imported trial balance for the period; if none exists, every
// report returns { available:false } with a verbatim empty-state message.
//
// Declared BEFORE the /imports list so `/periods/:id/reports` doesn't
// need a separate router mount.
bookkeepingRouter.get('/periods/:id/reports', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const period = await prisma.bookkeepingPeriod.findFirst({
    where: { ...alive, id: req.params.id },
    include: { engagement: true },
  })
  if (!period) throw ApiError.notFound('Period not found.')
  await assertCanSeeClient(session, scope, period.engagement.clientId)
  const reports = await reportsForPeriod(prisma, period.id)
  ok(res, { reports })
}))

// GET /api/bookkeeping/imports?period_id=&kind=
bookkeepingRouter.get('/imports', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)

  const periodId = q(req, 'period_id')
  const kind = q(req, 'kind')

  const rows = await prisma.bookkeepingImport.findMany({
    where: {
      ...where,
      ...(periodId ? { periodId } : {}),
      ...(kind ? { kind } : {}),
    },
    orderBy: { importedAt: 'desc' },
    take: 200,
  })
  const m = await employeeMap(rows.map((r) => r.importedByEmployeeId))
  ok(res, { items: rows.map((r) => importToApi(r, m)), count: rows.length, scope })
}))

// ── Deliverables ──────────────────────────────────────────────────────────
bookkeepingRouter.get('/deliverables', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)

  const rows = await prisma.bookkeepingDeliverable.findMany({
    where: {
      ...alive, ...where,
      ...(q(req, 'status') ? { status: q(req, 'status')! } : {}),
      ...(q(req, 'type') ? { type: q(req, 'type')! } : {}),
      ...(q(req, 'client_id') ? { clientId: q(req, 'client_id')! } : {}),
      ...(q(req, 'period_id') ? { periodId: q(req, 'period_id')! } : {}),
    },
    include: { client: true, period: true, clientDocument: true },
    orderBy: [{ createdAt: 'desc' }],
  })
  const m = await employeeMap(rows.flatMap((r) => [r.preparedByEmployeeId, r.reviewedByEmployeeId]))
  ok(res, { items: rows.map((r) => deliverableToApi(r, m)), count: rows.length, scope })
}))

bookkeepingRouter.post('/deliverables', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const b = body(req)
  const f = new FieldErrors()
  const clientId = f.str('client_id', b.client_id)
  const type = f.oneOf('type', b.type, DELIVERABLE_TYPES)
  const periodId = f.str('period_id', b.period_id, { required: false })
  const notes = f.str('notes', b.notes, { required: false, max: 2000 })
  f.throwIfAny()
  await assertCanSeeClient(session, scope, clientId!)

  const row = await prisma.bookkeepingDeliverable.create({
    data: {
      clientId: clientId!, periodId: periodId ?? null, type: type!,
      preparedByEmployeeId: session.employeeId ?? null, notes: notes ?? null,
    },
    include: { client: true, period: true, clientDocument: true },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'bookkeeping.deliverable.create',
    entityType: 'BookkeepingDeliverable', entityId: row.id, after: row, req,
  })
  await writeBkActivity({
    clientId: row.clientId, periodId: row.periodId, actorUserId: session.userId,
    action: 'Deliverable created', detail: row.type.replace(/_/g, ' '),
  })
  const m = await employeeMap([row.preparedByEmployeeId])
  ok(res, deliverableToApi(row, m), 201)
}))

bookkeepingRouter.patch('/deliverables/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const before = await prisma.bookkeepingDeliverable.findFirst({ where: { ...alive, id: req.params.id } })
  if (!before) throw ApiError.notFound('Deliverable not found.')
  await assertCanSeeClient(session, scope, before.clientId)

  const b = body(req)
  const f = new FieldErrors()
  const data: Record<string, unknown> = {}
  if (b.status !== undefined) data.status = f.oneOf('status', b.status, DELIVERABLE_STATUSES)
  if (b.notes !== undefined) data.notes = f.str('notes', b.notes, { required: false, max: 2000 }) ?? null
  if (b.client_document_id !== undefined) data.clientDocumentId = f.str('client_document_id', b.client_document_id, { required: false }) ?? null
  f.throwIfAny()

  if (data.status === 'approved') {
    data.approvedAt = new Date()
    data.reviewedByEmployeeId = session.employeeId ?? null
  }
  if (data.status === 'delivered') data.deliveredAt = new Date()

  const row = await prisma.bookkeepingDeliverable.update({
    where: { id: before.id }, data,
    include: { client: true, period: true, clientDocument: true },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'bookkeeping.deliverable.update',
    entityType: 'BookkeepingDeliverable', entityId: row.id, before, after: row, req,
  })
  if (data.status && data.status !== before.status) {
    await writeBkActivity({
      clientId: row.clientId, periodId: row.periodId, actorUserId: session.userId,
      action: 'Deliverable updated', detail: `${row.type.replace(/_/g, ' ')}: ${before.status} → ${row.status}`,
    })
  }
  const m = await employeeMap([row.preparedByEmployeeId, row.reviewedByEmployeeId])
  ok(res, deliverableToApi(row, m))
}))

// ── Reminders ─────────────────────────────────────────────────────────────
// Reuses the existing FollowUp table (§17) rather than adding a second
// reminder system; these are simply follow-ups tagged to bookkeeping clients.
bookkeepingRouter.get('/reminders', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)

  const engagements = await prisma.bookkeepingEngagement.findMany({
    where: { ...alive, ...where }, select: { clientId: true },
  })
  const clientIds = engagements.map((e) => e.clientId)

  const rows = await prisma.followUp.findMany({
    where: {
      ...alive,
      clientId: { in: clientIds },
      ...(q(req, 'status') ? { status: q(req, 'status')! } : {}),
      ...(q(req, 'client_id') ? { clientId: q(req, 'client_id')! } : {}),
    },
    include: { client: true },
    orderBy: [{ scheduledAt: 'asc' }],
  })
  const m = await employeeMap(rows.map((r) => r.assignedEmployeeId))
  ok(res, {
    items: rows.map((r) => ({
      id: r.id,
      client_id: r.clientId,
      client_name: r.client?.companyName ?? null,
      title: r.title,
      type: r.type,
      scheduled_at: r.scheduledAt.toISOString(),
      status: r.status,
      notes: r.notes,
      assigned_employee: m.get(r.assignedEmployeeId) ?? null,
    })),
    count: rows.length,
    scope,
  })
}))

bookkeepingRouter.post('/reminders', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const b = body(req)
  const f = new FieldErrors()
  const clientId = f.str('client_id', b.client_id)
  const title = f.str('title', b.title, { max: 200 })
  const assignedEmployeeId = f.str('assigned_employee_id', b.assigned_employee_id)
  const notes = f.str('notes', b.notes, { required: false, max: 2000 })
  const scheduledAtRaw = f.str('scheduled_at', b.scheduled_at)
  f.throwIfAny()
  await assertCanSeeClient(session, scope, clientId!)

  const scheduledAt = new Date(scheduledAtRaw!)
  if (Number.isNaN(scheduledAt.getTime())) throw ApiError.badRequest('scheduled_at must be a valid date-time.')

  const client = await prisma.client.findFirst({ where: { ...alive, id: clientId! } })
  if (!client) throw ApiError.notFound('Client not found.')

  const row = await prisma.followUp.create({
    data: {
      organisationId: client.organisationId,
      clientId: clientId!, title: title!, type: 'service_followup',
      scheduledAt, assignedEmployeeId: assignedEmployeeId!, notes: notes ?? null,
      createdBy: session.userId,
    },
    include: { client: true },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'bookkeeping.reminder.create',
    entityType: 'FollowUp', entityId: row.id, after: row, req,
  })
  const m = await employeeMap([row.assignedEmployeeId])
  ok(res, {
    id: row.id, client_id: row.clientId, client_name: row.client?.companyName ?? null,
    title: row.title, type: row.type, scheduled_at: row.scheduledAt.toISOString(),
    status: row.status, notes: row.notes, assigned_employee: m.get(row.assignedEmployeeId) ?? null,
  }, 201)
}))

bookkeepingRouter.patch('/reminders/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const before = await prisma.followUp.findFirst({ where: { ...alive, id: req.params.id } })
  if (!before) throw ApiError.notFound('Reminder not found.')
  if (before.clientId) await assertCanSeeClient(session, scope, before.clientId)

  const b = body(req)
  const f = new FieldErrors()
  const status = f.oneOf('status', b.status, ['pending', 'completed', 'rescheduled', 'cancelled', 'missed'] as const)
  f.throwIfAny()

  const row = await prisma.followUp.update({
    where: { id: before.id },
    data: {
      status: status!,
      ...(status === 'completed'
        ? { completedAt: new Date(), completedByEmployeeId: session.employeeId ?? null }
        : {}),
    },
    include: { client: true },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'bookkeeping.reminder.update',
    entityType: 'FollowUp', entityId: row.id, before, after: row, req,
  })
  const m = await employeeMap([row.assignedEmployeeId])
  ok(res, {
    id: row.id, client_id: row.clientId, client_name: row.client?.companyName ?? null,
    title: row.title, type: row.type, scheduled_at: row.scheduledAt.toISOString(),
    status: row.status, notes: row.notes, assigned_employee: m.get(row.assignedEmployeeId) ?? null,
  })
}))

// ── Settings ──────────────────────────────────────────────────────────────
// The vocabulary the UI renders its dropdowns from, so the two can never
// drift apart.
bookkeepingRouter.get('/settings', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, ...READ)
  const stages = await prisma.bookkeepingWorkflowStage.findMany({
    where: { isActive: true }, orderBy: { sequence: 'asc' },
  })
  ok(res, {
    engagement_statuses: ENGAGEMENT_STATUSES,
    billing_frequencies: BILLING_FREQUENCIES,
    period_statuses: PERIOD_STATUSES,
    task_statuses: TASK_STATUSES,
    task_categories: TASK_CATEGORIES,
    priorities: PRIORITIES,
    pending_statuses: PENDING_STATUSES,
    pending_categories: PENDING_CATEGORIES,
    document_types: DOCUMENT_TYPES,
    docreq_statuses: DOCREQ_STATUSES,
    deliverable_types: DELIVERABLE_TYPES,
    deliverable_statuses: DELIVERABLE_STATUSES,
    workflow_stages: stages.map(workflowStageToApi),
    // Legacy view of stages as a flat string[], retained for one release.
    workflow_steps: WORKFLOW_STEPS,
  })
}))
