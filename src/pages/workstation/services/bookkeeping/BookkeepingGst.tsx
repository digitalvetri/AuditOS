import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { bookkeepingAccountingApi } from '@/modules/tools/audit-automation/bookkeeping';
import { DataTable, Money, Panel, Loading, ErrorNote, usePeriod, ReportHeader, StatusPill, downloadText } from '@/modules/tools/bookkeeping/ui';
import { Button } from '@/components/Button';

/**
 * /gst — GST and other statutory reporting.
 *
 * Everything on this screen is PREPARED from posted vouchers. Audit OS
 * has no GSTN or IRP integration, so nothing here is filed, and the
 * screen says so rather than implying otherwise.
 */
type Tab = 'summary' | 'gstr1' | 'gstr3b' | 'exceptions' | 'tds';

export function BookkeepingGst() {
  const { companyId = '' } = useParams();
  const { from, to } = usePeriod();
  const [tab, setTab] = useState<Tab>('summary');

  return (
    <div data-testid="tally-gst">
      <ReportHeader
        title="GST &amp; Tax"
        subtitle={`${from} to ${to} — prepared from posted vouchers`}
      />

      <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-12 text-amber-900 mb-3">
        These returns are <strong>prepared</strong> and can be <strong>exported</strong>. Audit OS does not connect to the GST portal,
        so nothing here is filed and no ARN or IRN is produced. File on the portal, then record the acknowledgement in your own records.
      </div>

      <div className="flex gap-1 mb-3 flex-wrap print:hidden">
        {([['summary', 'GST summary'], ['gstr1', 'GSTR-1'], ['gstr3b', 'GSTR-3B'], ['exceptions', 'Exceptions'], ['tds', 'TDS / TCS']] as [Tab, string][]).map(([k, label]) => (
          <button
            key={k} type="button" onClick={() => setTab(k)}
            className={`h-8 px-3 text-12 rounded border ${tab === k ? 'bg-neutral-100 border-neutral-300 text-neutral-900 font-medium' : 'bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'summary' ? <GstSummaryTab companyId={companyId} from={from} to={to} /> : null}
      {tab === 'gstr1' ? <Gstr1Tab companyId={companyId} from={from} to={to} /> : null}
      {tab === 'gstr3b' ? <Gstr3bTab companyId={companyId} from={from} to={to} /> : null}
      {tab === 'exceptions' ? <ExceptionsTab companyId={companyId} from={from} to={to} /> : null}
      {tab === 'tds' ? <StatutoryTab companyId={companyId} from={from} to={to} /> : null}
    </div>
  );
}

function GstSummaryTab({ companyId, from, to }: { companyId: string; from: string; to: string }) {
  const { companyId: _c } = useParams();
  const q = useQuery({ queryKey: ['tally.gstSummary', companyId, from, to], queryFn: () => bookkeepingAccountingApi.gstSummary(companyId, { from, to }) });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const d = q.data!;
  const base = `/tally/companies/${companyId}`;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <Box label="Output tax (payable)" paise={d.output.totalPaise} />
        <Box label="Input tax credit" paise={d.input.totalPaise} />
        <Box label={d.net.totalPaise >= 0 ? 'Net GST payable' : 'Net credit carried forward'} paise={Math.abs(d.net.totalPaise)} strong />
      </div>

      <Panel title="Component-wise">
        <DataTable
          minWidth="520px"
          rows={[
            { component: 'CGST', out: d.output.cgstPaise, inp: d.input.cgstPaise, net: d.net.cgstPaise },
            { component: 'SGST', out: d.output.sgstPaise, inp: d.input.sgstPaise, net: d.net.sgstPaise },
            { component: 'IGST', out: d.output.igstPaise, inp: d.input.igstPaise, net: d.net.igstPaise },
            { component: 'Cess', out: d.output.cessPaise, inp: d.input.cessPaise, net: d.net.cessPaise },
          ]}
          rowKey={(r) => r.component}
          columns={[
            { key: 'component', label: 'Component', value: (r) => r.component },
            { key: 'out', label: 'Output', align: 'right', value: (r) => r.out / 100, render: (r) => <Money paise={r.out} /> },
            { key: 'in', label: 'Input', align: 'right', value: (r) => r.inp / 100, render: (r) => <Money paise={r.inp} /> },
            { key: 'net', label: 'Net', align: 'right', value: (r) => r.net / 100, render: (r) => <Money paise={r.net} signed /> },
          ]}
        />
      </Panel>

      <Panel title="Tax ledgers">
        <DataTable
          minWidth="620px"
          rows={d.ledgers}
          rowKey={(r) => r.ledgerId}
          columns={[
            { key: 'ledger', label: 'Ledger', value: (r) => r.ledgerName, render: (r) => <Link to={`${base}/reports/ledger/${r.ledgerId}?from=${from}&to=${to}`} className="text-neutral-900 hover:text-gold">{r.ledgerName}</Link> },
            { key: 'component', label: 'Component', value: (r) => r.component, render: (r) => <span className="uppercase text-11 text-neutral-500">{r.component}</span> },
            { key: 'direction', label: 'Direction', value: (r) => r.direction },
            { key: 'debit', label: 'Debit', align: 'right', value: (r) => r.debitPaise / 100, render: (r) => <Money paise={r.debitPaise} /> },
            { key: 'credit', label: 'Credit', align: 'right', value: (r) => r.creditPaise / 100, render: (r) => <Money paise={r.creditPaise} /> },
          ]}
          empty="No GST ledgers are configured. They are created with every new company under Duties & Taxes."
        />
      </Panel>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <Box label="Outward taxable value" paise={d.outwardTaxableValuePaise} />
        <Box label="Inward taxable value" paise={d.inwardTaxableValuePaise} />
      </div>
    </div>
  );
}

function Gstr1Tab({ companyId, from, to }: { companyId: string; from: string; to: string }) {
  const q = useQuery({ queryKey: ['tally.gstr1', companyId, from, to], queryFn: () => bookkeepingAccountingApi.gstr1(companyId, from, to) });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const d = q.data! as unknown as {
    status: string;
    totals: { taxableValuePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; invoiceCount: number };
    b2b: Invoice[]; b2cl: Invoice[]; b2cs: Invoice[]; creditNotes: Invoice[];
    hsn: { hsnCode: string; description: string; uqc: string; qtyMilli: number; rateBp: number; taxableValuePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number }[];
    exceptions: { voucherId: string; voucherNumber: string; issue: string }[];
  };
  const base = `/tally/companies/${companyId}`;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <StatusPill status={d.status} />
        <span className="text-12 text-neutral-500">{d.totals.invoiceCount} document(s) · taxable <Money paise={d.totals.taxableValuePaise} /></span>
        <Button size="sm" variant="secondary" onClick={() => downloadText(`gstr1-${from}-to-${to}.json`, JSON.stringify(d, null, 2), 'application/json')}>
          Export JSON
        </Button>
      </div>
      <InvoiceTable title="B2B — registered counterparties" rows={d.b2b} base={base} />
      <InvoiceTable title="B2C large — inter-state, above ₹2.5 lakh" rows={d.b2cl} base={base} />
      <InvoiceTable title="B2C small" rows={d.b2cs} base={base} />
      <InvoiceTable title="Credit notes" rows={d.creditNotes} base={base} />
      <Panel title="HSN summary">
        <DataTable
          minWidth="720px" rows={d.hsn} rowKey={(r) => `${r.hsnCode}-${r.rateBp}`}
          columns={[
            { key: 'hsn', label: 'HSN', value: (r) => r.hsnCode },
            { key: 'desc', label: 'Description', value: (r) => r.description },
            { key: 'uqc', label: 'UQC', value: (r) => r.uqc },
            { key: 'qty', label: 'Qty', align: 'right', value: (r) => r.qtyMilli / 1000 },
            { key: 'rate', label: 'Rate %', align: 'right', value: (r) => r.rateBp / 100 },
            { key: 'taxable', label: 'Taxable', align: 'right', value: (r) => r.taxableValuePaise / 100, render: (r) => <Money paise={r.taxableValuePaise} /> },
            { key: 'cgst', label: 'CGST', align: 'right', value: (r) => r.cgstPaise / 100, render: (r) => <Money paise={r.cgstPaise} /> },
            { key: 'sgst', label: 'SGST', align: 'right', value: (r) => r.sgstPaise / 100, render: (r) => <Money paise={r.sgstPaise} /> },
            { key: 'igst', label: 'IGST', align: 'right', value: (r) => r.igstPaise / 100, render: (r) => <Money paise={r.igstPaise} /> },
          ]}
          empty="No item lines with an HSN code in this period."
        />
      </Panel>
      {d.exceptions.length ? (
        <Panel title={`Exceptions (${d.exceptions.length})`}>
          <ul className="divide-y divide-neutral-100">
            {d.exceptions.slice(0, 50).map((e, i) => (
              <li key={`${e.voucherId}-${i}`} className="px-3 py-2 text-13 flex justify-between gap-3">
                <span className="text-neutral-700">{e.issue}</span>
                <Link to={`${base}/vouchers/${e.voucherId}`} className="text-gold hover:underline whitespace-nowrap">{e.voucherNumber}</Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

interface Invoice {
  voucherId: string; voucherNumber: string; date: string; partyName: string | null; partyGstin: string | null;
  placeOfSupply: string | null; taxableValuePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; invoiceValuePaise: number;
}

function InvoiceTable({ title, rows, base }: { title: string; rows: Invoice[]; base: string }) {
  return (
    <Panel title={`${title} (${rows.length})`}>
      <DataTable
        minWidth="820px" rows={rows} rowKey={(r) => r.voucherId}
        columns={[
          { key: 'date', label: 'Date', value: (r) => r.date },
          { key: 'no', label: 'No.', value: (r) => r.voucherNumber, render: (r) => <Link to={`${base}/vouchers/${r.voucherId}`} className="text-neutral-900 hover:text-gold">{r.voucherNumber}</Link> },
          { key: 'party', label: 'Party', value: (r) => r.partyName ?? '' },
          { key: 'gstin', label: 'GSTIN', value: (r) => r.partyGstin ?? '', render: (r) => <span className="font-mono text-12">{r.partyGstin ?? '—'}</span> },
          { key: 'pos', label: 'POS', value: (r) => r.placeOfSupply ?? '' },
          { key: 'taxable', label: 'Taxable', align: 'right', value: (r) => r.taxableValuePaise / 100, render: (r) => <Money paise={r.taxableValuePaise} /> },
          { key: 'cgst', label: 'CGST', align: 'right', value: (r) => r.cgstPaise / 100, render: (r) => <Money paise={r.cgstPaise} /> },
          { key: 'sgst', label: 'SGST', align: 'right', value: (r) => r.sgstPaise / 100, render: (r) => <Money paise={r.sgstPaise} /> },
          { key: 'igst', label: 'IGST', align: 'right', value: (r) => r.igstPaise / 100, render: (r) => <Money paise={r.igstPaise} /> },
          { key: 'total', label: 'Total', align: 'right', value: (r) => r.invoiceValuePaise / 100, render: (r) => <Money paise={r.invoiceValuePaise} /> },
        ]}
        empty="Nothing in this section for the period."
      />
    </Panel>
  );
}

function Gstr3bTab({ companyId, from, to }: { companyId: string; from: string; to: string }) {
  const q = useQuery({ queryKey: ['tally.gstr3b', companyId, from, to], queryFn: () => bookkeepingAccountingApi.gstr3b(companyId, from, to) });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const d = q.data! as unknown as {
    status: string;
    outwardTaxableSupplies: { taxableValuePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number };
    itcAvailable: { cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number; totalPaise: number };
    netPayable: { cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number };
    inwardSupplies: { taxableValuePaise: number };
    note: string;
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <StatusPill status={d.status} />
        <Button size="sm" variant="secondary" onClick={() => downloadText(`gstr3b-${from}-to-${to}.json`, JSON.stringify(d, null, 2), 'application/json')}>Export JSON</Button>
      </div>
      <Panel title="3.1(a) Outward taxable supplies">
        <dl className="p-3 space-y-1 text-13">
          <Line label="Taxable value" paise={d.outwardTaxableSupplies.taxableValuePaise} />
          <Line label="CGST" paise={d.outwardTaxableSupplies.cgstPaise} />
          <Line label="SGST" paise={d.outwardTaxableSupplies.sgstPaise} />
          <Line label="IGST" paise={d.outwardTaxableSupplies.igstPaise} />
        </dl>
      </Panel>
      <Panel title="4(A)(5) ITC available — all other ITC">
        <dl className="p-3 space-y-1 text-13">
          <Line label="CGST" paise={d.itcAvailable.cgstPaise} />
          <Line label="SGST" paise={d.itcAvailable.sgstPaise} />
          <Line label="IGST" paise={d.itcAvailable.igstPaise} />
          <Line label="Total ITC" paise={d.itcAvailable.totalPaise} bold />
        </dl>
      </Panel>
      <Panel title="Net tax payable">
        <dl className="p-3 space-y-1 text-13">
          <Line label="CGST" paise={d.netPayable.cgstPaise} />
          <Line label="SGST" paise={d.netPayable.sgstPaise} />
          <Line label="IGST" paise={d.netPayable.igstPaise} />
          <Line label="Total" paise={d.netPayable.totalPaise} bold />
        </dl>
        <p className="px-3 pb-3 text-11 text-neutral-500">{d.note}</p>
      </Panel>
    </div>
  );
}

function ExceptionsTab({ companyId, from, to }: { companyId: string; from: string; to: string }) {
  const q = useQuery({ queryKey: ['tally.gstExceptions', companyId, from, to], queryFn: () => bookkeepingAccountingApi.gstExceptions(companyId, from, to) });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const base = `/tally/companies/${companyId}`;
  const d = q.data!;
  if (!d.total) return <Panel><div className="px-3 py-6 text-13 text-emerald-700">No GST exceptions in this period.</div></Panel>;
  return (
    <div className="space-y-3">
      {d.groups.map((g) => (
        <Panel key={g.issue} title={`${g.issue} (${g.vouchers.length})`}>
          <div className="p-3 flex flex-wrap gap-2">
            {g.vouchers.map((v) => (
              <Link key={v.voucher_id} to={`${base}/vouchers/${v.voucher_id}`} className="text-12 px-2 py-1 border border-neutral-200 rounded hover:border-gold">{v.voucher_number}</Link>
            ))}
          </div>
        </Panel>
      ))}
    </div>
  );
}

function StatutoryTab({ companyId, from, to }: { companyId: string; from: string; to: string }) {
  const [taxType, setTaxType] = useState<'tds' | 'tcs'>('tds');
  const q = useQuery({ queryKey: ['tally.statutory', companyId, taxType, from, to], queryFn: () => bookkeepingAccountingApi.statutorySummary(companyId, taxType, { from, to }) });
  const ratesQ = useQuery({ queryKey: ['tally.taxRates', companyId, taxType], queryFn: () => bookkeepingAccountingApi.listTaxRates(companyId, taxType) });
  return (
    <div className="space-y-4">
      <div className="flex gap-1">
        {(['tds', 'tcs'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTaxType(t)} className={`h-7 px-3 text-12 rounded border ${taxType === t ? 'bg-neutral-100 border-neutral-300 font-medium' : 'bg-white border-neutral-200'}`}>{t.toUpperCase()}</button>
        ))}
      </div>
      {q.isLoading ? <Loading /> : q.data ? (
        <>
          <Panel title={`${taxType.toUpperCase()} position`}>
            <DataTable
              minWidth="560px" rows={q.data.rows} rowKey={(r) => r.ledger_id}
              columns={[
                { key: 'ledger', label: 'Ledger', value: (r) => r.ledger_name },
                { key: 'section', label: 'Section', value: (r) => r.section ?? '' },
                { key: 'deducted', label: 'Deducted', align: 'right', value: (r) => r.deducted_paise / 100, render: (r) => <Money paise={r.deducted_paise} /> },
                { key: 'paid', label: 'Paid', align: 'right', value: (r) => r.paid_paise / 100, render: (r) => <Money paise={r.paid_paise} /> },
                { key: 'payable', label: 'Payable', align: 'right', value: (r) => r.payable_paise / 100, render: (r) => <Money paise={r.payable_paise} /> },
              ]}
              empty={q.data.note}
            />
          </Panel>
          <Panel title="Configured rates">
            <DataTable
              minWidth="520px" rows={ratesQ.data?.items ?? []} rowKey={(r) => r.id}
              columns={[
                { key: 'name', label: 'Name', value: (r) => r.name },
                { key: 'section', label: 'Section', value: (r) => r.section ?? '' },
                { key: 'rate', label: 'Rate %', align: 'right', value: (r) => r.rate_pct },
                { key: 'threshold', label: 'Threshold', align: 'right', value: (r) => (r.threshold_paise ?? 0) / 100, render: (r) => (r.threshold_paise ? <Money paise={r.threshold_paise} /> : <span className="text-neutral-400">—</span>) },
                { key: 'from', label: 'Effective from', value: (r) => r.effective_from ?? '' },
              ]}
              empty="No rates configured. Rates are data, not code — add them here and the reports use them."
            />
          </Panel>
          <p className="text-11 text-neutral-500">{q.data.note}</p>
        </>
      ) : null}
    </div>
  );
}

function Box({ label, paise, strong }: { label: string; paise: number; strong?: boolean }) {
  return (
    <div className={`bg-white border rounded p-3 ${strong ? 'border-gold' : 'border-neutral-200'}`}>
      <div className="text-11 text-neutral-500">{label}</div>
      <div className="text-16 font-semibold text-neutral-900 mt-0.5"><Money paise={paise} /></div>
    </div>
  );
}

function Line({ label, paise, bold }: { label: string; paise: number; bold?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className={bold ? 'font-medium text-neutral-900' : 'text-neutral-600'}>{label}</dt>
      <dd><Money paise={paise} bold={bold} /></dd>
    </div>
  );
}
