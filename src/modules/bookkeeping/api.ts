import { api } from '@/services/api';
import type {
  Activity, BookkeepingClient, ClientDetailResponse, Deliverable, DocumentRequest,
  Engagement, ListResponse, OverviewResponse, PendingItem, Period, PeriodDetailResponse,
  Reminder, SettingsResponse, Task, ChecklistItem,
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
  updateChecklistItem: (id: string, input: Record<string, unknown>) =>
    api.patch<ChecklistItem>(`${B}/checklist-items/${id}`, input),

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
};
