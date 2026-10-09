/**
 * Employees client — typed wrapper over the api adapter.
 *
 * Note: the shape returned by GET /employees depends on the caller's role
 * (Finance receives a strict 6-field projection). We type as a union.
 */
import { api } from '@/services/api';
import { can } from '@/platform/rbac/can';
import type { ArticledTraining, AuditLog, Employee, RoleCode } from '@/data/models';

/**
 * Hourly staff cost for profitability (paise). Returned by GET / accepted by
 * PATCH only for payroll/finance callers — absent from the payload otherwise.
 */
export interface EmployeeCostRate {
  cost_rate_paise_per_hour?: number | null;
}

/** May this role see/set an employee's hourly cost rate? */
export function canSeeCostRate(roleCode: RoleCode | undefined): boolean {
  return can(roleCode, 'payroll.view', 'organisation')
    || can(roleCode, 'reports.finance', 'organisation')
    || can(roleCode, 'reports.all', 'organisation');
}

/** Rupee text field → paise (blank → null). NaN-safe: bad input → null. */
export function rupeesToPaise(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/** The reduced employee row a finance-only viewer receives. */
export interface FinanceProjection {
  id: string;
  employee_code: string;
  full_name: string;
  department_id: string | null;
  designation_id: string | null;
  bank_account_masked: string | null;
  status: Employee['status'];
}

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
  type?: Employee['type'];
  status?: Employee['status'];
  manager_id?: string | null;
  phone?: string;
  joining_date?: string;
  /** Covered under PF (default true). Ignored for articled assistants. */
  pf_applicable?: boolean;
  /** Role for the login created with the employee (never Super Admin). */
  role_code?: string;
  /** Set by the admin; left out, the server generates one. */
  password?: string;
}

/** Shown once after the password is set; it can't be fetched again. */
export interface CreatedLogin {
  email: string;
  role: string;
  password: string;
  generated: boolean;
}

export interface EmployeeDetailResponse {
  employee: EmployeeRow;
  refs: {
    department: { id: string; name: string } | null;
    designation: { id: string; name: string } | null;
    manager: { id: string; full_name: string; employee_code: string } | null;
    location: { id: string; name: string } | null;
    /** The employee's login role; null when they have no login. */
    role: { id: string; code: string; name: string } | null;
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
  create: (body: EmployeeCreateInput) => api.post<{ employee: Employee; login: CreatedLogin }>('/api/employees', body),

  patch: (id: string, body: Partial<Employee> & EmployeeCostRate) =>
    api.patch<{ employee: Employee }>(`/api/employees/${id}`, body),

  /** Move the employee's login to another role (Super Admin … Intern). */
  /** Set or reset the password; creates the login if the employee has none. */
  setPassword: (id: string, body: { password?: string; role_code?: string }) =>
    api.put<{ created: boolean; login: CreatedLogin }>(`/api/employees/${id}/password`, body),
  setRole: (id: string, roleId: string) =>
    api.put<{ role: { id: string; code: string; name: string } }>(`/api/employees/${id}/role`, { role_id: roleId }),

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
