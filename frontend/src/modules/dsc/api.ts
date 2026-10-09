/**
 * DSC register — `/api/dsc` (docs/compliance/README.md).
 */
import { api } from '@/services/api';
import { asList, qs } from '@/modules/compliance/api';

export interface Dsc {
  id: string;
  client_id: string | null;
  client_name?: string | null;
  holder_name: string;
  holder_pan?: string | null;
  holder_role?: string | null;
  dsc_class: string;
  usage?: string | null;
  provider?: string | null;
  token_serial?: string | null;
  valid_from?: string | null;
  expiry_date: string;
  custody: string;
  notes?: string | null;
  days_left?: number | null;
}

export type DscInput = Omit<Dsc, 'id' | 'client_name' | 'days_left'>;

export const DSC_ROLES = [
  { value: 'director', label: 'Director' },
  { value: 'partner', label: 'Partner' },
  { value: 'proprietor', label: 'Proprietor' },
  { value: 'authorised_signatory', label: 'Authorised signatory' },
  { value: 'trustee', label: 'Trustee' },
  { value: 'firm', label: 'Firm' },
];
export const DSC_CLASSES = [
  { value: 'class3', label: 'Class 3' },
  { value: 'dgft', label: 'DGFT' },
  { value: 'other', label: 'Other' },
];
export const DSC_USAGES = [
  { value: 'signing', label: 'Signing' },
  { value: 'encryption', label: 'Encryption' },
  { value: 'combo', label: 'Signing + encryption' },
];
export const DSC_CUSTODY = [
  { value: 'with_firm', label: 'With firm' },
  { value: 'with_client', label: 'With client' },
];

export const dscKeys = {
  all: ['dsc'] as const,
  list: (f: { client_id?: string; expiring_within_days?: number }) => ['dsc', 'list', f] as const,
};

export const dscApi = {
  list: async (f: { client_id?: string; expiring_within_days?: number } = {}) =>
    asList(await api.get<Dsc[] | { items: Dsc[] }>(`/api/dsc${qs({ ...f })}`)),
  create: (body: Partial<DscInput>) => api.post<Dsc>('/api/dsc', body),
  update: (id: string, body: Partial<DscInput>) => api.patch<Dsc>(`/api/dsc/${id}`, body),
  remove: (id: string) => api.delete<void>(`/api/dsc/${id}`),
};
