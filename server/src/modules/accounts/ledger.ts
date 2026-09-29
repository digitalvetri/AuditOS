import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import {
  INTERNAL_NAMESPACE,
  LIABILITY_CATEGORIES,
  type Category,
  type LedgerType,
  type LiabilityCategory,
} from '../../platform/constants.js'

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
  'Liability Remittance': 'LT-REM',
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

/**
 * One leg of a compound journal. Exactly one of `debitPaise` / `creditPaise`
 * carries a non-zero value; the other side may be omitted.
 */
export interface JournalLeg {
  category: Category | string
  description?: string
  debitPaise?: number
  creditPaise?: number
  employeeId?: string | null
}

export interface PostJournalInput {
  date: string // 'YYYY-MM-DD'
  type: LedgerType
  description: string
  legs: JournalLeg[]
  employeeId?: string | null
  referenceId: string
  referenceType: string
  paymentId?: string | null
  reversesId?: string | null
  createdBy: string | null
}

/**
 * Compound double-entry posting. Writes one LedgerTransaction row per leg,
 * atomically in the caller's transaction, and enforces the accounting
 * identity Σ debits = Σ credits BEFORE any row is written. Zero-value legs
 * are filtered — e.g. a payroll run with no ESI produces no ESI leg.
 *
 * The `paymentId` (for payroll/expense discharges) or `reversesId` (for
 * contra reversals) naturally clusters the legs of one posting, so a
 * separate group id is not stored.
 */
export async function postJournal(tx: Prisma.TransactionClient, input: PostJournalInput) {
  const legs = input.legs.filter((l) => (l.debitPaise ?? 0) > 0 || (l.creditPaise ?? 0) > 0)
  if (legs.length < 2) {
    throw ApiError.badRequest('A journal needs at least two non-zero legs.')
  }
  for (const l of legs) {
    const dr = l.debitPaise ?? 0
    const cr = l.creditPaise ?? 0
    if (dr > 0 && cr > 0) {
      throw ApiError.badRequest(`Journal leg "${l.category}" carries both a debit and a credit.`)
    }
  }
  const totalDr = legs.reduce((s, l) => s + (l.debitPaise ?? 0), 0)
  const totalCr = legs.reduce((s, l) => s + (l.creditPaise ?? 0), 0)
  if (totalDr !== totalCr) {
    throw ApiError.badRequest(`Journal unbalanced: Dr ${totalDr} paise ≠ Cr ${totalCr} paise.`)
  }

  const rows: Awaited<ReturnType<typeof postLedger>>[] = []
  for (const leg of legs) {
    rows.push(await postLedger(tx, {
      date: input.date,
      type: input.type,
      description: leg.description ?? input.description,
      employeeId: leg.employeeId ?? input.employeeId ?? null,
      category: leg.category,
      debitPaise: leg.debitPaise,
      creditPaise: leg.creditPaise,
      referenceId: input.referenceId,
      referenceType: input.referenceType,
      paymentId: input.paymentId,
      reversesId: input.reversesId,
      createdBy: input.createdBy,
    }))
  }
  return rows
}

/**
 * "Held, not yet remitted." Sums credits minus debits per liability
 * category — a payroll run credits the payable, a remittance debits it, so
 * the balance is what the firm is still holding from staff and owes out.
 */
export async function heldLiabilityBalances(): Promise<Record<LiabilityCategory, number>> {
  const rows = await prisma.ledgerTransaction.groupBy({
    by: ['category'],
    where: {
      namespace: INTERNAL_NAMESPACE,
      status: 'posted',
      category: { in: LIABILITY_CATEGORIES as unknown as string[] },
    },
    _sum: { debitPaise: true, creditPaise: true },
  })
  const out = Object.fromEntries(
    LIABILITY_CATEGORIES.map((c) => [c, 0]),
  ) as Record<LiabilityCategory, number>
  for (const r of rows) {
    if (!r.category) continue
    const cat = r.category as LiabilityCategory
    out[cat] = (r._sum.creditPaise ?? 0) - (r._sum.debitPaise ?? 0)
  }
  return out
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
 * §14 reconciliation. Two things must hold in a double-entry ledger:
 *   1. Σ debits = Σ credits across every posted row.
 *   2. Every Bank credit is traceable to a source of truth: a processed
 *      payroll run's net pay, a paid expense's amount, a recorded
 *      remittance, or an advance/office payment. This step catches
 *      "Bank credited but the payroll run says something else" bugs.
 * Remittances and manual payments have no external source; their Bank
 * credits are trusted as-is since the ledger row is the record.
 */
export async function reconcile() {
  const [payroll, expenses, totals, bankFromPayroll, bankFromExpense] = await Promise.all([
    prisma.payrollRun.aggregate({ where: { stage: 'processed', deletedAt: null }, _sum: { netTotalPaise: true } }),
    prisma.expense.aggregate({ where: { stage: 'paid', deletedAt: null }, _sum: { amountPaise: true } }),
    prisma.ledgerTransaction.aggregate({
      where: { namespace: INTERNAL_NAMESPACE, status: 'posted' },
      _sum: { debitPaise: true, creditPaise: true },
    }),
    prisma.ledgerTransaction.aggregate({
      where: {
        namespace: INTERNAL_NAMESPACE, status: 'posted',
        category: 'Bank', referenceType: 'PayrollItem',
      },
      _sum: { creditPaise: true },
    }),
    prisma.ledgerTransaction.aggregate({
      where: {
        namespace: INTERNAL_NAMESPACE, status: 'posted',
        category: 'Bank', referenceType: 'Expense',
      },
      _sum: { creditPaise: true },
    }),
  ])
  const processedPayrollPaise = payroll._sum.netTotalPaise ?? 0
  const paidExpensesPaise = expenses._sum.amountPaise ?? 0
  const totalDr = totals._sum.debitPaise ?? 0
  const totalCr = totals._sum.creditPaise ?? 0
  const bankPayrollPaise = bankFromPayroll._sum.creditPaise ?? 0
  const bankExpensePaise = bankFromExpense._sum.creditPaise ?? 0
  return {
    total_debit_paise: totalDr,
    total_credit_paise: totalCr,
    balanced: totalDr === totalCr,
    processed_payroll_paise: processedPayrollPaise,
    ledger_payroll_bank_paise: bankPayrollPaise,
    payroll_variance_paise: bankPayrollPaise - processedPayrollPaise,
    paid_expenses_paise: paidExpensesPaise,
    ledger_expense_bank_paise: bankExpensePaise,
    expense_variance_paise: bankExpensePaise - paidExpensesPaise,
    reconciled:
      totalDr === totalCr
      && bankPayrollPaise === processedPayrollPaise
      && bankExpensePaise === paidExpensesPaise,
  }
}
