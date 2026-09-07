/**
 * Typed dashboard service. All figures in this file, none in components.
 * Swapping to a real API means changing this file only.
 *
 * Latency simulated at 200–400ms per §8 of the prompt.
 */
export type TodayStatus =
  | 'not_checked_in'
  | 'checked_in'
  | 'checked_out'
  | 'on_leave'
  | 'weekly_off';

export interface UserSummary {
  name: string;
  role: 'md' | 'hr_admin' | 'finance_admin' | 'dept_manager' | 'employee';
}

export interface TodayState {
  status: TodayStatus;
  check_in_at?: string | null;
  check_out_at?: string | null;
  worked_minutes?: number | null;
  leave_type?: string | null;
}

export interface AttendanceCounts {
  total: number;
  present: number;
  late: number;
  absent: number;
  onLeave: number;
  missingCheckout: number;
}

export interface ExpensesSnapshot {
  awaitingApproval: number;
  approvedUnspent: number;
  approvedAmount: number; // rupees
}

export interface LedgerSnapshot {
  balance: number;        // rupees
  monthDebit: number;     // rupees
  monthCredit: number;    // rupees
}

export interface DepartmentRow {
  id: string;
  name: string;
  headcount: number;
  present: number;
  absent: number;
}

export interface PayrollSnapshot {
  period: string;         // 'September 2026'
  stage: string;          // 'Draft' | 'HR Review' | etc.
  employees: number;
  grossTotal: number;     // rupees
}

export interface DashboardData {
  user: UserSummary;
  today: TodayState;
  attendance: AttendanceCounts;
  expenses: ExpensesSnapshot;
  ledger: LedgerSnapshot;
  departments: DepartmentRow[];
  payroll: PayrollSnapshot;
}

/**
 * The mock payload from §8 of the prompt — matches the reference screenshot.
 * 6 employees / 6 absent is the seed being thin, not a UI bug.
 */
const MOCK: DashboardData = {
  user: { name: 'Ravi Krishnan', role: 'md' },
  today: { status: 'not_checked_in' },
  attendance: {
    total: 6, present: 0, late: 0, absent: 6, onLeave: 0, missingCheckout: 0,
  },
  expenses: { awaitingApproval: 2, approvedUnspent: 2, approvedAmount: 12340 },
  ledger: { balance: 1645520, monthDebit: 0, monthCredit: 0 },
  departments: [
    { id: 'dep-mgmt', name: 'Management', headcount: 1, present: 0, absent: 1 },
    { id: 'dep-hr',   name: 'HR',         headcount: 1, present: 0, absent: 1 },
    { id: 'dep-fin',  name: 'Finance',    headcount: 1, present: 0, absent: 1 },
    { id: 'dep-ops',  name: 'Operations', headcount: 3, present: 0, absent: 3 },
  ],
  payroll: {
    period: 'September 2026',
    stage: 'Draft',
    employees: 6,
    grossTotal: 0,
  },
};

/** 200–400ms simulated latency (deterministic-ish via Math.random). */
function latency(): Promise<void> {
  const ms = 200 + Math.floor(Math.random() * 200);
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchDashboard(): Promise<DashboardData> {
  await latency();
  return MOCK;
}

export async function checkIn(): Promise<TodayState> {
  await latency();
  const now = new Date().toISOString();
  MOCK.today = { status: 'checked_in', check_in_at: now, worked_minutes: 0 };
  return MOCK.today;
}

export async function checkOut(): Promise<TodayState> {
  await latency();
  const now = new Date().toISOString();
  const checkedInAt = MOCK.today.check_in_at ? new Date(MOCK.today.check_in_at) : new Date();
  const workedMinutes = Math.max(1, Math.round((Date.now() - checkedInAt.getTime()) / 60_000));
  MOCK.today = { status: 'checked_out', check_in_at: MOCK.today.check_in_at, check_out_at: now, worked_minutes: workedMinutes };
  return MOCK.today;
}
