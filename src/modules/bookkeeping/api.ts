import { api } from '@/services/api';
import type {
  Activity, BookkeepingClient, ClientDetailResponse, Deliverable, DocumentRequest,
  Engagement, GridResponse, Import, ListResponse, OverviewResponse, PendingItem,
  Period, PeriodDetailResponse, Reminder, SettingsResponse, Task,
} from './types';

/** Empty values are dropped so an unset filter never reaches the server as `?status=`. */
function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const B = '/api/bookkeeping';

export const bookkeepingApi = {
  overview: () => api.get<OverviewResponse>(`${B}/overview`),
  settings: () => api.get<SettingsResponse>(`${B}/settings`),

  listClients: (f: Record<string, string> = {}) =>
    api.get<ListResponse<BookkeepingClient>>(`${B}/clients${qs(f)}`),
  clientsGrid: (f: Record<string, string | number> = {}) =>
    api.get<GridResponse>(`${B}/clients/grid${qs(f)}`),
  client: (clientId: string) => api.get<ClientDetailResponse>(`${B}/clients/${clientId}`),
  clientActivity: (clientId: string) =>
    api.get<ListResponse<Activity>>(`${B}/clients/${clientId}/activity`),

  createEngagement: (input: Record<string, unknown>) =>
    api.post<Engagement>(`${B}/engagements`, input),
  updateEngagement: (id: string, input: Record<string, unknown>) =>
    api.patch<Engagement>(`${B}/engagements/${id}`, input),

  listPeriods: (f: Record<string, string> = {}) =>
    api.get<ListResponse<Period>>(`${B}/periods${qs(f)}`),
  period: (id: string) => api.get<PeriodDetailResponse>(`${B}/periods/${id}`),
  createPeriod: (input: Record<string, unknown>) => api.post<Period>(`${B}/periods`, input),
  updatePeriod: (id: string, input: Record<string, unknown>) =>
    api.patch<Period>(`${B}/periods/${id}`, input),

  listTasks: (f: Record<string, string> = {}) => api.get<ListResponse<Task>>(`${B}/tasks${qs(f)}`),
  createTask: (input: Record<string, unknown>) => api.post<Task>(`${B}/tasks`, input),
  updateTask: (id: string, input: Record<string, unknown>) =>
    api.patch<Task>(`${B}/tasks/${id}`, input),

  listPendingItems: (f: Record<string, string> = {}) =>
    api.get<ListResponse<PendingItem>>(`${B}/pending-items${qs(f)}`),
  createPendingItem: (input: Record<string, unknown>) =>
    api.post<PendingItem>(`${B}/pending-items`, input),
  updatePendingItem: (id: string, input: Record<string, unknown>) =>
    api.patch<PendingItem>(`${B}/pending-items/${id}`, input),

  listDocumentRequests: (f: Record<string, string> = {}) =>
    api.get<ListResponse<DocumentRequest>>(`${B}/document-requests${qs(f)}`),
  createDocumentRequest: (input: Record<string, unknown>) =>
    api.post<DocumentRequest>(`${B}/document-requests`, input),
  updateDocumentRequest: (id: string, input: Record<string, unknown>) =>
    api.patch<DocumentRequest>(`${B}/document-requests/${id}`, input),

  listDeliverables: (f: Record<string, string> = {}) =>
    api.get<ListResponse<Deliverable>>(`${B}/deliverables${qs(f)}`),
  createDeliverable: (input: Record<string, unknown>) =>
    api.post<Deliverable>(`${B}/deliverables`, input),
  updateDeliverable: (id: string, input: Record<string, unknown>) =>
    api.patch<Deliverable>(`${B}/deliverables/${id}`, input),

  listReminders: (f: Record<string, string> = {}) =>
    api.get<ListResponse<Reminder>>(`${B}/reminders${qs(f)}`),
  createReminder: (input: Record<string, unknown>) => api.post<Reminder>(`${B}/reminders`, input),
  updateReminder: (id: string, input: Record<string, unknown>) =>
    api.patch<Reminder>(`${B}/reminders/${id}`, input),

  listImports: (f: Record<string, string> = {}) =>
    api.get<ListResponse<Import>>(`${B}/imports${qs(f)}`),
  /**
   * The import upload takes multipart/form-data — file plus metadata. Only
   * the two-blocking-validation fields (company_name_in_file,
   * period_from_in_file, period_to_in_file) are the user's own claim about
   * the file; the server validates them against the period + client and
   * records the outcome on a new BookkeepingImport row.
   */
  createImport: async (input: {
    file: File;
    period_id: string;
    kind: 'trial_balance' | 'day_book' | 'outstandings' | 'bank_statement';
    source?: 'upload' | 'email' | 'agent';
    company_name_in_file: string;
    period_from_in_file: string;
    period_to_in_file: string;
  }) => {
    const fd = new FormData();
    fd.set('file', input.file);
    fd.set('period_id', input.period_id);
    fd.set('kind', input.kind);
    fd.set('source', input.source ?? 'upload');
    fd.set('company_name_in_file', input.company_name_in_file);
    fd.set('period_from_in_file', input.period_from_in_file);
    fd.set('period_to_in_file', input.period_to_in_file);
    return api.postForm<Import>(`${B}/imports`, fd);
  },
};
