/**
 * Private Limited post-registration compliance (INC-20A, ADTC). One endpoint
 * feeds both the Private Limited case screen and the main Dashboard. The
 * status and days remaining are worked out by the server from the due date
 * and today, on every read.
 */
import { api } from '@/services/api';

export type ComplianceStatus = 'NOT_STARTED' | 'UPCOMING' | 'DUE_SOON' | 'DUE_TODAY' | 'OVERDUE' | 'COMPLETED';

export interface ComplianceItem {
  id: string;
  code: 'INC_20A' | 'ADTC' | string;
  label: string;
  title: string;
  case: { id: string; code: string; registration_completed_at: string | null };
  client: { id: string; name: string };
  trigger_date: string | null;
  trigger_label: string;
  trigger_editable_label: boolean;
  offset_days: number;
  due_date: string | null;
  days_remaining: number | null;
  status: ComplianceStatus;
  due_soon_days: number;
  /** A reminder notification repeats every this many days until completed. */
  reminder_every_days: number | null;
  /** 'YYYY-MM-DD' the next reminder goes out; null when completed or no date yet. */
  next_reminder: string | null;
  completed_on: string | null;
  notes: string | null;
  updated_at: string;
}

export interface ComplianceSummary {
  total: number;
  not_started: number;
  upcoming: number;
  due_soon: number;
  due_today: number;
  overdue: number;
  completed: number;
}

export interface ComplianceList {
  today: string;
  summary: ComplianceSummary;
  items: ComplianceItem[];
}

const BASE = '/api/post-registration-compliance';

export const postRegistrationApi = {
  list: (q: { case_id?: string; status?: ComplianceStatus } = {}) => {
    const p = new URLSearchParams();
    if (q.case_id) p.set('case_id', q.case_id);
    if (q.status) p.set('status', q.status);
    const s = p.toString();
    return api.get<ComplianceList>(s ? `${BASE}?${s}` : BASE);
  },
  update: (id: string, input: { trigger_date?: string | null; trigger_label?: string; offset_days?: number; notes?: string | null }) =>
    api.patch<{ item: ComplianceItem }>(`${BASE}/${id}`, input),
  complete: (id: string, completed_on: string) => api.post<{ item: ComplianceItem }>(`${BASE}/${id}/complete`, { completed_on }),
  reopen: (id: string) => api.post<{ item: ComplianceItem }>(`${BASE}/${id}/reopen`, {}),
};

export const postRegistrationKeys = {
  all: ['post-registration-compliance'] as const,
  list: (q: { case_id?: string } = {}) => ['post-registration-compliance', q.case_id ?? 'all'] as const,
};
