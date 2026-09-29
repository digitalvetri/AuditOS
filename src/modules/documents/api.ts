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

  /** Uploads the file itself (multipart) with its details. */
  upload: (body: {
    name: string;
    type: DocumentType;
    employee_id: string;
    expiry_date?: string | null;
    file: File;
  }) => {
    const form = new FormData();
    form.set('name', body.name);
    form.set('type', body.type);
    form.set('employee_id', body.employee_id);
    form.set('expiry_date', body.expiry_date ?? '');
    form.append('file', body.file);
    return api.postForm<{ document: DocumentWithEmp }>('/api/documents', form);
  },

  delete: (id: string) => api.delete<void>(`/api/documents/${id}`),

  /** Two-step "signed URL" flow: fetch URL + token, then browser navigates. */
  downloadUrl: (id: string) =>
    api.get<{ url: string; expires_at: string }>(`/api/documents/${id}/download-url`),
};
