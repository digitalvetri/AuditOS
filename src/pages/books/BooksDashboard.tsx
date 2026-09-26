import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { booksApi, errorText, type ZRecord } from '@/modules/books/api';
import { useOrg } from '@/modules/books/context';
import { Badge, Cell, Empty, ErrorState, Notice, Row, Section, Skeleton, Table, Tile, date, dateTime, money } from '@/modules/books/ui';

/**
 * Books dashboard. Every number comes from the last sync's snapshot, which
 * the server computed from Zoho Books records — nothing is estimated here.
 */
export function BooksDashboardPage() {
  const org = useOrg();
  const q = useQuery({ queryKey: ['books', org.id, 'dashboard'], queryFn: () => booksApi.org(org.id).dashboard(), staleTime: 60_000 });
  if (q.isLoading) return <Skeleton rows={8} />;
  if (q.isError) return <Section><ErrorState error={errorText(q.error)} onRetry={() => q.refetch()} /></Section>;
  const d = q.data!;
  const s = d.snapshot;
  if (!s) return <Section><Empty title="No data yet">Run “Sync now” to load this organisation’s figures from Zoho Books.</Empty></Section>;
  const cur = s.currency_code ?? org.currency_code;
  const m = (v: unknown) => money(v, cur);
  const t = s.totals;

  return (
    <div className="space-y-4">
      {d.sync_status === 'failed' && d.last_sync_error ? <Notice tone="error">The last sync failed — showing figures from {dateTime(d.last_sync_at)}. {d.last_sync_error}</Notice> : null}
      {s.truncated ? <Notice tone="warn">This organisation has more records than one sync reads; totals cover the most recent 1,000 documents per list.</Notice> : null}
      {s.mixed_currency ? <Notice tone="warn">Some documents are in a foreign currency; totals add their amounts as recorded, without conversion.</Notice> : null}

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
        <Tile label="Total receivables" value={m(t.receivables)} hint={`${s.counts.outstanding_invoices} outstanding invoices`} />
        <Tile label="Total payables" value={m(t.payables)} hint={`${s.counts.outstanding_bills} outstanding bills`} />
        <Tile label="Overdue invoices" value={m(t.overdue_receivables)} hint={`${s.counts.overdue_invoices} invoices`} tone={s.counts.overdue_invoices ? 'warn' : 'default'} />
        <Tile label="Overdue bills" value={m(t.overdue_payables)} hint={`${s.counts.overdue_bills} bills`} tone={s.counts.overdue_bills ? 'warn' : 'default'} />
        <Tile label="Revenue" value={m(t.revenue)} hint={`Invoiced since ${date(s.period.from)}`} />
        <Tile label="Expenses" value={m(t.expenses)} hint="Bills + expenses, same period" />
        <Tile label="Payments received" value={m(t.payments_received)} hint="Same period" />
        <Tile label="Payments made" value={m(t.payments_made)} hint="Same period" />
        {s.bank_accounts.length ? <Tile label="Bank balance" value={m(t.bank_balance)} hint={`${s.bank_accounts.length} accounts in Zoho`} /> : null}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Section title="Revenue vs expenses — last 6 months" className="xl:col-span-2">
          <div className="h-64 px-2 py-3" role="img" aria-label="Monthly revenue and expenses">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={s.monthly.map((x) => ({ ...x, label: new Date(`${x.month}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short' }) }))} margin={{ left: 8, right: 8 }}>
                <CartesianGrid vertical={false} stroke="rgb(var(--c-border))" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: 'rgb(var(--c-inkMuted))' }} />
                <YAxis tickLine={false} axisLine={false} width={70} tick={{ fontSize: 11, fill: 'rgb(var(--c-inkMuted))' }} tickFormatter={(v: number) => new Intl.NumberFormat('en-IN', { notation: 'compact' }).format(v)} />
                <Tooltip formatter={(v: number) => m(v)} contentStyle={{ fontSize: 12, background: 'rgb(var(--c-surface))', border: '1px solid rgb(var(--c-border))' }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="revenue" name="Revenue" fill="rgb(var(--c-primary))" radius={[3, 3, 0, 0]} />
                <Bar dataKey="expenses" name="Expenses" fill="rgb(var(--c-gold))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
        <div className="space-y-4">
          <Ageing title="Receivables ageing" rows={s.receivables_ageing} m={m} />
          <Ageing title="Payables ageing" rows={s.payables_ageing} m={m} />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Recent title="Recent invoices" to="/books/sales/invoices" rows={s.recent.invoices} cols={['invoice_number', 'customer_name', 'date']} amount="total" status m={m} />
        <Recent title="Recent bills" to="/books/purchases/bills" rows={s.recent.bills} cols={['bill_number', 'vendor_name', 'date']} amount="total" status m={m} />
        <Recent title="Recent payments received" to="/books/payments" rows={s.recent.payments} cols={['payment_number', 'customer_name', 'date']} amount="amount" m={m} />
        <Recent title="Recent expenses" to="/books/expenses" rows={s.recent.expenses} cols={['account_name', 'vendor_name', 'date']} amount="amount_total" m={m} />
      </div>
      {s.bank_accounts.length ? (
        <Section title="Bank accounts">
          <Table cols={[{ label: 'Account' }, { label: 'Type' }, { label: 'Balance', right: true }]} minWidth={480}>
            {s.bank_accounts.map((b) => <Row key={b.account_id}><Cell>{b.account_name}</Cell><Cell muted className="capitalize">{String(b.account_type ?? '').replace(/_/g, ' ')}</Cell><Cell right>{money(b.balance, b.currency_code ?? cur)}</Cell></Row>)}
          </Table>
        </Section>
      ) : null}
      <p className="text-12 text-inkFaint">Figures computed by Audit OS from Zoho Books records as of {date(s.as_of)}.</p>
    </div>
  );
}

function Ageing({ title, rows, m }: { title: string; rows: { label: string; amount: number; count: number }[]; m: (v: unknown) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.amount));
  return (
    <Section title={title}>
      <div className="px-4 py-3 space-y-2">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="flex justify-between text-12"><span className="text-inkMuted">{r.label} · {r.count}</span><span className="tabular-nums text-ink">{m(r.amount)}</span></div>
            <div className="h-1.5 bg-canvas rounded mt-1"><div className={`h-1.5 rounded ${r.label === 'Current' ? 'bg-primary' : 'bg-danger'}`} style={{ width: `${(r.amount / max) * 100}%` }} /></div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Recent({ title, to, rows, cols, amount, status, m }: { title: string; to: string; rows: ZRecord[]; cols: string[]; amount: string; status?: boolean; m: (v: unknown) => string }) {
  return (
    <Section title={title} right={<Link to={to} className="text-12 text-inkMuted hover:text-ink">View all</Link>}>
      {rows.length === 0 ? <Empty title="Nothing yet." /> : (
        <Table cols={[{ label: 'Number' }, { label: 'Name' }, { label: 'Date' }, ...(status ? [{ label: 'Status' }] : []), { label: 'Amount', right: true }]} minWidth={520}>
          {rows.map((r, i) => (
            <Row key={i}>
              <Cell className="font-medium">{r[cols[0]] ?? '—'}</Cell>
              <Cell muted>{r[cols[1]] ?? '—'}</Cell>
              <Cell muted>{date(r[cols[2]])}</Cell>
              {status ? <Cell><Badge status={r.status} /></Cell> : null}
              <Cell right>{m(r[amount])}</Cell>
            </Row>
          ))}
        </Table>
      )}
    </Section>
  );
}
