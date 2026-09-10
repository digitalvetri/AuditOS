import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { bookkeepingApi } from '@/modules/bookkeeping/api';
import { Card, Cell, PageHeader, QueryState, Row, Status, Table } from '@/modules/workstation/components';
import type { Kpis } from '@/modules/bookkeeping/types';
import { fmtDate } from '@/lib/format';

/**
 * Every tile here is a database aggregate returned by /api/bookkeeping/overview.
 * Nothing on this page is a literal.
 */
const TILES: { key: keyof Kpis; label: string }[] = [
  { key: 'total_clients', label: 'Total Clients' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'pending_items', label: 'Pending Items' },
  { key: 'due_this_month', label: 'Due This Month' },
  { key: 'completed_this_month', label: 'Completed This Month' },
  { key: 'overdue_tasks', label: 'Overdue Tasks' },
  { key: 'awaiting_documents', label: 'Awaiting Documents' },
  { key: 'awaiting_bank_statements', label: 'Awaiting Bank Statements' },
  { key: 'pending_review', label: 'Pending Review' },
];

export function BookkeepingOverviewPage() {
  const navigate = useNavigate();
  const overview = useQuery({ queryKey: ['bookkeeping', 'overview'], queryFn: bookkeepingApi.overview });

  return (
    <div>
      <PageHeader
        title="Bookkeeping Service"
        subtitle="Manage bookkeeping services for your clients"
      />
      <QueryState query={overview}>
        {(data) => (
          <div className="space-y-4">
            <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
              {TILES.map((t) => (
                <div key={t.key} className="bg-white border border-neutral-200 rounded px-4 py-3">
                  <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{t.label}</div>
                  <div className="text-24 font-semibold text-neutral-900 mt-1 tabular-nums">
                    {data.kpis[t.key]}
                  </div>
                </div>
              ))}
            </div>

            <Card title="Open periods — most urgent first">
              {data.upcoming.length === 0 ? (
                <div className="px-4 py-6 text-13 text-neutral-500">
                  No open bookkeeping periods. Open one from a client to start the month.
                </div>
              ) : (
                <Table head={['Client', 'Period', 'Status', 'Progress', 'Due', 'Assigned to']}>
                  {data.upcoming.map((p) => (
                    <Row key={p.id} status={p.status} onClick={() => navigate(`../monthly-work/${p.id}`)}>
                      <Cell>{p.client_name ?? '—'}</Cell>
                      <Cell>{p.label}</Cell>
                      <Cell><Status value={p.status} /></Cell>
                      <Cell muted>
                        {p.progress ? `${p.progress.completed}/${p.progress.total} · ${p.progress.percent}%` : '—'}
                      </Cell>
                      <Cell muted>{p.due_date ? fmtDate(p.due_date) : '—'}</Cell>
                      <Cell muted>{p.assigned_employee?.full_name ?? '—'}</Cell>
                    </Row>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        )}
      </QueryState>
    </div>
  );
}
