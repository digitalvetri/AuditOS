import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { addDays, istToday, monthLabel, monthlyPayrollPeriod } from '../../lib/dates.js'
import { calculatePayrollItem, pfAppliesTo, type CustomComponent } from '../../domain/payroll/calc.js'
import { summarize } from '../../domain/payroll/attendanceSummary.js'
import { snapshotAt, type StatutorySnapshot } from '../../domain/payroll/statutory.js'
import {
  employmentWindow, payrollEmployeeWhere, periodStructureWhere, pickStructure,
} from '../../domain/payroll/employment.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { notifyEmployee } from '../../platform/notify.js'
import { signedLink } from '../../platform/signedUrl.js'
import {
  employeeRef, employeeRefWithDept, payrollItemToApi, payrollRunToApi,
  paymentToApi, payslipToApi, salaryStructureToApi,
} from '../../api/serialize.js'
import { nextPaymentNo, postJournal, type JournalLeg } from '../accounts/ledger.js'
import { lockSequence } from '../../lib/sequence.js'
import { CATEGORIES, TDS_PLAN_GROSS_THRESHOLD_PAISE } from '../../platform/constants.js'
import type { PayrollDeductions } from '../../domain/payroll/calc.js'

/**
 * PAYROLL (§8.4 / §9)
 *
 * Stage machine: draft → hr_review → finance_review → approved → processed.
 * Each step is permission-gated and audited.
 *
 * IMMUTABILITY. Two properties matter and both are enforced here, not by
 * convention:
 *   1. A Processed run refuses every state-change endpoint.
 *   2. Calculate snapshots the statutory table onto the run. A later rate
 *      change cannot alter a calculated run's numbers, because the calculation
 *      reads the snapshot, not the live table.
 *
 * The React app performs no payroll arithmetic. It renders what this returns.
 */
export const payrollRouter = Router()
export const salaryRouter = Router({ mergeParams: true })

function requireView(session: Session) {
  if (!can(session, 'payroll.view', 'organisation')) throw ApiError.forbidden()
}

/**
 * Legs for one employee's payroll journal:
 *   Dr Salaries              gross
 *       Cr Bank                       net
 *       Cr PF Payable                 pf_employee
 *       Cr ESI Payable                esi_employee
 *       Cr Professional Tax Payable   pt
 *       Cr TDS Payable                tds
 *       Cr Other Deduction            advance + lop + other
 *
 * Gross is already LOP-adjusted (calc subtracts LOP before returning gross),
 * so lop_paise is NOT re-added here — that would double-count. Zero legs
 * are dropped by postJournal. Calc caps deductions at gross, so
 * gross = net + Σ credits always holds.
 */
export function payrollJournalLegs(
  grossPaise: number,
  netPaise: number,
  deductionsJson: string,
): JournalLeg[] {
  const d = JSON.parse(deductionsJson) as PayrollDeductions
  const otherPaise =
    (d.advance_paise ?? 0) +
    (d.other ?? []).reduce((s, o) => s + o.amount_paise, 0)
  return [
    { category: CATEGORIES.SALARIES, debitPaise: grossPaise },
    { category: CATEGORIES.BANK, creditPaise: netPaise },
    { category: CATEGORIES.PF_PAYABLE, creditPaise: d.pf_employee_paise ?? 0 },
    { category: CATEGORIES.ESI_PAYABLE, creditPaise: d.esi_employee_paise ?? 0 },
    { category: CATEGORIES.PT_PAYABLE, creditPaise: d.pt_paise ?? 0 },
    { category: CATEGORIES.TDS_PAYABLE, creditPaise: d.tds_paise ?? 0 },
    { category: CATEGORIES.OTHER_DEDUCTION, creditPaise: otherPaise },
  ]
}

/**
 * Employees on a run with their employment window and the structure that
 * pays it (undefined → blocker). Shared by calculate and both blocker checks.
 */
async function payrollHeadcount(run: { periodStart: string; periodEnd: string }) {
  const employees = await prisma.employee.findMany({
    where: payrollEmployeeWhere(run.periodStart, run.periodEnd),
    include: {
      department: true,
      salaryStructures: { where: periodStructureWhere(run.periodStart, run.periodEnd) },
    },
    orderBy: { employeeCode: 'asc' },
  })
  return employees.flatMap((e) => {
    const window = employmentWindow(run.periodStart, run.periodEnd, e.joiningDate, e.exitDate)
    if (!window) return []
    return [{ employee: e, window, structure: pickStructure(e.salaryStructures, window) }]
  })
}

// ── Runs ──────────────────────────────────────────────────────────────────
payrollRouter.get('/runs', handler(async (req, res) => {
  requireView(requireSession(req))
  const rows = await prisma.payrollRun.findMany({
    where: { deletedAt: null }, orderBy: { periodStart: 'desc' },
  })
  ok(res, { items: rows.map(payrollRunToApi) })
}))

payrollRouter.post('/runs', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'payroll.run', 'organisation')) {
    throw ApiError.forbidden('Only HR/MD can create a payroll run.')
  }
  // Period is derived from (year, month) — never from date arithmetic on a
  // caller-supplied range. This is the fix for the malformed
  // 2026-12-30 → 2027-01-30 row: no way to construct anything other than
  // first-of-month / last-of-month here.
  const b = z.object({
    year: z.number().int().min(2000).max(2100).optional(),
    month: z.number().int().min(1).max(12).optional(),
    // Back-compat: callers that still send period_start/period_end must
    // send a value that (year, month) would have produced. Anything else
    // is refused.
    period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) {
    throw ApiError.badRequest('{ year, month } required (or a matching { period_start, period_end }).')
  }
  let year: number
  let month: number
  if (b.data.year !== undefined && b.data.month !== undefined) {
    year = b.data.year
    month = b.data.month
  } else if (b.data.period_start && b.data.period_end) {
    const [y, m, d] = b.data.period_start.split('-').map(Number)
    if (d !== 1) {
      throw ApiError.unprocessable('non_monthly_period',
        'A payroll run covers one calendar month. period_start must be the first day of a month.')
    }
    year = y
    month = m
    const derived = monthlyPayrollPeriod(y, m)
    if (b.data.period_start !== derived.start || b.data.period_end !== derived.end) {
      throw ApiError.unprocessable('non_monthly_period',
        `Period must be ${derived.start} → ${derived.end}, not ${b.data.period_start} → ${b.data.period_end}.`)
    }
  } else {
    throw ApiError.badRequest('Provide { year, month } (or a matching { period_start, period_end }).')
  }

  const { start: periodStart, end: periodEnd } = monthlyPayrollPeriod(year, month)

  // Future-period guard. The current month can exist as Draft (for
  // preview) but nothing further out — that turns a data-entry accident
  // into an error rather than a Draft row someone might process later.
  const today = istToday()
  const currentYm = today.slice(0, 7)
  const targetYm = periodStart.slice(0, 7)
  if (targetYm > currentYm) {
    throw ApiError.unprocessable('future_period',
      `Cannot create a run for ${monthLabel(periodStart)}: only the current month or earlier is allowed.`)
  }

  const overlap = await prisma.payrollRun.findFirst({
    where: { deletedAt: null, periodStart, periodEnd },
  })
  if (overlap) throw ApiError.conflict('overlap', 'A payroll run for this period already exists.')

  const org = await prisma.organisation.findFirstOrThrow({ where: { deletedAt: null } })
  const row = await prisma.payrollRun.create({
    data: {
      organisationId: org.id,
      periodStart,
      periodEnd,
      stage: 'draft',
      createdBy: session.userId,
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'payroll.run_created',
    entityType: 'PayrollRun', entityId: row.id, after: payrollRunToApi(row), req,
  })
  ok(res, { run: payrollRunToApi(row) })
}))

payrollRouter.get('/runs/:id', handler(async (req, res) => {
  requireView(requireSession(req))
  const run = await prisma.payrollRun.findUnique({ where: { id: req.params.id } })
  if (!run) throw ApiError.notFound('Run not found.')
  const items = await prisma.payrollItem.findMany({
    where: { payrollRunId: run.id, deletedAt: null },
    include: { employee: true },
    orderBy: { employee: { employeeCode: 'asc' } },
  })

  // Blockers: active employees who joined on or before the period end but
  // have no salary structure covering the period. These are the employees
  // who would silently reduce gross by "one whole person" (Bug 3) if the
  // run were processed as-is. Draft and hr_review runs surface them so
  // Finance can either add a structure or take them out of the headcount.
  const [headcount, previousRun] = await Promise.all([
    payrollHeadcount(run),
    // The immediately preceding month's run, for the variance banner.
    prisma.payrollRun.findFirst({
      where: {
        deletedAt: null,
        periodStart: { lt: run.periodStart },
        stage: { in: ['approved', 'processed'] },
      },
      orderBy: { periodStart: 'desc' },
    }),
  ])

  const blockers: {
    employee: ReturnType<typeof employeeRefWithDept>
    reason: 'no_salary_structure' | 'tds_plan_missing'
    message: string
  }[] = []
  for (const { employee: e, structure: s } of headcount) {
    if (!s) {
      blockers.push({
        employee: employeeRefWithDept(e),
        reason: 'no_salary_structure',
        message: `No salary structure covering ${run.periodStart} to ${run.periodEnd}.`,
      })
      continue
    }
    // TDS plan blocker (§2.6). Read the actual gross for this run's item
    // if one exists (post-calculate); fall back to structure sum for the
    // pre-calculate preview.
    const item = items.find((i) => i.employeeId === e.id)
    const grossForCheck = item?.grossPaise
      ?? (s.basicPaise + s.hraPaise + s.conveyancePaise + s.specialAllowancePaise)
    const exempt = (e.tdsExemptReason ?? '').trim().length > 0
    if (
      grossForCheck > TDS_PLAN_GROSS_THRESHOLD_PAISE
      && e.annualTdsPlanPaise === 0
      && !exempt
    ) {
      blockers.push({
        employee: employeeRefWithDept(e),
        reason: 'tds_plan_missing',
        message: `Gross above ₹${(TDS_PLAN_GROSS_THRESHOLD_PAISE / 100).toLocaleString('en-IN')} with no annual TDS plan. Set the plan on the employee, or mark "no TDS applicable" with a reason.`,
      })
    }
  }

  // Variance banner: same headcount month-over-month, but gross moved by
  // more than one employee-month's floor (₹1,000 by default). If the
  // previous run had a different headcount the banner is silent — the
  // delta is not "one person disappeared".
  let variance: {
    previous_run_id: string
    previous_label: string
    previous_gross_paise: number
    delta_paise: number
    same_headcount: boolean
  } | null = null
  if (previousRun && previousRun.headcount === run.headcount && run.headcount > 0) {
    variance = {
      previous_run_id: previousRun.id,
      previous_label: `PR/${previousRun.periodStart.slice(0, 7)}`,
      previous_gross_paise: previousRun.grossTotalPaise,
      delta_paise: run.grossTotalPaise - previousRun.grossTotalPaise,
      same_headcount: true,
    }
  }

  ok(res, {
    run: payrollRunToApi(run),
    items: items.map((i) => ({ ...payrollItemToApi(i), employee: employeeRefWithDept(i.employee) })),
    blockers,
    variance,
    can_process: blockers.length === 0,
  })
}))

// POST /api/payroll/runs/:id/calculate — Draft only, rebuilds items from scratch.
payrollRouter.post('/runs/:id/calculate', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'payroll.run', 'organisation')) throw ApiError.forbidden()
  const run = await prisma.payrollRun.findUnique({ where: { id: req.params.id } })
  if (!run) throw ApiError.notFound('Run not found.')
  if (run.stage !== 'draft') throw ApiError.conflict('not_draft', 'Only Draft runs can be recalculated.')

  const rates = await prisma.statutoryRate.findMany({
    where: { deletedAt: null },
    select: { code: true, value: true, effectiveFrom: true, effectiveTo: true },
  })
  const snap: StatutorySnapshot = snapshotAt(run.periodStart, rates)
  if (Object.keys(snap).length === 0) {
    throw ApiError.unprocessable(
      'no_statutory_rates',
      'No statutory rates are effective for this pay period. Add them in Settings → Statutory Rates before calculating.',
    )
  }
  const periodStartMonth = Number(run.periodStart.split('-')[1])

  const headcount = await payrollHeadcount(run)
  const periodDays = summarize([], [], run.periodStart, run.periodEnd).payable_days

  const prepared: {
    employeeId: string
    salaryStructureId: string
    summary: ReturnType<typeof summarize>
    calc: ReturnType<typeof calculatePayrollItem>
  }[] = []

  for (const { employee: emp, window, structure } of headcount) {
    if (!structure) continue // no salary on file for this period — not payable
    // Attendance, leave and payable days are all over the days actually
    // employed; calc pro-rates the month by payable_days / periodDays.
    const [attendance, leaves] = await Promise.all([
      prisma.attendance.findMany({
        where: { employeeId: emp.id, deletedAt: null, date: { gte: window.start, lte: window.end } },
        select: { date: true, status: true },
      }),
      prisma.leaveRequest.findMany({
        where: { employeeId: emp.id, status: 'approved', deletedAt: null },
        select: { startDate: true, endDate: true, status: true },
      }),
    ])
    const summary = summarize(attendance, leaves, window.start, window.end)
    // Monthly TDS = annual plan ÷ 12, rounded to nearest paise. Not a
    // slab calculator — the spec deliberately keeps the number the firm's
    // decision. Zero plan means zero deducted this month; the process
    // gate above catches "zero plan but should have been non-zero".
    const monthlyTds = Math.round((emp.annualTdsPlanPaise ?? 0) / 12)
    const calc = calculatePayrollItem({
      structure: {
        basic_paise: structure.basicPaise,
        hra_paise: structure.hraPaise,
        conveyance_paise: structure.conveyancePaise,
        special_allowance_paise: structure.specialAllowancePaise,
        custom_components: JSON.parse(structure.customComponentsJson) as CustomComponent[],
      },
      attendance: summary,
      snap,
      periodStartMonth,
      period_days: periodDays,
      tds_paise: monthlyTds,
      pf_applicable: pfAppliesTo(emp),
    })
    prepared.push({ employeeId: emp.id, salaryStructureId: structure.id, summary, calc })
  }

  const gross = prepared.reduce((s, p) => s + p.calc.gross_paise, 0)
  const deductions = prepared.reduce((s, p) => s + p.calc.total_deductions_paise, 0)
  const net = prepared.reduce((s, p) => s + p.calc.net_paise, 0)

  // Atomic replace: items, run totals and snapshot move together.
  const { fresh, items } = await prisma.$transaction(async (tx) => {
    await tx.payrollItem.deleteMany({ where: { payrollRunId: run.id } })
    for (const p of prepared) {
      await tx.payrollItem.create({
        data: {
          payrollRunId: run.id,
          employeeId: p.employeeId,
          salaryStructureId: p.salaryStructureId,
          payableDays: p.summary.payable_days,
          presentDays: p.summary.present_days,
          onLeaveDays: p.summary.on_leave_days,
          absentDays: p.summary.absent_days,
          lopDays: p.summary.lop_days,
          earningsJson: JSON.stringify(p.calc.earnings),
          deductionsJson: JSON.stringify(p.calc.deductions),
          grossPaise: p.calc.gross_paise,
          totalDeductionsPaise: p.calc.total_deductions_paise,
          netPaise: p.calc.net_paise,
          gratuityAccrualPaise: p.calc.gratuity_accrual_paise,
          createdBy: session.userId,
          updatedBy: session.userId,
        },
      })
    }
    const updated = await tx.payrollRun.update({
      where: { id: run.id },
      data: {
        statutorySnapshotJson: JSON.stringify(snap),
        headcount: prepared.length,
        grossTotalPaise: gross,
        deductionsTotalPaise: deductions,
        netTotalPaise: net,
        updatedBy: session.userId,
      },
    })
    const rows = await tx.payrollItem.findMany({ where: { payrollRunId: run.id } })
    return { fresh: updated, items: rows }
  })

  await writeAudit({
    actorUserId: session.userId, action: 'payroll.calculated',
    entityType: 'PayrollRun', entityId: run.id,
    after: { items: prepared.length, gross_paise: gross, net_paise: net }, req,
  })
  ok(res, { run: payrollRunToApi(fresh), items: items.map(payrollItemToApi) })
}))

// POST /api/payroll/runs/:id/review — draft → hr_review → finance_review
payrollRouter.post('/runs/:id/review', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'payroll.review', 'organisation')) throw ApiError.forbidden('Only HR/MD can review.')
  const run = await prisma.payrollRun.findUnique({ where: { id: req.params.id } })
  if (!run) throw ApiError.notFound('Run not found.')
  if (run.stage !== 'draft' && run.stage !== 'hr_review') {
    throw ApiError.conflict('wrong_stage', `Run is ${run.stage}; review not allowed.`)
  }
  if (run.headcount === 0) {
    throw ApiError.unprocessable('no_items', 'Calculate the run before submitting for review.')
  }

  const next = run.stage === 'draft' ? 'hr_review' : 'finance_review'
  const updated = await prisma.payrollRun.update({
    where: { id: run.id },
    data: {
      stage: next,
      ...(next === 'hr_review' ? { reviewedBy: session.userId } : {}),
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: `payroll.${next}`,
    entityType: 'PayrollRun', entityId: run.id,
    before: { stage: run.stage }, after: { stage: next }, req,
  })
  ok(res, { run: payrollRunToApi(updated) })
}))

// POST /api/payroll/runs/:id/approve — Finance
payrollRouter.post('/runs/:id/approve', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'payroll.approve', 'organisation')) {
    throw ApiError.forbidden('Only Finance/MD can approve.')
  }
  const run = await prisma.payrollRun.findUnique({ where: { id: req.params.id } })
  if (!run) throw ApiError.notFound('Run not found.')
  if (run.stage === 'processed') {
    throw ApiError.conflict('already_processed', 'Run is Processed — immutable.')
  }
  if (run.stage !== 'finance_review') {
    throw ApiError.conflict('wrong_stage', `Run is ${run.stage}; must be finance_review.`)
  }

  const updated = await prisma.payrollRun.update({
    where: { id: run.id },
    data: { stage: 'approved', approvedBy: session.userId, updatedBy: session.userId },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'payroll.approved',
    entityType: 'PayrollRun', entityId: run.id,
    before: { stage: run.stage }, after: { stage: 'approved' }, req,
  })
  ok(res, { run: payrollRunToApi(updated) })
}))

// POST /api/payroll/runs/:id/process — irreversible: payments + ledger + payslips
payrollRouter.post('/runs/:id/process', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'payroll.process', 'organisation')) {
    throw ApiError.forbidden('Only Finance/MD can process.')
  }
  const run = await prisma.payrollRun.findUnique({ where: { id: req.params.id } })
  if (!run) throw ApiError.notFound('Run not found.')
  if (run.stage === 'processed') {
    throw ApiError.conflict('already_processed', 'Run is Processed — immutable.')
  }
  if (run.stage !== 'approved') throw ApiError.conflict('wrong_stage', `Run is ${run.stage}; approve first.`)

  // Blocker check (§2.5 + §2.6). Refuse to process while any active
  // employee has (a) no salary structure covering this period, or (b)
  // gross above the TDS threshold with a zero annual TDS plan and no
  // exempt reason. Both classes surface as UI blocker rows too.
  const headcount = await payrollHeadcount(run)
  const missingStructures: string[] = []
  const missingTdsPlan: string[] = []
  const itemsForCheck = await prisma.payrollItem.findMany({
    where: { payrollRunId: run.id, deletedAt: null },
    select: { employeeId: true, grossPaise: true },
  })
  for (const { employee: e, structure: s } of headcount) {
    if (!s) {
      missingStructures.push(e.fullName)
      continue
    }
    const item = itemsForCheck.find((i) => i.employeeId === e.id)
    const grossForCheck = item?.grossPaise
      ?? (s.basicPaise + s.hraPaise + s.conveyancePaise + s.specialAllowancePaise)
    const exempt = (e.tdsExemptReason ?? '').trim().length > 0
    if (
      grossForCheck > TDS_PLAN_GROSS_THRESHOLD_PAISE
      && e.annualTdsPlanPaise === 0
      && !exempt
    ) {
      missingTdsPlan.push(e.fullName)
    }
  }
  if (missingStructures.length > 0) {
    throw ApiError.unprocessable('blockers_present',
      `${missingStructures.length} employee(s) in the headcount have no salary structure covering this period: ${missingStructures.join(', ')}. Add a structure or remove them from the run before processing.`)
  }
  if (missingTdsPlan.length > 0) {
    throw ApiError.unprocessable('blockers_present',
      `${missingTdsPlan.length} employee(s) above the ₹${(TDS_PLAN_GROSS_THRESHOLD_PAISE / 100).toLocaleString('en-IN')} monthly threshold have no annual TDS plan and are not marked exempt: ${missingTdsPlan.join(', ')}. Set the plan or mark "no TDS applicable" with a reason.`)
  }

  const items = await prisma.payrollItem.findMany({
    where: { payrollRunId: run.id, deletedAt: null }, include: { employee: true },
  })
  const now = new Date()

  const { fresh, payments, payslips } = await prisma.$transaction(async (tx) => {
    // Claim the run first: only one request can move it approved →
    // processed. The stage check above is a read outside this transaction,
    // so two concurrent requests would both pass it and pay everyone twice.
    const claimed = await tx.payrollRun.updateMany({
      where: { id: run.id, stage: 'approved' },
      data: {
        stage: 'processed', processedBy: session.userId, processedAt: now, updatedBy: session.userId,
      },
    })
    if (claimed.count !== 1) throw ApiError.conflict('already_processed', 'Run is Processed — immutable.')

    // Payslip numbers are one global counter (the month is only a prefix).
    // Allocate under the payslip lock, inside this transaction, from the
    // highest existing number — a count read outside the transaction let
    // two runs processed at once hand out the same numbers. Lock order:
    // payslip_no → payment_no (nextPaymentNo) → ledger (postJournal).
    await lockSequence(tx, 'payslip_no')
    const existingSlips = await tx.payslip.findMany({ select: { payslipNo: true } })
    let n = 0
    for (const p of existingSlips) {
      const k = Number(p.payslipNo.slice(p.payslipNo.lastIndexOf('-') + 1))
      if (Number.isInteger(k) && k > n) n = k
    }

    const createdPayments = []
    const createdPayslips = []

    for (const item of items) {
      const paymentNo = await nextPaymentNo(tx)
      const payment = await tx.payment.create({
        data: {
          paymentNo,
          employeeId: item.employeeId,
          payrollRunId: run.id,
          amountPaise: item.netPaise,
          method: 'mock',
          reference: `${paymentNo}/${run.periodStart.slice(0, 7)}`,
          status: 'completed',
          paidAt: now,
          createdBy: session.userId,
          updatedBy: session.userId,
        },
      })
      createdPayments.push(payment)

      n += 1
      const payslip = await tx.payslip.create({
        data: {
          payrollRunId: run.id,
          payrollItemId: item.id,
          employeeId: item.employeeId,
          payslipNo: `PS-${run.periodStart.slice(0, 7).replace('-', '')}-${String(n).padStart(4, '0')}`,
          publishedAt: now,
          fileKey: `payslips/${run.id}/${item.employeeId}.pdf`,
          status: 'published',
          createdBy: session.userId,
          updatedBy: session.userId,
        },
      })
      createdPayslips.push(payslip)

      // A zero-gross item (whole month LOP) has nothing to post: calc caps
      // every deduction to zero, so all legs would be zero.
      if (item.grossPaise > 0) await postJournal(tx, {
        date: run.periodEnd,
        type: 'Payroll',
        description: `Salary — ${monthLabel(run.periodStart)}`,
        employeeId: item.employeeId,
        referenceId: item.id,
        referenceType: 'PayrollItem',
        paymentId: payment.id,
        createdBy: session.userId,
        legs: payrollJournalLegs(item.grossPaise, item.netPaise, item.deductionsJson),
      })
    }

    const updated = await tx.payrollRun.findUniqueOrThrow({ where: { id: run.id } })
    return { fresh: updated, payments: createdPayments, payslips: createdPayslips }
  })

  // Notifications sit outside the transaction: a notification failure must not
  // roll back a completed payroll.
  for (const item of items) {
    await notifyEmployee(item.employeeId, {
      type: 'payroll.payslip_published', module: 'payroll', title: 'Payslip published',
      body: `Your payslip for ${monthLabel(run.periodStart)} is available.`,
      entityType: 'Payslip', entityId: run.id, actionUrl: '/me/payslips',
    })
  }

  await writeAudit({
    actorUserId: session.userId, action: 'payroll.processed',
    entityType: 'PayrollRun', entityId: run.id,
    after: { payments: payments.length, payslips: payslips.length, net_paise: run.netTotalPaise }, req,
  })
  ok(res, {
    run: payrollRunToApi(fresh),
    payments: payments.map(paymentToApi),
    payslips: payslips.map(payslipToApi),
  })
}))

// ── Payslips ──────────────────────────────────────────────────────────────
payrollRouter.get('/payslips', handler(async (req, res) => {
  const session = requireSession(req)
  const q = z.object({ employeeId: z.string().optional(), runId: z.string().optional() }).parse(req.query)
  const canViewAll = can(session, 'payroll.view', 'organisation')
  const canViewOwn = can(session, 'payroll.view.own', 'self')

  const where: Record<string, unknown> = { status: 'published', deletedAt: null }
  if (!canViewAll) {
    if (!canViewOwn || !session.employeeId) throw ApiError.forbidden()
    where.employeeId = session.employeeId
  }
  if (q.employeeId) {
    if (!canViewAll && q.employeeId !== session.employeeId) throw ApiError.forbidden()
    where.employeeId = q.employeeId
  }
  if (q.runId) where.payrollRunId = q.runId

  const rows = await prisma.payslip.findMany({
    where, include: { employee: true, payrollItem: true, payrollRun: true },
    orderBy: { publishedAt: 'desc' },
  })
  ok(res, {
    items: rows.map((p) => ({
      ...payslipToApi(p),
      period_start: p.payrollRun.periodStart,
      period_end: p.payrollRun.periodEnd,
      gross_paise: p.payrollItem.grossPaise,
      net_paise: p.payrollItem.netPaise,
      employee: employeeRef(p.employee),
    })),
  })
}))

/** Load a payslip the caller is allowed to see, or throw. */
async function loadPayslip(session: Session, id: string) {
  const row = await prisma.payslip.findUnique({
    where: { id },
    include: {
      employee: { include: { department: true, designation: true } },
      payrollItem: { include: { salaryStructure: true } },
      payrollRun: true,
    },
  })
  if (!row || row.status !== 'published' || row.deletedAt) throw ApiError.notFound('Payslip not found.')
  const isOwn = row.employeeId === session.employeeId
  if (!can(session, 'payroll.view', 'organisation') && !isOwn) throw ApiError.forbidden()
  return row
}

payrollRouter.get('/payslips/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const p = await loadPayslip(session, req.params.id)
  ok(res, {
    payslip: payslipToApi(p),
    run: payrollRunToApi(p.payrollRun),
    item: payrollItemToApi(p.payrollItem),
    structure: salaryStructureToApi(p.payrollItem.salaryStructure),
    employee: {
      id: p.employee.id,
      full_name: p.employee.fullName,
      employee_code: p.employee.employeeCode,
      email: p.employee.email,
    },
    department: p.employee.department ? { id: p.employee.department.id, name: p.employee.department.name } : null,
    designation: p.employee.designation ? { id: p.employee.designation.id, name: p.employee.designation.name } : null,
  })
}))

payrollRouter.get('/payslips/:id/download-url', handler(async (req, res) => {
  const session = requireSession(req)
  const p = await loadPayslip(session, req.params.id)
  ok(res, signedLink(`/api/payroll/payslips/${p.id}/pdf`, `payslip:${p.id}`, session.userId))
}))

// ── Salary structure — /api/employees/:id/salary ──────────────────────────
salaryRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const canRead =
    can(session, 'salary.manage', 'organisation') || can(session, 'payroll.view', 'organisation')
  if (!canRead) throw ApiError.forbidden()

  const [rows, employee] = await Promise.all([
    prisma.salaryStructure.findMany({
      where: { employeeId: req.params.id, deletedAt: null }, orderBy: { effectiveFrom: 'desc' },
    }),
    prisma.employee.findUnique({
      where: { id: req.params.id },
      select: { annualTdsPlanPaise: true, tdsExemptReason: true },
    }),
  ])
  ok(res, {
    current: rows.find((r) => r.effectiveTo === null) ? salaryStructureToApi(rows.find((r) => r.effectiveTo === null)!) : null,
    history: rows.map(salaryStructureToApi),
    tds_plan: employee ? {
      annual_tds_plan_paise: employee.annualTdsPlanPaise,
      monthly_tds_paise: Math.round(employee.annualTdsPlanPaise / 12),
      exempt_reason: employee.tdsExemptReason,
      threshold_paise: TDS_PLAN_GROSS_THRESHOLD_PAISE,
    } : null,
  })
}))

salaryRouter.patch('/', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'salary.manage', 'organisation')) {
    throw ApiError.forbidden('Only HR/MD can update salary.')
  }
  const employeeId = req.params.id
  const b = z.object({
    effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    monthly_ctc_paise: z.number().int().optional(),
    basic_paise: z.number().int().optional(),
    hra_paise: z.number().int().optional(),
    conveyance_paise: z.number().int().optional(),
    special_allowance_paise: z.number().int().optional(),
    notes: z.string().nullable().optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('effective_from required.')

  const employee = await prisma.employee.findUnique({ where: { id: employeeId } })
  if (!employee) throw ApiError.notFound('Employee not found.')

  // A new structure supersedes the current one rather than editing it, so a
  // processed run's snapshot of the old numbers stays true.
  const current = await prisma.salaryStructure.findFirst({
    where: { employeeId, effectiveTo: null, deletedAt: null },
  })

  const row = await prisma.$transaction(async (tx) => {
    if (current && current.effectiveFrom < b.data.effective_from) {
      await tx.salaryStructure.update({
        where: { id: current.id },
        data: { effectiveTo: addDays(b.data.effective_from, -1), updatedBy: session.userId },
      })
    }
    return tx.salaryStructure.create({
      data: {
        employeeId,
        effectiveFrom: b.data.effective_from,
        effectiveTo: null,
        monthlyCtcPaise: b.data.monthly_ctc_paise ?? current?.monthlyCtcPaise ?? 0,
        basicPaise: b.data.basic_paise ?? current?.basicPaise ?? 0,
        hraPaise: b.data.hra_paise ?? current?.hraPaise ?? 0,
        conveyancePaise: b.data.conveyance_paise ?? current?.conveyancePaise ?? 0,
        specialAllowancePaise: b.data.special_allowance_paise ?? current?.specialAllowancePaise ?? 0,
        customComponentsJson: current?.customComponentsJson ?? '[]',
        notes: b.data.notes ?? null,
        createdBy: session.userId,
        updatedBy: session.userId,
      },
    })
  })

  await writeAudit({
    actorUserId: session.userId, action: 'salary.updated',
    entityType: 'SalaryStructure', entityId: row.id,
    before: current ? salaryStructureToApi(current) : null, after: salaryStructureToApi(row), req,
  })
  ok(res, { structure: salaryStructureToApi(row) })
}))

// ── Annual TDS plan — /api/employees/:id/tds-plan ────────────────────────
//
// Manual, once-per-year figure (§2.6). The payroll engine reads it as
// plan ÷ 12 for the monthly deduction. Marking exempt is an explicit
// opt-out that carries a reason on the row — peer review can trace who
// decided what.
salaryRouter.patch('/tds-plan', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'salary.manage', 'organisation')) {
    throw ApiError.forbidden('Only HR/MD can set the TDS plan.')
  }
  const employeeId = req.params.id
  const b = z.object({
    annual_tds_plan_paise: z.number().int().min(0),
    exempt_reason: z.string().trim().max(500).optional().nullable(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('annual_tds_plan_paise required.')

  const employee = await prisma.employee.findUnique({ where: { id: employeeId } })
  if (!employee) throw ApiError.notFound('Employee not found.')

  const exempt = (b.data.exempt_reason ?? '').trim() || null
  // Refuse the combination "non-zero plan AND marked exempt": that's a
  // contradiction the UI should never send, and storing it would confuse
  // peer review reading the audit trail.
  if (b.data.annual_tds_plan_paise > 0 && exempt) {
    throw ApiError.unprocessable('inconsistent_tds',
      'An employee cannot have both a non-zero TDS plan and a "no TDS applicable" reason. Clear one.')
  }

  const updated = await prisma.employee.update({
    where: { id: employeeId },
    data: {
      annualTdsPlanPaise: b.data.annual_tds_plan_paise,
      tdsExemptReason: exempt,
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'employee.tds_plan_updated',
    entityType: 'Employee', entityId: employeeId,
    before: {
      annual_tds_plan_paise: employee.annualTdsPlanPaise,
      exempt_reason: employee.tdsExemptReason,
    },
    after: {
      annual_tds_plan_paise: updated.annualTdsPlanPaise,
      exempt_reason: updated.tdsExemptReason,
    },
    req,
  })
  ok(res, {
    employee_id: employeeId,
    annual_tds_plan_paise: updated.annualTdsPlanPaise,
    monthly_tds_paise: Math.round(updated.annualTdsPlanPaise / 12),
    exempt_reason: updated.tdsExemptReason,
  })
}))

/** Exported so the dashboard widget can reuse the "today" convention. */
export const payrollToday = istToday
