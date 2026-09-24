import { api } from '@/services/api';

/**
 * Partnership Firm Registration — Workstation → Services → Registration.
 * Real backend only (/api/partnership); like the rest of Workstation it has no
 * mock handlers.
 */

export interface EmployeeRef { id: string; full_name: string; employee_code: string }

export type CaseStatus =
  | 'NOT_STARTED' | 'IN_PROGRESS' | 'DOCUMENTS_PENDING' | 'UNDER_REVIEW'
  | 'SUBMITTED' | 'QUERY' | 'COMPLETED' | 'ON_HOLD';
export type RegistrationKind = 'PARTNERSHIP' | 'LLP' | 'GST';
/** Partnership: INFO_COLLECTION | DEED | ROF_FILING | REGISTERED. LLP: STAGE_1 | STAGE_2 | COMPLETED. GST: INFO_COLLECTION | FILING | REGISTERED. */
export type CaseStage = string;
export type ItemStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'NOT_APPLICABLE' | 'BLOCKED';
export type RequirementType = 'REQUIRED' | 'OPTIONAL' | 'CONDITIONAL';
export type ItemKind = 'INFO' | 'DOCUMENT' | 'ACTION';
export type EntityType = 'PROPRIETORSHIP' | 'PARTNERSHIP' | 'LLP' | 'PVT_LTD';
export type EntityCondition = EntityType | 'LLP_OR_PVT_LTD';
export type DocStatus =
  | 'PENDING' | 'UPLOADED' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED'
  | 'REPLACEMENT_REQUIRED' | 'NOT_APPLICABLE';
export type DueState = 'overdue' | 'today' | 'soon' | 'upcoming' | 'completed' | null;

export interface CaseProgress {
  pct: number;
  items_total: number;
  items_done: number;
  items_pending: number;
  items_required: number;
  items_required_done: number;
  docs_required: number;
  docs_uploaded: number;
  docs_verified: number;
  docs_pct: number;
}

export interface CaseSummary {
  id: string;
  case_code: string;
  kind: RegistrationKind;
  client: { id: string; name: string; code: string };
  status: CaseStatus;
  stage: CaseStage;
  assigned: EmployeeRef | null;
  reviewer: EmployeeRef | null;
  approver: EmployeeRef | null;
  due_date: string | null;
  due_state: DueState;
  premises_type: 'RENTED' | 'OWNED' | null;
  entity_type: EntityType | null;
  progress: CaseProgress;
  created_at: string;
  last_activity_at: string | null;
  completed_at: string | null;
}

export interface CaseItem {
  id: string;
  name: string;
  description: string | null;
  requirement: RequirementType;
  kind: ItemKind;
  per_partner: boolean;
  partner: { id: string; name: string } | null;
  doc_type_options: string[] | null;
  max_age_days: number | null;
  condition: 'RENTED' | 'OWNED' | null;
  entity_condition: EntityCondition | null;
  applicable: boolean;
  status: ItemStatus;
  assigned: EmployeeRef | null;
  due_date: string | null;
  due_state: DueState;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  notes: string | null;
  is_custom: boolean;
  completed_at: string | null;
  completed_by: EmployeeRef | null;
  created_at: string;
  updated_at: string;
  documents: { requirement_id: string; name: string; status: DocStatus; partner: { id: string; name: string } | null }[];
}

export interface CaseCategory {
  id: string;
  name: string;
  description: string | null;
  stage: CaseStage | null;
  is_custom: boolean;
  per_partner: boolean;
  entity_condition: EntityCondition | null;
  applicable: boolean;
  items: CaseItem[];
}

export interface DocVersion {
  id: string;
  version: number;
  original_name: string | null;
  mime_type: string | null;
  size_bytes: number;
  uploaded_by: EmployeeRef | null;
  uploaded_at: string;
  review_status: string;
  reviewed_by: EmployeeRef | null;
  reviewed_at: string | null;
  review_note: string | null;
  notes: string | null;
  document_type: string | null;
  document_date: string | null;
}

export interface DocRequirement {
  id: string;
  name: string;
  category_name: string | null;
  requirement: RequirementType;
  condition: 'RENTED' | 'OWNED' | null;
  doc_key: string | null;
  doc_type_options: string[] | null;
  max_age_days: number | null;
  status: DocStatus;
  not_applicable: boolean;
  due_date: string | null;
  due_state: DueState;
  item: { id: string; name: string } | null;
  partner: { id: string; name: string } | null;
  current_version: DocVersion | null;
  versions: DocVersion[];
}

export interface Partner {
  id: string;
  name: string;
  father_name: string | null;
  address: string | null;
  mobile: string | null;
  email: string | null;
  pan: string | null;
  aadhaar: string | null;
  capital: string | null;
  profit_share: string | null;
  remuneration: string | null;
}

export interface RegistrationDetails {
  firm_names: string[];
  nature_of_business: string;
  principal_place: string;
  other_branches: string;
  total_capital: string;
  remuneration_terms: string;
  interest_on_capital: string;
  drawing_limits: string;
  bank_operation: string;
  authorized_signatory: string;
  commencement_date: string;
  deed_witnesses: { name: string; address: string }[];
  application_witnesses: { name: string; occupation: string; pan_aadhaar: string }[];
}

/** LLP source, section 3 — "Basic Business Details Needed". */
export interface LlpDetails {
  llp_names: string[];
  main_objective: string;
  total_contribution: string;
}

export interface CaseDetail extends CaseSummary {
  details: RegistrationDetails & Partial<LlpDetails>;
  stages: string[];
  stage_progress: { stage: string; done: number; total: number }[];
  partner_progress: { partner_id: string; name: string; done: number; total: number; docs_pending: number }[];
  partners: Partner[];
  categories: CaseCategory[];
  requirements: DocRequirement[];
  permissions: { manage: boolean; upload: boolean; verify: boolean };
}

export interface Overview {
  total_clients: number;
  in_progress: number;
  documents_pending: number;
  checklist_items_pending: number;
  completed: number;
  overdue: number;
  today: string;
}

export interface ActivityEntry {
  id: string;
  action: string;
  detail: string | null;
  entity_type: string | null;
  entity_id: string | null;
  actor: EmployeeRef | null;
  created_at: string;
}

export interface TemplateItem {
  id: string;
  name: string;
  description: string | null;
  requirement: RequirementType;
  kind: ItemKind;
  per_partner: boolean;
  doc_key: string | null;
  condition: 'RENTED' | 'OWNED' | null;
  entity_condition: EntityCondition | null;
  default_due_days: number | null;
  default_assignee: 'ASSIGNEE' | 'REVIEWER' | null;
  doc_type_options: string[] | null;
  max_age_days: number | null;
  sort_order: number;
}
export interface TemplateCategory {
  id: string;
  name: string;
  description: string | null;
  stage: CaseStage;
  sort_order: number;
  per_partner: boolean;
  entity_condition: EntityCondition | null;
  items: TemplateItem[];
}

export interface CaseFilters {
  q?: string;
  status?: string;
  stage?: string;
  assignee?: string;
  reviewer?: string;
  due?: string;
  doc_status?: string;
  progress_min?: string;
  progress_max?: string;
  sort?: string;
  dir?: string;
  page?: number;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * One client per registration service. Partnership and LLP share the server's
 * case engine, mounted at /api/partnership and /api/llp.
 */
export function makeRegistrationApi(base: string) {
  const c = (id: string) => `${base}/cases/${id}`;
  return {
    overview: () => api.get<Overview>(`${base}/overview`),
    listCases: (f: CaseFilters = {}) =>
      api.get<{ items: CaseSummary[]; count: number; page: number; page_size: number }>(`${base}/cases${qs({ ...f })}`),
    createCase: (input: { client_id: string; assigned_employee_id?: string; reviewer_employee_id?: string; approver_employee_id?: string; due_date?: string; entity_type?: EntityType | null }) =>
      api.post<{ id: string; case_code: string }>(`${base}/cases`, input),
    getCase: (id: string) => api.get<CaseDetail>(c(id)),
    updateCase: (id: string, input: Record<string, unknown>) => api.patch<{ id: string }>(c(id), input),
    saveDetails: (id: string, details: RegistrationDetails) => api.put<{ details: RegistrationDetails }>(`${c(id)}/details`, { details }),

    addPartner: (id: string, input: Partial<Partner>) => api.post<{ id: string }>(`${c(id)}/partners`, input),
    updatePartner: (id: string, pid: string, input: Partial<Partner>) => api.patch<{ id: string }>(`${c(id)}/partners/${pid}`, input),
    removePartner: (id: string, pid: string) => api.delete<{ id: string }>(`${c(id)}/partners/${pid}`),

    addCategory: (id: string, input: { name: string; description?: string }) => api.post<{ id: string }>(`${c(id)}/categories`, input),
    addItem: (id: string, input: Record<string, unknown>) => api.post<{ id: string }>(`${c(id)}/items`, input),
    updateItem: (id: string, itemId: string, input: Record<string, unknown>) => api.patch<{ id: string }>(`${c(id)}/items/${itemId}`, input),
    removeItem: (id: string, itemId: string) => api.delete<{ id: string }>(`${c(id)}/items/${itemId}`),

    upload: (id: string, form: FormData) =>
      api.postForm<{ requirement_id: string; version_id: string; version: number }>(`${c(id)}/documents`, form),
    updateRequirement: (id: string, rid: string, input: Record<string, unknown>) => api.patch<{ id: string }>(`${c(id)}/requirements/${rid}`, input),
    review: (id: string, rid: string, input: { status: string; note?: string }) => api.post<{ id: string }>(`${c(id)}/requirements/${rid}/review`, input),
    deleteDocument: (id: string, rid: string) => api.delete<{ id: string }>(`${c(id)}/requirements/${rid}`),
    fileLink: (id: string, rid: string, versionId: string) =>
      api.get<{ url: string; expires_at: string; mime_type: string; original_name: string; size_bytes: number }>(
        `${c(id)}/requirements/${rid}/versions/${versionId}/link`,
      ),

    activity: (id: string) => api.get<{ items: ActivityEntry[] }>(`${c(id)}/activity`),

    template: () => api.get<{ can_manage: boolean; stages: string[]; categories: TemplateCategory[] }>(`${base}/template`),
    addTemplateCategory: (input: Record<string, unknown>) => api.post<{ id: string }>(`${base}/template/categories`, input),
    updateTemplateCategory: (cid: string, input: Record<string, unknown>) => api.patch<{ id: string }>(`${base}/template/categories/${cid}`, input),
    deleteTemplateCategory: (cid: string) => api.delete<{ id: string }>(`${base}/template/categories/${cid}`),
    addTemplateItem: (input: Record<string, unknown>) => api.post<{ id: string }>(`${base}/template/items`, input),
    updateTemplateItem: (iid: string, input: Record<string, unknown>) => api.patch<{ id: string }>(`${base}/template/items/${iid}`, input),
    deleteTemplateItem: (iid: string) => api.delete<{ id: string }>(`${base}/template/items/${iid}`),
  };
}
export type RegistrationApi = ReturnType<typeof makeRegistrationApi>;

export const partnershipApi = makeRegistrationApi('/api/partnership');
export const llpApi = makeRegistrationApi('/api/llp');
export const gstRegApi = makeRegistrationApi('/api/gst-registration');

/** Query keys, namespaced per service so the two never share a cache entry. */
export function makeRegistrationKeys(ns: string) {
  return {
    all: [ns] as const,
    overview: [ns, 'overview'] as const,
    cases: (f: CaseFilters) => [ns, 'cases', f] as const,
    case: (id: string) => [ns, 'case', id] as const,
    activity: (id: string) => [ns, 'activity', id] as const,
    template: [ns, 'template'] as const,
  };
}
export type RegistrationKeys = ReturnType<typeof makeRegistrationKeys>;
export const pfrKeys = makeRegistrationKeys('partnership');
