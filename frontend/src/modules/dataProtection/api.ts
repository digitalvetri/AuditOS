import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { downloadBinary } from '@/modules/audit/api';

/** Data protection — `/api/data-protection` (backend/src/modules/data-protection). */

export interface DataProtectionSettings {
  ai_external_processing: boolean;
  data_retention_years: number;
  min_retention_years: number;
}

export interface PurgePlan {
  client_id: string;
  client_code: string;
  company_name: string;
  exit_date: string | null;
  retention_years: number;
  retention_ends: string | null;
  due: boolean;
  remove: {
    documents: number; files: number; audit_files: number; gst_notices: number;
    client_notices: number; contacts: number; credentials: number; share_links: number;
  };
  retained: { invoices: number; payments: number; credit_notes: number; refunds?: number };
}

export interface PurgeResult {
  plan: PurgePlan;
  files_removed: number;
  files_failed: { store: string; key: string }[];
}

export const AI_DISCLOSURE =
  'Notice text is sent to an outside AI service (Groq, US) to draft replies; PAN, GSTIN, Aadhaar, phone and email are masked first.';

export const dataProtectionApi = {
  settings: () => api.get<DataProtectionSettings>('/api/data-protection/settings'),
  updateSettings: (body: Partial<Pick<DataProtectionSettings, 'ai_external_processing' | 'data_retention_years'>>) =>
    api.patch<DataProtectionSettings>('/api/data-protection/settings', body),
  due: () => api.get<{ items: PurgePlan[]; count: number }>('/api/data-protection/retention/due'),
  purge: (clientId: string, confirm: string) =>
    api.post<PurgeResult>(`/api/data-protection/retention/clients/${encodeURIComponent(clientId)}/purge`, { confirm }),
  exportClient: (clientId: string, clientCode: string) =>
    downloadBinary(`/api/data-protection/clients/${encodeURIComponent(clientId)}/export`, `${clientCode}-data-export.zip`),
};

/** The firm's AI switch. Defaults to on while loading so nothing flickers off. */
export function useAiProcessingEnabled(): boolean {
  const q = useQuery({ queryKey: ['data-protection', 'settings'], queryFn: dataProtectionApi.settings, staleTime: 60_000 });
  return q.data?.ai_external_processing ?? true;
}
