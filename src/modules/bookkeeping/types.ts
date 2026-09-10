/** Wire types for the Bookkeeping Service API. snake_case, as the server sends. */
export interface EmployeeRef { id: string; full_name: string; employee_code: string }

export interface Progress {
  total: number; completed: number; pending: number; overdue: number; percent: number;
}

export interface Kpis {
  total_clients: number; in_progress: number; pending_items: number; due_this_month: number;
  completed_this_month: number; overdue_tasks: number; awaiting_documents: number;
  awaiting_bank_statements: number; pending_review: number;
}

export interface Period {
  id: string; engagement_id: string; client_id: string | null; client_name: string | null;
  year: number; month: number; label: string; status: string; due_date: string | null;
  completed_date: string | null; assigned_employee: EmployeeRef | null; notes: string | null;
  progress: Progress | null; created_at: string | null;
}

export interface Engagement {
  id: string; client_id: string; client_name: string | null; client_code: string | null;
  status: string; service_start_date: string; assigned_employee: EmployeeRef | null;
  billing_frequency: string; next_due_date: string | null; notes: string | null;
}

export interface BookkeepingClient extends Engagement {
  current_period: string | null; current_period_id: string | null;
  current_period_status: string | null; pending_items: number; books_org_id: string | null;
}

export interface ChecklistItem {
  id: string; period_id: string; label: string; status: string; sort_order: number;
  notes: string | null; completed_at: string | null; completed_by: EmployeeRef | null;
}

export interface Task {
  id: string; period_id: string | null; period_label: string | null; client_id: string;
  client_name: string | null; title: string; description: string | null; category: string;
  priority: string; status: string; assigned_employee: EmployeeRef | null;
  due_date: string | null; completed_at: string | null; notes: string | null;
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

export interface ListResponse<T> { items: T[]; count: number; scope?: string }

export interface OverviewResponse { kpis: Kpis; upcoming: Period[]; scope: string }

export interface ClientDetailResponse {
  engagement: Engagement; periods: Period[]; books_org_id: string | null;
  workflow_steps: string[];
}

export interface PeriodDetailResponse {
  period: Period; checklist: ChecklistItem[]; tasks: Task[];
  pending_items: PendingItem[]; document_requests: DocumentRequest[];
  deliverables: Deliverable[]; workflow_steps: string[];
}

export interface SettingsResponse {
  engagement_statuses: string[]; billing_frequencies: string[]; period_statuses: string[];
  checklist_statuses: string[]; task_statuses: string[]; task_categories: string[];
  priorities: string[]; pending_statuses: string[]; pending_categories: string[];
  document_types: string[]; docreq_statuses: string[]; deliverable_types: string[];
  deliverable_statuses: string[]; workflow_steps: string[]; checklist_template: string[];
}
