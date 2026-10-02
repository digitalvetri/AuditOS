/**
 * Leave module client — thin typed wrapper. Server owns all validation and
 * routing decisions; this file just shapes requests.
 */
import { api } from '@/services/api';
import type { Holiday, LeaveRequest, LeaveType } from '@/data/models';

export interface RequestWithEmp extends LeaveRequest {
  employee: { id: string; full_name: string; employee_code: string } | null;
  type: { id: string; name: string; code: string } | null;
  stage: 'awaiting_manager' | 'awaiting_hr' | 'terminal';
}

export interface BalanceRow {
  type: LeaveType;
  entitled: number;
  availed: number;
  carried_forward: number;
  pending: number;
}

export const leaveApi = {
  holidays: () => api.get<{ items: Holiday[] }>('/api/leaves/holidays'),

  balances: (employeeId: string) =>
    api.get<{ items: BalanceRow[] }>(`/api/leaves/balances/${employeeId}`),

  list: (opts?: { employeeId?: string; status?: LeaveRequest['status']; queue?: boolean }) => {
    const p = new URLSearchParams();
    if (opts?.employeeId) p.set('employeeId', opts.employeeId);
    if (opts?.status) p.set('status', opts.status);
    if (opts?.queue) p.set('scope', 'queue');
    const qs = p.toString();
    return api.get<{ items: RequestWithEmp[]; count: number }>(
      `/api/leaves${qs ? `?${qs}` : ''}`,
    );
  },

  get: (id: string) =>
    api.get<{ request: RequestWithEmp }>(`/api/leaves/${id}`),

  apply: (p: {
    leave_type_id: string;
    start_date: string;
    end_date: string;
    half_day: boolean;
    reason: string;
  }) => api.post<{ request: RequestWithEmp }>(`/api/leaves`, p),

  approve: (id: string) =>
    api.post<{ request: RequestWithEmp }>(`/api/leaves/${id}/approve`),

  reject: (id: string, reason: string) =>
    api.post<{ request: RequestWithEmp }>(`/api/leaves/${id}/reject`, { reason }),

  cancel: (id: string) =>
    api.post<{ request: RequestWithEmp }>(`/api/leaves/${id}/cancel`),
};
