import { api } from '@/services/api';

/**
 * Task API client. Goes through the one adapter in services/api.ts like the
 * rest of Workstation.
 *
 * Note what is NOT here: no call sends a timestamp or a duration. Start,
 * pause, resume and complete are POSTs with no meaningful body — the server
 * supplies the clock, which is why the tracked time cannot be edited from
 * the browser.
 */

export type TaskStatus = 'pending' | 'in_progress' | 'paused' | 'completed' | 'cancelled';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  raw_status: string;
  priority: TaskPriority;
  overdue: boolean;
  assigned_employee_id: string;
  assigned_employee_name: string;
  assigned_by_id: string | null;
  assigned_by_name: string | null;
  client_id: string | null;
  client_name: string | null;
  project_id: string | null;
  project_name: string | null;
  due_date: string | null;
  estimated_minutes: number | null;
  actual_minutes: number;
  actual_seconds: number;
  pause_minutes: number;
  elapsed_minutes: number;
  variance_minutes: number | null;
  running: boolean;
  current_session_started_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  notes: string | null;
  attachment_url: string | null;
  session_count: number;
  created_at: string;
  updated_at: string;
}

export interface TaskSession {
  id: string;
  employee_id: string;
  employee_name: string;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
  opened_by: string;
  closed_by: string | null;
  open: boolean;
}

export interface TaskTimelineEntry {
  id: string;
  action: string;
  at: string;
  by: string;
  old_status: string | null;
  new_status: string | null;
  meta: unknown;
}

export interface TaskDetail {
  task: Task;
  sessions: TaskSession[];
  timeline: TaskTimelineEntry[];
}

export interface TaskDashboard {
  period: { from: string | null; to: string | null };
  totals: {
    total: number; pending: number; in_progress: number; paused: number;
    completed: number; cancelled: number; overdue: number; active_employees: number;
    total_work_minutes: number; total_pause_minutes: number;
    average_completion_minutes: number; completed_work_minutes: number;
  };
  by_priority: { priority: string; count: number }[];
  by_status: { status: string; count: number }[];
  estimated_vs_actual: { estimated_minutes: number; actual_minutes: number; variance_minutes: number };
}

export interface EmployeeWorkRow {
  employee_id: string; employee_name: string; employee_code: string; department: string | null;
  total: number; pending: number; in_progress: number; paused: number; completed: number;
  cancelled: number; overdue: number; work_minutes: number; estimated_minutes: number;
  average_task_minutes: number; variance_minutes: number | null;
}

export interface DimensionRow {
  id: string | null; label: string; total: number; completed: number;
  work_minutes: number; estimated_minutes: number;
}

export interface EstimatedVsActual {
  items: {
    task_id: string; title: string; employee_id: string; employee_name: string; priority: string;
    estimated_minutes: number; actual_minutes: number; variance_minutes: number; completed_at: string | null;
  }[];
  totals: { count: number; estimated_minutes: number; actual_minutes: number; under: number; over: number; on_estimate: number };
  note: string;
}

export interface TaskFilters extends Record<string, string | number | boolean | null | undefined> {
  status?: string; priority?: string; employee_id?: string; client_id?: string; project_id?: string;
  due_from?: string; due_to?: string; created_from?: string; created_to?: string;
  overdue?: boolean; q?: string; sort?: string; limit?: number; offset?: number;
}

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  assigned_employee_id: string;
  priority: TaskPriority;
  due_date: string;
  client_id?: string | null;
  project_id?: string | null;
  estimated_minutes?: number | null;
  notes?: string | null;
}

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const tasksApi = {
  list: (f: TaskFilters = {}) =>
    api.get<{ items: Task[]; total: number; limit: number; offset: number }>(`/api/tasks${qs(f)}`),
  get: (id: string) => api.get<TaskDetail>(`/api/tasks/${id}`),
  create: (input: CreateTaskInput) => api.post<TaskDetail>('/api/tasks', input),
  update: (id: string, patch: Partial<CreateTaskInput>) => api.patch<TaskDetail>(`/api/tasks/${id}`, patch),
  reassign: (id: string, employeeId: string, reason?: string) =>
    api.post<TaskDetail>(`/api/tasks/${id}/reassign`, { employee_id: employeeId, reason: reason ?? null }),

  // The clock. No body carries a time.
  start: (id: string) => api.post<TaskDetail>(`/api/tasks/${id}/start`, {}),
  pause: (id: string) => api.post<TaskDetail>(`/api/tasks/${id}/pause`, {}),
  resume: (id: string) => api.post<TaskDetail>(`/api/tasks/${id}/resume`, {}),
  complete: (id: string, note?: string) => api.post<TaskDetail>(`/api/tasks/${id}/complete`, { note: note ?? null }),
  cancel: (id: string, reason?: string) => api.post<TaskDetail>(`/api/tasks/${id}/cancel`, { reason: reason ?? null }),
  reopen: (id: string, reason?: string) => api.post<TaskDetail>(`/api/tasks/${id}/reopen`, { reason: reason ?? null }),

  assignableEmployees: () =>
    api.get<{ items: { id: string; name: string; code: string; department: string | null }[] }>('/api/tasks/assignable-employees'),

  dashboard: (f: { from?: string; to?: string; employee_id?: string } = {}) =>
    api.get<TaskDashboard>(`/api/tasks/reports/dashboard${qs(f)}`),
  byEmployee: (f: { from?: string; to?: string } = {}) =>
    api.get<{ items: EmployeeWorkRow[] }>(`/api/tasks/reports/by-employee${qs(f)}`),
  byClient: (f: { from?: string; to?: string } = {}) =>
    api.get<{ items: DimensionRow[] }>(`/api/tasks/reports/by-client${qs(f)}`),
  byProject: (f: { from?: string; to?: string } = {}) =>
    api.get<{ items: DimensionRow[] }>(`/api/tasks/reports/by-project${qs(f)}`),
  estimatedVsActual: (f: { from?: string; to?: string; employee_id?: string } = {}) =>
    api.get<EstimatedVsActual>(`/api/tasks/reports/estimated-vs-actual${qs(f)}`),
  timesheet: (f: { from?: string; to?: string; employee_id?: string } = {}) =>
    api.get<{ days: { date: string; minutes: number; sessions: number; employees: number }[]; total_minutes: number }>(`/api/tasks/reports/timesheet${qs(f)}`),
};

/**
 * Tracked time as words. Under a minute it reads in seconds, so a short
 * session shows "48s" rather than rounding away to nothing — the stored
 * record is still whole minutes.
 */
export function formatWorked(minutes: number, seconds?: number): string {
  if (seconds !== undefined && seconds > 0 && seconds < 60) return `${seconds}s`;
  return formatMinutes(minutes);
}

/** 135 → "2h 15m". The one place minutes become words. */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m === 0) return '—';
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}m`;
  if (rem === 0) return `${h}h`;
  return `${h}h ${rem}m`;
}

/** Signed variance, e.g. "+1h" over or "−30m" under. */
export function formatVariance(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes === 0) return 'on estimate';
  return `${minutes > 0 ? '+' : '−'}${formatMinutes(Math.abs(minutes))}`;
}

export const PRIORITY_LABEL: Record<string, string> = {
  low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent',
};

export const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending', in_progress: 'In progress', paused: 'Paused',
  completed: 'Completed', cancelled: 'Cancelled',
};
