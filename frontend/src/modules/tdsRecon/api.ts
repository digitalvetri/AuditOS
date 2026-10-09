/**
 * 26AS vs books reconciliation — `/api/tds-recon`.
 *
 * Contract (the README leaves it open; this is what the page calls):
 *   GET   /api/tds-recon/jobs?client_id=&financial_year=   → jobs, newest first
 *   POST  /api/tds-recon/jobs  multipart { client_id, financial_year,
 *           file_26as, file_books, tolerance_paise? }       → job (run synchronously)
 *   GET   /api/tds-recon/jobs/:id                           → { job, rows }
 *   PATCH /api/tds-recon/rows/:id { auditor_note?, action_status? }
 *   GET   /api/tds-recon/jobs/:id/export?format=xlsx|csv    → file download
 *
 * Built on AaTds26AS / AaTdsBooks / AaTdsReconJob / AaTdsReconRow.
 */
import { api } from '@/services/api';
import { asList, qs, type Paise } from '@/modules/compliance/api';

export type MatchStatus = 'verified' | 'variance' | 'only_26as' | 'only_books';

export interface ReconTotals { count?: number; amount_paid_paise?: Paise; tds_paise?: Paise; tds_amount_paise?: Paise }

export interface ReconJob {
  id: string;
  client_id: string;
  client_name?: string | null;
  financial_year?: string | null;
  assessment_year?: number | string | null;
  status: string;
  verified_count?: number;
  variance_count?: number;
  only_26as_count?: number;
  only_books_count?: number;
  flags?: string | string[] | null;
  totals?: Partial<Record<MatchStatus, ReconTotals>> | null;
  error_message?: string | null;
  file_26as_name?: string | null;
  books_file_name?: string | null;
  created_at?: string;
  completed_at?: string | null;
}

export interface ReconSide {
  amount_paid_paise?: Paise;
  tds_paise?: Paise;
  tds_amount_paise?: Paise;
  date?: string | null;
  tds_date?: string | null;
  reference?: string | null;
  status?: string | null;
}

export interface ReconRow {
  id: string;
  match_status: MatchStatus;
  deductor_tan?: string | null;
  deductor_name?: string | null;
  section?: string | null;
  quarter?: string | null;
  as26?: ReconSide | null;
  books?: ReconSide | null;
  difference_paise?: Paise;
  mismatch_fields?: string | string[] | null;
  flags?: string | string[] | null;
  action_status?: string | null;
  auditor_note?: string | null;
}

export const ACTION_STATUSES = [
  { value: 'no_action', label: 'No action' },
  { value: 'chase_deductor', label: 'Chase deductor' },
  { value: 'revise_book', label: 'Revise books' },
  { value: 'credit_claimed', label: 'Credit claimed' },
  { value: 'written_off', label: 'Written off' },
];

export const tdsReconKeys = {
  jobs: (clientId: string, fy: string) => ['tds-recon', 'jobs', clientId, fy] as const,
  job: (id: string) => ['tds-recon', 'job', id] as const,
};

export const tdsReconApi = {
  jobs: async (clientId: string, fy: string) =>
    asList(await api.get<ReconJob[] | { items: ReconJob[] }>(`/api/tds-recon/jobs${qs({ client_id: clientId, financial_year: fy })}`)),
  job: async (id: string) => {
    const r = await api.get<{ job: ReconJob; rows?: ReconRow[] | { items: ReconRow[] } } | (ReconJob & { rows?: ReconRow[] })>(`/api/tds-recon/jobs/${id}`);
    const out = 'job' in r && r.job ? { job: r.job, rows: asList(r.rows) } : { job: r as ReconJob, rows: (r as ReconJob & { rows?: ReconRow[] }).rows ?? [] };
    out.rows = out.rows.map((row) => ({ ...row, match_status: normStatus(row.match_status ?? (row as { status?: string }).status) }));
    return out;
  },
  run: (form: FormData) => api.postForm<ReconJob | { job: ReconJob }>('/api/tds-recon/jobs', form),
  patchRow: (id: string, body: { auditor_note?: string | null; action_status?: string }) =>
    api.patch<ReconRow>(`/api/tds-recon/rows/${id}`, body),
  exportUrl: (id: string, format: 'xlsx' | 'csv') => `/api/tds-recon/jobs/${id}/export?format=${format}`,
};

/** The schema names (verified …) and the contract names (matched, difference, 26as_only, books_only) both map here. */
const STATUS_ALIAS: Record<string, MatchStatus> = {
  verified: 'verified', matched: 'verified', variance: 'variance', difference: 'variance',
  only_26as: 'only_26as', '26as_only': 'only_26as', only_books: 'only_books', books_only: 'only_books',
};
export const normStatus = (s: string | null | undefined): MatchStatus => STATUS_ALIAS[s ?? ''] ?? 'variance';

/** Accept either spelling for TDS paise on a side. */
export const sideTds = (s: ReconSide | null | undefined): Paise => s?.tds_paise ?? s?.tds_amount_paise ?? null;
export const listFrom = (v: string | string[] | null | undefined): string[] =>
  Array.isArray(v) ? v : (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
