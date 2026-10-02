/** TDS service records — see backend/src/modules/tds/routes.ts. */
import { api } from '@/services/api';

export type TdsKind = 'registration' | 'challan' | 'return' | 'correction' | 'certificate' | 'notice_check' | 'notice' | 'challan_statement';
export type ReturnForm = '24Q' | '26Q' | '27Q' | '27EQ';
export const RETURN_FORMS: ReturnForm[] = ['24Q', '26Q', '27Q', '27EQ'];

export interface TdsDocument {
  version: number;
  original_name: string | null;
  size_bytes: number;
  uploaded_at: string;
}

export interface TdsRecord {
  id: string;
  /** Null = the client's primary TAN. */
  tan: string | null;
  kind: TdsKind;
  document: TdsDocument | null;
  fy: string | null;
  period: string | null;
  form_type: string | null;
  status: 'pending' | 'in_progress' | 'done';
  reference: string | null;
  bsr_code: string | null;
  event_date: string | null;
  amount_tax: number | null;
  amount_interest: number | null;
  amount_fee: number | null;
  filed_by: string | null;
  notes: string | null;
  original_id: string | null;
  /** 26QB / 26QC / 26QD only: the other party and the Form 16B/16C/16D issue date. */
  party_name: string | null;
  party_pan: string | null;
  gross_amount: number | null;
  cert_issued_on: string | null;
  created_at: string;
  updated_at: string;
}

/** Free-text profile fields (all optional) — Form 49B details for the Registration field sheet. */
export const PROFILE_TEXT_KEYS = [
  'responsible_person', 'rp_designation', 'rp_pan', 'rp_email', 'rp_mobile',
  'addr_flat', 'addr_building', 'addr_road', 'addr_area', 'addr_city', 'addr_pin', 'ao_code',
] as const;
export type ProfileTextKey = (typeof PROFILE_TEXT_KEYS)[number];

export type TdsProfile = {
  return_forms: ReturnForm[];
  deductor_type: string | null;
  additional_tans: string[];
} & Record<ProfileTextKey, string | null>;

export interface TdsData {
  /** `tan` is the primary; `tans` is primary + additional. */
  client: { id: string; company_name: string; tan: string | null; tans: string[] };
  /** The TAN these records belong to. */
  active_tan: string | null;
  profile: TdsProfile;
  records: TdsRecord[];
  any_filed_return: boolean;
}

export type TdsRecordInput = Partial<Omit<TdsRecord, 'id' | 'tan' | 'document' | 'created_at' | 'updated_at'>> & {
  /** Registration only: the allotted TAN, saved on the client. */
  tan?: string | null;
  /** Which of the client's TANs the record is for; omitted = primary. */
  for_tan?: string | null;
};

// ── firm-wide board ────────────────────────────────────────────────────────
export interface TdsOverviewItem {
  kind: 'challan' | 'return' | 'certificate' | 'challan_statement_cert';
  period: string;
  formType: string | null;
  label: string;
  due: string;
  state: 'in_progress' | 'due' | 'overdue';
  due_soon: boolean;
}
export interface TdsOverviewRow {
  client_id: string;
  client_name: string;
  client_code: string | null;
  account_manager: string | null;
  tan: string | null;
  is_primary_tan: boolean;
  deductor_type: string | null;
  return_forms: string[];
  open_items: TdsOverviewItem[];
  overdue: number;
  due_soon: number;
  open_notices: number;
  last_notice_check: string | null;
  notice_check_stale: boolean;
  standing: 'overdue' | 'due_soon' | 'check_due' | 'ok' | 'no_tan';
}
export interface TdsOverview { fy: string; today: string; due_soon_days: number; rows: TdsOverviewRow[] }

// ── deductee register ─────────────────────────────────────────────────────
export type DeducteeCategory = 'individual_huf' | 'other';
export type Residency = 'resident' | 'non_resident';
export type TdsBasis = 'normal' | 'no_pan' | 'lower_certificate' | 'declaration' | 'below_threshold' | 'manual';
export interface TdsSection { code: string; label: string; rate_individual: number | null; rate_other: number | null; return_form: string; declaration_allowed: boolean }
export interface TdsDeductee { id: string; name: string; pan: string | null; category: DeducteeCategory; residency: Residency; email: string | null; notes: string | null }
export interface TdsLowerCertificate { id: string; deductee_id: string; certificate_no: string; section: string; rate: number; valid_from: string; valid_to: string; amount_limit: number | null }
export interface TdsDeclaration { id: string; deductee_id: string; fy: string; form: '15G' | '15H'; received_on: string; estimated_income: number | null; uin: string | null }
export interface TdsDeduction {
  id: string; tan: string | null; fy: string; month: string; deductee_id: string; section: string;
  payment_date: string; deduction_date: string; amount_paid: number; expected_tds: number | null; tds_amount: number;
  rate_pct: number | null; basis: TdsBasis; invoice_ref: string | null; notes: string | null;
  /** Positive = deducted less than the rules give. */
  shortfall: number;
}
export interface TdsMonthTotal { month: string; entries: number; deducted: number; expected: number; deposited: number | null; difference: number | null }
export interface TdsRegister {
  fy: string; active_tan: string | null; sections: TdsSection[]; deductees: TdsDeductee[];
  lower_certificates: TdsLowerCertificate[]; declarations: TdsDeclaration[]; deductions: TdsDeduction[]; months: TdsMonthTotal[];
}
export interface TdsPreview { expected_tds: number | null; rate: number | null; basis: TdsBasis; note: string; lower_certificate_no: string | null; declaration: string | null; return_form: string }

const qs = (p: Record<string, string | null | undefined>) => {
  const s = new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]).toString();
  return s ? `?${s}` : '';
};

export const tdsApi = {
  overview: (fy: string) => api.get<TdsOverview>(`/api/tds/overview${qs({ fy })}`),
  register: (clientId: string, fy: string, tan?: string | null) => api.get<TdsRegister>(`/api/tds/${clientId}/register${qs({ fy, tan })}`),
  preview: (clientId: string, input: { deductee_id: string; section: string; deduction_date: string; amount_paid: number; except_id?: string }) =>
    api.post<TdsPreview>(`/api/tds/${clientId}/deductions/preview`, input),
  save: <T>(clientId: string, kind: 'deductees' | 'lower-certificates' | 'declarations' | 'deductions', input: Record<string, unknown>, id?: string) =>
    id ? api.patch<T>(`/api/tds/${clientId}/${kind}/${id}`, input) : api.post<T>(`/api/tds/${clientId}/${kind}`, input),
  removeItem: (clientId: string, kind: 'deductees' | 'lower-certificates' | 'declarations' | 'deductions', id: string) =>
    api.delete<{ deleted: true }>(`/api/tds/${clientId}/${kind}/${id}`),
  exportUrl: (clientId: string, p: { fy: string; quarter: string; form: string; tan?: string | null }) =>
    `/api/tds/${clientId}/deductions/export${qs(p)}`,

  get: (clientId: string, fy: string, tan?: string | null) =>
    api.get<TdsData>(`/api/tds/${clientId}?fy=${encodeURIComponent(fy)}${tan ? `&tan=${encodeURIComponent(tan)}` : ''}`),
  saveProfile: (clientId: string, input: Partial<TdsProfile>) =>
    api.put<{ profile: TdsProfile }>(`/api/tds/${clientId}/profile`, input),
  create: (clientId: string, input: TdsRecordInput) =>
    api.post<{ record: TdsRecord }>(`/api/tds/${clientId}/records`, input),
  update: (clientId: string, id: string, input: TdsRecordInput) =>
    api.patch<{ record: TdsRecord }>(`/api/tds/${clientId}/records/${id}`, input),
  remove: (clientId: string, id: string) =>
    api.delete<{ deleted: true }>(`/api/tds/${clientId}/records/${id}`),
  uploadFile: (clientId: string, id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.postForm<{ document: TdsDocument }>(`/api/tds/${clientId}/records/${id}/file`, fd);
  },
  /** Same-origin, cookie-authenticated download URL. */
  fileUrl: (clientId: string, id: string, inline = false) =>
    `/api/tds/${clientId}/records/${id}/file${inline ? '?inline=1' : ''}`,
};
