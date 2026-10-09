/**
 * Workstation API types — the exact shapes backend/src/api/workstation.serialize.ts
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
  /** organization → converts into an organization client. */
  lead_type: LeadType;
  /** The person, or the organization's name for an organization lead. */
  name: string;
  /** Organization leads: who we deal with there. */
  contact_person: string | null;
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
  /** Second staff — also sees and works the client. */
  secondary_manager_id: string | null;
  secondary_manager: EmployeeRef | null;
  assigned_team: string | null;
  status: ClientStatus;
  onboarding_date: string;
  notes: string | null;
  source_lead_id: string | null;
  /** An organization: a client that other clients sit under. */
  is_organization: boolean;
  /** Organizations: short label for naming clients ("ABC" → "ABC DV Client 1"). */
  short_name: string | null;
  /** The organization this client belongs to — an extra identifier only. */
  organization_id: string | null;
  organization: OrganizationRef | null;
  portal_enabled: boolean;
  portal_invite_email: string | null;
}

export interface ClientListItem extends Client {
  service_names: string[];
  document_count: number;
  child_client_count: number;
}

export interface ClientDetail extends Client {
  contacts: ClientContact[];
  document_count: number;
  follow_up_count: number;
  /** Organizations: how many of its clients the caller can open. */
  child_client_count: number;
}

export type LeadType = 'individual' | 'organization';

export interface OrganizationRef {
  id: string;
  name: string;
  /** 'CLI-1001' */
  client_id: string;
}

export interface OrganizationClientCard extends Client {
  service_names: string[];
  service_count: number;
  active_service_count: number;
  completed_service_count: number;
  document_count: number;
}

export interface OrganizationOverview {
  organization: Client;
  stats: {
    clients: number;
    active_clients: number;
    inactive_clients: number;
    services: number;
    services_in_progress: number;
    services_not_started: number;
    services_completed: number;
    /** null when the caller cannot read documents. */
    documents: number | null;
    organization_documents: number | null;
  };
  services_by_type: {
    service_id: string;
    name: string;
    client_count: number;
    active: number;
    completed: number;
    clients: { id: string; name: string }[];
  }[];
  clients: OrganizationClientCard[];
  recent_activity: (Activity & { client_id: string; client_name: string | null; is_organization_level: boolean })[];
  next_client_name: string;
}

export type OrganizationDocType = 'gst' | 'eway' | 'einvoice' | 'tds' | 'invoices' | 'returns' | 'other';

export interface OrganizationDocument extends ClientFolderItem {
  client_id: string;
  client_name: string;
  client_code: string;
  is_organization_level: boolean;
  folder_key: string;
  folder_label: string;
  types: OrganizationDocType[];
  uploaded_by: string | null;
}

export interface OrganizationDocuments {
  organization: OrganizationRef;
  clients: { id: string; name: string; client_id: string; is_organization: boolean }[];
  types: { key: OrganizationDocType; label: string }[];
  counts: Record<string, number>;
  items: OrganizationDocument[];
  can_upload: boolean;
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
  /** Who is actually contacted. For an organization's client this is the organization. */
  contact_number: string | null;
  contact_name: string | null;
  contact_email: string | null;
  /** Set when the follow-up goes to the client's organization instead of the client. */
  sent_to_organization: OrganizationRef | null;
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
  /** Date printed on the document, as entered (YYYY-MM-DD). */
  document_date?: string | null;
  /** False for older metadata-only versions with no stored file. */
  has_file?: boolean;
  review_status?: string | null;
  reviewed_at?: string | null;
  review_note?: string | null;
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

// ── Client document folders — every document for one client ─────────────
export type FolderItemOpenable = 'pdf' | 'file' | 'record' | 'missing' | 'none';

export interface ClientFolderItem {
  id: string;
  source: string;
  title: string;
  subtitle: string | null;
  date: string | null;
  status: string | null;
  amount_paise: number | null;
  openable: FolderItemOpenable;
  file_name: string | null;
  mime_type: string | null;
  fields: [string, string][] | null;
  document_id: string | null;
  /** An organization request received for one of its clients. */
  stored_for?: { client_id: string; client_name: string; document_id: string } | null;
}

/** The client's live document link (null when none is active). */
export interface ClientShareLink {
  id: string;
  /** False while turned off — the same URL works again once turned back on. */
  active: boolean;
  paused_at: string | null;
  /** Absolute when the server knows PUBLIC_APP_URL; otherwise a path. */
  url: string;
  absolute: boolean;
  created_at: string;
  last_viewed_at: string | null;
  view_count: number;
}

/** What the client sees through that link — read-only, no internal ids. */
export interface ClientPortalDocuments {
  firm: string | null;
  client: { name: string; code: string; gstin: string | null };
  folders: {
    key: string;
    label: string;
    group: ClientFolder['group'];
    count: number;
    items: Omit<ClientFolderItem, 'document_id' | 'stored_for'>[];
  }[];
  total: number;
  generated_at: string;
}

export interface ClientFolder {
  key: string;
  label: string;
  group: 'compliance' | 'billing' | 'uploads' | 'imports';
  count: number;
  /** The caller may upload files into this folder. */
  can_upload: boolean;
  items: ClientFolderItem[];
}

export interface ClientDocumentFolders {
  folders: ClientFolder[];
  total: number;
  generated_at: string;
}
