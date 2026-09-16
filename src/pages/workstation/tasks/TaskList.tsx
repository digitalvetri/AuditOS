import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Play, Pause, Square, CheckCircle2 } from 'lucide-react';
import {
  PageHeader, Card, Table, Row, Cell, FilterBar, Select, SearchInput, Modal, Field,
  inputClass, textareaClass, QueryState, fieldErrors,
} from '@/modules/workstation/components';
import { tasksApi, formatMinutes, formatWorked, type Task, type CreateTaskInput, type TaskFilters } from '@/modules/workstation/tasks/api';
import { Priority, TaskStatusPill, useLiveMinutes } from '@/modules/workstation/tasks/ui';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import type { ApiError } from '@/services/api';

/**
 * /workstation/tasks — the Task dashboard and register.
 *
 * Managers see every task in their scope and the summary tiles above it;
 * an employee sees the tasks assigned to them. That difference is decided
 * by the server's scope resolution, not by hiding rows here.
 */
export function TaskListPage() {
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'workstation.task.manage', 'self');
  const navigate = useNavigate();

  const [filters, setFilters] = useState<TaskFilters>({ status: 'all', priority: 'all', sort: 'newest', limit: 50 });
  const [showCreate, setShowCreate] = useState(false);

  const dashboardQ = useQuery({
    queryKey: ['tasks.dashboard'],
    queryFn: () => tasksApi.dashboard(),
  });
  const listQ = useQuery({
    queryKey: ['tasks.list', filters],
    queryFn: () => tasksApi.list(filters),
  });
  const employeesQ = useQuery({
    queryKey: ['tasks.employees'],
    queryFn: () => tasksApi.assignableEmployees(),
  });

  const set = <K extends keyof TaskFilters>(k: K, v: TaskFilters[K]) =>
    setFilters((f) => ({ ...f, [k]: v, offset: 0 }));

  const totals = dashboardQ.data?.totals;

  return (
    <div data-testid="task-list">
      <PageHeader
        title="Tasks"
        subtitle={canManage
          ? 'Assign work, and see the time it actually took — tracked by the server, not typed in.'
          : 'Your assigned work. Start the clock when you begin; it runs on the server.'}
        action={canManage ? (
          <button type="button" onClick={() => setShowCreate(true)} className="h-8 px-3 inline-flex items-center gap-1 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800">
            <Plus size={14} strokeWidth={1.75} /> Create task
          </button>
        ) : undefined}
      />

      {/* Tiles — every number is a server-side aggregate. */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2 mb-4">
        <Tile label="Total" value={totals?.total} onClick={() => set('status', 'all')} />
        <Tile label="Pending" value={totals?.pending} onClick={() => set('status', 'pending')} />
        <Tile label="In progress" value={totals?.in_progress} onClick={() => set('status', 'in_progress')} />
        <Tile label="Paused" value={totals?.paused} onClick={() => set('status', 'paused')} />
        <Tile label="Completed" value={totals?.completed} onClick={() => set('status', 'completed')} />
        <Tile label="Overdue" value={totals?.overdue} tone="danger" onClick={() => setFilters((f) => ({ ...f, status: 'all', overdue: true, offset: 0 }))} />
        <Tile label="Cancelled" value={totals?.cancelled} onClick={() => set('status', 'cancelled')} />
        <Tile label="Work time" text={totals ? formatMinutes(totals.total_work_minutes) : undefined} />
      </div>

      {canManage && totals ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
          <Tile label="Active employees" value={totals.active_employees} />
          <Tile label="Average completion" text={formatMinutes(totals.average_completion_minutes)} />
          <Tile label="Estimated" text={formatMinutes(dashboardQ.data!.estimated_vs_actual.estimated_minutes)} />
          <Tile label="Actual (estimated tasks)" text={formatMinutes(dashboardQ.data!.estimated_vs_actual.actual_minutes)} />
        </div>
      ) : null}

      <FilterBar>
        <SearchInput value={filters.q ?? ''} onChange={(v) => set('q', v)} placeholder="Title, description, employee, client…" />
        <Select
          label="Status"
          value={filters.status ?? 'all'}
          onChange={(v) => setFilters((f) => ({ ...f, status: v, overdue: false, offset: 0 }))}
          options={[
            { value: 'all', label: 'All statuses' },
            { value: 'pending', label: 'Pending' },
            { value: 'in_progress', label: 'In progress' },
            { value: 'paused', label: 'Paused' },
            { value: 'completed', label: 'Completed' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: 'overdue', label: 'Overdue' },
          ]}
        />
        <Select
          label="Priority"
          value={filters.priority ?? 'all'}
          onChange={(v) => set('priority', v)}
          options={[
            { value: 'all', label: 'All priorities' },
            { value: 'urgent', label: 'Urgent' },
            { value: 'high', label: 'High' },
            { value: 'medium', label: 'Medium' },
            { value: 'low', label: 'Low' },
          ]}
        />
        {canManage ? (
          <Select
            label="Employee"
            value={filters.employee_id ?? ''}
            onChange={(v) => set('employee_id', v || undefined)}
            options={[{ value: '', label: 'All employees' }, ...(employeesQ.data?.items ?? []).map((e) => ({ value: e.id, label: e.name }))]}
          />
        ) : null}
        <Select
          label="Sort"
          value={filters.sort ?? 'newest'}
          onChange={(v) => set('sort', v)}
          options={[
            { value: 'newest', label: 'Newest first' },
            { value: 'oldest', label: 'Oldest first' },
            { value: 'due_date', label: 'Due date' },
            { value: 'priority', label: 'Priority' },
            { value: 'duration', label: 'Longest tracked' },
          ]}
        />
        <Link to="/workstation/tasks/reports" className="h-8 px-3 inline-flex items-center text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50">
          Reports
        </Link>
      </FilterBar>

      <QueryState query={listQ} empty={<div className="px-4 py-6 text-13 text-neutral-500">No tasks match these filters.</div>}>
        {(data) => (
          <Card
            title={`${data.total} task${data.total === 1 ? '' : 's'}`}
            right={data.total > data.items.length ? <span className="text-12 text-neutral-500">Showing {data.items.length}</span> : undefined}
          >
            <Table head={['Task', 'Employee', 'Client / Project', 'Priority', 'Status', 'Estimated', 'Actual', 'Due', 'Actions']}>
              {data.items.map((t) => (
                <TaskRow key={t.id} task={t} onOpen={() => navigate(`/workstation/tasks/${t.id}`)} />
              ))}
            </Table>
            {data.total > data.items.length ? (
              <div className="px-3 py-2 border-t border-neutral-100">
                <button
                  type="button"
                  onClick={() => setFilters((f) => ({ ...f, limit: (f.limit ?? 50) + 50 }))}
                  className="text-13 text-gold hover:underline"
                >
                  Load more
                </button>
              </div>
            ) : null}
          </Card>
        )}
      </QueryState>

      {showCreate ? (
        <CreateTaskModal
          employees={employeesQ.data?.items ?? []}
          onClose={() => setShowCreate(false)}
        />
      ) : null}
    </div>
  );
}

function Tile({ label, value, text, tone, onClick }: {
  label: string; value?: number; text?: string; tone?: 'danger'; onClick?: () => void;
}) {
  const body = (
    <>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className={`text-18 font-semibold mt-0.5 ${tone === 'danger' && (value ?? 0) > 0 ? 'text-red' : 'text-neutral-900'}`}>
        {text ?? (value === undefined ? '—' : value)}
      </div>
    </>
  );
  if (!onClick) return <div className="bg-white border border-neutral-200 rounded p-3">{body}</div>;
  return (
    <button type="button" onClick={onClick} className="text-left bg-white border border-neutral-200 rounded p-3 hover:border-gold transition-colors">
      {body}
    </button>
  );
}

/** One row, with the clock controls the current status allows. */
function TaskRow({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const qc = useQueryClient();
  const live = useLiveMinutes(task);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['tasks.list'] });
    void qc.invalidateQueries({ queryKey: ['tasks.dashboard'] });
  };
  const act = useMutation({
    mutationFn: (action: 'start' | 'pause' | 'resume' | 'complete') => tasksApi[action](task.id),
    onSuccess: invalidate,
  });

  return (
    <Row onClick={onOpen} status={task.overdue ? 'missed' : task.status}>
      <Cell>
        <span className="text-neutral-900">{task.title}</span>
        {task.session_count > 0 ? <span className="block text-11 text-neutral-500">{task.session_count} session{task.session_count === 1 ? '' : 's'}</span> : null}
      </Cell>
      <Cell muted>{task.assigned_employee_name}</Cell>
      <Cell muted>
        {task.client_name ?? '—'}
        {task.project_name ? <span className="block text-11 text-neutral-400">{task.project_name}</span> : null}
      </Cell>
      <Cell><Priority value={task.priority} /></Cell>
      <Cell><TaskStatusPill status={task.status} overdue={task.overdue} /></Cell>
      <Cell muted>{task.estimated_minutes ? formatMinutes(task.estimated_minutes) : '—'}</Cell>
      <Cell>
        <span className={task.running ? 'text-blue-700 tabular-nums' : 'tabular-nums'}>{formatWorked(live, task.running ? undefined : task.actual_seconds)}</span>
      </Cell>
      <Cell muted>{task.due_date ?? '—'}</Cell>
      <Cell>
        <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {task.status === 'pending' ? (
            <IconButton label="Start" onClick={() => act.mutate('start')} disabled={act.isPending}><Play size={13} /></IconButton>
          ) : null}
          {task.status === 'in_progress' ? (
            <>
              <IconButton label="Pause" onClick={() => act.mutate('pause')} disabled={act.isPending}><Pause size={13} /></IconButton>
              <IconButton label="Complete" onClick={() => act.mutate('complete')} disabled={act.isPending}><CheckCircle2 size={13} /></IconButton>
            </>
          ) : null}
          {task.status === 'paused' ? (
            <>
              <IconButton label="Resume" onClick={() => act.mutate('resume')} disabled={act.isPending}><Play size={13} /></IconButton>
              <IconButton label="Complete" onClick={() => act.mutate('complete')} disabled={act.isPending}><CheckCircle2 size={13} /></IconButton>
            </>
          ) : null}
          {task.status === 'completed' || task.status === 'cancelled' ? (
            <Square size={13} className="text-neutral-300" />
          ) : null}
        </span>
      </Cell>
    </Row>
  );
}

function IconButton({ label, onClick, disabled, children }: {
  label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}
      className="h-7 w-7 inline-flex items-center justify-center rounded border border-neutral-200 bg-white text-neutral-600 hover:border-gold hover:text-neutral-900 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function CreateTaskModal({ employees, onClose }: {
  employees: { id: string; name: string; department: string | null }[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<CreateTaskInput>({
    title: '', description: '', assigned_employee_id: '', priority: 'medium',
    due_date: new Date().toISOString().slice(0, 10),
  });
  const [estimateHours, setEstimateHours] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: () => tasksApi.create({
      ...form,
      description: form.description?.trim() || null,
      estimated_minutes: estimateHours.trim() ? Math.round(Number(estimateHours) * 60) : null,
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks.list'] });
      await qc.invalidateQueries({ queryKey: ['tasks.dashboard'] });
      onClose();
    },
    onError: (e: ApiError) => { setErr(e.message); setFieldErr(fieldErrors(e)); },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!form.title.trim()) { setErr('A task needs a title.'); return; }
    if (!form.assigned_employee_id) { setErr('Choose who it is assigned to.'); return; }
    if (estimateHours.trim() && !(Number(estimateHours) > 0)) { setErr('Estimated duration must be a positive number of hours.'); return; }
    create.mutate();
  }

  return (
    <Modal
      open
      title="Create task"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="h-8 px-3 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50">Cancel</button>
          <button type="submit" form="create-task" disabled={create.isPending} className="h-8 px-3 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-50">
            {create.isPending ? 'Creating…' : 'Create task'}
          </button>
        </>
      }
    >
      <form id="create-task" onSubmit={submit}>
        <Field label="Task title" error={fieldErr.title}>
          <input className={inputClass} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus data-testid="task-title" />
        </Field>
        <Field label="Description">
          <textarea className={textareaClass} rows={3} value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assign to" error={fieldErr.assigned_employee_id}>
            <select className={inputClass} value={form.assigned_employee_id} onChange={(e) => setForm({ ...form, assigned_employee_id: e.target.value })} data-testid="task-assignee">
              <option value="">Select employee…</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}{e.department ? ` · ${e.department}` : ''}</option>)}
            </select>
          </Field>
          <Field label="Priority">
            <select className={inputClass} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as CreateTaskInput['priority'] })}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Due date" error={fieldErr.due_date}>
            <input type="date" className={inputClass} value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
          </Field>
          <Field label="Estimated duration (hours)" hint="Used for the estimated-vs-actual comparison. Optional.">
            <input className={inputClass} value={estimateHours} onChange={(e) => setEstimateHours(e.target.value)} placeholder="e.g. 2" />
          </Field>
        </div>
        <Field label="Notes">
          <textarea className={textareaClass} rows={2} value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
        {err ? <div className="text-13 text-red mb-2">{err}</div> : null}
        <p className="text-12 text-neutral-500">
          The employee starts and stops the clock themselves; time is recorded by the server and cannot be typed in.
        </p>
      </form>
    </Modal>
  );
}
