import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { workstationApi } from '@/modules/workstation/api';
import {
  Card, Cell, PageHeader, QueryState, Row, Status, Table,
} from '@/modules/workstation/components';
import type { DashboardResponse } from '@/modules/workstation/types';
import { fmtDate, fmtTime } from '@/lib/format';

/**
 * THE WORKSTATION DASHBOARD (§7.1).
 *
 * This is the Workstation overview — a screen INSIDE Workstation. It is not
 * the main AUDIT OS dashboard and does not replace it: `/` still renders
 * src/pages/Dashboard.tsx with HRMS · Workstation · Tools, untouched.
 *
 * Every number here is scoped server-side, so a GST executive's "Active
 * Clients" counts their assignments rather than the firm's.
 */
export function WorkstationDashboardPage() {
  const query = useQuery({
    queryKey: ['workstation', 'dashboard'],
    queryFn: workstationApi.dashboard,
  });

  return (
    <div className="m-page">
      <PageHeader
        title="Workstation"
        subtitle="Leads, clients, services, follow-ups and documents for the firm's own clients."
      />
      <QueryState query={query}>
        {(data: DashboardResponse) => <DashboardBody data={data} />}
      </QueryState>
    </div>
  );
}

function DashboardBody({ data }: { data: DashboardResponse }) {
  const navigate = useNavigate();
  const k = data.kpis;

  const kpis: { label: string; value: number; to: string; attention?: boolean }[] = [
    { label: 'Total Leads', value: k.total_leads, to: '/workstation/leads' },
    { label: 'New Leads', value: k.new_leads, to: '/workstation/leads?status=new' },
    { label: 'Active Clients', value: k.active_clients, to: '/workstation/clients?status=active' },
    { label: 'Follow-ups Today', value: k.follow_ups_today, to: '/workstation/follow-ups?range=today' },
    { label: 'Pending Follow-ups', value: k.pending_follow_ups, to: '/workstation/follow-ups?status=pending' },
    { label: 'Overdue Follow-ups', value: k.overdue_follow_ups, to: '/workstation/follow-ups?range=overdue', attention: k.overdue_follow_ups > 0 },
    { label: 'Active Services', value: k.active_services, to: '/workstation/services' },
    { label: 'Pending Documents', value: k.pending_documents, to: '/workstation/documents?status=requested' },
    { label: 'Services Due Soon', value: k.services_due_soon, to: '/workstation/services?due=soon', attention: k.services_due_soon > 0 },
  ];

  const maxStage = Math.max(1, ...data.pipeline.map((p) => p.count));

  return (
    <div className="space-y-6">
      {/* KPI cards — each one navigates to the list it counts, so no figure
          on this page is a dead end. */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-[repeat(5,minmax(0,1fr))] gap-3">
        {kpis.map((kpi) => (
          <Link
            key={kpi.label}
            to={kpi.to}
            className={
              'bg-white border border-neutral-200 rounded p-3 min-h-[44px] hover:bg-neutral-50 transition-colors ' +
              (kpi.attention ? 'border-l-2 border-l-amber' : '')
            }
          >
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{kpi.label}</div>
            <div className="text-20 font-semibold text-neutral-900 mt-1 tabular-nums">{kpi.value}</div>
          </Link>
        ))}
      </div>

      {/* Lead pipeline (§7.1). A stage with zero leads still renders — a
          pipeline missing a stage reads as a bug rather than as emptiness. */}
      <Card title="Lead pipeline">
        <div className="p-4 space-y-2">
          {data.pipeline.map((stage) => (
            <Link
              key={stage.status}
              to={`/workstation/leads?status=${stage.status}`}
              className={
                'hover:bg-neutral-50 ' +
                // Phone: label + count on one line, bar beneath, 44px tall.
                'flex flex-col justify-center gap-1 min-h-[44px] py-1 ' +
                // Desktop: the original single 32px row, unchanged.
                'md:flex-row md:items-center md:gap-3 md:h-8 md:min-h-0 md:py-0'
              }
            >
              <span className="flex items-baseline gap-2 md:contents">
                <span className="text-13 text-neutral-700 flex-1 min-w-0 md:w-[200px] md:flex-none md:shrink-0">
                  {stage.label}
                </span>
                <span className="text-13 font-medium text-neutral-900 tabular-nums shrink-0 md:w-8">
                  {stage.count}
                </span>
              </span>
              {/* A bar, not a chart: one measure, no axis needed. */}
              <span className="block w-full md:flex-1 h-2 bg-neutral-100 rounded overflow-hidden">
                <span
                  className="block h-full bg-neutral-400"
                  style={{ width: `${Math.round((stage.count / maxStage) * 100)}%` }}
                />
              </span>
            </Link>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Today's follow-ups (§7.1) */}
        <Card
          title="Today's follow-ups"
          right={
            <Link to="/workstation/follow-ups?range=today" className="inline-flex items-center min-h-[44px] md:min-h-0 px-2 -mr-2 text-12 text-neutral-500 hover:text-neutral-900">
              View all
            </Link>
          }
        >
          {data.todays_follow_ups.length === 0 ? (
            <div className="px-4 py-6 text-13 text-neutral-500">Nothing scheduled for today.</div>
          ) : (
            <Table head={['Lead / Client', 'Service', 'Time', 'Assigned To', 'Status']}>
              {data.todays_follow_ups.map((f) => (
                <Row
                  key={f.id}
                  status={f.status}
                  onClick={() =>
                    navigate(
                      f.subject_type === 'lead'
                        ? `/workstation/leads/${f.lead_id}`
                        : `/workstation/clients/${f.client_id}`,
                    )
                  }
                >
                  <Cell>
                    <span className="font-medium">{f.subject_name}</span>
                    <span className="block text-12 text-neutral-500">{f.title}</span>
                  </Cell>
                  <Cell muted>{f.service_name ?? '—'}</Cell>
                  <Cell>{fmtTime(f.scheduled_at)}</Cell>
                  <Cell muted>{f.assigned_employee?.full_name ?? '—'}</Cell>
                  <Cell><Status value={f.status} /></Cell>
                </Row>
              ))}
            </Table>
          )}
        </Card>

        {/* Client summary (§7.1) */}
        <Card
          title="Client summary"
          right={
            <Link to="/workstation/clients" className="inline-flex items-center min-h-[44px] md:min-h-0 px-2 -mr-2 text-12 text-neutral-500 hover:text-neutral-900">
              View all
            </Link>
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 p-4 border-b border-neutral-200">
            <Summary label="New" value={data.client_summary.new_clients} />
            <Summary label="Active" value={data.client_summary.active_clients} />
            <Summary label="Pending documents" value={data.client_summary.pending_documents} />
            <Summary label="Services due" value={data.client_summary.services_due} />
            <Summary label="Need follow-up" value={data.client_summary.requiring_follow_up} />
          </div>
          <Table head={['Client ID', 'Company', 'Status', 'Docs']}>
            {data.client_summary.items.map((c) => (
              <Row
                key={c.id}
                status={c.status}
                onClick={() => navigate(`/workstation/clients/${c.id}`)}
              >
                <Cell muted>{c.client_id}</Cell>
                <Cell>{c.company_name}</Cell>
                <Cell><Status value={c.status} /></Cell>
                <Cell muted>{c.pending_document_count > 0 ? `${c.pending_document_count} pending` : '—'}</Cell>
              </Row>
            ))}
          </Table>
        </Card>
      </div>

      <p className="text-12 text-neutral-500">
        Showing {data.scope === 'organisation' ? 'all firm records' : 'records assigned to you'} · {fmtDate(new Date())}
      </p>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className="text-16 font-medium text-neutral-900 mt-1 tabular-nums">{value}</div>
    </div>
  );
}
