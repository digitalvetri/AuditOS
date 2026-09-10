import { Router } from 'express'
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
  BILLING_FREQUENCIES, CHECKLIST_STATUSES, DELIVERABLE_STATUSES, DELIVERABLE_TYPES,
  DOCREQ_STATUSES, DOCUMENT_TYPES, ENGAGEMENT_STATUSES, PENDING_CATEGORIES,
  PENDING_STATUSES, PERIOD_STATUSES, PRIORITIES, TASK_CATEGORIES, TASK_STATUSES,
  WORKFLOW_STEPS, CHECKLIST_TEMPLATE, periodLabel,
} from './validate.js'
import {
  createPeriodWithChecklist, overviewKpis, progressByPeriod, progressFrom,
  today, writeBkActivity,
} from './service.js'
import {
  activityToApi, checklistItemToApi, deliverableToApi, documentRequestToApi,
  engagementToApi, pendingItemToApi, periodToApi, taskToApi,
} from './serialize.js'

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
// GET /api/bookkeeping/overview
bookkeepingRouter.get('/overview', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)

  const kpis = await overviewKpis(where)

  // The month's periods, most urgent first, so Overview is actionable and
  // not just a wall of counters.
  const periods = await prisma.bookkeepingPeriod.findMany({
    where: {
      ...alive,
      ...(('clientId' in where) ? { engagement: { clientId: (where as { clientId: { in: string[] } }).clientId } } : {}),
      status: { not: 'completed' },
    },
    include: { engagement: { include: { client: true } } },
    orderBy: [{ dueDate: 'asc' }],
    take: 8,
  })
  const prog = await progressByPeriod(periods.map((p) => p.id))
  const m = await employeeMap(periods.map((p) => p.assignedEmployeeId))

  ok(res, {
    kpis,
    upcoming: periods.map((p) => periodToApi(p, m, prog.get(p.id))),
    scope,
  })
}))

// ── Clients ───────────────────────────────────────────────────────────────
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

  ok(res, {
    engagement: engagementToApi(engagement, m),
    periods: engagement.periods.map((p) => periodToApi(p, m, prog.get(p.id))),
    books_org_id: books.get(clientId) ?? null,
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
      billingFrequency: billingFrequency!, nextDueDate: nextDueDate ?? null, notes: notes ?? null,
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
      checklistItems: { orderBy: { sortOrder: 'asc' } },
      tasks: { where: alive, include: { client: true } },
      pendingItems: { where: alive, include: { client: true } },
      documentRequests: { where: alive, include: { client: true, clientDocument: true } },
      deliverables: { where: alive, include: { client: true, clientDocument: true } },
    },
  })
  if (!row) throw ApiError.notFound('Period not found.')
  await assertCanSeeClient(session, scope, row.engagement.clientId)

  const m = await employeeMap([
    row.assignedEmployeeId,
    ...row.checklistItems.map((c) => c.completedByEmployeeId),
    ...row.tasks.map((t) => t.assignedEmployeeId),
    ...row.pendingItems.map((p) => p.assignedEmployeeId),
    ...row.deliverables.flatMap((d) => [d.preparedByEmployeeId, d.reviewedByEmployeeId]),
  ])

  ok(res, {
    period: periodToApi(row, m, progressFrom(row.tasks)),
    checklist: row.checklistItems.map((c) => checklistItemToApi(c, m)),
    tasks: row.tasks.map((t) => taskToApi(t, m)),
    pending_items: row.pendingItems.map((p) => pendingItemToApi(p, m)),
    document_requests: row.documentRequests.map((d) => documentRequestToApi(d, m)),
    deliverables: row.deliverables.map((d) => deliverableToApi(d, m)),
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

  const row = await createPeriodWithChecklist(prisma, {
    engagementId: engagementId!, year, month,
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
    action: 'Period opened', detail: `${periodLabel(year, month)} opened with ${row.checklistItems.length} checklist items.`,
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
bookkeepingRouter.patch('/checklist-items/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const before = await prisma.bookkeepingChecklistItem.findFirst({
    where: { id: req.params.id }, include: { period: { include: { engagement: true } } },
  })
  if (!before) throw ApiError.notFound('Checklist item not found.')
  await assertCanSeeClient(session, scope, before.period.engagement.clientId)

  const b = body(req)
  const f = new FieldErrors()
  const status = f.oneOf('status', b.status, CHECKLIST_STATUSES)
  const notes = b.notes === undefined ? undefined : f.str('notes', b.notes, { required: false, max: 1000 }) ?? null
  f.throwIfAny()

  const row = await prisma.bookkeepingChecklistItem.update({
    where: { id: before.id },
    data: {
      status: status!,
      ...(notes === undefined ? {} : { notes }),
      completedAt: status === 'completed' ? new Date() : null,
      completedByEmployeeId: status === 'completed' ? session.employeeId ?? null : null,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'bookkeeping.checklist.update',
    entityType: 'BookkeepingChecklistItem', entityId: row.id, before, after: row, req,
  })
  const m = await employeeMap([row.completedByEmployeeId])
  ok(res, checklistItemToApi(row, m))
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
    include: { client: true, period: true },
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
    include: { client: true, period: true },
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
    where: { ...alive, id: req.params.id }, include: { client: true, period: true },
  })
  if (!row) throw ApiError.notFound('Task not found.')
  await assertCanSeeClient(session, scope, row.clientId)
  const m = await employeeMap([row.assignedEmployeeId])
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

  if (data.status === 'completed') data.completedAt = new Date()
  else if (data.status && before.status === 'completed') data.completedAt = null

  const row = await prisma.bookkeepingTask.update({
    where: { id: before.id }, data, include: { client: true, period: true },
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
  const m = await employeeMap([row.assignedEmployeeId])
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
  ok(res, {
    engagement_statuses: ENGAGEMENT_STATUSES,
    billing_frequencies: BILLING_FREQUENCIES,
    period_statuses: PERIOD_STATUSES,
    checklist_statuses: CHECKLIST_STATUSES,
    task_statuses: TASK_STATUSES,
    task_categories: TASK_CATEGORIES,
    priorities: PRIORITIES,
    pending_statuses: PENDING_STATUSES,
    pending_categories: PENDING_CATEGORIES,
    document_types: DOCUMENT_TYPES,
    docreq_statuses: DOCREQ_STATUSES,
    deliverable_types: DELIVERABLE_TYPES,
    deliverable_statuses: DELIVERABLE_STATUSES,
    workflow_steps: WORKFLOW_STEPS,
    checklist_template: CHECKLIST_TEMPLATE,
  })
}))
