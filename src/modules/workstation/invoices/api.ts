import { api } from '@/services/api';

/**
 * Invoice API client. Goes through the one adapter in services/api.ts like
 * the rest of Workstation.
 *
 * Note what is NOT here: no call sends a total, a tax figure, an invoice
 * number or a timestamp. The browser sends ITEMS; the server returns the
 * money and the number. That is why the figures on an invoice cannot
 * disagree with the lines that produced them, and why two people building an
 * invoice at once cannot land on the same number.
 */

export type InvoiceStatus =
  | 'draft' | 'sent' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled';

/** What the payment QR encodes. `none` omits it. */
export type QrMode = 'upi_amount' | 'upi_only' | 'custom' | 'image' | 'none';

export const QR_MODE_LABEL: Record<QrMode, string> = {
  upi_amount: 'UPI — with the balance due',
  upi_only: 'UPI — no amount',
  custom: 'Custom link or text',
  image: 'Upload my own QR image',
  none: 'No QR code',
};

export type Term = 'due_on_receipt' | 'net_7' | 'net_15' | 'net_30' | 'net_45' | 'custom';

export const TERM_LABEL: Record<Term, string> = {
  due_on_receipt: 'Due on Receipt',
  net_7: 'Net 7',
  net_15: 'Net 15',
  net_30: 'Net 30',
  net_45: 'Net 45',
  custom: 'Custom',
};

/** The slabs a line may carry. CGST/SGST are each half of this. */
export const GST_RATES = [0, 5, 12, 18, 28] as const;

export interface InvoiceItem {
  id: string;
  service_id: string | null;
  sort_order: number;
  item_name: string;
  description: string | null;
  hsn_sac: string | null;
  /** Hundredths of a unit: 250 = 2.5. */
  quantity_centi: number;
  unit: string | null;
  rate_paise: number;
  discount_percent: number;
  /** The FULL slab — what the editor works in. */
  gst_rate_percent: number;
  /* Derived halves for display. 2.5 is a real value here: half of the 5%
     slab. Never round these into a rate the invoice does not charge. */
  cgst_rate_percent: number;
  sgst_rate_percent: number;
  igst_rate_percent: number;
  taxable_amount_paise: number;
  cgst_amount_paise: number;
  sgst_amount_paise: number;
  igst_amount_paise: number;
  total_amount_paise: number;
}

export interface BankSnapshot {
  id: string;
  label: string;
  account_number: string;
  account_type: string;
  account_holder: string;
  bank_name: string;
  branch_name: string | null;
  ifsc_code: string;
  upi_id: string | null;
}

export interface BankAccountInput {
  label: string;
  account_number: string;
  account_type: string;
  account_holder: string;
  bank_name: string;
  branch_name?: string | null;
  ifsc_code: string;
  upi_id?: string | null;
  is_default?: boolean;
}

export interface Invoice {
  id: string;
  invoice_number: string;
  client_id: string;
  client_name: string | null;
  invoice_date: string;
  terms: Term;
  due_date: string;
  place_of_supply: string | null;
  is_inter_state: boolean;
  status: InvoiceStatus;
  stored_status: InvoiceStatus;
  is_overdue: boolean;
  is_editable: boolean;
  billing_name: string | null;
  billing_address: string | null;
  ship_same_as_bill: boolean;
  shipping_name: string | null;
  shipping_address: string | null;
  customer_gstin: string | null;
  subtotal_paise: number;
  discount_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  round_off_paise: number;
  total_paise: number;
  amount_paid_paise: number;
  balance_due_paise: number;
  payment_state: 'unpaid' | 'partially_paid' | 'paid';
  /** Generated server-side, so the document and the PDF cannot disagree. */
  total_in_words: string;
  notes: string | null;
  template_id: string;
  layout_config: Record<string, unknown> | null;
  block_config: Record<string, unknown>[] | null;
  bank_account_id: string | null;
  bank_snapshot: BankSnapshot | null;
  signatory_name: string | null;
  signatory_designation: string | null;
  footer_note: string | null;
  qr_mode: QrMode;
  qr_value: string | null;
  /** An uploaded code, inlined as a data URL. */
  qr_image: string | null;
  prepared_by_id: string | null;
  prepared_by: { id: string; full_name: string; employee_code: string } | null;
  sent_at: string | null;
  paid_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  items: InvoiceItem[];
}

export interface InvoiceItemInput {
  service_id?: string | null;
  item_name: string;
  description?: string | null;
  hsn_sac?: string | null;
  quantity_centi: number;
  unit?: string | null;
  rate_paise: number;
  discount_percent: number;
  /** The FULL slab. The server derives the CGST/SGST halves from it. */
  gst_rate_percent: number;
}

export interface InvoiceInput {
  client_id: string;
  invoice_date: string;
  terms: Term;
  due_date?: string | null;
  place_of_supply?: string | null;
  is_inter_state?: boolean;
  discount_paise?: number;
  notes?: string | null;
  billing_name?: string | null;
  billing_address?: string | null;
  ship_same_as_bill?: boolean;
  shipping_name?: string | null;
  shipping_address?: string | null;
  customer_gstin?: string | null;
  bank_account_id?: string | null;
  template_id?: string | null;
  signatory_name?: string | null;
  signatory_designation?: string | null;
  footer_note?: string | null;
  qr_mode?: QrMode;
  qr_value?: string | null;
  qr_image?: string | null;
  layout_config?: Record<string, unknown> | null;
  block_config?: Record<string, unknown>[] | null;
  items: InvoiceItemInput[];
}

export interface InvoiceFilters {
  status?: string;
  client_id?: string;
  date_from?: string;
  date_to?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface InvoiceSummary {
  counts: Record<string, number>;
  outstanding_paise: number;
  overdue_paise: number;
  total: number;
}

function qs(f: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const invoicesApi = {
  list: (f: InvoiceFilters = {}) =>
    api.get<{ items: Invoice[]; total: number }>(`/api/invoices${qs({ ...f })}`),
  summary: () => api.get<InvoiceSummary>('/api/invoices/summary'),
  bankAccounts: () => api.get<{ items: BankSnapshot[] }>('/api/invoices/bank-accounts'),
  createBankAccount: (input: BankAccountInput) =>
    api.post<BankSnapshot>('/api/invoices/bank-accounts', input),
  deactivateBankAccount: (id: string) => api.delete<void>(`/api/invoices/bank-accounts/${id}`),
  get: (id: string) => api.get<Invoice>(`/api/invoices/${id}`),
  create: (input: InvoiceInput) => api.post<Invoice>('/api/invoices', input),
  update: (id: string, input: InvoiceInput) => api.put<Invoice>(`/api/invoices/${id}`, input),
  send: (id: string) => api.post<Invoice>(`/api/invoices/${id}/send`),
  recordPayment: (id: string, amount_paise: number) =>
    api.post<Invoice>(`/api/invoices/${id}/payments`, { amount_paise }),
  cancel: (id: string, reason?: string) =>
    api.post<Invoice>(`/api/invoices/${id}/cancel`, { reason }),
  remove: (id: string) => api.delete<void>(`/api/invoices/${id}`),
  /** A signed, public link to the invoice PDF — for WhatsApp and email. */
  pdfUrl: (id: string) =>
    api.get<{ url: string; expires_at: string }>(`/api/invoices/${id}/pdf-url`),
};
