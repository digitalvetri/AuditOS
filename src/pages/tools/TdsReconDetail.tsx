import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { tdsApi, type TdsActionStatus, type TdsMatchStatus, type TdsReconJob, type TdsReconRow } from '@/modules/tools/audit-automation/tds';
import type { ApiError } from '@/services/api';

export function TdsReconDetailPage() {
  const { jobId = '' } = useParams();
  const [tab, setTab] = useState<'all' | TdsMatchStatus>('all');

  const jobQ = useQuery({
    queryKey: ['tds.job', jobId],
    enabled: Boolean(jobId),
    queryFn: () => tdsApi.getRecon(jobId),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'queued' || s === 'matching' ? 1500 : false;
    },
  });
  const rowsQ = useQuery({
    queryKey: ['tds.rows', jobId, tab],
    enabled: Boolean(jobId) && jobQ.data?.status === 'matched',
    queryFn: () => tdsApi.getReconRows(jobId, tab === 'all' ? {} : { status: tab }),
  });

  return (
    <div className="max-w-[1400px] mx-auto" data-testid="tds-detail">
      <div className="mb-4">
        <Link to="/audit-automation/tds" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> TDS reconciliation
        </Link>
      </div>

      {jobQ.isLoading ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">Loading…</div>
      ) : jobQ.error ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-danger">Could not load this reconciliation.</div>
      ) : jobQ.data ? (
        <>
          <SummaryHeader job={jobQ.data} />
          {jobQ.data.status !== 'matched' ? (
            <div className="bg-white border border-neutral-200 rounded p-6 mt-4 text-13 text-neutral-500">
              {jobQ.data.status === 'failed'
                ? (jobQ.data.error_message || 'Reconciliation failed.')
                : `Status: ${jobQ.data.status}…`}
            </div>
          ) : (
            <>
              <Tabs current={tab} onChange={setTab} counts={{
                all: jobQ.data.verified_count + jobQ.data.variance_count + jobQ.data.only_26as_count + jobQ.data.only_books_count,
                verified: jobQ.data.verified_count,
                variance: jobQ.data.variance_count,
                only_26as: jobQ.data.only_26as_count,
                only_books: jobQ.data.only_books_count,
              }} />
              <RowsTable jobId={jobId} rows={rowsQ.data?.items ?? []} loading={rowsQ.isLoading} />
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

function SummaryHeader({ job }: { job: TdsReconJob }) {
  const total = job.verified_count + job.variance_count + job.only_26as_count + job.only_books_count;
  const verifiedPct = total > 0 ? Math.round((job.verified_count / total) * 100) : 0;
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <SummaryCard label="Verified" value={job.verified_count} accent="text-green-700" bar="bg-green-500" pct={verifiedPct} />
      <SummaryCard label="Variance" value={job.variance_count} accent="text-amber-700" bar="bg-amber-500" />
      <SummaryCard label="Only in 26AS" value={job.only_26as_count} accent="text-neutral-700" bar="bg-neutral-400" />
      <SummaryCard label="Only in Books" value={job.only_books_count} accent="text-neutral-700" bar="bg-neutral-400" />
      <div className="bg-white border border-neutral-200 rounded p-3 flex flex-col justify-between">
        <div>
          <div className="text-11 tracking-[0.06em] text-neutral-500">EXPORT</div>
          <div className="text-14 text-neutral-900 mt-1">Reconciliation workbook</div>
        </div>
        <a href={tdsApi.exportUrl(job.id)} download className="mt-3 inline-flex items-center gap-1 text-12 text-gold font-medium">
          <Download size={12} strokeWidth={1.75} /> XLSX
        </a>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, accent, bar, pct }: { label: string; value: number; accent: string; bar: string; pct?: number }) {
  return (
    <div className="bg-white border border-neutral-200 rounded p-3">
      <div className="text-11 tracking-[0.06em] text-neutral-500">{label.toUpperCase()}</div>
      <div className={'text-20 font-semibold mt-1 ' + accent}>{value}</div>
      {pct !== undefined ? (
        <>
          <div className="text-11 text-neutral-500 mt-1">{pct}% of all rows</div>
          <div className="mt-1 h-1 bg-neutral-100 rounded overflow-hidden">
            <div className={'h-full ' + bar} style={{ width: `${pct}%` }} />
          </div>
        </>
      ) : null}
    </div>
  );
}

function Tabs({ current, onChange, counts }: {
  current: 'all' | TdsMatchStatus;
  onChange: (v: 'all' | TdsMatchStatus) => void;
  counts: Record<'all' | TdsMatchStatus, number>;
}) {
  const items: { key: 'all' | TdsMatchStatus; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'verified', label: 'Verified' },
    { key: 'variance', label: 'Variance' },
    { key: 'only_26as', label: 'Only in 26AS' },
    { key: 'only_books', label: 'Only in Books' },
  ];
  return (
    <div className="mt-4 flex gap-1 border-b border-neutral-200">
      {items.map((i) => (
        <button
          key={i.key}
          type="button"
          onClick={() => onChange(i.key)}
          className={
            'px-3 py-2 text-13 border-b-2 -mb-px transition-colors ' +
            (current === i.key
              ? 'border-gold text-neutral-900 font-medium'
              : 'border-transparent text-neutral-500 hover:text-neutral-900')
          }
        >
          {i.label} <span className="text-11 text-neutral-400 ml-1">{counts[i.key]}</span>
        </button>
      ))}
    </div>
  );
}

function RowsTable({ jobId, rows, loading }: { jobId: string; rows: TdsReconRow[]; loading?: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();

  const update = async (rowId: string, action: TdsActionStatus) => {
    try {
      await tdsApi.updateRow(rowId, { action_status: action });
      toast.push('success', 'Action updated.');
      await qc.invalidateQueries({ queryKey: ['tds.rows', jobId] });
    } catch (err) {
      toast.push('error', (err as ApiError).message);
    }
  };

  if (loading) return <div className="mt-3 bg-white border border-neutral-200 rounded p-4 text-13 text-neutral-500">Loading rows…</div>;
  if (rows.length === 0) return <div className="mt-3 bg-white border border-neutral-200 rounded p-4 text-13 text-neutral-500">No rows in this bucket.</div>;

  return (
    <div className="mt-3 bg-white border border-neutral-200 rounded overflow-x-auto">
      <table className="w-full text-13 min-w-[1100px]">
        <thead>
          <tr className="text-left text-11 text-neutral-500 tracking-[0.06em]">
            <th className="px-3 py-2 font-normal">STATUS</th>
            <th className="px-3 py-2 font-normal">DEDUCTOR</th>
            <th className="px-3 py-2 font-normal">SECTION</th>
            <th className="px-3 py-2 font-normal">QTR</th>
            <th className="px-3 py-2 font-normal text-right">26AS TDS</th>
            <th className="px-3 py-2 font-normal text-right">BOOKS TDS</th>
            <th className="px-3 py-2 font-normal">MISMATCHES</th>
            <th className="px-3 py-2 font-normal">ACTION</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const two = r.filing_26as_entry;
            const b = r.books_entry;
            const deductor = two?.deductor_name ?? b?.deductor_name ?? '—';
            const tan = two?.deductor_tan ?? b?.deductor_tan ?? '—';
            const section = two?.section ?? b?.section ?? '';
            const qtr = two?.quarter ?? b?.quarter ?? '';
            return (
              <tr key={r.id} className="border-t border-neutral-100">
                <td className="px-3 py-2 whitespace-nowrap"><StatusChip status={r.match_status} /></td>
                <td className="px-3 py-2">
                  <div className="text-neutral-900 truncate max-w-[200px]" title={deductor}>{deductor}</div>
                  <div className="text-11 text-neutral-500 font-mono">{tan}</div>
                </td>
                <td className="px-3 py-2 text-neutral-900">{section}</td>
                <td className="px-3 py-2 text-neutral-700">{qtr}</td>
                <td className="px-3 py-2 text-right tabular-nums">{two ? paiseText(two.tds_amount) : '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{b ? paiseText(b.tds_amount) : '—'}</td>
                <td className="px-3 py-2">
                  {r.mismatch_fields.length === 0 ? <span className="text-neutral-400">—</span> : (
                    <div className="flex flex-wrap gap-1">
                      {r.mismatch_fields.map((f) => (
                        <span key={f} className="text-11 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">{f}</span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <select
                    value={r.action_status}
                    onChange={(e) => update(r.id, e.target.value as TdsActionStatus)}
                    className="h-7 px-2 text-12 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
                  >
                    <option value="no_action">No action</option>
                    <option value="chase_deductor">Chase deductor</option>
                    <option value="revise_book">Revise book</option>
                    <option value="credit_claimed">Credit claimed</option>
                    <option value="written_off">Written off</option>
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatusChip({ status }: { status: TdsMatchStatus }) {
  const map: Record<TdsMatchStatus, { label: string; cls: string }> = {
    verified: { label: 'Verified', cls: 'border-l-green-500 text-green-700' },
    variance: { label: 'Variance', cls: 'border-l-amber-500 text-amber-700' },
    only_26as: { label: 'Only 26AS', cls: 'border-l-neutral-400 text-neutral-700' },
    only_books: { label: 'Only Books', cls: 'border-l-neutral-400 text-neutral-700' },
  };
  const s = map[status];
  return (
    <span className={'inline-flex items-center pl-2 pr-1 border-l-2 text-11 font-medium ' + s.cls}>
      {s.label}
    </span>
  );
}

function paiseText(p: number): string {
  return (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
