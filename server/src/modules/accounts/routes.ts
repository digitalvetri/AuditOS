import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { istToday } from '../../lib/dates.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { LEDGER_TYPES, MOCK_PAYMENT_NOTICE, type LedgerType } from '../../platform/constants.js'
import { employeeRef, ledgerToApi, paymentToApi } from '../../api/serialize.js'
import { nextPaymentNo, postLedger, reconcile } from './ledger.js'

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
      // A reversed row keeps its amounts; its contra row nets them to zero.
      balance_paise: totalCredit - totalDebit,
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
    await postLedger(tx, {
      date: istToday(),
      type: ledgerType,
      description: b.data.description ?? `${ledgerType} — ${employee.fullName}`,
      employeeId: employee.id,
      category: ledgerType,
      debitPaise: b.data.amount_paise,
      referenceId: created.id,
      referenceType: 'Payment',
      paymentId: created.id,
      createdBy: session.userId,
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
