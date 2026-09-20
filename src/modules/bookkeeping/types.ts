/** Wire types for the Bookkeeping Service API. snake_case, as the server sends. */
export interface EmployeeRef { id: string; full_name: string; employee_code: string }

export interface Progress {
  total: number; completed: number; pending: number; overdue: number; percent: number;
}

/**
 * OVERVIEW tile counts (spec §6.1). Each is a database aggregate over the
 * caller's visible clients and is also the filter shortcut that produces
 * the table below.
 */
export interface OverviewTiles {
  overdue: number; blocked: number; due_soon: number; review: number; closed: number;
}

export interface Period {
  id: string; engagement_id: string; client_id: string | null; client_name: string | null;
  year: number; month: number; label: string;
  /** Calendar window of the period; derived from year+month+engagement frequency. */
  period_start: string | null; period_end: string | null;
  status: string; due_date: string | null;
  completed_date: string | null; assigned_employee: EmployeeRef | null; notes: string | null;
  progress: Progress | null; created_at: string | null;
}

export interface Engagement {
  id: string; client_id: string; client_name: string | null; client_code: string | null;
  status: string; service_start_date: string; assigned_employee: EmployeeRef | null;
  billing_frequency: string;
  /** Days after period_end at which the period defaults to due. Per-client. */
  due_offset_days: number;
  next_due_date: string | null; notes: string | null;
}

export interface BookkeepingClient extends Engagement {
  current_period: string | null; current_period_id: string | null;
  current_period_status: string | null; pending_items: number; books_org_id: string | null;
}

export interface WorkflowStage {
  id: string; sequence: number; name: string; slug: string;
  default_category: string; default_offset_days: number;
  gate_rule_slug: string | null; is_active: boolean;
}

export interface Task {
  id: string; period_id: string | null; period_label: string | null; client_id: string;
  client_name: string | null; title: string; description: string | null; category: string;
  priority: string; status: string; assigned_employee: EmployeeRef | null;
  due_date: string | null; completed_at: string | null; completed_by: EmployeeRef | null;
  notes: string | null;
  /**
   * The workflow stage this task represents. `null` for ad-hoc tasks that
   * live on the period outside the standard monthly workflow.
   */
  stage_id: string | null;
  stage: { id: string; slug: string; name: string; sequence: number } | null;
}

export interface PendingItem {
  id: string; period_id: string | null; period_label: string | null; client_id: string;
  client_name: string | null; title: string; description: string | null; category: string;
  priority: string; status: string; requested_date: string; due_date: string | null;
  resolved_date: string | null; assigned_employee: EmployeeRef | null;
}

export interface DocumentRequest {
  id: string; period_id: string | null; period_label: string | null; client_id: string;
  client_name: string | null; document_type: string; description: string | null;
  status: string; requested_at: string | null; due_date: string | null;
  received_at: string | null; client_document_id: string | null;
  client_document: { id: string; name: string; status: string } | null;
}

export interface Deliverable {
  id: string; period_id: string | null; period_label: string | null; client_id: string;
  client_name: string | null; type: string; status: string;
  prepared_by: EmployeeRef | null; reviewed_by: EmployeeRef | null;
  approved_at: string | null; delivered_at: string | null; notes: string | null;
}

export interface Reminder {
  id: string; client_id: string | null; client_name: string | null; title: string;
  type: string; scheduled_at: string; status: string; notes: string | null;
  assigned_employee: EmployeeRef | null;
}

export interface Activity {
  id: string; client_id: string; period_id: string | null; period_label: string | null;
  action: string; detail: string | null; created_at: string | null;
}

/**
 * A file the firm pulled into a period (spec §4.2 / §6.4). Append-only:
 * a re-import creates a new record, never overwriting. `status` records
 * the outcome of the two blocking validations (period + company).
 */
export type ImportKind = 'trial_balance' | 'day_book' | 'outstandings' | 'bank_statement';
export type ImportStatus =
  | 'imported'
  | 'rejected_period_mismatch'
  | 'rejected_company_mismatch'
  | 'parse_failed';

export interface Import {
  id: string;
  period_id: string;
  client_id: string;
  kind: ImportKind;
  source: 'upload' | 'email' | 'agent';
  original_filename: string;
  file_size: number;
  mime_type: string;
  company_name_in_file: string;
  period_from_in_file: string;
  period_to_in_file: string;
  row_count: number | null;
  status: ImportStatus;
  error_detail: string | null;
  imported_at: string | null;
  imported_by: EmployeeRef | null;
}

export interface ListResponse<T> { items: T[]; count: number; scope?: string }

/**
 * Clients period grid (spec §6.2) — clients down, months across. Each cell
 * carries the period_id if that month is open (so it can navigate straight
 * to Monthly Work) plus enough state to render one of four glyphs:
 *   ✓ closed · ▍ open/overdue · · in progress · blank not started
 */
export interface GridMonth { year: number; month: number; label: string }
export interface GridCell {
  year: number; month: number;
  period_id: string | null;
  status: string | null;    // period status; null when the period has not been opened yet
  is_overdue: boolean;
}
export interface GridRow {
  client_id: string;
  client_name: string | null;
  client_code: string | null;
  engagement_id: string;
  owner: EmployeeRef | null;
  cells: GridCell[];
}
export interface GridResponse {
  fy: number;              // starting calendar year — 2026 = FY 2026-27
  fy_label: string;        // "2026-27"
  months: GridMonth[];     // 12 entries, Apr → Mar
  rows: GridRow[];
  scope?: string;
}

/**
 * A period on the Overview table, shown as one row with the current
 * (earliest incomplete) stage and a blocked-task tally.
 */
export interface OverviewPeriodRow extends Period {
  current_stage: { id: string; slug: string; name: string; sequence: number } | null;
  blocked_count: number;
}

export type OverviewGroup = 'period' | 'task';

export interface OverviewResponse {
  tiles: OverviewTiles;
  group: OverviewGroup;
  rows: OverviewPeriodRow[] | Task[];
  count: number;
  scope: string;
}

export interface ClientDetailResponse {
  engagement: Engagement; periods: Period[]; books_org_id: string | null;
  workflow_stages: WorkflowStage[];
  /** @deprecated use workflow_stages */ workflow_steps: string[];
}

export interface PeriodDetailResponse {
  period: Period; tasks: Task[];
  pending_items: PendingItem[]; document_requests: DocumentRequest[];
  deliverables: Deliverable[];
  imports: Import[];
  workflow_stages: WorkflowStage[];
  /** @deprecated use workflow_stages */ workflow_steps: string[];
}

// ── Reports (spec §6.5) ─────────────────────────────────────────────────
export type ReportKind = 'trial_balance' | 'profit_and_loss' | 'balance_sheet' | 'debtors' | 'creditors';

export interface ReportLine {
  ledger_name: string;
  parent_group: string;
  category: string;
  subtype: string;
  opening: string;   // rupees.paise as string, e.g. "1500.00"
  debit: string;
  credit: string;
  closing: string;
}

export interface ReportSection {
  label: string;
  lines: ReportLine[];
  total_paise: string;
}

export interface ReportView {
  available: true;
  as_of_period_end: string | null;
  imported_at: string | null;
  imported_by: string | null;
  sections: ReportSection[];
  totals: Record<string, string>;
}

export interface UnavailableReport {
  available: false;
  missing_import: 'trial_balance';
  message: string;   // verbatim spec §6.5 empty-state text
}

export type ReportEntry = ReportView | UnavailableReport;

export interface ReportsResponse {
  reports: Record<ReportKind, ReportEntry>;
}

export interface SettingsResponse {
  engagement_statuses: string[]; billing_frequencies: string[]; period_statuses: string[];
  task_statuses: string[]; task_categories: string[];
  priorities: string[]; pending_statuses: string[]; pending_categories: string[];
  document_types: string[]; docreq_statuses: string[]; deliverable_types: string[];
  deliverable_statuses: string[]; workflow_stages: WorkflowStage[];
  /** @deprecated use workflow_stages */ workflow_steps: string[];
}
