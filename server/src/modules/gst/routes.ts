/**
 * GST COMPLIANCE SERVICE — Workstation → Services → Registration → GST.
 *
 * IT FILES NOTHING. Audit OS has no GSTN connectivity (§31): an employee
 * files on the government portal in another tab and records the outcome
 * here, so every filed row carries `filed_manually: true` and the screens
 * say "Filed — manually recorded".
 *
 * Permissions are the EXISTING workstation.gst.read / .manage pair — this
 * module adds no permission code. Client scoping goes through the GST
 * profile, so an employee only ever sees periods for clients assigned to
 * them (§38) — enforced in the query, never as a post-fetch filter.
 */
import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma, alive } from '../../lib/prisma.js'
import { handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { requireWorkstation, assignedClientIds } from '../../platform/workstation/scope.js'
import { employeeMap } from '../../api/workstation.serialize.js'
import { periodToApi, profileToApi, stagesOf, type PeriodRow } from './serialize.js'
import { backfillPeriods, daysRemaining, deriveOverall, nextDueOf, today } from './service.js'

export const gstRouter = Router()

const READ = ['workstation.gst.read', 'workstation.gst.manage'] as const
const periodInclude = Prisma.validator<Prisma.GstCompliancePeriodInclude>()({
  gstProfile: { include: { client: { select: { id: true, companyName: true } } } },
  filings: { where: alive },
  r2b: true,
  reconciliation: true,
  _count: { select: { exceptions: { where: { status: { not: 'resolved' } } } } },
})

/** Scope as a GstCompliancePeriod `where` — the client lives two hops away. */
async function periodScopeWhere(session: ReturnType<typeof requireSession>, scope: 'self' | 'department' | 'organisation') {
  const ids = await assignedClientIds(session, scope)
  return ids === 'ALL' ? {} : { gstProfile: { clientId: { in: ids } } }
}

const str = (q: unknown) => (typeof q === 'string' && q ? q : null)

// ── Dashboard ──────────────────────────────────────────────────────────────

/**
 * GET /api/gst/overview — the §8 summary cards.
 *
 * Counted in the DATABASE, not by loading rows (§37). Stage counts are
 * groupBy aggregates; the derived ones (overdue / due soon / completed)
 * need the stage combination, so they come from one lean projection rather
 * than the full include.
 */
gstRouter.get('/overview', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = { ...alive, ...(await periodScopeWhere(session, scope)) }
  const fy = str(req.query.fy)
  const period = str(req.query.period)
  const scoped = { ...where, ...(fy ? { financialYear: fy } : {}), ...(period ? { period } : {}) }

  const [totalClients, totalPeriods, rows, exceptionsOpen] = await Promise.all([
    prisma.gstProfile.count({ where: { ...alive, active: true } }),
    prisma.gstCompliancePeriod.count({ where: scoped }),
    prisma.gstCompliancePeriod.findMany({
      where: scoped,
      select: {
        period: true, periodType: true,
        filings: { where: alive, select: { returnType: true, status: true, paymentStatus: true } },
        r2b: { select: { status: true } },
        reconciliation: { select: { status: true } },
        _count: { select: { exceptions: { where: { status: { not: 'resolved' } } } } },
      },
    }),
    prisma.gstException.count({ where: { ...alive, status: { not: 'resolved' } } }),
  ])

  const t = today()
  const tally = {
    gstr1: { filed: 0, pending: 0, overdue: 0 },
    gstr2b: { available: 0, pending: 0, reconciliation_pending: 0, reconciled: 0 },
    gstr3b: { filed: 0, pending: 0, payment_pending: 0, overdue: 0 },
    due_today: 0, due_soon: 0, overdue: 0, completed: 0, in_progress: 0,
    not_started: 0, exceptions: exceptionsOpen,
  }

  for (const r of rows) {
    const stages = stagesOf(r as unknown as PeriodRow)
    const g1 = stages.gstr1, g3 = stages.gstr3b, r2b = stages.gstr2b
    const due1 = nextDueOf(r.period, r.periodType, { ...stages, gstr3b: 'filed' })
    const due3 = nextDueOf(r.period, r.periodType, { ...stages, gstr1: 'filed' })

    if (g1 === 'filed' || g1 === 'completed') tally.gstr1.filed++
    else { tally.gstr1.pending++; if (due1 && due1 < t) tally.gstr1.overdue++ }

    if (r2b === 'reconciliation_completed') tally.gstr2b.reconciled++
    else if (r2b === 'available' || r2b === 'downloaded') tally.gstr2b.available++
    else if (r2b === 'reconciliation_pending' || r2b === 'reconciliation_in_progress') tally.gstr2b.reconciliation_pending++
    else tally.gstr2b.pending++

    const pay = r.filings.find((f) => f.returnType === 'GSTR-3B')?.paymentStatus
    if (g3 === 'filed' || g3 === 'completed') {
      tally.gstr3b.filed++
      if (pay === 'pending') tally.gstr3b.payment_pending++
    } else { tally.gstr3b.pending++; if (due3 && due3 < t) tally.gstr3b.overdue++ }

    const nextDue = nextDueOf(r.period, r.periodType, stages)
    const overall = deriveOverall(stages, nextDue, r._count.exceptions)
    if (overall === 'completed') tally.completed++
    else if (overall === 'overdue') tally.overdue++
    else if (overall === 'in_progress') tally.in_progress++
    else if (overall === 'not_started') tally.not_started++

    const d = daysRemaining(nextDue, t)
    if (d !== null && overall !== 'completed') {
      if (d === 0) tally.due_today++
      else if (d > 0 && d <= 7) tally.due_soon++
    }
  }

  ok(res, { total_clients: totalClients, total_periods: totalPeriods, ...tally, scope })
}))

// ── The §9 central table ───────────────────────────────────────────────────

/**
 * GET /api/gst/periods — filtered in the DATABASE and paginated (§7/§37).
 * Derived filters (overall status, due window) are applied after derivation
 * because they are not columns; everything a column CAN express is a where.
 */
gstRouter.get('/periods', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const q = req.query

  const page = Math.max(1, Number(str(q.page) ?? 1))
  const pageSize = Math.min(100, Math.max(1, Number(str(q.page_size) ?? 25)))
  const clientId = str(q.client_id)
  const gstin = str(q.gstin)
  const search = str(q.q)

  // §27 search and the client/GSTIN filters all live on the profile, so they
  // are composed into ONE relation filter rather than several spreads.
  const profileWhere: Prisma.GstProfileWhereInput = {
    ...(clientId ? { clientId } : {}),
    ...(gstin ? { gstin: { contains: gstin, mode: 'insensitive' } } : {}),
    ...(search
      ? {
          OR: [
            { gstin: { contains: search, mode: 'insensitive' } },
            { pan: { contains: search, mode: 'insensitive' } },
            { client: { companyName: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  }

  const where: Prisma.GstCompliancePeriodWhereInput = {
    ...alive,
    ...(await periodScopeWhere(session, scope)),
    ...(str(q.fy) ? { financialYear: str(q.fy)! } : {}),
    ...(str(q.period) ? { period: str(q.period)! } : {}),
    ...(str(q.employee_id) ? { assignedEmployeeId: str(q.employee_id)! } : {}),
    ...(str(q.reviewer_id) ? { reviewerEmployeeId: str(q.reviewer_id)! } : {}),
    ...(Object.keys(profileWhere).length ? { gstProfile: profileWhere } : {}),
  }

  const [total, rows] = await Promise.all([
    prisma.gstCompliancePeriod.count({ where }),
    prisma.gstCompliancePeriod.findMany({
      where,
      include: periodInclude,
      orderBy: [{ period: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  const employees = await employeeMap(
    rows.flatMap((r) => [r.assignedEmployeeId, r.reviewerEmployeeId]),
  )
  let items = rows.map((r) => periodToApi(r as unknown as PeriodRow, employees, r._count.exceptions))

  const status = str(q.status)
  if (status) items = items.filter((i) => i.overall_status === status)
  const due = str(q.due)
  if (due) {
    items = items.filter((i) => {
      const d = i.days_remaining
      if (d === null) return false
      if (due === 'today') return d === 0
      if (due === 'soon') return d > 0 && d <= 7
      if (due === 'overdue') return d < 0
      return true
    })
  }

  ok(res, { items, count: items.length, total, page, page_size: pageSize, scope })
}))

// GET /api/gst/periods/:id — the §19 client GST detail.
gstRouter.get('/periods/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const row = await prisma.gstCompliancePeriod.findFirst({
    where: { ...alive, id: req.params.id, ...(await periodScopeWhere(session, scope)) },
    include: {
      ...periodInclude,
      exceptions: { where: alive, orderBy: { createdAt: 'desc' } },
      assignments: { orderBy: { assignedAt: 'desc' } },
      auditLogs: { orderBy: { performedAt: 'desc' }, take: 50 },
    },
  })
  if (!row) return ok(res, null, 404)

  const employees = await employeeMap([row.assignedEmployeeId, row.reviewerEmployeeId, row.managerEmployeeId])
  ok(res, {
    ...periodToApi(row as unknown as PeriodRow, employees, row._count.exceptions),
    exceptions: row.exceptions.map((e) => ({
      id: e.id, stage: e.stage, issue_type: e.issueType, severity: e.severity,
      title: e.title, status: e.status, due_date: e.dueDate,
    })),
    timeline: row.auditLogs.map((a) => ({
      action: a.action, stage: a.stage, at: a.performedAt.toISOString(),
    })),
  })
}))

// ── GST clients (§11) ──────────────────────────────────────────────────────

gstRouter.get('/clients', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const ids = await assignedClientIds(session, scope)
  const rows = await prisma.gstProfile.findMany({
    where: {
      ...alive,
      ...(ids === 'ALL' ? {} : { clientId: { in: ids } }),
      ...(str(req.query.active) === 'false' ? {} : { active: true }),
    },
    include: { client: { select: { id: true, companyName: true } }, _count: { select: { periods: true } } },
    orderBy: { createdAt: 'asc' },
  })
  const employees = await employeeMap(rows.flatMap((r) => [r.assignedEmployeeId, r.reviewerEmployeeId]))
  ok(res, { items: rows.map((r) => profileToApi(r, employees)), count: rows.length, scope })
}))

// ── Period maintenance ─────────────────────────────────────────────────────

/**
 * POST /api/gst/periods/backfill — create the missing period rows for
 * filings that predate this module. Idempotent; safe to run repeatedly.
 */
gstRouter.post('/periods/backfill', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.gst.manage')
  ok(res, await backfillPeriods())
}))
