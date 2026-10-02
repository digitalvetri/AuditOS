import { api } from '@/services/api';

/** Workstation documents — the same adapter and shape conventions as quotations. */

export type DocStatus = 'draft' | 'final' | 'archived';

export interface WorkstationDoc {
  id: string;
  doc_code: string;
  doc_type: string;
  title: string;
  client_id: string | null;
  lead_id: string | null;
  party_name: string | null;
  party_kind: 'client' | 'lead' | null;
  party_email: string | null;
  party_contact_number: string | null;
  party_address: string | null;
  party_contact_person: string | null;
  doc_date: string;
  status: DocStatus;
  is_editable: boolean;
  field_values: Record<string, string> | null;
  block_config: Record<string, unknown>[] | null;
  layout_config: Record<string, unknown> | null;
  finalised_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DocInput {
  doc_type: string;
  title: string;
  client_id: string | null;
  lead_id: string | null;
  doc_date: string;
  field_values: Record<string, string>;
  block_config: Record<string, unknown>[];
  layout_config: Record<string, unknown>;
}

function qs(p: Record<string, string | number | undefined>): string {
  const e = Object.entries(p).filter(([, v]) => v !== undefined && v !== '');
  return e.length ? `?${e.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : '';
}

const base = '/api/workstation-docs';

export const docsApi = {
  list: (f: { doc_type?: string; status?: string; client_id?: string; q?: string; limit?: number } = {}) =>
    api.get<{ items: WorkstationDoc[]; total: number }>(`${base}${qs(f)}`),
  /** How many of each type exist — the counts on the Doc cards. */
  counts: () => api.get<{ counts: Record<string, number> }>(`${base}/counts`),
  get: (id: string) => api.get<WorkstationDoc>(`${base}/${id}`),
  create: (input: DocInput) => api.post<WorkstationDoc>(base, input),
  update: (id: string, input: DocInput) => api.put<WorkstationDoc>(`${base}/${id}`, input),
  finalise: (id: string) => api.post<WorkstationDoc>(`${base}/${id}/finalise`),
  reopen: (id: string) => api.post<WorkstationDoc>(`${base}/${id}/reopen`),
  archive: (id: string) => api.post<WorkstationDoc>(`${base}/${id}/archive`),
  duplicate: (id: string) => api.post<WorkstationDoc>(`${base}/${id}/duplicate`),
  remove: (id: string) => api.delete<void>(`${base}/${id}`),
  pdfUrl: (id: string) => api.get<{ url: string; expires_at: string }>(`${base}/${id}/pdf-url`),
};
