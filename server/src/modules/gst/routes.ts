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
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { requireWorkstation, assignedClientIds } from '../../platform/workstation/scope.js'
import { employeeMap } from '../../api/workstation.serialize.js'
import { periodToApi, profileToApi, stagesOf, type PeriodRow } from './serialize.js'
import {
  backfillPeriods, daysRemaining, deriveOverall, dueDateFor, financialYearOf,
  nextDueOf, today, writeGstAudit,
} from './service.js'
import {
  assertDate, assertFilingRecord, assertGstin, assertGstinMatchesPan, assertGstr1Transition,
  assertGstr2bTransition, assertGstr3bTransition, assertOneOf, assertPan,
  normaliseFilingStatus, toPaise,
  FILING_FREQUENCIES, REGISTRATION_STATUSES, REGISTRATION_TYPES,
} from './validate.js'

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

// ── Per-stage work sections (§11–§19) ──────────────────────────────────────

/**
 * GET /api/gst/stages/:stage — one work queue: counts AND the client list.
 *
 * `stage` is gstr1 | gstr2b | gstr3b. The three share this handler because
 * they differ only in which row carries the status and which figures matter;
 * duplicating it three times would have meant three places to fix a due-date
 * rule. The summary is stage-specific, which is the point of §12/§14/§19.
 */
gstRouter.get('/stages/:stage', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const stage = req.params.stage
  if (!['gstr1', 'gstr2b', 'gstr3b'].includes(stage)) return ok(res, null, 404)

  const q = req.query
  const page = Math.max(1, Number(str(q.page) ?? 1))
  const pageSize = Math.min(100, Math.max(1, Number(str(q.page_size) ?? 25)))

  const where: Prisma.GstCompliancePeriodWhereInput = {
    ...alive,
    ...(await periodScopeWhere(session, scope)),
    ...(str(q.fy) ? { financialYear: str(q.fy)! } : {}),
    ...(str(q.period) ? { period: str(q.period)! } : {}),
    ...(str(q.employee_id) ? { assignedEmployeeId: str(q.employee_id)! } : {}),
  }

  // Counts are over the WHOLE filtered set, not the page — a summary that
  // only described the current page would be worse than no summary.
  const all = await prisma.gstCompliancePeriod.findMany({
    where,
    include: periodInclude,
    orderBy: [{ period: 'desc' }],
  })

  const t = today()
  const employees = await employeeMap(all.flatMap((r) => [r.assignedEmployeeId, r.reviewerEmployeeId]))
  const mapped = all.map((r) => periodToApi(r as unknown as PeriodRow, employees, r._count.exceptions))

  const returnType = stage === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'
  const statusOf = (m: (typeof mapped)[number]) =>
    stage === 'gstr1' ? m.stage_status.gstr1 : stage === 'gstr3b' ? m.stage_status.gstr3b : m.stage_status.gstr2b
  const dueOf = (m: (typeof mapped)[number]) =>
    stage === 'gstr2b' ? m.next_due_date : (stage === 'gstr1' ? m.gstr1?.due_date : m.gstr3b?.due_date) ?? m.next_due_date

  const DONE = stage === 'gstr2b'
    ? ['reconciliation_completed']
    : ['filed', 'completed']

  const summary: Record<string, number> = { today_work: 0, overdue: 0, completed: 0, total: mapped.length }
  if (stage === 'gstr1' || stage === 'gstr3b') {
    Object.assign(summary, { upcoming: 0, in_progress: 0, under_review: 0, ready_to_file: 0, payment_pending: 0 })
  } else {
    Object.assign(summary, { expected: 0, available: 0, downloaded: 0, reconciliation_pending: 0, exceptions: 0 })
  }

  for (const m of mapped) {
    const st = statusOf(m)
    const due = dueOf(m)
    const done = DONE.includes(st)
    if (done) summary.completed++
    if (!done && due === t) summary.today_work++
    if (!done && due && due < t) summary.overdue++

    if (stage === 'gstr2b') {
      if (st === 'available') summary.available++
      else if (st === 'downloaded') summary.downloaded++
      else if (st === 'expected' || st === 'pending') summary.expected++
      else if (st === 'reconciliation_pending' || st === 'reconciliation_in_progress') summary.reconciliation_pending++
      if (st === 'exceptions_found' || m.open_exceptions > 0) summary.exceptions++
    } else {
      if (!done && due && due > t) summary.upcoming++
      if (['data_preparation', 'in_preparation', 'data_collection'].includes(st)) summary.in_progress++
      if (st === 'under_review') summary.under_review++
      if (st === 'ready_to_file') summary.ready_to_file++
      const pay = stage === 'gstr3b' ? m.gstr3b?.payment_status : null
      if (pay === 'pending') summary.payment_pending++
    }
  }

  // Row filters, applied after derivation because status and due window are
  // derived values, not columns.
  let items = mapped
  const status = str(q.status)
  if (status) items = items.filter((m) => statusOf(m) === status)
  const due = str(q.due)
  if (due) {
    items = items.filter((m) => {
      const d = dueOf(m)
      const done = DONE.includes(statusOf(m))
      if (due === 'today') return !done && d === t
      if (due === 'overdue') return !done && !!d && d < t
      if (due === 'upcoming') return !done && !!d && d > t
      if (due === 'completed') return done
      return true
    })
  }

  const total = items.length
  const paged = items.slice((page - 1) * pageSize, page * pageSize)

  ok(res, {
    stage,
    return_type: stage === 'gstr2b' ? null : returnType,
    summary,
    items: paged.map((m) => ({ ...m, stage_status_value: statusOf(m), stage_due_date: dueOf(m) })),
    count: paged.length,
    total,
    page,
    page_size: pageSize,
    scope,
  })
}))

// ── Writes (§30 assignment, §13/§15/§20 workflow, §42 filing record) ───────
//
// Everything below requires workstation.gst.manage AND re-checks that the
// caller may see this client — the period id from the URL is never trusted
// on its own (§41). Every change writes a GstAuditLog row.

/** The period, or 403/404 — never "found but not yours". */
async function periodForWrite(req: Parameters<typeof requireSession>[0], id: string) {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.gst.manage')
  const row = await prisma.gstCompliancePeriod.findFirst({
    where: { ...alive, id, ...(await periodScopeWhere(session, scope)) },
    include: { filings: { where: alive }, r2b: true },
  })
  if (!row) throw ApiError.notFound()
  return { session, row }
}

/** PATCH /api/gst/periods/:id/assign — preparer, reviewer, approver (§30). */
gstRouter.patch('/periods/:id/assign', handler(async (req, res) => {
  const { session, row } = await periodForWrite(req, req.params.id)
  const b = req.body ?? {}
  const pick = (k: string) => (typeof b[k] === 'string' && b[k] ? (b[k] as string) : null)

  const next = {
    assignedEmployeeId: 'assigned_employee_id' in b ? pick('assigned_employee_id') : row.assignedEmployeeId,
    reviewerEmployeeId: 'reviewer_employee_id' in b ? pick('reviewer_employee_id') : row.reviewerEmployeeId,
    managerEmployeeId: 'manager_employee_id' in b ? pick('manager_employee_id') : row.managerEmployeeId,
  }

  // The employees must exist. A frontend-supplied id is never taken on trust.
  const ids = [next.assignedEmployeeId, next.reviewerEmployeeId, next.managerEmployeeId].filter((v): v is string => !!v)
  if (ids.length) {
    const found = await prisma.employee.count({ where: { id: { in: ids } } })
    if (found !== new Set(ids).size) throw ApiError.badRequest('Unknown employee.')
  }

  await prisma.$transaction(async (tx) => {
    await tx.gstCompliancePeriod.update({ where: { id: row.id }, data: { ...next, updatedBy: session.userId } })
    // §30 "track assignments" — append, never overwrite, so who held the work
    // in September survives a later reassignment.
    for (const [role, employeeId, before] of [
      ['preparer', next.assignedEmployeeId, row.assignedEmployeeId],
      ['reviewer', next.reviewerEmployeeId, row.reviewerEmployeeId],
      ['approver', next.managerEmployeeId, row.managerEmployeeId],
    ] as const) {
      if (employeeId === before) continue
      await tx.gstAssignment.updateMany({
        where: { compliancePeriodId: row.id, role, unassignedAt: null },
        data: { unassignedAt: new Date() },
      })
      if (employeeId) {
        await tx.gstAssignment.create({
          data: { compliancePeriodId: row.id, role, employeeId, assignedByUserId: session.userId },
        })
      }
    }
  })

  await writeGstAudit({
    compliancePeriodId: row.id, action: 'GST_ASSIGNMENT_CHANGED', stage: 'period',
    userId: session.userId,
    oldValue: JSON.stringify({ a: row.assignedEmployeeId, r: row.reviewerEmployeeId, m: row.managerEmployeeId }),
    newValue: JSON.stringify(next),
  })
  ok(res, { ok: true })
}))

/**
 * POST /api/gst/periods/:id/stages/:stage — advance a stage, record figures.
 *
 * GSTR-1 and GSTR-3B write GstFiling rows (created on first touch, since a
 * period may not have one yet); GSTR-2B writes GstR2BRecord. Status moves are
 * validated against the workflow, and a filed state additionally demands an
 * ARN and a date — §42: we record a filing, we never perform one.
 */
gstRouter.post('/periods/:id/stages/:stage', handler(async (req, res) => {
  const stage = req.params.stage
  if (!['gstr1', 'gstr2b', 'gstr3b'].includes(stage)) throw ApiError.notFound()
  const { session, row } = await periodForWrite(req, req.params.id)
  const b = req.body ?? {}
  const s = (k: string) => (typeof b[k] === 'string' && b[k] ? (b[k] as string) : null)

  if (stage === 'gstr2b') {
    const before = row.r2b?.status ?? 'pending'
    const status = s('status') ?? before
    assertGstr2bTransition(before, status)

    const data = {
      status,
      availableDate: 'available_date' in b ? s('available_date') : row.r2b?.availableDate ?? null,
      downloadDate: 'download_date' in b ? s('download_date') : row.r2b?.downloadDate ?? null,
      totalItcCgst: toPaise(b.total_itc_cgst, 'CGST') ?? row.r2b?.totalItcCgst ?? 0n,
      totalItcSgst: toPaise(b.total_itc_sgst, 'SGST') ?? row.r2b?.totalItcSgst ?? 0n,
      totalItcIgst: toPaise(b.total_itc_igst, 'IGST') ?? row.r2b?.totalItcIgst ?? 0n,
      remarks: 'remarks' in b ? s('remarks') : row.r2b?.remarks ?? null,
      updatedBy: session.userId,
    }
    await prisma.gstR2BRecord.upsert({
      where: { compliancePeriodId: row.id },
      create: { compliancePeriodId: row.id, ...data, createdBy: session.userId },
      update: data,
    })
    await writeGstAudit({
      compliancePeriodId: row.id,
      action: status === 'downloaded' ? 'GSTR2B_DOWNLOADED' : status === 'available' ? 'GSTR2B_AVAILABLE' : 'GSTR2B_UPDATED',
      stage: 'gstr2b', userId: session.userId, oldValue: before, newValue: status,
    })
    return ok(res, { ok: true })
  }

  const returnType = stage === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'
  const existing = row.filings.find((f) => f.returnType === returnType)
  const before = existing?.status ?? 'pending'
  const status = s('status') ?? normaliseFilingStatus(before, returnType)

  if (stage === 'gstr1') assertGstr1Transition(before, status)
  else assertGstr3bTransition(before, status)

  const arn = 'arn' in b ? s('arn') : existing?.arn ?? null
  const filedDate = s('filed_date')
  if (status === 'filed') assertFilingRecord(arn, filedDate ?? existing?.filedAt?.toISOString().slice(0, 10) ?? null)

  const now = new Date()
  const money = stage === 'gstr1'
    ? {
        taxableValue: toPaise(b.taxable_value, 'Taxable value') ?? existing?.taxableValue ?? null,
        taxAmount: toPaise(b.tax_amount, 'Tax amount') ?? existing?.taxAmount ?? null,
      }
    : {
        taxLiability: toPaise(b.tax_liability, 'Tax liability') ?? existing?.taxLiability ?? null,
        eligibleItc: toPaise(b.eligible_itc, 'Eligible ITC') ?? existing?.eligibleItc ?? null,
        netPayable: toPaise(b.net_payable, 'Net payable') ?? existing?.netPayable ?? null,
        paymentStatus: s('payment_status') ?? existing?.paymentStatus ?? 'not_applicable',
        paymentDate: 'payment_date' in b ? s('payment_date') : existing?.paymentDate ?? null,
        challanRef: 'challan_ref' in b ? s('challan_ref') : existing?.challanRef ?? null,
      }

  const data = {
    status,
    arn,
    remarks: 'remarks' in b ? s('remarks') : existing?.remarks ?? null,
    ...money,
    ...(status === 'under_review' ? { reviewedAt: now } : {}),
    ...(['in_preparation', 'preparation'].includes(status) && !existing?.preparedAt ? { preparedAt: now } : {}),
    ...(status === 'filed'
      ? {
          filedAt: filedDate ? new Date(filedDate + 'T00:00:00Z') : now,
          // §42 — recorded by a person, never transmitted by Audit OS.
          filedManually: true,
          filedByUserId: session.userId,
        }
      : {}),
    updatedBy: session.userId,
  }

  if (existing) {
    await prisma.gstFiling.update({ where: { id: existing.id }, data })
  } else {
    await prisma.gstFiling.create({
      data: {
        gstProfileId: row.gstProfileId,
        compliancePeriodId: row.id,
        financialYear: row.financialYear,
        period: row.period,
        returnType,
        dueDate: dueDateFor(row.period, returnType, row.periodType),
        assignedEmployeeId: row.assignedEmployeeId ?? '',
        reviewerEmployeeId: row.reviewerEmployeeId,
        createdBy: session.userId,
        ...data,
      },
    })
  }

  await writeGstAudit({
    compliancePeriodId: row.id,
    action: status === 'filed'
      ? (stage === 'gstr1' ? 'GSTR1_FILED' : 'GSTR3B_FILED')
      : status === 'under_review'
        ? (stage === 'gstr1' ? 'GSTR1_REVIEWED' : 'GSTR3B_REVIEWED')
        : (stage === 'gstr1' ? 'GSTR1_UPDATED' : 'GSTR3B_UPDATED'),
    stage, userId: session.userId, oldValue: before, newValue: status,
    meta: status === 'filed' ? { arn, filed_date: filedDate } : undefined,
  })
  ok(res, { ok: true })
}))

/** POST /api/gst/periods/:id/payment — §20 payment recording. */
gstRouter.post('/periods/:id/payment', handler(async (req, res) => {
  const { session, row } = await periodForWrite(req, req.params.id)
  const b = req.body ?? {}
  const filing = row.filings.find((f) => f.returnType === 'GSTR-3B')
  if (!filing) throw ApiError.badRequest('There is no GSTR-3B on this period yet.')
  if (normaliseFilingStatus(filing.status, 'GSTR-3B') !== 'filed' &&
      filing.paymentStatus !== 'pending') {
    throw ApiError.badRequest('Record the GSTR-3B as filed before recording its payment.')
  }
  const date = typeof b.payment_date === 'string' ? b.payment_date : null
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw ApiError.badRequest('A payment date is required.')

  await prisma.gstFiling.update({
    where: { id: filing.id },
    data: {
      paymentStatus: 'completed',
      paymentDate: date,
      challanRef: typeof b.challan_ref === 'string' ? b.challan_ref : null,
      status: 'completed',
      updatedBy: session.userId,
    },
  })
  await writeGstAudit({
    compliancePeriodId: row.id, action: 'PAYMENT_RECORDED', stage: 'payment',
    userId: session.userId, newValue: date, meta: { challan_ref: b.challan_ref ?? null },
  })
  ok(res, { ok: true })
}))

/**
 * POST /api/gst/stages/:stage/entries — add a client's work for one period.
 *
 * This is the "Add" on each of the GSTR-1 / GSTR-2B / GSTR-3B sections. It
 * creates the compliance period if the client has none for that tax period,
 * then opens the stage record on it — so adding a GSTR-1 for September and
 * later a GSTR-3B for September lands both on the SAME period rather than
 * creating two parallel histories for one client-month.
 *
 * Adding the same stage twice for one client and period is refused: §41 says
 * duplicate client + FY + period + stage must be prevented, and the unique
 * index on the period is only half of that.
 */
gstRouter.post('/stages/:stage/entries', handler(async (req, res) => {
  const stage = req.params.stage
  if (!['gstr1', 'gstr2b', 'gstr3b'].includes(stage)) throw ApiError.notFound()

  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.gst.manage')
  const b = req.body ?? {}
  const s = (k: string) => (typeof b[k] === 'string' && b[k] ? (b[k] as string) : null)

  const profileId = s('gst_profile_id')
  const period = s('period')
  if (!profileId) throw ApiError.badRequest('Choose a client.')
  if (!period || !/^\d{4}-\d{2}$/.test(period)) throw ApiError.badRequest('Choose a tax period.')
  const month = Number(period.slice(5))
  if (month < 1 || month > 12) throw ApiError.badRequest('That is not a valid month.')

  // The profile must exist AND be one this user may act on — the id in the
  // body is never taken on trust (§41).
  const ids = await assignedClientIds(session, scope)
  const profile = await prisma.gstProfile.findFirst({
    where: {
      ...alive, id: profileId, ...(ids === 'ALL' ? {} : { clientId: { in: ids } }),
    },
    select: { id: true, filingFrequency: true, assignedEmployeeId: true, reviewerEmployeeId: true },
  })
  if (!profile) throw ApiError.notFound()

  const financialYear = financialYearOf(period)
  const periodType = profile.filingFrequency === 'quarterly' ? 'quarterly' : 'monthly'

  const existing = await prisma.gstCompliancePeriod.findUnique({
    where: { gstProfileId_financialYear_period: { gstProfileId: profile.id, financialYear, period } },
    include: { filings: { where: alive }, r2b: true },
  })

  // Refuse a second record for the same client + period + stage.
  if (existing) {
    const clash = stage === 'gstr2b'
      ? !!existing.r2b
      : existing.filings.some((f) => f.returnType === (stage === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'))
    if (clash) {
      throw ApiError.badRequest(
        `This client already has a ${stage === 'gstr2b' ? 'GSTR-2B' : stage === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'} for that period. Open it from the list instead.`,
      )
    }
  }

  const assigned = s('assigned_employee_id') ?? profile.assignedEmployeeId ?? null
  const reviewer = s('reviewer_employee_id') ?? profile.reviewerEmployeeId ?? null
  for (const id of [assigned, reviewer].filter((v): v is string => !!v)) {
    if (!(await prisma.employee.count({ where: { id } }))) throw ApiError.badRequest('Unknown employee.')
  }

  const periodRow = existing ?? await prisma.gstCompliancePeriod.create({
    data: {
      gstProfileId: profile.id, financialYear, period, periodType,
      assignedEmployeeId: assigned, reviewerEmployeeId: reviewer,
      createdBy: session.userId,
    },
    include: { filings: true, r2b: true },
  })
  if (!existing) {
    await writeGstAudit({
      compliancePeriodId: periodRow.id, gstProfileId: profile.id,
      action: 'GST_PERIOD_CREATED', stage: 'period', userId: session.userId, newValue: `${financialYear} ${period}`,
    })
  }

  if (stage === 'gstr2b') {
    await prisma.gstR2BRecord.create({
      data: {
        compliancePeriodId: periodRow.id,
        status: s('status') ?? 'expected',
        availableDate: s('available_date'),
        totalItcCgst: toPaise(b.total_itc_cgst, 'CGST') ?? 0n,
        totalItcSgst: toPaise(b.total_itc_sgst, 'SGST') ?? 0n,
        totalItcIgst: toPaise(b.total_itc_igst, 'IGST') ?? 0n,
        remarks: s('remarks'),
        createdBy: session.userId,
      },
    })
  } else {
    const returnType = stage === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'
    const status = s('status') ?? 'pending'
    if (stage === 'gstr1') assertGstr1Transition('pending', status)
    else assertGstr3bTransition('pending', status)
    await prisma.gstFiling.create({
      data: {
        gstProfileId: profile.id,
        compliancePeriodId: periodRow.id,
        financialYear, period, returnType, status,
        dueDate: s('due_date') ?? dueDateFor(period, returnType, periodType),
        assignedEmployeeId: assigned ?? '',
        reviewerEmployeeId: reviewer,
        remarks: s('remarks'),
        ...(stage === 'gstr1'
          ? { taxableValue: toPaise(b.taxable_value, 'Taxable value'), taxAmount: toPaise(b.tax_amount, 'Tax amount') }
          : {
              taxLiability: toPaise(b.tax_liability, 'Tax liability'),
              eligibleItc: toPaise(b.eligible_itc, 'Eligible ITC'),
              netPayable: toPaise(b.net_payable, 'Net payable'),
            }),
        createdBy: session.userId,
      },
    })
  }

  await writeGstAudit({
    compliancePeriodId: periodRow.id, gstProfileId: profile.id,
    action: stage === 'gstr1' ? 'GSTR1_ASSIGNED' : stage === 'gstr2b' ? 'GSTR2B_EXPECTED' : 'GSTR3B_PREPARED',
    stage, userId: session.userId, newValue: period,
  })

  ok(res, { id: periodRow.id, period, financial_year: financialYear }, 201)
}))

/**
 * PATCH /api/gst/clients/:id — the client's GST registration details (§28).
 *
 * Only the GST-specific fields live here. Name, phone and address of the
 * CLIENT itself belong to Workstation → Clients and are not editable from
 * this screen; duplicating them would give the firm two versions of the
 * same fact.
 */
gstRouter.patch('/clients/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.gst.manage')
  const ids = await assignedClientIds(session, scope)

  const current = await prisma.gstProfile.findFirst({
    where: { ...alive, id: req.params.id, ...(ids === 'ALL' ? {} : { clientId: { in: ids } }) },
  })
  if (!current) throw ApiError.notFound()

  const b = req.body ?? {}
  const has = (k: string) => k in b
  const s = (k: string) => (typeof b[k] === 'string' && b[k] ? (b[k] as string).trim() : null)

  const gstin = has('gstin') ? (s('gstin')?.toUpperCase() ?? null) : current.gstin
  const pan = has('pan') ? (s('pan')?.toUpperCase() ?? null) : current.pan
  if (!gstin) throw ApiError.badRequest('A GSTIN is required.')
  assertGstin(gstin)
  if (pan) {
    assertPan(pan)
    assertGstinMatchesPan(gstin, pan)
  }

  const registrationType = has('registration_type') ? (s('registration_type') ?? 'regular') : current.registrationType
  const registrationStatus = has('registration_status') ? (s('registration_status') ?? 'active') : current.registrationStatus
  const filingFrequency = has('filing_frequency') ? (s('filing_frequency') ?? 'monthly') : current.filingFrequency
  assertOneOf(registrationType, REGISTRATION_TYPES, 'registration type')
  assertOneOf(registrationStatus, REGISTRATION_STATUSES, 'registration status')
  assertOneOf(filingFrequency, FILING_FREQUENCIES, 'filing frequency')

  const registrationDate = has('registration_date') ? s('registration_date') : current.registrationDate
  assertDate(registrationDate, 'Registration date')

  const assigned = has('assigned_employee_id') ? s('assigned_employee_id') : current.assignedEmployeeId
  const reviewer = has('reviewer_employee_id') ? s('reviewer_employee_id') : current.reviewerEmployeeId
  for (const id of [assigned, reviewer].filter((v): v is string => !!v)) {
    if (!(await prisma.employee.count({ where: { id } }))) throw ApiError.badRequest('Unknown employee.')
  }
  if (!assigned) throw ApiError.badRequest('Every GST client needs an assigned employee.')

  const next = {
    gstin,
    pan,
    legalName: has('legal_name') ? s('legal_name') : current.legalName,
    state: has('state') ? s('state') : current.state,
    registrationType, registrationStatus, filingFrequency, registrationDate,
    assignedEmployeeId: assigned,
    reviewerEmployeeId: reviewer,
    contactPerson: has('contact_person') ? s('contact_person') : current.contactPerson,
    contactEmail: has('contact_email') ? s('contact_email') : current.contactEmail,
    contactPhone: has('contact_phone') ? s('contact_phone') : current.contactPhone,
    address: has('address') ? s('address') : current.address,
    active: has('active') ? b.active !== false : current.active,
    updatedBy: session.userId,
  }

  await prisma.gstProfile.update({ where: { id: current.id }, data: next })

  // Only the fields that actually moved go into the trail (§39).
  const changed: Record<string, [unknown, unknown]> = {}
  for (const [k, v] of Object.entries(next)) {
    if (k === 'updatedBy') continue
    const before = (current as unknown as Record<string, unknown>)[k]
    if (before !== v) changed[k] = [before, v]
  }
  await writeGstAudit({
    gstProfileId: current.id, action: 'GST_CLIENT_UPDATED', stage: 'client',
    userId: session.userId, meta: changed,
  })

  ok(res, { ok: true })
}))
