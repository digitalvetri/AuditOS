import { api } from '@/services/api';

/**
 * Quotation API client. Goes through the one adapter in services/api.ts like
 * the rest of Workstation.
 *
 * Note what is NOT here: no call sends a total, a tax figure or a timestamp.
 * The browser sends LINES; the server returns the money. That is why the
 * figures on a quotation cannot disagree with the lines that produced them.
 */

export type QuotationStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired';

export const GST_RATES = [0, 5, 12, 18, 28] as const;

export interface QuotationItem {
  id: string;
  service_id: string | null;
  description: string;
  /** Hundredths of a unit: 250 = 2.5. */
  quantity_centi: number;
  unit_rate_paise: number;
  discount_percent: number;
  gst_rate_percent: number;
  /** Free text: 'Monthly', 'Quarterly', 'Every 6 Months'. */
  frequency: string | null;
  category: string | null;
  detail: string | null;
  amount_paise: number;
  tax_paise: number;
  sort_order: number;
}

export interface QuotationWorkSection {
  id: string;
  sort_order: number;
  title: string;
  description: string | null;
  items: { id: string; sort_order: number; content: string }[];
}

export interface QuotationTemplate {
  id: string;
  name: string;
  description: string | null;
  configuration: Record<string, unknown> | null;
}

export interface Quotation {
  id: string;
  quotation_code: string;
  lead_id: string | null;
  client_id: string | null;
  party_name: string | null;
  party_kind: 'client' | 'lead' | null;
  party_email: string | null;
  party_contact_number: string | null;
  party_gstin: string | null;
  party_address: string | null;
  subject: string;
  quote_date: string;
  valid_until: string;
  status: QuotationStatus;
  stored_status: QuotationStatus;
  is_expired: boolean;
  is_editable: boolean;
  place_of_supply: string | null;
  is_inter_state: boolean;
  subtotal_paise: number;
  discount_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  total_paise: number;
  notes: string | null;
  terms: string | null;
  prepared_by_id: string | null;
  prepared_by: { id: string; full_name: string; employee_code: string } | null;
  sent_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  converted_task_id: string | null;
  converted_at: string | null;
  items: QuotationItem[];

  // ── Document composition (the builder) ──────────────────────────────────
  template_id: string;
  introduction: string | null;
  closing_text: string | null;
  prepared_by_name: string | null;
  prepared_by_designation: string | null;
  /** Opaque to the API: the builder's own layout shape, stored verbatim. */
  layout_config: Record<string, unknown> | null;
  block_config: Record<string, unknown>[] | null;
  client_snapshot: Record<string, unknown> | null;
  work_sections: QuotationWorkSection[];
  created_at: string;
  updated_at: string;
}

export interface QuotationSummary {
  draft: number;
  sent: number;
  expired: number;
  accepted: number;
  rejected: number;
  accepted_value_paise: number;
}

export interface QuotationFilters {
  status?: string;
  client_id?: string;
  lead_id?: string;
  date_from?: string;
  date_to?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface QuotationItemInput {
  service_id?: string | null;
  description: string;
  quantity_centi: number;
  unit_rate_paise: number;
  discount_percent: number;
  gst_rate_percent: number;
  frequency?: string | null;
  category?: string | null;
  detail?: string | null;
}

export interface QuotationWorkSectionInput {
  title: string;
  description?: string | null;
  items: string[];
}

export interface QuotationInput {
  lead_id?: string | null;
  client_id?: string | null;
  subject: string;
  quote_date: string;
  valid_until: string;
  place_of_supply?: string | null;
  is_inter_state: boolean;
  discount_paise: number;
  notes?: string | null;
  terms?: string | null;
  items: QuotationItemInput[];

  // ── Document composition. Optional, so an older caller still writes a
  // valid quotation and simply gets the default template. ─────────────────
  template_id?: string | null;
  introduction?: string | null;
  closing_text?: string | null;
  prepared_by_name?: string | null;
  prepared_by_designation?: string | null;
  layout_config?: Record<string, unknown> | null;
  block_config?: Record<string, unknown>[] | null;
  client_snapshot?: Record<string, unknown> | null;
  work_sections?: QuotationWorkSectionInput[];
}

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '' || v === 'all') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const quotationsApi = {
  list: (f: QuotationFilters = {}) =>
    api.get<{ items: Quotation[]; total: number }>(`/api/quotations${qs({ ...f })}`),
  summary: () => api.get<QuotationSummary>('/api/quotations/summary'),
  templates: () => api.get<{ items: QuotationTemplate[] }>('/api/quotations/templates'),
  get: (id: string) => api.get<Quotation>(`/api/quotations/${id}`),
  create: (input: QuotationInput) => api.post<Quotation>('/api/quotations', input),
  update: (id: string, input: QuotationInput) => api.put<Quotation>(`/api/quotations/${id}`, input),
  send: (id: string) => api.post<Quotation>(`/api/quotations/${id}/send`),
  accept: (id: string) => api.post<Quotation>(`/api/quotations/${id}/accept`),
  reject: (id: string, reason: string) => api.post<Quotation>(`/api/quotations/${id}/reject`, { reason }),
  revise: (id: string) => api.post<Quotation>(`/api/quotations/${id}/revise`),
  convertToTask: (id: string, assigned_employee_id: string, due_date?: string) =>
    api.post<{ task_id: string; quotation: Quotation }>(`/api/quotations/${id}/convert-to-task`, {
      assigned_employee_id, due_date,
    }),
  remove: (id: string) => api.delete<void>(`/api/quotations/${id}`),
  /** A signed, public link to the quotation PDF — for WhatsApp and email. */
  pdfUrl: (id: string) =>
    api.get<{ url: string; expires_at: string }>(`/api/quotations/${id}/pdf-url`),
};

// ── Money and quantity formatting ─────────────────────────────────────────
//
// Paise in, rupees out, in ONE place. Every screen that prints a figure calls
// these, so a quotation reads the same in the list, the builder and the print
// view.

export const inr = (paise: number): string =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** '2.5' from 250 — trailing zeros dropped so whole quantities read as '1'. */
export const qty = (centi: number): string => String(centi / 100);

/** Parse a typed rupee amount into paise, half-up, without floating drift. */
export const rupeesToPaise = (value: string): number => {
  const n = Number(String(value).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
};

/** Parse a typed quantity into hundredths. */
export const qtyToCenti = (value: string): number => {
  const n = Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
};

/**
 * The same arithmetic the server runs, for the live preview in the builder.
 *
 * This is a MIRROR, never the source of truth: the figures that get stored are
 * the ones the server computes on save. It exists so the total moves while you
 * type, and it is kept deliberately small for that reason.
 */
export function previewTotals(items: QuotationItemInput[], discountPaise: number, isInterState: boolean) {
  const amounts = items.map((i) =>
    Math.round(((i.quantity_centi * i.unit_rate_paise) / 100) * (1 - i.discount_percent / 100)));
  const subtotal = amounts.reduce((a, b) => a + b, 0);

  const wanted = Math.min(Math.max(0, Math.trunc(discountPaise)), subtotal);
  const shares = subtotal > 0
    ? amounts.map((a) => Math.floor((a * wanted) / subtotal))
    : amounts.map(() => 0);
  let remainder = wanted - shares.reduce((a, b) => a + b, 0);
  const order = amounts.map((_, i) => i).sort((x, y) => amounts[y] - amounts[x]);
  for (let k = 0; remainder > 0 && order.length; k = (k + 1) % order.length) {
    shares[order[k]] += 1;
    remainder -= 1;
  }

  const taxable = amounts.map((a, i) => a - shares[i]);
  const tax = taxable.reduce((sum, t, i) => sum + Math.round((t * items[i].gst_rate_percent) / 100), 0);
  const taxableTotal = taxable.reduce((a, b) => a + b, 0);
  const cgst = isInterState ? 0 : Math.ceil(tax / 2);

  return {
    lineAmounts: amounts,
    subtotal_paise: subtotal,
    discount_paise: shares.reduce((a, b) => a + b, 0),
    taxable_paise: taxableTotal,
    cgst_paise: cgst,
    sgst_paise: isInterState ? 0 : tax - cgst,
    igst_paise: isInterState ? tax : 0,
    total_paise: taxableTotal + tax,
  };
}
