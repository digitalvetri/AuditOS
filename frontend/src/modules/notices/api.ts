/**
 * GST notices API — matches backend/src/modules/notices/routes.ts.
 */
import { api } from '@/services/api';

export const NOTICE_KINDS = ['DRC07', 'DRC01', 'ASMT10', 'GSTR3A'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export const NOTICE_KIND_LABEL: Record<NoticeKind, string> = {
  DRC07: 'DRC-07 — Summary of Order',
  DRC01: 'DRC-01 — Show Cause Notice',
  ASMT10: 'ASMT-10 — Scrutiny Notice',
  GSTR3A: 'GSTR-3A — Notice to Return Defaulter',
};

/** Notice kinds the first slice supports end-to-end. */
export const NOTICE_KIND_READY: Record<NoticeKind, boolean> = {
  DRC07: true,
  DRC01: true,
  ASMT10: true,
  GSTR3A: true,
};

export type NoticeStatus = 'draft' | 'review' | 'sent' | 'closed';

export interface ReplyInputs {
  grounds: string;
  facts: string;
  documents_in_support?: string;
  prayer?: string;
  taxpayer_name?: string;
  taxpayer_gstin?: string;
}

export interface Notice {
  id: string;
  client_id: string;
  kind: NoticeKind;
  status: NoticeStatus;
  reference_no: string | null;
  notice_date: string | null;
  section: string | null;
  financial_year: string | null;
  period_from: string | null;
  period_to: string | null;
  officer_name: string | null;
  officer_designation: string | null;
  jurisdiction: string | null;
  total_demand: number | null;
  uploaded_file_name: string | null;
  uploaded_file_size: number | null;
  uploaded_mime: string | null;
  extraction_source: 'pdf-parse' | 'tesseract' | 'empty' | 'manual' | null;
  extracted_text_length: number;
  reply_inputs: ReplyInputs | null;
  client_letter: string | null;
  draft_content: string | null;
  llm_provider: string | null;
  llm_model: string | null;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
}

export const noticesKeys = {
  list: (clientId: string) => ['notices', 'client', clientId] as const,
  one: (id: string) => ['notices', 'one', id] as const,
};

export const noticesApi = {
  listByClient: (clientId: string) => api.get<Notice[]>(`/api/clients/${clientId}/notices`),
  get: (id: string) => api.get<Notice>(`/api/notices/${id}`),
  upload: (args: { clientId: string; kind: NoticeKind; file: File }) => {
    const f = new FormData();
    f.append('clientId', args.clientId);
    f.append('kind', args.kind);
    f.append('file', args.file);
    return api.postForm<Notice>('/api/notices', f);
  },
  update: (id: string, patch: Partial<Omit<Notice, 'id' | 'client_id' | 'created_at' | 'updated_at'>>) =>
    api.patch<Notice>(`/api/notices/${id}`, patch),
  generate: (id: string, replyInputs?: ReplyInputs) =>
    api.post<Notice>(`/api/notices/${id}/generate`, replyInputs ? { reply_inputs: replyInputs } : undefined),
  regenerateClientLetter: (id: string) => api.post<Notice>(`/api/notices/${id}/client-letter`),
  remove: (id: string) => api.delete<void>(`/api/notices/${id}`),
};
