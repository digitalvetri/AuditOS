/**
 * Bookkeeping · Client Dashboard (BOOKKEEPING-REBUILD §6).
 *
 * Shows the client's financial dashboard exactly as the client will get
 * it: the page is the same HTML the generated file carries, served by the
 * API and shown in a sandboxed frame. Its own sidebar and top bar switch
 * reports and periods (monthly / quarterly / yearly, vs prior) on the
 * financial year chosen in the workspace's period bar.
 *
 * Above it, the deliverable workflow: set the "prepared by" line, generate
 * the one self-contained file sent over WhatsApp, download it, and
 * re-download any earlier file from the audited history.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { Download, FileText, History, Maximize2, RefreshCw } from 'lucide-react';
import { bookkeepingAccountingApi } from '@/modules/tools/audit-automation/bookkeeping';
import { usePeriod } from '@/modules/tools/bookkeeping/ui';

const INDIGO = '#4f46e5';

export function BookkeepingClientDashboardPage() {
  const { companyId = '' } = useParams();
  const qc = useQueryClient();
  const period = usePeriod();
  const fy = period.financialYears.find((f) => f.id === period.fyId) ?? period.financialYears[0] ?? null;

  // The firm's own name and contact land in the dashboard's sidebar and footer.
  const [preparedBy, setPreparedBy] = useState('JNS Accounting Solutions');
  const [firmContact, setFirmContact] = useState('');
  const [applied, setApplied] = useState({ preparedBy, firmContact });
  const [lastId, setLastId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const viewUrl = bookkeepingAccountingApi.clientDashboardViewUrl(companyId, {
    from: period.from, to: period.to, fy_id: fy?.id,
    prepared_by: applied.preparedBy || undefined, firm_contact: applied.firmContact || undefined,
  });

  const runsQ = useQuery({
    queryKey: ['bk.client-reports', companyId],
    queryFn: () => bookkeepingAccountingApi.listClientReports(companyId),
    enabled: Boolean(companyId),
  });

  const genMut = useMutation({
    mutationFn: () =>
      bookkeepingAccountingApi.generateClientReport(companyId, {
        from: period.from, to: period.to, fy_id: fy?.id ?? null,
        prepared_by: preparedBy.trim(), firm_contact: firmContact.trim() || null,
      }),
    onSuccess: (r) => {
      setLastId(r.id);
      setApplied({ preparedBy: preparedBy.trim(), firmContact: firmContact.trim() });
      void qc.invalidateQueries({ queryKey: ['bk.client-reports', companyId] });
    },
  });

  const dirty = preparedBy.trim() !== applied.preparedBy || firmContact.trim() !== applied.firmContact;
  const input = 'h-8 px-2.5 text-13 border border-neutral-300 rounded-md bg-white min-w-0';
  const runs = runsQ.data?.items ?? [];

  return (
    <div className="space-y-3">
      <div className="bg-white border border-neutral-200 rounded-lg px-3 py-2.5 flex flex-wrap items-end gap-2.5">
        <div className="mr-auto">
          <h2 className="text-15 font-semibold text-neutral-900">Client dashboard</h2>
          <p className="text-12 text-neutral-500">FY {fy?.label ?? '—'} · switch reports and periods inside the dashboard. Generate the file to send it to the client.</p>
        </div>
        <label className="text-11 text-neutral-600 flex flex-col gap-0.5">Prepared by
          <input value={preparedBy} onChange={(e) => setPreparedBy(e.target.value)} className={input + ' w-56'} />
        </label>
        <label className="text-11 text-neutral-600 flex flex-col gap-0.5">Firm contact
          <input value={firmContact} onChange={(e) => setFirmContact(e.target.value)} placeholder="accounts@… · +91 …" className={input + ' w-56'} />
        </label>
        {dirty ? (
          <button type="button" onClick={() => setApplied({ preparedBy: preparedBy.trim(), firmContact: firmContact.trim() })}
            className="h-8 px-3 rounded-md text-13 border border-neutral-300 bg-white hover:bg-neutral-50 inline-flex items-center gap-1.5">
            <RefreshCw size={13} />Update preview
          </button>
        ) : null}
        <button type="button" disabled={genMut.isPending || !preparedBy.trim()} onClick={() => genMut.mutate()}
          className="h-8 px-3 rounded-md text-13 font-medium text-white inline-flex items-center gap-1.5 disabled:opacity-50" style={{ background: INDIGO }}>
          <FileText size={14} />{genMut.isPending ? 'Generating…' : 'Generate file'}
        </button>
        {lastId ? (
          <a href={bookkeepingAccountingApi.clientReportDownloadUrl(companyId, lastId)} download
            className="h-8 px-3 rounded-md text-13 font-medium inline-flex items-center gap-1.5 border" style={{ color: '#059669', background: '#d1fae5', borderColor: '#a7f3d0' }}>
            <Download size={14} />Download file
          </a>
        ) : null}
        <button type="button" onClick={() => setShowHistory((s) => !s)} aria-expanded={showHistory}
          className="h-8 px-3 rounded-md text-13 border border-neutral-300 bg-white hover:bg-neutral-50 inline-flex items-center gap-1.5">
          <History size={14} />History{runs.length ? ` (${runs.length})` : ''}
        </button>
        <a href={viewUrl} target="_blank" rel="noreferrer" title="Open the dashboard in a new tab"
          className="h-8 w-8 rounded-md border border-neutral-300 bg-white hover:bg-neutral-50 inline-flex items-center justify-center">
          <Maximize2 size={14} />
        </a>
        {genMut.isError ? <div className="basis-full text-12 text-danger">{(genMut.error as Error).message}</div> : null}
      </div>

      {showHistory ? (
        <div className="bg-white border border-neutral-200 rounded-lg p-3">
          <div className="text-13 font-medium text-neutral-900 mb-2">Generated files</div>
          {runsQ.isLoading ? <div className="text-12 text-neutral-500">Loading…</div>
            : runs.length === 0 ? <div className="text-12 text-neutral-500">Nothing generated yet.</div> : (
              <div className="overflow-x-auto">
                <table className="w-full text-13 min-w-[560px]">
                  <thead>
                    <tr className="text-11 uppercase text-neutral-500 tracking-[0.06em] border-b border-neutral-100">
                      <th className="text-left py-1.5 pr-3">Generated</th><th className="text-left py-1.5 pr-3">Covers</th>
                      <th className="text-left py-1.5 pr-3">File</th><th className="text-left py-1.5">SHA-256</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id} className="border-b border-neutral-100">
                        <td className="py-1 pr-3 text-neutral-700">{new Date(r.createdAt).toLocaleString('en-IN')}</td>
                        <td className="py-1 pr-3 text-neutral-700">{r.periodLabel}</td>
                        <td className="py-1 pr-3 font-mono text-11 text-neutral-600 truncate max-w-[240px]" title={r.fileName}>{r.fileName}</td>
                        <td className="py-1 pr-3 font-mono text-11 text-neutral-400" title={r.fileSha256}>{r.fileSha256.slice(0, 12)}…</td>
                        <td className="py-1 text-right"><a href={bookkeepingAccountingApi.clientReportDownloadUrl(companyId, r.id)} download className="text-12 font-medium hover:underline" style={{ color: INDIGO }}>Download →</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      ) : null}

      <div className="rounded-lg border border-neutral-200 overflow-hidden bg-[#f0f2f5]">
        <iframe
          key={`${viewUrl}#${reloadKey}`}
          src={viewUrl}
          title="Client financial dashboard"
          // The page runs its own script to switch reports and periods; the
          // sandbox keeps it apart from the app (no same-origin access).
          sandbox="allow-scripts allow-modals allow-downloads allow-popups"
          className="w-full block"
          style={{ height: 'max(640px, calc(100dvh - 230px))' }}
        />
      </div>
      <div className="text-11 text-neutral-500">
        Not showing?{' '}
        <button type="button" className="underline" onClick={() => setReloadKey((k) => k + 1)}>Reload the dashboard</button>
        {' '}— it is built from the books each time it opens.
      </div>
    </div>
  );
}
