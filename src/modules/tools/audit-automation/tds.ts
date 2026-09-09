import { api, type ApiError } from '@/services/api';

/** TDS reconciliation API client — mirror of gst.ts. */

export type TdsMatchStatus = 'verified' | 'variance' | 'only_26as' | 'only_books';
export type TdsActionStatus = 'no_action' | 'chase_deductor' | 'revise_book' | 'credit_claimed' | 'written_off';

export interface Filing26ASSummary {
  id: string;
  pan: string | null;
  assessment_year: number;
  source_format: 'text' | 'excel';
  original_filename: string;
  entry_count: number;
  generated_at: string | null;
  created_at: string;
}

export interface TdsBooksSummary {
  id: string;
  assessment_year: number;
  source_format: 'excel' | 'tally_xml';
  original_filename: string;
  entry_count: number;
  created_at: string;
}

export interface TdsBooksPreview {
  sheetName: string;
  columns: string[];
  headerRow: string[];
  rows: string[][];
}

export interface TdsBooksColumnMap {
  deductorTan: string;
  deductorName?: string;
  section: string;
  quarter?: string;
  amountPaid: string;
  tdsAmount: string;
  tdsDate: string;
  glCode?: string;
  dataStartRow?: number;
}

export interface TdsReconTotalsBucket {
  amount_paid: number;
  tds_amount: number;
  count: number;
}

export interface TdsReconJob {
  id: string;
  client_id: string;
  filing_26as_id: string;
  books_id: string;
  status: 'queued' | 'matching' | 'matched' | 'failed';
  progress: number;
  verified_count: number;
  variance_count: number;
  only_26as_count: number;
  only_books_count: number;
  totals: Record<TdsMatchStatus, TdsReconTotalsBucket> | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface TdsReconRowEntry {
  id: string;
  part?: string;
  section: string;
  deductor_tan: string;
  deductor_name: string | null;
  quarter: string;
  amount_paid: number;
  tds_amount: number;
  tds_date: string;
  status?: string | null;
  gl_code?: string | null;
}

export interface TdsReconRow {
  id: string;
  match_status: TdsMatchStatus;
  mismatch_fields: string[];
  action_status: TdsActionStatus;
  auditor_note: string | null;
  reviewed_at: string | null;
  filing_26as_entry: TdsReconRowEntry | null;
  books_entry: TdsReconRowEntry | null;
}

export interface TdsReconRowsPage {
  total: number;
  items: TdsReconRow[];
}

function makeError(status: number, code: string, message: string, details?: unknown): ApiError {
  const err = new Error(message) as ApiError;
  err.status = status;
  err.code = code;
  err.details = details;
  return err;
}

function upload<T>(url: string, form: FormData, onProgress?: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let json: { data?: T; error?: { code: string; message: string; details?: unknown } } = {};
      try { json = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch { /* empty */ }
      if (xhr.status >= 200 && xhr.status < 300 && json.data) return resolve(json.data);
      const e = json.error ?? { code: 'unknown', message: 'Upload failed.' };
      reject(makeError(xhr.status, e.code, e.message, e.details));
    };
    xhr.onerror = () => reject(makeError(0, 'network', 'Upload failed.'));
    xhr.send(form);
  });
}

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const tdsApi = {
  upload26AS: (input: { clientId: string; assessmentYear: number; file: File }, onProgress?: (pct: number) => void) => {
    const form = new FormData();
    form.append('client_id', input.clientId);
    form.append('assessment_year', String(input.assessmentYear));
    form.append('file', input.file, input.file.name);
    return upload<{ filing_id: string; source_format: 'text' | 'excel'; entry_count: number; pan: string | null; generated_at: string | null }>(
      '/api/audit-automation/tds/26as/uploads', form, onProgress,
    );
  },
  list26AS: (clientId: string) => api.get<{ items: Filing26ASSummary[] }>(`/api/audit-automation/tds/26as${qs({ client_id: clientId })}`),

  uploadBooks: (input: {
    clientId: string; assessmentYear: number; file: File;
    columnMap?: TdsBooksColumnMap;
  }, onProgress?: (pct: number) => void) => {
    const form = new FormData();
    form.append('client_id', input.clientId);
    form.append('assessment_year', String(input.assessmentYear));
    if (input.columnMap) form.append('column_map', JSON.stringify(input.columnMap));
    form.append('file', input.file, input.file.name);
    return upload<{
      books_id: string | null;
      source_format: 'excel' | 'tally_xml';
      preview?: TdsBooksPreview;
      entry_count?: number;
    }>('/api/audit-automation/tds/books/uploads', form, onProgress);
  },
  listBooks: (clientId: string) => api.get<{ items: TdsBooksSummary[] }>(`/api/audit-automation/tds/books${qs({ client_id: clientId })}`),

  createRecon: (input: { client_id: string; filing_26as_id: string; books_id: string }) =>
    api.post<TdsReconJob>('/api/audit-automation/tds/recon', input),
  listRecon: (clientId: string) => api.get<{ items: TdsReconJob[] }>(`/api/audit-automation/tds/recon${qs({ client_id: clientId })}`),
  getRecon: (id: string) => api.get<TdsReconJob>(`/api/audit-automation/tds/recon/${id}`),
  getReconRows: (id: string, filter: { status?: TdsMatchStatus; limit?: number; offset?: number } = {}) =>
    api.get<TdsReconRowsPage>(`/api/audit-automation/tds/recon/${id}/rows${qs({ ...filter })}`),
  updateRow: (rowId: string, patch: { action_status?: TdsActionStatus; auditor_note?: string | null }) =>
    api.patch<{ id: string; action_status: TdsActionStatus; auditor_note: string | null }>(
      `/api/audit-automation/tds/recon/rows/${rowId}`, patch,
    ),
  exportUrl: (id: string) => `/api/audit-automation/tds/recon/${id}/export.xlsx`,
};
