import { api } from '@/services/api';
import type { EinvEwbResponse, EinvEwbProfile, EinvEwbMode } from './types';

/** The one call the page uses — page state comes back in a single envelope. */
export const einvoiceEwbApi = {
  /**
   * `mode` asks for one screen's half only, which lets the server skip the
   * other half's query instead of sending rows this screen would discard.
   * Omit it for the combined payload.
   */
  get: (clientId: string, mode: EinvEwbMode = 'both') =>
    api.get<EinvEwbResponse>(
      `/api/clients/${clientId}/einvoice-ewb${mode === 'both' ? '' : `?mode=${mode}`}`,
    ),
  updateProfile: (clientId: string, patch: Record<string, unknown>) =>
    api.patch<EinvEwbProfile>(`/api/clients/${clientId}/einvoice-ewb`, patch),
  recordPull: (clientId: string, kind: 'ewb' | 'einvoice', month: string) =>
    api.post(`/api/clients/${clientId}/einvoice-ewb/pull`, { kind, month }),
};
