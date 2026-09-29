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
})

/**
 * The stored running balance is a snapshot of the FULL ledger at write time.
 * When the caller filters, we recompute over the returned rows so the balance
 * column reads correctly for that view.
 */
function withRunningBalance<T extends { debit_paise: number; credit_paise: number; sequence: number }>(rows: T[]): T[] {
  const ascending = [...rows].sort((a, b) => a.sequence - b.sequence)
  let running = 0
  return ascending.map((r) => {
    running += r.debit_paise - r.credit_paise
    return { ...r, running_balance_paise: running }
  })
}

async function listLedger(req: Request, res: Response) {
  const session = requireSession(req)
  requireRead(session)
  const q = ledgerQuery.parse(req.query)

  const rows = await prisma.ledgerTransaction.findMany({
    where: {
      ...(q.type ? { type: q.type } : {}),
      ...(q.employeeId ? { employeeId: q.employeeId } : {}),
      ...(q.from || q.to ? { date: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    },
    include: { employee: true },
    orderBy: { sequence: 'asc' },
  })

  const serialized = rows.map((r) => ({ ...ledgerToApi(r), employee: employeeRef(r.employee) }))
  const items = withRunningBalance(serialized).reverse() // newest first for the table
  ok(res, { items, count: items.length })
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
accountsRouter.post('/ledger/:id/reverse', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'accounts.manage', 'organisation')) {
    throw ApiError.forbidden('Only Finance can reverse.')
  }
  const original = await prisma.ledgerTransaction.findUnique({ where: { id: req.params.id } })
  if (!original) throw ApiError.notFound('Ledger row not found.')
  if (original.status === 'reversed') {
    throw ApiError.conflict('already_reversed', 'This row has already been reversed.')
  }
  if (original.reversesId) {
    throw ApiError.conflict('is_contra', 'A contra entry cannot itself be reversed.')
  }
  // Under double-entry, a payroll or expense posting is a cluster of legs
  // that share a paymentId. Reversing one leg would break Σdr = Σcr and
  // turn the Overview strip from "✓ balanced" to false in one click.
  // Whole-cluster reversal ships in Step 2 (with the reason field); until
  // then, refuse the multi-leg case rather than silently unbalance.
  if (original.paymentId) {
    const clusterSize = await prisma.ledgerTransaction.count({
      where: { paymentId: original.paymentId, status: 'posted' },
    })
    if (clusterSize > 1) {
      throw ApiError.conflict('multi_leg_reversal',
        `This row is one leg of a ${clusterSize}-leg journal. Reversing a single leg would unbalance the ledger — use the source correction flow (unpay expense, or a manual counter-journal) until the cluster-reverse action lands in Step 2.`)
    }
  }

  const { reverse, updatedOriginal } = await prisma.$transaction(async (tx) => {
    const contra = await postLedger(tx, {
      date: istToday(),
      type: original.type as LedgerType,
      description: `Reversal — ${original.description}`,
      employeeId: original.employeeId,
      category: original.category,
      // Swap the sides. The original row's amounts are never rewritten.
      debitPaise: original.creditPaise,
      creditPaise: original.debitPaise,
      referenceId: original.id,
      referenceType: 'LedgerReversal',
      reversesId: original.id,
      createdBy: session.userId,
    })
    const updated = await tx.ledgerTransaction.update({
      where: { id: original.id }, data: { status: 'reversed' },
    })
    return { reverse: contra, updatedOriginal: updated }
  })

  await writeAudit({
    actorUserId: session.userId, action: 'accounts.ledger_reversed',
    entityType: 'LedgerTransaction', entityId: original.id,
    before: { status: original.status }, after: { reverse_id: reverse.id }, req,
  })
  ok(res, { original: ledgerToApi(updatedOriginal), reverse: ledgerToApi(reverse) })
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
