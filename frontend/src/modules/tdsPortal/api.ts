/**
 * TDS portal credentials client. `TdsCredential` never carries the password —
 * `password_present` says whether one is stored; `reveal` fetches it on
 * demand (each call writes an audit row server-side).
 */
import { api } from '@/services/api';

export interface TdsCredential {
  user_id: string;
  password_present: boolean;
  updated_at: string;
}

export const tdsPortalApi = {
  status: () => api.get<{ items: { client_id: string; user_id: string }[] }>('/api/tds-portal/status'),
  get: (clientId: string) => api.get<{ record: TdsCredential | null }>(`/api/tds-portal/${clientId}`),
  save: (clientId: string, input: { user_id: string; password?: string }) =>
    api.put<{ record: TdsCredential }>(`/api/tds-portal/${clientId}`, input),
  remove: (clientId: string) => api.delete<{ deleted: true }>(`/api/tds-portal/${clientId}`),
  reveal: (clientId: string) => api.post<{ value: string }>(`/api/tds-portal/${clientId}/reveal`),
};
