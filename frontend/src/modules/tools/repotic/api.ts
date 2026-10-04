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
    api.postForm<UploadResult>('/api/repotic/ecommerce/uploads', form),
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

  /** List every adapter the firm has for Repotic Ecommerce. */
  adapters: () => api.get<{ items: AdapterEntry[] }>(`/api/repotic/adapters`),

  /** Preview a sample file before saving an adapter — returns headers +
   *  the first few data rows so the staffer can map columns visually. */
  adapterPreview: (form: FormData) =>
    api.postForm<AdapterPreviewResult>('/api/repotic/adapters/preview', form),

  /** Create a new adapter version. Returns id + assigned version. */
  adapterCreate: (body: AdapterCreateBody) =>
    api.post<{ id: string; version: number; coverage: Record<string, boolean> }>(
      '/api/repotic/adapters', body,
    ),

  /** Toggle active, rename, or update the column map on an adapter. */
  adapterUpdate: (id: string, body: Partial<{ active: boolean; notes: string; column_map: Record<string, string>; coverage: Record<string, boolean> }>) =>
    api.patch<{ id: string; active: boolean }>(`/api/repotic/adapters/${id}`, body),

  adapterDelete: (id: string) =>
    api.delete<{ id: string; deleted: true }>(`/api/repotic/adapters/${id}`),
};

export interface AdapterEntry {
  id: string;
  marketplace: string;
  report_kind: string;
  version: number;
  effective_from: string | null;
  notes: string | null;
  active: boolean;
  detect_columns: string[];
  column_map: Record<string, string>;
  transforms: Record<string, unknown> | null;
  coverage: Record<string, boolean>;
  created_at: string;
}

export interface AdapterPreviewResult {
  marketplace: string;
  report_kind: string;
  original_name: string;
  size_bytes: number;
  headers: string[];
  sample_rows: string[][];
}

export interface AdapterCreateBody {
  marketplace: string;
  report_kind: string;
  detect_columns: string[];
  column_map: Record<string, string>;
  coverage?: Record<string, boolean>;
  notes?: string;
}
