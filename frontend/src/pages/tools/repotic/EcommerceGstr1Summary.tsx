/**
 * /audit-automation/ecommerce/summary — the Repotic-style GSTR-1 category
 * summary.
 *
 * Twelve rows, one per government table. Taxable / IGST / CGST / SGST / Cess
 * / Invoice totals for each; the shaded rows below the total surface
 * cross-check amounts (Supplies via ECO, HSN summary, Documents issued).
 *
 * Rows the ingestion does not yet carry (B2B, CDN Registered, Exports,
 * Advances, Nil Rated, Documents Issued) come back with zeros and a
 * discreet "pending source" label — intentional, so the auditor sees the
 * full GSTR-1 shape and can tell at a glance what is covered today.
 *
 * Export buttons download the same /api/repotic/ecommerce/gstr1 endpoint
 * the SourcesTable screen uses — `portal=1` returns the R1_<GSTIN>_<MM>_
 * <YYYY>.json shape a Repotic export has (wrapper fields stripped, empty
 * sections omitted).
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams, Navigate } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, Download, Info } from 'lucide-react';
import { repoticApi, type SummaryRow } from '@/modules/tools/repotic/api';
import { gstApi } from '@/modules/workstation/gst/api';
import { BetaBadge } from '@/pages/tools/AuditAutomation';

function monthLabel(iso: string): string {
  const [y, m] = iso.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleString(undefined, { month: 'long', year: 'numeric' });
}

function money(n: number): string {
  if (n === 0) return '0';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function EcommerceGstr1SummaryPage() {
  const params = useParams<{ clientId?: string; period?: string }>();
  const [searchParams] = useSearchParams();

  const clientId = params.clientId ?? searchParams.get('client_id') ?? '';
  const period = params.period ?? searchParams.get('period') ?? '';

  const clients = useQuery({ queryKey: ['gst.clients'], queryFn: () => gstApi.clients() });
  const client = useMemo(
    () => clients.data?.items.find((c) => c.client_id === clientId),
    [clients.data, clientId],
  );
  // The import screen passes the GSTIN it built for (a client can hold several).
  const gstin = searchParams.get('gstin') ?? client?.gstin ?? '';
  const clientName = client?.client_name ?? client?.legal_name ?? clientId;

  const scoped = clientId && gstin && period ? { client_id: clientId, gstin, period } : null;
  const summary = useQuery({
    queryKey: ['repotic.gstr1.summary', clientId, gstin, period],
    queryFn: () => repoticApi.gstr1Summary(scoped!),
    enabled: Boolean(scoped),
  });

  if (!clientId || !period) {
    return <Navigate to="/audit-automation/ecommerce" replace />;
  }

  const rows = summary.data?.summary_rows ?? [];
  // The bar row — totals across the implemented particulars.
  const totals = rows.filter((r) => r.implemented && !isCrosscheck(r.code))
    .reduce((a, r) => {
      // Credit notes reduce the liability; every other row adds to it.
      const k = r.code.startsWith('9B') ? -1 : 1;
      return {
        vouchers: a.vouchers + r.vouchers,
        taxable: a.taxable + k * r.taxable,
        igst: a.igst + k * r.igst, cgst: a.cgst + k * r.cgst, sgst: a.sgst + k * r.sgst, cess: a.cess + k * r.cess,
        invoice: a.invoice + k * r.invoice,
      };
    }, { vouchers: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, invoice: 0 });

  const warnings = summary.data?.warnings ?? [];
  const portalUrl = scoped ? repoticApi.gstr1DownloadUrl(scoped, true) : '#';
  const previewUrl = scoped ? repoticApi.gstr1DownloadUrl(scoped, false) : '#';

  return (
    <div className="max-w-[1240px] mx-auto">
      <div className="mb-4">
        <Link to="/audit-automation/ecommerce" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> Import
        </Link>
      </div>

      <header className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-20 font-semibold text-neutral-900">GSTR-1</h1>
            <BetaBadge />
          </div>
          <p className="text-13 text-neutral-500 mt-1">
            {clientName} · <span className="font-mono text-12">{gstin}</span> · {monthLabel(period)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={portalUrl}
            title="Upload file for the GSTN portal — R1_<GSTIN>_<MM>_<YYYY>.json."
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded bg-neutral-900 text-white text-13 font-medium hover:bg-neutral-800"
          >
            <Download size={14} strokeWidth={2} /> Portal JSON
          </a>
          <a
            href={previewUrl}
            title="Human-readable copy with disclaimer wrapper. The portal rejects this file — use Portal JSON to upload."
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded border border-neutral-300 text-13 text-neutral-600 hover:bg-neutral-50"
          >
            <Download size={14} strokeWidth={2} /> Review copy (do not upload)
          </a>
        </div>
      </header>

      <div className="mb-4 p-3 rounded border border-amber-200 bg-amber-50 text-12 text-amber-900 flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" strokeWidth={2} />
        <div>
          <strong>Beta — verify before filing.</strong> The Portal JSON has not been checked against the GSTN offline tool.
          It carries Tables 5A, 7 (net of returns), 9B (credit notes on B2C-large invoices), 12 (HSN) and 14 only — no B2B,
          exports, advances, nil-rated supplies or documents issued. Check every figure against the marketplace report before you upload it.
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="mb-4 p-3 rounded border border-amber-200 bg-amber-50 text-12 text-amber-900 flex items-start gap-2">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" strokeWidth={2} />
          <div className="space-y-1">
            {warnings.map((w, i) => <div key={i}>{w}</div>)}
          </div>
        </div>
      )}

      <section className="bg-white border border-neutral-200 rounded overflow-hidden">
        <table className="w-full min-w-[960px] text-13">
          <thead>
            <tr className="text-11 uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-200">
              <th className="text-left px-3 py-2 font-medium w-10">Sr.</th>
              <th className="text-left px-3 py-2 font-medium">Particulars</th>
              <th className="text-right px-3 py-2 font-medium w-24">Voucher Count</th>
              <th className="text-right px-3 py-2 font-medium w-28">Taxable Amount</th>
              <th className="text-right px-3 py-2 font-medium w-28">Integrated Tax</th>
              <th className="text-right px-3 py-2 font-medium w-28">Central Tax</th>
              <th className="text-right px-3 py-2 font-medium w-28">State Tax</th>
              <th className="text-right px-3 py-2 font-medium w-20">Cess</th>
              <th className="text-right px-3 py-2 font-medium w-28">Invoice Amount</th>
            </tr>
          </thead>
          <tbody>
            {summary.isLoading && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-13 text-neutral-500">Loading…</td></tr>
            )}
            {!summary.isLoading && rows.filter((r) => !isCrosscheck(r.code)).map((r, i) => (
              <Row key={r.code} sr={i + 1} row={r} />
            ))}
            {!summary.isLoading && rows.length > 0 && (
              <tr className="bg-indigo-600 text-white font-semibold">
                <td className="px-3 py-2"></td>
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right">{totals.vouchers || ''}</td>
                <td className="px-3 py-2 text-right">{money(totals.taxable)}</td>
                <td className="px-3 py-2 text-right">{money(totals.igst)}</td>
                <td className="px-3 py-2 text-right">{money(totals.cgst)}</td>
                <td className="px-3 py-2 text-right">{money(totals.sgst)}</td>
                <td className="px-3 py-2 text-right">{money(totals.cess)}</td>
                <td className="px-3 py-2 text-right">{money(totals.invoice)}</td>
              </tr>
            )}
            {!summary.isLoading && rows.filter((r) => isCrosscheck(r.code)).map((r) => (
              <Row key={r.code} sr={null} row={r} dim />
            ))}
          </tbody>
        </table>
        {!summary.isLoading && (
          <div className="p-3 border-t border-neutral-100 text-11 text-neutral-500 flex items-start gap-1.5">
            <Info size={12} className="mt-0.5" />
            <span>
              Rows marked <em>pending source</em> are not built from marketplace reports (B2B invoices, registered credit
              notes, exports, advances, nil-rated supplies, documents issued). Add them on the portal yourself.
              In the total, credit notes (9B) are subtracted.
            </span>
          </div>
        )}
      </section>
    </div>
  );
}

function Row({ sr, row, dim }: { sr: number | null; row: SummaryRow; dim?: boolean }) {
  const cls = dim ? 'bg-neutral-50 text-neutral-600' : 'text-neutral-900';
  return (
    <tr className={`border-b border-neutral-100 ${cls}`}>
      <td className="px-3 py-2 text-neutral-500">{sr ?? ''}</td>
      <td className="px-3 py-2">
        {row.label}
        {!row.implemented && (
          <span className="ml-2 inline-flex items-center px-1.5 h-4 rounded text-[10px] font-medium text-neutral-500 bg-neutral-100">
            pending source
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right">{row.vouchers || ''}</td>
      <td className="px-3 py-2 text-right">{money(row.taxable)}</td>
      <td className="px-3 py-2 text-right">{money(row.igst)}</td>
      <td className="px-3 py-2 text-right">{money(row.cgst)}</td>
      <td className="px-3 py-2 text-right">{money(row.sgst)}</td>
      <td className="px-3 py-2 text-right">{money(row.cess)}</td>
      <td className="px-3 py-2 text-right">{money(row.invoice)}</td>
    </tr>
  );
}

/** Rows that live BELOW the total bar — they cross-check the totals
 *  above, not add to them (ECO supplies and HSN summary are different
 *  slices of the same underlying invoices). */
function isCrosscheck(code: string): boolean {
  return code === 'supeco' || code === 'hsn' || code === '13';
}
