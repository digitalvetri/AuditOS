import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Play, Pause, CheckCircle2, Ban, RotateCcw, UserCog } from 'lucide-react';
import { Card, Detail, Modal, Field, inputClass, QueryState } from '@/modules/workstation/components';
import { tasksApi, formatMinutes, formatWorked, type TaskDetail as TaskDetailData } from '@/modules/workstation/tasks/api';
import { Priority, TaskStatusPill, LiveTimer, Variance } from '@/modules/workstation/tasks/ui';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import type { ApiError } from '@/services/api';

/**
 * /workstation/tasks/:id — one task in full.
 *
 * The buttons are driven by the task's current status, and the numbers come
 * from the server on every action. The only thing the browser computes is the
 * ticking seconds on a running task, and even that reconciles to the database
 * on the next refresh.
 */
export function TaskDetailPage() {
  const { taskId = '' } = useParams();
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'workstation.task.manage', 'self');
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [showReassign, setShowReassign] = useState(false);

  const q = useQuery({
    queryKey: ['tasks.detail', taskId],
    queryFn: () => tasksApi.get(taskId),
    // A running task is refreshed periodically so the banked total stays
    // honest even if the tab is left open for hours.
    refetchInterval: (query) => (query.state.data?.task.running ? 60_000 : false),
  });

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ['tasks.detail', taskId] });
    await qc.invalidateQueries({ queryKey: ['tasks.list'] });
    await qc.invalidateQueries({ queryKey: ['tasks.dashboard'] });
  };

  const act = useMutation({
    mutationFn: async (input: { action: 'start' | 'pause' | 'resume' | 'complete' | 'cancel' | 'reopen'; reason?: string }) => {
      if (input.action === 'cancel') return tasksApi.cancel(taskId, input.reason);
      if (input.action === 'reopen') return tasksApi.reopen(taskId, input.reason);
      if (input.action === 'complete') return tasksApi.complete(taskId, input.reason);
      return tasksApi[input.action](taskId);
    },
    onSuccess: async () => { setError(null); await invalidate(); },
    onError: (e: ApiError) => setError(e.message),
  });

  return (
    <div data-testid="task-detail">
      <Link to="/workstation/tasks" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900 mb-3">
        <ArrowLeft size={14} strokeWidth={1.75} /> Tasks
      </Link>

      <QueryState query={q}>
        {(data: TaskDetailData) => {
          const t = data.task;
          const openSession = data.sessions.find((s) => s.open);
          return (
            <>
              <header className="flex items-start gap-4 mb-4 flex-wrap">
                <div className="min-w-0">
                  <h1 className="text-20 font-semibold text-neutral-900">{t.title}</h1>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <TaskStatusPill status={t.status} overdue={t.overdue} />
                    <Priority value={t.priority} />
                    <span className="text-12 text-neutral-500">
                      Assigned to {t.assigned_employee_name}{t.assigned_by_name ? ` by ${t.assigned_by_name}` : ''}
                    </span>
                  </div>
                </div>
                <div className="flex-1" />
                <div className="flex items-center gap-2 flex-wrap">
                  {t.status === 'pending' ? (
                    <Action primary label="Start task" icon={<Play size={14} />} onClick={() => act.mutate({ action: 'start' })} busy={act.isPending} />
                  ) : null}
                  {t.status === 'in_progress' ? (
                    <>
                      <Action label="Pause" icon={<Pause size={14} />} onClick={() => act.mutate({ action: 'pause' })} busy={act.isPending} />
                      <Action primary label="Complete" icon={<CheckCircle2 size={14} />} onClick={() => act.mutate({ action: 'complete' })} busy={act.isPending} />
                    </>
                  ) : null}
                  {t.status === 'paused' ? (
                    <>
                      <Action primary label="Resume" icon={<Play size={14} />} onClick={() => act.mutate({ action: 'resume' })} busy={act.isPending} />
                      <Action label="Complete" icon={<CheckCircle2 size={14} />} onClick={() => act.mutate({ action: 'complete' })} busy={act.isPending} />
                    </>
                  ) : null}
                  {(t.status === 'pending' || t.status === 'paused' || (t.status === 'in_progress' && canManage)) ? (
                    <Action
                      label="Cancel" icon={<Ban size={14} />} busy={act.isPending}
                      onClick={() => {
                        const reason = window.prompt('Why is this task being cancelled? (recorded in the history)');
                        if (reason !== null) act.mutate({ action: 'cancel', reason });
                      }}
                    />
                  ) : null}
                  {canManage && (t.status === 'completed' || t.status === 'cancelled') ? (
                    <Action
                      label="Reopen" icon={<RotateCcw size={14} />} busy={act.isPending}
                      onClick={() => {
                        const reason = window.prompt('Why is this task being reopened?');
                        if (reason !== null) act.mutate({ action: 'reopen', reason });
                      }}
                    />
                  ) : null}
                  {canManage && t.status !== 'completed' ? (
                    <Action label="Reassign" icon={<UserCog size={14} />} onClick={() => setShowReassign(true)} />
                  ) : null}
                </div>
              </header>

              {error ? <div className="border-l-2 border-red bg-white px-3 py-2 text-13 text-red mb-3">{error}</div> : null}

              {t.status === 'completed' ? (
                <div className="border-l-2 border-green bg-white px-3 py-2 text-13 text-neutral-700 mb-3">
                  Completed {t.completed_at ? new Date(t.completed_at).toLocaleString('en-IN') : ''} — {formatWorked(t.actual_minutes, t.actual_seconds)} of tracked work.
                </div>
              ) : null}
              {t.status === 'cancelled' ? (
                <div className="border-l-2 border-neutral-400 bg-white px-3 py-2 text-13 text-neutral-700 mb-3">
                  Cancelled{t.cancel_reason ? `: ${t.cancel_reason}` : ''}. The {formatWorked(t.actual_minutes, t.actual_seconds)} already tracked is kept.
                </div>
              ) : null}

              <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-4">
                <div className="space-y-4">
                  <Card title="Task information">
                    <div className="p-4">
                      {t.description ? <p className="text-13 text-neutral-700 mb-4 whitespace-pre-wrap">{t.description}</p> : null}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
                        <Detail label="Assigned to" value={t.assigned_employee_name} />
                        <Detail label="Assigned by" value={t.assigned_by_name ?? '—'} />
                        <Detail label="Client" value={t.client_name ?? '—'} />
                        <Detail label="Project" value={t.project_name ?? '—'} />
                        <Detail label="Priority" value={<Priority value={t.priority} />} />
                        <Detail label="Due date" value={t.due_date ? `${t.due_date}${t.overdue ? ' (overdue)' : ''}` : '—'} />
                        <Detail label="Status" value={<TaskStatusPill status={t.status} overdue={t.overdue} />} />
                        <Detail label="Created" value={new Date(t.created_at).toLocaleString('en-IN')} />
                      </div>
                      {t.notes ? (
                        <div className="mt-3 pt-3 border-t border-neutral-100">
                          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Notes</div>
                          <p className="text-13 text-neutral-700 whitespace-pre-wrap">{t.notes}</p>
                        </div>
                      ) : null}
                    </div>
                  </Card>

                  <Card title={`Work sessions (${data.sessions.length})`}>
                    {data.sessions.length === 0 ? (
                      <div className="px-4 py-5 text-13 text-neutral-500">
                        No work has been logged yet. The clock starts when the task is started.
                      </div>
                    ) : (
                      <ul className="divide-y divide-neutral-100">
                        {data.sessions.map((s, i) => (
                          <li key={s.id} className="px-4 py-2 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-13 text-neutral-900">
                                Session {i + 1} · {s.opened_by === 'resume' ? 'resumed' : 'started'} {new Date(s.started_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                                {s.ended_at ? ` → ${new Date(s.ended_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ''}
                              </div>
                              <div className="text-11 text-neutral-500">
                                {s.employee_name} · {new Date(s.started_at).toLocaleDateString('en-IN')}
                                {s.closed_by ? ` · closed on ${s.closed_by}` : ''}
                              </div>
                            </div>
                            <span className="text-13 tabular-nums">
                              {s.open ? <span className="text-blue-700">running</span> : formatWorked(s.duration_minutes ?? 0, sessionSeconds(s))}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>

                  <Card title="Timeline &amp; activity">
                    <ul className="divide-y divide-neutral-100">
                      {data.timeline.map((e) => (
                        <li key={e.id} className="px-4 py-2 flex items-start gap-3">
                          <span className="text-12 text-neutral-500 tabular-nums w-[132px] flex-shrink-0">
                            {new Date(e.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          </span>
                          <span className="text-13 text-neutral-900 flex-1">
                            {humanAction(e.action)}
                            {e.old_status && e.new_status && e.old_status !== e.new_status ? (
                              <span className="text-neutral-500"> · {e.old_status.replace(/_/g, ' ')} → {e.new_status.replace(/_/g, ' ')}</span>
                            ) : null}
                          </span>
                          <span className="text-12 text-neutral-500">{e.by}</span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                </div>

                <div className="space-y-4">
                  <Card title="Time">
                    <div className="p-4">
                      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Actual work time</div>
                      <div className="text-24 font-semibold text-neutral-900 mt-1">
                        {t.running && openSession ? (
                          <LiveTimer startedAt={openSession.started_at} bankedMinutes={t.actual_minutes} />
                        ) : (
                          formatWorked(t.actual_minutes, t.actual_seconds)
                        )}
                      </div>
                      {t.running ? (
                        <p className="text-11 text-neutral-500 mt-1">
                          Ticking. The database holds the authoritative total and is re-read every minute.
                        </p>
                      ) : null}

                      <div className="mt-4 space-y-2 text-13">
                        <TimeRow label="Estimated" value={t.estimated_minutes ? formatMinutes(t.estimated_minutes) : '—'} />
                        <TimeRow label="Total pause" value={formatMinutes(t.pause_minutes)} />
                        <TimeRow label="Total elapsed" value={formatMinutes(t.elapsed_minutes)} />
                        <TimeRow label="Variance" value={<Variance minutes={t.variance_minutes} />} />
                      </div>

                      <div className="mt-4 pt-3 border-t border-neutral-100 space-y-2 text-13">
                        <TimeRow label="Start time" value={t.started_at ? new Date(t.started_at).toLocaleString('en-IN') : 'Not started'} />
                        <TimeRow label="End time" value={t.ended_at ? new Date(t.ended_at).toLocaleString('en-IN') : '—'} />
                        <TimeRow label="Sessions" value={String(t.session_count)} />
                      </div>
                    </div>
                  </Card>
                </div>
              </div>

              {showReassign ? (
                <ReassignModal taskId={t.id} currentEmployeeId={t.assigned_employee_id} onClose={() => setShowReassign(false)} onDone={invalidate} />
              ) : null}
            </>
          );
        }}
      </QueryState>
    </div>
  );
}

function TimeRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-neutral-500">{label}</span>
      <span className="text-neutral-900">{value}</span>
    </div>
  );
}

function Action({ label, icon, onClick, busy, primary }: {
  label: string; icon?: React.ReactNode; onClick: () => void; busy?: boolean; primary?: boolean;
}) {
  return (
    <button
      type="button" onClick={onClick} disabled={busy}
      className={
        'h-8 px-3 inline-flex items-center gap-1 text-13 rounded disabled:opacity-50 ' +
        (primary ? 'bg-neutral-900 text-white hover:bg-neutral-800' : 'border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50')
      }
    >
      {icon}{label}
    </button>
  );
}

function ReassignModal({ taskId, currentEmployeeId, onClose, onDone }: {
  taskId: string; currentEmployeeId: string; onClose: () => void; onDone: () => Promise<void>;
}) {
  const [employeeId, setEmployeeId] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const employeesQ = useQuery({ queryKey: ['tasks.employees'], queryFn: () => tasksApi.assignableEmployees() });
  const reassign = useMutation({
    mutationFn: () => tasksApi.reassign(taskId, employeeId, reason || undefined),
    onSuccess: async () => { await onDone(); onClose(); },
    onError: (e: ApiError) => setErr(e.message),
  });

  return (
    <Modal
      open title="Reassign task" onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="h-8 px-3 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50">Cancel</button>
          <button
            type="button" disabled={!employeeId || reassign.isPending} onClick={() => reassign.mutate()}
            className="h-8 px-3 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            {reassign.isPending ? 'Reassigning…' : 'Reassign'}
          </button>
        </>
      }
    >
      <Field label="Reassign to">
        <select className={inputClass} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
          <option value="">Select employee…</option>
          {(employeesQ.data?.items ?? []).filter((e) => e.id !== currentEmployeeId).map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
      </Field>
      <Field label="Reason" hint="Recorded in the task history.">
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {err ? <div className="text-13 text-red">{err}</div> : null}
      <p className="text-12 text-neutral-500">
        A running task is paused first, so the minutes already worked stay attributed to the person who worked them.
      </p>
    </Modal>
  );
}

/** Exact seconds for one closed session, for the sub-minute display. */
function sessionSeconds(s: { started_at: string; ended_at: string | null }): number | undefined {
  if (!s.ended_at) return undefined;
  return Math.max(0, Math.round((Date.parse(s.ended_at) - Date.parse(s.started_at)) / 1000));
}

function humanAction(action: string): string {
  const map: Record<string, string> = {
    task_created: 'Task created',
    task_assigned: 'Assigned',
    task_reassigned: 'Reassigned',
    task_edited: 'Edited',
    task_started: 'Started',
    task_paused: 'Paused',
    task_resumed: 'Resumed',
    task_completed: 'Completed',
    task_cancelled: 'Cancelled',
    task_reopened: 'Reopened',
  };
  return map[action] ?? action.replace(/_/g, ' ');
}
