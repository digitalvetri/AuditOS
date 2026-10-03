import { api, type ApiError } from '@/services/api';

/**
 * Audit Automation API client. JSON calls go through the shared adapter
 * in services/api.ts. Uploads are multipart with an optional password
 * field — an XHR is used so the password rides in the same form as the
 * file (the server destructures the password out before persisting).
 */

export interface AaBank {
  id: string;
  key: string;
  name: string;
  order: number;
}

export interface AaAccount {
  id: string;
  client_id: string;
  bank_id: string;
  account_number_masked: string;
  label: string | null;
  currency: string;
}

export type AaJobStatus = 'queued' | 'extracting' | 'extracted' | 'failed';

export interface AaJob {
  id: string;
  source_document_id: string;
  client_id: string;
  status: AaJobStatus;
  progress: number;
  flags: string[];
  error_message: string | null;
  meta: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  fy: string | null;
  period_from: string | null;
  period_to: string | null;
  opening_balance_paise: number | null;
  closing_balance_paise: number | null;
  row_count: number;
  review_status: 'pending' | 'approved';
  approved_at: string | null;
  bank_ledger_name: string | null;
}

export type AaTxnStatus = 'ok' | 'flagged' | 'duplicate' | 'excluded';
export interface AaTxn {
  id: string;
  seq: number;
  page: number | null;
  txn_date: string;
  value_date: string | null;
  narration: string;
  reference: string | null;
  debit_paise: number;
  credit_paise: number;
  balance_paise: number | null;
  status: AaTxnStatus;
  flags: string[];
  duplicate_of_id: string | null;
  ledger_name: string | null;
  voucher_type: 'payment' | 'receipt' | 'contra' | 'journal' | null;
  matched_rule_id: string | null;
  edited: boolean;
  edited_at: string | null;
  original: Record<string, unknown>;
}
export interface AaTxnPage {
  items: AaTxn[];
  total: number;
  limit: number;
  offset: number;
  counts: Partial<Record<AaTxnStatus, number>>;
  missing_ledger: number;
}
export interface AaRule {
  id: string;
  client_id: string | null;
  match_type: 'contains' | 'exact' | 'regex';
  pattern: string;
  direction: 'any' | 'withdrawal' | 'deposit';
  ledger_name: string;
  voucher_type: string | null;
  priority: number;
}

export interface AaJobDetail {
  job: AaJob;
  source_document: {
    id: string;
    original_filename: string;
    file_size: number;
    page_count: number;
    declared_page_count: number | null;
    encrypted: boolean;
    source_format?: 'pdf' | 'xlsx' | 'csv';
    bank: { id: string; key: string; name: string };
    bank_account: { id: string; account_number_masked: string; label: string | null };
    uploaded_by: { id: string; label: string };
    uploaded_at: string;
  } | null;
}

export interface AaDetection {
  band: 'ok' | 'uncertain' | 'mismatch' | 'no_adapter';
  score: number;
  adapterId: string | null;
}

export interface AaUploadResult {
  job: AaJob;
  source_document_id: string;
  detection: AaDetection;
  page_count: number;
  declared_page_count: number | null;
  flags: string[];
}

export interface AaUploadRequest {
  clientId: string;
  bankKey: string;
  bankAccountId: string;
  file: File;
  password?: string;
  /** The uploader confirmed they may decrypt this statement (required with a password). */
  authorised?: boolean;
  fy?: string;
  overrideAdapterMismatch?: boolean;
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

function makeError(status: number, code: string, message: string, details?: unknown): ApiError {
  const err = new Error(message) as ApiError;
  err.status = status;
  err.code = code;
  err.details = details;
  return err;
}

/**
 * Multipart upload with optional password. XHR is used (rather than fetch)
 * because it exposes upload progress. The password rides in the form only
 * for the duration of the upload; the server discards it after decryption.
 */
export function uploadStatement(req: AaUploadRequest, onProgress?: (pct: number) => void): Promise<AaUploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/audit-automation/uploads');
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let json: { data?: AaUploadResult; error?: { code: string; message: string; details?: unknown } } = {};
      try {
        json = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch { /* empty */ }
      if (xhr.status >= 200 && xhr.status < 300 && json.data) return resolve(json.data);
      const e = json.error ?? { code: 'unknown', message: 'Upload failed. Please try again.' };
      reject(makeError(xhr.status, e.code, e.message, e.details));
    };
    xhr.onerror = () => reject(makeError(0, 'network', 'Upload failed. Check your connection and try again.'));

    const form = new FormData();
    form.append('client_id', req.clientId);
    form.append('bank_key', req.bankKey);
    form.append('bank_account_id', req.bankAccountId);
    if (req.password) form.append('password', req.password);
    if (req.authorised) form.append('authorised', '1');
    if (req.fy) form.append('fy', req.fy);
    if (req.overrideAdapterMismatch) form.append('override_adapter_mismatch', '1');
    form.append('file', req.file, req.file.name);
    xhr.send(form);
  });
}

export const auditAutomationApi = {
  banks: () => api.get<{ items: AaBank[]; count: number }>('/api/audit-automation/banks'),
  accounts: (clientId: string, bankId?: string) =>
    api.get<{ items: AaAccount[]; count: number }>(
      `/api/audit-automation/accounts${qs({ client_id: clientId, bank_id: bankId })}`,
    ),
  createAccount: (input: {
    client_id: string;
    bank_id: string;
    account_number_masked: string;
    label?: string | null;
    currency?: string;
  }) => api.post<AaAccount>('/api/audit-automation/accounts', input),

  upload: uploadStatement,

  jobs: (clientId: string) =>
    api.get<{ items: AaJob[]; count: number }>(`/api/audit-automation/jobs${qs({ client_id: clientId })}`),
  job: (id: string) => api.get<AaJobDetail>(`/api/audit-automation/jobs/${id}`),
  updateJob: (id: string, body: { bank_ledger_name?: string; fy?: string }) => api.patch<AaJob>(`/api/audit-automation/jobs/${id}`, body),
  rows: (id: string, q: { status?: string; search?: string; limit?: number; offset?: number } = {}) =>
    api.get<AaTxnPage>(`/api/audit-automation/jobs/${id}/rows${qs(q)}`),
  updateRow: (rowId: string, body: Record<string, unknown>) => api.patch<AaTxn>(`/api/audit-automation/rows/${rowId}`, body),
  applyRules: (id: string) => api.post<{ changed: number }>(`/api/audit-automation/jobs/${id}/apply-rules`),
  approve: (id: string) => api.post<AaJob>(`/api/audit-automation/jobs/${id}/approve`),
  reopen: (id: string) => api.post<AaJob>(`/api/audit-automation/jobs/${id}/reopen`),
  reprocess: (id: string) => api.post<AaJob>(`/api/audit-automation/jobs/${id}/reprocess`),
  remove: (id: string) => api.delete<{ deleted: boolean }>(`/api/audit-automation/jobs/${id}`),
  tallyXmlUrl: (id: string) => `/api/audit-automation/jobs/${id}/export/tally.xml`,
  workbookUrl: (id: string) => `/api/audit-automation/jobs/${id}/export.xlsx`,
  rules: (clientId: string) => api.get<{ items: AaRule[] }>(`/api/audit-automation/rules${qs({ client_id: clientId })}`),
  /** Client's known ledgers + own bank/cash ledger set (REPOTIC §1 fix 2/4). */
  ledgerMaster: (clientId: string) =>
    api.get<{ ledgers: string[]; own_bank_cash_ledgers: string[] }>(`/api/audit-automation/clients/${clientId}/ledger-master`),
  createRule: (body: { client_id?: string | null; match_type?: string; pattern: string; direction?: string; ledger_name: string; voucher_type?: string | null; priority?: number }) =>
    api.post<{ id: string }>('/api/audit-automation/rules', body),
  deleteRule: (id: string) => api.delete<{ deleted: boolean }>(`/api/audit-automation/rules/${id}`),
};
