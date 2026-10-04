/**
 * Repotic — Ecommerce GSTR-1 API client (REPOTIC-MODULE.md Phase 1).
 */
import { api } from '@/services/api';

export interface MarketplaceEntry {
  key: string;
  label: string;
  reports: ReportEntry[];
}

export interface ReportEntry {
  key: string;
  label: string;
  intended_coverage: string[];
  adapter_versions: number;
  latest_adapter_version: number | null;
  upload?: {
    rows: number;
    detectStatus: 'matched' | 'drifted' | 'no_match';
    adapterVersion: number | null;
    typeCounts: Record<string, number> | null;
    drift: { newColumns: string[]; missingColumns: string[] } | null;
    uploadedAt: string;
  };
}

export interface UploadResult {
  upload_id: string;
  detect_status: 'matched' | 'drifted' | 'no_match';
  adapter_id: string | null;
  adapter_version: number | null;
  similarity: number;
  new_columns: string[];
  missing_columns: string[];
  status: string;
  error_message: string | null;
}

export const repoticApi = {
  marketplaces: (scope?: { client_id: string; gstin: string; period: string }) => {
    const qs = scope ? `?client_id=${encodeURIComponent(scope.client_id)}&gstin=${encodeURIComponent(scope.gstin)}&period=${encodeURIComponent(scope.period)}` : '';
    return api.get<{ items: MarketplaceEntry[] }>(`/api/repotic/marketplaces${qs}`);
  },
  upload: (form: FormData) =>
    api.post<UploadResult>('/api/repotic/ecommerce/uploads', form),
  uploads: (q: { client_id: string; gstin: string; period: string }) =>
    api.get<{ items: Array<Omit<Required<ReportEntry['upload']>, 'typeCounts' | 'drift'> & { id: string; marketplace: string; report_kind: string; original_name: string; status: string; error_message: string | null; type_counts: Record<string, number> | null; drift: { newColumns: string[]; missingColumns: string[] } | null }> }>(
      `/api/repotic/ecommerce/uploads?client_id=${encodeURIComponent(q.client_id)}&gstin=${encodeURIComponent(q.gstin)}&period=${encodeURIComponent(q.period)}`,
    ),
  /** Phase 3 — summary of what the GSTR-1 preview will contain for a scope. */
  gstr1Summary: (scope: { client_id: string; gstin: string; period: string }) =>
    api.get<{
      counts: {
        b2cs: number; b2cl: number; cdnur: number; hsn: number;
        excluded_free_replacement: number; excluded_other: number; total_rows: number;
      };
      preview_sample: {
        gstin: string; fp: string; disclaimer: string;
        b2cs_count: number; b2cl_count: number; cdnur_count: number; hsn_count: number;
      };
    }>(
      `/api/repotic/ecommerce/gstr1?client_id=${encodeURIComponent(scope.client_id)}&gstin=${encodeURIComponent(scope.gstin)}&period=${encodeURIComponent(scope.period)}`,
    ),
  /** Phase 3 — URL for the downloadable JSON. Returned so the browser can
   *  honour the Content-Disposition header without us re-fetching. */
  gstr1DownloadUrl: (scope: { client_id: string; gstin: string; period: string }) =>
    `/api/repotic/ecommerce/gstr1?client_id=${encodeURIComponent(scope.client_id)}&gstin=${encodeURIComponent(scope.gstin)}&period=${encodeURIComponent(scope.period)}&download=1`,
};
