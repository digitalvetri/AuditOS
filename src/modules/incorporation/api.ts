import { api } from '@/services/api';
import type {
  CaseDetailResponse, CaseTasksResponse, ChecklistItem, ChecklistResponse,
  ChecklistTemplate, DeliverablesResponse, Deliverable, DocumentRequest,
  DocumentsResponse, Dsc, DscResponse, EntityType, Fee, FeesResponse, Filing,
  GovernmentQuery, IncorporationCase, ListResponse, PagedResponse, Party,
  PartiesResponse, PendingItemsResponse, ProposedName, QueriesResponse,
  SettingsResponse, OverviewResponse, CaseTask, TimelineEntry,
} from './types';

/** Empty values are dropped so an unset filter never reaches the server as `?stage=`. */
function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const B = '/api/incorporation';

export const incorporationApi = {
  overview: () => api.get<OverviewResponse>(`${B}/overview`),
  settings: () => api.get<SettingsResponse>(`${B}/settings`),

  // ── Cases ───────────────────────────────────────────────────────────────
  listCases: (f: Record<string, string | number | boolean> = {}) =>
    api.get<PagedResponse<IncorporationCase>>(`${B}/cases${qs(f)}`),
  createCase: (input: Record<string, unknown>) =>
    api.post<IncorporationCase & { parties: Party[] }>(`${B}/cases`, input),
  getCase: (id: string) => api.get<CaseDetailResponse>(`${B}/cases/${id}`),
  updateCase: (id: string, patch: Record<string, unknown>) =>
    api.patch<IncorporationCase>(`${B}/cases/${id}`, patch),
  changeStage: (id: string, input: { stage: string; reason?: string }) =>
    api.post<IncorporationCase>(`${B}/cases/${id}/stage`, input),
  timeline: (id: string) => api.get<ListResponse<TimelineEntry>>(`${B}/cases/${id}/timeline`),

  // ── Parties ─────────────────────────────────────────────────────────────
  listParties: (caseId: string) => api.get<PartiesResponse>(`${B}/cases/${caseId}/parties`),
  createParty: (caseId: string, input: Record<string, unknown>) =>
    api.post<Party>(`${B}/cases/${caseId}/parties`, input),
  updateParty: (id: string, patch: Record<string, unknown>) =>
    api.patch<Party>(`${B}/parties/${id}`, patch),
  deleteParty: (id: string) => api.delete<{ id: string; deleted: boolean }>(`${B}/parties/${id}`),

  // ── Checklist ───────────────────────────────────────────────────────────
  checklist: (caseId: string) => api.get<ChecklistResponse>(`${B}/cases/${caseId}/checklist`),
  updateChecklistItem: (id: string, patch: Record<string, unknown>) =>
    api.patch<ChecklistItem>(`${B}/checklist-items/${id}`, patch),
  applyTemplate: (caseId: string) =>
    api.post<{ added: number }>(`${B}/cases/${caseId}/checklist/apply-template`, {}),

  // ── Documents (requests only — files stay in the Documents module) ───────
  documents: (caseId: string) => api.get<DocumentsResponse>(`${B}/cases/${caseId}/documents`),
  createDocumentRequest: (caseId: string, input: Record<string, unknown>) =>
    api.post<DocumentRequest>(`${B}/cases/${caseId}/documents`, input),
  updateDocumentRequest: (id: string, patch: Record<string, unknown>) =>
    api.patch<DocumentRequest>(`${B}/document-requests/${id}`, patch),
  linkDocument: (id: string, clientDocumentId: string | null) =>
    api.post<DocumentRequest>(`${B}/document-requests/${id}/link`, { client_document_id: clientDocumentId }),

  // ── DSC (tracking only) ─────────────────────────────────────────────────
  dsc: (caseId: string) => api.get<DscResponse>(`${B}/cases/${caseId}/dsc`),
  createDsc: (caseId: string, input: Record<string, unknown>) =>
    api.post<Dsc>(`${B}/cases/${caseId}/dsc`, input),
  updateDsc: (id: string, patch: Record<string, unknown>) => api.patch<Dsc>(`${B}/dsc/${id}`, patch),

  // ── Names ───────────────────────────────────────────────────────────────
  names: (caseId: string) => api.get<ListResponse<ProposedName>>(`${B}/cases/${caseId}/names`),
  createName: (caseId: string, input: Record<string, unknown>) =>
    api.post<ProposedName>(`${B}/cases/${caseId}/names`, input),
  updateName: (id: string, patch: Record<string, unknown>) =>
    api.patch<ProposedName>(`${B}/names/${id}`, patch),

  // ── Filings ─────────────────────────────────────────────────────────────
  filings: (caseId: string) => api.get<ListResponse<Filing>>(`${B}/cases/${caseId}/filings`),
  createFiling: (caseId: string, input: Record<string, unknown>) =>
    api.post<Filing>(`${B}/cases/${caseId}/filings`, input),
  updateFiling: (id: string, patch: Record<string, unknown>) =>
    api.patch<Filing>(`${B}/filings/${id}`, patch),

  // ── Government queries ──────────────────────────────────────────────────
  queries: (caseId: string) => api.get<QueriesResponse>(`${B}/cases/${caseId}/queries`),
  createQuery: (caseId: string, input: Record<string, unknown>) =>
    api.post<GovernmentQuery>(`${B}/cases/${caseId}/queries`, input),
  updateQuery: (id: string, patch: Record<string, unknown>) =>
    api.patch<GovernmentQuery>(`${B}/queries/${id}`, patch),

  // ── Tasks (rows in the EXISTING Task table) ─────────────────────────────
  caseTasks: (caseId: string) => api.get<CaseTasksResponse>(`${B}/cases/${caseId}/tasks`),
  createTask: (caseId: string, input: Record<string, unknown>) =>
    api.post<CaseTask>(`${B}/cases/${caseId}/tasks`, input),
  updateTask: (id: string, patch: Record<string, unknown>) =>
    api.patch<CaseTask>(`${B}/tasks/${id}`, patch),

  // ── Fees ────────────────────────────────────────────────────────────────
  fees: (caseId: string) => api.get<FeesResponse>(`${B}/cases/${caseId}/fees`),
  createFee: (caseId: string, input: Record<string, unknown>) =>
    api.post<Fee>(`${B}/cases/${caseId}/fees`, input),
  updateFee: (id: string, patch: Record<string, unknown>) => api.patch<Fee>(`${B}/fees/${id}`, patch),

  // ── Deliverables ────────────────────────────────────────────────────────
  deliverables: (caseId: string) => api.get<DeliverablesResponse>(`${B}/cases/${caseId}/deliverables`),
  createDeliverable: (caseId: string, input: Record<string, unknown>) =>
    api.post<Deliverable>(`${B}/cases/${caseId}/deliverables`, input),
  updateDeliverable: (id: string, patch: Record<string, unknown>) =>
    api.patch<Deliverable>(`${B}/deliverables/${id}`, patch),

  // ── Cross-case queues ───────────────────────────────────────────────────
  pendingItems: (f: Record<string, string> = {}) =>
    api.get<PendingItemsResponse>(`${B}/pending-items${qs(f)}`),
  allDeliverables: (f: Record<string, string> = {}) =>
    api.get<ListResponse<Deliverable>>(`${B}/deliverables${qs(f)}`),
  allTasks: (f: Record<string, string | boolean> = {}) =>
    api.get<ListResponse<CaseTask>>(`${B}/tasks${qs(f)}`),

  // ── Settings writes ─────────────────────────────────────────────────────
  updateEntityType: (id: string, patch: Record<string, unknown>) =>
    api.patch<EntityType>(`${B}/entity-types/${id}`, patch),
  createTemplateItem: (input: Record<string, unknown>) =>
    api.post<ChecklistTemplate>(`${B}/checklist-templates`, input),
  updateTemplateItem: (id: string, patch: Record<string, unknown>) =>
    api.patch<ChecklistTemplate>(`${B}/checklist-templates/${id}`, patch),
};
