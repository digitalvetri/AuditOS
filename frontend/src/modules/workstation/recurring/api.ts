import { api } from '@/services/api';

/**
 * Recurring retainers — a profile that raises an invoice for a client on a
 * schedule (monthly retainer, quarterly GST fee, annual audit fee …).
 */

export type RecurringFrequency = 'monthly' | 'quarterly' | 'half_yearly' | 'annual';
export type RecurringTerm = 'due_on_receipt' | 'net_7' | 'net_15' | 'net_30' | 'net_45';

export const FREQUENCY_LABEL: Record<RecurringFrequency, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  half_yearly: 'Half-yearly',
  annual: 'Annual',
};

export const RECURRING_TERM_LABEL: Record<RecurringTerm, string> = {
  due_on_receipt: 'Due on Receipt',
  net_7: 'Net 7',
  net_15: 'Net 15',
  net_30: 'Net 30',
  net_45: 'Net 45',
};

/** 31 means "the last day of the month". */
export const MONTH_END = 31;

export interface RecurringLine {
  description: string;
  sac_code: string | null;
  /** Hundredths of a unit: 250 = 2.5. */
  quantity_centi: number;
  unit_rate_paise: number;
  gst_rate: number;
  /** A rupee amount (in paise) off this line — not a percentage. */
  discount_paise: number;
}

export interface RecurringProfile {
  id: string;
  client_id: string;
  client_name: string | null;
  name: string;
  frequency: RecurringFrequency;
  day_of_month: number;
  start_date: string;
  end_date: string | null;
  next_issue_date: string | null;
  terms: RecurringTerm;
  place_of_supply: string | null;
  client_service_id: string | null;
  lines: RecurringLine[];
  auto_send: boolean;
  is_active: boolean;
  last_generated_at: string | null;
  last_invoice_id: string | null;
  last_invoice_number: string | null;
  invoice_count: number;
  created_at: string;
}

export interface RecurringInput {
  client_id: string;
  name: string;
  frequency: RecurringFrequency;
  day_of_month: number;
  start_date: string;
  end_date?: string | null;
  terms: RecurringTerm;
  place_of_supply?: string | null;
  client_service_id?: string | null;
  lines: { description: string; sac_code?: string | null; quantity_centi: number; unit_rate_paise: number; gst_rate: number; discount_paise: number }[];
  auto_send: boolean;
  is_active: boolean;
}

export interface RunResult {
  created: boolean;
  invoice_id: string | null;
  invoice_number: string | null;
  reason?: string;
}

export const recurringApi = {
  list: () => api.get<{ items: RecurringProfile[] }>('/api/recurring-invoices'),
  get: (id: string) => api.get<RecurringProfile>(`/api/recurring-invoices/${id}`),
  create: (input: RecurringInput) => api.post<RecurringProfile>('/api/recurring-invoices', input),
  update: (id: string, input: RecurringInput) => api.put<RecurringProfile>(`/api/recurring-invoices/${id}`, input),
  remove: (id: string) => api.delete<void>(`/api/recurring-invoices/${id}`),
  run: (id: string) => api.post<RunResult>(`/api/recurring-invoices/${id}/run`),
  runDue: () => api.post<{ created: number }>('/api/recurring-invoices/run-due'),
};
