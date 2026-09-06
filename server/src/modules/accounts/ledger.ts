import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import { INTERNAL_NAMESPACE, type LedgerType } from '../../platform/constants.js'

/**
 * INTERNAL LEDGER (§8.6).
 *
 * This module is the ONLY writer to LedgerTransaction and it exposes no update
 * and no delete. A posted row is permanent; the single correction path is a
 * contra entry that points back at the row it reverses.
 *
 * NAMESPACE: these are Audit OS's own books. Client accounting has no door in
 * — every write asserts the internal namespace and every read filters on it,
 * so a future client-accounting store cannot share these rows by accident.
 *
 * Balance convention: running = previous + debit − credit. A debit is money
 * leaving Audit OS (salary paid, expense reimbursed), so the closing balance
 * equals total disbursed.
 */

const REF_PREFIX: Record<string, string> = {
  'Payroll': 'LT-PAY',
  'Expense Reimbursement': 'LT-EXP',
  'Office Expense': 'LT-OFC',
  'Employee Advance': 'LT-ADV',
  'Advance Recovery': 'LT-REC',
  'Payment': 'LT-PMT',
}

export interface PostLedgerInput {
  date: string // 'YYYY-MM-DD'
  type: LedgerType
  description: string
  employeeId?: string | null
  category?: string | null
  debitPaise?: number
  creditPaise?: number
  referenceId: string
  referenceType: string
  paymentId?: string | null
  reversesId?: string | null
  createdBy: string | null
}

/**
 * Post one append-only row. MUST run inside a transaction: the sequence and
 * the running balance are read-then-written, and two concurrent posts outside
 * a transaction would collide on the unique `sequence`.
 */
export async function postLedger(tx: Prisma.TransactionClient, input: PostLedgerInput) {
  const debit = input.debitPaise ?? 0
  const credit = input.creditPaise ?? 0
  if (debit < 0 || credit < 0) throw ApiError.badRequest('Ledger amounts cannot be negative.')
  if (debit === 0 && credit === 0) throw ApiError.badRequest('A ledger row must carry a debit or a credit.')

  const last = await tx.ledgerTransaction.findFirst({
    where: { namespace: INTERNAL_NAMESPACE },
    orderBy: { sequence: 'desc' },
    select: { sequence: true, runningBalancePaise: true },
  })
  const sequence = (last?.sequence ?? 0) + 1
  const runningBalancePaise = (last?.runningBalancePaise ?? 0) + debit - credit

  return tx.ledgerTransaction.create({
    data: {
      transactionRef: `${REF_PREFIX[input.type] ?? 'LT'}-${String(sequence).padStart(6, '0')}`,
      namespace: INTERNAL_NAMESPACE,
      sequence,
      date: input.date,
      type: input.type,
      description: input.description,
      employeeId: input.employeeId ?? null,
      category: input.category ?? null,
      debitPaise: debit,
      creditPaise: credit,
      runningBalancePaise,
      referenceId: input.referenceId,
      referenceType: input.referenceType,
      paymentId: input.paymentId ?? null,
      reversesId: input.reversesId ?? null,
      status: 'posted',
      createdBy: input.createdBy,
    },
  })
}

/** Next payment number, inside the caller's transaction. */
export async function nextPaymentNo(tx: Prisma.TransactionClient): Promise<string> {
  const count = await tx.payment.count()
  return `PMT-${String(count + 1).padStart(5, '0')}`
}

export async function ledgerBalancePaise(): Promise<number> {
  const last = await prisma.ledgerTransaction.findFirst({
    where: { namespace: INTERNAL_NAMESPACE },
    orderBy: { sequence: 'desc' },
    select: { runningBalancePaise: true },
  })
  return last?.runningBalancePaise ?? 0
}

/**
 * §14 reconciliation: the ledger balance must equal processed payroll plus
 * paid expenses plus any other movements.
 */
export async function reconcile() {
  const [payroll, expenses, byType, balance] = await Promise.all([
    prisma.payrollRun.aggregate({ where: { stage: 'processed', deletedAt: null }, _sum: { netTotalPaise: true } }),
    prisma.expense.aggregate({ where: { stage: 'paid', deletedAt: null }, _sum: { amountPaise: true } }),
    prisma.ledgerTransaction.groupBy({
      by: ['type'],
      where: { namespace: INTERNAL_NAMESPACE },
      _sum: { debitPaise: true, creditPaise: true },
    }),
    ledgerBalancePaise(),
  ])
  const processedPayrollPaise = payroll._sum.netTotalPaise ?? 0
  const paidExpensesPaise = expenses._sum.amountPaise ?? 0
  const otherPaise = byType
    .filter((t) => t.type !== 'Payroll' && t.type !== 'Expense Reimbursement')
    .reduce((s, t) => s + (t._sum.debitPaise ?? 0) - (t._sum.creditPaise ?? 0), 0)
  const expected = processedPayrollPaise + paidExpensesPaise + otherPaise
  return {
    processed_payroll_paise: processedPayrollPaise,
    paid_expenses_paise: paidExpensesPaise,
    other_movements_paise: otherPaise,
    expected_balance_paise: expected,
    ledger_balance_paise: balance,
    variance_paise: balance - expected,
    reconciled: balance === expected,
  }
}
