import { useParams, useSearchParams, Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import {
  bookkeepingAccountingApi,
  type DayBookRow, type TrialBalanceRow, type RegisterReport, type Outstandings, type LedgerStatement,
} from '@/modules/tools/audit-automation/bookkeeping';
import {
  DataTable, Money, DrCr, Panel, Loading, ErrorNote, usePeriod, ReportHeader, ExportButtons, StatusPill,
  type Column,
} from '@/modules/tools/bookkeeping/ui';

/**
 * Every statement-style report, one component per shape.
 *
 * The rule the whole module follows shows up here: a number is either a
 * link to what it is made of, or it is the transaction itself. Balance
 * sheet → group → ledger → voucher, with no dead ends.
 */

export function BookkeepingReportPage() {
  const { reportId = '' } = useParams();
  switch (reportId) {
    case 'day-book': return <DayBook />;
    case 'trial-balance': return <TrialBalanceReport />;
    case 'profit-and-loss': return <ProfitAndLossReport />;
    case 'balance-sheet': return <BalanceSheetReport />;
    case 'group-summary': return <GroupSummaryReport />;
    case 'outstandings': return <OutstandingsReport />;
    case 'cash-flow': return <CashFlowReport />;
    case 'ratios': return <RatiosReport />;
    default: return <ErrorNote message={`Unknown report "${reportId}".`} />;
  }
}

function useCtx() {
  const { companyId = '' } = useParams();
  const { from, to } = usePeriod();
  return { companyId, from, to, base: `/workstation/services/bookkeeping/companies/${companyId}` };
}

function BackLink() {
  const { base } = useCtx();
  return (
    <Link to={`${base}/reports`} className="inline-flex items-center gap-1 text-12 text-neutral-500 hover:text-neutral-900 mb-2 print:hidden">
      <ArrowLeft size={13} strokeWidth={1.75} /> All reports
    </Link>
  );
}

// ── Day book ─────────────────────────────────────────────────────────
function DayBook() {
  const { companyId, from, to, base } = useCtx();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['tally.dayBook', companyId, from, to],
    queryFn: () => bookkeepingAccountingApi.dayBook(companyId, { from, to, limit: 500, include_cancelled: true }),
  });
  const columns: Column<DayBookRow>[] = [
    { key: 'date', label: 'Date', width: '96px', value: (r) => r.date },
    { key: 'type', label: 'Type', value: (r) => r.voucher_type_name },
    {
      key: 'number', label: 'No.', value: (r) => r.voucher_number,
      render: (r) => <Link to={`${base}/vouchers/${r.voucher_id}`} className="text-neutral-900 font-medium hover:text-gold">{r.voucher_number}</Link>,
    },
    { key: 'particulars', label: 'Particulars', value: (r) => r.party_name ?? r.ledgers.join(' / '), render: (r) => <span className="text-neutral-600">{r.party_name ?? r.ledgers.join(' / ')}</span> },
    { key: 'narration', label: 'Narration', value: (r) => r.narration ?? '' },
    { key: 'debit', label: 'Debit', align: 'right', value: (r) => r.debit_paise / 100, render: (r) => <Money paise={r.debit_paise} /> },
    { key: 'credit', label: 'Credit', align: 'right', value: (r) => r.credit_paise / 100, render: (r) => <Money paise={r.credit_paise} /> },
    { key: 'status', label: '', align: 'center', value: (r) => r.status, render: (r) => (r.status === 'active' ? null : <StatusPill status={r.status} />) },
  ];
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  return (
    <div data-testid="tally-day-book">
      <BackLink />
      <ReportHeader
        title="Day Book"
        subtitle={`${from} to ${to} · ${q.data!.totals.count} vouchers`}
        actions={<ExportButtons filename="day-book.csv" rows={q.data!.items} columns={columns} />}
      />
      <Panel>
        <DataTable
          rows={q.data!.items}
          rowKey={(r) => r.voucher_id}
          columns={columns}
          onRowClick={(r) => navigate(`${base}/vouchers/${r.voucher_id}`)}
          footer={
            <tr>
              <td className="px-3 py-2" colSpan={5}>Total</td>
              <td className="px-3 py-2 text-right"><Money paise={q.data!.totals.debit_paise} bold /></td>
              <td className="px-3 py-2 text-right"><Money paise={q.data!.totals.credit_paise} bold /></td>
              <td />
            </tr>
          }
        />
      </Panel>
    </div>
  );
}

// ── Trial balance ────────────────────────────────────────────────────
function TrialBalanceReport() {
  const { companyId, from, to, base } = useCtx();
  const q = useQuery({
    queryKey: ['tally.trialBalance', companyId, from, to],
    queryFn: () => bookkeepingAccountingApi.trialBalance(companyId, { from, to }),
  });
  const columns: Column<TrialBalanceRow>[] = [
    {
      key: 'ledger', label: 'Ledger', value: (r) => r.ledgerName,
      render: (r) => <Link to={`${base}/reports/ledger/${r.ledgerId}?from=${from}&to=${to}`} className="text-neutral-900 hover:text-gold">{r.ledgerName}</Link>,
    },
    // Spec §5 asks for Group + Sub-group as separate columns — primary
    // is the top-level, group is the immediate parent (may coincide).
    { key: 'primaryGroup', label: 'Group', value: (r) => r.primaryGroupName, render: (r) => <span className="text-neutral-700">{r.primaryGroupName}</span> },
    { key: 'group', label: 'Sub-group', value: (r) => r.groupName, render: (r) => <span className="text-neutral-500">{r.groupName === r.primaryGroupName ? '—' : r.groupName}</span> },
    { key: 'opening', label: 'Opening', align: 'right', value: (r) => r.openingPaise / 100, render: (r) => <DrCr paise={r.openingPaise} /> },
    { key: 'debit', label: 'Debit', align: 'right', value: (r) => r.debitPaise / 100, render: (r) => <Money paise={r.debitPaise} /> },
    { key: 'credit', label: 'Credit', align: 'right', value: (r) => r.creditPaise / 100, render: (r) => <Money paise={r.creditPaise} /> },
    { key: 'closingDr', label: 'Closing Dr', align: 'right', value: (r) => r.closingDebitPaise / 100, render: (r) => <Money paise={r.closingDebitPaise} /> },
    { key: 'closingCr', label: 'Closing Cr', align: 'right', value: (r) => r.closingCreditPaise / 100, render: (r) => <Money paise={r.closingCreditPaise} /> },
  ];
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const t = q.data!.totals;
  return (
    <div data-testid="tally-trial-balance">
      <BackLink />
      <ReportHeader
        title="Trial Balance"
        subtitle={`${from} to ${to}`}
        actions={<ExportButtons filename="trial-balance.csv" rows={q.data!.rows} columns={columns} />}
      />
      <div className={`mb-3 rounded border px-3 py-2 text-13 ${t.balanced ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-danger/30 text-danger'}`}>
        {t.balanced
          ? 'Debits equal credits. The books balance.'
          : `Out of balance by ₹${(Math.abs(t.differencePaise) / 100).toFixed(2)} — investigate before relying on any statement below.`}
      </div>
      <Panel>
        <DataTable
          minWidth="1000px"
          rows={q.data!.rows.filter((r) => r.openingPaise || r.debitPaise || r.creditPaise || r.closingPaise)}
          rowKey={(r) => r.ledgerId}
          columns={columns}
          footer={
            <tr>
              {/* Ledger, Group, Sub-group, Opening — 4 label cells for the Total */}
              <td className="px-3 py-2" colSpan={4}>Total</td>
              <td className="px-3 py-2 text-right"><Money paise={t.debitPaise} bold /></td>
              <td className="px-3 py-2 text-right"><Money paise={t.creditPaise} bold /></td>
              <td className="px-3 py-2 text-right"><Money paise={t.closingDebitPaise} bold /></td>
              <td className="px-3 py-2 text-right"><Money paise={t.closingCreditPaise} bold /></td>
            </tr>
          }
        />
      </Panel>
    </div>
  );
}

// ── P&L ──────────────────────────────────────────────────────────────
function ProfitAndLossReport() {
  const { companyId, from, to, base } = useCtx();
  const q = useQuery({
    queryKey: ['tally.pl', companyId, from, to],
    queryFn: () => bookkeepingAccountingApi.profitAndLoss(companyId, { from, to }),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const pl = q.data!;
  const side = (rows: { ledgerId: string; ledgerName: string; groupName: string; amountPaise: number }[]) => (
    <ul className="divide-y divide-neutral-100">
      {rows.length === 0 ? <li className="px-3 py-3 text-13 text-neutral-500">Nothing in this period.</li> : null}
      {rows.map((r) => (
        <li key={r.ledgerId} className="px-3 py-2 flex items-center justify-between gap-3">
          <Link to={`${base}/reports/ledger/${r.ledgerId}?from=${from}&to=${to}`} className="text-13 text-neutral-900 hover:text-gold truncate">
            {r.ledgerName} <span className="text-11 text-neutral-400">· {r.groupName}</span>
          </Link>
          <Money paise={r.amountPaise} />
        </li>
      ))}
    </ul>
  );
  return (
    <div data-testid="tally-pl">
      <BackLink />
      <ReportHeader title="Profit &amp; Loss" subtitle={`${from} to ${to}`} actions={<ExportButtons filename="profit-and-loss.csv" rows={[...pl.income.rows.map((r) => ({ ...r, side: 'Income' })), ...pl.expenses.rows.map((r) => ({ ...r, side: 'Expense' }))]} columns={[{ key: 'side', label: 'Side', value: (r) => r.side }, { key: 'ledger', label: 'Ledger', value: (r) => r.ledgerName }, { key: 'group', label: 'Group', value: (r) => r.groupName }, { key: 'amount', label: 'Amount', value: (r) => r.amountPaise / 100 }]} />} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Panel title={`Expenses — ₹${(pl.expenses.totalPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}>{side(pl.expenses.rows)}</Panel>
        <Panel title={`Income — ₹${(pl.income.totalPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}>{side(pl.income.rows)}</Panel>
      </div>
      {/*
       * Margin percentages per BOOKKEEPING-REBUILD §5: the P&L is the
       * one place a CA looks for margin at a glance. GP margin uses
       * income as the denominator, not COGS.
       */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <Panel title="Gross profit">
          <div className="p-3 flex items-baseline gap-3">
            <span className="text-16 font-semibold"><Money paise={pl.grossProfitPaise} signed /></span>
            {pl.income.totalPaise > 0 && (
              <span className={`text-13 ${pl.grossProfitPaise >= 0 ? 'text-emerald-700' : 'text-danger'}`}>
                {((pl.grossProfitPaise / pl.income.totalPaise) * 100).toFixed(1)}% margin
              </span>
            )}
          </div>
          <p className="px-3 pb-3 text-11 text-neutral-500">Sales and direct income less purchases and direct expenses.</p>
        </Panel>
        <Panel title={pl.netProfitPaise >= 0 ? 'Net profit' : 'Net loss'}>
          <div className="p-3 flex items-baseline gap-3">
            <span className="text-16 font-semibold"><Money paise={pl.netProfitPaise} signed /></span>
            {pl.income.totalPaise > 0 && (
              <span className={`text-13 ${pl.netProfitPaise >= 0 ? 'text-emerald-700' : 'text-danger'}`}>
                {((pl.netProfitPaise / pl.income.totalPaise) * 100).toFixed(1)}% margin
              </span>
            )}
          </div>
          <p className="px-3 pb-3 text-11 text-neutral-500">Carried to the balance sheet alongside capital.</p>
        </Panel>
      </div>
    </div>
  );
}

// ── Balance sheet ────────────────────────────────────────────────────
function BalanceSheetReport() {
  const { companyId, from, to, base } = useCtx();
  const q = useQuery({
    queryKey: ['tally.bs', companyId, from, to],
    queryFn: () => bookkeepingAccountingApi.balanceSheet(companyId, { from, to }),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const bs = q.data!;
  const sideList = (groups: typeof bs.assets.groups) => (
    <ul className="divide-y divide-neutral-100">
      {groups.length === 0 ? <li className="px-3 py-3 text-13 text-neutral-500">Nothing here yet.</li> : null}
      {groups.map((g) => (
        <li key={g.groupId} className="px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-13 font-medium text-neutral-900">{g.groupName}</span>
            <Money paise={g.amountPaise} bold />
          </div>
          <ul className="mt-1 space-y-0.5">
            {g.ledgers.map((l) => (
              <li key={l.ledgerId} className="flex items-center justify-between gap-3 pl-3">
                <Link to={`${base}/reports/ledger/${l.ledgerId}?from=${from}&to=${to}`} className="text-12 text-neutral-600 hover:text-gold truncate">{l.ledgerName}</Link>
                <span className="text-12"><Money paise={l.amountPaise} /></span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
  return (
    <div data-testid="tally-balance-sheet">
      <BackLink />
      <ReportHeader
        title="Balance Sheet"
        subtitle={`As at ${to}`}
        actions={
          /*
           * Balanced badge per BOOKKEEPING-REBUILD §5. The engine
           * already guarantees this, but a CA looks for the badge as
           * confirmation — silence looked like an oversight.
           */
          bs.balanced ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-12 text-emerald-800">
              <span className="text-emerald-700">✓</span> Balanced
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-danger/30 bg-red-50 px-2 py-0.5 text-12 text-danger">
              Out of balance
            </span>
          )
        }
      />
      {!bs.balanced ? (
        <div className="mb-3 rounded border border-danger/30 bg-red-50 px-3 py-2 text-13 text-danger">
          The two sides differ by ₹{(Math.abs(bs.differencePaise) / 100).toFixed(2)}. Check the trial balance.
        </div>
      ) : null}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Panel title={`Liabilities — ₹${((bs.liabilities.totalPaise + bs.netProfitPaise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}>
          {sideList(bs.liabilities.groups)}
          <div className="px-3 py-2 border-t border-neutral-100 flex items-center justify-between">
            <Link to={`${base}/reports/profit-and-loss?from=${from}&to=${to}`} className="text-13 text-neutral-900 hover:text-gold">
              {bs.netProfitPaise >= 0 ? 'Profit for the period' : 'Loss for the period'}
            </Link>
            <Money paise={bs.netProfitPaise} signed bold />
          </div>
        </Panel>
        <Panel title={`Assets — ₹${(bs.assets.totalPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}>
          {sideList(bs.assets.groups)}
        </Panel>
      </div>
    </div>
  );
}

// ── Group summary ────────────────────────────────────────────────────
function GroupSummaryReport() {
  const { companyId, from, to, base } = useCtx();
  const q = useQuery({
    queryKey: ['tally.groupSummary', companyId, from, to],
    queryFn: () => bookkeepingAccountingApi.groupSummary(companyId, { from, to }),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const rows = q.data!.items.filter((g) => g.closingPaise !== 0 || g.debitPaise !== 0 || g.creditPaise !== 0);
  const columns: Column<typeof rows[number]>[] = [
    { key: 'group', label: 'Group', value: (r) => r.groupName, render: (r) => <span className={r.parentGroupId ? 'pl-4 text-neutral-700' : 'font-medium text-neutral-900'}>{r.groupName}</span> },
    { key: 'nature', label: 'Nature', value: (r) => r.nature, render: (r) => <span className="text-11 uppercase text-neutral-500">{r.nature}</span> },
    { key: 'ledgers', label: 'Ledgers', align: 'right', value: (r) => r.ledgerCount },
    { key: 'opening', label: 'Opening', align: 'right', value: (r) => r.openingPaise / 100, render: (r) => <DrCr paise={r.openingPaise} /> },
    { key: 'debit', label: 'Debit', align: 'right', value: (r) => r.debitPaise / 100, render: (r) => <Money paise={r.debitPaise} /> },
    { key: 'credit', label: 'Credit', align: 'right', value: (r) => r.creditPaise / 100, render: (r) => <Money paise={r.creditPaise} /> },
    { key: 'closing', label: 'Closing', align: 'right', value: (r) => r.closingPaise / 100, render: (r) => <DrCr paise={r.closingPaise} /> },
  ];
  return (
    <div data-testid="tally-group-summary">
      <BackLink />
      <ReportHeader title="Group Summary" subtitle={`${from} to ${to} · drill into a ledger from the trial balance`} actions={<ExportButtons filename="group-summary.csv" rows={rows} columns={columns} />} />
      <Panel>
        <DataTable rows={rows} rowKey={(r) => r.groupId} columns={columns} minWidth="820px" />
      </Panel>
      <p className="mt-2 text-11 text-neutral-500">
        Group totals include every sub-group beneath them. <Link to={`${base}/reports/trial-balance?from=${from}&to=${to}`} className="text-gold hover:underline">Open the trial balance</Link> to reach individual ledgers.
      </p>
    </div>
  );
}

// ── Registers ────────────────────────────────────────────────────────
export function BookkeepingRegisterPage() {
  const { companyId = '', typeCode = '' } = useParams();
  const { from, to } = usePeriod();
  const base = `/workstation/services/bookkeeping/companies/${companyId}`;
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['tally.register', companyId, typeCode, from, to],
    queryFn: () => bookkeepingAccountingApi.register(companyId, typeCode, { from, to }),
  });
  const columns: Column<RegisterReport['items'][number]>[] = [
    { key: 'date', label: 'Date', width: '96px', value: (r) => r.date },
    { key: 'number', label: 'No.', value: (r) => r.voucher_number, render: (r) => <Link to={`${base}/vouchers/${r.voucher_id}`} className="text-neutral-900 font-medium hover:text-gold">{r.voucher_number}</Link> },
    { key: 'party', label: 'Party', value: (r) => r.party_name ?? '', render: (r) => (r.party_id ? <Link to={`${base}/reports/ledger/${r.party_id}`} className="text-neutral-700 hover:text-gold">{r.party_name}</Link> : <span className="text-neutral-400">—</span>) },
    { key: 'gstin', label: 'GSTIN', value: (r) => r.party_gstin ?? '', render: (r) => <span className="font-mono text-12 text-neutral-500">{r.party_gstin ?? '—'}</span> },
    { key: 'taxable', label: 'Taxable', align: 'right', value: (r) => r.taxable_value_paise / 100, render: (r) => <Money paise={r.taxable_value_paise} /> },
    { key: 'cgst', label: 'CGST', align: 'right', value: (r) => r.cgst_paise / 100, render: (r) => <Money paise={r.cgst_paise} /> },
    { key: 'sgst', label: 'SGST', align: 'right', value: (r) => r.sgst_paise / 100, render: (r) => <Money paise={r.sgst_paise} /> },
    { key: 'igst', label: 'IGST', align: 'right', value: (r) => r.igst_paise / 100, render: (r) => <Money paise={r.igst_paise} /> },
    { key: 'total', label: 'Total', align: 'right', value: (r) => r.grand_total_paise / 100, render: (r) => <Money paise={r.grand_total_paise} /> },
  ];
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const t = q.data!.totals;
  const title = typeCode.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <div data-testid={`tally-register-${typeCode}`}>
      <BackLink />
      <ReportHeader title={`${title} Register`} subtitle={`${from} to ${to} · ${t.count} voucher${t.count === 1 ? '' : 's'}`} actions={<ExportButtons filename={`${typeCode}-register.csv`} rows={q.data!.items} columns={columns} />} />
      <Panel>
        <DataTable
          minWidth="960px"
          rows={q.data!.items}
          rowKey={(r) => r.voucher_id}
          columns={columns}
          onRowClick={(r) => navigate(`${base}/vouchers/${r.voucher_id}`)}
          footer={
            <tr>
              <td className="px-3 py-2" colSpan={4}>Total</td>
              <td className="px-3 py-2 text-right"><Money paise={t.taxableValuePaise} bold /></td>
              <td className="px-3 py-2 text-right"><Money paise={t.cgstPaise} bold /></td>
              <td className="px-3 py-2 text-right"><Money paise={t.sgstPaise} bold /></td>
              <td className="px-3 py-2 text-right"><Money paise={t.igstPaise} bold /></td>
              <td className="px-3 py-2 text-right"><Money paise={t.grandTotalPaise} bold /></td>
            </tr>
          }
        />
      </Panel>
    </div>
  );
}

// ── Outstandings ─────────────────────────────────────────────────────
function OutstandingsReport() {
  const { companyId, to, base } = useCtx();
  const [params] = useSearchParams();
  const side = (params.get('side') === 'payable' ? 'payable' : 'receivable') as 'receivable' | 'payable';
  const q = useQuery({
    queryKey: ['tally.outstandings', companyId, side, to],
    queryFn: () => bookkeepingAccountingApi.outstandings(companyId, side, { as_of: to }),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const d: Outstandings = q.data!;
  const flat = d.parties.flatMap((p) => p.bills.map((b) => ({ party: p.ledger_name, ...b })));

  // Summary numbers per BOOKKEEPING-REBUILD §5 — "the most-used
  // number in the whole module. Build it properly." Total is signed
  // the way the party expects (positive means we're owed); the
  // average is rounded to the nearest rupee for readability.
  const partyCount = d.parties.length;
  const avgPaise = partyCount > 0 ? Math.round(d.totalPaise / partyCount) : 0;
  const overdueBills = d.parties.reduce(
    (s, p) => s + p.bills.filter((b) => b.days_overdue > 0).length,
    0,
  );
  const overduePaise = d.parties.reduce(
    (s, p) => s + p.bills.filter((b) => b.days_overdue > 0).reduce((s2, b) => s2 + b.pending_paise, 0),
    0,
  );

  // Ageing bars scale to the largest bucket so the visual makes the
  // over-90 slice obvious when there is one, not lost in the total.
  const overdueBuckets = d.ageing.filter((a) => a.key !== 'not_due');
  const maxBucketPaise = Math.max(1, ...overdueBuckets.map((a) => Math.abs(a.amount_paise)));
  const invoicesPerBucket = d.parties.reduce((map, p) => {
    for (const b of p.bills) {
      map[b.ageing_bucket] = (map[b.ageing_bucket] ?? 0) + 1;
    }
    return map;
  }, {} as Record<string, number>);

  return (
    <div data-testid={`tally-outstandings-${side}`}>
      <BackLink />
      <ReportHeader
        title={side === 'receivable' ? 'Receivables' : 'Payables'}
        subtitle={`As at ${d.as_of}`}
        actions={
          <>
            <Link to={`${base}/reports/outstandings?side=${side === 'receivable' ? 'payable' : 'receivable'}`} className="h-8 px-2 inline-flex items-center text-12 border border-neutral-300 rounded bg-white hover:bg-neutral-50">
              Switch to {side === 'receivable' ? 'payables' : 'receivables'}
            </Link>
            <ExportButtons
              filename={`${side}s.csv`} rows={flat}
              columns={[
                { key: 'party', label: 'Party', value: (r) => r.party },
                { key: 'bill', label: 'Bill', value: (r) => r.bill_ref },
                { key: 'date', label: 'Date', value: (r) => r.date },
                { key: 'due', label: 'Due', value: (r) => r.due_date ?? '' },
                { key: 'pending', label: 'Pending', value: (r) => r.pending_paise / 100 },
                { key: 'age', label: 'Days overdue', value: (r) => r.days_overdue },
              ]}
            />
          </>
        }
      />

      {/* Summary KPIs — §5's "Summary (total outstanding, count, average)". */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 bg-white border border-neutral-200 rounded p-3">
        <OutstandingsStat label="Total outstanding" value={`₹ ${(d.totalPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`} />
        <OutstandingsStat label={side === 'receivable' ? 'Customers' : 'Suppliers'} value={String(partyCount)} />
        <OutstandingsStat label="Average per party" value={`₹ ${(avgPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`} />
        <OutstandingsStat
          label="Overdue"
          value={overdueBills === 0 ? '0 bills' : `${overdueBills} bill${overdueBills === 1 ? '' : 's'} · ₹${(overduePaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}
          tone={overdueBills > 0 ? 'warn' : 'muted'}
        />
      </div>

      {/* Ageing bars — the visual §5 (and §6) call for.
       *   Under 30 days   ████████████████░░░░  ₹2,41,000  4 invoices
       *   31–60 days      ██████░░░░░░░░░░░░░░  ₹  92,400  2 invoices
       *   61–90 days      ███░░░░░░░░░░░░░░░░░  ₹  48,260  2 invoices
       *   Over 90 days    ██░░░░░░░░░░░░░░░░░░  ₹  31,000  1 invoice   ← 2px left border
       */}
      <Panel title="Ageing" className="mb-4">
        <div className="p-3 space-y-2">
          {overdueBuckets.map((a) => {
            const pct = Math.round((Math.abs(a.amount_paise) / maxBucketPaise) * 100);
            const count = invoicesPerBucket[a.key] ?? 0;
            const isOverNinety = a.key === '90_plus' && a.amount_paise !== 0;
            return (
              <div key={a.key} className={`flex items-center gap-3 ${isOverNinety ? 'border-l-2 border-danger pl-2' : ''}`}>
                <div className="w-[110px] text-13 text-neutral-700">{a.label}</div>
                <div className="flex-1 h-4 bg-neutral-100 rounded overflow-hidden">
                  <div
                    className={`h-full ${isOverNinety ? 'bg-danger' : 'bg-neutral-500'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="w-[130px] text-right text-13 tabular-nums text-neutral-900">
                  <Money paise={a.amount_paise} />
                </div>
                <div className="w-[80px] text-right text-12 text-neutral-500 tabular-nums">
                  {count === 0 ? '—' : `${count} bill${count === 1 ? '' : 's'}`}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      {d.parties.length === 0 ? (
        <Panel><div className="px-3 py-6 text-13 text-neutral-500">Nothing outstanding as at {d.as_of}.</div></Panel>
      ) : (
        d.parties.map((p) => (
          <Panel
            key={p.ledger_id}
            className="mb-3"
            title={p.ledger_name}
            actions={
              <div className="flex items-center gap-3">
                {p.on_account_paise !== 0 ? <span className="text-11 text-neutral-500">On account <Money paise={p.on_account_paise} /></span> : null}
                <span className="text-13 font-semibold"><Money paise={p.total_paise} /></span>
                <Link to={`${base}/reports/ledger/${p.ledger_id}`} className="text-12 text-gold hover:underline">Ledger →</Link>
              </div>
            }
          >
            {p.bills.length === 0 ? (
              <div className="px-3 py-3 text-12 text-neutral-500">No bill-wise detail — the balance is carried on account.</div>
            ) : (
              <DataTable
                minWidth="620px"
                rows={p.bills}
                rowKey={(b) => `${p.ledger_id}-${b.bill_ref}`}
                columns={[
                  { key: 'bill', label: 'Bill ref', value: (b) => b.bill_ref, render: (b) => <Link to={`${base}/vouchers/${b.voucher_id}`} className="text-neutral-900 hover:text-gold">{b.bill_ref}</Link> },
                  { key: 'date', label: 'Date', value: (b) => b.date },
                  { key: 'due', label: 'Due date', value: (b) => b.due_date ?? '', render: (b) => <span className="text-neutral-600">{b.due_date ?? '—'}</span> },
                  { key: 'amount', label: 'Bill amount', align: 'right', value: (b) => b.amount_paise / 100, render: (b) => <Money paise={b.amount_paise} /> },
                  { key: 'settled', label: 'Settled', align: 'right', value: (b) => b.settled_paise / 100, render: (b) => <Money paise={b.settled_paise} /> },
                  { key: 'pending', label: 'Pending', align: 'right', value: (b) => b.pending_paise / 100, render: (b) => <Money paise={b.pending_paise} /> },
                  { key: 'age', label: 'Overdue', align: 'right', value: (b) => b.days_overdue, render: (b) => <span className={b.days_overdue > 0 ? 'text-danger tabular-nums' : 'text-neutral-500 tabular-nums'}>{b.days_overdue > 0 ? `${b.days_overdue} d` : '—'}</span> },
                ]}
              />
            )}
          </Panel>
        ))
      )}
    </div>
  );
}

// ── Cash / bank book ─────────────────────────────────────────────────
export function BookkeepingBookPage() {
  const { companyId = '', kind = 'cash' } = useParams();
  const { from, to } = usePeriod();
  const base = `/workstation/services/bookkeeping/companies/${companyId}`;
  const q = useQuery({
    queryKey: ['tally.book', companyId, kind, from, to],
    queryFn: () => bookkeepingAccountingApi.book(companyId, kind as 'cash' | 'bank', { from, to }),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const d = q.data!;
  return (
    <div data-testid={`tally-book-${kind}`}>
      <BackLink />
      <ReportHeader title={kind === 'cash' ? 'Cash Book' : 'Bank Book'} subtitle={`${from} to ${to}`} />
      <Panel>
        <DataTable
          rows={d.ledgers}
          rowKey={(r) => r.ledger_id}
          minWidth="640px"
          empty={`No ${kind} ledgers yet.`}
          columns={[
            { key: 'ledger', label: 'Ledger', value: (r) => r.ledger_name, render: (r) => <Link to={`${base}/reports/ledger/${r.ledger_id}?from=${from}&to=${to}`} className="text-neutral-900 hover:text-gold">{r.ledger_name}</Link> },
            { key: 'opening', label: 'Opening', align: 'right', value: (r) => r.opening_paise / 100, render: (r) => <DrCr paise={r.opening_paise} /> },
            { key: 'in', label: 'Receipts', align: 'right', value: (r) => r.debit_paise / 100, render: (r) => <Money paise={r.debit_paise} /> },
            { key: 'out', label: 'Payments', align: 'right', value: (r) => r.credit_paise / 100, render: (r) => <Money paise={r.credit_paise} /> },
            { key: 'closing', label: 'Closing', align: 'right', value: (r) => r.closing_paise / 100, render: (r) => <DrCr paise={r.closing_paise} /> },
          ]}
          footer={
            <tr>
              <td className="px-3 py-2">Total</td>
              <td className="px-3 py-2 text-right"><DrCr paise={d.totals.opening_paise} /></td>
              <td className="px-3 py-2 text-right"><Money paise={d.totals.debit_paise} bold /></td>
              <td className="px-3 py-2 text-right"><Money paise={d.totals.credit_paise} bold /></td>
              <td className="px-3 py-2 text-right"><DrCr paise={d.totals.closing_paise} /></td>
            </tr>
          }
        />
      </Panel>
    </div>
  );
}

// ── Ledger statement ─────────────────────────────────────────────────
export function BookkeepingLedgerStatement() {
  const { companyId = '', ledgerId = '' } = useParams();
  const { from, to } = usePeriod();
  const base = `/workstation/services/bookkeeping/companies/${companyId}`;
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['tally.ledgerStatement', companyId, ledgerId, from, to],
    queryFn: () => bookkeepingAccountingApi.ledgerStatement(companyId, ledgerId, { from, to }),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const d: LedgerStatement = q.data!;
  const columns: Column<LedgerStatement['rows'][number]>[] = [
    { key: 'date', label: 'Date', width: '96px', value: (r) => r.date },
    { key: 'particulars', label: 'Particulars', value: (r) => r.particulars, render: (r) => <span className="text-neutral-700">{r.particulars}</span> },
    { key: 'type', label: 'Type', value: (r) => r.voucher_type_code, render: (r) => <span className="capitalize text-12 text-neutral-500">{r.voucher_type_code.replace(/_/g, ' ')}</span> },
    { key: 'number', label: 'No.', value: (r) => r.voucher_number, render: (r) => <Link to={`${base}/vouchers/${r.voucher_id}`} className="text-neutral-900 hover:text-gold">{r.voucher_number}</Link> },
    { key: 'debit', label: 'Debit', align: 'right', value: (r) => r.debit_paise / 100, render: (r) => <Money paise={r.debit_paise} /> },
    { key: 'credit', label: 'Credit', align: 'right', value: (r) => r.credit_paise / 100, render: (r) => <Money paise={r.credit_paise} /> },
    { key: 'balance', label: 'Balance', align: 'right', value: (r) => r.running_balance_paise / 100, render: (r) => <DrCr paise={r.running_balance_paise} /> },
  ];
  return (
    <div data-testid="tally-ledger-statement">
      <BackLink />
      <ReportHeader
        title={d.ledger.name}
        subtitle={`${d.ledger.group_name} · ${from} to ${to}`}
        actions={<ExportButtons filename={`${d.ledger.name}-ledger.csv`} rows={d.rows} columns={columns} />}
      />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
        <Stat label="Opening" paise={d.openingPaise} signedDrCr />
        <Stat label="Debits" paise={d.debitPaise} />
        <Stat label="Credits" paise={d.creditPaise} />
        <Stat label="Closing" paise={d.closingPaise} signedDrCr />
      </div>
      <Panel>
        <DataTable
          minWidth="820px"
          rows={d.rows}
          rowKey={(r, i) => `${r.voucher_id}-${i}`}
          columns={columns}
          onRowClick={(r) => navigate(`${base}/vouchers/${r.voucher_id}`)}
          empty="No movement on this ledger in the selected period."
        />
      </Panel>
    </div>
  );
}

function Stat({ label, paise, signedDrCr }: { label: string; paise: number; signedDrCr?: boolean }) {
  return (
    <div className="bg-white border border-neutral-200 rounded p-3">
      <div className="text-11 text-neutral-500">{label}</div>
      <div className="text-14 font-semibold text-neutral-900 mt-0.5">
        {signedDrCr ? <DrCr paise={paise} /> : <Money paise={paise} />}
      </div>
    </div>
  );
}

// ── Cash flow ────────────────────────────────────────────────────────
function CashFlowReport() {
  const { companyId, from, to } = useCtx();
  const q = useQuery({
    queryKey: ['tally.cashFlow', companyId, from, to],
    queryFn: () => bookkeepingAccountingApi.cashFlow(companyId, { from, to }),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const d = q.data!;
  return (
    <div data-testid="tally-cash-flow">
      <BackLink />
      <ReportHeader title="Cash Flow" subtitle={`${from} to ${to} · movement through cash and bank ledgers`} />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4">
        <Stat label="Opening cash + bank" paise={d.opening_paise} />
        <Stat label="Net change" paise={d.net_change_paise} />
        <Stat label="Closing cash + bank" paise={d.closing_paise} />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Panel title="Inflows">
          <ul className="divide-y divide-neutral-100">
            {d.inflows.length === 0 ? <li className="px-3 py-3 text-13 text-neutral-500">None.</li> : null}
            {d.inflows.map((r) => (
              <li key={r.label} className="px-3 py-2 flex justify-between"><span className="text-13 text-neutral-700">{r.label}</span><Money paise={r.amount_paise} /></li>
            ))}
          </ul>
        </Panel>
        <Panel title="Outflows">
          <ul className="divide-y divide-neutral-100">
            {d.outflows.length === 0 ? <li className="px-3 py-3 text-13 text-neutral-500">None.</li> : null}
            {d.outflows.map((r) => (
              <li key={r.label} className="px-3 py-2 flex justify-between"><span className="text-13 text-neutral-700">{r.label}</span><Money paise={r.amount_paise} /></li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

// ── Ratios ───────────────────────────────────────────────────────────
function RatiosReport() {
  const { companyId, from, to } = useCtx();
  const q = useQuery({
    queryKey: ['tally.ratios', companyId, from, to],
    queryFn: () => bookkeepingAccountingApi.ratios(companyId, { from, to }),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const r = q.data!;
  const show = (v: number | null, suffix = '') => (v === null ? <span className="text-neutral-400">n/a</span> : <>{v}{suffix}</>);
  return (
    <div data-testid="tally-ratios">
      <BackLink />
      <ReportHeader title="Ratio Analysis" subtitle={`As at ${to}`} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
        <Stat label="Working capital" paise={r.working_capital_paise} />
        <Stat label="Total assets" paise={r.total_assets_paise} />
        <Stat label="Net profit" paise={r.net_profit_paise} />
      </div>
      <Panel title="Ratios">
        <ul className="divide-y divide-neutral-100 text-13">
          <li className="px-3 py-2 flex justify-between"><span className="text-neutral-700">Current ratio</span><span className="tabular-nums">{show(r.current_ratio)}</span></li>
          <li className="px-3 py-2 flex justify-between"><span className="text-neutral-700">Quick ratio</span><span className="tabular-nums">{show(r.quick_ratio)}</span></li>
          <li className="px-3 py-2 flex justify-between"><span className="text-neutral-700">Debt / equity</span><span className="tabular-nums">{show(r.debt_equity_ratio)}</span></li>
          <li className="px-3 py-2 flex justify-between"><span className="text-neutral-700">Gross profit margin</span><span className="tabular-nums">{show(r.gross_profit_pct, '%')}</span></li>
          <li className="px-3 py-2 flex justify-between"><span className="text-neutral-700">Net profit margin</span><span className="tabular-nums">{show(r.net_profit_pct, '%')}</span></li>
        </ul>
      </Panel>
      <p className="mt-2 text-11 text-neutral-500">A ratio whose denominator is zero is shown as n/a rather than as 0.00.</p>
    </div>
  );
}

/**
 * The Outstandings summary cell. Distinct from the generic Stat helper
 * above because it takes a pre-formatted text value (party counts,
 * "N bills · ₹X" mixed lines) and supports a warning tone for the
 * overdue KPI.
 */
function OutstandingsStat({ label, value, tone }: { label: string; value: string; tone?: 'muted' | 'warn' }) {
  const valueClass =
    tone === 'warn' ? 'text-danger' :
    tone === 'muted' ? 'text-neutral-500' :
    'text-neutral-900';
  return (
    <div>
      <div className="text-11 uppercase tracking-[0.08em] text-neutral-400">{label}</div>
      <div className={`text-15 font-medium tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}
