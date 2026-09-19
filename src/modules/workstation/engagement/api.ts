import { api } from '@/services/api';

/** Engagement letter API — the same adapter and shape conventions as quotations. */

export type EngagementStatus = 'draft' | 'sent' | 'accepted' | 'archived';

export interface EngagementFeeItem {
  id?: string;
  service: string;
  description: string | null;
  frequency: string | null;
  amount_paise: number;
  billing_basis: string | null;
  notes: string | null;
}

export interface EngagementLetter {
  id: string;
  letter_code: string;
  client_id: string | null;
  lead_id: string | null;
  party_name: string | null;
  party_kind: 'client' | 'lead' | null;
  party_email: string | null;
  party_contact_number: string | null;
  party_address: string | null;
  party_contact_person: string | null;
  subject: string;
  letter_date: string;
  effective_from: string | null;
  effective_until: string | null;
  financial_year: string | null;
  status: EngagementStatus;
  is_editable: boolean;
  recipient_snapshot: Record<string, unknown> | null;
  template_id: string;
  block_config: Record<string, unknown>[] | null;
  layout_config: Record<string, unknown> | null;
  signatory_name: string | null;
  signatory_designation: string | null;
  client_signatory_name: string | null;
  client_signatory_designation: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  fee_items: EngagementFeeItem[];
  created_at: string;
  updated_at: string;
}

export interface EngagementInput {
  client_id: string | null;
  lead_id: string | null;
  subject: string;
  letter_date: string;
  effective_from: string | null;
  effective_until: string | null;
  financial_year: string | null;
  recipient_snapshot: Record<string, unknown>;
  template_id: string;
  block_config: Record<string, unknown>[];
  layout_config: Record<string, unknown>;
  signatory_name: string | null;
  signatory_designation: string | null;
  client_signatory_name: string | null;
  client_signatory_designation: string | null;
  fee_items: Omit<EngagementFeeItem, 'id'>[];
}

function qs(p: Record<string, string | number | undefined>): string {
  const e = Object.entries(p).filter(([, v]) => v !== undefined && v !== '');
  return e.length ? `?${e.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : '';
}

const base = '/api/engagement-letters';

export const engagementApi = {
  list: (f: { status?: string; client_id?: string; q?: string; limit?: number } = {}) =>
    api.get<{ items: EngagementLetter[]; total: number }>(`${base}${qs(f)}`),
  get: (id: string) => api.get<EngagementLetter>(`${base}/${id}`),
  create: (input: EngagementInput) => api.post<EngagementLetter>(base, input),
  update: (id: string, input: EngagementInput) => api.put<EngagementLetter>(`${base}/${id}`, input),
  send: (id: string) => api.post<EngagementLetter>(`${base}/${id}/send`),
  accept: (id: string) => api.post<EngagementLetter>(`${base}/${id}/accept`),
  archive: (id: string) => api.post<EngagementLetter>(`${base}/${id}/archive`),
  /** A sent letter back to draft, so it can be edited and re-sent. */
  reopen: (id: string) => api.post<EngagementLetter>(`${base}/${id}/reopen`),
  duplicate: (id: string) => api.post<EngagementLetter>(`${base}/${id}/duplicate`),
  remove: (id: string) => api.delete<void>(`${base}/${id}`),
  pdfUrl: (id: string) => api.get<{ url: string; expires_at: string }>(`${base}/${id}/pdf-url`),
};
