/**
 * Official docs → Sales register. Every invoice issued in a financial year,
 * month by month, with the GST split, less credit notes; downloadable as
 * Excel (backend invoice/sales-register.ts). Drafts are not sales; cancelled
 * invoices are listed at zero so the number series stays explainable.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import { api } from '@/services/api';
import { useToast } from '@/components/Toast';
import { istToday } from '@/modules/dashboardV2/brief';
import { QueryState } from '@/modules/workstation/components';
import { ListHeader } from '@/modules/workstation/listUi';
import { errorText, smallBtn } from '@/modules/compliance/ui';

interface Money { taxable: number; cgst: number; sgst: number; igst: number; total: number }
interface Month { month: string; invoices: number; credit_notes: number; sales: Money; credits: Money; net: Money }
interface Row extends Money {
  kind: 'invoice' | 'credit_note'; id: string; number: string; date: string; month: string;
  party: string; gstin: string | null; status: string;
}
interface Register { fy: string; months: Month[]; totals: Month; rows: Row[] }

const fyOf = (date: string) => {
  const y = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};
const rs = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const gst = (m: Money) => m.cgst + m.sgst + m.igst;

async function download(fy: string) {
  const res = await fetch(`/api/invoices/sales-register/export?fy=${fy}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: `sales-register-${fy}.xlsx` });
  a.click();
  URL.revokeObjectURL(url);
}

const th = 'px-3 py-2 text-left text-12 font-medium text-neutral-500 whitespace-nowrap';
const td = 'px-3 py-2 text-13 text-neutral-800 whitespace-nowrap';
const num = `${td} text-right tabular-nums`;

export default function SalesRegisterPage() {
  const toast = useToast();
  const current = fyOf(istToday());
  const [fy, setFy] = useState(current);
  const [month, setMonth] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = Number(current.slice(0, 4));
  const years = [0, 1, 2, 3, 4].map((i) => `${start - i}-${String((start - i + 1) % 100).padStart(2, '0')}`);

  const q = useQuery({
    queryKey: ['sales-register', fy],
    queryFn: () => api.get<Register>(`/api/invoices/sales-register?fy=${fy}`),
  });
  const rowsOf = (reg: Register) => reg.rows.filter((r) => !month || r.month === month);

  const onDownload = async () => {
    setBusy(true);
    try { await download(fy); } catch (e) { toast.push('error', errorText(e)); } finally { setBusy(false); }
  };

  return (
    <div className="max-w-[1400px] space-y-4">
      <ListHeader
        title="Sales register"
        meta={<>Every invoice issued in the year, month by month, with the GST split. Credit notes are taken off the month they were issued in.</>}
        action={<button type="button" className={smallBtn} onClick={onDownload} disabled={busy || !q.data}><Download size={13} />{busy ? 'Preparing…' : 'Download Excel'}</button>}
      />
      <div className="flex items-center gap-2">
        <select aria-label="Financial year" value={fy} onChange={(e) => { setFy(e.target.value); setMonth(null); }}
          className="h-8 px-2 text-13 bg-white border border-neutral-200 rounded-lg">
          {years.map((y) => <option key={y} value={y}>FY {y}</option>)}
        </select>
        {month ? <button type="button" className={smallBtn} onClick={() => setMonth(null)}>Show all months</button> : null}
      </div>

      <QueryState query={q}>
        {(reg) => { const rows = rowsOf(reg); return (
          <>
            <div className="bg-white border border-neutral-200 rounded overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-neutral-200">
                  <tr>
                    <th className={th}>Month</th><th className={`${th} text-right`}>Invoices</th>
                    <th className={`${th} text-right`}>Taxable</th><th className={`${th} text-right`}>CGST</th>
                    <th className={`${th} text-right`}>SGST</th><th className={`${th} text-right`}>IGST</th>
                    <th className={`${th} text-right`}>Invoice total</th><th className={`${th} text-right`}>Credit notes</th>
                    <th className={`${th} text-right`}>Net taxable</th><th className={`${th} text-right`}>Net GST</th>
                    <th className={`${th} text-right`}>Net total</th>
                  </tr>
                </thead>
                <tbody>
                  {reg.months.map((m) => {
                    const empty = !m.invoices && !m.credit_notes;
                    return (
                      <tr key={m.month} onClick={() => !empty && setMonth(m.month)}
                        className={`border-b border-neutral-100 ${empty ? 'text-neutral-400' : 'cursor-pointer hover:bg-neutral-50'} ${month === m.month ? 'bg-primary/5' : ''}`}>
                        <td className={td}>{monthName(m.month)}</td>
                        <td className={num}>{m.invoices}</td>
                        <td className={num}>{rs(m.sales.taxable)}</td><td className={num}>{rs(m.sales.cgst)}</td>
                        <td className={num}>{rs(m.sales.sgst)}</td><td className={num}>{rs(m.sales.igst)}</td>
                        <td className={num}>{rs(m.sales.total)}</td>
                        <td className={num}>{m.credit_notes ? `− ${rs(m.credits.total)}` : '—'}</td>
                        <td className={num}>{rs(m.net.taxable)}</td><td className={num}>{rs(gst(m.net))}</td>
                        <td className={`${num} font-medium`}>{rs(m.net.total)}</td>
                      </tr>
                    );
                  })}
                  <tr className="bg-neutral-50 font-semibold">
                    <td className={td}>FY {reg.fy}</td>
                    <td className={num}>{reg.totals.invoices}</td>
                    <td className={num}>{rs(reg.totals.sales.taxable)}</td><td className={num}>{rs(reg.totals.sales.cgst)}</td>
                    <td className={num}>{rs(reg.totals.sales.sgst)}</td><td className={num}>{rs(reg.totals.sales.igst)}</td>
                    <td className={num}>{rs(reg.totals.sales.total)}</td>
                    <td className={num}>{reg.totals.credit_notes ? `− ${rs(reg.totals.credits.total)}` : '—'}</td>
                    <td className={num}>{rs(reg.totals.net.taxable)}</td><td className={num}>{rs(gst(reg.totals.net))}</td>
                    <td className={num}>{rs(reg.totals.net.total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <h2 className="text-14 font-semibold text-neutral-900 pt-2">
              {month ? monthName(month) : `All of FY ${reg.fy}`} · {rows.length} {rows.length === 1 ? 'document' : 'documents'}
            </h2>
            {rows.length ? (
              <div className="bg-white border border-neutral-200 rounded overflow-x-auto">
                <table className="w-full">
                  <thead className="border-b border-neutral-200">
                    <tr>
                      <th className={th}>Date</th><th className={th}>Number</th><th className={th}>Party</th><th className={th}>GSTIN</th>
                      <th className={`${th} text-right`}>Taxable</th><th className={`${th} text-right`}>CGST</th>
                      <th className={`${th} text-right`}>SGST</th><th className={`${th} text-right`}>IGST</th>
                      <th className={`${th} text-right`}>Total</th><th className={th}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const sign = r.kind === 'credit_note' ? '− ' : '';
                      const link = r.kind === 'invoice' ? `/workstation/invoices/${r.id}` : `/workstation/credit-notes/${r.id}`;
                      return (
                        <tr key={r.id} className={`border-b border-neutral-100 ${r.status === 'cancelled' ? 'text-neutral-400 line-through' : ''}`}>
                          <td className={td}>{r.date}</td>
                          <td className={td}><Link to={link} className="text-primary hover:underline">{r.number}</Link>{r.kind === 'credit_note' ? <span className="ml-1 text-12 text-neutral-500">credit note</span> : null}</td>
                          <td className={`${td} max-w-[260px] truncate`}>{r.party}</td>
                          <td className={td}>{r.gstin ?? '—'}</td>
                          <td className={num}>{sign}{rs(r.taxable)}</td><td className={num}>{sign}{rs(r.cgst)}</td>
                          <td className={num}>{sign}{rs(r.sgst)}</td><td className={num}>{sign}{rs(r.igst)}</td>
                          <td className={num}>{sign}{rs(r.total)}</td>
                          <td className={`${td} capitalize`}>{r.status.replace('_', ' ')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <p className="text-13 text-neutral-500">No invoices issued in this period.</p>}
          </>
        ); }}
      </QueryState>
    </div>
  );
}
