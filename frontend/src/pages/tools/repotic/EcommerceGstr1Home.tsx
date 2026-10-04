/**
 * /audit-automation/ecommerce — Repotic Ecommerce GSTR-1 landing
 * (REPOTIC-MODULE.md §4.1).
 *
 * The import screen. Scope selector (client × GSTIN × period) at the
 * top, then one row per marketplace × report-kind with the current
 * state against that scope:
 *
 *   SOURCE            REPORT              STATE / ACTION          COVERAGE
 *   Amazon            MTR B2C             ✓ uploaded 412 rows     all tables
 *                     MTR B2B             [ Upload ]               all tables
 *   Myntra            Sales               [ Upload ]               no doc 13
 *
 * The coverage column replaces the original Repotic's export-time
 * surprise modal — nobody discovers at download that document summary
 * doesn't work for Myntra; they see it before uploading anything.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeft, Upload, Check, AlertTriangle, Info } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { repoticApi, type ReportEntry } from '@/modules/tools/repotic/api';
import { gstApi, recentPeriods } from '@/modules/workstation/gst/api';

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function EcommerceGstr1HomePage() {
  const [clientId, setClientId] = useState<string>('');
  const [gstin, setGstin] = useState<string>('');
  const [period, setPeriod] = useState<string>(currentMonth());
  const periods = useMemo(() => recentPeriods(12), []);

  const clients = useQuery({ queryKey: ['gst.clients'], queryFn: () => gstApi.clients() });
  const clientGstinByClient = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of clients.data?.items ?? []) {
      if (c.client_id) m.set(c.client_id, c.gstin);
    }
    return m;
  }, [clients.data]);

  // Lock GSTIN to the selected client's primary GST profile (same model
  // GST module uses — one GSTIN per client in the common case).
  const effectiveGstin = clientGstinByClient.get(clientId) ?? gstin;

  const scoped = clientId && effectiveGstin && period
    ? { client_id: clientId, gstin: effectiveGstin, period }
    : undefined;

  const marketplacesQ = useQuery({
    queryKey: ['repotic.marketplaces', scoped?.client_id, scoped?.gstin, scoped?.period],
    queryFn: () => repoticApi.marketplaces(scoped),
  });

  const clientName = clients.data?.items.find((c) => c.client_id === clientId)?.client_name ?? '';

  // Push the scope to the AuditOS browser extension (if installed) so the
  // marketplace FAB on Amazon Seller Central etc. already knows which
  // client × GSTIN × period to attach uploads to. The extension listens for
  // this on crm-bridge; if it isn't installed the postMessage is a no-op.
  useEffect(() => {
    if (clientId && effectiveGstin && period && clientName) {
      window.postMessage(
        {
          source: 'auditos-crm',
          type: 'AUDITOS_SET_ECOMMERCE_SCOPE',
          payload: { clientId, clientName, gstin: effectiveGstin, period },
        },
        window.location.origin,
      );
    }
  }, [clientId, clientName, effectiveGstin, period]);

  return (
    <div className="max-w-[1240px] mx-auto">
      <div className="mb-4">
        <Link to="/audit-automation" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> Repotic
        </Link>
      </div>

      <header className="mb-5">
        <h1 className="text-20 font-semibold text-neutral-900">Ecommerce GSTR-1</h1>
        <p className="text-13 text-neutral-500 mt-1">
          One normalised set of rows from the marketplaces the seller uses, built into the government's GSTR-1 tables.
        </p>
      </header>

      <section className="bg-white border border-neutral-200 rounded p-4 mb-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <label className="text-11 text-neutral-500">
            Client
            <select value={clientId} onChange={(e) => { setClientId(e.target.value); setGstin(''); }}
              className="mt-1 h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white">
              <option value="">— pick a client —</option>
              {(clients.data?.items ?? []).map((c) => (
                <option key={c.id} value={c.client_id ?? ''}>
                  {c.client_name ?? c.legal_name ?? '—'} · {c.gstin}
                </option>
              ))}
            </select>
          </label>
          <label className="text-11 text-neutral-500">
            GSTIN
            <input value={effectiveGstin} onChange={(e) => setGstin(e.target.value.toUpperCase())}
              placeholder="33ABCDE1234F1Z5" maxLength={15}
              disabled={Boolean(clientGstinByClient.get(clientId))}
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
          Coverage states what each adapter can and cannot produce — stated here before upload, not surprised at export.
          An adapter not yet configured for your firm shows <strong>Adapter missing</strong>; a drifted file is parsed with a loud warning.
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
      if (r.detect_status === 'matched') {
        toast.push('success', `Uploaded — adapter v${r.adapter_version} matched the header.`);
      } else if (r.detect_status === 'drifted') {
        toast.push('info', `Uploaded with warnings — header drifted from adapter v${r.adapter_version}.`);
      } else {
        toast.push('error', 'Header did not match any adapter. Add a marketplace adapter or map columns manually.');
      }
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  if (report.upload) {
    const u = report.upload;
    const usable = u.detectStatus === 'matched' || u.detectStatus === 'drifted';
    return (
      <div className="space-y-1">
        {usable ? (
          <div className="inline-flex items-center gap-1 text-12 text-success">
            <Check size={13} strokeWidth={2} />
            Uploaded {u.rows ? `· ${u.rows} rows` : ''} · adapter v{u.adapterVersion ?? '?'}
          </div>
        ) : (
          <div className="inline-flex items-center gap-1 text-12 text-danger">
            <AlertTriangle size={13} strokeWidth={2} />
            Last upload rejected — header did not match any adapter
          </div>
        )}
        {u.detectStatus === 'drifted' && u.drift ? (
          <div className="text-11 text-amber bg-amber/10 border-l-2 border-amber px-2 py-1">
            Header drifted — {u.drift.newColumns.length} new column{u.drift.newColumns.length === 1 ? '' : 's'}, {u.drift.missingColumns.length} missing. Review before building.
          </div>
        ) : null}
        {u.detectStatus === 'no_match' ? (
          <div className="text-11 text-danger bg-danger/10 border-l-2 border-danger px-2 py-1">
            Adapter missing — manual column mapping required (Phase 2+).
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
  const noAdapter = report.adapter_versions === 0;
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
      {noAdapter ? (
        <div className="text-11 text-neutral-500 inline-flex items-center gap-1">
          <AlertTriangle size={11} /> No adapter configured yet for this firm. Upload a sample to seed one.
        </div>
      ) : (
        <div className="text-11 text-neutral-400">Adapter v{report.latest_adapter_version} available.</div>
      )}
      {uploading ? (
        <FilePicker onPick={(f) => { upload.mutate(f); setUploading(false); }} onCancel={() => setUploading(false)} />
      ) : null}
    </div>
  );
}

function FilePicker({ onPick, onCancel }: { onPick: (f: File) => void; onCancel: () => void }) {
  return (
    <div className="mt-1 flex items-center gap-2">
      <input type="file" accept=".xlsx,.xls,.csv,.tsv,.txt"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); }}
        className="text-11" />
      <button type="button" onClick={onCancel} className="text-11 text-neutral-500 hover:text-neutral-900">cancel</button>
    </div>
  );
}

function Coverage({ intendedCoverage }: { intendedCoverage: string[] }) {
  const ALL = ['4A', '5A', '7', '9B', '6A', '11A', '11B', '8', '12', '13', '14a'];
  const missing = ALL.filter((t) => !intendedCoverage.includes(t));
  if (missing.length === 0) return <span className="text-success">all tables</span>;
  if (missing.length === 1) return <span>no table {missing[0] === '13' ? 'doc 13' : missing[0]}</span>;
  return <span>no {missing.map((t) => (t === '13' ? 'doc 13' : t)).join(', ')}</span>;
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
            Tables 5A, 7, 9B and 12 — assembled from every matched upload above.
          </div>
        </div>
        <a href={anyRows ? downloadHref : undefined}
          aria-disabled={!anyRows}
          className={
            'h-9 px-3 text-13 inline-flex items-center gap-1 border rounded ' +
            (anyRows
              ? 'border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-700'
              : 'border-neutral-200 text-neutral-400 cursor-not-allowed')
          }
          onClick={(e) => { if (!anyRows) e.preventDefault(); }}
          download={anyRows ? `gstr1-preview-${scope.gstin}-${scope.period}.json` : undefined}
        >
          Download JSON
        </a>
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
              <TableCount label="5A — B2C Large (≥ ₹1 lakh)" count={summaryQ.data!.counts.b2cl} />
              <TableCount label="7 — B2C Small (consolidated)" count={summaryQ.data!.counts.b2cs} />
              <TableCount label="9B — Credit/debit notes" count={summaryQ.data!.counts.cdnur} />
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
                  : ''}
                . Preview JSON is for human review — not yet verified against the GSTN offline tool schema.
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
