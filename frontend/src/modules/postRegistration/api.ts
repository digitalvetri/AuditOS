/**
 * Post-registration compliance — Private Limited (INC-20A, ADTC) and LLP
 * (LLP Form 3). One endpoint feeds the case screens, the LLP Dashboard, the
 * Private Limited compliance tab and the main Dashboard. The
 * status and days remaining are worked out by the server from the due date
 * and today, on every read.
 */
import { api } from '@/services/api';

export type ComplianceStatus = 'NOT_STARTED' | 'UPCOMING' | 'DUE_SOON' | 'DUE_TODAY' | 'OVERDUE' | 'COMPLETED';

export type ComplianceKind = 'PRIVATE_LIMITED' | 'LLP';

export interface ComplianceItem {
  id: string;
  /** The compliance type: INC_20A | ADTC | LLP_FORM_3_INITIAL. */
  code: 'INC_20A' | 'ADTC' | 'LLP_FORM_3_INITIAL' | string;
  kind: ComplianceKind;
  label: string;
  title: string;
  description: string | null;
  case: { id: string; code: string; status: string; registration_completed_at: string | null };
  client: { id: string; name: string };
  /** LLPIN (LLP) / CIN (Private Limited). */
  registration_number: string | null;
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
  /** "LLP Form 3 for X is due in 20 days." — null when completed or no date yet. */
  reminder_message: string | null;
  assigned_to: { id: string; name: string } | null;
  completed_on: string | null;
  completed_by: { id: string | null; name: string } | null;
  notes: string | null;
  created_at: string;
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
  list: (q: { case_id?: string; status?: ComplianceStatus; kind?: ComplianceKind } = {}) => {
    const p = new URLSearchParams();
    if (q.kind) p.set('kind', q.kind);
    if (q.case_id) p.set('case_id', q.case_id);
    if (q.status) p.set('status', q.status);
    const s = p.toString();
    return api.get<ComplianceList>(s ? `${BASE}?${s}` : BASE);
  },
  update: (id: string, input: { trigger_date?: string | null; trigger_label?: string; offset_days?: number; notes?: string | null; assigned_employee_id?: string | null }) =>
    api.patch<{ item: ComplianceItem }>(`${BASE}/${id}`, input),
  complete: (id: string, input: { completed_on: string; completed_by_employee_id?: string; notes?: string | null }) =>
    api.post<{ item: ComplianceItem }>(`${BASE}/${id}/complete`, input),
  reopen: (id: string) => api.post<{ item: ComplianceItem }>(`${BASE}/${id}/reopen`, {}),
};

export const postRegistrationKeys = {
  all: ['post-registration-compliance'] as const,
  list: (q: { case_id?: string; kind?: ComplianceKind } = {}) => ['post-registration-compliance', q.kind ?? 'any', q.case_id ?? 'all'] as const,
};
