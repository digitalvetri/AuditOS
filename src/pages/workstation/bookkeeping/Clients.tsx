import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { bookkeepingApi } from '@/modules/bookkeeping/api';
import { workstationApi } from '@/modules/workstation/api';
import { human } from '@/modules/bookkeeping/format';
import type { GridCell, GridRow } from '@/modules/bookkeeping/types';
import {
  Card, Cell, Detail, Field, FilterBar, PageHeader, QueryState, Row, SearchInput,
  Select, Status, Table, inputClass, textareaClass,
} from '@/modules/workstation/components';
import { CreateModal } from './CreateModal';
import { fmtDate } from '@/lib/format';

/**
 * BOOKKEEPING CLIENTS — the period grid (spec §6.2).
 *
 * Clients down, twelve calendar months across, one cell per client-period.
 * This is the screen that makes silent drift visible: a client three months
 * behind that nobody noticed shows up as a row of unmarked cells.
 *
 * The old "one row per client with the current period label" list is gone
 * because the grid answers the same question and four more (which months
 * are open, which are overdue, which are closed, and — most importantly —
 * which are missing entirely).
 */

// Current Indian FY (Apr → Mar). Today is 2026-09-20 → FY 2026 (2026-27).
function currentFy(): number {
  const now = new Date();
  return now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

export function BookkeepingClientsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const fyStr = params.get('fy');
  const fy = fyStr && /^\d{4}$/.test(fyStr) ? Number(fyStr) : currentFy();
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

  const grid = useQuery({
    queryKey: ['bookkeeping', 'clients', 'grid', { fy, employeeId, q }],
    queryFn: () => bookkeepingApi.clientsGrid({ fy, employee_id: employeeId, q }),
  });
  const settings = useQuery({ queryKey: ['bookkeeping', 'settings'], queryFn: bookkeepingApi.settings });
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });

  // The full client book — a client only becomes a *bookkeeping* client once
  // an engagement opens, so the picker cannot be fed from the grid above.
  const allClients = useQuery({
    queryKey: ['workstation', 'clients', 'for-bookkeeping'],
    queryFn: () => workstationApi.listClients(),
    enabled: open,
  });
  // Two exclusions, for different reasons: a client that already has an
  // engagement would be rejected by the server with 409 (one per client), and
  // an inactive client is not someone whose books we would start keeping.
  const engaged = new Set((grid.data?.rows ?? []).map((r) => r.client_id));
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

  // Three FYs are enough for the selector — last FY (compliance queries),
  // this FY (default), next FY (planning ahead). Anything further and the
  // firm should filter another way.
  const fyOptions = [currentFy() - 1, currentFy(), currentFy() + 1].map((y) => ({
    value: String(y),
    label: `${y}-${String((y + 1) % 100).padStart(2, '0')}`,
  }));

  return (
    <div>
      <PageHeader
        title="Clients"
        subtitle="Every open client, every month of the year. A row of blanks is a client the firm has stopped keeping books for without noticing."
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
          label="Assigned to" value={employeeId} onChange={(v) => setParam('employee_id', v)}
          options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name }))}
        />
        <label className="block">
          <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
            Financial year
          </span>
          <select
            value={String(fy)}
            onChange={(e) => setParam('fy', e.target.value === String(currentFy()) ? '' : e.target.value)}
            className="h-8 px-2 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
          >
            {fyOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      </FilterBar>

      <Card>
        <QueryState query={grid}>
          {(data) => data.rows.length === 0 ? (
            <div className="px-4 py-6 text-13 text-neutral-500">
              No bookkeeping clients match these filters.
            </div>
          ) : (
            <ClientsPeriodGrid
              data={data}
              onOpenPeriod={(periodId) => navigate(`../monthly-work/${periodId}`)}
              onOpenClient={(clientId) => navigate(clientId)}
            />
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
        <Field label="Due offset (days after period end)" hint="Default 5. Weekend rolls to Monday.">
          <input
            type="number" min={0} max={60}
            className={inputClass} value={form.due_offset_days ?? '5'}
            onChange={(e) => setForm({ ...form, due_offset_days: e.target.value })}
          />
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

/**
 * The grid itself. Rendered as a plain HTML table so column widths line up
 * — the shared Table component is grid-based and cannot enforce a fixed
 * 12-column month strip. No new design tokens: only Cell shading and the
 * existing status vocabulary.
 */
function ClientsPeriodGrid({
  data,
  onOpenPeriod,
  onOpenClient,
}: {
  data: import('@/modules/bookkeeping/types').GridResponse;
  onOpenPeriod: (periodId: string) => void;
  onOpenClient: (clientId: string) => void;
}) {
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-13 border-collapse">
          <thead>
            <tr className="text-left border-b border-neutral-200">
              <th className="px-3 py-2 font-medium text-11 uppercase tracking-[0.06em] text-neutral-500 sticky left-0 bg-white">
                Client
              </th>
              {data.months.map((m) => (
                <th
                  key={`${m.year}-${m.month}`}
                  className="px-2 py-2 font-medium text-11 uppercase tracking-[0.06em] text-neutral-500 text-center tabular-nums"
                  title={`${m.label} ${m.year}`}
                >
                  {m.label}
                </th>
              ))}
              <th className="px-3 py-2 font-medium text-11 uppercase tracking-[0.06em] text-neutral-500 text-right">
                Owner
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <ClientGridRow
                key={row.engagement_id}
                row={row}
                onOpenPeriod={onOpenPeriod}
                onOpenClient={onOpenClient}
              />
            ))}
          </tbody>
        </table>
      </div>
      <GridLegend />
    </div>
  );
}

function ClientGridRow({
  row, onOpenPeriod, onOpenClient,
}: {
  row: GridRow;
  onOpenPeriod: (periodId: string) => void;
  onOpenClient: (clientId: string) => void;
}) {
  return (
    <tr className="border-b border-neutral-100 hover:bg-neutral-50">
      <td className="px-3 py-2 sticky left-0 bg-inherit">
        <button
          onClick={() => onOpenClient(row.client_id)}
          className="text-left text-13 text-neutral-900 hover:underline"
        >
          {row.client_name ?? '—'}
        </button>
      </td>
      {row.cells.map((cell) => (
        <GridCellView
          key={`${cell.year}-${cell.month}`}
          cell={cell}
          onOpenPeriod={onOpenPeriod}
        />
      ))}
      <td className="px-3 py-2 text-right text-12 text-neutral-500">
        {row.owner?.full_name ?? '—'}
      </td>
    </tr>
  );
}

function GridCellView({
  cell, onOpenPeriod,
}: { cell: GridCell; onOpenPeriod: (periodId: string) => void }) {
  const { glyph, tone, label } = cellPresentation(cell);
  const clickable = Boolean(cell.period_id);
  return (
    <td className="p-0 text-center align-middle">
      <button
        onClick={() => cell.period_id && onOpenPeriod(cell.period_id)}
        disabled={!clickable}
        title={label}
        className={
          'w-full h-8 text-13 tabular-nums flex items-center justify-center ' +
          (clickable ? 'cursor-pointer ' : 'cursor-default ') + tone
        }
      >
        {glyph}
      </button>
    </td>
  );
}

interface CellPresentation { glyph: string; tone: string; label: string }
function cellPresentation(cell: GridCell): CellPresentation {
  if (!cell.period_id) {
    return {
      glyph: '',
      tone: 'text-neutral-300',
      label: 'Not opened yet',
    };
  }
  if (cell.status === 'completed') {
    return {
      glyph: '✓',
      tone: 'text-neutral-500 hover:bg-neutral-100',
      label: 'Closed',
    };
  }
  if (cell.is_overdue) {
    return {
      glyph: '▍',
      tone: 'text-red-600 hover:bg-red-50',
      label: 'Overdue',
    };
  }
  return {
    glyph: '·',
    tone: 'text-neutral-700 hover:bg-neutral-100',
    label: `In progress · ${cell.status ?? ''}`,
  };
}

function GridLegend() {
  return (
    <div className="px-4 py-2 flex gap-4 text-11 text-neutral-500 border-t border-neutral-100">
      <span><span className="text-neutral-500">✓</span> closed</span>
      <span><span className="text-red-600">▍</span> overdue</span>
      <span><span className="text-neutral-700">·</span> in progress</span>
      <span className="text-neutral-400">blank not opened yet</span>
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
                  onClick={() => navigate(`/books?org=${data.books_org_id}`)}
                  className="h-8 px-3 text-13 bg-primary text-white rounded hover:bg-primaryHover"
                >
                  Open Books
                </button>
              ) : (
                <span className="text-12 text-neutral-500">No Zoho Books organisation mapped to this client yet</span>
              )
            }
          />

          <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6 mb-4">
            <Detail label="Status" value={<Status value={data.engagement.status} />} />
            <Detail label="Assigned to" value={data.engagement.assigned_employee?.full_name ?? '—'} />
            <Detail label="Service start" value={fmtDate(data.engagement.service_start_date)} />
            <Detail label="Billing" value={`${human(data.engagement.billing_frequency)} · +${data.engagement.due_offset_days}d`} />
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
                {(data.workflow_stages ?? []).map((stage) => (
                  <li key={stage.id} className="text-13 text-neutral-700 flex gap-2">
                    <span className="text-neutral-400 tabular-nums">{stage.sequence}.</span>{stage.name}
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
                    <Row key={p.id} status={p.status} onClick={() => navigate(`../monthly-work/${p.id}`)}>
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
