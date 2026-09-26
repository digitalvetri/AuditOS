import { api } from '@/services/api';

/**
 * Books (Zoho Books) API client. The browser only ever talks to Audit OS;
 * the server holds the Zoho tokens and calls Zoho. Records are Zoho's own
 * JSON shapes, so they are typed loosely as ZRecord and read field by field.
 */
export type ZRecord = Record<string, any>;

export interface BooksOrg {
  id: string;
  zoho_org_id: string;
  name: string;
  currency_code: string | null;
  country: string | null;
  is_active: boolean;
  client_id: string | null;
  client_name?: string | null;
  connection_id: string;
  connection_status?: string;
  sync_status: 'idle' | 'syncing' | 'synced' | 'failed';
  last_sync_at: string | null;
  last_sync_attempt_at: string | null;
  last_sync_error: string | null;
  activated_at: string | null;
  auto_refresh_minutes: number;
}

export interface BooksConnection {
  id: string;
  status: string;
  connected_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  scopes: string[];
  data_center: string | null;
}

export interface BooksStatus {
  configured: boolean;
  connections: BooksConnection[];
  organizations: BooksOrg[];
  permissions: { manage: boolean; accountant: boolean; settings: boolean; reports: boolean };
}

export interface ListResult { items: ZRecord[]; page: number; per_page: number; has_more: boolean }

export interface DashboardResult {
  snapshot: null | {
    as_of: string;
    currency_code: string | null;
    period: { from: string; to: string };
    totals: Record<string, number>;
    counts: Record<string, number>;
    monthly: { month: string; revenue: number; expenses: number }[];
    receivables_ageing: { label: string; amount: number; count: number }[];
    payables_ageing: { label: string; amount: number; count: number }[];
    bank_accounts: ZRecord[];
    recent: Record<string, ZRecord[]>;
    truncated: boolean;
    mixed_currency: boolean;
  };
  last_sync_at: string | null;
  sync_status: string;
  last_sync_error: string | null;
}

export interface ReportDef { id: string; title: string; group: string; dated: boolean; available: boolean }
export interface ReportResult {
  id: string; title: string; source: 'computed' | 'unavailable'; note: string;
  columns: { key: string; label: string; money?: boolean }[];
  rows: ZRecord[]; totals?: ZRecord; truncated?: boolean;
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const booksApi = {
  status: () => api.get<BooksStatus>('/api/books/status'),
  connect: () => api.post<{ connectionId: string; authorizeUrl: string }>('/api/books/connect'),
  reconnect: (id: string) => api.post<{ authorizeUrl: string }>(`/api/books/connections/${id}/reconnect`),
  disconnect: (id: string) => api.post(`/api/books/connections/${id}/disconnect`),
  refreshOrgs: (id: string) => api.post(`/api/books/connections/${id}/organizations/refresh`),
  clients: () => api.get<{ items: { id: string; name: string; code: string }[] }>('/api/books/clients'),
  updateOrg: (id: string, body: { is_active?: boolean; client_id?: string | null; auto_refresh_minutes?: number }) => api.patch<BooksOrg>(`/api/books/organizations/${id}`, body),

  org: (ref: string) => {
    const b = `/api/books/o/${ref}`;
    return {
      dashboard: () => api.get<DashboardResult>(`${b}/dashboard`),
      sync: () => api.post<DashboardResult>(`${b}/sync`),
      syncLogs: () => api.get<{ items: ZRecord[] }>(`${b}/sync-logs`),
      organization: () => api.get<ZRecord | null>(`${b}/organization`),
      reports: () => api.get<{ items: ReportDef[] }>(`${b}/reports`),
      report: (id: string, from?: string, to?: string) => api.get<ReportResult>(`${b}/reports/${id}${qs({ from, to })}`),
      list: (entity: string, params: Record<string, string | number | undefined> = {}) => api.get<ListResult>(`${b}/e/${entity}${qs(params)}`),
      get: (entity: string, id: string) => api.get<ZRecord>(`${b}/e/${entity}/${id}`),
      create: (entity: string, body: ZRecord) => api.post<ZRecord>(`${b}/e/${entity}`, body),
      update: (entity: string, id: string, body: ZRecord) => api.put<ZRecord>(`${b}/e/${entity}/${id}`, body),
      remove: (entity: string, id: string) => api.delete<{ deleted: boolean }>(`${b}/e/${entity}/${id}`),
      action: (entity: string, id: string, action: string, body?: ZRecord) => api.post<{ message: string }>(`${b}/e/${entity}/${id}/a/${action}`, body),
      matches: (txnId: string) => api.get<{ items: ZRecord[] }>(`${b}/e/banktransactions/${txnId}/match`),
      pdfUrl: (entity: string, id: string) => `${b}/e/${entity}/${id}/pdf`,
      attachReceipt: (expenseId: string, file: File) => {
        const f = new FormData();
        f.append('receipt', file);
        return api.postForm<{ attached: boolean }>(`${b}/e/expenses/${expenseId}/receipt`, f);
      },
    };
  },
};

/** The message to show for a failed call; the server already made it user-friendly. */
export function errorText(e: unknown): string {
  const err = e as { status?: number; message?: string } | null;
  if (!err) return 'Something went wrong.';
  if (err.status === 403) return err.message || 'Your role does not allow this.';
  return err.message || 'Something went wrong.';
}
