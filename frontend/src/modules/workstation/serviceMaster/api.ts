import { api } from '@/services/api';

/**
 * Service master — the firm's standard services and their scope of work as
 * selectable activities (backend modules/service-master). Engagement letters
 * start from these.
 */
export type ItemKind = 'scope' | 'deliverable' | 'responsibility' | 'exclusion' | 'note';

export const KIND_LABEL: Record<ItemKind, string> = {
  scope: 'Scope of services',
  deliverable: 'Typical deliverables',
  responsibility: 'Client responsibilities',
  exclusion: 'Exclusions / separately chargeable services',
  note: 'Important note',
};
export const KINDS: ItemKind[] = ['scope', 'deliverable', 'responsibility', 'exclusion', 'note'];

export const FREQUENCIES = ['Monthly', 'Quarterly', 'Half-yearly', 'Yearly', 'One-time', 'Per return', 'Per application'];

export interface MasterItem { id?: string; kind: ItemKind; content: string; default_selected: boolean }
export interface MasterService {
  id: string;
  code: string;
  category: string;
  name: string;
  billing_frequency: string;
  service_code: string | null;
  is_active: boolean;
  sort_order: number;
  items: MasterItem[];
}
export type MasterInput = Omit<MasterService, 'id' | 'code' | 'items'> & { items: Omit<MasterItem, 'id'>[] };

/** What a letter keeps of each service picked (EngagementLetter.serviceScopes). */
export interface ServiceScope {
  code: string;
  name: string;
  category: string | null;
  billing_frequency: string | null;
  service_code: string | null;
  items: { kind: ItemKind; content: string }[];
  extras?: Record<string, string>;
}

export interface Coverage { status: 'draft' | 'sent' | 'accepted'; letter_id: string; letter_code: string; accepted_at: string | null }

const base = '/api/service-master';

export const serviceMasterApi = {
  list: (includeInactive = false) => api.get<MasterService[]>(`${base}${includeInactive ? '?include_inactive=1' : ''}`),
  create: (b: MasterInput) => api.post<MasterService>(base, b),
  update: (id: string, b: MasterInput) => api.put<MasterService>(`${base}/${id}`, b),
  remove: (id: string) => api.delete<void>(`${base}/${id}`),
  coverage: (clientId: string) => api.get<Record<string, Coverage>>(`${base}/coverage?client_id=${encodeURIComponent(clientId)}`),
};

export const serviceMasterKeys = {
  list: (all: boolean) => ['service-master', all] as const,
  coverage: (clientId: string) => ['service-master', 'coverage', clientId] as const,
};
