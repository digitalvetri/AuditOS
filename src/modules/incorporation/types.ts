/** Wire types for the Incorporation Service API. snake_case, as the server sends. */
export interface EmployeeRef { id: string; full_name: string; employee_code: string }

/**
 * PROVENANCE (§1.4). Every row describing something a government portal did
 * or said carries this triple, and the UI is required to render it as
 * "Recorded by <employee> · <date>". Nothing here ever means "verified with
 * the portal" — `source` is always `manual_entry`.
 */
export interface Provenance {
  source: string;
  recorded_by: EmployeeRef | null;
  recorded_at: string | null;
}

export interface Progress {
  total: number; completed: number; pending: number; blocked: number; percent: number;
}

export interface Kpis {
  active_cases: number; new_cases: number; documents_pending: number; dsc_pending: number;
  name_pending: number; filing_pending: number; government_queries: number;
  resubmission_required: number; approval_pending: number; overdue_tasks: number;
  completed_this_month: number;
}

export interface StageOption { stage: string; label: string }

export interface IncorporationCase {
  id: string;
  case_code: string;
  client_id: string;
  client_name: string | null;
  client_code: string | null;
  entity_type_id: string;
  entity_type_code: string | null;
  entity_type_name: string | null;
  client_service_id: string | null;
  proposed_name: string;
  alternate_name: string | null;
  business_activity: string | null;
  business_category: string | null;
  state: string | null;
  city: string | null;
  registered_office_info: string | null;
  incorporation_objective: string | null;
  stage: string;
  stage_label: string;
  held_from_stage: string | null;
  /** Exactly what the server will accept next — the UI offers nothing else. */
  allowed_next: StageOption[];
  status: string;
  priority: string;
  assigned_employee_id: string;
  assigned_employee: EmployeeRef | null;
  target_date: string | null;
  internal_notes: string | null;
  completed_at: string | null;
  cancelled_reason: string | null;
  is_demo: boolean;
  progress: Progress | null;
  open_queries: number | null;
  pending_documents: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface EntityType {
  id: string; code: string; name: string; description: string | null;
  party_roles: string[]; min_parties: number; max_parties: number | null;
  default_target_days: number;
  default_assigned_employee: EmployeeRef | null;
  default_assigned_employee_id: string | null;
  is_active: boolean; sort_order: number;
}

export interface ChecklistTemplate {
  id: string; entity_type_id: string | null; category: string; label: string;
  sort_order: number; stage: string | null; document_category: string | null; is_active: boolean;
}

export interface Party {
  id: string; case_id: string; role: string; name: string;
  contact_number: string | null; email: string | null; address: string | null;
  client_contact_id: string | null;
  client_contact: { id: string; name: string; designation: string | null } | null;
  dsc_required: boolean; sort_order: number; notes: string | null;
}

export interface ChecklistItem {
  id: string; case_id: string; category: string; label: string; status: string;
  sort_order: number; stage: string | null; stage_label: string | null;
  assigned_employee_id: string | null; assigned_employee: EmployeeRef | null;
  due_date: string | null; remarks: string | null;
  completed_at: string | null; completed_by: EmployeeRef | null;
}

export interface LinkedDocument {
  id: string; name: string; status?: string; currentVersion?: number; current_version?: number;
}

export interface DocumentRequest {
  id: string; case_id: string; case_code: string | null; client_id: string;
  client_name: string | null; party_id: string | null;
  category: string; document_type: string; description: string | null; status: string;
  requested_by: EmployeeRef | null; requested_at: string | null; due_date: string | null;
  received_at: string | null; reviewed_by: EmployeeRef | null; rejection_reason: string | null;
  client_document_id: string | null; client_document: LinkedDocument | null;
  created_at: string | null;
}

export interface Dsc extends Provenance {
  id: string; case_id: string; case_code: string | null; client_name: string | null;
  party_id: string; party_name: string | null; party_role: string | null;
  required: boolean; status: string; provider: string | null; reference_no: string | null;
  request_date: string | null; received_date: string | null; expiry_date: string | null;
  remarks: string | null; created_at: string | null;
}

export interface ProposedName extends Provenance {
  id: string; case_id: string; case_code: string | null; client_name: string | null;
  proposed_name: string; priority: number; status: string;
  submission_date: string | null; application_ref: string | null; response_date: string | null;
  remarks: string | null; created_at: string | null;
}

export interface Filing extends Provenance {
  id: string; case_id: string; case_code: string | null; client_name: string | null;
  filing_type: string; portal: string | null;
  application_ref: string | null; acknowledgement_ref: string | null;
  prepared_date: string | null; submitted_date: string | null; status: string;
  assigned_employee_id: string | null; assigned_employee: EmployeeRef | null;
  remarks: string | null;
  client_document_id: string | null; client_document: LinkedDocument | null;
  created_at: string | null;
}

export interface GovernmentQuery extends Provenance {
  id: string; case_id: string; case_code: string | null; client_name: string | null;
  filing_id: string | null; filing_type: string | null;
  query_date: string; authority: string | null; description: string;
  client_document_id: string | null; client_document: LinkedDocument | null;
  assigned_employee_id: string | null; assigned_employee: EmployeeRef | null;
  response_due_date: string | null; response: string | null;
  response_submitted_date: string | null; resubmission_ref: string | null;
  resolution: string | null; remarks: string | null; status: string;
  /** Computed by the server at read time, never stored. */
  is_overdue: boolean;
  created_at: string | null;
}

export interface Deliverable extends Provenance {
  id: string; case_id: string; case_code: string | null; client_id: string;
  client_name: string | null; name: string; type: string; status: string;
  client_document_id: string | null; client_document: LinkedDocument | null;
  prepared_date: string | null; delivered_date: string | null;
  delivered_by: EmployeeRef | null; reference_no: string | null; notes: string | null;
  created_at: string | null;
}

export interface Fee {
  id: string; case_id: string; case_code: string | null; client_id: string;
  category: string; description: string | null; amount_paise: number; status: string;
  client_service_id: string | null; invoice_ref: string | null;
  due_date: string | null; paid_date: string | null; paid_amount_paise: number;
  notes: string | null; recorded_by: EmployeeRef | null; created_at: string | null;
}

export interface CaseTask {
  id: string; client_id: string; incorporation_case_id: string | null;
  title: string; description: string | null; status: string;
  assigned_employee_id: string; assigned_employee: EmployeeRef | null;
  due_date: string | null; created_at: string | null;
  case_code?: string | null; client_name?: string | null; is_overdue?: boolean;
}

export interface TimelineEntry {
  id: string; case_id: string; action: string; detail: string | null;
  actor_user_id: string | null; actor_name: string | null; created_at: string | null;
}

export interface PendingItem {
  kind: string; tab: string;
  case_id: string | null; case_code: string | null;
  client_name: string | null; proposed_name: string | null;
  title: string; detail: string | null; due_date: string | null; overdue: boolean;
}

export interface TaskTemplate { key: string; title: string; dueInDays: number }

export interface Vocabularies {
  stages: StageOption[];
  case_statuses: string[];
  priorities: string[];
  party_roles: { value: string; label: string }[];
  checklist_categories: string[];
  checklist_statuses: string[];
  document_categories: string[];
  document_statuses: string[];
  dsc_statuses: string[];
  name_statuses: string[];
  filing_types: string[];
  filing_statuses: string[];
  query_statuses: string[];
  deliverable_types: string[];
  deliverable_statuses: string[];
  fee_categories: string[];
  fee_statuses: string[];
  task_templates: TaskTemplate[];
  handover_checklist: string[];
}

export interface SettingsResponse {
  entity_types: EntityType[];
  checklist_templates: ChecklistTemplate[];
  vocabularies: Vocabularies;
  can_manage_settings: boolean;
}

export interface OverviewResponse { kpis: Kpis; active: IncorporationCase[]; scope: string }

export interface ListResponse<T> { items: T[]; count: number }

export interface PagedResponse<T> extends ListResponse<T> {
  page: number; page_size: number; total: number;
}

export interface CaseDetailResponse {
  case: IncorporationCase;
  entity_type: EntityType;
  party_roles: { value: string; label: string }[];
  handover_checklist: string[];
  task_templates: TaskTemplate[];
}

export interface PartiesResponse extends ListResponse<Party> {
  roles: { value: string; label: string }[];
}
export interface ChecklistResponse extends ListResponse<ChecklistItem> { progress: Progress }
export interface DocumentsResponse extends ListResponse<DocumentRequest> {
  available_documents: LinkedDocument[];
}
export interface DscResponse extends ListResponse<Dsc> {
  parties: { id: string; name: string; role: string; dscRequired: boolean }[];
}
export interface QueriesResponse extends ListResponse<GovernmentQuery> {
  filings: { id: string; filingType: string; applicationRef: string | null }[];
}
export interface FeesResponse extends ListResponse<Fee> {
  totals: { billed_paise: number; received_paise: number; outstanding_paise: number };
  client_services: { id: string; name: string; status: string }[];
}
export interface DeliverablesResponse extends ListResponse<Deliverable> {
  available_documents: LinkedDocument[];
}
export interface CaseTasksResponse extends ListResponse<CaseTask> { templates: TaskTemplate[] }
export interface PendingItemsResponse extends ListResponse<PendingItem> {
  counts_by_kind: Record<string, number>;
}
