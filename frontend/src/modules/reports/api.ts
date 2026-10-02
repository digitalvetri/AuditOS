import { api } from '@/services/api';

export type ReportType = 'attendance' | 'leave' | 'payroll' | 'expenses';

interface BaseReport {
  type: ReportType;
  generated_at: string;
  scope: 'self' | 'department' | 'organisation';
}

export interface AttendanceReportRow {
  employee_id: string;
  employee_code: string;
  full_name: string;
  department_id: string;
  days_recorded: number;
  present: number;
  late: number;
  half_day: number;
  wfh: number;
  absent: number;
  on_leave: number;
  missing_check_out: number;
  off_site_days: number;
  hours: number;
}

export interface LeaveByTypeRow {
  type_code: string;
  type_name: string;
  entitled: number;
  availed: number;
  pending: number;
  available: number;
}
export interface LeaveReportRow {
  employee_id: string;
  employee_code: string;
  full_name: string;
  department_id: string;
  by_type: LeaveByTypeRow[];
}

export interface PayrollReportRow {
  employee_id: string;
  employee_code: string;
  full_name: string;
  department_id: string;
  payable_days: number;
  lop_days: number;
  basic_paise: number;
  hra_paise: number;
  gross_paise: number;
  pf_paise: number;
  esi_paise: number;
  pt_paise: number;
  tds_paise: number;
  lop_paise: number;
  total_deductions_paise: number;
  net_paise: number;
}

export interface ExpenseReportRow {
  employee_id: string;
  employee_code: string;
  full_name: string;
  department_id: string;
  count: number;
  drafts: number;
  claimed_paise: number;
  reimbursed_paise: number;
}
export interface ExpenseByCategoryRow {
  category_id: string;
  category_code: string;
  category_name: string;
  count: number;
  reimbursed_paise: number;
}

export interface AttendanceReport extends BaseReport {
  type: 'attendance';
  items: AttendanceReportRow[];
}
export interface LeaveReport extends BaseReport {
  type: 'leave';
  items: LeaveReportRow[];
}
export interface PayrollReport extends BaseReport {
  type: 'payroll';
  run: { id: string; period_start: string; period_end: string; stage: string };
  items: PayrollReportRow[];
  totals: { gross_paise: number; deductions_paise: number; net_paise: number };
}
export interface ExpenseReport extends BaseReport {
  type: 'expenses';
  items: ExpenseReportRow[];
  by_category: ExpenseByCategoryRow[];
  totals: { expense_count: number; claimed_paise: number; reimbursed_paise: number };
}

export const reportsApi = {
  attendance: (filters: { from?: string; to?: string; departmentId?: string; employeeId?: string }) =>
    fetchReport<AttendanceReport>('attendance', filters),
  leave: (filters: { departmentId?: string; employeeId?: string }) =>
    fetchReport<LeaveReport>('leave', filters),
  payroll: (filters: { runId?: string; departmentId?: string }) =>
    fetchReport<PayrollReport>('payroll', filters),
  expenses: (filters: { from?: string; to?: string; departmentId?: string; employeeId?: string }) =>
    fetchReport<ExpenseReport>('expenses', filters),
};

function fetchReport<T>(type: ReportType, filters: Record<string, string | undefined>): Promise<T> {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const qs = p.toString();
  return api.get<T>(`/api/reports/${type}${qs ? `?${qs}` : ''}`);
}
