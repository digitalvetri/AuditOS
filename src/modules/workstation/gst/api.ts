import { api } from '@/services/api';

/**
 * GST compliance API client — Workstation → Services → Registration → GST.
 *
 * Every number here is computed by the server: overall status, days
 * remaining and the due-date wording are all sent down ready to render, so
 * two screens can never disagree about whether something is overdue.
 */

export type OverallStatus = 'not_started' | 'in_progress' | 'completed' | 'overdue' | 'exception';

export interface StageStatus {
  gstr1: string;
  gstr2b: string;
  reconciliation: string;
  gstr3b: string;
}

export interface GstFilingView {
  status: string;
  due_date: string | null;
  arn: string | null;
  filed_at: string | null;
  /** §31 — recorded by an employee, never transmitted by Audit OS. */
  filed_manually: boolean;
  taxable_value: number | null;
  tax_amount: number | null;
  tax_liability: number | null;
  eligible_itc: number | null;
  net_payable: number | null;
  payment_status: string;
}

export interface GstPeriod {
  id: string;
  financial_year: string;
  period: string;
  period_type: string;
  client_id: string | null;
  client_name: string | null;
  gstin: string;
  registration_type: string;
  filing_frequency: string;
  assigned_employee_id: string | null;
  assigned_employee_name: string | null;
  reviewer_employee_id: string | null;
  reviewer_employee_name: string | null;
  gstr1: GstFilingView | null;
  gstr2b: { status: string; available_date: string | null; total_itc: number | null };
  reconciliation: {
    status: string; matched_count: number; mismatch_count: number;
    books_itc: number | null; two_b_itc: number | null; itc_difference: number | null;
  };
  gstr3b: GstFilingView | null;
  stage_status: StageStatus;
  open_exceptions: number;
  overall_status: OverallStatus;
  next_due_date: string | null;
  days_remaining: number | null;
  due_label: string | null;
}

export interface GstOverview {
  total_clients: number;
  total_periods: number;
  gstr1: { filed: number; pending: number; overdue: number };
  gstr2b: { available: number; pending: number; reconciliation_pending: number; reconciled: number };
  gstr3b: { filed: number; pending: number; payment_pending: number; overdue: number };
  due_today: number; due_soon: number; overdue: number;
  completed: number; in_progress: number; not_started: number; exceptions: number;
}

export interface GstClient {
  id: string;
  client_id: string | null;
  client_name: string | null;
  legal_name: string | null;
  gstin: string;
  pan: string | null;
  state: string | null;
  registration_type: string;
  registration_status: string;
  filing_frequency: string;
  assigned_employee_name: string | null;
  reviewer_employee_name: string | null;
  active: boolean;
  period_count: number;
}

export interface PeriodFilters {
  fy?: string; period?: string; client_id?: string; gstin?: string;
  employee_id?: string; reviewer_id?: string; status?: string; due?: string;
  q?: string; page?: number; page_size?: number;
}

const qs = (f: PeriodFilters) => {
  const p = new URLSearchParams();
  Object.entries(f).forEach(([k, v]) => { if (v !== undefined && v !== '') p.set(k, String(v)); });
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const gstApi = {
  overview: (f: Pick<PeriodFilters, 'fy' | 'period'> = {}) =>
    api.get<GstOverview>(`/api/gst/overview${qs(f)}`),
  periods: (f: PeriodFilters = {}) =>
    api.get<{ items: GstPeriod[]; count: number; total: number; page: number; page_size: number }>(
      `/api/gst/periods${qs(f)}`,
    ),
  period: (id: string) => api.get<GstPeriod & { exceptions: unknown[]; timeline: unknown[] }>(`/api/gst/periods/${id}`),
  clients: () => api.get<{ items: GstClient[]; count: number }>('/api/gst/clients'),
};

/** Paise → ₹ display. GST figures are held as integer paise end to end. */
export function rupees(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '—';
  return '₹' + (paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** 'YYYY-MM' → 'September 2026'. */
export function periodLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1))
    .toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
