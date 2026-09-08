import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { gstApi, type ItcClassification, type MatchStatus, type ReconJob, type ReconRow } from '@/modules/tools/audit-automation/gst';
import type { ApiError } from '@/services/api';

/**
 * /audit-automation/gst/jobs/:jobId — recon detail with summary cards,
 * tabbed filter for match buckets, and inline ITC classification edit.
 */
export function GstReconDetailPage() {
  const { jobId = '' } = useParams();
  const [tab, setTab] = useState<'all' | MatchStatus>('all');

  const jobQ = useQuery({
    queryKey: ['gst.job', jobId],
    enabled: Boolean(jobId),
    queryFn: () => gstApi.getRecon(jobId),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'queued' || s === 'matching' ? 1500 : false;
    },
  });
  const rowsQ = useQuery({
    queryKey: ['gst.rows', jobId, tab],
    enabled: Boolean(jobId) && jobQ.data?.status === 'matched',
    queryFn: () => gstApi.getReconRows(jobId, tab === 'all' ? {} : { status: tab }),
  });

  return (
    <div className="max-w-[1400px] mx-auto" data-testid="gst-detail">
      <div className="mb-4">
        <Link to="/audit-automation/gst" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> GST reconciliation
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
                all: jobQ.data.matched_count + jobQ.data.partial_count + jobQ.data.only_2b_count + jobQ.data.only_pr_count,
                matched: jobQ.data.matched_count,
                partial: jobQ.data.partial_count,
                only_2b: jobQ.data.only_2b_count,
                only_pr: jobQ.data.only_pr_count,
              }} />
              <RowsTable jobId={jobId} rows={rowsQ.data?.items ?? []} loading={rowsQ.isLoading} />
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

function SummaryHeader({ job }: { job: ReconJob }) {
  const total = job.matched_count + job.partial_count + job.only_2b_count + job.only_pr_count;
  const matchedPct = total > 0 ? Math.round((job.matched_count / total) * 100) : 0;
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <SummaryCard label="Matched" value={job.matched_count} accent="text-green-700" bar="bg-green-500" pct={matchedPct} />
      <SummaryCard label="Partial" value={job.partial_count} accent="text-amber-700" bar="bg-amber-500" />
      <SummaryCard label="Only in 2B" value={job.only_2b_count} accent="text-neutral-700" bar="bg-neutral-400" />
      <SummaryCard label="Only in PR" value={job.only_pr_count} accent="text-neutral-700" bar="bg-neutral-400" />
      <div className="bg-white border border-neutral-200 rounded p-3 flex flex-col justify-between">
        <div>
          <div className="text-11 tracking-[0.06em] text-neutral-500">EXPORT</div>
          <div className="text-14 text-neutral-900 mt-1">Reconciliation workbook</div>
        </div>
        <a href={gstApi.exportUrl(job.id)} download className="mt-3 inline-flex items-center gap-1 text-12 text-gold font-medium">
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
  current: 'all' | MatchStatus;
  onChange: (v: 'all' | MatchStatus) => void;
  counts: Record<'all' | MatchStatus, number>;
}) {
  const items: { key: 'all' | MatchStatus; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'matched', label: 'Matched' },
    { key: 'partial', label: 'Partial' },
    { key: 'only_2b', label: 'Only in 2B' },
    { key: 'only_pr', label: 'Only in PR' },
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

function RowsTable({ jobId, rows, loading }: { jobId: string; rows: ReconRow[]; loading?: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();

  const update = async (rowId: string, classification: ItcClassification) => {
    try {
      await gstApi.updateRow(rowId, { itc_classification: classification });
      toast.push('success', 'ITC classification updated.');
      await qc.invalidateQueries({ queryKey: ['gst.rows', jobId] });
    } catch (err) {
      toast.push('error', (err as ApiError).message);
    }
  };

  if (loading) return <div className="mt-3 bg-white border border-neutral-200 rounded p-4 text-13 text-neutral-500">Loading rows…</div>;
  if (rows.length === 0) return <div className="mt-3 bg-white border border-neutral-200 rounded p-4 text-13 text-neutral-500">No rows in this bucket.</div>;

  return (
    <div className="mt-3 bg-white border border-neutral-200 rounded overflow-x-auto">
      <table className="w-full text-13 min-w-[1000px]">
        <thead>
          <tr className="text-left text-11 text-neutral-500 tracking-[0.06em]">
            <th className="px-3 py-2 font-normal">STATUS</th>
            <th className="px-3 py-2 font-normal">SUPPLIER</th>
            <th className="px-3 py-2 font-normal">INVOICE #</th>
            <th className="px-3 py-2 font-normal">DATE</th>
            <th className="px-3 py-2 font-normal text-right">2B TAXABLE</th>
            <th className="px-3 py-2 font-normal text-right">PR TAXABLE</th>
            <th className="px-3 py-2 font-normal">MISMATCHES</th>
            <th className="px-3 py-2 font-normal">ITC</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const two = r.filing_2b_entry;
            const pr = r.purchase_register_entry;
            const supplier = two?.supplier_name ?? pr?.supplier_name ?? '—';
            const gstin = two?.supplier_gstin ?? pr?.supplier_gstin ?? '—';
            return (
              <tr key={r.id} className="border-t border-neutral-100">
                <td className="px-3 py-2 whitespace-nowrap"><StatusChip status={r.match_status} /></td>
                <td className="px-3 py-2">
                  <div className="text-neutral-900 truncate max-w-[180px]" title={supplier}>{supplier}</div>
                  <div className="text-11 text-neutral-500 font-mono">{gstin}</div>
                </td>
                <td className="px-3 py-2 text-neutral-900">{two?.invoice_number ?? pr?.invoice_number}</td>
                <td className="px-3 py-2 text-neutral-700">{two?.invoice_date ?? pr?.invoice_date}</td>
                <td className="px-3 py-2 text-right tabular-nums">{two ? paiseToRupeesText(two.taxable_value) : '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{pr ? paiseToRupeesText(pr.taxable_value) : '—'}</td>
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
                    value={r.itc_classification}
                    onChange={(e) => update(r.id, e.target.value as ItcClassification)}
                    className="h-7 px-2 text-12 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
                  >
                    <option value="eligible">Eligible</option>
                    <option value="ineligible">Ineligible</option>
                    <option value="reversal">Reversal</option>
                    <option value="blocked">Blocked</option>
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

function StatusChip({ status }: { status: MatchStatus }) {
  const map: Record<MatchStatus, { label: string; cls: string }> = {
    matched: { label: 'Matched', cls: 'border-l-green-500 text-green-700' },
    partial: { label: 'Partial', cls: 'border-l-amber-500 text-amber-700' },
    only_2b: { label: 'Only 2B', cls: 'border-l-neutral-400 text-neutral-700' },
    only_pr: { label: 'Only PR', cls: 'border-l-neutral-400 text-neutral-700' },
  };
  const s = map[status];
  return (
    <span className={'inline-flex items-center pl-2 pr-1 border-l-2 text-11 font-medium ' + s.cls}>
      {s.label}
    </span>
  );
}

function paiseToRupeesText(p: number): string {
  return (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
