import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { bookkeepingApi } from '@/modules/bookkeeping/api';
import { human, opts } from '@/modules/bookkeeping/format';
import type {
  Deliverable, DocumentRequest, PendingItem, Task, WorkflowStage,
} from '@/modules/bookkeeping/types';
import {
  Card, Cell, FilterBar, PageHeader, QueryState, Row, Select, Status, Table,
} from '@/modules/workstation/components';
import { fmtDate } from '@/lib/format';

type PeriodSection = 'checklist' | 'data' | 'deliverables';

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
 * One month of work. Tasks are grouped by workflow stage — the same rows
 * that used to be a separate checklist, a separate workflow panel and a
 * separate task table are now ONE list with THREE renderings. Ticking a
 * checkbox is the same write as changing the status dropdown; both call
 * PATCH /bookkeeping/tasks/:id and land on the same record.
 */
export function BookkeepingPeriodDetailPage() {
  const { periodId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const section = ((params.get('section') as PeriodSection | null) ?? 'checklist') as PeriodSection;
  const setSection = (v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set('section', v); else next.delete('section');
    setParams(next, { replace: true });
  };

  const detail = useQuery({
    queryKey: ['bookkeeping', 'period', periodId],
    queryFn: () => bookkeepingApi.period(periodId),
  });
  const settings = useQuery({ queryKey: ['bookkeeping', 'settings'], queryFn: bookkeepingApi.settings });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['bookkeeping', 'period', periodId] });
    void qc.invalidateQueries({ queryKey: ['bookkeeping', 'overview'] });
  };

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
      {(data) => {
        const stageTasks = data.tasks.filter((t) => t.stage);
        const adhocTasks = data.tasks.filter((t) => !t.stage);
        const stages: WorkflowStage[] = data.workflow_stages ?? [];
        return (
          <div className="space-y-4">
            <PageHeader
              title={`${data.period.client_name ?? 'Client'} · ${data.period.label}`}
              subtitle={
                <span>
                  {data.period.period_start && data.period.period_end
                    ? `${fmtDate(data.period.period_start)} – ${fmtDate(data.period.period_end)} · `
                    : ''}
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
                      onClick={() => navigate(`../clients/${data.period.client_id}`)}
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

            {/* Sub-tabs: Checklist | Data | Deliverables. `?section=` in the
                URL rather than `?tab=` because the periods LIST view already
                uses `?status=` — namespacing keeps a bookmarked link
                unambiguous. */}
            <nav className="flex gap-1 border-b border-neutral-200 -mt-2">
              {(['checklist', 'data', 'deliverables'] as const).map((s) => (
                <button
                  key={s} onClick={() => setSection(s === 'checklist' ? '' : s)}
                  className={
                    'px-3 h-9 text-13 whitespace-nowrap border-b-2 -mb-px ' +
                    (section === s
                      ? 'border-gold text-neutral-900 font-medium'
                      : 'border-transparent text-neutral-500 hover:text-neutral-900')
                  }
                >
                  {human(s)}
                </button>
              ))}
            </nav>

            {section === 'checklist' ? (
              <ChecklistSection
                stages={stages}
                stageTasks={stageTasks}
                adhocTasks={adhocTasks}
                taskStatuses={settings.data?.task_statuses ?? []}
                onTaskStatus={(id, next) => setTaskStatus.mutate({ id, status: next })}
              />
            ) : null}

            {section === 'data' ? (
              <DataSection
                pending={data.pending_items}
                documents={data.document_requests}
              />
            ) : null}

            {section === 'deliverables' ? (
              <DeliverablesSection deliverables={data.deliverables} />
            ) : null}
          </div>
        );
      }}
    </QueryState>
  );
}

function ChecklistSection(props: {
  stages: WorkflowStage[];
  stageTasks: Task[];
  adhocTasks: Task[];
  taskStatuses: string[];
  onTaskStatus: (id: string, status: string) => void;
}) {
  const { stages, stageTasks, adhocTasks, taskStatuses, onTaskStatus } = props;
  return (
    <>
      <Card title="Workflow">
        {stages.length === 0 ? (
          <div className="px-4 py-6 text-13 text-neutral-500">
            No workflow stages configured for this service.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-200">
            {stages.map((s) => {
              const inStage = stageTasks.filter((t) => t.stage?.id === s.id);
              const done = inStage.filter((t) => t.status === 'completed').length;
              return (
                <StageGroup
                  key={s.id}
                  stage={s}
                  tasks={inStage}
                  doneCount={done}
                  taskStatuses={taskStatuses}
                  onToggle={(task, checked) =>
                    onTaskStatus(task.id, checked ? 'completed' : 'pending')
                  }
                  onStatus={(task, next) => onTaskStatus(task.id, next)}
                />
              );
            })}
          </ul>
        )}
      </Card>

      {adhocTasks.length > 0 ? (
        <Card title="Ad-hoc tasks">
          <Table head={['Task', 'Category', 'Priority', 'Assigned to', 'Due', 'Status']}>
            {adhocTasks.map((t) => (
              <Row key={t.id} status={t.status}>
                <Cell>{t.title}</Cell>
                <Cell muted>{human(t.category)}</Cell>
                <Cell muted>{human(t.priority)}</Cell>
                <Cell muted>{t.assigned_employee?.full_name ?? '—'}</Cell>
                <Cell muted>{t.due_date ? fmtDate(t.due_date) : '—'}</Cell>
                <Cell>
                  <select
                    value={t.status}
                    onChange={(e) => onTaskStatus(t.id, e.target.value)}
                    className="h-7 px-1 text-12 bg-white border border-neutral-300 rounded"
                  >
                    {taskStatuses.map((s) => (
                      <option key={s} value={s}>{human(s)}</option>
                    ))}
                  </select>
                </Cell>
              </Row>
            ))}
          </Table>
        </Card>
      ) : null}
    </>
  );
}

/**
 * Data sub-tab. Today this is pending items + document requests (the two
 * lists the retired Pending Items / Documents tabs used to hold). Step 5
 * adds the imports table alongside; the section is shaped to accept it.
 */
function DataSection(props: {
  pending: PendingItem[];
  documents: DocumentRequest[];
}) {
  const { pending, documents } = props;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Pending items">
        {pending.length === 0 ? (
          <div className="px-4 py-6 text-13 text-neutral-500">Nothing outstanding.</div>
        ) : (
          <ul className="divide-y divide-neutral-200">
            {pending.map((p) => (
              <li key={p.id} className="px-4 py-2 flex items-center gap-2">
                <span className="text-13 flex-1">{p.title}</span>
                <Status value={p.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Document requests">
        {documents.length === 0 ? (
          <div className="px-4 py-6 text-13 text-neutral-500">No documents chased yet.</div>
        ) : (
          <ul className="divide-y divide-neutral-200">
            {documents.map((d) => (
              <li key={d.id} className="px-4 py-2 flex items-center gap-2">
                <span className="text-13 flex-1">{human(d.document_type)}</span>
                <Status value={d.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function DeliverablesSection(props: { deliverables: Deliverable[] }) {
  return (
    <Card title="Deliverables">
      {props.deliverables.length === 0 ? (
        <div className="px-4 py-6 text-13 text-neutral-500">None prepared yet.</div>
      ) : (
        <Table head={['Type', 'Prepared by', 'Reviewed by', 'Approved', 'Delivered', 'Status']}>
          {props.deliverables.map((d) => (
            <Row key={d.id} status={d.status}>
              <Cell>{human(d.type)}</Cell>
              <Cell muted>{d.prepared_by?.full_name ?? '—'}</Cell>
              <Cell muted>{d.reviewed_by?.full_name ?? '—'}</Cell>
              <Cell muted>{d.approved_at ? fmtDate(d.approved_at) : '—'}</Cell>
              <Cell muted>{d.delivered_at ? fmtDate(d.delivered_at) : '—'}</Cell>
              <Cell><Status value={d.status} /></Cell>
            </Row>
          ))}
        </Table>
      )}
    </Card>
  );
}

/**
 * One stage on the monthly workflow. Renders both the "checklist" (a
 * checkbox per task) and the "workflow panel" (a stage heading with per-stage
 * counts) at the same time — they are literally the same data.
 */
function StageGroup(props: {
  stage: WorkflowStage;
  tasks: Task[];
  doneCount: number;
  taskStatuses: string[];
  onToggle: (task: Task, checked: boolean) => void;
  onStatus: (task: Task, status: string) => void;
}) {
  const { stage, tasks, doneCount, taskStatuses, onToggle, onStatus } = props;
  const total = tasks.length;
  return (
    <li className="px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-11 tracking-wider uppercase text-neutral-500 font-medium">
          {stage.name}
        </div>
        <div className="text-11 text-neutral-500 tabular-nums">
          {doneCount} of {total}
        </div>
      </div>
      {total === 0 ? (
        <div className="text-13 text-neutral-400 italic">No task on this stage.</div>
      ) : (
        <ul className="space-y-1">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={t.status === 'completed'}
                onChange={(e) => onToggle(t, e.target.checked)}
                className="accent-neutral-900"
                aria-label={t.title}
              />
              <span className={'text-13 flex-1 ' + (t.status === 'completed' ? 'text-neutral-400 line-through' : 'text-neutral-900')}>
                {t.title}
              </span>
              {t.assigned_employee?.full_name ? (
                <span className="text-12 text-neutral-500">{t.assigned_employee.full_name}</span>
              ) : null}
              {t.due_date ? (
                <span className="text-12 text-neutral-500 tabular-nums">{fmtDate(t.due_date)}</span>
              ) : null}
              <select
                value={t.status}
                onChange={(e) => onStatus(t, e.target.value)}
                className="h-7 px-1 text-12 bg-white border border-neutral-300 rounded"
              >
                {taskStatuses.map((s) => (
                  <option key={s} value={s}>{human(s)}</option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
