/** TDS service records — see server/src/modules/tds/routes.ts. */
import { api } from '@/services/api';

export type TdsKind = 'registration' | 'challan' | 'return' | 'correction' | 'certificate' | 'notice_check' | 'notice';
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

export const tdsApi = {
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
