import { api } from '@/services/api';
import type { DocumentType, EmployeeDocument } from '@/data/models';

export interface DocumentWithEmp extends EmployeeDocument {
  employee: { id: string; full_name: string; employee_code: string } | null;
  uploader_label: string;
}

export interface DocumentsListResponse {
  items: DocumentWithEmp[];
  count: number;
  scope: 'self' | 'department' | 'organisation';
}

export const documentsApi = {
  list: (filters: {
    employeeId?: string;
    type?: DocumentType | '';
    status?: EmployeeDocument['status'] | '';
    expiringWithinDays?: number;
  } = {}) => {
    const p = new URLSearchParams();
    if (filters.employeeId) p.set('employeeId', filters.employeeId);
    if (filters.type) p.set('type', filters.type);
    if (filters.status) p.set('status', filters.status);
    if (filters.expiringWithinDays) p.set('expiringWithinDays', String(filters.expiringWithinDays));
    const qs = p.toString();
    return api.get<DocumentsListResponse>(`/api/documents${qs ? `?${qs}` : ''}`);
  },

  upload: (body: {
    name: string;
    type: DocumentType;
    employee_id: string;
    expiry_date?: string | null;
  }) => api.post<{ document: DocumentWithEmp }>('/api/documents', body),

  delete: (id: string) => api.delete<void>(`/api/documents/${id}`),

  /** Two-step "signed URL" flow: fetch URL + token, then browser navigates. */
  downloadUrl: (id: string) =>
    api.get<{ url: string; expires_at: string }>(`/api/documents/${id}/download-url`),
};
