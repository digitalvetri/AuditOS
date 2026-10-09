/**
 * Audit files (docs/audit-files/README.md) — the API's shapes.
 *
 * The backend serializes the Prisma columns snake_case, money as `_paise`
 * numbers and calendar dates as 'YYYY-MM-DD' (the workstation.serialize.ts
 * rules). People are ids plus a `*_name` string beside each
 * (backend/src/modules/audit/serialize.ts). Sub-lists come back as arrays;
 * api.ts also accepts `{ items }` so either envelope works.
 */

export type AuditType = 'statutory' | 'tax' | 'internal' | 'stock' | 'bank' | 'gst' | 'concurrent' | 'other';
export type AuditStatus = 'planning' | 'fieldwork' | 'review' | 'reporting' | 'signed' | 'archived';
export type TeamRole = 'partner' | 'manager' | 'senior' | 'assistant' | 'article' | 'eqcr';
export type WpStatus = 'not_started' | 'in_progress' | 'prepared' | 'reviewed';
export type NoteStatus = 'open' | 'responded' | 'cleared';
export type RiskLevel = 'low' | 'medium' | 'high' | 'significant';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type ObsKind = 'query' | 'observation' | 'misstatement' | 'control_deficiency';
export type ReportImpact = 'none' | 'caro' | 'emphasis_of_matter' | 'qualification' | 'management_letter';
export type ObsStatus = 'open' | 'sent_to_client' | 'responded' | 'resolved' | 'carried_forward';
export type ChecklistAnswer = 'yes' | 'no' | 'na' | 'qualified' | 'adverse' | 'pending';
export type OpinionType = 'unmodified' | 'qualified' | 'adverse' | 'disclaimer';
export type MaterialityBenchmark = 'profit_before_tax' | 'revenue' | 'total_assets' | 'equity' | 'expenses' | 'other';

export interface ClientRef {
  id: string;
  company_name: string;
  client_code?: string | null;
  pan?: string | null;
}

/** One reason the file cannot be signed yet. */
export interface Blocker {
  code: string;
  message: string;
  count: number;
  /** e.g. the working-paper refs not reviewed. */
  items: string[];
}

export interface AuditProgress {
  working_papers: { total: number; prepared: number; reviewed: number };
  review_notes_open: number;
  observations_open: number;
  checklist_pending: number;
  team_undeclared: number;
}

/**
 * Optional per-caller counts. Sent with `?mine=1` if the backend computes
 * them; the dashboard falls back to the file-level `progress` when absent.
 */
export interface AuditMine {
  working_papers_to_prepare?: number;
  review_notes_to_respond?: number;
  review_notes_to_clear?: number;
}

export interface AuditMateriality {
  benchmark: MaterialityBenchmark | null;
  base_paise: number | null;
  percent: string | null;
  overall_paise: number | null;
  performance_paise: number | null;
  clearly_trivial_paise: number | null;
  rationale: string | null;
  /** Echoed if the backend keeps them; otherwise derived from the paise. */
  performance_percent?: string | number | null;
  trivial_percent?: string | number | null;
  is_set?: boolean;
}

export interface AuditTeamMember {
  id: string;
  engagement_id?: string;
  employee_id: string;
  employee_name: string | null;
  role: TeamRole;
  is_signing_partner?: boolean;
  is_manager?: boolean;
  independence_declared?: boolean;
  independence_declared_at: string | null;
  independence_note: string | null;
}

export interface AuditListItem {
  id: string;
  audit_code: string;
  client_id: string;
  client: ClientRef | null;
  client_name?: string | null;
  financial_year: string;
  audit_type: AuditType;
  title: string;
  engagement_letter_id: string | null;
  signing_partner_id: string | null;
  signing_partner_name: string | null;
  partner_membership_no: string | null;
  manager_id: string | null;
  manager_name: string | null;
  status: AuditStatus;
  planned_start_date: string | null;
  planned_report_date: string | null;
  report_date: string | null;
  opinion_type: OpinionType | null;
  report_place: string | null;
  assembly_due_date: string | null;
  acceptance_approved_at: string | null;
  acceptance_approved_by: string | null;
  acceptance_approved_by_name?: string | null;
  locked_at: string | null;
  locked: boolean;
  locked_by?: string | null;
  locked_by_name?: string | null;
  /** Null on the missing-UDIN list. */
  progress: AuditProgress | null;
  mine?: AuditMine;
  created_at: string;
  updated_at: string;
}

export interface AuditFile extends AuditListItem {
  team: AuditTeamMember[];
  materiality: AuditMateriality | null;
  /** What still stops signing; empty when ready. */
  blockers: Blocker[];
  can_sign?: boolean;
}

export interface AuditListResponse {
  items: AuditListItem[];
  total?: number;
  count?: number;
}

export interface WorkingPaperFile {
  id: string;
  working_paper_id: string;
  original_name: string;
  mime_type: string | null;
  size_bytes: number;
  sha256: string;
  uploaded_by: string;
  uploaded_by_name?: string | null;
  uploaded_at: string;
  is_addendum: boolean;
}

export interface WorkingPaper {
  id: string;
  engagement_id: string;
  ref: string;
  section: string;
  area: string | null;
  title: string;
  objective: string | null;
  procedure: string | null;
  conclusion: string | null;
  status: WpStatus;
  assigned_to: string | null;
  assigned_to_name: string | null;
  prepared_by: string | null;
  prepared_by_name: string | null;
  prepared_at: string | null;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  is_addendum: boolean;
  addendum_reason: string | null;
  files?: WorkingPaperFile[];
  open_review_notes?: number;
  created_at: string;
  updated_at: string;
}

export interface ReviewNote {
  id: string;
  engagement_id: string;
  working_paper_id: string | null;
  working_paper_ref?: string | null;
  working_paper_title?: string | null;
  note: string;
  raised_by: string;
  raised_by_name: string | null;
  raised_at: string;
  response: string | null;
  responded_by: string | null;
  responded_by_name: string | null;
  responded_at: string | null;
  status: NoteStatus;
  cleared_by: string | null;
  cleared_by_name: string | null;
  cleared_at: string | null;
}

export interface AuditRisk {
  id: string;
  engagement_id: string;
  area: string;
  assertion: string | null;
  description: string;
  level: RiskLevel;
  fraud_risk: boolean;
  response: string | null;
  working_paper_refs: string | null;
  created_at: string;
}

export interface AuditObservation {
  id: string;
  engagement_id: string;
  ref: string;
  title: string;
  description: string;
  area: string | null;
  severity: Severity;
  kind: ObsKind;
  amount_paise: number | null;
  adjusted: boolean | null;
  management_response: string | null;
  report_impact: ReportImpact;
  status: ObsStatus;
  owner_id: string | null;
  owner_name: string | null;
  due_date: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface ChecklistTemplate {
  id: string;
  code: string;
  name: string;
  /** Audit types it is offered for (an array; a comma-separated string is accepted too). */
  applies_to: string[] | string;
  description: string | null;
  source: string | null;
  is_active?: boolean;
  applicable?: boolean;
  item_count?: number;
}

export interface ChecklistItem {
  clause: string;
  heading: string;
  guidance: string | null;
  sort_order: number;
  answer: ChecklistAnswer;
  remarks: string | null;
  working_paper_ref: string | null;
  prepared_by: string | null;
  prepared_by_name: string | null;
  prepared_at: string | null;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
}

export interface ChecklistResponse {
  template: ChecklistTemplate;
  items: ChecklistItem[];
  counts: { total: number; pending: number; answered?: number; reviewed: number };
}

export interface AuditUdin {
  id: string;
  engagement_id: string | null;
  audit_code?: string | null;
  client_id: string;
  client_name: string | null;
  udin: string;
  document_type: string;
  document_description: string | null;
  document_date: string;
  partner_id: string | null;
  partner_name: string | null;
  membership_no: string | null;
  generated_on: string;
  revoked?: boolean;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
}

/** Signed files with a report date and no live UDIN — the file shape without progress. */
export type MissingUdin = AuditListItem;

/** Sent with every write once the file is locked (SA 230 para A24). */
export interface AddendumFields {
  addendum?: true;
  addendum_reason?: string;
}
