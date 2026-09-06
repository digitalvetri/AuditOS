/**
 * Payroll seed.
 *
 *   - SalaryStructure per active employee, effective from joining date.
 *   - Two historical PayrollRuns (Jul-2026, Aug-2026), both Processed.
 *   - One current Draft run for Sep-2026 (no items — HR will Calculate).
 *   - Payment + LedgerTransaction rows for the two processed runs.
 *
 * Historical runs use the same calc.ts the live handler uses, so numbers are
 * internally consistent — a reviewer opening a July payslip sees a real
 * breakdown, not placeholder text.
 */

import type {
  LedgerTransaction,
  PayrollItem,
  PayrollRun,
  Payment,
  Payslip,
  SalaryStructure,
} from '@/data/models';
import { organisation, employees } from './index';
import { extraEmployees } from './extraEmployees';
import { statutoryRates } from './config';
import { calculatePayrollItem } from '@/lib/payroll/calc';
import { snapshotAt } from '@/lib/payroll/statutory';

const now = new Date().toISOString();
const audit = () => ({
  created_at: now,
  updated_at: now,
  created_by: null,
  updated_by: null,
  deleted_at: null,
});

// ── Salary structures (illustrative CTCs by type) ─────────────────────────
const CTC_BY_EMPLOYEE_TYPE: Record<string, number> = {
  partner: 3_600_000,         // ₹36L p.a.
  manager: 1_500_000,         // ₹15L
  executive: 720_000,         // ₹7.2L
  articled: 480_000,          // ₹4.8L (stipend-equivalent)
  support: 360_000,           // ₹3.6L
};

function buildStructure(employeeId: string, type: string, joining: string): SalaryStructure {
  const annualCTC = CTC_BY_EMPLOYEE_TYPE[type] ?? 480_000;
  const monthlyCTC = annualCTC / 12;
  const basic = monthlyCTC * 0.5;
  const hra = basic * 0.4;
  const conveyance = Math.min(1_600, monthlyCTC * 0.03);
  const special = monthlyCTC - basic - hra - conveyance;
  const toP = (r: number) => Math.round(r) * 100; // rupees → paise
  return {
    id: `ss-${employeeId}`,
    employee_id: employeeId,
    effective_from: joining,
    effective_to: null,
    monthly_ctc_paise: toP(monthlyCTC),
    basic_paise: toP(basic),
    hra_paise: toP(hra),
    conveyance_paise: toP(conveyance),
    special_allowance_paise: toP(special),
    custom_components: [],
    notes: null,
    ...audit(),
  };
}

const allEmployees = [...employees, ...extraEmployees];
export const salaryStructures: SalaryStructure[] = allEmployees
  .filter((e) => e.status !== 'inactive')
  .map((e) => buildStructure(e.id, e.type, e.joining_date));

// ── Two historical runs ───────────────────────────────────────────────────
function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function buildHistoricalRun(y: number, m: number): {
  run: PayrollRun;
  items: PayrollItem[];
  payments: Payment[];
  payslips: Payslip[];
  ledger: LedgerTransaction[];
} {
  const period_start = isoDate(y, m, 1);
  const period_end = isoDate(y, m, lastDayOfMonth(y, m));
  const snap = snapshotAt(period_start, statutoryRates);
  const activeEmps = allEmployees.filter((e) => e.status !== 'inactive' && e.joining_date <= period_end);
  const payable_days = new Date(Date.UTC(y, m, 0)).getUTCDate();

  const items: PayrollItem[] = [];
  const payments: Payment[] = [];
  const payslips: Payslip[] = [];
  const ledger: LedgerTransaction[] = [];
  const runId = `pr-${y}-${String(m).padStart(2, '0')}`;
  const processedAt = `${isoDate(y, m, 25)}T10:00:00.000Z`;
  let grossTotal = 0;
  let deductionsTotal = 0;
  let netTotal = 0;
  let runningLedger = 0;

  for (const emp of activeEmps) {
    const structure = salaryStructures.find((s) => s.employee_id === emp.id);
    if (!structure) continue;
    // Historical runs: assume full attendance, no LOP.
    const calc = calculatePayrollItem({
      structure,
      attendance: { payable_days, present_days: payable_days, on_leave_days: 0, absent_days: 0, lop_days: 0 },
      snap,
      periodStartMonth: m,
    });
    const item: PayrollItem = {
      id: `pi-${runId}-${emp.id}`,
      payroll_run_id: runId,
      employee_id: emp.id,
      salary_structure_id: structure.id,
      payable_days,
      present_days: payable_days,
      on_leave_days: 0,
      absent_days: 0,
      lop_days: 0,
      earnings: calc.earnings,
      deductions: calc.deductions,
      gross_paise: calc.gross_paise,
      total_deductions_paise: calc.total_deductions_paise,
      net_paise: calc.net_paise,
      notes: null,
      ...audit(),
    };
    items.push(item);
    grossTotal += calc.gross_paise;
    deductionsTotal += calc.total_deductions_paise;
    netTotal += calc.net_paise;

    // Payment (mock) — Completed.
    const payment: Payment = {
      id: `pay-${runId}-${emp.id}`,
      employee_id: emp.id,
      payroll_run_id: runId,
      expense_id: null,
      amount_paise: calc.net_paise,
      method: 'mock',
      reference: `SIM-${runId}-${emp.id}`,
      status: 'completed',
      paid_at: processedAt,
      ...audit(),
    };
    payments.push(payment);

    // Payslip.
    payslips.push({
      id: `ps-${runId}-${emp.id}`,
      payroll_run_id: runId,
      payroll_item_id: item.id,
      employee_id: emp.id,
      published_at: processedAt,
      file_key: `mock/payslips/${runId}-${emp.id}.pdf`,
      status: 'published',
      ...audit(),
    });

    // Ledger: debit Payroll expense, credit Payment.
    runningLedger -= calc.net_paise;
    ledger.push({
      id: `lt-${runId}-payroll-${emp.id}`,
      date: isoDate(y, m, 25),
      type: 'Payroll',
      description: `Salary — ${emp.full_name} (${period_start} to ${period_end})`,
      employee_id: emp.id,
      category: 'Payroll',
      debit_paise: calc.net_paise,
      credit_paise: 0,
      running_balance_paise: runningLedger,
      reference_id: item.id,
      reference_type: 'PayrollItem',
      status: 'posted',
      created_at: processedAt,
      created_by: null,
    });
  }

  const run: PayrollRun = {
    id: runId,
    organisation_id: organisation.id,
    period_start,
    period_end,
    stage: 'processed',
    is_calculating: false,
    statutory_snapshot: snap,
    headcount: items.length,
    gross_total_paise: grossTotal,
    deductions_total_paise: deductionsTotal,
    net_total_paise: netTotal,
    reviewed_by: 'usr-hr',
    approved_by: 'usr-fin',
    processed_by: 'usr-fin',
    processed_at: processedAt,
    notes: null,
    ...audit(),
  };

  return { run, items, payments, payslips, ledger };
}

// Build for Jul and Aug 2026.
const historical = [buildHistoricalRun(2026, 7), buildHistoricalRun(2026, 8)];

// One current Draft for Sep 2026 (no items yet — Calculate produces them).
const draftRun: PayrollRun = {
  id: 'pr-2026-09',
  organisation_id: organisation.id,
  period_start: '2026-09-01',
  period_end: '2026-09-30',
  stage: 'draft',
  is_calculating: false,
  statutory_snapshot: null,
  headcount: 0,
  gross_total_paise: 0,
  deductions_total_paise: 0,
  net_total_paise: 0,
  reviewed_by: null,
  approved_by: null,
  processed_by: null,
  processed_at: null,
  notes: 'Awaiting Calculate.',
  ...audit(),
};

export const payrollRuns: PayrollRun[] = [
  ...historical.map((h) => h.run),
  draftRun,
];
export const payrollItems: PayrollItem[] = historical.flatMap((h) => h.items);
export const payments: Payment[] = historical.flatMap((h) => h.payments);
export const payslips: Payslip[] = historical.flatMap((h) => h.payslips);
export const ledgerTransactions: LedgerTransaction[] = historical.flatMap((h) => h.ledger);
