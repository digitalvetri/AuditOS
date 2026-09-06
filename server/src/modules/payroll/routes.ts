import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { addDays, istToday, monthLabel } from '../../lib/dates.js'
import { calculatePayrollItem, type CustomComponent } from '../../domain/payroll/calc.js'
import { summarize } from '../../domain/payroll/attendanceSummary.js'
import { snapshotAt, type StatutorySnapshot } from '../../domain/payroll/statutory.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { notifyEmployee } from '../../platform/notify.js'
import { signedLink } from '../../platform/signedUrl.js'
import {
  employeeRef, employeeRefWithDept, payrollItemToApi, payrollRunToApi,
  paymentToApi, payslipToApi, salaryStructureToApi,
} from '../../api/serialize.js'
import { nextPaymentNo, postLedger } from '../accounts/ledger.js'

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

async function structureEffectiveOn(employeeId: string, onDate: string) {
  return prisma.salaryStructure.findFirst({
    where: {
      employeeId, deletedAt: null,
      effectiveFrom: { lte: onDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: onDate } }],
    },
    orderBy: { effectiveFrom: 'desc' },
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
  const b = z.object({
    period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('period_start and period_end required.')
  const { period_start, period_end } = b.data
  if (period_start > period_end) {
    throw ApiError.unprocessable('invalid_range', 'period_start must be on or before period_end.')
  }

  const overlap = await prisma.payrollRun.findFirst({
    where: { deletedAt: null, periodStart: { lte: period_end }, periodEnd: { gte: period_start } },
  })
  if (overlap) throw ApiError.conflict('overlap', 'A payroll run for this period already exists.')

  const org = await prisma.organisation.findFirstOrThrow({ where: { deletedAt: null } })
  const row = await prisma.payrollRun.create({
    data: {
      organisationId: org.id,
      periodStart: period_start,
      periodEnd: period_end,
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
  ok(res, {
    run: payrollRunToApi(run),
    items: items.map((i) => ({ ...payrollItemToApi(i), employee: employeeRefWithDept(i.employee) })),
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

  const employees = await prisma.employee.findMany({
    where: { deletedAt: null, status: { not: 'inactive' }, joiningDate: { lte: run.periodEnd } },
  })

  const prepared: {
    employeeId: string
    salaryStructureId: string
    summary: ReturnType<typeof summarize>
    calc: ReturnType<typeof calculatePayrollItem>
  }[] = []

  for (const emp of employees) {
    const structure = await structureEffectiveOn(emp.id, run.periodStart)
    if (!structure) continue // no salary on file for this period — not payable
    const [attendance, leaves] = await Promise.all([
      prisma.attendance.findMany({
        where: { employeeId: emp.id, deletedAt: null, date: { gte: run.periodStart, lte: run.periodEnd } },
        select: { date: true, status: true },
      }),
      prisma.leaveRequest.findMany({
        where: { employeeId: emp.id, status: 'approved', deletedAt: null },
        select: { startDate: true, endDate: true, status: true },
      }),
    ])
    const summary = summarize(attendance, leaves, run.periodStart, run.periodEnd)
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

  const items = await prisma.payrollItem.findMany({
    where: { payrollRunId: run.id, deletedAt: null }, include: { employee: true },
  })
  const now = new Date()
  const payslipBase = await prisma.payslip.count()

  const { fresh, payments, payslips } = await prisma.$transaction(async (tx) => {
    const createdPayments = []
    const createdPayslips = []
    let n = payslipBase

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

      await postLedger(tx, {
        date: run.periodEnd,
        type: 'Payroll',
        description: `Salary — ${item.employee.fullName} (${run.periodStart} to ${run.periodEnd})`,
        employeeId: item.employeeId,
        category: 'Payroll',
        debitPaise: item.netPaise,
        referenceId: item.id,
        referenceType: 'PayrollItem',
        paymentId: payment.id,
        createdBy: session.userId,
      })
    }

    const updated = await tx.payrollRun.update({
      where: { id: run.id },
      data: {
        stage: 'processed', processedBy: session.userId, processedAt: now, updatedBy: session.userId,
      },
    })
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
    department: { id: p.employee.department.id, name: p.employee.department.name },
    designation: { id: p.employee.designation.id, name: p.employee.designation.name },
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

  const rows = await prisma.salaryStructure.findMany({
    where: { employeeId: req.params.id, deletedAt: null }, orderBy: { effectiveFrom: 'desc' },
  })
  ok(res, {
    current: rows.find((r) => r.effectiveTo === null) ? salaryStructureToApi(rows.find((r) => r.effectiveTo === null)!) : null,
    history: rows.map(salaryStructureToApi),
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

/** Exported so the dashboard widget can reuse the "today" convention. */
export const payrollToday = istToday
