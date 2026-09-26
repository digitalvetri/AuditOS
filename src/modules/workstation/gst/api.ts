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
  registration_date: string | null;
  assigned_employee_id: string | null;
  assigned_employee_name: string | null;
  reviewer_employee_id: string | null;
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

export type StageKey = 'gstr1' | 'gstr2b' | 'gstr3b';

/** A period row as seen from ONE stage, with that stage's status/due hoisted. */
export interface StageRow extends GstPeriod {
  stage_status_value: string;
  stage_due_date: string | null;
}

export interface StageQueue {
  stage: StageKey;
  return_type: string | null;
  /** Keys vary by stage — §12/§14/§19 ask for different summaries. */
  summary: Record<string, number>;
  items: StageRow[];
  count: number;
  total: number;
  page: number;
  page_size: number;
}

/** Client-dashboard row: one GSTIN, three return cells for the requested period. */
export interface ClientDashboardCell {
  state: 'done' | 'due' | 'overdue' | 'not_started';
  due_date: string | null;
  case_id: string | null;
  arn: string | null;
}
export interface ClientDashboardRow {
  client_id: string;
  gst_profile_id: string;
  name: string;
  gstin: string;
  filing_frequency: 'monthly' | 'quarterly';
  assigned_employee_id: string | null;
  reviewer_employee_id: string | null;
  gstr1: ClientDashboardCell | null;
  gstr2b: ClientDashboardCell | null;
  gstr3b: ClientDashboardCell | null;
}
export interface ClientDashboardResponse {
  period: string;
  counters: {
    total_clients: number;
    monthly: number;
    quarterly: number;
    overdue: number;
    due_soon: number;
  };
  clients: ClientDashboardRow[];
}

/** Client-view landing after clicking a dashboard row — GST-CLIENT-DASHBOARD-TASKS §2. */
export interface ClientViewCell extends ClientDashboardCell {
  filed_at: string | null;
}
export interface ClientViewResponse {
  period: string;
  client: { id: string; name: string };
  gst_profile: {
    id: string; gstin: string; legal_name: string | null; state: string | null;
    registration_type: string; filing_frequency: 'monthly' | 'quarterly';
    assigned_employee_id: string | null; reviewer_employee_id: string | null;
  };
  gstr1: ClientViewCell | null;
  gstr2b: ClientViewCell | null;
  gstr3b: ClientViewCell | null;
  earlier: { period: string; gstr1_done: boolean; gstr2b_done: boolean; gstr3b_done: boolean }[];
}

/** Response from POST /api/gst/period/seed — GST-CLIENT-DASHBOARD-TASKS §4. */
export interface SeedPeriodResponse {
  period: string;
  client_id: string;
  items: {
    kind: 'GSTR1' | 'GSTR2B' | 'GSTR3B';
    case_id: string;
    case_created: boolean;
    task_id: string;
    task_created: boolean;
  }[];
  skipped: { kind: string; reason: string }[];
}

export const gstApi = {
  stage: (stage: StageKey, f: PeriodFilters = {}) =>
    api.get<StageQueue>(`/api/gst/stages/${stage}${qs(f)}`),
  clientDashboard: (period: string) =>
    api.get<ClientDashboardResponse>(`/api/gst/client-dashboard?period=${encodeURIComponent(period)}`),
  clientView: (clientId: string, period: string) =>
    api.get<ClientViewResponse>(`/api/gst/client-view/${clientId}?period=${encodeURIComponent(period)}`),
  seedPeriod: (clientId: string, period: string) =>
    api.post<SeedPeriodResponse>('/api/gst/period/seed', { client_id: clientId, period }),
  overview: (f: Pick<PeriodFilters, 'fy' | 'period'> = {}) =>
    api.get<GstOverview>(`/api/gst/overview${qs(f)}`),
  periods: (f: PeriodFilters = {}) =>
    api.get<{ items: GstPeriod[]; count: number; total: number; page: number; page_size: number }>(
      `/api/gst/periods${qs(f)}`,
    ),
  period: (id: string) => api.get<GstPeriod & { exceptions: unknown[]; timeline: unknown[] }>(`/api/gst/periods/${id}`),
  clients: () => api.get<{ items: GstClient[]; count: number }>('/api/gst/clients'),

  // ── Writes ──────────────────────────────────────────────────────────────
  assign: (id: string, body: Record<string, string | null>) =>
    api.patch<{ ok: true }>(`/api/gst/periods/${id}/assign`, body),
  /** Advance a stage and/or record its figures. */
  updateStage: (id: string, stage: StageKey, body: Record<string, unknown>) =>
    api.post<{ ok: true }>(`/api/gst/periods/${id}/stages/${stage}`, body),
  recordPayment: (id: string, body: { payment_date: string; challan_ref?: string }) =>
    api.post<{ ok: true }>(`/api/gst/periods/${id}/payment`, body),
  /** Edit a client's GST registration details (§28). */
  updateClient: (id: string, body: Record<string, unknown>) =>
    api.patch<{ ok: true }>(`/api/gst/clients/${id}`, body),
  /** Add a client's work for one period to this section. */
  addEntry: (stage: StageKey, body: Record<string, unknown>) =>
    api.post<{ id: string; period: string; financial_year: string }>(
      `/api/gst/stages/${stage}/entries`, body,
    ),
};

export const REGISTRATION_TYPES = [
  { value: 'regular', label: 'Regular' },
  { value: 'composition', label: 'Composition' },
  { value: 'casual', label: 'Casual taxable person' },
  { value: 'isd', label: 'Input Service Distributor' },
  { value: 'sez', label: 'SEZ unit / developer' },
  { value: 'non_resident', label: 'Non-resident taxable person' },
];

export const REGISTRATION_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'not_registered', label: 'Not registered' },
];

export const FILING_FREQUENCIES = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly (QRMP)' },
];

/** The last 18 months, newest first — the periods a firm actually files for. */
export function recentPeriods(count = 18): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const v = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    out.push({ value: v, label: periodLabel(v) });
  }
  return out;
}

/** The moves offered for each stage, in workflow order (§13/§15/§20). */
export const STAGE_STATUSES: Record<StageKey, { value: string; label: string }[]> = {
  gstr1: [
    { value: 'pending', label: 'Pending' },
    { value: 'data_collection', label: 'Data collection' },
    { value: 'in_preparation', label: 'In preparation' },
    { value: 'under_review', label: 'Under review' },
    { value: 'ready_to_file', label: 'Ready for filing' },
    { value: 'filed', label: 'Filed — manually recorded' },
    { value: 'rework_required', label: 'Rework required' },
  ],
  gstr2b: [
    { value: 'expected', label: 'Expected' },
    { value: 'available', label: 'Available' },
    { value: 'downloaded', label: 'Downloaded' },
    { value: 'reconciliation_pending', label: 'Reconciliation pending' },
    { value: 'reconciliation_in_progress', label: 'Reconciliation in progress' },
    { value: 'reconciliation_completed', label: 'Reconciliation completed' },
    { value: 'exceptions_found', label: 'Exceptions found' },
  ],
  gstr3b: [
    { value: 'pending', label: 'Pending' },
    { value: 'preparation', label: 'Preparation' },
    { value: 'under_review', label: 'Under review' },
    { value: 'ready_to_file', label: 'Ready for filing' },
    { value: 'filed', label: 'Filed — manually recorded' },
    { value: 'payment_pending', label: 'Payment pending' },
    { value: 'completed', label: 'Completed' },
    { value: 'rework_required', label: 'Rework required' },
  ],
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

/**
 * The message to show when a write is refused.
 *
 * `fieldErrors()` only returns the per-FIELD map from `details`; the GST
 * guards (duplicate period, an illegal status move, a missing ARN) answer
 * with a plain message and no details, which rendered as silence. This reads
 * the message so a refusal is always visible.
 */
export function errorMessage(e: unknown): string {
  const m = (e as { message?: unknown } | undefined)?.message;
  return typeof m === 'string' && m ? m : 'Could not save this. Please try again.';
}
