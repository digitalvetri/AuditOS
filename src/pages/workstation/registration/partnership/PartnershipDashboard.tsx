import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {  } from '@/modules/partnership/api';
import { Card, Cell, PageHeader, QueryState, Row, Status, Table } from '@/modules/workstation/components';
import { fmtDateTime } from '@/lib/format';
import { DueChip, ProgressBar, useSvc } from './shared';

/** Service dashboard: database counts, then the cases needing attention. */
export function PartnershipDashboard() {
  const { api: regApi, keys: regKeys, base, label } = useSvc();
  const navigate = useNavigate();
  const overview = useQuery({ queryKey: regKeys.overview, queryFn: regApi.overview });
  const active = useQuery({
    queryKey: regKeys.cases({ sort: 'due', dir: 'asc' }),
    queryFn: () => regApi.listCases({ sort: 'due', dir: 'asc' }),
  });

  return (
    <>
      <PageHeader
        title={label}
        subtitle="Deed drafting and registration with the Registrar of Firms, case by case."
        action={<Link to={`${base}/clients?add=1`} className="h-8 px-3 inline-flex items-center text-13 bg-neutral-900 text-white rounded hover:bg-neutral-800">+ Add Client</Link>}
      />
      <QueryState query={overview}>
        {(o) => (
          <div className="grid grid-cols-2 md:grid-cols-6 gap-2 mb-4">
            {[
              ['Total Clients', o.total_clients, ''],
              ['In Progress', o.in_progress, 'status=IN_PROGRESS'],
              ['Documents Pending', o.documents_pending, 'doc_status=pending'],
              ['Checklist Items Pending', o.checklist_items_pending, ''],
              ['Completed', o.completed, 'status=COMPLETED'],
              ['Overdue', o.overdue, 'due=overdue'],
            ].map(([label, value, filter]) => (
              <Link
                key={label as string}
                to={`${base}/clients${filter ? `?${filter}` : ''}`}
                className="bg-white border border-neutral-200 rounded px-3 py-2 hover:border-neutral-400"
              >
                <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
                <div className={`text-20 font-semibold tabular-nums ${label === 'Overdue' && Number(value) > 0 ? 'text-red' : 'text-neutral-900'}`}>{value}</div>
              </Link>
            ))}
          </div>
        )}
      </QueryState>

      <Card title="Client progress">
        <QueryState
          query={active}
          empty={
            <span>
              No {label} clients yet.{' '}
              <Link className="underline" to={`${base}/clients?add=1`}>+ Add Client</Link>
            </span>
          }
        >
          {(d) => (
            <Table head={['Client', 'Status', 'Checklist', 'Documents', 'Pending Items', 'Assigned', 'Due', 'Last Activity']}>
              {d.items.map((c) => (
                <Row key={c.id} status={c.status.toLowerCase()} onClick={() => navigate(`${base}/clients/${c.id}`)}>
                  <Cell>
                    <div className="font-medium">{c.client.name}</div>
                    <div className="text-12 text-neutral-500">{c.case_code}</div>
                  </Cell>
                  <Cell><Status value={c.status.toLowerCase()} /></Cell>
                  <Cell><ProgressBar pct={c.progress.pct} /></Cell>
                  <Cell className="tabular-nums">{c.progress.docs_verified} / {c.progress.docs_required} verified</Cell>
                  <Cell className="tabular-nums">{c.progress.items_pending}</Cell>
                  <Cell muted>{c.assigned?.full_name ?? '—'}</Cell>
                  <Cell><DueChip date={c.due_date} state={c.due_state} /></Cell>
                  <Cell muted>{c.last_activity_at ? fmtDateTime(c.last_activity_at) : '—'}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>
    </>
  );
}
