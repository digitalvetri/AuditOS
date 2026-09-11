import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { bookkeepingApi } from '@/modules/bookkeeping/api';
import { workstationApi } from '@/modules/workstation/api';
import { human, opts } from '@/modules/bookkeeping/format';
import {
  Card, Cell, Detail, Field, FilterBar, PageHeader, QueryState, Row, SearchInput,
  Select, Status, Table, inputClass, textareaClass,
} from '@/modules/workstation/components';
import { CreateModal } from './CreateModal';
import { fmtDate } from '@/lib/format';

/** The bookkeeping service client list (§8). */
export function BookkeepingClientsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const status = params.get('status') ?? '';
  const employeeId = params.get('employee_id') ?? '';
  const q = params.get('q') ?? '';

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };

  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  const clients = useQuery({
    queryKey: ['bookkeeping', 'clients', { status, employeeId, q }],
    queryFn: () => bookkeepingApi.listClients({ status, employee_id: employeeId, q }),
  });
  const settings = useQuery({ queryKey: ['bookkeeping', 'settings'], queryFn: bookkeepingApi.settings });
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });

  // The full client book — a client only becomes a *bookkeeping* client once
  // an engagement opens, so the picker cannot be fed from the list above.
  const allClients = useQuery({
    queryKey: ['workstation', 'clients', 'for-bookkeeping'],
    queryFn: () => workstationApi.listClients(),
    enabled: open,
  });
  // Two exclusions, for different reasons: a client that already has an
  // engagement would be rejected by the server with 409 (one per client), and
  // an inactive client is not someone whose books we would start keeping.
  // Every other status stays — the seed's own `pending_documents` client has
  // an engagement, so filtering to `active` would hide legitimate choices.
  const engaged = new Set((clients.data?.items ?? []).map((c) => c.client_id));
  const selectable = (allClients.data?.items ?? [])
    .filter((c) => !engaged.has(c.id) && c.status !== 'inactive');

  const create = useMutation({
    mutationFn: () => bookkeepingApi.createEngagement(form),
    onSuccess: () => {
      setOpen(false);
      setForm({});
      void qc.invalidateQueries({ queryKey: ['bookkeeping', 'clients'] });
      void qc.invalidateQueries({ queryKey: ['bookkeeping', 'overview'] });
    },
  });

  return (
    <div>
      <PageHeader
        title="Clients" subtitle="Clients whose books this firm keeps."
        action={
          <button
            onClick={() => setOpen(true)}
            className="h-8 px-3 text-13 bg-primary text-white rounded hover:bg-primaryHover"
          >
            Add client
          </button>
        }
      />
      <FilterBar>
        <SearchInput value={q} onChange={(v) => setParam('q', v)} placeholder="Client name" />
        <Select
          label="Status" value={status} onChange={(v) => setParam('status', v)}
          options={opts(settings.data?.engagement_statuses)}
        />
        <Select
          label="Assigned to" value={employeeId} onChange={(v) => setParam('employee_id', v)}
          options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name }))}
        />
      </FilterBar>

      <Card>
        <QueryState query={clients}>
          {(data) => data.items.length === 0 ? (
            <div className="px-4 py-6 text-13 text-neutral-500">
              No bookkeeping clients match these filters.
            </div>
          ) : (
            <Table head={['Client', 'Service Status', 'Current Period', 'Pending Items', 'Next Due', 'Assigned To', 'Books', '']}>
              {data.items.map((c) => (
                <Row key={c.id} status={c.status} onClick={() => navigate(c.client_id)}>
                  <Cell>{c.client_name ?? '—'}</Cell>
                  <Cell><Status value={c.status} /></Cell>
                  <Cell muted>{c.current_period ?? '—'}</Cell>
                  <Cell muted>{c.pending_items === 0 ? '—' : `${c.pending_items} pending`}</Cell>
                  <Cell muted>{c.next_due_date ? fmtDate(c.next_due_date) : '—'}</Cell>
                  <Cell muted>{c.assigned_employee?.full_name ?? '—'}</Cell>
                  <Cell>
                    {c.books_org_id ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); navigate(`/books/${c.books_org_id}`); }}
                        className="text-12 text-gold hover:underline"
                      >
                        Open Books
                      </button>
                    ) : <span className="text-12 text-neutral-400">No books</span>}
                  </Cell>
                  <Cell muted className="text-12">Open →</Cell>
                </Row>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>

      <CreateModal
        open={open} title="Add bookkeeping client" onClose={() => setOpen(false)}
        onSubmit={() => create.mutate()} pending={create.isPending} err={create.error}
        submitLabel="Add client"
      >
        <Field
          label="Client"
          hint={
            allClients.isLoading ? 'Loading the client book…'
              : selectable.length === 0 ? 'Every active client already has a bookkeeping engagement.'
                : 'Only clients without an engagement are listed.'
          }
        >
          <select
            className={inputClass} value={form.client_id ?? ''}
            onChange={(e) => setForm({ ...form, client_id: e.target.value })}
          >
            <option value="">Select…</option>
            {selectable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.company_name}{c.status === 'active' ? '' : ` · ${human(c.status)}`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Service start date">
          <input
            type="date" className={inputClass} value={form.service_start_date ?? ''}
            onChange={(e) => setForm({ ...form, service_start_date: e.target.value })}
          />
        </Field>
        <Field label="Assign to">
          <select
            className={inputClass} value={form.assigned_employee_id ?? ''}
            onChange={(e) => setForm({ ...form, assigned_employee_id: e.target.value })}
          >
            <option value="">Select…</option>
            {(employees.data?.items ?? []).map((e) => (
              <option key={e.id} value={e.id}>{e.full_name}</option>
            ))}
          </select>
        </Field>
        <Field label="Billing frequency">
          <select
            className={inputClass} value={form.billing_frequency ?? 'monthly'}
            onChange={(e) => setForm({ ...form, billing_frequency: e.target.value })}
          >
            {(settings.data?.billing_frequencies ?? []).map((s) => (
              <option key={s} value={s}>{human(s)}</option>
            ))}
          </select>
        </Field>
        <Field label="Next due date" hint="Optional — leave empty to set it when the first period opens.">
          <input
            type="date" className={inputClass} value={form.next_due_date ?? ''}
            onChange={(e) => setForm({ ...form, next_due_date: e.target.value })}
          />
        </Field>
        <Field label="Notes">
          <textarea
            rows={3} className={textareaClass} value={form.notes ?? ''}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </Field>
      </CreateModal>
    </div>
  );
}

/** Client detail (§9) — status, assignment, periods, and the Books handoff. */
export function BookkeepingClientDetailPage() {
  const { clientId = '' } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'overview' | 'periods' | 'activity'>('overview');

  const detail = useQuery({
    queryKey: ['bookkeeping', 'client', clientId],
    queryFn: () => bookkeepingApi.client(clientId),
  });
  const activity = useQuery({
    queryKey: ['bookkeeping', 'client', clientId, 'activity'],
    queryFn: () => bookkeepingApi.clientActivity(clientId),
    enabled: tab === 'activity',
  });

  return (
    <QueryState query={detail}>
      {(data) => (
        <div>
          <PageHeader
            title={data.engagement.client_name ?? 'Client'}
            subtitle={<span className="text-neutral-500">Bookkeeping · {data.engagement.client_code ?? '—'}</span>}
            action={
              data.books_org_id ? (
                <button
                  onClick={() => navigate(`/books/${data.books_org_id}`)}
                  className="h-8 px-3 text-13 bg-primary text-white rounded hover:bg-primaryHover"
                >
                  Open Books
                </button>
              ) : (
                <span className="text-12 text-neutral-500">No set of books for this client yet</span>
              )
            }
          />

          <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6 mb-4">
            <Detail label="Status" value={<Status value={data.engagement.status} />} />
            <Detail label="Assigned to" value={data.engagement.assigned_employee?.full_name ?? '—'} />
            <Detail label="Service start" value={fmtDate(data.engagement.service_start_date)} />
            <Detail label="Billing" value={human(data.engagement.billing_frequency)} />
            <Detail label="Current period" value={data.periods[0]?.label ?? '—'} />
            <Detail label="Next due" value={data.engagement.next_due_date ? fmtDate(data.engagement.next_due_date) : '—'} />
          </div>

          <nav className="flex gap-1 border-b border-neutral-200 mb-3">
            {(['overview', 'periods', 'activity'] as const).map((t) => (
              <button
                key={t} onClick={() => setTab(t)}
                className={'px-3 h-8 text-13 border-b-2 -mb-px ' + (tab === t
                  ? 'border-gold text-neutral-900 font-medium'
                  : 'border-transparent text-neutral-500 hover:text-neutral-900')}
              >
                {human(t)}
              </button>
            ))}
          </nav>

          {tab === 'overview' ? (
            <Card title="Monthly workflow">
              <ol className="px-4 py-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                {data.workflow_steps.map((s, i) => (
                  <li key={s} className="text-13 text-neutral-700 flex gap-2">
                    <span className="text-neutral-400 tabular-nums">{i + 1}.</span>{s}
                  </li>
                ))}
              </ol>
            </Card>
          ) : null}

          {tab === 'periods' ? (
            <Card>
              {data.periods.length === 0 ? (
                <div className="px-4 py-6 text-13 text-neutral-500">No periods opened yet.</div>
              ) : (
                <Table head={['Period', 'Status', 'Progress', 'Due', 'Completed', 'Assigned to']}>
                  {data.periods.map((p) => (
                    <Row key={p.id} status={p.status} onClick={() => navigate(`../../monthly-work/${p.id}`)}>
                      <Cell>{p.label}</Cell>
                      <Cell><Status value={p.status} /></Cell>
                      <Cell muted>{p.progress ? `${p.progress.percent}%` : '—'}</Cell>
                      <Cell muted>{p.due_date ? fmtDate(p.due_date) : '—'}</Cell>
                      <Cell muted>{p.completed_date ? fmtDate(p.completed_date.slice(0, 10)) : '—'}</Cell>
                      <Cell muted>{p.assigned_employee?.full_name ?? '—'}</Cell>
                    </Row>
                  ))}
                </Table>
              )}
            </Card>
          ) : null}

          {tab === 'activity' ? (
            <Card>
              <QueryState query={activity}>
                {(a) => a.items.length === 0 ? (
                  <div className="px-4 py-6 text-13 text-neutral-500">No activity recorded yet.</div>
                ) : (
                  <ul className="divide-y divide-neutral-200">
                    {a.items.map((e) => (
                      <li key={e.id} className="px-4 py-2">
                        <div className="text-13 text-neutral-900">{e.action}</div>
                        <div className="text-12 text-neutral-500">
                          {e.detail}{e.created_at ? ` · ${fmtDate(e.created_at.slice(0, 10))}` : ''}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </QueryState>
            </Card>
          ) : null}
        </div>
      )}
    </QueryState>
  );
}
