import { api } from '@/services/api';

/**
 * Credit notes against issued invoices. As with invoices, the browser sends
 * LINES (taxable value + slab); the server computes the tax split, the total
 * and allocates the CN number when the note is issued.
 */

export type CreditNoteStatus = 'draft' | 'issued' | 'cancelled';
export type CreditNoteReason = 'rate_change' | 'deficiency' | 'discount' | 'return' | 'fee_reduction' | 'other';

export const CREDIT_NOTE_REASON_LABEL: Record<CreditNoteReason, string> = {
  rate_change: 'Change in rate / fee revised',
  deficiency: 'Deficiency in service',
  discount: 'Post-sale discount',
  return: 'Service withdrawn / returned',
  fee_reduction: 'Fee reduction agreed',
  other: 'Other',
};

export interface CreditNoteLine {
  description: string;
  sac_code: string | null;
  taxable_paise: number;
  gst_rate: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  total_paise: number;
}

export interface CreditNote {
  id: string;
  credit_note_number: string | null;
  /** 'CN-000001' or 'Draft'. */
  display_number: string;
  invoice_id: string;
  invoice_number: string | null;
  client_id: string;
  client_name: string | null;
  note_date: string;
  reason: CreditNoteReason;
  reason_note: string | null;
  status: CreditNoteStatus;
  is_inter_state: boolean;
  place_of_supply: string | null;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  total_paise: number;
  lines: CreditNoteLine[];
  issued_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Creditable {
  invoice_id: string;
  invoice_number: string | null;
  total_paise: number;
  credited_paise: number;
  creditable_paise: number;
  is_inter_state: boolean;
  place_of_supply: string | null;
  suggested_lines: { description: string; sac_code: string | null; taxable_paise: number; gst_rate: number }[];
}

export interface CreditNoteLineInput {
  description: string;
  sac_code?: string | null;
  taxable_paise: number;
  gst_rate: number;
}

export interface CreditNoteInput {
  note_date: string;
  reason: CreditNoteReason;
  reason_note?: string | null;
  lines: CreditNoteLineInput[];
}

export interface CreditNoteFilters {
  invoice_id?: string;
  client_id?: string;
  status?: string;
  q?: string;
}

function qs(f: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const creditNotesApi = {
  list: (f: CreditNoteFilters = {}) =>
    api.get<{ items: CreditNote[]; total: number }>(`/api/credit-notes${qs({ ...f })}`),
  get: (id: string) => api.get<CreditNote>(`/api/credit-notes/${id}`),
  creditable: (invoiceId: string) => api.get<Creditable>(`/api/credit-notes/creditable/${invoiceId}`),
  create: (input: CreditNoteInput & { invoice_id: string }) => api.post<CreditNote>('/api/credit-notes', input),
  update: (id: string, input: CreditNoteInput) => api.put<CreditNote>(`/api/credit-notes/${id}`, input),
  issue: (id: string) => api.post<CreditNote>(`/api/credit-notes/${id}/issue`),
  cancel: (id: string, reason?: string) => api.post<CreditNote>(`/api/credit-notes/${id}/cancel`, { reason }),
  remove: (id: string) => api.delete<void>(`/api/credit-notes/${id}`),
  pdfUrl: (id: string) => api.get<{ url: string; expires_at: string }>(`/api/credit-notes/${id}/pdf-url`),
};

/** Display-only GST split for a line; the server is authoritative. */
export function previewLineTax(taxablePaise: number, rate: number, interState: boolean) {
  if (interState) {
    const igst = Math.round((taxablePaise * rate) / 100);
    return { cgst: 0, sgst: 0, igst, total: taxablePaise + igst };
  }
  const half = Math.round((taxablePaise * rate) / 200);
  return { cgst: half, sgst: half, igst: 0, total: taxablePaise + half * 2 };
}
