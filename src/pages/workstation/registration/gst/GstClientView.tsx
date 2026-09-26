/**
 * GST client view — GST-CLIENT-DASHBOARD-TASKS §2 / §3 / §4 / §5.
 *
 * Lands here from the client dashboard's row click. Layout (top → bottom):
 *   1. Header — client name + GSTIN + filing type + FY + Visit portal
 *   2. GST Portal Login Credentials panel (Show/Copy/30s auto-hide, Edit,
 *      Delete, Add). Placed above the period selector because credentials
 *      are per-GSTIN, not per-period, and reaching for them is the first
 *      thing a filer does when starting work.
 *   3. Period selector
 *   4. This period's three returns with state + due + [ Open case ]
 *   5. Tasks — one row per return per period, generated on demand by the
 *      Generate tasks button (§4). Each row links to the Task module.
 *   6. Earlier periods — collapsed row-per-period with three ticks
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, ExternalLink, Check, Circle, AlertTriangle } from 'lucide-react';
import { Card, PageHeader, QueryState } from '@/modules/workstation/components';
import {
  gstApi, periodLabel, recentPeriods,
  type ClientViewCell, type ClientViewResponse,
} from '@/modules/workstation/gst/api';
import { SERVICES } from '../partnership/shared';
import { PortalPanel } from './PortalPanel';
import { useToast } from '@/components/Toast';
import { tasksApi, PRIORITY_LABEL, STATUS_LABEL, type Task } from '@/modules/workstation/tasks/api';
import type { RegistrationKind } from '@/modules/partnership/api';

const RETURN_LABELS: Record<'GSTR1' | 'GSTR2B' | 'GSTR3B', string> = {
  GSTR1: 'GSTR-1',
  GSTR2B: 'IMS + GSTR-2B',
  GSTR3B: 'GSTR-3B',
};
const RETURN_ACTIONS: Record<'GSTR1' | 'GSTR2B' | 'GSTR3B', string> = {
  GSTR1: 'File GSTR-1',
  GSTR2B: 'Reconcile GSTR-2B', // §6 — 2B is reconciled, never filed
  GSTR3B: 'File GSTR-3B',
};

function StateChip({ cell }: { cell: ClientViewCell | null }) {
  if (!cell) return <span className="text-neutral-400">Not due this period</span>;
  const Icon = cell.state === 'done' ? Check : cell.state === 'overdue' ? AlertTriangle : Circle;
  const tint = cell.state === 'done' ? 'text-green' : cell.state === 'overdue' ? 'text-red' : cell.state === 'due' ? 'text-amber' : 'text-neutral-400';
  return <Icon size={13} strokeWidth={2} className={tint} aria-hidden />;
}

function ReturnRow({ view, kind, onOpen, busy }: {
  view: ClientViewResponse;
  kind: 'GSTR1' | 'GSTR2B' | 'GSTR3B';
  onOpen: () => void;
  busy: boolean;
}) {
  const cell = kind === 'GSTR1' ? view.gstr1 : kind === 'GSTR2B' ? view.gstr2b : view.gstr3b;
  if (!cell) {
    return (
      <div className="px-4 py-2 text-13 text-neutral-500 flex items-center gap-3 border-b border-neutral-100 last:border-b-0">
        <StateChip cell={null} />
        <span className="font-medium text-neutral-700">{RETURN_LABELS[kind]}</span>
        <span>— Not due this period.</span>
      </div>
    );
  }
  const dateStr = cell.due_date ? new Date(cell.due_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : null;
  return (
    <div className="px-4 py-2 flex items-center gap-3 text-13 border-b border-neutral-100 last:border-b-0">
      <StateChip cell={cell} />
      <span className="font-medium text-neutral-900 min-w-[120px]">{RETURN_LABELS[kind]}</span>
      <span className="flex-1 min-w-0 text-neutral-700">
        {cell.state === 'done' ? (
          <>Filed {cell.filed_at ? new Date(cell.filed_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : dateStr}
            {cell.arn ? <span className="ml-1 font-mono text-12 text-neutral-500">ARN {cell.arn}</span> : null}</>
        ) : cell.state === 'overdue' ? (
          <span className="text-red">Overdue — was due {dateStr}</span>
        ) : cell.state === 'due' ? (
          <span className="text-amber">{RETURN_ACTIONS[kind]} — due {dateStr}</span>
        ) : (
          <>Not started · due {dateStr}</>
        )}
      </span>
      <button
        type="button"
        onClick={onOpen}
        disabled={busy}
        className="text-13 text-neutral-700 underline hover:text-neutral-900 disabled:opacity-60"
      >
        Open case
      </button>
    </div>
  );
}

/**
 * Tasks panel. Scopes tasks by the three case IDs on the current view; if
 * the seed generator has not run for this period, offers a button to run it.
 *
 * Cases and tasks are seeded together by POST /gst/period/seed — refetching
 * both the client-view query (which picked up new case_ids) and this panel's
 * task list is what makes the "Generate" flow update the whole screen.
 */
function TasksPanel({ view, period, viewQueryKey }: {
  view: ClientViewResponse;
  period: string;
  viewQueryKey: readonly unknown[];
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const caseIds = [view.gstr1?.case_id, view.gstr2b?.case_id, view.gstr3b?.case_id].filter(
    (id): id is string => !!id,
  );
  const noAssignee = !view.gst_profile.assigned_employee_id;
  const csv = caseIds.join(',');

  const tasksQuery = useQuery({
    queryKey: ['gst', 'client-view', view.client.id, period, 'tasks', csv],
    queryFn: () => tasksApi.list({ partnership_case_ids: csv, sort: 'due_date', limit: 20 }),
    enabled: caseIds.length > 0,
  });

  const seed = useMutation({
    mutationFn: () => gstApi.seedPeriod(view.client.id, period),
    onSuccess: (r) => {
      const created = r.items.filter((i) => i.task_created).length;
      const recomputed = r.items.filter((i) => i.task_due_updated || i.case_due_updated).length;
      const kept = r.items.length - created;
      if (r.items.length === 0) {
        toast.push('info', `Nothing to generate for ${period}.`);
      } else if (created > 0) {
        toast.push(
          'success',
          `Generated ${created} task${created === 1 ? '' : 's'}${kept > 0 ? ` (${kept} already existed)` : ''}${recomputed > 0 ? `; ${recomputed} due date${recomputed === 1 ? '' : 's'} updated` : ''}.`,
        );
      } else if (recomputed > 0) {
        toast.push('success', `Updated ${recomputed} due date${recomputed === 1 ? '' : 's'} to the current statutory calendar.`);
      } else {
        toast.push('info', `Tasks for ${period} already exist and dates are current.`);
      }
      qc.invalidateQueries({ queryKey: viewQueryKey });
      qc.invalidateQueries({ queryKey: ['gst', 'client-view', view.client.id, period, 'tasks'] });
    },
    onError: (e) => toast.push('error', e instanceof Error ? e.message : 'Could not generate tasks.'),
  });

  const items = tasksQuery.data?.items ?? [];
  const empty = items.length === 0;

  return (
    <Card
      title="Tasks"
      right={
        empty ? (
          <button
            type="button"
            disabled={seed.isPending || noAssignee}
            onClick={() => seed.mutate()}
            title={noAssignee ? 'Assign an employee to this GST profile first.' : undefined}
            className="h-8 px-3 text-13 border border-neutral-300 rounded hover:border-neutral-400 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {seed.isPending ? 'Generating…' : 'Generate tasks'}
          </button>
        ) : null
      }
    >
      {noAssignee ? (
        <div className="px-4 py-3 text-13 text-amber">
          Assign an employee to this GST profile before generating tasks —
          tasks need an owner and defaulting to the person who clicks Generate
          would orphan the task when they leave.
        </div>
      ) : empty ? (
        <div className="px-4 py-3 text-13 text-neutral-500">
          No tasks for {periodLabel(period)} yet. Generate one per applicable
          return (respecting the client's monthly/quarterly filing frequency).
        </div>
      ) : (
        <div>{items.map((t) => <TaskRow key={t.id} task={t} />)}</div>
      )}
    </Card>
  );
}

function TaskRow({ task }: { task: Task }) {
  const dueStr = task.due_date
    ? new Date(task.due_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
    : null;
  const tint = task.status === 'completed'
    ? 'text-green'
    : task.overdue
    ? 'text-red'
    : task.status === 'in_progress'
    ? 'text-amber'
    : 'text-neutral-400';
  const Icon = task.status === 'completed' ? Check : task.overdue ? AlertTriangle : Circle;
  return (
    <Link
      to={`/workstation/tasks/${task.id}`}
      className="px-4 py-2 flex items-center gap-3 text-13 border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50"
    >
      <Icon size={13} strokeWidth={2} className={tint} aria-hidden />
      <span className="font-medium text-neutral-900 min-w-0 flex-1 truncate">{task.title}</span>
      <span className="text-neutral-600 hidden sm:inline">{task.assigned_employee_name}</span>
      <span className="text-neutral-500">{STATUS_LABEL[task.status] ?? task.status}</span>
      <span className="text-neutral-500">{PRIORITY_LABEL[task.priority] ?? task.priority}</span>
      <span className="text-neutral-500 tabular-nums min-w-[52px] text-right">
        {task.overdue && dueStr ? <span className="text-red">{dueStr}</span> : dueStr ?? '—'}
      </span>
    </Link>
  );
}

export function GstClientView() {
  const navigate = useNavigate();
  const { clientId = '' } = useParams();
  const periods = recentPeriods(12);
  const defaultPeriod = periods[0]?.value ?? new Date().toISOString().slice(0, 7);
  const [period, setPeriod] = useState(defaultPeriod);

  const viewQueryKey = ['gst', 'client-view', clientId, period] as const;
  const q = useQuery({
    queryKey: viewQueryKey,
    queryFn: () => gstApi.clientView(clientId, period),
    enabled: !!clientId,
  });

  const openCase = useMutation({
    mutationFn: async ({ view, kind }: { view: ClientViewResponse; kind: RegistrationKind }) => {
      const svc = SERVICES[kind];
      const cell = kind === 'GSTR1' ? view.gstr1 : kind === 'GSTR2B' ? view.gstr2b : view.gstr3b;
      if (cell?.case_id) return { url: svc.caseUrl(cell.case_id) };
      const r = await svc.api.openForPeriod({
        client_id: view.client.id, period,
        period_type: view.gst_profile.filing_frequency === 'quarterly' ? 'quarterly' : 'monthly',
      });
      return { url: svc.caseUrl(r.id) };
    },
    onSuccess: (r) => navigate(r.url),
    onError: (e) => window.alert(e instanceof Error ? e.message : 'Could not open case'),
  });

  return (
    <div className="m-gst space-y-4">
      <button type="button" onClick={() => navigate('../dashboard')}
              className="inline-flex items-center gap-1 min-h-[44px] md:min-h-0 text-13 text-neutral-500 hover:text-neutral-900">
        <ChevronLeft size={16} strokeWidth={2} /> GST
      </button>

      <QueryState query={q}>
        {(d) => (
          <>
            <div className="flex items-start justify-between gap-3">
              <PageHeader
                title={d.client.name}
                subtitle={`${d.gst_profile.gstin} · ${d.gst_profile.filing_frequency === 'monthly' ? 'Monthly' : 'Quarterly'} · ${d.gst_profile.state ?? ''}`.trim()}
              />
              <a href="https://www.gst.gov.in" target="_blank" rel="noopener noreferrer"
                 className="inline-flex items-center gap-1 h-9 px-3 text-13 border border-neutral-300 rounded hover:border-neutral-400 shrink-0">
                <ExternalLink size={14} /> Visit portal
              </a>
            </div>

            {/* Portal credentials — the first thing needed when starting work. */}
            <PortalPanel gstProfileId={d.gst_profile.id} />

            <div className="flex items-center gap-1 self-start">
              <button type="button" onClick={() => {
                const idx = periods.findIndex((p) => p.value === period);
                const next = periods[idx + 1];
                if (next) setPeriod(next.value);
              }} className="h-8 w-8 text-13 border border-neutral-300 rounded" aria-label="Previous">◂</button>
              <select className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded"
                      value={period} onChange={(e) => setPeriod(e.target.value)}>
                {periods.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
              <button type="button" onClick={() => {
                const idx = periods.findIndex((p) => p.value === period);
                const next = periods[idx - 1];
                if (next) setPeriod(next.value);
              }} className="h-8 w-8 text-13 border border-neutral-300 rounded" aria-label="Next">▸</button>
            </div>

            <Card title={periodLabel(period)}>
              <div>
                {(['GSTR1', 'GSTR2B', 'GSTR3B'] as const).map((k) => (
                  <ReturnRow key={k} view={d} kind={k} busy={openCase.isPending}
                             onOpen={() => openCase.mutate({ view: d, kind: k })} />
                ))}
              </div>
            </Card>

            {/* Tasks — one row per return per period; Generate button seeds
                cases + tasks in a single POST. §4. */}
            <TasksPanel view={d} period={period} viewQueryKey={viewQueryKey} />

            {d.earlier.length > 0 ? (
              <Card title="Earlier periods">
                <div className="px-4 py-3 flex flex-wrap gap-x-6 gap-y-2 text-13">
                  {d.earlier.map((e) => (
                    <span key={e.period} className="inline-flex items-center gap-2">
                      <span className="text-neutral-600">{periodLabel(e.period)}</span>
                      <span className="inline-flex gap-1">
                        <Check size={12} className={e.gstr1_done ? 'text-green' : 'text-neutral-300'} strokeWidth={2} aria-label="GSTR-1" />
                        <Check size={12} className={e.gstr2b_done ? 'text-green' : 'text-neutral-300'} strokeWidth={2} aria-label="GSTR-2B" />
                        <Check size={12} className={e.gstr3b_done ? 'text-green' : 'text-neutral-300'} strokeWidth={2} aria-label="GSTR-3B" />
                      </span>
                    </span>
                  ))}
                </div>
              </Card>
            ) : null}
          </>
        )}
      </QueryState>
    </div>
  );
}

