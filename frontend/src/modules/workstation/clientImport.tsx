import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { api, type ApiError } from '@/services/api';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { Modal } from './components';
import type { ClientListItem, ListResponse } from './types';

/**
 * Clients: import from Excel, export to Excel, bulk actions, and the paged
 * list call. Kept apart from workstation/api.ts so the list page's new
 * server-side paging does not change what the older callers receive.
 */

// ── API ───────────────────────────────────────────────────────────────────

export interface ClientPageQuery {
  q?: string;
  status?: string;
  account_manager_id?: string;
  service_id?: string;
  pending_documents?: boolean;
  kind?: 'organization' | 'member' | 'standalone';
  mine?: boolean;
  /** Comma-separated client ids. */
  ids?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  page?: number;
  page_size?: number;
  facets?: boolean;
}

export interface ClientFacets {
  total: number;
  by_status: Record<string, number>;
  organizations: number;
  mine: number;
}

export interface ClientPage extends ListResponse<ClientListItem> {
  page?: number;
  page_size?: number;
  facets?: ClientFacets;
}

export function clientQueryString(f: ClientPageQuery): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    sp.set(k, v === true ? (k === 'pending_documents' ? 'true' : '1') : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface ImportRow {
  row: number;
  values: Record<string, string>;
  errors: Record<string, string>;
  account_manager: { id: string; name: string } | null;
}
export interface ImportResult {
  dry_run: boolean;
  total: number;
  valid: number;
  invalid: number;
  rows: ImportRow[];
  created?: number;
  clients?: { id: string; client_id: string; company_name: string }[];
}

export const clientsBulkApi = {
  page: (f: ClientPageQuery) => api.get<ClientPage>(`/api/clients${clientQueryString(f)}`),
  importFile: (file: File, dryRun: boolean) => {
    const form = new FormData();
    form.append('dry_run', dryRun ? 'true' : 'false');
    form.append('file', file);
    return api.postForm<ImportResult>('/api/clients/import', form);
  },
  bulk: (input: { ids: string[]; action: 'assign_account_manager' | 'set_status'; account_manager_id?: string; status?: string }) =>
    api.post<{ action: string; requested: number; updated: number }>('/api/clients/bulk', input),
};

/** GET a file (xlsx) and hand it to the browser as a download. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(path, { credentials: 'include' });
  if (!res.ok) {
    let message = `Download failed (HTTP ${res.status}).`;
    try { message = (await res.json())?.error?.message ?? message; } catch { /* not JSON */ }
    throw new Error(message);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Import dialog ─────────────────────────────────────────────────────────

const PREVIEW_COLS: { key: string; label: string }[] = [
  { key: 'company_name', label: 'Company' },
  { key: 'business_type', label: 'Business type' },
  { key: 'pan', label: 'PAN' },
  { key: 'gstin', label: 'GSTIN' },
  { key: 'tan', label: 'TAN' },
  { key: 'cin', label: 'CIN / LLPIN' },
  { key: 'contact_person', label: 'Contact' },
  { key: 'contact_number', label: 'Number' },
  { key: 'email', label: 'Email' },
  { key: 'account_manager', label: 'Account manager' },
  { key: 'onboarding_date', label: 'Onboarded' },
];

export function ImportClientsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);

  const reset = () => { setFile(null); setPreview(null); setOnlyErrors(false); setTemplateError(null); if (fileRef.current) fileRef.current.value = ''; };
  const close = () => { reset(); check.reset(); commit.reset(); onClose(); };

  const check = useMutation({
    mutationFn: (f: File) => clientsBulkApi.importFile(f, true),
    onSuccess: (r) => { setPreview(r); setOnlyErrors(r.invalid > 0); },
  });
  const commit = useMutation({
    mutationFn: (f: File) => clientsBulkApi.importFile(f, false),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      void qc.invalidateQueries({ queryKey: ['sidebar', 'client-count'] });
      void qc.invalidateQueries({ queryKey: ['onboarding'] });
      toast.push('success', `${r.created ?? 0} client${r.created === 1 ? '' : 's'} imported.`);
      close();
    },
    onError: (e) => {
      // 422 carries the re-checked rows: show them instead of a bare message.
      const d = (e as ApiError).details as ImportResult | undefined;
      if (d && Array.isArray(d.rows)) { setPreview(d); setOnlyErrors(true); }
    },
  });

  const pick = (f: File | null) => {
    setFile(f); setPreview(null); check.reset(); commit.reset();
    if (f) check.mutate(f);
  };

  const rows = preview ? (onlyErrors ? preview.rows.filter((r) => Object.keys(r.errors).length) : preview.rows) : [];
  const busy = check.isPending || commit.isPending;
  const failure = (check.error ?? (commit.error && !(commit.error as ApiError).details ? commit.error : null)) as ApiError | null;

  return (
    <Modal
      open={open}
      title="Import clients from Excel"
      onClose={close}
      width="w-[1080px]"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!file || !preview || preview.invalid > 0 || preview.total === 0 || busy}
            onClick={() => { if (file) commit.mutate(file); }}
          >
            {commit.isPending ? 'Importing…' : preview && preview.invalid === 0 ? `Import ${preview.total} client${preview.total === 1 ? '' : 's'}` : 'Import'}
          </Button>
        </>
      }
    >
      <ol className="grid gap-3 sm:grid-cols-2 mb-4">
        <li className="rounded-lg border border-neutral-200 p-3">
          <div className="text-12 font-semibold text-neutral-500 mb-1">1 · Get the template</div>
          <p className="text-13 text-neutral-700 mb-3">One client per row. Business type and account manager are dropdowns; the Instructions sheet explains each column.</p>
          <Button size="sm" onClick={() => {
            setTemplateError(null);
            downloadFile('/api/clients/import/template', 'client-import-template.xlsx').catch((e: Error) => setTemplateError(e.message));
          }}>
            <Download size={14} aria-hidden /> Download template
          </Button>
          {templateError ? <p className="text-12 text-red mt-2">{templateError}</p> : null}
        </li>
        <li className="rounded-lg border border-neutral-200 p-3">
          <div className="text-12 font-semibold text-neutral-500 mb-1">2 · Upload the filled file</div>
          <p className="text-13 text-neutral-700 mb-3">Every row is checked first — nothing is saved until you confirm, and then all rows are saved or none.</p>
          <label className="inline-flex items-center gap-2 h-8 px-3 text-13 font-medium rounded-lg border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 cursor-pointer focus-within:ring-2 focus-within:ring-primary/30">
            <Upload size={14} aria-hidden />
            {file ? 'Choose another file' : 'Choose .xlsx or .csv'}
            <input
              ref={fileRef} type="file" className="sr-only"
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
            />
          </label>
          {file ? <span className="ml-2 text-12 text-neutral-500 break-all"><FileSpreadsheet size={13} className="inline -mt-0.5" aria-hidden /> {file.name}</span> : null}
        </li>
      </ol>

      {check.isPending ? <p className="text-13 text-neutral-500" role="status">Checking every row…</p> : null}
      {failure ? <p className="text-13 text-red" role="alert">{failure.message}</p> : null}

      {preview ? (
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-3" role="status">
            <span className="text-13 font-semibold text-neutral-900">{preview.total} row{preview.total === 1 ? '' : 's'}</span>
            <span className="h-6 px-3 inline-flex items-center rounded-full text-12 font-medium bg-success/10 text-success">{preview.valid} ready</span>
            {preview.invalid ? (
              <span className="h-6 px-3 inline-flex items-center rounded-full text-12 font-medium bg-danger/10 text-danger">{preview.invalid} with problems</span>
            ) : null}
            <span className="flex-1" />
            {preview.invalid ? (
              <label className="inline-flex items-center gap-2 text-12 text-neutral-600">
                <input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} />
                Only rows with problems
              </label>
            ) : null}
          </div>
          {preview.invalid ? (
            <p className="text-12 text-neutral-600 mb-2">Fix the highlighted cells in your file and choose it again — nothing has been imported.</p>
          ) : null}
          <div className="overflow-auto max-h-[52vh] border border-neutral-200 rounded-lg">
            <table className="w-full text-12">
              <thead className="sticky top-0 bg-neutral-50 z-10">
                <tr className="text-left text-neutral-500">
                  <th scope="col" className="px-3 py-2 font-medium whitespace-nowrap">Row</th>
                  {PREVIEW_COLS.map((c) => <th key={c.key} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const bad = Object.keys(r.errors).length > 0;
                  return (
                    <tr key={r.row} className={'border-t border-neutral-100 align-top ' + (bad ? 'border-l-2 border-l-red' : '')}>
                      <td className="px-3 py-2 tabular-nums text-neutral-500">{r.row}</td>
                      {PREVIEW_COLS.map((c) => {
                        const err = r.errors[c.key] ?? (c.key === 'account_manager' ? r.errors.account_manager_id : undefined);
                        const shown = c.key === 'account_manager' && r.account_manager ? r.account_manager.name : r.values[c.key];
                        return (
                          <td key={c.key} className={'px-3 py-2 min-w-[96px] ' + (err ? 'bg-danger/5' : '')} aria-invalid={err ? true : undefined}>
                            <div className={err ? 'text-danger font-medium' : 'text-neutral-800'}>{shown || <span className="text-neutral-400">—</span>}</div>
                            {err ? <div className="text-11 text-danger mt-0.5 max-w-[240px]">{err}</div> : null}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {rows.length === 0 ? (
                  <tr><td colSpan={PREVIEW_COLS.length + 1} className="px-3 py-6 text-center text-neutral-500">No rows to show.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
