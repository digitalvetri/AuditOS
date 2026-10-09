/**
 * Compliance calendar API — `/api/compliance` (docs/compliance/README.md).
 *
 * Responses are read defensively: a list may come back bare (`T[]`) or in
 * the Workstation envelope (`{ items, count }`), and paise may be a number or
 * a BigInt-as-string. `asList` / `toPaise` absorb both.
 */
import { api } from '@/services/api';

// ── Shared helpers ───────────────────────────────────────────────────────

export type Paise = number | string | null | undefined;

/** Paise as a number (BigInt columns may arrive as strings). */
export function toPaise(v: Paise): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Rupees typed into an input → integer paise. Blank → null. */
export function rupeesToPaise(v: string): number | null {
  const t = v.replace(/[,₹\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function paiseToRupeesInput(v: Paise): string {
  const p = toPaise(v);
  return p === null ? '' : String(p / 100);
}

export function asList<T>(r: T[] | { items?: T[] } | null | undefined): T[] {
  if (!r) return [];
  if (Array.isArray(r)) return r;
  return r.items ?? [];
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    p.set(k, v === true ? '1' : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ── Types ────────────────────────────────────────────────────────────────

export type Authority = 'income_tax' | 'gst' | 'mca' | 'labour' | 'tds' | 'other';

export const AUTHORITY_LABEL: Record<string, string> = {
  income_tax: 'Income tax',
  gst: 'GST',
  mca: 'MCA',
  labour: 'Labour',
  tds: 'TDS',
  other: 'Other',
};

export type ItemStatus = 'not_started' | 'documents_pending' | 'in_progress' | 'filed' | 'not_applicable';

export const ITEM_STATUSES: { value: ItemStatus; label: string }[] = [
  { value: 'not_started', label: 'Not started' },
  { value: 'documents_pending', label: 'Documents pending' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'filed', label: 'Filed' },
  { value: 'not_applicable', label: 'Not applicable' },
];

export interface ComplianceForm {
  code: string;
  name: string;
  authority: string;
  frequency: string;
  entity_types: string | string[];
  anchor: string;
  offset_months?: number;
  due_day?: number | null;
  offset_days?: number;
  months?: string | null;
  late_fee_note?: string | null;
  description?: string | null;
  source_url?: string | null;
  is_active?: boolean;
}

export interface Extension {
  id: string;
  form_code: string;
  form_name?: string | null;
  period_key: string;
  new_due_date: string;
  reference: string;
  source_url?: string | null;
  entity_types?: string | string[] | null;
  created_at?: string;
}

export interface LateFeeEstimate {
  amount_paise?: Paise;
  note?: string | null;
}

export interface ComplianceItem {
  id: string;
  /** 'compliance' for calendar rows; GST / TDS rows are merged in read-only. */
  source?: 'compliance' | 'gst' | 'tds' | string;
  read_only?: boolean;
  client_id: string;
  client_name?: string | null;
  /** 'CLI-1001' */
  client_code?: string | null;
  form_code: string;
  form_name?: string | null;
  authority?: string | null;
  period_key: string;
  period_label?: string | null;
  statutory_due_date: string;
  due_date: string;
  extension?: (Partial<Extension> & { reference?: string | null }) | null;
  anchor_date?: string | null;
  /** True for AGM-anchored rows whose AGM date has not been entered. */
  anchor_missing?: boolean;
  status: string;
  assigned_employee_id?: string | null;
  assigned_employee_name?: string | null;
  filed_on?: string | null;
  acknowledgement_no?: string | null;
  late_fee_paid_paise?: Paise;
  notes?: string | null;
  days_left?: number | null;
  overdue?: boolean;
  late_fee_estimate?: LateFeeEstimate | null;
  /** Merged GST / TDS rows: the page that owns them. */
  link?: string | null;
}

export interface ItemFilters {
  from?: string;
  to?: string;
  client_id?: string;
  form_code?: string;
  authority?: string;
  status?: string;
  assigned_to?: string;
  mine?: boolean;
  overdue?: boolean;
  /** 'gst,tds' */
  include?: string;
}

export interface ItemPatch {
  status?: string;
  assigned_employee_id?: string | null;
  filed_on?: string | null;
  acknowledgement_no?: string | null;
  anchor_date?: string | null;
  late_fee_paid_paise?: number | null;
  notes?: string | null;
}

export interface BulkResult {
  id?: string;
  row?: number;
  client_code?: string;
  form_code?: string;
  period_key?: string;
  ok: boolean;
  error?: string | null;
  message?: string | null;
}

export interface Obligation {
  id?: string;
  form_code: string;
  form_name?: string | null;
  authority?: string | null;
  frequency?: string | null;
  assigned_employee_id?: string | null;
  remind_client?: boolean;
  is_active?: boolean;
}

export interface ObligationsResponse {
  client?: { id: string; name?: string; entity_type?: string | null; business_type?: string | null };
  entity_type?: string | null;
  obligations?: Obligation[];
  items?: Obligation[];
  /** Form codes (or forms) suggested for the client's entity type. */
  suggested?: (string | { code?: string; form_code?: string })[];
}

export interface SummaryBucket { overdue?: number; due_7?: number; due_30?: number }
export interface ComplianceSummary extends SummaryBucket {
  /** Alternate spellings the backend may use. */
  due_in_7_days?: number;
  due_in_30_days?: number;
  by_authority?: Record<string, SummaryBucket>;
  mine?: SummaryBucket & { due_in_7_days?: number; due_in_30_days?: number };
}

// ── Calls ────────────────────────────────────────────────────────────────

export const complianceKeys = {
  all: ['compliance'] as const,
  forms: ['compliance', 'forms'] as const,
  items: (f: ItemFilters) => ['compliance', 'items', f] as const,
  obligations: (clientId: string) => ['compliance', 'obligations', clientId] as const,
  extensions: ['compliance', 'extensions'] as const,
  summary: ['compliance', 'summary'] as const,
};

export const complianceApi = {
  forms: async () => asList(await api.get<ComplianceForm[] | { items: ComplianceForm[] }>('/api/compliance/forms')),
  items: async (f: ItemFilters) =>
    asList(await api.get<ComplianceItem[] | { items: ComplianceItem[] }>(`/api/compliance/items${qs({ ...f })}`)),
  patchItem: (id: string, patch: ItemPatch) => api.patch<ComplianceItem>(`/api/compliance/items/${id}`, patch),
  bulk: (body: { ids: string[]; status?: string; assigned_employee_id?: string | null; filed_on?: string }) =>
    api.post<{ results?: BulkResult[]; updated?: number }>('/api/compliance/items/bulk', body),
  importCsv: (csv: string) =>
    api.post<{ results?: BulkResult[]; updated?: number }>('/api/compliance/items/bulk', { csv }),
  obligations: (clientId: string) => api.get<ObligationsResponse>(`/api/compliance/clients/${clientId}/obligations`),
  saveObligations: (clientId: string, forms: { form_code: string; assigned_employee_id?: string | null; remind_client?: boolean }[]) =>
    api.put<ObligationsResponse>(`/api/compliance/clients/${clientId}/obligations`, { forms }),
  extensions: async () => asList(await api.get<Extension[] | { items: Extension[] }>('/api/compliance/extensions')),
  addExtension: (body: {
    form_code: string; period_key: string; new_due_date: string; reference: string;
    source_url?: string; entity_types?: string[];
  }) => api.post<Extension>('/api/compliance/extensions', body),
  deleteExtension: (id: string) => api.delete<void>(`/api/compliance/extensions/${id}`),
  summary: () => api.get<ComplianceSummary>('/api/compliance/summary'),
};

export const CSV_TEMPLATE_HEADER = 'client_code,form_code,period_key,acknowledgement_no,filed_on';
