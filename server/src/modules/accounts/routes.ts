import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { istToday } from '../../lib/dates.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import {
  CATEGORIES,
  LEDGER_TYPES,
  LIABILITY_CATEGORIES,
  MOCK_PAYMENT_NOTICE,
  type LedgerType,
  type LiabilityCategory,
} from '../../platform/constants.js'
import { employeeRef, ledgerToApi, paymentToApi } from '../../api/serialize.js'
import { heldLiabilityBalances, nextPaymentNo, postJournal, postLedger, reconcile } from './ledger.js'

/**
 * ACCOUNTS + PAYMENTS (§8.6 / §9)
 *
 * Append-only: there is no PATCH and no DELETE on the ledger. `accounts.read`
 * (MD) and `accounts.manage` (Finance) both open the reads; only
 * `accounts.manage` may post a contra entry.
 *
 * Client accounting never enters this module: no endpoint here accepts a
 * client_id, on a ledger row or on a payment.
 */
export const accountsRouter = Router()
export const paymentsRouter = Router()

function requireRead(session: Session) {
  if (!can(session, 'accounts.manage', 'organisation') && !can(session, 'accounts.read', 'organisation')) {
    throw ApiError.forbidden()
  }
}

const ledgerQuery = z.object({
  type: z.string().optional(),
  employeeId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  // 'date' (the accounting-correct order — Bug 7 fix), 'amount', 'type',
  // 'employee'. Anything but 'date' suppresses running_balance_paise.
  sort: z.enum(['date', 'amount', 'type', 'employee']).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
})

/**
 * Running balance is meaningful ONLY when rows are in transaction-date
 * order — "the balance as at 22 Aug" cannot be answered from a list sorted
 * by amount. So we compute the balance in the accounting order (date,
 * createdAt, id) regardless of how the caller wants the list back, and
 * only surface it when the CALLER'S order matches that. Any other sort
 * returns rows without a running_balance_paise field, and the UI hides
 * the column.
 */
function withRunningBalance<T extends {
  id: string; debit_paise: number; credit_paise: number; created_at: string; date: string
}>(rows: T[]): (T & { running_balance_paise: number })[] {
  const ascending = [...rows].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
    return a.id < b.id ? -1 : 1
  })
  const map = new Map<string, number>()
  let running = 0
  for (const r of ascending) {
    running += r.debit_paise - r.credit_paise
    map.set(r.id, running)
  }
  return rows.map((r) => ({ ...r, running_balance_paise: map.get(r.id) ?? 0 }))
}

/**
 * A short human reference for the ledger's REFERENCE column. Never a UUID.
 * Payroll rows → `PR/YYYY-MM`. Expense rows → the expense number.
 * Manual payments / remittances → the payment number. Reversals point at
 * the original row's transactionRef.
 */
async function buildReferenceLabels(rows: { id: string; referenceId: string; referenceType: string }[]) {
  const payrollItemIds = rows.filter((r) => r.referenceType === 'PayrollItem').map((r) => r.referenceId)
  const expenseIds = rows.filter((r) => r.referenceType === 'Expense').map((r) => r.referenceId)
  const paymentIds = rows.filter((r) => r.referenceType === 'Payment' || r.referenceType === 'LiabilityRemittance').map((r) => r.referenceId)
  const ledgerIds = rows.filter((r) => r.referenceType === 'LedgerReversal').map((r) => r.referenceId)

  const [items, expenses, payments, reversedRows] = await Promise.all([
    payrollItemIds.length
      ? prisma.payrollItem.findMany({ where: { id: { in: payrollItemIds } }, include: { payrollRun: true } })
      : Promise.resolve([]),
    expenseIds.length
      ? prisma.expense.findMany({ where: { id: { in: expenseIds } }, select: { id: true, expenseNo: true } })
      : Promise.resolve([]),
    paymentIds.length
      ? prisma.payment.findMany({ where: { id: { in: paymentIds } }, select: { id: true, paymentNo: true } })
      : Promise.resolve([]),
    ledgerIds.length
      ? prisma.ledgerTransaction.findMany({ where: { id: { in: ledgerIds } }, select: { id: true, transactionRef: true } })
      : Promise.resolve([]),
  ])

  const labels = new Map<string, string>()
  for (const it of items) {
    // `PR/2026-08` from '2026-08-01', regardless of period_end drift.
    labels.set(`PayrollItem:${it.id}`, `PR/${it.payrollRun.periodStart.slice(0, 7)}`)
  }
  for (const e of expenses) labels.set(`Expense:${e.id}`, e.expenseNo)
  for (const p of payments) {
    labels.set(`Payment:${p.id}`, p.paymentNo)
    labels.set(`LiabilityRemittance:${p.id}`, p.paymentNo)
  }
  for (const r of reversedRows) labels.set(`LedgerReversal:${r.id}`, r.transactionRef)
  return labels
}

async function listLedger(req: Request, res: Response) {
  const session = requireSession(req)
  requireRead(session)
  const q = ledgerQuery.parse(req.query)
  const sort = q.sort ?? 'date'
  // Traditional accounting convention: oldest first, so the running balance
  // reads top-to-bottom as it accrues. Callers can flip via ?dir=desc.
  const dir = q.dir ?? 'asc'

  const rows = await prisma.ledgerTransaction.findMany({
    where: {
      ...(q.type ? { type: q.type } : {}),
      ...(q.employeeId ? { employeeId: q.employeeId } : {}),
      ...(q.from || q.to ? { date: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    },
    include: { employee: true },
    // Fetch in accounting order so running_balance_paise, when we compute
    // it, is always over the same series regardless of the caller's `sort`.
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })

  const labels = await buildReferenceLabels(rows)
  const serialized = rows.map((r) => ({
    ...ledgerToApi(r),
    employee: employeeRef(r.employee),
    reference_label: labels.get(`${r.referenceType}:${r.referenceId}`) ?? null,
  }))

  // Running balance is computed once, in date order. If the caller asked
  // for anything other than the date sort we STRIP the field rather than
  // show a running balance that no longer refers to "as at this date".
  const withBalance = withRunningBalance(serialized)
  let items: Array<(typeof withBalance)[number] | Omit<(typeof withBalance)[number], 'running_balance_paise'>> = withBalance
  const sortCmp = (a: (typeof withBalance)[number], b: (typeof withBalance)[number]) => {
    if (sort === 'date') {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
      return a.id < b.id ? -1 : 1
    }
    if (sort === 'amount') {
      const av = (a.debit_paise || 0) + (a.credit_paise || 0)
      const bv = (b.debit_paise || 0) + (b.credit_paise || 0)
      if (av !== bv) return av - bv
    }
    if (sort === 'type') {
      if (a.type !== b.type) return a.type < b.type ? -1 : 1
    }
    if (sort === 'employee') {
      const ae = a.employee?.full_name ?? ''
      const be = b.employee?.full_name ?? ''
      if (ae !== be) return ae < be ? -1 : 1
    }
    return 0
  }
  const sorted = [...withBalance].sort(sortCmp)
  if (dir === 'desc') sorted.reverse()
  if (sort !== 'date') {
    items = sorted.map(({ running_balance_paise: _, ...rest }) => rest)
  } else {
    items = sorted
  }
  ok(res, { items, count: items.length, sort, dir, running_balance_available: sort === 'date' })
}

accountsRouter.get('/ledger', handler(listLedger))
// `/transactions` is the alias the spec lists; same handler, no second code path.
accountsRouter.get('/transactions', handler(listLedger))

accountsRouter.get('/summary', handler(async (req, res) => {
  const session = requireSession(req)
  requireRead(session)

  const all = await prisma.ledgerTransaction.findMany({
    select: { type: true, date: true, debitPaise: true, creditPaise: true },
  })
  const totalDebit = all.reduce((s, l) => s + l.debitPaise, 0)
  const totalCredit = all.reduce((s, l) => s + l.creditPaise, 0)
  const monthPrefix = istToday().slice(0, 7)
  const thisMonth = all.filter((l) => l.date.startsWith(monthPrefix))

  ok(res, {
    totals: {
      debit_paise: totalDebit,
      credit_paise: totalCredit,
      // Under double-entry this is 0 for a healthy book; a non-zero balance
      // is an unbalanced posting to investigate. A reversed row keeps its
      // amounts; its contra row nets them to zero.
      balance_paise: totalDebit - totalCredit,
      balanced: totalDebit === totalCredit,
    },
    this_month: {
      debit_paise: thisMonth.reduce((s, l) => s + l.debitPaise, 0),
      credit_paise: thisMonth.reduce((s, l) => s + l.creditPaise, 0),
    },
    by_type: LEDGER_TYPES.map((t) => {
      const rows = all.filter((l) => l.type === t)
      return {
        type: t,
        debit: rows.reduce((s, l) => s + l.debitPaise, 0),
        credit: rows.reduce((s, l) => s + l.creditPaise, 0),
        count: rows.length,
      }
    }),
  })
}))

/** §14 reconciliation check, surfaced so Finance can see it rather than trust it. */
accountsRouter.get('/reconciliation', handler(async (req, res) => {
  requireRead(requireSession(req))
  ok(res, await reconcile())
}))

/**
 * GET /api/accounts/liabilities/held — balances of statutory withholdings
 * the firm is holding on behalf of staff. Drives the Overview tab's
 * "Held, not yet remitted" panel.
 */
accountsRouter.get('/liabilities/held', handler(async (req, res) => {
  requireRead(requireSession(req))
  const balances = await heldLiabilityBalances()
  ok(res, {
    items: LIABILITY_CATEGORIES.map((c) => ({ category: c, balance_paise: balances[c] })),
  })
}))

/**
 * POST /api/accounts/liabilities/remit — Finance records a remittance to
 * EPFO / state / income tax. Writes Dr <Liability> / Cr Bank and refuses
 * amounts that would drive the liability below zero (remitting more than
 * we've withheld is a data-entry error, not a valid transaction).
 */
accountsRouter.post('/liabilities/remit', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'accounts.manage', 'organisation')) {
    throw ApiError.forbidden('Only Finance can record a remittance.')
  }
  const b = z.object({
    category: z.enum(LIABILITY_CATEGORIES),
    amount_paise: z.number().int().positive(),
    reference: z.string().trim().min(1).max(120),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    notes: z.string().max(500).optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('category, positive amount_paise, and reference required.')

  const balances = await heldLiabilityBalances()
  const category = b.data.category as LiabilityCategory
  if (b.data.amount_paise > balances[category]) {
    throw ApiError.unprocessable('exceeds_balance',
      `Cannot remit more than the held balance (${balances[category]} paise).`)
  }

  const date = b.data.date ?? istToday()
  const rows = await prisma.$transaction(async (tx) => {
    const paymentNo = await nextPaymentNo(tx)
    const payment = await tx.payment.create({
      data: {
        paymentNo,
        // Remittance is not employee-scoped, but Payment.employeeId is
        // non-nullable in the schema. Attribute it to the acting user's
        // employee record so the row is well-formed and traceable.
        employeeId: session.employeeId ?? (() => {
          throw ApiError.unprocessable('no_employee', 'Your login has no employee record; cannot record a remittance.')
        })(),
        amountPaise: b.data.amount_paise,
        method: 'mock',
        reference: b.data.reference,
        status: 'completed',
        paidAt: new Date(),
        createdBy: session.userId,
        updatedBy: session.userId,
      },
    })
    const legs = await postJournal(tx, {
      date,
      type: 'Liability Remittance',
      description: `Remittance — ${category} — ${b.data.reference}`,
      referenceId: payment.id,
      referenceType: 'LiabilityRemittance',
      paymentId: payment.id,
      createdBy: session.userId,
      legs: [
        { category, debitPaise: b.data.amount_paise },
        { category: CATEGORIES.BANK, creditPaise: b.data.amount_paise },
      ],
    })
    return { payment, legs }
  })

  await writeAudit({
    actorUserId: session.userId, action: 'accounts.liability_remitted',
    entityType: 'Payment', entityId: rows.payment.id,
    after: { category, amount_paise: b.data.amount_paise, reference: b.data.reference }, req,
  })
  ok(res, {
    payment: paymentToApi(rows.payment),
    ledger_rows: rows.legs.map(ledgerToApi),
  })
}))

// POST /api/accounts/ledger/:id/reverse — the only correction path.
//
// A reason is required and stored on every contra row, so the audit trail
// survives even if the AuditLog is compacted. When the target is one leg
// of a multi-leg journal (payment cluster), the WHOLE cluster is reversed
// atomically: reversing one leg alone would break Σdr = Σcr.
//
// Reversing a Liability Remittance ("unremit") is permitted intentionally
// — a mistaken EPFO/state payment should be correctable. The reason field
// is the audit trail; a Finance user cannot un-remit silently.
accountsRouter.post('/ledger/:id/reverse', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'accounts.manage', 'organisation')) {
    throw ApiError.forbidden('Only Finance can reverse.')
  }
  const b = z.object({
    reason: z.string().trim().min(3, 'A reason of at least 3 characters is required.').max(500),
  }).safeParse(req.body ?? {})
  if (!b.success) {
    const msg = b.error.issues[0]?.message ?? 'A reason is required to reverse a ledger row.'
    throw ApiError.badRequest(msg)
  }
  const reason = b.data.reason

  const original = await prisma.ledgerTransaction.findUnique({ where: { id: req.params.id } })
  if (!original) throw ApiError.notFound('Ledger row not found.')
  if (original.status === 'reversed') {
    throw ApiError.conflict('already_reversed', 'This row has already been reversed.')
  }
  if (original.reversesId) {
    throw ApiError.conflict('is_contra', 'A contra entry cannot itself be reversed.')
  }

  // If this row is one leg of a payment cluster, reverse them all — every
  // posted row that shares the paymentId. Otherwise reverse just this row.
  const clusterRows = original.paymentId
    ? await prisma.ledgerTransaction.findMany({
      where: {
        paymentId: original.paymentId, status: 'posted', reversesId: null,
      },
      orderBy: { sequence: 'asc' },
    })
    : [original]

  const { contras, updatedOriginals } = await prisma.$transaction(async (tx) => {
    const created: (typeof clusterRows)[number][] = []
    const marked: (typeof clusterRows)[number][] = []
    for (const row of clusterRows) {
      const contra = await postLedger(tx, {
        date: istToday(),
        type: row.type as LedgerType,
        description: `Reversal — ${row.description}`,
        employeeId: row.employeeId,
        category: row.category,
        // Swap the sides. The original row's amounts are never rewritten.
        debitPaise: row.creditPaise,
        creditPaise: row.debitPaise,
        referenceId: row.id,
        referenceType: 'LedgerReversal',
        reversesId: row.id,
        reversalReason: reason,
        createdBy: session.userId,
      })
      const updated = await tx.ledgerTransaction.update({
        where: { id: row.id }, data: { status: 'reversed' },
      })
      created.push(contra)
      marked.push(updated)
    }
    return { contras: created, updatedOriginals: marked }
  })

  await writeAudit({
    actorUserId: session.userId, action: 'accounts.ledger_reversed',
    entityType: 'LedgerTransaction', entityId: original.id,
    before: { status: original.status, cluster_size: clusterRows.length },
    after: { reverse_ids: contras.map((c) => c.id), reason },
    req,
  })
  ok(res, {
    originals: updatedOriginals.map(ledgerToApi),
    contras: contras.map(ledgerToApi),
    reason,
    cluster_size: clusterRows.length,
  })
}))

// ── Payments ──────────────────────────────────────────────────────────────
paymentsRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'payments.manage', 'organisation')) throw ApiError.forbidden()
  const q = z.object({ employeeId: z.string().optional(), status: z.string().optional() }).parse(req.query)

  const rows = await prisma.payment.findMany({
    where: {
      deletedAt: null,
      ...(q.employeeId ? { employeeId: q.employeeId } : {}),
      ...(q.status ? { status: q.status } : {}),
    },
    include: { employee: true },
    orderBy: { createdAt: 'desc' },
  })
  const items = rows.map((p) => ({ ...paymentToApi(p), employee: employeeRef(p.employee) }))
  ok(res, { items, count: items.length, notice: MOCK_PAYMENT_NOTICE })
}))

paymentsRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'payments.manage', 'organisation')) {
    throw ApiError.forbidden('Only Finance can record payments.')
  }
  const b = z.object({
    employee_id: z.string().min(1),
    amount_paise: z.number().int().positive(),
    method: z.enum(['bank_transfer', 'cash', 'cheque', 'mock']).optional(),
    reference: z.string().optional(),
    ledger_type: z.string().optional(),
    description: z.string().optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('employee_id and positive amount_paise required.')

  const employee = await prisma.employee.findUnique({ where: { id: b.data.employee_id } })
  if (!employee) throw ApiError.unprocessable('invalid_employee', 'Unknown employee.')

  const ledgerType = (b.data.ledger_type ?? 'Employee Advance') as LedgerType
  if (!LEDGER_TYPES.includes(ledgerType)) throw ApiError.badRequest('unknown ledger_type')

  const payment = await prisma.$transaction(async (tx) => {
    const paymentNo = await nextPaymentNo(tx)
    const created = await tx.payment.create({
      data: {
        paymentNo,
        employeeId: employee.id,
        amountPaise: b.data.amount_paise,
        method: b.data.method ?? 'mock',
        reference: b.data.reference ?? `${paymentNo}/MANUAL`,
        status: 'completed', // simulated — settles immediately
        paidAt: new Date(),
        createdBy: session.userId,
        updatedBy: session.userId,
      },
    })
    // Chart-of-accounts leg for the debit side depends on the type.
    // Advance Recovery is money coming IN from an employee, so Bank is debited.
    const isRecovery = ledgerType === 'Advance Recovery'
    const drCategory =
      ledgerType === 'Employee Advance' ? CATEGORIES.EMPLOYEE_ADVANCE
      : ledgerType === 'Office Expense' ? CATEGORIES.OFFICE_EXPENSE
      : ledgerType === 'Payment' ? CATEGORIES.REIMBURSEMENT
      : CATEGORIES.BANK
    const crCategory = isRecovery ? CATEGORIES.EMPLOYEE_ADVANCE : CATEGORIES.BANK
    await postJournal(tx, {
      date: istToday(),
      type: ledgerType,
      description: b.data.description ?? `${ledgerType} — ${employee.fullName}`,
      employeeId: employee.id,
      referenceId: created.id,
      referenceType: 'Payment',
      paymentId: created.id,
      createdBy: session.userId,
      legs: isRecovery
        ? [
            { category: CATEGORIES.BANK, debitPaise: b.data.amount_paise },
            { category: CATEGORIES.EMPLOYEE_ADVANCE, creditPaise: b.data.amount_paise },
          ]
        : [
            { category: drCategory, debitPaise: b.data.amount_paise },
            { category: crCategory, creditPaise: b.data.amount_paise },
          ],
    })
    return created
  })

  await writeAudit({
    actorUserId: session.userId, action: 'payments.recorded',
    entityType: 'Payment', entityId: payment.id,
    after: { amount_paise: payment.amountPaise, type: ledgerType, employee_id: employee.id, simulated: true }, req,
  })
  ok(res, { payment: paymentToApi(payment) })
}))
