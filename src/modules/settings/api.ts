import { api } from '@/services/api';
import type {
  Department,
  Designation,
  ExpenseCategory,
  Holiday,
  LeaveType,
  Permission,
  Role,
  RoleCode,
  StatutoryRate,
  WorkLocation,
  WorkSchedule,
} from '@/data/models';
import type { Grant, Scope } from '@/platform/rbac/matrix';

export const settingsApi = {
  departments: {
    list: () => api.get<{ items: Department[] }>('/api/settings/departments'),
    create: (body: Partial<Department>) => api.post<{ department: Department }>('/api/settings/departments', body),
    patch: (id: string, body: Partial<Department>) => api.patch<{ department: Department }>(`/api/settings/departments/${id}`, body),
    delete: (id: string) => api.delete<{ ok: true }>(`/api/settings/departments/${id}`),
  },
  designations: {
    list: () => api.get<{ items: Designation[] }>('/api/settings/designations'),
    create: (body: Partial<Designation>) => api.post<{ designation: Designation }>('/api/settings/designations', body),
    patch: (id: string, body: Partial<Designation>) => api.patch<{ designation: Designation }>(`/api/settings/designations/${id}`, body),
    delete: (id: string) => api.delete<{ ok: true }>(`/api/settings/designations/${id}`),
  },
  workLocations: {
    list: () => api.get<{ items: WorkLocation[] }>('/api/settings/work-locations'),
    create: (body: Partial<WorkLocation>) => api.post<{ workLocation: WorkLocation }>('/api/settings/work-locations', body),
    patch: (id: string, body: Partial<WorkLocation>) => api.patch<{ workLocation: WorkLocation }>(`/api/settings/work-locations/${id}`, body),
  },
  workSchedules: {
    list: () => api.get<{ items: WorkSchedule[] }>('/api/settings/work-schedules'),
  },
  holidays: {
    list: () => api.get<{ items: Holiday[] }>('/api/settings/holidays'),
    create: (body: Partial<Holiday>) => api.post<{ holiday: Holiday }>('/api/settings/holidays', body),
    delete: (id: string) => api.delete<{ ok: true }>(`/api/settings/holidays/${id}`),
  },
  leaveTypes: {
    list: () => api.get<{ items: LeaveType[] }>('/api/settings/leave-types'),
    patch: (id: string, body: Partial<LeaveType>) => api.patch<{ leaveType: LeaveType }>(`/api/settings/leave-types/${id}`, body),
  },
  expenseCategories: {
    list: () => api.get<{ items: ExpenseCategory[] }>('/api/settings/expense-categories'),
    create: (body: Partial<ExpenseCategory>) => api.post<{ category: ExpenseCategory }>('/api/settings/expense-categories', body),
    patch: (id: string, body: Partial<ExpenseCategory>) => api.patch<{ category: ExpenseCategory }>(`/api/settings/expense-categories/${id}`, body),
  },
  statutoryRates: {
    list: () => api.get<{ items: StatutoryRate[] }>('/api/settings/statutory-rates'),
    supersede: (body: Partial<StatutoryRate>) => api.post<{ rate: StatutoryRate }>('/api/settings/statutory-rates', body),
  },
  roles: {
    get: () => api.get<{
      roles: Role[];
      permissions: Permission[];
      matrix: Record<RoleCode, Grant[]>;
    }>('/api/settings/roles'),
    /** null scope revokes the grant. Any other scope grants or upserts it. */
    setGrant: (roleId: string, permissionCode: string, scope: Scope | null) =>
      api.put<{ role: Role; grant: Grant | null }>(
        `/api/settings/roles/${roleId}/permissions/${encodeURIComponent(permissionCode)}`,
        { scope },
      ),
  },
};
