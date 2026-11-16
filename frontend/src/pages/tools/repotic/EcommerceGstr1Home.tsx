/**
 * /audit-automation/ecommerce — Repotic Ecommerce GSTR-1 landing
 * (REPOTIC-MODULE.md §4.1).
 *
 * The import screen. Scope selector (client × GSTIN × period) at the
 * top, then one row per marketplace × report-kind with the current
 * state against that scope:
 *
 *   SOURCE            REPORT              STATE / ACTION          COVERAGE
 *   Amazon            MTR B2C             ✓ uploaded 412 rows     5A, 7, 9B, 12, 14
 *                     MTR B2B             [ Upload ]               not built (B2B)
 *
 * The coverage column replaces the original Repotic's export-time
 * surprise modal — nobody discovers at download that document summary
 * doesn't work for Myntra; they see it before uploading anything.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeft, Upload, Check, AlertTriangle, Info, Trash2 } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { repoticApi, type ReportEntry } from '@/modules/tools/repotic/api';
import { gstApi, recentPeriods } from '@/modules/workstation/gst/api';
import { BetaBadge } from '@/pages/tools/AuditAutomation';

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function EcommerceGstr1HomePage() {
  // A client can hold several GST registrations: the picker chooses one
  // registration (profile), which gives both the client and the GSTIN.
  const [profileId, setProfileId] = useState<string>('');
  const [period, setPeriod] = useState<string>(currentMonth());
  const periods = useMemo(() => recentPeriods(12), []);

  const clients = useQuery({ queryKey: ['gst.clients'], queryFn: () => gstApi.clients() });
  const profile = (clients.data?.items ?? []).find((c) => c.id === profileId);
  const clientId = profile?.client_id ?? '';
  const effectiveGstin = profile?.gstin ?? '';

  const scoped = clientId && effectiveGstin && period
    ? { client_id: clientId, gstin: effectiveGstin, period }
    : undefined;

  const marketplacesQ = useQuery({
    queryKey: ['repotic.marketplaces', scoped?.client_id, scoped?.gstin, scoped?.period],
    queryFn: () => repoticApi.marketplaces(scoped),
  });

  const clientName = clients.data?.items.find((c) => c.client_id === clientId)?.client_name ?? '';

  return (
    <div className="max-w-[1240px] mx-auto">
      <div className="mb-4">
        <Link to="/audit-automation" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> Repotic
        </Link>
      </div>

      <header className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-20 font-semibold text-neutral-900">Ecommerce GSTR-1</h1>
          <BetaBadge />
        </div>
        <p className="text-13 text-neutral-500 mt-1">
          One normalised set of rows from the marketplaces the seller uses, built into the government's GSTR-1 tables.
        </p>
      </header>

      <section className="bg-white border border-neutral-200 rounded p-4 mb-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <label className="text-11 text-neutral-500">
            Client
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)}
              className="mt-1 h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white">
              <option value="">— pick a client —</option>
              {(clients.data?.items ?? []).filter((c) => c.client_id).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.client_name ?? c.legal_name ?? '—'} · {c.gstin}
                </option>
              ))}
            </select>
          </label>
          <label className="text-11 text-neutral-500">
            GSTIN
            <input value={effectiveGstin} readOnly placeholder="Pick a client and registration"
              className="mt-1 h-9 w-full px-2 text-13 font-mono border border-neutral-300 rounded disabled:bg-neutral-50 disabled:text-neutral-500" />
          </label>
          <label className="text-11 text-neutral-500">
            Period
            <select value={period} onChange={(e) => setPeriod(e.target.value)}
              className="mt-1 h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white">
              {periods.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
        </div>
      </section>

      {!scoped ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">
          Choose a client and period above to start uploading marketplace reports.
        </div>
      ) : (
        <>
          <SourcesTable
            scope={scoped}
            clientName={clientName}
            items={marketplacesQ.data?.items ?? []}
            loading={marketplacesQ.isLoading}
          />
          <UploadsList scope={scoped} />
          <BuildGstr1Section scope={scoped} />
        </>
      )}
    </div>
  );
}

function SourcesTable({ scope, clientName, items, loading }: {
  scope: { client_id: string; gstin: string; period: string };
  clientName: string;
  items: Array<{ key: string; label: string; reports: ReportEntry[] }>;
  loading: boolean;
}) {
  return (
    <section className="bg-white border border-neutral-200 rounded overflow-hidden">
      <div className="p-4 border-b border-neutral-200">
        <div className="text-11 tracking-[0.06em] text-neutral-500 mb-1">IMPORT</div>
        <div className="text-14 font-semibold text-neutral-900">
          {clientName || scope.client_id} · <span className="font-mono text-13 font-normal">{scope.gstin}</span>
        </div>
      </div>
      {loading ? (
        <div className="p-4 text-13 text-neutral-500">Loading…</div>
      ) : (
        <table className="w-full min-w-[720px] text-13">
          <thead>
            <tr className="text-11 uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-200">
              <th className="text-left px-4 h-8 font-medium w-[180px]">Source</th>
              <th className="text-left px-2 font-medium w-[160px]">Report</th>
              <th className="text-left px-2 font-medium">State</th>
              <th className="text-left px-2 font-medium w-[170px]">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {items.flatMap((mp) =>
              mp.reports.map((r, idx) => (
                <tr key={`${mp.key}:${r.key}`} className="border-b border-neutral-100 align-top">
                  <td className="px-4 py-2 text-neutral-800 font-medium">
                    {idx === 0 ? mp.label : <span className="text-neutral-400">·</span>}
                  </td>
                  <td className="px-2 py-2 text-neutral-700">{r.label}</td>
                  <td className="px-2 py-2">
                    <ReportState scope={scope} marketplace={mp.key} report={r} />
                  </td>
                  <td className="px-2 py-2 text-11 text-neutral-500">
                    <Coverage intendedCoverage={r.intended_coverage} />
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
      <div className="p-3 border-t border-neutral-100 text-11 text-neutral-500 flex items-start gap-1.5">
        <Info size={12} className="mt-0.5" />
        <span>
          Coverage lists the GSTR-1 tables built from each report. B2B reports are not built: file B2B invoices separately.
          A new file for the same report replaces the earlier one. Amazon MTR B2C, Flipkart Sales and Meesho Sales have tested
          layouts; other marketplaces are read only when their column names match — <strong>Beta, verify before filing</strong>.
        </span>
      </div>
    </section>
  );
}

function ReportState({ scope, marketplace, report }: {
  scope: { client_id: string; gstin: string; period: string };
  marketplace: string;
  report: ReportEntry;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('client_id', scope.client_id);
      fd.append('gstin', scope.gstin);
      fd.append('period', scope.period);
      fd.append('marketplace', marketplace);
      fd.append('report_kind', report.key);
      return repoticApi.upload(fd);
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['repotic.marketplaces'] });
      await qc.invalidateQueries({ queryKey: ['repotic.uploads'] });
      await qc.invalidateQueries({ queryKey: ['repotic.gstr1'] });
      const rows = r.parse?.rows ?? 0;
      const warn = r.parse?.warnings?.length ? ` Check: ${r.parse.warnings.join('; ')}.` : '';
      if (warn) {
        toast.push('info', `Uploaded — ${rows} row${rows === 1 ? '' : 's'} parsed.${warn}`);
      } else if (r.detect_status === 'matched' || r.detect_status === 'auto_detected') {
        toast.push('success', `Uploaded — ${rows} row${rows === 1 ? '' : 's'} parsed.`);
      } else if (r.detect_status === 'drifted') {
        toast.push('info', `Uploaded with warnings — some columns differ from last time.`);
      } else {
        toast.push('error', r.error_message ?? "We couldn't read this file. Please check the export is the right report.");
      }
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  if (report.upload) {
    const u = report.upload;
    const usable = u.detectStatus === 'matched' || u.detectStatus === 'drifted' || u.detectStatus === 'auto_detected';
    return (
      <div className="space-y-1">
        {usable ? (
          <div className="inline-flex items-center gap-1 text-12 text-success">
            <Check size={13} strokeWidth={2} />
            Uploaded{u.rows ? ` · ${u.rows} rows` : ''}
          </div>
        ) : (
          <div className="inline-flex items-center gap-1 text-12 text-danger">
            <AlertTriangle size={13} strokeWidth={2} />
            Couldn't read this file — try a different export
          </div>
        )}
        {u.detectStatus === 'drifted' && u.drift ? (
          <div className="text-11 text-amber bg-amber/10 border-l-2 border-amber px-2 py-1">
            Some columns changed since last time — {u.drift.newColumns.length} new, {u.drift.missingColumns.length} missing. Review before building.
          </div>
        ) : null}
        <button type="button" className="text-11 text-primary hover:underline"
          onClick={() => setUploading(true)}>
          {usable ? 'Replace file' : 'Try another file'}
        </button>
        {uploading ? (
          <FilePicker onPick={(f) => { upload.mutate(f); setUploading(false); }} onCancel={() => setUploading(false)} />
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <button type="button"
        onClick={() => setUploading(true)}
        disabled={upload.isPending}
        className="h-7 px-2 text-12 inline-flex items-center gap-1 border border-neutral-300 rounded hover:bg-neutral-50 disabled:opacity-60"
      >
        <Upload size={12} strokeWidth={2} />
        {upload.isPending ? 'Uploading…' : 'Upload'}
      </button>
      {uploading ? (
        <FilePicker onPick={(f) => { upload.mutate(f); setUploading(false); }} onCancel={() => setUploading(false)} />
      ) : null}
    </div>
  );
}

function FilePicker({ onPick, onCancel }: { onPick: (f: File) => void; onCancel: () => void }) {
  return (
    <div className="mt-1 flex items-center gap-2">
      <input type="file" accept=".xlsx,.csv"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); }}
        className="text-11" />
      <button type="button" onClick={onCancel} className="text-11 text-neutral-500 hover:text-neutral-900">cancel</button>
    </div>
  );
}

function Coverage({ intendedCoverage }: { intendedCoverage: string[] }) {
  if (intendedCoverage.length === 0) return <span>not built (B2B)</span>;
  return <span>Tables {intendedCoverage.join(', ')}</span>;
}

/** Every file uploaded for this scope, current and replaced, with delete. */
function UploadsList({ scope }: { scope: { client_id: string; gstin: string; period: string } }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['repotic.uploads', scope.client_id, scope.gstin, scope.period],
    queryFn: () => repoticApi.uploads(scope),
  });
  const del = useMutation({
    mutationFn: (id: string) => repoticApi.deleteUpload(id),
    onSuccess: async () => {
      await Promise.all(['repotic.uploads', 'repotic.marketplaces', 'repotic.gstr1'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      toast.push('success', 'Upload deleted. Its rows are no longer in the GSTR-1.');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const items = q.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section className="mt-4 bg-white border border-neutral-200 rounded overflow-hidden">
      <div className="p-4 border-b border-neutral-200">
        <div className="text-11 tracking-[0.06em] text-neutral-500 mb-1">UPLOADED FILES</div>
        <div className="text-12 text-neutral-500">Only the current file of each report is built. A replaced file is kept for the record.</div>
      </div>
      <table className="w-full min-w-[720px] text-13">
        <thead>
          <tr className="text-11 uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-200">
            <th className="text-left px-4 h-8 font-medium">File</th>
            <th className="text-left px-2 font-medium">Report</th>
            <th className="text-right px-2 font-medium">Rows</th>
            <th className="text-left px-2 font-medium">Status</th>
            <th className="text-left px-2 font-medium">Uploaded</th>
            <th className="px-4 w-10" />
          </tr>
        </thead>
        <tbody>
          {items.map((u) => {
            const current = u.status !== 'superseded' && u.detect_status !== 'no_match';
            return (
              <tr key={u.id} className="border-b border-neutral-100">
                <td className="px-4 py-2 text-neutral-800 truncate max-w-[280px]">{u.original_name}</td>
                <td className="px-2 py-2 text-neutral-600">{u.marketplace} · {u.report_kind}</td>
                <td className="px-2 py-2 text-right text-neutral-700">{u.row_count}</td>
                <td className="px-2 py-2">
                  {u.detect_status === 'no_match' ? <span className="text-danger">Not read</span>
                    : current ? <span className="text-success">Current</span>
                    : <span className="text-neutral-500">Replaced</span>}
                </td>
                <td className="px-2 py-2 text-neutral-500">{new Date(u.uploaded_at).toLocaleString()}</td>
                <td className="px-4 py-2 text-right">
                  <button type="button" aria-label={`Delete ${u.original_name}`} disabled={del.isPending}
                    onClick={() => { if (window.confirm(`Delete ${u.original_name}? Its rows leave the GSTR-1.`)) del.mutate(u.id); }}
                    className="text-neutral-400 hover:text-danger disabled:opacity-60">
                    <Trash2 size={14} strokeWidth={1.75} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Phase 3 — Build GSTR-1 preview. Reads a per-scope summary from the
 * backend and offers a download link. The summary number is what firms
 * use to decide "is this safe to download?" — a sudden drop in b2cs
 * rows against last month is usually an unparsed Cancel adjustment or a
 * missing upload, which the summary surfaces before download.
 */
function BuildGstr1Section({ scope }: { scope: { client_id: string; gstin: string; period: string } }) {
  const summaryQ = useQuery({
    queryKey: ['repotic.gstr1', scope.client_id, scope.gstin, scope.period],
    queryFn: () => repoticApi.gstr1Summary(scope),
    enabled: true,
  });
  const anyRows = (summaryQ.data?.counts.total_rows ?? 0) > 0;
  const downloadHref = repoticApi.gstr1DownloadUrl(scope);
  return (
    <section className="mt-4 bg-white border border-neutral-200 rounded">
      <div className="p-4 border-b border-neutral-200 flex items-center justify-between gap-4">
        <div>
          <div className="text-11 tracking-[0.06em] text-neutral-500 mb-1">BUILD</div>
          <div className="text-14 font-semibold text-neutral-900">GSTR-1 preview</div>
          <div className="text-11 text-neutral-500 mt-0.5">
            Tables 5A, 7, 9B (B2C-large credit notes), 12 and 14 — from the current file of each report above.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={`/audit-automation/ecommerce/summary?client_id=${encodeURIComponent(scope.client_id)}&gstin=${encodeURIComponent(scope.gstin)}&period=${encodeURIComponent(scope.period)}`}
            aria-disabled={!anyRows}
            className={
              'h-9 px-3 text-13 inline-flex items-center gap-1 border rounded ' +
              (anyRows
                ? 'border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-700'
                : 'border-neutral-200 text-neutral-400 cursor-not-allowed pointer-events-none')
            }
          >
            View GSTR-1 summary
          </Link>
          <a href={anyRows ? downloadHref : undefined}
            aria-disabled={!anyRows}
            className={
              'h-9 px-3 text-13 inline-flex items-center gap-1 border rounded ' +
              (anyRows
                ? 'border-neutral-300 text-neutral-900 hover:bg-neutral-50'
                : 'border-neutral-200 text-neutral-400 cursor-not-allowed')
            }
            onClick={(e) => { if (!anyRows) e.preventDefault(); }}
            download={anyRows ? `gstr1-preview-${scope.gstin}-${scope.period}.json` : undefined}
          >
            Download JSON
          </a>
        </div>
      </div>
      <div className="p-4">
        {summaryQ.isLoading ? (
          <div className="text-13 text-neutral-500">Checking what's buildable…</div>
        ) : !anyRows ? (
          <div className="text-13 text-neutral-500">
            Upload a matched marketplace report above to populate the GSTR-1 preview.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <TableCount label="5A — B2C Large (> ₹1 lakh, inter-state)" count={summaryQ.data!.counts.b2cl} />
              <TableCount label="7 — B2C Small (net of returns)" count={summaryQ.data!.counts.b2cs + summaryQ.data!.counts.b2cs_returns} />
              <TableCount label="9B — Credit notes on B2C Large" count={summaryQ.data!.counts.cdnur} />
              <TableCount label="12 — HSN summary" count={summaryQ.data!.counts.hsn} />
            </div>
            <div className="mt-3 text-11 text-neutral-500 flex items-start gap-1.5">
              <Info size={12} className="mt-0.5" />
              <span>
                {summaryQ.data!.counts.total_rows} source rows{' '}
                {summaryQ.data!.counts.excluded_free_replacement
                  ? `· ${summaryQ.data!.counts.excluded_free_replacement} free-replacement rows excluded`
                  : ''}{' '}
                {summaryQ.data!.counts.excluded_other
                  ? `· ${summaryQ.data!.counts.excluded_other} unclassified rows excluded`
                  : ''}{' '}
                {summaryQ.data!.counts.excluded_other_gstin
                  ? `· ${summaryQ.data!.counts.excluded_other_gstin} rows of another GSTIN excluded`
                  : ''}{' '}
                {summaryQ.data!.counts.excluded_out_of_period
                  ? `· ${summaryQ.data!.counts.excluded_out_of_period} rows outside the period excluded`
                  : ''}{' '}
                {summaryQ.data!.counts.excluded_b2b
                  ? `· ${summaryQ.data!.counts.excluded_b2b} B2B rows not built`
                  : ''}
                . Beta — verify before filing: the JSON is not yet checked against the GSTN offline tool.
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function TableCount({ label, count }: { label: string; count: number }) {
  return (
    <div className="border border-neutral-200 rounded p-3">
      <div className="text-11 text-neutral-500">{label}</div>
      <div className="text-18 font-semibold text-neutral-900 mt-1">{count}</div>
    </div>
  );
}
