/**
 * Bookkeeping · Client Dashboard file generator (BOOKKEEPING-REBUILD §6).
 *
 * The deliverable the firm actually sends. This page lets the operator
 * pick a period (via the workspace's PeriodBar) and generate a single
 * self-contained HTML file the recipient opens on a phone with no
 * network. The heavy lifting lives on the backend; this page is just
 * the "generate + download + history" triple.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { bookkeepingAccountingApi } from '@/modules/tools/audit-automation/bookkeeping';
import { usePeriod } from '@/modules/tools/bookkeeping/ui';

/** Turn the period label + FY into the strings the backend needs. */
function useReportContext() {
  const period = usePeriod();
  const fy = period.financialYears.find((f) => f.id === period.fyId) ?? period.financialYears[0] ?? null;
  return {
    from: period.from,
    to: period.to,
    periodLabel: period.label,
    fyLabel: fy?.label ?? '—',
  };
}

export function BookkeepingClientDashboardPage() {
  const { companyId = '' } = useParams();
  const qc = useQueryClient();
  const ctx = useReportContext();

  // The firm's own name and contact land in the file's header + footer.
  // These are per-generation values so an operator can rename the
  // deliverable for a specific client without editing settings.
  const [preparedBy, setPreparedBy] = useState('JNS Accounting Solutions');
  const [firmContact, setFirmContact] = useState('');
  const [lastId, setLastId] = useState<string | null>(null);

  const runsQ = useQuery({
    queryKey: ['bk.client-reports', companyId],
    queryFn: () => bookkeepingAccountingApi.listClientReports(companyId),
    enabled: Boolean(companyId),
  });

  const genMut = useMutation({
    mutationFn: () =>
      bookkeepingAccountingApi.generateClientReport(companyId, {
        from: ctx.from,
        to: ctx.to,
        period_label: ctx.periodLabel,
        fy_label: ctx.fyLabel,
        prepared_by: preparedBy,
        firm_contact: firmContact || null,
      }),
    onSuccess: (r) => {
      setLastId(r.id);
      void qc.invalidateQueries({ queryKey: ['bk.client-reports', companyId] });
    },
  });

  return (
    <div className="max-w-[960px] space-y-4">
      <div>
        <h2 className="text-16 font-semibold text-neutral-900">Client dashboard</h2>
        <p className="text-13 text-neutral-500 mt-1">
          Generate the one-page HTML file the firm sends over WhatsApp — self-contained,
          offline, no login, works on a phone with no signal. Every generation is
          audited; re-download from the history to prove which bytes were sent.
        </p>
      </div>

      <div className="border border-neutral-200 rounded p-3 bg-white space-y-3">
        <div className="text-13 font-medium text-neutral-900">Header — appears on the file</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="text-12 text-neutral-700 block">
            Prepared by
            <input
              value={preparedBy}
              onChange={(e) => setPreparedBy(e.target.value)}
              className="mt-1 w-full h-8 px-2 text-13 border border-neutral-300 rounded"
            />
          </label>
          <label className="text-12 text-neutral-700 block">
            Firm contact (email + phone, one line)
            <input
              value={firmContact}
              onChange={(e) => setFirmContact(e.target.value)}
              placeholder="accounts@jns.example · +91 XXXXX XXXXX"
              className="mt-1 w-full h-8 px-2 text-13 border border-neutral-300 rounded"
            />
          </label>
        </div>

        <div className="text-12 text-neutral-500 border-t border-neutral-100 pt-3">
          Period covered: <span className="text-neutral-900 font-medium">{ctx.periodLabel}</span>
          {' · '}
          FY <span className="text-neutral-900 font-medium">{ctx.fyLabel}</span>
          {' · '}
          <span className="font-mono text-11">{ctx.from} to {ctx.to}</span>
          <div className="text-11 text-neutral-500 mt-1">
            Change the period from the bar at the top of the page.
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2 border-t border-neutral-100">
          <button
            type="button"
            disabled={genMut.isPending}
            onClick={() => genMut.mutate()}
            className="text-13 px-3 py-1 border border-neutral-900 bg-neutral-900 text-white rounded disabled:opacity-40"
          >
            {genMut.isPending ? 'Generating…' : 'Generate report'}
          </button>
          {lastId && (
            <a
              href={bookkeepingAccountingApi.clientReportDownloadUrl(companyId, lastId)}
              className="text-13 text-gold hover:underline"
              download
            >
              Download the file just generated →
            </a>
          )}
          {genMut.isError && (
            <span className="text-12 text-danger">{(genMut.error as Error).message}</span>
          )}
        </div>
      </div>

      <div className="border border-neutral-200 rounded p-3 bg-white">
        <div className="text-13 font-medium text-neutral-900 mb-2">History</div>
        {runsQ.isLoading ? (
          <div className="text-12 text-neutral-500">Loading…</div>
        ) : (runsQ.data?.items ?? []).length === 0 ? (
          <div className="text-12 text-neutral-500">Nothing generated yet.</div>
        ) : (
          <table className="w-full text-13">
            <thead>
              <tr className="text-11 uppercase text-neutral-500 tracking-[0.06em] border-b border-neutral-100">
                <th className="text-left py-1.5 pr-3">Generated</th>
                <th className="text-left py-1.5 pr-3">Period</th>
                <th className="text-left py-1.5 pr-3">File</th>
                <th className="text-left py-1.5">SHA-256</th>
                <th className="text-right py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {runsQ.data!.items.map((r) => (
                <tr key={r.id} className="border-b border-neutral-100">
                  <td className="py-1 pr-3 text-neutral-700">{new Date(r.createdAt).toLocaleString('en-IN')}</td>
                  <td className="py-1 pr-3 text-neutral-700">{r.periodLabel}</td>
                  <td className="py-1 pr-3 font-mono text-11 text-neutral-600 truncate max-w-[220px]" title={r.fileName}>{r.fileName}</td>
                  <td className="py-1 pr-3 font-mono text-11 text-neutral-400" title={r.fileSha256}>{r.fileSha256.slice(0, 12)}…</td>
                  <td className="py-1 text-right">
                    <a
                      href={bookkeepingAccountingApi.clientReportDownloadUrl(companyId, r.id)}
                      className="text-12 text-gold hover:underline"
                      download
                    >
                      Download →
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
