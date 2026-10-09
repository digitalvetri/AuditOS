/**
 * Finance MIS — one panel on /hrms/reports for org-scope finance users.
 *
 * The server describes each report (columns with a type, rows, totals,
 * notes), so this is a single generic table rather than ten bespoke views.
 * CSV / Excel come from the server (`?format=csv|xlsx`), not a client-side
 * re-encoding, so the file matches what the API computed.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { istToday } from '@/lib/dates';
import { inrAmount } from '@/modules/workstation/invoices/document';
import {
  FALLBACK_CATALOGUE, currentFy, financeReportsApi, fyLabel,
  type FinanceColumn, type FinanceQuery, type FinanceReport,
} from './financeApi';

const selectClass =
  'block w-full h-10 px-3 text-14 bg-surface text-ink border border-border rounded-md focus:outline-none focus:border-gold';

function formatCell(col: FinanceColumn, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  switch (col.type) {
    case 'money': {
      const n = Number(v);
      return Number.isFinite(n) ? `₹${inrAmount(Math.round(n))}` : String(v);
    }
    case 'hours': {
      const n = Number(v);
      return Number.isFinite(n) ? n.toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 2 }) : String(v);
    }
    case 'percent': {
      const n = Number(v);
      return Number.isFinite(n) ? `${n.toLocaleString('en-IN', { maximumFractionDigits: 1 })}%` : String(v);
    }
    case 'number': {
      const n = Number(v);
      return Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : String(v);
    }
    case 'boolean':
      return v === true || v === 'true' || v === 1 ? 'Yes' : 'No';
    default:
      return String(v);
  }
}

const isNumeric = (c: FinanceColumn) => c.type === 'money' || c.type === 'number' || c.type === 'percent' || c.type === 'hours';

export function FinanceMisSection() {
  const toast = useToast();
  const today = istToday();
  const fy = currentFy(today);
  const thisFyStart = Number(fy.from.slice(0, 4));
  const fyOptions = Array.from({ length: 6 }, (_, i) => fyLabel(thisFyStart - i));

  const [key, setKey] = useState<string>('revenue-by-month');
  const [from, setFrom] = useState(fy.from);
  const [to, setTo] = useState(fy.to);
  const [fyPick, setFyPick] = useState(fy.label);
  const [busy, setBusy] = useState<'csv' | 'xlsx' | null>(null);

  const catalogue = useQuery({
    queryKey: ['reports', 'finance', 'catalogue'],
    queryFn: () => financeReportsApi.catalogue(),
    retry: false,
  });
  const items = catalogue.data?.items?.length ? catalogue.data.items : FALLBACK_CATALOGUE;
  const current = items.find((i) => i.key === key) ?? items[0];
  const isFy = key === 'tds-receivable';
  const query: FinanceQuery = isFy ? { fy: fyPick } : { from, to };

  const report = useQuery({
    queryKey: ['reports', 'finance', key, query],
    queryFn: () => financeReportsApi.run(key, query),
    retry: false,
  });

  const exportAs = async (format: 'csv' | 'xlsx') => {
    setBusy(format);
    try {
      await financeReportsApi.download(key, query, format);
    } catch (e) {
      toast.push('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="finance-mis">
      <div className="m-form dash-card px-5 py-4 mb-5 grid grid-cols-1 md:flex md:items-end gap-3 md:flex-wrap">
        <label className="block md:min-w-[240px]">
          <span className="block text-11 uppercase tracking-[0.06em] text-inkFaint mb-1">Report</span>
          <select className={selectClass} value={key} onChange={(e) => setKey(e.target.value)} data-testid="finance-report-pick">
            {items.map((i) => <option key={i.key} value={i.key}>{i.title}</option>)}
          </select>
        </label>
        {isFy ? (
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-inkFaint mb-1">Financial year</span>
            <select className={selectClass} value={fyPick} onChange={(e) => setFyPick(e.target.value)} data-testid="finance-fy">
              {fyOptions.map((f) => <option key={f} value={f}>FY {f}</option>)}
            </select>
          </label>
        ) : (
          <>
            <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="finance-from" />
            <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="finance-to" />
          </>
        )}
      </div>
      {current?.description ? <p className="text-12 text-neutral-500 mb-3">{current.description}</p> : null}

      {report.isLoading ? <div className="h-40 rounded-lg bg-neutral-100" aria-label="Loading" /> : null}
      {report.isError ? (
        (report.error as { status?: number }).status === 403 ? (
          <div className="dash-card p-6 flex items-center gap-3 text-13 text-neutral-600">
            <span className="h-9 w-9 shrink-0 rounded-lg inline-flex items-center justify-center bg-[#f1f5f9] text-neutral-500" aria-hidden>
              <ShieldAlert size={16} strokeWidth={1.9} />
            </span>
            You don't have access to this report.
          </div>
        ) : (
          <div className="dash-card p-6 text-13 text-red">Could not load report. {(report.error as Error).message}</div>
        )
      ) : null}
      {report.data ? (
        <div className="space-y-3" data-testid="finance-report-body">
          <div className="flex flex-col md:flex-row md:items-center gap-2">
            <div className="text-13 text-neutral-500 md:flex-1">
              {report.data.title}{isFy ? ` · FY ${fyPick}` : ` · ${report.data.from} → ${report.data.to}`}
            </div>
            <Button variant="secondary" onClick={() => exportAs('csv')} disabled={busy !== null}
              className="w-full min-h-[44px] md:w-auto md:min-h-0" data-testid="finance-export-csv">
              <Download size={15} strokeWidth={1.9} className="mr-2" />Export CSV
            </Button>
            <Button variant="secondary" onClick={() => exportAs('xlsx')} disabled={busy !== null}
              className="w-full min-h-[44px] md:w-auto md:min-h-0" data-testid="finance-export-xlsx">
              <Download size={15} strokeWidth={1.9} className="mr-2" />Export Excel
            </Button>
          </div>
          <FinanceTable data={report.data} />
          {report.data.notes?.length ? (
            <div className="dash-card px-5 py-4" data-testid="finance-notes">
              <ul className="list-disc pl-4 space-y-1 text-12 text-neutral-500">
                {report.data.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FinanceTable({ data }: { data: FinanceReport }) {
  const cols = data.columns;
  if (data.rows.length === 0) {
    return <div className="dash-card p-6 text-13 text-neutral-500">No rows for this period.</div>;
  }
  return (
    <div className="m-cards md:overflow-x-auto" data-testid="finance-report-table">
      <table className="hr-float w-full border-collapse tabular-nums">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} className={`${isNumeric(c) ? 'text-right' : 'text-left'} text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <tr key={i} className="border-b border-neutral-200 last:border-b-0">
              {cols.map((c) => (
                <td key={c.key} data-label={c.label} className={`px-3 py-2 text-13 text-neutral-900 ${isNumeric(c) ? 'text-right whitespace-nowrap' : ''}`}>
                  {formatCell(c, row[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {data.totals ? (
          <tfoot>
            <tr className="border-t border-neutral-300">
              {cols.map((c, j) => {
                const v = data.totals![c.key];
                return (
                  <td key={c.key} data-label={c.label} className={`px-3 py-2 text-13 font-semibold text-neutral-900 ${isNumeric(c) ? 'text-right whitespace-nowrap' : ''}`}>
                    {v === undefined || v === null ? (j === 0 ? 'Total' : '') : formatCell(c, v)}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
