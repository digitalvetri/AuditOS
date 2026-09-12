import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { bookkeepingApi } from '@/modules/bookkeeping/api';
import { workstationApi } from '@/modules/workstation/api';
import { human, opts } from '@/modules/bookkeeping/format';
import {
  Card, Cell, Field, FilterBar, PageHeader, QueryState, Row, SearchInput,
  Select, Table, inputClass,
} from '@/modules/workstation/components';
import { CreateModal } from './CreateModal';
import { fmtDate } from '@/lib/format';

/** URL-backed filter state, so a filtered list is a shareable link. */
function useFilters() {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };
  return { get, set };
}

function useSettings() {
  return useQuery({ queryKey: ['bookkeeping', 'settings'], queryFn: bookkeepingApi.settings });
}
function useEmployees() {
  return useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });
}
function useBkClients() {
  return useQuery({ queryKey: ['bookkeeping', 'clients', {}], queryFn: () => bookkeepingApi.listClients() });
}

// ── Tasks ─────────────────────────────────────────────────────────────────
export function BookkeepingTasksPage() {
  const { get, set } = useFilters();
  const qc = useQueryClient();
  const settings = useSettings();
  const employees = useEmployees();
  const clients = useBkClients();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  const filters = {
    q: get('q'), status: get('status'), priority: get('priority'),
    category: get('category'), client_id: get('client_id'), employee_id: get('employee_id'),
    due: get('due'),
  };
  const tasks = useQuery({
    queryKey: ['bookkeeping', 'tasks', filters],
    queryFn: () => bookkeepingApi.listTasks(filters),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bookkeeping', 'tasks'] });
    void qc.invalidateQueries({ queryKey: ['bookkeeping', 'overview'] });
  };
  const create = useMutation({
    mutationFn: () => bookkeepingApi.createTask(form),
    onSuccess: () => { setOpen(false); setForm({}); refresh(); },
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => bookkeepingApi.updateTask(id, { status }),
    onSuccess: refresh,
  });

  return (
    <div>
      <PageHeader
        title="Tasks" subtitle="Bookkeeping work assigned to the team."
        action={
          <button onClick={() => setOpen(true)} className="h-8 px-3 text-13 bg-primary text-white rounded hover:bg-primaryHover">
            New task
          </button>
        }
      />
      <FilterBar>
        <SearchInput value={filters.q} onChange={(v) => set('q', v)} placeholder="Title or description" />
        <Select label="Client" value={filters.client_id} onChange={(v) => set('client_id', v)}
          options={(clients.data?.items ?? []).map((c) => ({ value: c.client_id, label: c.client_name ?? '—' }))} />
        <Select label="Status" value={filters.status} onChange={(v) => set('status', v)} options={opts(settings.data?.task_statuses)} />
        <Select label="Priority" value={filters.priority} onChange={(v) => set('priority', v)} options={opts(settings.data?.priorities)} />
        <Select label="Category" value={filters.category} onChange={(v) => set('category', v)} options={opts(settings.data?.task_categories)} />
        <Select label="Assigned to" value={filters.employee_id} onChange={(v) => set('employee_id', v)}
          options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name }))} />
        <Select label="Due" value={filters.due} onChange={(v) => set('due', v)} options={[{ value: 'overdue', label: 'Overdue' }]} />
      </FilterBar>

      <Card>
        <QueryState query={tasks}>
          {(data) => data.items.length === 0 ? (
            <div className="px-4 py-6 text-13 text-neutral-500">No tasks match these filters.</div>
          ) : (
            <Table head={['Task', 'Client', 'Period', 'Category', 'Priority', 'Assigned to', 'Due', 'Status']}>
              {data.items.map((t) => (
                <Row key={t.id} status={t.status}>
                  <Cell>{t.title}</Cell>
                  <Cell muted>{t.client_name ?? '—'}</Cell>
                  <Cell muted>{t.period_label ?? '—'}</Cell>
                  <Cell muted>{human(t.category)}</Cell>
                  <Cell muted>{human(t.priority)}</Cell>
                  <Cell muted>{t.assigned_employee?.full_name ?? '—'}</Cell>
                  <Cell muted>{t.due_date ? fmtDate(t.due_date) : '—'}</Cell>
                  <Cell>
                    <select value={t.status} onChange={(e) => setStatus.mutate({ id: t.id, status: e.target.value })}
                      className="h-7 px-1 text-12 bg-white border border-neutral-300 rounded">
                      {(settings.data?.task_statuses ?? []).map((s) => <option key={s} value={s}>{human(s)}</option>)}
                    </select>
                  </Cell>
                </Row>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>

      <CreateModal open={open} title="New task" onClose={() => setOpen(false)}
        onSubmit={() => create.mutate()} pending={create.isPending} err={create.error}>
        <Field label="Client">
          <select className={inputClass} value={form.client_id ?? ''} onChange={(e) => setForm({ ...form, client_id: e.target.value })}>
            <option value="">Select…</option>
            {(clients.data?.items ?? []).map((c) => <option key={c.client_id} value={c.client_id}>{c.client_name}</option>)}
          </select>
        </Field>
        <Field label="Title">
          <input className={inputClass} value={form.title ?? ''} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label="Category">
          <select className={inputClass} value={form.category ?? 'other'} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {(settings.data?.task_categories ?? []).map((s) => <option key={s} value={s}>{human(s)}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select className={inputClass} value={form.priority ?? 'medium'} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            {(settings.data?.priorities ?? []).map((s) => <option key={s} value={s}>{human(s)}</option>)}
          </select>
        </Field>
        <Field label="Assign to">
          <select className={inputClass} value={form.assigned_employee_id ?? ''} onChange={(e) => setForm({ ...form, assigned_employee_id: e.target.value })}>
            <option value="">Select…</option>
            {(employees.data?.items ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
          </select>
        </Field>
        <Field label="Due date">
          <input type="date" className={inputClass} value={form.due_date ?? ''} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
        </Field>
      </CreateModal>
    </div>
  );
}

// ── Pending items ─────────────────────────────────────────────────────────
export function BookkeepingPendingItemsPage() {
  const { get, set } = useFilters();
  const qc = useQueryClient();
  const settings = useSettings();
  const employees = useEmployees();
  const clients = useBkClients();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  const filters = {
    q: get('q'), status: get('status'), priority: get('priority'),
    category: get('category'), client_id: get('client_id'), due: get('due'),
  };
  const items = useQuery({
    queryKey: ['bookkeeping', 'pending-items', filters],
    queryFn: () => bookkeepingApi.listPendingItems(filters),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bookkeeping', 'pending-items'] });
    void qc.invalidateQueries({ queryKey: ['bookkeeping', 'overview'] });
  };
  const create = useMutation({
    mutationFn: () => bookkeepingApi.createPendingItem(form),
    onSuccess: () => { setOpen(false); setForm({}); refresh(); },
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => bookkeepingApi.updatePendingItem(id, { status }),
    onSuccess: refresh,
  });

  return (
    <div>
      <PageHeader
        title="Pending Items" subtitle="What the firm is still waiting on from clients."
        action={<button onClick={() => setOpen(true)} className="h-8 px-3 text-13 bg-primary text-white rounded hover:bg-primaryHover">New item</button>}
      />
      <FilterBar>
        <SearchInput value={filters.q} onChange={(v) => set('q', v)} placeholder="Item title" />
        <Select label="Client" value={filters.client_id} onChange={(v) => set('client_id', v)}
          options={(clients.data?.items ?? []).map((c) => ({ value: c.client_id, label: c.client_name ?? '—' }))} />
        <Select label="Status" value={filters.status} onChange={(v) => set('status', v)} options={opts(settings.data?.pending_statuses)} />
        <Select label="Category" value={filters.category} onChange={(v) => set('category', v)} options={opts(settings.data?.pending_categories)} />
        <Select label="Priority" value={filters.priority} onChange={(v) => set('priority', v)} options={opts(settings.data?.priorities)} />
        <Select label="Due" value={filters.due} onChange={(v) => set('due', v)} options={[{ value: 'overdue', label: 'Overdue' }]} />
      </FilterBar>

      <Card>
        <QueryState query={items}>
          {(data) => data.items.length === 0 ? (
            <div className="px-4 py-6 text-13 text-neutral-500">Nothing outstanding.</div>
          ) : (
            <Table head={['Pending item', 'Client', 'Period', 'Category', 'Priority', 'Requested', 'Due', 'Status']}>
              {data.items.map((p) => (
                <Row key={p.id} status={p.status}>
                  <Cell>{p.title}</Cell>
                  <Cell muted>{p.client_name ?? '—'}</Cell>
                  <Cell muted>{p.period_label ?? '—'}</Cell>
                  <Cell muted>{human(p.category)}</Cell>
                  <Cell muted>{human(p.priority)}</Cell>
                  <Cell muted>{fmtDate(p.requested_date)}</Cell>
                  <Cell muted>{p.due_date ? fmtDate(p.due_date) : '—'}</Cell>
                  <Cell>
                    <select value={p.status} onChange={(e) => setStatus.mutate({ id: p.id, status: e.target.value })}
                      className="h-7 px-1 text-12 bg-white border border-neutral-300 rounded">
                      {(settings.data?.pending_statuses ?? []).map((s) => <option key={s} value={s}>{human(s)}</option>)}
                    </select>
                  </Cell>
                </Row>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>

      <CreateModal open={open} title="New pending item" onClose={() => setOpen(false)}
        onSubmit={() => create.mutate()} pending={create.isPending} err={create.error}>
        <Field label="Client">
          <select className={inputClass} value={form.client_id ?? ''} onChange={(e) => setForm({ ...form, client_id: e.target.value })}>
            <option value="">Select…</option>
            {(clients.data?.items ?? []).map((c) => <option key={c.client_id} value={c.client_id}>{c.client_name}</option>)}
          </select>
        </Field>
        <Field label="Title">
          <input className={inputClass} value={form.title ?? ''} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label="Category">
          <select className={inputClass} value={form.category ?? 'other'} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {(settings.data?.pending_categories ?? []).map((s) => <option key={s} value={s}>{human(s)}</option>)}
          </select>
        </Field>
        <Field label="Priority">
          <select className={inputClass} value={form.priority ?? 'medium'} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            {(settings.data?.priorities ?? []).map((s) => <option key={s} value={s}>{human(s)}</option>)}
          </select>
        </Field>
        <Field label="Assign to">
          <select className={inputClass} value={form.assigned_employee_id ?? ''} onChange={(e) => setForm({ ...form, assigned_employee_id: e.target.value })}>
            <option value="">Unassigned</option>
            {(employees.data?.items ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
          </select>
        </Field>
        <Field label="Due date">
          <input type="date" className={inputClass} value={form.due_date ?? ''} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
        </Field>
      </CreateModal>
    </div>
  );
}

// ── Document requests ─────────────────────────────────────────────────────
export function BookkeepingDocumentsPage() {
  const { get, set } = useFilters();
  const qc = useQueryClient();
  const settings = useSettings();
  const clients = useBkClients();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  const filters = { q: get('q'), status: get('status'), document_type: get('document_type'), client_id: get('client_id') };
  const reqs = useQuery({
    queryKey: ['bookkeeping', 'document-requests', filters],
    queryFn: () => bookkeepingApi.listDocumentRequests(filters),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bookkeeping', 'document-requests'] });
    void qc.invalidateQueries({ queryKey: ['bookkeeping', 'overview'] });
  };
  const create = useMutation({
    mutationFn: () => bookkeepingApi.createDocumentRequest(form),
    onSuccess: () => { setOpen(false); setForm({}); refresh(); },
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => bookkeepingApi.updateDocumentRequest(id, { status }),
    onSuccess: refresh,
  });

  return (
    <div>
      <PageHeader
        title="Documents"
        subtitle="Document requests. Files themselves live in the Workstation Documents module."
        action={<button onClick={() => setOpen(true)} className="h-8 px-3 text-13 bg-primary text-white rounded hover:bg-primaryHover">Request document</button>}
      />
      <FilterBar>
        <SearchInput value={filters.q} onChange={(v) => set('q', v)} placeholder="Description" />
        <Select label="Client" value={filters.client_id} onChange={(v) => set('client_id', v)}
          options={(clients.data?.items ?? []).map((c) => ({ value: c.client_id, label: c.client_name ?? '—' }))} />
        <Select label="Type" value={filters.document_type} onChange={(v) => set('document_type', v)} options={opts(settings.data?.document_types)} />
        <Select label="Status" value={filters.status} onChange={(v) => set('status', v)} options={opts(settings.data?.docreq_statuses)} />
      </FilterBar>

      <Card>
        <QueryState query={reqs}>
          {(data) => data.items.length === 0 ? (
            <div className="px-4 py-6 text-13 text-neutral-500">No document requests match these filters.</div>
          ) : (
            <Table head={['Document', 'Client', 'Period', 'Requested', 'Due', 'Received', 'File', 'Status']}>
              {data.items.map((d) => (
                <Row key={d.id} status={d.status}>
                  <Cell>{human(d.document_type)}</Cell>
                  <Cell muted>{d.client_name ?? '—'}</Cell>
                  <Cell muted>{d.period_label ?? '—'}</Cell>
                  <Cell muted>{d.requested_at ? fmtDate(d.requested_at.slice(0, 10)) : '—'}</Cell>
                  <Cell muted>{d.due_date ? fmtDate(d.due_date) : '—'}</Cell>
                  <Cell muted>{d.received_at ? fmtDate(d.received_at.slice(0, 10)) : '—'}</Cell>
                  <Cell muted>{d.client_document?.name ?? '—'}</Cell>
                  <Cell>
                    <select value={d.status} onChange={(e) => setStatus.mutate({ id: d.id, status: e.target.value })}
                      className="h-7 px-1 text-12 bg-white border border-neutral-300 rounded">
                      {(settings.data?.docreq_statuses ?? []).map((s) => <option key={s} value={s}>{human(s)}</option>)}
                    </select>
                  </Cell>
                </Row>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>

      <CreateModal open={open} title="Request a document" onClose={() => setOpen(false)}
        onSubmit={() => create.mutate()} pending={create.isPending} err={create.error}>
        <Field label="Client">
          <select className={inputClass} value={form.client_id ?? ''} onChange={(e) => setForm({ ...form, client_id: e.target.value })}>
            <option value="">Select…</option>
            {(clients.data?.items ?? []).map((c) => <option key={c.client_id} value={c.client_id}>{c.client_name}</option>)}
          </select>
        </Field>
        <Field label="Document type">
          <select className={inputClass} value={form.document_type ?? ''} onChange={(e) => setForm({ ...form, document_type: e.target.value })}>
            <option value="">Select…</option>
            {(settings.data?.document_types ?? []).map((s) => <option key={s} value={s}>{human(s)}</option>)}
          </select>
        </Field>
        <Field label="Description">
          <input className={inputClass} value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="Due date">
          <input type="date" className={inputClass} value={form.due_date ?? ''} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
        </Field>
      </CreateModal>
    </div>
  );
}

// ── Deliverables ──────────────────────────────────────────────────────────
export function BookkeepingDeliverablesPage() {
  const { get, set } = useFilters();
  const qc = useQueryClient();
  const settings = useSettings();
  const clients = useBkClients();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  const filters = { status: get('status'), type: get('type'), client_id: get('client_id') };
  const rows = useQuery({
    queryKey: ['bookkeeping', 'deliverables', filters],
    queryFn: () => bookkeepingApi.listDeliverables(filters),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bookkeeping', 'deliverables'] });
    void qc.invalidateQueries({ queryKey: ['bookkeeping', 'overview'] });
  };
  const create = useMutation({
    mutationFn: () => bookkeepingApi.createDeliverable(form),
    onSuccess: () => { setOpen(false); setForm({}); refresh(); },
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => bookkeepingApi.updateDeliverable(id, { status }),
    onSuccess: refresh,
  });

  return (
    <div>
      <PageHeader
        title="Deliverables"
        subtitle="What was prepared and sent. The figures themselves are produced by Books."
        action={<button onClick={() => setOpen(true)} className="h-8 px-3 text-13 bg-primary text-white rounded hover:bg-primaryHover">New deliverable</button>}
      />
      <FilterBar>
        <Select label="Client" value={filters.client_id} onChange={(v) => set('client_id', v)}
          options={(clients.data?.items ?? []).map((c) => ({ value: c.client_id, label: c.client_name ?? '—' }))} />
        <Select label="Type" value={filters.type} onChange={(v) => set('type', v)} options={opts(settings.data?.deliverable_types)} />
        <Select label="Status" value={filters.status} onChange={(v) => set('status', v)} options={opts(settings.data?.deliverable_statuses)} />
      </FilterBar>

      <Card>
        <QueryState query={rows}>
          {(data) => data.items.length === 0 ? (
            <div className="px-4 py-6 text-13 text-neutral-500">No deliverables match these filters.</div>
          ) : (
            <Table head={['Deliverable', 'Client', 'Period', 'Prepared by', 'Reviewed by', 'Delivered', 'Status']}>
              {data.items.map((d) => (
                <Row key={d.id} status={d.status}>
                  <Cell>{human(d.type)}</Cell>
                  <Cell muted>{d.client_name ?? '—'}</Cell>
                  <Cell muted>{d.period_label ?? '—'}</Cell>
                  <Cell muted>{d.prepared_by?.full_name ?? '—'}</Cell>
                  <Cell muted>{d.reviewed_by?.full_name ?? '—'}</Cell>
                  <Cell muted>{d.delivered_at ? fmtDate(d.delivered_at.slice(0, 10)) : '—'}</Cell>
                  <Cell>
                    <select value={d.status} onChange={(e) => setStatus.mutate({ id: d.id, status: e.target.value })}
                      className="h-7 px-1 text-12 bg-white border border-neutral-300 rounded">
                      {(settings.data?.deliverable_statuses ?? []).map((s) => <option key={s} value={s}>{human(s)}</option>)}
                    </select>
                  </Cell>
                </Row>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>

      <CreateModal open={open} title="New deliverable" onClose={() => setOpen(false)}
        onSubmit={() => create.mutate()} pending={create.isPending} err={create.error}>
        <Field label="Client">
          <select className={inputClass} value={form.client_id ?? ''} onChange={(e) => setForm({ ...form, client_id: e.target.value })}>
            <option value="">Select…</option>
            {(clients.data?.items ?? []).map((c) => <option key={c.client_id} value={c.client_id}>{c.client_name}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select className={inputClass} value={form.type ?? ''} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option value="">Select…</option>
            {(settings.data?.deliverable_types ?? []).map((s) => <option key={s} value={s}>{human(s)}</option>)}
          </select>
        </Field>
        <Field label="Notes">
          <input className={inputClass} value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
      </CreateModal>
    </div>
  );
}

// ── Reminders ─────────────────────────────────────────────────────────────
export function BookkeepingRemindersPage() {
  const { get, set } = useFilters();
  const qc = useQueryClient();
  const employees = useEmployees();
  const clients = useBkClients();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  const filters = { status: get('status'), client_id: get('client_id') };
  const rows = useQuery({
    queryKey: ['bookkeeping', 'reminders', filters],
    queryFn: () => bookkeepingApi.listReminders(filters),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['bookkeeping', 'reminders'] });
  const create = useMutation({
    mutationFn: () => bookkeepingApi.createReminder({
      ...form,
      scheduled_at: form.scheduled_at ? new Date(form.scheduled_at).toISOString() : '',
    }),
    onSuccess: () => { setOpen(false); setForm({}); refresh(); },
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => bookkeepingApi.updateReminder(id, { status }),
    onSuccess: refresh,
  });

  return (
    <div>
      <PageHeader
        title="Reminders"
        subtitle="Follow-ups for bookkeeping clients — the same Follow-ups the rest of Workstation uses."
        action={<button onClick={() => setOpen(true)} className="h-8 px-3 text-13 bg-primary text-white rounded hover:bg-primaryHover">New reminder</button>}
      />
      <FilterBar>
        <Select label="Client" value={filters.client_id} onChange={(v) => set('client_id', v)}
          options={(clients.data?.items ?? []).map((c) => ({ value: c.client_id, label: c.client_name ?? '—' }))} />
        <Select label="Status" value={filters.status} onChange={(v) => set('status', v)}
          options={opts(['pending', 'completed', 'rescheduled', 'cancelled', 'missed'])} />
      </FilterBar>

      <Card>
        <QueryState query={rows}>
          {(data) => data.items.length === 0 ? (
            <div className="px-4 py-6 text-13 text-neutral-500">No reminders scheduled.</div>
          ) : (
            <Table head={['Reminder', 'Client', 'Scheduled', 'Assigned to', 'Status']}>
              {data.items.map((r) => (
                <Row key={r.id} status={r.status}>
                  <Cell>{r.title}</Cell>
                  <Cell muted>{r.client_name ?? '—'}</Cell>
                  <Cell muted>{fmtDate(r.scheduled_at.slice(0, 10))}</Cell>
                  <Cell muted>{r.assigned_employee?.full_name ?? '—'}</Cell>
                  <Cell>
                    <select value={r.status} onChange={(e) => setStatus.mutate({ id: r.id, status: e.target.value })}
                      className="h-7 px-1 text-12 bg-white border border-neutral-300 rounded">
                      {['pending', 'completed', 'rescheduled', 'cancelled', 'missed'].map((s) => (
                        <option key={s} value={s}>{human(s)}</option>
                      ))}
                    </select>
                  </Cell>
                </Row>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>

      <CreateModal open={open} title="New reminder" onClose={() => setOpen(false)}
        onSubmit={() => create.mutate()} pending={create.isPending} err={create.error}>
        <Field label="Client">
          <select className={inputClass} value={form.client_id ?? ''} onChange={(e) => setForm({ ...form, client_id: e.target.value })}>
            <option value="">Select…</option>
            {(clients.data?.items ?? []).map((c) => <option key={c.client_id} value={c.client_id}>{c.client_name}</option>)}
          </select>
        </Field>
        <Field label="Title">
          <input className={inputClass} value={form.title ?? ''} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label="When">
          <input type="datetime-local" className={inputClass} value={form.scheduled_at ?? ''} onChange={(e) => setForm({ ...form, scheduled_at: e.target.value })} />
        </Field>
        <Field label="Assign to">
          <select className={inputClass} value={form.assigned_employee_id ?? ''} onChange={(e) => setForm({ ...form, assigned_employee_id: e.target.value })}>
            <option value="">Select…</option>
            {(employees.data?.items ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
          </select>
        </Field>
      </CreateModal>
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────────────
export function BookkeepingSettingsPage() {
  const settings = useSettings();
  return (
    <div>
      <PageHeader title="Settings" subtitle="The vocabulary this module validates against, served by the API." />
      <QueryState query={settings}>
        {(s) => (
          <div className="grid gap-4 md:grid-cols-2">
            <Card title="Monthly checklist template">
              <ol className="px-4 py-3 space-y-1">
                {s.checklist_template.map((c, i) => (
                  <li key={c} className="text-13 text-neutral-700 flex gap-2">
                    <span className="text-neutral-400 tabular-nums w-5">{i + 1}.</span>{c}
                  </li>
                ))}
              </ol>
            </Card>
            <Card title="Workflow steps">
              <ol className="px-4 py-3 space-y-1">
                {s.workflow_steps.map((c, i) => (
                  <li key={c} className="text-13 text-neutral-700 flex gap-2">
                    <span className="text-neutral-400 tabular-nums w-5">{i + 1}.</span>{c}
                  </li>
                ))}
              </ol>
            </Card>
            <Card title="Task categories">
              <div className="px-4 py-3 flex flex-wrap gap-1">
                {s.task_categories.map((c) => (
                  <span key={c} className="text-12 px-2 py-0.5 border border-neutral-200 rounded text-neutral-600">{human(c)}</span>
                ))}
              </div>
            </Card>
            <Card title="Pending item categories">
              <div className="px-4 py-3 flex flex-wrap gap-1">
                {s.pending_categories.map((c) => (
                  <span key={c} className="text-12 px-2 py-0.5 border border-neutral-200 rounded text-neutral-600">{human(c)}</span>
                ))}
              </div>
            </Card>
          </div>
        )}
      </QueryState>
    </div>
  );
}
