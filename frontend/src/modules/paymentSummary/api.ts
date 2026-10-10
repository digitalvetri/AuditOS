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

export type TdsSection = '194J' | '194C' | '194H' | '194I' | '194-O' | 'other';

export const TDS_SECTIONS: { value: TdsSection; label: string }[] = [
  { value: '194J', label: '194J — Professional / technical fees' },
  { value: '194C', label: '194C — Contracts' },
  { value: '194H', label: '194H — Commission / brokerage' },
  { value: '194I', label: '194I — Rent' },
  { value: '194-O', label: '194-O — E-commerce' },
  { value: 'other', label: 'Other' },
];

export interface InvoicePayment {
  id: string;
  invoice_id: string;
  client_id: string;
  /** Cash received (excludes TDS). */
  amount_paise: number;
  /** TDS the client deducted against this receipt. */
  tds_paise?: number;
  tds_section?: TdsSection | null;
  tds_certificate_received?: boolean;
  /** 'RCT-000123' */
  receipt_number?: string | null;
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
  /** Cash received, net of refunds paid back. */
  paid_paise: number;
  pending_paise: number;
  overdue_paise: number;
  refunded_paise?: number;
  /** Owed back to the client (invoices settled beyond their total). */
  refund_due_paise?: number;
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
    /** Net of refunds paid back this month. */
    collected_this_month_paise: number;
    refunded_paise?: number;
    refund_due_paise?: number;
    clients_with_refund_due?: number;
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
  /** Cash received, net of refunds paid back. */
  paid_paise: number;
  pending_paise: number;
  refunded_paise?: number;
  /** Owed back to the client on this invoice. */
  refund_due_paise?: number;
  /** TDS deducted by the client (counts towards settlement, not cash). */
  tds_deducted_paise?: number;
  /** Issued credit notes against this invoice. */
  credited_paise?: number;
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
  /** Cash in, net of refunds paid back in the month. */
  collected_paise: number;
  refunded_paise?: number;
  invoices: number;
  payments: number;
}

export interface PaymentBody {
  amount_paise: number;
  paid_on: string;
  mode: PaymentMode;
  reference?: string;
  note?: string;
  tds_paise?: number;
  tds_section?: TdsSection;
  tds_certificate_received?: boolean;
}

export const paymentSummaryApi = {
  summary: (f: { from?: string; to?: string } = {}) => {
    const p = new URLSearchParams();
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
    const qs = p.toString();
    return api.get<SummaryResponse>(`/api/payment-summary${qs ? `?${qs}` : ''}`);
  },
  monthly: (months = 6) => api.get<{ months: MonthPoint[]; avg_days_to_collect: number | null }>(`/api/payment-summary/monthly?months=${months}`),
  client: (clientId: string) => api.get<ClientDetailResponse>(`/api/payment-summary/clients/${clientId}`),
  record: (invoiceId: string, body: PaymentBody) =>
    api.post<{ payment: InvoicePayment }>(`/api/payment-summary/invoices/${invoiceId}/payments`, body),
  remove: (invoiceId: string, paymentId: string) =>
    api.delete<{ payments: InvoicePayment[] }>(`/api/payment-summary/invoices/${invoiceId}/payments/${paymentId}`),
};
