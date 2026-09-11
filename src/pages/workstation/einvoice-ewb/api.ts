import { api } from '@/services/api';
import type { EinvEwbResponse, EinvEwbProfile } from './types';

/** The one call the page uses — page state comes back in a single envelope. */
export const einvoiceEwbApi = {
  get: (clientId: string) => api.get<EinvEwbResponse>(`/api/clients/${clientId}/einvoice-ewb`),
  updateProfile: (clientId: string, patch: Record<string, unknown>) =>
    api.patch<EinvEwbProfile>(`/api/clients/${clientId}/einvoice-ewb`, patch),
  recordPull: (clientId: string, kind: 'ewb' | 'einvoice', month: string) =>
    api.post(`/api/clients/${clientId}/einvoice-ewb/pull`, { kind, month }),
};
