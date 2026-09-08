import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Button } from '@/components/Button';
import { booksApi } from '@/modules/books/api';
import { Cell, Empty, Money, Notice, Row, Section, Table, inputCls, selectCls, useBooks } from '@/modules/books/components';
import { bp, downloadCsv, downloadJson, fromPaise, fyRange, money, today } from '@/modules/books/format';

type ReportName = 'trial-balance' | 'profit-and-loss' | 'balance-sheet' | 'cash-flow' | 'general-ledger' | 'ar-ageing' | 'ap-ageing' | 'gstr-1' | 'gstr-3b' | 'tds';
const REPORTS: { id: ReportName; label: string; period: 'range' | 'as_of' }[] = [
  { id: 'trial-balance', label: 'Trial balance', period: 'as_of' },
  { id: 'profit-and-loss', label: 'Profit & loss', period: 'range' },
  { id: 'balance-sheet', label: 'Balance sheet', period: 'as_of' },
  { id: 'cash-flow', label: 'Cash flow', period: 'range' },
  { id: 'general-ledger', label: 'General ledger', period: 'range' },
  { id: 'ar-ageing', label: 'AR ageing', period: 'as_of' },
  { id: 'ap-ageing', label: 'AP ageing', period: 'as_of' },
  { id: 'gstr-1', label: 'GSTR-1', period: 'range' },
  { id: 'gstr-3b', label: 'GSTR-3B', period: 'range' },
  { id: 'tds', label: 'TDS deducted', period: 'range' },
];

/** /books/:orgId/reports — every figure computed live from posted journals. */
export function BooksReportsPage() {
  const { orgId, org } = useBooks();
  const fy = fyRange(today(), org.fiscal_year_start_month);
  const [report, setReport] = useState<ReportName>('trial-balance');
  const [from, setFrom] = useState(fy.from);
  const [to, setTo] = useState(today());
  const [ledgerId, setLedgerId] = useState('');
  const api = booksApi.org(orgId);
  const def = REPORTS.find((r) => r.id === report)!;
  const ledgers = useQuery({ queryKey: ['books', orgId, 'ledgers', 'all'], queryFn: () => api.chart.ledgers(), enabled: report === 'general-ledger' });

  const q = useQuery<unknown>({
    queryKey: ['books', orgId, 'report', report, { from, to, ledgerId }],
    queryFn: async (): Promise<unknown> => {
      switch (report) {
        case 'trial-balance': return api.reports.trialBalance(to);
        case 'profit-and-loss': return api.reports.profitAndLoss(from, to);
        case 'balance-sheet': return api.reports.balanceSheet(to);
        case 'cash-flow': return api.reports.cashFlow(from, to);
        case 'general-ledger': return api.reports.generalLedger(ledgerId, from, to);
        case 'ar-ageing': return api.reports.ageing('ar', to);
        case 'ap-ageing': return api.reports.ageing('ap', to);
        case 'gstr-1': return api.reports.gstr1(from, to);
        case 'gstr-3b': return api.reports.gstr3b(from, to);
        case 'tds': return api.reports.tds(from, to);
        default: return null;
      }
    },
    enabled: report !== 'general-ledger' || Boolean(ledgerId),
  });

  return (
    <div className="space-y-4" data-testid="books-reports">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block"><span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Report</span>
          <select value={report} onChange={(e) => setReport(e.target.value as ReportName)} className={`${selectCls} w-[200px]`} data-testid="report-picker">
            {REPORTS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </label>
        {def.period === 'range' ? <label className="block"><span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} /></label> : null}
        <label className="block"><span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">{def.period === 'as_of' ? 'As of' : 'To'}</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} /></label>
        {report === 'general-ledger' ? (
          <label className="block"><span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Account</span>
            <select value={ledgerId} onChange={(e) => setLedgerId(e.target.value)} className={`${selectCls} w-[220px]`} data-testid="report-ledger">
              <option value="">Select an account…</option>{(ledgers.data?.items ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        ) : null}
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => exportReport(report, q.data, org.name)} disabled={!q.data} data-testid="report-export"><Download size={14} strokeWidth={1.75} className="mr-1" />Export</Button>
      </div>

      {q.isLoading ? <div className="h-40 bg-neutral-100 rounded" /> : q.isError ? <Section><Empty>{(q.error as Error).message}</Empty></Section> : !q.data ? <Section><Empty>Choose an account.</Empty></Section> : (
        <Body report={report} data={q.data as never} currency={org.base_currency} />
      )}
    </div>
  );
}

function Body({ report, data, currency }: { report: ReportName; data: never; currency: string }) {
  const d = data as Record<string, never>;
  if (report === 'trial-balance') {
    const t = data as unknown as import('@/modules/books/types').TrialBalance;
    return (
      <Section title={`Trial balance as of ${t.as_of}`}>
        <Table head={['Account', 'Group', { label: 'Debit', align: 'right' }, { label: 'Credit', align: 'right' }, { label: 'Closing Dr', align: 'right' }, { label: 'Closing Cr', align: 'right' }]}>
          {t.rows.map((r) => (
            <Row key={r.ledger_id}>
              <Cell className="font-medium">{r.name}</Cell><Cell muted>{r.tally_group}</Cell>
              <Cell right><Money value={r.debit} currency={currency} /></Cell><Cell right><Money value={r.credit} currency={currency} /></Cell>
              <Cell right><Money value={r.closing_debit} currency={currency} /></Cell><Cell right><Money value={r.closing_credit} currency={currency} /></Cell>
            </Row>
          ))}
          <Row><Cell className="font-medium">Total</Cell><Cell /><Cell right><Money value={t.totals.debit} bold currency={currency} zero="0" /></Cell><Cell right><Money value={t.totals.credit} bold currency={currency} zero="0" /></Cell><Cell right><Money value={t.totals.closing_debit} bold currency={currency} zero="0" /></Cell><Cell right><Money value={t.totals.closing_credit} bold currency={currency} zero="0" /></Cell></Row>
        </Table>
        {t.totals.debit !== t.totals.credit ? <div className="p-3"><Notice tone="error">Debits and credits differ. This should be impossible — please report it.</Notice></div> : null}
      </Section>
    );
  }
  if (report === 'profit-and-loss') {
    const p = data as unknown as import('@/modules/books/types').ProfitAndLoss;
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="Income">
          <Table head={['Account', { label: 'Amount', align: 'right' }]} minWidth={320}>
            {p.income.map((r) => <Row key={r.ledger_id}><Cell>{r.name}</Cell><Cell right><Money value={r.amount} currency={currency} /></Cell></Row>)}
            <Row><Cell className="font-medium">Total income</Cell><Cell right><Money value={p.total_income} bold currency={currency} zero="0" /></Cell></Row>
          </Table>
        </Section>
        <Section title="Expenses">
          <Table head={['Account', { label: 'Amount', align: 'right' }]} minWidth={320}>
            {p.expense.map((r) => <Row key={r.ledger_id}><Cell>{r.name}</Cell><Cell right><Money value={r.amount} currency={currency} /></Cell></Row>)}
            <Row><Cell className="font-medium">Total expenses</Cell><Cell right><Money value={p.total_expense} bold currency={currency} zero="0" /></Cell></Row>
          </Table>
        </Section>
        <div className="lg:col-span-2 bg-white border border-neutral-200 rounded px-4 py-3 flex items-baseline justify-between">
          <span className="text-14 font-medium text-neutral-900">Net {p.net_profit >= 0 ? 'profit' : 'loss'} · {p.from} to {p.to}</span>
          <span className="text-20 font-semibold tabular-nums">{money(Math.abs(p.net_profit), currency)}</span>
        </div>
      </div>
    );
  }
  if (report === 'balance-sheet') {
    const b = data as unknown as import('@/modules/books/types').BalanceSheet;
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="Assets">
          <Table head={['Account', { label: 'Amount', align: 'right' }]} minWidth={320}>
            {b.assets.map((r) => <Row key={r.ledger_id}><Cell>{r.name}</Cell><Cell right><Money value={r.amount} currency={currency} /></Cell></Row>)}
            <Row><Cell className="font-medium">Total assets</Cell><Cell right><Money value={b.total_assets} bold currency={currency} zero="0" /></Cell></Row>
          </Table>
        </Section>
        <Section title="Liabilities and equity">
          <Table head={['Account', { label: 'Amount', align: 'right' }]} minWidth={320}>
            {b.liabilities.map((r) => <Row key={r.ledger_id}><Cell>{r.name}</Cell><Cell right><Money value={r.amount} currency={currency} /></Cell></Row>)}
            {b.equity.map((r) => <Row key={r.ledger_id}><Cell>{r.name}</Cell><Cell right><Money value={r.amount} currency={currency} /></Cell></Row>)}
            <Row><Cell muted>Retained earnings (prior years)</Cell><Cell right><Money value={b.prior_years_earnings} currency={currency} /></Cell></Row>
            <Row><Cell muted>Current year earnings</Cell><Cell right><Money value={b.current_year_earnings} currency={currency} /></Cell></Row>
            <Row><Cell className="font-medium">Total liabilities and equity</Cell><Cell right><Money value={b.total_liabilities + b.total_equity} bold currency={currency} zero="0" /></Cell></Row>
          </Table>
        </Section>
        {b.difference !== 0 ? <div className="lg:col-span-2"><Notice tone="error">The sheet is out by {money(b.difference, currency)}. This should be impossible — please report it.</Notice></div> : null}
      </div>
    );
  }
  if (report === 'cash-flow') {
    const c = data as unknown as import('@/modules/books/types').CashFlow;
    return (
      <Section title={`Cash flow · ${c.from} to ${c.to}`}>
        <Table head={['', { label: 'Amount', align: 'right' }]} minWidth={320}>
          <Row><Cell muted>Opening cash and bank</Cell><Cell right><Money value={c.opening_cash} currency={currency} zero="0" /></Cell></Row>
          <Row><Cell>Operating activities</Cell><Cell right><Money value={c.operating} currency={currency} zero="0" /></Cell></Row>
          <Row><Cell>Investing activities</Cell><Cell right><Money value={c.investing} currency={currency} zero="0" /></Cell></Row>
          <Row><Cell>Financing activities</Cell><Cell right><Money value={c.financing} currency={currency} zero="0" /></Cell></Row>
          <Row><Cell className="font-medium">Net change</Cell><Cell right><Money value={c.net_change} bold currency={currency} zero="0" /></Cell></Row>
          <Row><Cell className="font-medium">Closing cash and bank</Cell><Cell right><Money value={c.closing_cash} bold currency={currency} zero="0" /></Cell></Row>
        </Table>
      </Section>
    );
  }
  if (report === 'general-ledger') {
    const g = data as unknown as import('@/modules/books/types').GeneralLedger;
    return (
      <Section title={`${g.ledger.name} · ${g.from} to ${g.to}`}>
        <Table head={['Date', 'Voucher', 'Narration', { label: 'Debit', align: 'right' }, { label: 'Credit', align: 'right' }, { label: 'Balance', align: 'right' }]}>
          <Row><Cell muted colSpan={5}>Opening balance</Cell><Cell right><Money value={g.opening} currency={currency} zero="0" /></Cell></Row>
          {g.rows.map((r) => (
            <Row key={r.id}>
              <Cell muted className="tabular-nums whitespace-nowrap">{r.journal?.date}</Cell>
              <Cell muted>{r.journal?.number}</Cell>
              <Cell muted className="max-w-[280px] truncate">{r.description ?? r.journal?.narration ?? '—'}</Cell>
              <Cell right><Money value={r.side === 'debit' ? r.amount : 0} currency={currency} /></Cell>
              <Cell right><Money value={r.side === 'credit' ? r.amount : 0} currency={currency} /></Cell>
              <Cell right><Money value={r.running} currency={currency} zero="0" /></Cell>
            </Row>
          ))}
          <Row><Cell className="font-medium" colSpan={3}>Closing</Cell><Cell right><Money value={g.total_debit} bold currency={currency} zero="0" /></Cell><Cell right><Money value={g.total_credit} bold currency={currency} zero="0" /></Cell><Cell right><Money value={g.closing} bold currency={currency} zero="0" /></Cell></Row>
        </Table>
      </Section>
    );
  }
  if (report === 'ar-ageing' || report === 'ap-ageing') {
    const a = data as unknown as import('@/modules/books/types').Ageing;
    return (
      <Section title={`${report === 'ar-ageing' ? 'Receivables' : 'Payables'} ageing as of ${a.as_of}`}>
        {a.rows.length === 0 ? <Empty>Nothing outstanding.</Empty> : (
          <Table head={[report === 'ar-ageing' ? 'Customer' : 'Vendor', { label: 'Current', align: 'right' }, { label: '1–30', align: 'right' }, { label: '31–60', align: 'right' }, { label: '61–90', align: 'right' }, { label: '90+', align: 'right' }, { label: 'Total', align: 'right' }]}>
            {a.rows.map((r) => (
              <Row key={r.contact_id ?? r.contact}>
                <Cell className="font-medium">{r.contact}</Cell>
                <Cell right><Money value={r.current} currency={currency} /></Cell><Cell right><Money value={r.d1_30} currency={currency} /></Cell>
                <Cell right><Money value={r.d31_60} currency={currency} /></Cell><Cell right><Money value={r.d61_90} currency={currency} /></Cell>
                <Cell right><Money value={r.d90_plus} currency={currency} /></Cell><Cell right><Money value={r.total} bold currency={currency} /></Cell>
              </Row>
            ))}
            <Row><Cell className="font-medium">Total</Cell>
              <Cell right><Money value={a.totals.current} bold currency={currency} zero="0" /></Cell><Cell right><Money value={a.totals.d1_30} bold currency={currency} zero="0" /></Cell>
              <Cell right><Money value={a.totals.d31_60} bold currency={currency} zero="0" /></Cell><Cell right><Money value={a.totals.d61_90} bold currency={currency} zero="0" /></Cell>
              <Cell right><Money value={a.totals.d90_plus} bold currency={currency} zero="0" /></Cell><Cell right><Money value={a.totals.total} bold currency={currency} zero="0" /></Cell>
            </Row>
          </Table>
        )}
      </Section>
    );
  }
  if (report === 'gstr-1') {
    const g = data as unknown as import('@/modules/books/types').Gstr1;
    const block = (title: string, rows: typeof g.b2b) => (
      <Section title={title} key={title}>
        {rows.length === 0 ? <Empty>Nothing in this section.</Empty> : (
          <Table head={['Invoice', 'Date', 'Party', 'GSTIN', 'POS', { label: 'Taxable', align: 'right' }, { label: 'CGST', align: 'right' }, { label: 'SGST', align: 'right' }, { label: 'IGST', align: 'right' }]}>
            {rows.map((r) => (
              <Row key={r.number}><Cell className="font-medium">{r.number}</Cell><Cell muted className="tabular-nums">{r.date}</Cell><Cell muted>{r.contact}</Cell><Cell muted className="tabular-nums">{r.gstin ?? '—'}</Cell><Cell muted>{r.place_of_supply ?? '—'}</Cell>
                <Cell right><Money value={r.taxable} /></Cell><Cell right><Money value={r.cgst} /></Cell><Cell right><Money value={r.sgst} /></Cell><Cell right><Money value={r.igst} /></Cell></Row>
            ))}
          </Table>
        )}
      </Section>
    );
    return (
      <div className="space-y-4">
        <Notice>Computed from posted invoices and credit notes. Export the JSON to file it in the offline utility; nothing is submitted from here.</Notice>
        {block('B2B invoices', g.b2b)}{block('B2C invoices', g.b2c)}{block('Credit notes (registered)', g.cdnr)}{block('Credit notes (unregistered)', g.cdnur)}
        <Section title="HSN summary">
          <Table head={['HSN / SAC', 'Description', { label: 'Qty', align: 'right' }, { label: 'Taxable', align: 'right' }, { label: 'CGST', align: 'right' }, { label: 'SGST', align: 'right' }, { label: 'IGST', align: 'right' }]}>
            {g.hsn.map((h) => <Row key={h.hsn_sac}><Cell className="tabular-nums">{h.hsn_sac}</Cell><Cell muted>{h.description}</Cell><Cell right muted className="tabular-nums">{h.quantity}</Cell><Cell right><Money value={h.taxable} /></Cell><Cell right><Money value={h.cgst} /></Cell><Cell right><Money value={h.sgst} /></Cell><Cell right><Money value={h.igst} /></Cell></Row>)}
          </Table>
        </Section>
      </div>
    );
  }
  if (report === 'gstr-3b') {
    const g = data as unknown as import('@/modules/books/types').Gstr3b;
    return (
      <Section title={`GSTR-3B · ${g.period.from} to ${g.period.to}`}>
        <Table head={['', { label: 'Taxable', align: 'right' }, { label: 'IGST', align: 'right' }, { label: 'CGST', align: 'right' }, { label: 'SGST', align: 'right' }]}>
          <Row><Cell className="font-medium">3.1 Outward supplies</Cell><Cell right><Money value={g['3_1_outward_supplies'].taxable} /></Cell><Cell right><Money value={g['3_1_outward_supplies'].igst} /></Cell><Cell right><Money value={g['3_1_outward_supplies'].cgst} /></Cell><Cell right><Money value={g['3_1_outward_supplies'].sgst} /></Cell></Row>
          <Row><Cell className="font-medium">4. Eligible ITC</Cell><Cell right><Money value={g['4_eligible_itc'].taxable} /></Cell><Cell right><Money value={g['4_eligible_itc'].igst} /></Cell><Cell right><Money value={g['4_eligible_itc'].cgst} /></Cell><Cell right><Money value={g['4_eligible_itc'].sgst} /></Cell></Row>
          <Row><Cell className="font-medium">Net payable</Cell><Cell /><Cell right><Money value={g.net_payable.igst} bold zero="0" /></Cell><Cell right><Money value={g.net_payable.cgst} bold zero="0" /></Cell><Cell right><Money value={g.net_payable.sgst} bold zero="0" /></Cell></Row>
        </Table>
      </Section>
    );
  }
  const t = d as unknown as { items: { bill: string; date: string; vendor: string; pan: string | null; section: string | null; rate_bp: number | null; taxable: number; tds: number }[] };
  return (
    <Section title="TDS deducted">
      {t.items.length === 0 ? <Empty>No TDS deducted in this period.</Empty> : (
        <Table head={['Bill', 'Date', 'Vendor', 'PAN', 'Section', { label: 'Rate', align: 'right' }, { label: 'Taxable', align: 'right' }, { label: 'TDS', align: 'right' }]}>
          {t.items.map((r) => (
            <Row key={r.bill}><Cell className="font-medium">{r.bill}</Cell><Cell muted className="tabular-nums">{r.date}</Cell><Cell muted>{r.vendor}</Cell>
              <Cell muted className="tabular-nums">{r.pan ?? <span className="text-red">No PAN</span>}</Cell><Cell muted>{r.section ?? '—'}</Cell>
              <Cell right muted className="tabular-nums">{r.rate_bp ? bp(r.rate_bp) : '—'}</Cell><Cell right><Money value={r.taxable} /></Cell><Cell right><Money value={r.tds} bold /></Cell></Row>
          ))}
        </Table>
      )}
    </Section>
  );
}

function exportReport(report: ReportName, data: unknown, orgName: string) {
  if (!data) return;
  const name = `${orgName.replace(/\W+/g, '-').toLowerCase()}-${report}`;
  if (report === 'gstr-1' || report === 'gstr-3b') return downloadJson(`${name}.json`, data);
  const d = data as Record<string, unknown>;
  if (report === 'trial-balance') {
    const t = data as import('@/modules/books/types').TrialBalance;
    return downloadCsv(`${name}.csv`, ['Account', 'Group', 'Debit', 'Credit', 'Closing Dr', 'Closing Cr'], t.rows.map((r) => [r.name, r.tally_group, fromPaise(r.debit), fromPaise(r.credit), fromPaise(r.closing_debit), fromPaise(r.closing_credit)]));
  }
  if (report === 'profit-and-loss') {
    const p = data as import('@/modules/books/types').ProfitAndLoss;
    return downloadCsv(`${name}.csv`, ['Section', 'Account', 'Amount'], [...p.income.map((r) => ['Income', r.name, fromPaise(r.amount)]), ...p.expense.map((r) => ['Expense', r.name, fromPaise(r.amount)]), ['', 'Net profit', fromPaise(p.net_profit)]]);
  }
  if (report === 'balance-sheet') {
    const b = data as import('@/modules/books/types').BalanceSheet;
    return downloadCsv(`${name}.csv`, ['Section', 'Account', 'Amount'], [...b.assets.map((r) => ['Asset', r.name, fromPaise(r.amount)]), ...b.liabilities.map((r) => ['Liability', r.name, fromPaise(r.amount)]), ...b.equity.map((r) => ['Equity', r.name, fromPaise(r.amount)]), ['Equity', 'Current year earnings', fromPaise(b.current_year_earnings)]]);
  }
  if (report === 'general-ledger') {
    const g = data as import('@/modules/books/types').GeneralLedger;
    return downloadCsv(`${name}.csv`, ['Date', 'Voucher', 'Narration', 'Debit', 'Credit', 'Balance'], g.rows.map((r) => [r.journal?.date ?? '', r.journal?.number ?? '', r.description ?? r.journal?.narration ?? '', fromPaise(r.side === 'debit' ? r.amount : 0), fromPaise(r.side === 'credit' ? r.amount : 0), fromPaise(r.running)]));
  }
  if (report === 'ar-ageing' || report === 'ap-ageing') {
    const a = data as import('@/modules/books/types').Ageing;
    return downloadCsv(`${name}.csv`, ['Party', 'Current', '1-30', '31-60', '61-90', '90+', 'Total'], a.rows.map((r) => [r.contact, fromPaise(r.current), fromPaise(r.d1_30), fromPaise(r.d31_60), fromPaise(r.d61_90), fromPaise(r.d90_plus), fromPaise(r.total)]));
  }
  if (report === 'tds') {
    const t = d as { items: { bill: string; date: string; vendor: string; pan: string | null; section: string | null; taxable: number; tds: number }[] };
    return downloadCsv(`${name}.csv`, ['Bill', 'Date', 'Vendor', 'PAN', 'Section', 'Taxable', 'TDS'], t.items.map((r) => [r.bill, r.date, r.vendor, r.pan ?? '', r.section ?? '', fromPaise(r.taxable), fromPaise(r.tds)]));
  }
  const c = data as import('@/modules/books/types').CashFlow;
  return downloadCsv(`${name}.csv`, ['Line', 'Amount'], [['Opening', fromPaise(c.opening_cash)], ['Operating', fromPaise(c.operating)], ['Investing', fromPaise(c.investing)], ['Financing', fromPaise(c.financing)], ['Closing', fromPaise(c.closing_cash)]]);
}
