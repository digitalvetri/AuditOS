/**
 * Payment summary (HRMS) client — per-client paid / pending over the
 * Workstation invoices, and the instalments recorded against each invoice.
 * All amounts are paise.
 */
import { api } from '@/services/api';

export type PaymentMode = 'bank_transfer' | 'upi' | 'cash' | 'cheque' | 'card' | 'other';
export type PayState = 'paid' | 'partial' | 'unpaid' | 'overdue';

export const PAYMENT_MODE_LABEL: Record<PaymentMode, string> = {
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  cash: 'Cash',
  cheque: 'Cheque',
  card: 'Card',
  other: 'Other',
};

export interface InvoicePayment {
  id: string;
  invoice_id: string;
  client_id: string;
  amount_paise: number;
  paid_on: string;
  mode: PaymentMode;
  reference: string | null;
  note: string | null;
  created_at: string;
  created_by: string | null;
}

export interface ClientSummary {
  client_id: string;
  client_name: string;
  client_code: string | null;
  contact_number: string | null;
  email: string | null;
  invoices: number;
  open_invoices: number;
  invoiced_paise: number;
  paid_paise: number;
  pending_paise: number;
  overdue_paise: number;
  oldest_due_date: string | null;
  last_payment_on: string | null;
  status: PayState;
}

export interface SummaryResponse {
  totals: {
    invoiced_paise: number;
    paid_paise: number;
    pending_paise: number;
    overdue_paise: number;
    collected_this_month_paise: number;
    collection_rate: number | null;
    invoices: number;
    clients: number;
    clients_with_dues: number;
  };
  ageing: { current: number; d1_30: number; d31_60: number; d61_90: number; d90_plus: number };
  clients: ClientSummary[];
  recent_payments: (InvoicePayment & { invoice_number: string; client_name: string })[];
}

export interface ClientInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  total_paise: number;
  paid_paise: number;
  pending_paise: number;
  state: PayState;
  days_overdue: number;
  payments: InvoicePayment[];
}

export interface ClientDetailResponse {
  client: { id: string; name: string; code: string | null; contact_number: string | null; email: string | null };
  invoices: ClientInvoice[];
}

/** One month of the cash-flow chart (GET /api/payment-summary/monthly). */
export interface MonthPoint {
  /** 'YYYY-MM' */
  month: string;
  billed_paise: number;
  collected_paise: number;
  invoices: number;
  payments: number;
}

export interface PaymentBody {
  amount_paise: number;
  paid_on: string;
  mode: PaymentMode;
  reference?: string;
  note?: string;
}

export const paymentSummaryApi = {
  summary: (f: { from?: string; to?: string } = {}) => {
    const p = new URLSearchParams();
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
    const qs = p.toString();
    return api.get<SummaryResponse>(`/api/payment-summary${qs ? `?${qs}` : ''}`);
  },
  monthly: (months = 6) => api.get<{ months: MonthPoint[] }>(`/api/payment-summary/monthly?months=${months}`),
  client: (clientId: string) => api.get<ClientDetailResponse>(`/api/payment-summary/clients/${clientId}`),
  record: (invoiceId: string, body: PaymentBody) =>
    api.post<{ payment: InvoicePayment }>(`/api/payment-summary/invoices/${invoiceId}/payments`, body),
  remove: (invoiceId: string, paymentId: string) =>
    api.delete<{ payments: InvoicePayment[] }>(`/api/payment-summary/invoices/${invoiceId}/payments/${paymentId}`),
};
