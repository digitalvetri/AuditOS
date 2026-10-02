/**
 * Attendance module client. Thin typed wrapper over the api adapter.
 * All server logic lives in the handlers — this file only shapes requests.
 */
import { api } from '@/services/api';
import type { Attendance, AttendanceCorrection, AttendanceStatus, LocationType } from '@/data/models';

export interface CheckInPayload {
  latitude: number;
  longitude: number;
  accuracy_m: number;
  location_type?: LocationType;
  off_site_reason?: string;
}

export interface AttendanceWithEmployee extends Attendance {
  employee: {
    id: string;
    full_name: string;
    employee_code: string;
    department_id: string;
  } | null;
}

export interface CorrectionWithEmployee extends AttendanceCorrection {
  employee: { id: string; full_name: string; employee_code: string } | null;
}

export interface TodayResponse {
  today: Attendance | null;
  counts: {
    total: number;
    present: number;
    late: number;
    absent: number;
    wfh: number;
    on_leave: number;
    missing_check_in: number;
    missing_check_out: number;
  } | null;
  scope: 'self' | 'department' | 'organisation';
}

export interface ListResponse {
  items: AttendanceWithEmployee[];
  count: number;
  scope: 'self' | 'department' | 'organisation';
}

export interface CorrectionsListResponse {
  items: CorrectionWithEmployee[];
  count: number;
}

export const attendanceApi = {
  today: () => api.get<TodayResponse>('/api/attendance/today'),

  checkIn: (p: CheckInPayload) =>
    api.post<{ attendance: Attendance; location: { id: string | null; name: string | null } }>(
      '/api/attendance/check-in',
      p,
    ),

  checkOut: (p: CheckInPayload) =>
    api.post<{ attendance: Attendance }>('/api/attendance/check-out', p),

  list: (q: {
    from?: string;
    to?: string;
    employeeId?: string;
    departmentId?: string;
    status?: AttendanceStatus | '';
    locationType?: LocationType | '';
  }) => {
    const params = new URLSearchParams();
    if (q.from) params.set('from', q.from);
    if (q.to) params.set('to', q.to);
    if (q.employeeId) params.set('employeeId', q.employeeId);
    if (q.departmentId) params.set('departmentId', q.departmentId);
    if (q.status) params.set('status', q.status);
    if (q.locationType) params.set('locationType', q.locationType);
    const qs = params.toString();
    return api.get<ListResponse>(`/api/attendance${qs ? `?${qs}` : ''}`);
  },

  requestCorrection: (p: {
    date: string;
    requested_check_in_at?: string;
    requested_check_out_at?: string;
    reason: string;
  }) => api.post<{ correction: AttendanceCorrection }>('/api/attendance/corrections', p),

  listCorrections: (status?: 'pending' | 'approved' | 'rejected') => {
    const qs = status ? `?status=${status}` : '';
    return api.get<CorrectionsListResponse>(`/api/attendance/corrections${qs}`);
  },

  approveCorrection: (id: string) =>
    api.post<{ correction: AttendanceCorrection }>(`/api/attendance/corrections/${id}/approve`),

  rejectCorrection: (id: string, notes: string) =>
    api.post<{ correction: AttendanceCorrection }>(
      `/api/attendance/corrections/${id}/reject`,
      { notes },
    ),
};
