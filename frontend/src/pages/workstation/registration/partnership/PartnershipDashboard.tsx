import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import {  } from '@/modules/partnership/api';
import { Plus } from 'lucide-react';
import { Card, Cell, PageHeader, QueryState, Row, Status, Table } from '@/modules/workstation/components';
import { ListAction } from '@/modules/workstation/listUi';
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
        action={<ListAction to={`${base}/clients?add=1`} icon={<Plus size={15} />}>Add Client</ListAction>}
      />
      <QueryState query={overview}>
        {(o) => (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-5">
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
                className="bg-white border border-neutral-200 rounded-lg px-4 py-3 hover:border-primary/40 hover:shadow-raised transition-all"
              >
                <div className="text-12 text-neutral-500">{label}</div>
                <div className={`text-[24px] leading-tight font-semibold mt-1 tabular-nums ${label === 'Overdue' && Number(value) > 0 ? 'text-red' : 'text-neutral-900'}`}>{value}</div>
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
