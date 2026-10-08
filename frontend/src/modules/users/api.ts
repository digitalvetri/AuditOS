import { api } from '@/services/api';

export interface UserRow {
  id: string;
  email: string;
  full_name: string | null;
  role: { id: string; code: string; name: string };
  is_active: boolean;
  last_login_at: string | null;
  employee_id: string | null;
  must_change_password: boolean;
}
export interface EmployeeWithoutLogin { id: string; full_name: string; email: string }
export interface RoleOption { id: string; code: string; name: string }

export interface NewUser {
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  joining_date?: string;
  role_id: string;
  temp_password: string;
}

export const usersApi = {
  list: () => api.get<{ items: UserRow[]; employees_without_login: EmployeeWithoutLogin[] }>('/api/users'),
  roles: () => api.get<{ items: RoleOption[] }>('/api/users/roles'),
  create: (body: NewUser) => api.post<{ user: UserRow }>('/api/users', body),
  createFromEmployee: (employeeId: string, body: { role_id: string; temp_password: string }) =>
    api.post<{ user: UserRow }>(`/api/users/from-employee/${employeeId}`, body),
  patch: (id: string, body: { role_id?: string; is_active?: boolean }) =>
    api.patch<{ user: UserRow }>(`/api/users/${id}`, body),
  resetPassword: (id: string, temp_password: string) =>
    api.post<{ user: UserRow }>(`/api/users/${id}/reset-password`, { temp_password }),
};
