/**
 * Workstation API types — the exact shapes server/src/api/workstation.serialize.ts
 * emits. Kept in the module rather than in src/data/models.ts so the core HRMS
 * model file stays a core-HR file, the same reason the Workstation seed and
 * serializer are their own modules.
 *
 * No `any` anywhere in this file or in api.ts — that is an acceptance
 * criterion, not a preference.
 */

export interface EmployeeRef {
  id: string;
  full_name: string;
  employee_code: string;
}

export interface Auditable {
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  deleted_at: string | null;
}

export type Scope = 'self' | 'department' | 'organisation';

export type LeadStatus =
  | 'new' | 'contacted' | 'requirement_identified'
  | 'quote_sent' | 'negotiation' | 'won' | 'lost';

export type ClientStatus =
  | 'active' | 'onboarding' | 'pending_documents' | 'service_due' | 'inactive';

export type ServiceStatus =
  | 'not_started' | 'documents_pending' | 'in_progress' | 'under_review'
  | 'ready' | 'submitted' | 'completed' | 'failed' | 'on_hold';

export type FollowUpType =
  | 'call' | 'whatsapp' | 'email' | 'meeting' | 'document_request'
  | 'payment_followup' | 'service_followup' | 'other';

export type FollowUpStatus =
  | 'pending' | 'completed' | 'rescheduled' | 'cancelled' | 'missed';

export type DocumentStatus =
  | 'requested' | 'pending' | 'uploaded' | 'under_review'
  | 'verified' | 'rejected' | 'expired';

export type GstFilingStatus =
  | 'not_started' | 'documents_pending' | 'data_preparation' | 'under_review'
  | 'ready_to_file' | 'filed' | 'failed' | 'completed';

export interface ServiceCatalogItem extends Auditable {
  id: string;
  organisation_id: string;
  code: string;
  name: string;
  is_active: boolean;
  sort_order: number;
}

export interface DocumentCategory extends Auditable {
  id: string;
  organisation_id: string;
  code: string;
  name: string;
  description: string | null;
  sort_order: number;
}

export interface Lead extends Auditable {
  id: string;
  organisation_id: string;
  /** The human-readable 'LD-1001', not the uuid. */
  lead_id: string;
  name: string;
  contact_number: string;
  email: string | null;
  service_id: string;
  service_name: string | null;
  /** Quoted, NOT received — Finance owns payment (§55). */
  price_quoted_paise: number;
  assigned_employee_id: string;
  assigned_employee: EmployeeRef | null;
  status: LeadStatus;
  notes: string | null;
  lost_reason: string | null;
  converted_client_id: string | null;
  converted_at: string | null;
  created_date: string;
}

export interface ClientContact extends Auditable {
  id: string;
  client_id: string;
  name: string;
  designation: string | null;
  phone: string;
  email: string | null;
  is_primary: boolean;
}

export interface Client extends Auditable {
  id: string;
  organisation_id: string;
  /** The human-readable 'CLI-1001'. */
  client_id: string;
  company_name: string;
  legal_name: string | null;
  business_type: string | null;
  contact_person: string;
  contact_number: string;
  email: string | null;
  address: string | null;
  gstin: string | null;
  pan: string | null;
  tan: string | null;
  account_manager_id: string;
  account_manager: EmployeeRef | null;
  assigned_team: string | null;
  status: ClientStatus;
  onboarding_date: string;
  notes: string | null;
  source_lead_id: string | null;
  portal_enabled: boolean;
  portal_invite_email: string | null;
}

export interface ClientListItem extends Client {
  service_names: string[];
  document_count: number;
}

export interface ClientDetail extends Client {
  contacts: ClientContact[];
  document_count: number;
  follow_up_count: number;
}

export interface ClientService extends Auditable {
  id: string;
  client_id: string;
  client_code: string | null;
  client_name: string | null;
  service_id: string;
  service_name: string | null;
  assigned_employee_id: string;
  assigned_employee: EmployeeRef | null;
  manager_id: string | null;
  manager: EmployeeRef | null;
  due_date: string | null;
  status: ServiceStatus;
  started_at: string | null;
  completed_at: string | null;
  notes: string | null;
}

export interface FollowUp extends Auditable {
  id: string;
  organisation_id: string;
  lead_id: string | null;
  client_id: string | null;
  client_service_id: string | null;
  /** One entity, two subjects (§3) — flattened for a single table. */
  subject_type: 'lead' | 'client';
  subject_id: string | null;
  subject_name: string | null;
  subject_code: string | null;
  contact_number: string | null;
  service_name: string | null;
  title: string;
  type: FollowUpType;
  scheduled_at: string;
  assigned_employee_id: string;
  assigned_employee: EmployeeRef | null;
  status: FollowUpStatus;
  notes: string | null;
  reminder_minutes_before: number | null;
  completed_by_employee_id: string | null;
  completed_by: EmployeeRef | null;
  completed_at: string | null;
  completion_notes: string | null;
}

export interface DocumentVersion {
  id: string;
  document_id: string;
  version: number;
  file_key: string;
  uploaded_by: string;
  uploaded_by_employee: EmployeeRef | null;
  /** True when the future Client Portal delivered this version (§10.5). */
  uploaded_via_portal: boolean;
  uploaded_at: string;
  size_bytes: number;
  notes: string | null;
  previous_version_id: string | null;
  created_at: string;
}

export interface ClientDocument extends Auditable {
  id: string;
  client_id: string;
  client_code: string | null;
  client_name: string | null;
  category_id: string;
  category_code: string | null;
  category_name: string | null;
  client_service_id: string | null;
  name: string;
  financial_year: string | null;
  status: DocumentStatus;
  version: number;
  requested_by_employee_id: string | null;
  requested_by: EmployeeRef | null;
  requested_at: string | null;
  verified_by_employee_id: string | null;
  verified_by: EmployeeRef | null;
  verified_at: string | null;
  rejection_reason: string | null;
  expiry_date: string | null;
  versions: DocumentVersion[];
  /** Present on create — says the portal request went nowhere yet. */
  portal_notice?: string | null;
}

export interface GstFiling extends Auditable {
  id: string;
  gst_profile_id: string;
  period: string;
  return_type: string;
  status: GstFilingStatus;
  filed_at: string | null;
  due_date: string | null;
  assigned_employee_id: string;
  assigned_employee: EmployeeRef | null;
  arn: string | null;
  remarks: string | null;
}

export interface GstProfile extends Auditable {
  id: string;
  client_id: string;
  gstin: string;
  registration_status: string;
  filing_frequency: string;
  registration_date: string | null;
  assigned_employee_id: string;
  assigned_employee: EmployeeRef | null;
  service_status: string;
  last_filed_at: string | null;
  next_due_date: string | null;
  filings: GstFiling[];
}

export interface EwayBill extends Auditable {
  id: string;
  client_id: string;
  ewb_no: string;
  document_no: string;
  document_date: string;
  from_gstin: string | null;
  to_gstin: string | null;
  to_party_name: string | null;
  value_paise: number;
  status: string;
  generated_at: string;
  valid_until: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  generated_by_employee_id: string;
  generated_by: EmployeeRef | null;
  /** Always true in this build — there is no government connectivity. */
  is_simulated: boolean;
}

export interface EwayResponse {
  items: EwayBill[];
  count: number;
  connection: { status: string; is_simulated: boolean; notice: string };
}

export interface Task extends Auditable {
  id: string;
  client_id: string;
  client_service_id: string | null;
  title: string;
  description: string | null;
  assigned_employee_id: string;
  assigned_employee: EmployeeRef | null;
  due_date: string | null;
  status: string;
}

export interface Activity {
  id: string;
  subject_type: string;
  subject_id: string;
  action: string;
  description: string;
  actor_user_id: string | null;
  actor_employee_id: string | null;
  actor: EmployeeRef | null;
  entity_type: string | null;
  entity_id: string | null;
  created_at: string;
}

export interface AssignableEmployee {
  id: string;
  full_name: string;
  employee_code: string;
  designation: string;
}

export interface ListResponse<T> {
  items: T[];
  count: number;
  scope?: Scope;
}

export interface PipelineStage {
  status: LeadStatus;
  label: string;
  count: number;
}

export interface DashboardResponse {
  scope: Scope;
  kpis: {
    total_leads: number;
    new_leads: number;
    active_clients: number;
    follow_ups_today: number;
    pending_follow_ups: number;
    overdue_follow_ups: number;
    active_services: number;
    pending_documents: number;
    services_due_soon: number;
  };
  pipeline: PipelineStage[];
  todays_follow_ups: FollowUp[];
  client_summary: {
    new_clients: number;
    active_clients: number;
    pending_documents: number;
    services_due: number;
    requiring_follow_up: number;
    items: (Client & { pending_document_count: number; pending_follow_up_count: number })[];
  };
}

export interface SearchResponse {
  query: string;
  leads: Lead[];
  clients: Client[];
  services: ClientService[];
  follow_ups: FollowUp[];
  documents: ClientDocument[];
  total: number;
}
