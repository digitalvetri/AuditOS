import { api } from '@/services/api';
import type {
  Activity, AssignableEmployee, ClientDetail, ClientDocument, ClientListItem,
  ClientService, DashboardResponse, DocumentCategory, EwayResponse, FollowUp,
  GstProfile, Lead, ListResponse, SearchResponse, ServiceCatalogItem, Task,
} from './types';

/**
 * The Workstation API client.
 *
 * Every call goes through the one swappable adapter in services/api.ts, so
 * these functions are identical whether MSW is intercepting or Express is
 * answering — no branch, no second implementation.
 *
 * Query strings are built with URLSearchParams and empty values dropped, so
 * an unset filter never reaches the server as `?status=` and get treated as a
 * literal empty status.
 */
function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface LeadFilters {
  status?: string;
  service_id?: string;
  employee_id?: string;
  q?: string;
}

export interface ClientFilters {
  q?: string;
  status?: string;
  account_manager_id?: string;
  service_id?: string;
  pending_documents?: boolean;
}

export interface ServiceFilters {
  status?: string;
  service_id?: string;
  client_id?: string;
  employee_id?: string;
  due?: 'overdue' | 'soon';
}

export interface FollowUpFilters {
  range?: 'today' | 'upcoming' | 'overdue';
  status?: string;
  employee_id?: string;
  client_id?: string;
  lead_id?: string;
}

export interface DocumentFilters {
  client_id?: string;
  category_id?: string;
  status?: string;
  financial_year?: string;
}

export interface CreateLeadInput {
  name: string;
  contact_number: string;
  service_id: string;
  price_quoted: number;
  assigned_employee_id: string;
  email?: string;
  notes?: string;
}

export interface ConvertLeadInput {
  company_name: string;
  contact_person: string;
  contact_number: string;
  email?: string;
  gstin?: string;
  pan?: string;
  account_manager_id: string;
  due_date?: string;
}

export const workstationApi = {
  // ── Dashboard + search ──────────────────────────────────────────────────
  dashboard: () => api.get<DashboardResponse>('/api/workstation/dashboard'),
  search: (q: string) => api.get<SearchResponse>(`/api/workstation/search${qs({ q })}`),
  assignableEmployees: () =>
    api.get<ListResponse<AssignableEmployee>>('/api/workstation/assignable-employees'),

  // ── Catalog ─────────────────────────────────────────────────────────────
  serviceCatalog: () => api.get<ListResponse<ServiceCatalogItem>>('/api/service-catalog'),
  documentCategories: () => api.get<ListResponse<DocumentCategory>>('/api/document-categories'),

  // ── Leads ───────────────────────────────────────────────────────────────
  listLeads: (f: LeadFilters = {}) => api.get<ListResponse<Lead>>(`/api/leads${qs({ ...f })}`),
  getLead: (id: string) => api.get<Lead>(`/api/leads/${id}`),
  leadActivity: (id: string) => api.get<ListResponse<Activity>>(`/api/leads/${id}/activity`),
  createLead: (input: CreateLeadInput) => api.post<Lead>('/api/leads', input),
  updateLead: (id: string, patch: Record<string, unknown>) => api.patch<Lead>(`/api/leads/${id}`, patch),
  convertLead: (id: string, input: ConvertLeadInput) =>
    api.post<{ client: ClientDetail; lead_id: string }>(`/api/leads/${id}/convert`, input),

  // ── Clients ─────────────────────────────────────────────────────────────
  listClients: (f: ClientFilters = {}) =>
    api.get<ListResponse<ClientListItem>>(`/api/clients${qs({ ...f })}`),
  getClient: (id: string) => api.get<ClientDetail>(`/api/clients/${id}`),
  createClient: (input: Record<string, unknown>) => api.post<ClientDetail>('/api/clients', input),
  updateClient: (id: string, patch: Record<string, unknown>) =>
    api.patch<ClientDetail>(`/api/clients/${id}`, patch),
  clientActivity: (id: string) => api.get<ListResponse<Activity>>(`/api/clients/${id}/activity`),
  clientTasks: (id: string) => api.get<ListResponse<Task>>(`/api/clients/${id}/tasks`),

  // ── Services ────────────────────────────────────────────────────────────
  listServices: (f: ServiceFilters = {}) =>
    api.get<ListResponse<ClientService>>(`/api/services${qs({ ...f })}`),
  clientServices: (clientId: string) =>
    api.get<ListResponse<ClientService>>(`/api/clients/${clientId}/services`),
  addClientService: (clientId: string, input: Record<string, unknown>) =>
    api.post<ClientService>(`/api/clients/${clientId}/services`, input),
  updateService: (id: string, patch: Record<string, unknown>) =>
    api.patch<ClientService>(`/api/services/${id}`, patch),

  // ── Follow-ups ──────────────────────────────────────────────────────────
  listFollowUps: (f: FollowUpFilters = {}) =>
    api.get<ListResponse<FollowUp>>(`/api/follow-ups${qs({ ...f })}`),
  createFollowUp: (input: Record<string, unknown>) => api.post<FollowUp>('/api/follow-ups', input),
  updateFollowUp: (id: string, patch: Record<string, unknown>) =>
    api.patch<FollowUp>(`/api/follow-ups/${id}`, patch),
  completeFollowUp: (id: string, completion_notes?: string) =>
    api.post<FollowUp>(`/api/follow-ups/${id}/complete`, { completion_notes }),

  // ── Documents ───────────────────────────────────────────────────────────
  listDocuments: (f: DocumentFilters = {}) =>
    api.get<ListResponse<ClientDocument>>(`/api/client-documents${qs({ ...f })}`),
  clientDocuments: (clientId: string) =>
    api.get<ListResponse<ClientDocument>>(`/api/clients/${clientId}/documents`),
  requestDocument: (clientId: string, input: Record<string, unknown>) =>
    api.post<ClientDocument>(`/api/clients/${clientId}/documents`, input),
  updateDocument: (id: string, patch: Record<string, unknown>) =>
    api.patch<ClientDocument>(`/api/client-documents/${id}`, patch),
  addDocumentVersion: (id: string, input: Record<string, unknown> = {}) =>
    api.post<ClientDocument>(`/api/client-documents/${id}/versions`, input),
  verifyDocument: (id: string, approve: boolean, rejection_reason?: string) =>
    api.post<ClientDocument>(`/api/client-documents/${id}/verify`, { approve, rejection_reason }),
  documentLink: (id: string, version: number) =>
    api.get<{ url: string; expires_at: string }>(`/api/client-documents/${id}/versions/${version}/link`),

  // ── GST ─────────────────────────────────────────────────────────────────
  clientGst: (clientId: string) => api.get<GstProfile | null>(`/api/clients/${clientId}/gst`),

  // ── E-way (simulated) ───────────────────────────────────────────────────
  clientEway: (clientId: string) => api.get<EwayResponse>(`/api/clients/${clientId}/eway`),
  generateEway: (clientId: string, input: Record<string, unknown>) =>
    api.post<EwayBillResponse>(`/api/clients/${clientId}/eway/generate`, input),
};

type EwayBillResponse = EwayResponse['items'][number];
