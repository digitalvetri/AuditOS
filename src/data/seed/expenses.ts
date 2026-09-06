/**
 * Expenses seed — 12 rows across all statuses per §13.
 *
 * A few Paid rows generate matching Payment + LedgerTransaction so the
 * "on Paid, ledger auto-writes" invariant is visible on first load, not just
 * when someone runs the flow live.
 */

import type {
  Expense,
  ExpensePaymentMethod,
  ExpenseStage,
  LedgerTransaction,
  Payment,
} from '@/data/models';
import { addDays, istToday } from '@/lib/dates';

const now = new Date().toISOString();
const today = istToday();
const audit = (createdBy: string | null = null) => ({
  created_at: now,
  updated_at: now,
  created_by: createdBy,
  updated_by: createdBy,
  deleted_at: null,
});

function paise(rupees: number): number { return Math.round(rupees) * 100; }

// Helper to build a canonical expense row.
function build(
  id: string,
  employee_id: string,
  category_id: string,
  amount_rupees: number,
  expense_date: string,
  title: string,
  description: string,
  stage: ExpenseStage,
  overrides: Partial<Expense> = {},
): Expense {
  const submitted = ['pending_manager', 'pending_finance', 'approved', 'paid', 'rejected'].includes(stage);
  const managerApproved = ['pending_finance', 'approved', 'paid'].includes(stage);
  const financeApproved = ['approved', 'paid'].includes(stage);
  return {
    id,
    employee_id,
    category_id,
    title,
    amount_paise: paise(amount_rupees),
    expense_date,
    description,
    payment_method: 'card',
    receipt_file_key: null,
    notes: null,
    stage,
    submitted_at: submitted ? now : null,
    manager_approved_by: managerApproved ? 'usr-mgr' : null,
    manager_approved_at: managerApproved ? now : null,
    finance_approved_by: financeApproved ? 'usr-fin' : null,
    finance_approved_at: financeApproved ? now : null,
    paid_at: stage === 'paid' ? now : null,
    payment_id: stage === 'paid' ? `pay-exp-${id}` : null,
    rejection_reason: stage === 'rejected' ? 'Duplicate of expense from last week' : null,
    rejected_by: stage === 'rejected' ? 'usr-mgr' : null,
    rejected_at: stage === 'rejected' ? now : null,
    client_id: null,
    ...audit(employee_id === 'emp-exec' ? 'usr-emp' : null),
    ...overrides,
  };
}

// Roughly one per stage + a few extras for volume.
export const expenseSeed: Expense[] = [
  // Employee (Meera) — a bunch of her own history + 1 pending
  build('exp-01', 'emp-exec', 'ec-travel', 1_850, addDays(today, -35), 'Cab to client — Coimbatore', 'Return cabs to Sundar & Co audit', 'paid'),
  build('exp-02', 'emp-exec', 'ec-meals', 620, addDays(today, -33), 'Client dinner — Q1 review', 'Dinner with client CFO', 'paid'),
  build('exp-03', 'emp-exec', 'ec-office', 340, addDays(today, -20), 'Stationery', 'Ring binders, tabs for filing', 'approved'),
  build('exp-04', 'emp-exec', 'ec-travel', 2_400, addDays(today, -12), 'Auto — field visit', 'Half-day auto for statutory office visit', 'pending_finance'),
  build('exp-05', 'emp-exec', 'ec-phone', 599, addDays(today, -5), 'Mobile top-up', 'Client-call recharge', 'pending_manager'),
  build('exp-06', 'emp-exec', 'ec-meals', 220, addDays(today, -2), 'Tea break', 'Meeting with junior over tea', 'draft'),

  // Manager (Vikram) — his own expenses
  build('exp-07', 'emp-mgr', 'ec-travel', 4_800, addDays(today, -18), 'Chennai → Trichy flight', 'Client visit', 'paid'),
  build('exp-08', 'emp-mgr', 'ec-meals', 950, addDays(today, -10), 'Team dinner', 'Team-lead dinner post-close', 'pending_finance'),

  // MD (Ravi) — approved but unpaid
  build('exp-09', 'emp-md', 'ec-sub', 12_000, addDays(today, -8), 'ICAI subscription', 'Annual renewal', 'approved'),

  // Rejected (Meera) — for status coverage
  build('exp-10', 'emp-exec', 'ec-other', 350, addDays(today, -14), 'Umbrella', 'Bought during monsoon field visit', 'rejected'),

  // Articled (Karthik) — small pending
  build('exp-11', 'emp-articled', 'ec-travel', 180, addDays(today, -3), 'Bus fare', 'To ITO office', 'pending_manager'),

  // HR (Priya) — historical paid
  build('exp-12', 'emp-hr', 'ec-office', 2_200, addDays(today, -45), 'Office plants', 'Reception refresh', 'paid'),
];

// Payment + Ledger rows for the paid ones.
function buildPaidArtifacts(exps: Expense[]): { payments: Payment[]; ledger: LedgerTransaction[] } {
  const payments: Payment[] = [];
  const ledger: LedgerTransaction[] = [];
  let running = 0;
  for (const e of exps.filter((x) => x.stage === 'paid' && x.paid_at)) {
    payments.push({
      id: `pay-exp-${e.id}`,
      employee_id: e.employee_id,
      payroll_run_id: null,
      expense_id: e.id,
      amount_paise: e.amount_paise,
      method: 'mock',
      reference: `SIM-EXP-${e.id}`,
      status: 'completed',
      paid_at: e.paid_at,
      ...audit(),
    } as Payment);
    running -= e.amount_paise;
    ledger.push({
      id: `lt-exp-${e.id}`,
      date: e.paid_at!.slice(0, 10),
      type: 'Expense Reimbursement',
      description: `Reimbursement — ${e.title}`,
      employee_id: e.employee_id,
      category: 'Expense',
      debit_paise: e.amount_paise,
      credit_paise: 0,
      running_balance_paise: running,
      reference_id: e.id,
      reference_type: 'Expense',
      status: 'posted',
      created_at: e.paid_at!,
      created_by: 'usr-fin',
    });
  }
  return { payments, ledger };
}

export const expensePaymentSeed = buildPaidArtifacts(expenseSeed).payments;
export const expenseLedgerSeed = buildPaidArtifacts(expenseSeed).ledger;

// Payment methods enum snapshot (helper for the modal picker).
export const EXPENSE_PAYMENT_METHODS: ExpensePaymentMethod[] = ['cash', 'card', 'upi', 'bank_transfer', 'other'];
