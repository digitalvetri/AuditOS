import { api, type ApiError } from '@/services/api';

/**
 * GST reconciliation API client. Same envelope as services/api.ts.
 * Multipart uploads go through XHR for progress reporting.
 */

export type ItcClassification = 'eligible' | 'ineligible' | 'reversal' | 'blocked';
export type MatchStatus = 'matched' | 'partial' | 'only_2b' | 'only_pr';

export interface Filing2BSummary {
  id: string;
  period_month: number;
  period_year: number;
  source_format: 'json' | 'excel';
  original_filename: string;
  gstin: string | null;
  generated_at: string | null;
  entry_count: number;
  created_at: string;
}

export interface RegisterSummary {
  id: string;
  period_month: number;
  period_year: number;
  source_format: 'excel' | 'tally_xml';
  original_filename: string;
  entry_count: number;
  created_at: string;
}

export interface RegisterPreview {
  sheetName: string;
  columns: string[];
  headerRow: string[];
  rows: string[][];
}

export interface ColumnMap {
  supplierGstin: string;
  supplierName?: string;
  invoiceNumber: string;
  invoiceDate: string;
  taxableValue: string;
  igst?: string;
  cgst?: string;
  sgst?: string;
  cess?: string;
  glCode?: string;
  dataStartRow?: number;
}

export interface ReconTotalsBucket {
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  count: number;
}

export interface ReconJob {
  id: string;
  client_id: string;
  filing_2b_id: string;
  purchase_register_id: string;
  status: 'queued' | 'matching' | 'matched' | 'failed';
  progress: number;
  matched_count: number;
  partial_count: number;
  only_2b_count: number;
  only_pr_count: number;
  totals: Record<MatchStatus, ReconTotalsBucket> | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface ReconRowEntry {
  id: string;
  supplier_gstin: string;
  supplier_name: string | null;
  invoice_number: string;
  invoice_date: string;
  taxable_value: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  itc_available?: boolean;
  gl_code?: string | null;
  section?: string;
}

export interface ReconRow {
  id: string;
  match_status: MatchStatus;
  mismatch_fields: string[];
  itc_classification: ItcClassification;
  auditor_note: string | null;
  reviewed_at: string | null;
  filing_2b_entry: ReconRowEntry | null;
  purchase_register_entry: ReconRowEntry | null;
}

export interface ReconRowsPage {
  total: number;
  items: ReconRow[];
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

export const gstApi = {
  // GSTR-2B
  upload2B: (input: { clientId: string; periodMonth: number; periodYear: number; file: File }, onProgress?: (pct: number) => void) => {
    const form = new FormData();
    form.append('client_id', input.clientId);
    form.append('period_month', String(input.periodMonth));
    form.append('period_year', String(input.periodYear));
    form.append('file', input.file, input.file.name);
    return upload<{ filing_id: string; source_format: 'json' | 'excel'; entry_count: number; gstin: string | null; generated_at: string | null }>(
      '/api/audit-automation/gst/2b/uploads', form, onProgress,
    );
  },
  list2B: (clientId: string) => api.get<{ items: Filing2BSummary[] }>(`/api/audit-automation/gst/2b${qs({ client_id: clientId })}`),

  // Purchase Register (2-step for Excel)
  uploadPR: (input: {
    clientId: string; periodMonth: number; periodYear: number; file: File;
    columnMap?: ColumnMap;
  }, onProgress?: (pct: number) => void) => {
    const form = new FormData();
    form.append('client_id', input.clientId);
    form.append('period_month', String(input.periodMonth));
    form.append('period_year', String(input.periodYear));
    if (input.columnMap) form.append('column_map', JSON.stringify(input.columnMap));
    form.append('file', input.file, input.file.name);
    return upload<{
      register_id: string | null;
      source_format: 'excel' | 'tally_xml';
      preview?: RegisterPreview;
      entry_count?: number;
    }>('/api/audit-automation/gst/purchase-registers/uploads', form, onProgress);
  },
  listPR: (clientId: string) => api.get<{ items: RegisterSummary[] }>(`/api/audit-automation/gst/purchase-registers${qs({ client_id: clientId })}`),

  // Recon jobs
  createRecon: (input: { client_id: string; filing_2b_id: string; purchase_register_id: string }) =>
    api.post<ReconJob>('/api/audit-automation/gst/recon', input),
  listRecon: (clientId: string) => api.get<{ items: ReconJob[] }>(`/api/audit-automation/gst/recon${qs({ client_id: clientId })}`),
  getRecon: (id: string) => api.get<ReconJob>(`/api/audit-automation/gst/recon/${id}`),
  getReconRows: (id: string, filter: { status?: MatchStatus; limit?: number; offset?: number } = {}) =>
    api.get<ReconRowsPage>(`/api/audit-automation/gst/recon/${id}/rows${qs({ ...filter })}`),
  updateRow: (rowId: string, patch: { itc_classification?: ItcClassification; auditor_note?: string | null }) =>
    api.patch<{ id: string; itc_classification: ItcClassification; auditor_note: string | null }>(
      `/api/audit-automation/gst/recon/rows/${rowId}`, patch,
    ),
  exportUrl: (id: string) => `/api/audit-automation/gst/recon/${id}/export.xlsx`,
};
