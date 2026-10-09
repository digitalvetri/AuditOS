/**
 * Notices register — `/api/notices-register` (docs/compliance/README.md).
 * One list of income-tax / MCA / other notices (ClientNotice) plus GST
 * notices (GstNotice, `authority: 'gst'`, drafted on the GST client page).
 */
import { api } from '@/services/api';
import { asList, qs, type Paise } from '@/modules/compliance/api';

export const NOTICE_STATUSES = [
  'received', 'in_progress', 'replied', 'hearing', 'order_received', 'appeal', 'closed',
] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

export const NOTICE_STATUS_LABEL: Record<string, string> = {
  received: 'Received',
  in_progress: 'In progress',
  replied: 'Replied',
  hearing: 'Hearing',
  order_received: 'Order received',
  appeal: 'Appeal',
  closed: 'Closed',
  // GstNotice statuses (read-only here)
  draft: 'Draft',
  review: 'Review',
  sent: 'Reply sent',
};

export const NOTICE_AUTHORITIES = [
  { value: 'income_tax', label: 'Income tax' },
  { value: 'gst', label: 'GST' },
  { value: 'mca', label: 'MCA' },
  { value: 'tds', label: 'TDS' },
  { value: 'labour', label: 'Labour' },
  { value: 'other', label: 'Other' },
];

/** Common sections offered in the add form, by authority. */
export const COMMON_SECTIONS: Record<string, { value: string; label: string }[]> = {
  income_tax: [
    { value: '143(1)', label: '143(1) — Intimation' },
    { value: '143(2)', label: '143(2) — Scrutiny' },
    { value: '142(1)', label: '142(1) — Inquiry before assessment' },
    { value: '148', label: '148 — Income escaping assessment' },
    { value: '148A(b)', label: '148A(b) — Show cause before reopening' },
    { value: '139(9)', label: '139(9) — Defective return' },
    { value: '245', label: '245 — Set-off of refund' },
    { value: '156', label: '156 — Demand notice' },
    { value: '263', label: '263 — Revision by PCIT' },
    { value: '271', label: '271 — Penalty' },
    { value: '270A', label: '270A — Under-reporting penalty' },
  ],
  mca: [
    { value: 'MCA-ADJ', label: 'Adjudication notice' },
    { value: 'MCA-206', label: '206 — Inspection / information' },
    { value: 'MCA-248', label: '248 — Strike-off' },
    { value: 'MCA-ROC', label: 'ROC show cause' },
  ],
  tds: [
    { value: '200A', label: '200A — TDS statement intimation' },
    { value: '201', label: '201 — Assessee in default' },
    { value: '234E', label: '234E — Late filing fee' },
  ],
  labour: [{ value: 'PF/ESI', label: 'PF / ESI notice' }],
  other: [],
};

export interface RegisterNotice {
  id: string;
  /** 'gst' rows come from GstNotice and are edited on the GST client page. */
  source?: 'client_notice' | 'gst' | string;
  client_id: string;
  client_name?: string | null;
  authority: string;
  section: string | null;
  kind?: string | null;
  reference_no?: string | null;
  din?: string | null;
  notice_date: string | null;
  assessment_year?: string | null;
  response_due_date?: string | null;
  hearing_date?: string | null;
  demand_paise?: Paise;
  status: string;
  assigned_employee_id?: string | null;
  assigned_employee_name?: string | null;
  reply_filed_on?: string | null;
  reply_ack_no?: string | null;
  summary?: string | null;
  outcome?: string | null;
  file_name?: string | null;
  has_file?: boolean;
  days_left?: number | null;
  overdue?: boolean;
  link?: string | null;
}

export interface NoticeFilters {
  client_id?: string;
  authority?: string;
  status?: string;
  assigned_to?: string;
  mine?: boolean;
}

export interface NoticePatch {
  status?: string;
  assigned_employee_id?: string | null;
  response_due_date?: string | null;
  hearing_date?: string | null;
  reply_filed_on?: string | null;
  reply_ack_no?: string | null;
  demand_paise?: number | null;
  summary?: string | null;
  outcome?: string | null;
}

export const noticesRegisterKeys = {
  all: ['notices-register'] as const,
  list: (f: NoticeFilters) => ['notices-register', 'list', f] as const,
};

export const noticesRegisterApi = {
  list: async (f: NoticeFilters = {}) =>
    asList(await api.get<RegisterNotice[] | { items: RegisterNotice[] }>(`/api/notices-register${qs({ ...f })}`)),
  /** Multipart: client_id, authority, section, notice_date, … and optional `file`. */
  create: (form: FormData) => api.postForm<RegisterNotice>('/api/notices-register', form),
  update: (id: string, patch: NoticePatch) => api.patch<RegisterNotice>(`/api/notices-register/${id}`, patch),
  remove: (id: string) => api.delete<void>(`/api/notices-register/${id}`),
  fileUrl: (id: string) => `/api/notices-register/${id}/file`,
  updateGst: (id: string, patch: { response_due_date?: string | null; assigned_employee_id?: string | null }) =>
    api.patch<RegisterNotice>(`/api/notices-register/gst/${id}`, patch),
};

/** The GST notice drafting page for a client. */
export const gstNoticePage = (clientId: string) => `/workstation/services/registration/gst/clients/${clientId}`;
