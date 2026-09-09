import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { booksApi } from '@/modules/books/api';
import { Cell, Money, Row, Section, Table, Tile, useBooks, Empty } from '@/modules/books/components';
import { moneyShort, money, VOUCHER_LABEL } from '@/modules/books/format';
import { StatusLabel } from '@/components/StatusRow';
import { journalStatus } from '@/modules/books/format';
import { fmtDate } from '@/lib/format';

/** /books/:orgId — receivables, payables, cash, this month, recent activity. */
export function BooksOverviewPage() {
  const { orgId, org } = useBooks();
  const q = useQuery({ queryKey: ['books', orgId, 'dashboard'], queryFn: () => booksApi.org(orgId).dashboard() });
  if (q.isLoading) return <div className="h-40 bg-neutral-100 rounded" />;
  if (q.isError) return <Section><Empty>Could not load the overview. {(q.error as Error).message}</Empty></Section>;
  const d = q.data!;

  return (
    <div className="space-y-4" data-testid="books-overview">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <Tile label="Receivables" value={moneyShort(d.receivables.total, org.base_currency)} hint={<>{d.receivables.count} open invoice{d.receivables.count === 1 ? '' : 's'}{d.receivables.overdue > 0 ? <span className="text-red"> · {money(d.receivables.overdue, org.base_currency)} overdue</span> : null}</>} />
        <Tile label="Payables" value={moneyShort(d.payables.total, org.base_currency)} hint={`${d.payables.count} open bill${d.payables.count === 1 ? '' : 's'}`} />
        <Tile label="Cash & bank" value={moneyShort(d.cash.reduce((t, a) => t + a.balance, 0), org.base_currency)} hint={`${d.cash.length} account${d.cash.length === 1 ? '' : 's'}`} />
        <Tile label="This month" value={moneyShort(d.month.net, org.base_currency)} hint={`Income ${money(d.month.income, org.base_currency)} · Expense ${money(d.month.expense, org.base_currency)}`} tone={d.month.net < 0 ? 'warn' : 'good'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="Cash and bank accounts" right={<Link to={`/books/${orgId}/banking`} className="text-12 text-gold hover:text-gold-hover">Banking →</Link>}>
          {d.cash.length === 0 ? <Empty>No bank or cash accounts yet.</Empty> : (
            <Table head={['Account', { label: 'Balance', align: 'right' }]} minWidth={320}>
              {d.cash.map((a) => (
                <Row key={a.id}>
                  <Cell>{a.name}</Cell>
                  <Cell right><Money value={a.balance} currency={org.base_currency} zero="0" /></Cell>
                </Row>
              ))}
            </Table>
          )}
        </Section>

        <Section title="Recent postings" right={<Link to={`/books/${orgId}/journals`} className="text-12 text-gold hover:text-gold-hover">All journals →</Link>}>
          {d.recent.length === 0 ? <Empty>Nothing posted yet.</Empty> : (
            <Table head={['Date', 'Voucher', 'Narration', { label: 'Amount', align: 'right' }, 'Status']} minWidth={520}>
              {d.recent.map((j) => (
                <Row key={j.id} border={j.status === 'void' ? 'red' : null} muted={j.status === 'void'}>
                  <Cell muted className="whitespace-nowrap tabular-nums">{fmtDate(`${j.date}T00:00:00Z`)}</Cell>
                  <Cell className="whitespace-nowrap">{j.number}<span className="text-neutral-500"> · {VOUCHER_LABEL[j.voucher_type] ?? j.voucher_type}</span></Cell>
                  <Cell muted className="max-w-[240px] truncate">{j.narration ?? '—'}</Cell>
                  <Cell right><Money value={j.total_debit} currency={org.base_currency} zero="0" /></Cell>
                  <Cell><StatusLabel {...journalStatus(j.status)} /></Cell>
                </Row>
              ))}
            </Table>
          )}
        </Section>
      </div>
    </div>
  );
}
