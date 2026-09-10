import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { bookkeepingApi } from '@/modules/bookkeeping/api';
import { human, opts } from '@/modules/bookkeeping/format';
import {
  Card, Cell, FilterBar, PageHeader, QueryState, Row, Select, Status, Table,
} from '@/modules/workstation/components';
import { fmtDate } from '@/lib/format';

/** Every monthly period the caller can see (§11). */
export function BookkeepingMonthlyWorkPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const status = params.get('status') ?? '';

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };

  const periods = useQuery({
    queryKey: ['bookkeeping', 'periods', { status }],
    queryFn: () => bookkeepingApi.listPeriods({ status }),
  });
  const settings = useQuery({ queryKey: ['bookkeeping', 'settings'], queryFn: bookkeepingApi.settings });

  return (
    <div>
      <PageHeader title="Monthly Work" subtitle="One row per client, per month." />
      <FilterBar>
        <Select
          label="Status" value={status} onChange={(v) => setParam('status', v)}
          options={opts(settings.data?.period_statuses)}
        />
      </FilterBar>
      <Card>
        <QueryState query={periods}>
          {(data) => data.items.length === 0 ? (
            <div className="px-4 py-6 text-13 text-neutral-500">No periods match these filters.</div>
          ) : (
            <Table head={['Client', 'Period', 'Status', 'Progress', 'Due', 'Assigned to']}>
              {data.items.map((p) => (
                <Row key={p.id} status={p.status} onClick={() => navigate(p.id)}>
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
        </QueryState>
      </Card>
    </div>
  );
}

/**
 * One month of work: the checklist, its tasks, what is still being chased,
 * and the deliverables. Checklist state is persisted on every click — it is
 * never held in React alone.
 */
export function BookkeepingPeriodDetailPage() {
  const { periodId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const detail = useQuery({
    queryKey: ['bookkeeping', 'period', periodId],
    queryFn: () => bookkeepingApi.period(periodId),
  });
  const settings = useQuery({ queryKey: ['bookkeeping', 'settings'], queryFn: bookkeepingApi.settings });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['bookkeeping', 'period', periodId] });
    void qc.invalidateQueries({ queryKey: ['bookkeeping', 'overview'] });
  };

  const setChecklist = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      bookkeepingApi.updateChecklistItem(id, { status }),
    onSuccess: invalidate,
  });
  const setPeriodStatus = useMutation({
    mutationFn: (status: string) => bookkeepingApi.updatePeriod(periodId, { status }),
    onSuccess: invalidate,
  });
  const setTaskStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      bookkeepingApi.updateTask(id, { status }),
    onSuccess: invalidate,
  });

  return (
    <QueryState query={detail}>
      {(data) => (
        <div className="space-y-4">
          <PageHeader
            title={`${data.period.client_name ?? 'Client'} · ${data.period.label}`}
            subtitle={
              <span>
                {data.period.progress
                  ? `${data.period.progress.completed} of ${data.period.progress.total} tasks done · ${data.period.progress.percent}%`
                  : 'No tasks yet'}
                {data.period.due_date ? ` · due ${fmtDate(data.period.due_date)}` : ''}
              </span>
            }
            action={
              <div className="flex items-center gap-2">
                <Select
                  label="" value={data.period.status}
                  onChange={(v) => v && setPeriodStatus.mutate(v)}
                  options={opts(settings.data?.period_statuses)}
                  allLabel="Set status…"
                />
                {data.period.client_id ? (
                  <button
                    onClick={() => navigate(`../../clients/${data.period.client_id}`)}
                    className="h-8 px-3 text-13 border border-neutral-300 rounded hover:bg-neutral-50"
                  >
                    Client
                  </button>
                ) : null}
              </div>
            }
          />

          {data.period.progress ? (
            <div className="h-1.5 bg-neutral-200 rounded overflow-hidden">
              <div className="h-full bg-gold" style={{ width: `${data.period.progress.percent}%` }} />
            </div>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Monthly checklist">
              <ul className="divide-y divide-neutral-200">
                {data.checklist.map((c) => (
                  <li key={c.id} className="px-4 py-2 flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={c.status === 'completed'}
                      onChange={(e) => setChecklist.mutate({
                        id: c.id, status: e.target.checked ? 'completed' : 'pending',
                      })}
                      className="accent-neutral-900"
                    />
                    <span className={'text-13 flex-1 ' + (c.status === 'completed' ? 'text-neutral-400 line-through' : 'text-neutral-900')}>
                      {c.label}
                    </span>
                    <select
                      value={c.status}
                      onChange={(e) => setChecklist.mutate({ id: c.id, status: e.target.value })}
                      className="h-7 px-1 text-12 bg-white border border-neutral-300 rounded"
                    >
                      {(settings.data?.checklist_statuses ?? []).map((s) => (
                        <option key={s} value={s}>{human(s)}</option>
                      ))}
                    </select>
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="Workflow">
              <ol className="px-4 py-3 space-y-1">
                {data.workflow_steps.map((s, i) => (
                  <li key={s} className="text-13 text-neutral-700 flex gap-2">
                    <span className="text-neutral-400 tabular-nums w-5">{i + 1}.</span>{s}
                  </li>
                ))}
              </ol>
            </Card>
          </div>

          <Card title="Tasks">
            {data.tasks.length === 0 ? (
              <div className="px-4 py-6 text-13 text-neutral-500">No tasks on this period.</div>
            ) : (
              <Table head={['Task', 'Category', 'Priority', 'Assigned to', 'Due', 'Status']}>
                {data.tasks.map((t) => (
                  <Row key={t.id} status={t.status}>
                    <Cell>{t.title}</Cell>
                    <Cell muted>{human(t.category)}</Cell>
                    <Cell muted>{human(t.priority)}</Cell>
                    <Cell muted>{t.assigned_employee?.full_name ?? '—'}</Cell>
                    <Cell muted>{t.due_date ? fmtDate(t.due_date) : '—'}</Cell>
                    <Cell>
                      <select
                        value={t.status}
                        onChange={(e) => setTaskStatus.mutate({ id: t.id, status: e.target.value })}
                        className="h-7 px-1 text-12 bg-white border border-neutral-300 rounded"
                      >
                        {(settings.data?.task_statuses ?? []).map((s) => (
                          <option key={s} value={s}>{human(s)}</option>
                        ))}
                      </select>
                    </Cell>
                  </Row>
                ))}
              </Table>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Pending items">
              {data.pending_items.length === 0 ? (
                <div className="px-4 py-6 text-13 text-neutral-500">Nothing outstanding.</div>
              ) : (
                <ul className="divide-y divide-neutral-200">
                  {data.pending_items.map((p) => (
                    <li key={p.id} className="px-4 py-2 flex items-center gap-2">
                      <span className="text-13 flex-1">{p.title}</span>
                      <Status value={p.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Deliverables">
              {data.deliverables.length === 0 ? (
                <div className="px-4 py-6 text-13 text-neutral-500">None prepared yet.</div>
              ) : (
                <ul className="divide-y divide-neutral-200">
                  {data.deliverables.map((d) => (
                    <li key={d.id} className="px-4 py-2 flex items-center gap-2">
                      <span className="text-13 flex-1">{human(d.type)}</span>
                      <Status value={d.status} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </QueryState>
  );
}
