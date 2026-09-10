import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { incorporationApi } from '@/modules/incorporation/api';
import { Card, Cell, PageHeader, QueryState, Table } from '@/modules/workstation/components';
import { IncStatus, ProgressBar, incStatusBorder } from '@/modules/incorporation/components';
import type { Kpis } from '@/modules/incorporation/types';
import { fmtDate } from '@/lib/format';

/**
 * Every tile is a database aggregate returned by /api/incorporation/overview,
 * and every tile is a link: clicking one opens Cases already filtered to the
 * rows it counted, so a number is never a dead end. Nothing on this page is
 * a literal.
 */
const TILES: { key: keyof Kpis; label: string; filter: Record<string, string> }[] = [
  { key: 'active_cases', label: 'Active Cases', filter: { status: 'active' } },
  { key: 'new_cases', label: 'New Cases', filter: { stage: 'new' } },
  { key: 'documents_pending', label: 'Documents Pending', filter: { stage: 'documents_pending' } },
  { key: 'dsc_pending', label: 'DSC Pending', filter: { stage: 'dsc_pending' } },
  { key: 'name_pending', label: 'Name Pending', filter: { stage: 'name_submitted' } },
  { key: 'filing_pending', label: 'Filing Pending', filter: { stage: 'filing_preparation' } },
  { key: 'government_queries', label: 'Government Queries', filter: { stage: 'government_query' } },
  { key: 'resubmission_required', label: 'Resubmission Required', filter: { stage: 'resubmission' } },
  { key: 'approval_pending', label: 'Approval Pending', filter: { stage: 'government_processing' } },
  { key: 'overdue_tasks', label: 'Overdue Tasks', filter: { overdue: 'true' } },
  { key: 'completed_this_month', label: 'Completed This Month', filter: { status: 'completed' } },
];

export function IncorporationOverviewPage() {
  const navigate = useNavigate();
  const overview = useQuery({ queryKey: ['incorporation', 'overview'], queryFn: incorporationApi.overview });

  return (
    <div>
      <PageHeader
        title="Incorporation Service"
        subtitle="Company, LLP and firm formation cases — every government detail recorded by an employee"
      />
      <QueryState query={overview}>
        {(data) => (
          <div className="space-y-4">
            <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
              {TILES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => {
                    const sp = new URLSearchParams(t.filter);
                    navigate(`cases?${sp.toString()}`);
                  }}
                  className="text-left bg-white border border-neutral-200 rounded px-4 py-3 hover:border-neutral-400 focus:outline-none focus:border-gold"
                >
                  <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{t.label}</div>
                  <div className="text-24 font-semibold text-neutral-900 mt-1 tabular-nums">
                    {data.kpis[t.key]}
                  </div>
                </button>
              ))}
            </div>

            <Card title="Active cases — nearest target date first">
              {data.active.length === 0 ? (
                <div className="px-4 py-6 text-13 text-neutral-500">
                  No active incorporation cases. Open one from Cases → New Case.
                </div>
              ) : (
                <Table head={['Case ID', 'Client', 'Entity Type', 'Proposed Name', 'Stage', 'Progress', 'Target', 'Assigned']}>
                  {data.active.map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => navigate(`cases/${c.id}`)}
                      className={`h-10 border-b border-neutral-200 cursor-pointer hover:bg-neutral-50 ${incStatusBorder(c.stage)}`}
                    >
                      <Cell className="font-mono text-12">{c.case_code}</Cell>
                      <Cell>{c.client_name ?? '—'}</Cell>
                      <Cell muted>{c.entity_type_name ?? '—'}</Cell>
                      <Cell>{c.proposed_name}</Cell>
                      <Cell><IncStatus value={c.stage} /></Cell>
                      <Cell muted>
                        <div className="w-[90px]">
                          <div className="tabular-nums text-12">
                            {c.progress ? `${c.progress.completed}/${c.progress.total}` : '—'}
                          </div>
                          {c.progress ? <ProgressBar percent={c.progress.percent} className="mt-1" /> : null}
                        </div>
                      </Cell>
                      <Cell muted>{c.target_date ? fmtDate(c.target_date) : '—'}</Cell>
                      <Cell muted>{c.assigned_employee?.full_name ?? '—'}</Cell>
                    </tr>
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
