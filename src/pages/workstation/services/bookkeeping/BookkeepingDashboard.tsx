import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { tallyAccountingApi, type DashboardTile } from '@/modules/tools/audit-automation/tally';
import { Money, Panel, Loading, usePeriod, DataTable, type Column, ErrorNote } from '@/modules/tools/tally/ui';
import type { DayBookRow, Outstandings } from '@/modules/tools/audit-automation/tally';

/**
 * /tally/companies/:companyId — the dashboard.
 *
 * Every tile is computed server-side from posted vouchers and links to
 * the report it came from. Nothing on this screen is a placeholder or a
 * sample figure; an empty company shows zeros, honestly.
 */
export function BookkeepingDashboard() {
  const { companyId = '' } = useParams();
  const { from, to } = usePeriod();
  const base = `/tally/companies/${companyId}`;

  const q = useQuery({
    queryKey: ['tally.dashboard', companyId, from, to],
    enabled: Boolean(companyId),
    queryFn: () => tallyAccountingApi.dashboard(companyId, { from, to }),
  });

  if (q.isLoading) return <Loading label="Computing from the posted vouchers…" />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const d = q.data!;

  const drillTo = (tile: DashboardTile): string => {
    const [kind, arg] = tile.drill.split(':');
    if (kind === 'register') return `${base}/reports/register/${arg}`;
    if (kind === 'outstanding') return `${base}/reports/outstandings?side=${arg}`;
    if (kind === 'book') return `${base}/reports/book/${arg}`;
    if (kind === 'inventory') return `${base}/inventory`;
    if (kind === 'gst') return `${base}/gst`;
    if (kind === 'report' && arg === 'pl') return `${base}/reports/profit-and-loss`;
    return `${base}/reports`;
  };

  return (
    <div data-testid="tally-dashboard">
      <div className="flex items-baseline justify-between gap-3 mb-3 flex-wrap">
        <h2 className="text-16 font-semibold text-neutral-900">Dashboard</h2>
        <p className="text-12 text-neutral-500">
          {d.period.financial_year_label ? `FY ${d.period.financial_year_label} · ` : ''}
          {d.period.from} to {d.period.to} · {d.voucher_count} voucher{d.voucher_count === 1 ? '' : 's'}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 mb-4">
        {d.tiles.map((t) => (
          <Link
            key={t.key}
            to={drillTo(t)}
            className="bg-white border border-neutral-200 rounded p-3 hover:border-gold transition-colors"
            data-testid={`tally-tile-${t.key}`}
          >
            <div className="text-11 text-neutral-500">{t.label}</div>
            <div className="text-16 font-semibold text-neutral-900 mt-1">
              <Money paise={t.amount_paise} signed />
            </div>
          </Link>
        ))}
      </div>

      {d.alerts.length ? (
        <Panel title="Exceptions" className="mb-4">
          <ul className="divide-y divide-neutral-100">
            {d.alerts.map((a) => (
              <li key={a.key} className="px-3 py-2 flex items-start gap-2">
                <AlertTriangle
                  size={14}
                  strokeWidth={1.75}
                  className={`mt-0.5 flex-shrink-0 ${a.severity === 'critical' || a.severity === 'high' ? 'text-danger' : 'text-amber-600'}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-13 text-neutral-900">{a.label} <span className="text-neutral-500">({a.count})</span></div>
                  <div className="text-12 text-neutral-500">{a.detail}</div>
                </div>
                <Link to={`${base}/audit`} className="text-12 text-gold hover:underline whitespace-nowrap">Review</Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        <Panel
          title="Recent vouchers"
          actions={<Link to={`${base}/reports/day-book`} className="text-12 text-gold hover:underline inline-flex items-center gap-1">Day book <ArrowRight size={12} /></Link>}
        >
          <DataTable<DayBookRow>
            minWidth="520px"
            rows={d.recent_vouchers}
            rowKey={(r) => r.voucher_id}
            columns={recentColumns(base)}
            empty="No vouchers posted in this period yet."
          />
        </Panel>

        <Panel title="Profit & loss">
          <div className="p-3 space-y-2 text-13">
            <Row label="Income" value={d.profit_and_loss.income_paise} />
            <Row label="Expenses" value={d.profit_and_loss.expense_paise} />
            <Row label="Gross profit" value={d.profit_and_loss.gross_profit_paise} />
            <div className="border-t border-neutral-100 pt-2">
              <Row label={d.profit_and_loss.net_profit_paise >= 0 ? 'Net profit' : 'Net loss'} value={d.profit_and_loss.net_profit_paise} bold />
            </div>
            <div className="pt-1">
              <Link to={`${base}/reports/profit-and-loss`} className="text-12 text-gold hover:underline">Open the P&amp;L →</Link>
            </div>
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <OutstandingPanel title="Top receivables" parties={d.top_receivables} ageing={d.receivable_ageing} to={`${base}/reports/outstandings?side=receivable`} base={base} />
        <OutstandingPanel title="Top payables" parties={d.top_payables} ageing={d.payable_ageing} to={`${base}/reports/outstandings?side=payable`} base={base} />
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={bold ? 'font-medium text-neutral-900' : 'text-neutral-600'}>{label}</span>
      <Money paise={value} signed bold={bold} />
    </div>
  );
}

function recentColumns(base: string): Column<DayBookRow>[] {
  return [
    { key: 'date', label: 'Date', value: (r) => r.date, render: (r) => <span className="tabular-nums text-neutral-600">{r.date}</span> },
    {
      key: 'voucher', label: 'Voucher', value: (r) => r.voucher_number,
      render: (r) => (
        <Link to={`${base}/vouchers/${r.voucher_id}`} className="text-neutral-900 hover:text-gold">
          {r.voucher_type_name} {r.voucher_number}
        </Link>
      ),
    },
    { key: 'party', label: 'Particulars', value: (r) => r.party_name ?? r.ledgers.join(' / '), render: (r) => <span className="text-neutral-600 truncate">{r.party_name ?? r.ledgers.join(' / ')}</span> },
    { key: 'amount', label: 'Amount', align: 'right', value: (r) => r.debit_paise / 100, render: (r) => <Money paise={r.debit_paise} /> },
  ];
}

function OutstandingPanel({ title, parties, ageing, to, base }: {
  title: string; parties: Outstandings['parties']; ageing: { key: string; label: string; amount_paise: number }[]; to: string; base: string;
}) {
  return (
    <Panel title={title} actions={<Link to={to} className="text-12 text-gold hover:underline">All →</Link>}>
      {parties.length === 0 ? (
        <div className="px-3 py-4 text-13 text-neutral-500">Nothing outstanding.</div>
      ) : (
        <ul className="divide-y divide-neutral-100">
          {parties.map((p) => (
            <li key={p.ledger_id} className="px-3 py-2 flex items-center justify-between gap-3">
              <Link to={`${base}/reports/ledger/${p.ledger_id}`} className="text-13 text-neutral-900 hover:text-gold truncate">{p.ledger_name}</Link>
              <Money paise={p.total_paise} />
            </li>
          ))}
        </ul>
      )}
      <div className="px-3 py-2 border-t border-neutral-100 flex flex-wrap gap-x-4 gap-y-1">
        {ageing.filter((a) => a.amount_paise !== 0).map((a) => (
          <span key={a.key} className="text-11 text-neutral-500">
            {a.label}: <span className="text-neutral-900 tabular-nums">₹{(Math.abs(a.amount_paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </span>
        ))}
      </div>
    </Panel>
  );
}
