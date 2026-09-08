/**
 * Employees client — typed wrapper over the api adapter.
 *
 * Note: the shape returned by GET /employees depends on the caller's role
 * (Finance receives a strict 6-field projection). We type as a union.
 */
import { api } from '@/services/api';
import type { ArticledTraining, AuditLog, Employee } from '@/data/models';
import type { FinanceProjection } from '@/data/mock/handlers/employees';

export type EmployeeRow = (Employee | FinanceProjection) & {
  today_attendance?: {
    status: string;
    check_in_at: string | null;
    check_out_at: string | null;
    worked_minutes: number | null;
  } | null;
};

export interface EmployeeFilters {
  departmentId?: string;
  designationId?: string;
  type?: string;
  status?: string;
  managerId?: string;
  joinedFrom?: string;
  joinedTo?: string;
  q?: string;
  includeInactive?: boolean;
}

export interface EmployeeListResponse {
  items: EmployeeRow[];
  count: number;
  scope: 'self' | 'department' | 'organisation' | 'finance';
}

export interface EmployeeCreateInput {
  first_name: string;
  last_name: string;
  email: string;
  department_id: string;
  designation_id: string;
  type?: Employee['type'];
  status?: Employee['status'];
  manager_id?: string | null;
  phone?: string;
  joining_date?: string;
}

export interface EmployeeDetailResponse {
  employee: EmployeeRow;
  refs: {
    department: { id: string; name: string } | null;
    designation: { id: string; name: string } | null;
    manager: { id: string; full_name: string; employee_code: string } | null;
    location: { id: string; name: string } | null;
  };
}

export const employeeApi = {
  list: (filters: EmployeeFilters = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== '' && v !== false) p.set(k, String(v));
    }
    const qs = p.toString();
    return api.get<EmployeeListResponse>(`/api/employees${qs ? `?${qs}` : ''}`);
  },

  get: (id: string) => api.get<EmployeeDetailResponse>(`/api/employees/${id}`),

  /** POST /api/employees — HR/MD only; the server allocates the employee code. */
  create: (body: EmployeeCreateInput) => api.post<{ employee: Employee }>('/api/employees', body),

  patch: (id: string, body: Partial<Employee>) =>
    api.patch<{ employee: Employee }>(`/api/employees/${id}`, body),

  deactivate: (id: string) =>
    api.post<{ employee: Employee }>(`/api/employees/${id}/deactivate`),

  training: (id: string) =>
    api.get<{
      training: ArticledTraining;
      principal: { id: string; full_name: string; employee_code: string } | null;
    }>(`/api/employees/${id}/training`),

  updateTraining: (id: string, body: Partial<ArticledTraining>) =>
    api.patch<{ training: ArticledTraining }>(`/api/employees/${id}/training`, body),

  activity: (employeeId: string) =>
    api.get<{ items: AuditLog[]; count: number }>(
      `/api/audit-logs?entity_type=Employee&entity_id=${encodeURIComponent(employeeId)}`,
    ),
};

// Helper: guard the projection difference at usage sites.
export function isFullEmployee(row: EmployeeRow): row is Employee & { today_attendance?: EmployeeRow['today_attendance'] } {
  return 'email' in row;
}
