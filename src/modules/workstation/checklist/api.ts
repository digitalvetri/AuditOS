import { api } from '@/services/api';

/**
 * Client compliance checklist API — Workstation → Clients → [Client] → GST.
 *
 * Two halves that must never be confused, and the URLs say which is which:
 *   /api/checklists/gst/catalog          → the MASTER catalogue (shared)
 *   /api/checklists/gst/clients/:id/...  → ONE client's work (never shared)
 *
 * `kind` is in every path so a TDS or Income-Tax checklist later reuses this
 * file rather than copying it.
 */

export type ChecklistKind = 'gst';

/** What a write may set. 'overdue' is derived by the server and never sent. */
export const STORED_STATUSES = ['not_started', 'in_progress', 'pending', 'completed', 'not_required'] as const;
export type StoredStatus = (typeof STORED_STATUSES)[number];
/** What a row may display. */
export const DISPLAY_STATUSES = [...STORED_STATUSES, 'overdue'] as const;

export const FREQUENCIES = ['one-time', 'monthly', 'quarterly', 'annual', 'event-based'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface ChecklistCategory { id: string; name: string; description: string | null; active: boolean }

export interface MasterService {
  id: string; slug: string | null; name: string; code: string | null;
  category_id: string | null; service_type: string; default_frequency: Frequency;
  description: string | null; active: boolean; is_custom: boolean;
}

export interface ChecklistItem {
  id: string;
  client_id: string;
  service_id: string | null;
  category_id: string | null;
  name: string;
  code: string | null;
  category_name: string | null;
  description: string | null;
  is_custom: boolean;
  stored_status: StoredStatus;
  status: string;
  is_overdue: boolean;
  assigned_to: { id: string; full_name: string } | null;
  due_date: string | null;
  frequency: Frequency;
  notes: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChecklistItemDetail extends ChecklistItem {
  activity: { id: string; action: string; detail: string | null; actor_name: string | null; at: string }[];
}

export interface ChecklistSummary {
  total: number; completed: number; in_progress: number; pending: number;
  overdue: number; not_started: number; not_required: number;
  applicable: number; progress_percent: number;
}

export interface ItemInput {
  service_id?: string | null;
  name?: string | null;
  category_id?: string | null;
  description?: string | null;
  frequency?: Frequency;
  due_date?: string | null;
  assigned_to_id?: string | null;
  notes?: string | null;
  add_to_master?: boolean;
}

export interface ItemPatch {
  status?: StoredStatus;
  assigned_to_id?: string | null;
  due_date?: string | null;
  frequency?: Frequency;
  notes?: string | null;
  description?: string | null;
  category_id?: string | null;
  name?: string | null;
}

/** One row of the cross-client roll-up behind Services → GST. */
export interface ChecklistOverviewRow {
  client_id: string;
  client_code: string;
  client_name: string;
  gstin: string | null;
  has_checklist: boolean;
  summary: ChecklistSummary;
  next_due: { name: string; due_date: string | null; status: string } | null;
}

export interface ChecklistOverview {
  items: ChecklistOverviewRow[];
  totals: ChecklistSummary & { clients: number; clients_with_checklist: number };
}

const base = (kind: ChecklistKind) => `/api/checklists/${kind}`;

export const checklistApi = {
  catalog: (kind: ChecklistKind = 'gst') =>
    api.get<{ categories: ChecklistCategory[]; services: MasterService[] }>(`${base(kind)}/catalog`),
  addCategory: (name: string, description: string | null, kind: ChecklistKind = 'gst') =>
    api.post<ChecklistCategory>(`${base(kind)}/categories`, { name, description }),

  overview: (kind: ChecklistKind = 'gst') => api.get<ChecklistOverview>(`${base(kind)}/overview`),

  list: (clientId: string, kind: ChecklistKind = 'gst') =>
    api.get<{ items: ChecklistItem[]; summary: ChecklistSummary }>(`${base(kind)}/clients/${clientId}`),
  get: (clientId: string, id: string, kind: ChecklistKind = 'gst') =>
    api.get<ChecklistItemDetail>(`${base(kind)}/clients/${clientId}/items/${id}`),
  initialize: (clientId: string, service_ids: string[], kind: ChecklistKind = 'gst') =>
    api.post<{ items: ChecklistItem[]; summary: ChecklistSummary }>(`${base(kind)}/clients/${clientId}/initialize`, { service_ids }),
  addItem: (clientId: string, input: ItemInput, kind: ChecklistKind = 'gst') =>
    api.post<ChecklistItemDetail>(`${base(kind)}/clients/${clientId}/items`, input),
  update: (clientId: string, id: string, patch: ItemPatch, kind: ChecklistKind = 'gst') =>
    api.patch<ChecklistItemDetail>(`${base(kind)}/clients/${clientId}/items/${id}`, patch),
  remove: (clientId: string, id: string, kind: ChecklistKind = 'gst') =>
    api.delete<void>(`${base(kind)}/clients/${clientId}/items/${id}`),
};

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  'one-time': 'One-time',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
  'event-based': 'Event-based',
};
