/**
 * GST client dashboard — GST-CLIENT-DASHBOARD-TASKS §1 / §5.
 *
 * Clicking GST lands here. One row per GSTIN with three return cells
 * (GSTR-1, IMS + 2B, GSTR-3B) for the selected period. Each cell shows
 * state + date + optional ARN; clicking a cell opens that (client,
 * kind, period) PartnershipCase. Clicking the row opens the client view.
 *
 * Monthly and quarterly are separated by a filter so their different
 * calendars do not look like one is "permanently behind" — a quarterly
 * client in a non-quarter-end month shows '—', not 'overdue'.
 *
 * The previous overview + '1 › 2B › Recon › 3B' chain dashboard is
 * replaced by this. The Dashboard tab is the landing surface again, just
 * with the right shape.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Check, Circle, AlertTriangle, Mail, X } from 'lucide-react';
import {
  Card, PageHeader, QueryState, Table, Row, Cell, FilterBar, SearchInput,
} from '@/modules/workstation/components';
import {
  gstApi, periodLabel, recentPeriods,
  type ClientDashboardRow, type ClientDashboardCell, type UpcomingReminderRow,
} from '@/modules/workstation/gst/api';
import { workstationApi } from '@/modules/workstation/api';
import { SERVICES } from '../partnership/shared';
import type { RegistrationKind } from '@/modules/partnership/api';

type Filter = 'all' | 'monthly' | 'quarterly' | 'needs_action';

const FOCUS_LABEL: Record<'GSTR1' | 'GSTR2B' | 'GSTR3B', { title: string; subtitle: string }> = {
  GSTR1: { title: 'GSTR-1 clients', subtitle: 'Every GST client with their GSTR-1 status for the selected period. Click a row to open the client view.' },
  GSTR2B: { title: 'IMS + GSTR-2B clients', subtitle: 'Every GST client with their 2B reconciliation status for the selected period. Click a row to open the client view.' },
  GSTR3B: { title: 'GSTR-3B clients', subtitle: 'Every GST client with their GSTR-3B status for the selected period. Click a row to open the client view.' },
};

/**
 * @param focusKind — when set, the same table is shown but the header names
 *   the specific return and the client view is the row-click target. This
 *   is what lets `/gst/gstr1`, `/gst/gstr2b`, `/gst/gstr3b` and `/gst/dashboard`
 *   converge on one component instead of the older case-list flow, so a
 *   client shows the same details from every entry point.
 */
export function GstDashboard({ focusKind }: { focusKind?: 'GSTR1' | 'GSTR2B' | 'GSTR3B' } = {}) {
  const navigate = useNavigate();
  const periods = recentPeriods(12);
  const defaultPeriod = periods[0]?.value ?? new Date().toISOString().slice(0, 7);
  const [period, setPeriod] = useState(defaultPeriod);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');

  const dash = useQuery({
    queryKey: ['gst', 'client-dashboard', period],
    queryFn: () => gstApi.clientDashboard(period),
  });

  // Resolve assignee names once per page view — fed into every row of the
  // Client progress table so operators see "Vikram" instead of a UUID.
  const employees = useQuery({
    queryKey: ['workstation', 'assignable-employees'],
    queryFn: () => workstationApi.assignableEmployees(),
    staleTime: 5 * 60_000,
  });
  const assigneeNameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of employees.data?.items ?? []) map.set(e.id, e.full_name);
    return (id: string | null) => (id ? map.get(id) ?? null : null);
  }, [employees.data]);

  const openCase = useMutation({
    mutationFn: async ({ row, kind }: { row: ClientDashboardRow; kind: RegistrationKind }) => {
      const svc = SERVICES[kind];
      const cell = kind === 'GSTR1' ? row.gstr1 : kind === 'GSTR2B' ? row.gstr2b : row.gstr3b;
      // Case already exists → just navigate. Otherwise open-for-period and
      // then navigate to the fresh case.
      if (cell?.case_id) return { url: svc.caseUrl(cell.case_id) };
      const r = await svc.api.openForPeriod({
        client_id: row.client_id, period,
        period_type: row.filing_frequency === 'quarterly' ? 'quarterly' : 'monthly',
      });
      return { url: svc.caseUrl(r.id) };
    },
    onSuccess: (r) => navigate(r.url),
    onError: (e) => window.alert(e instanceof Error ? e.message : 'Could not open case'),
  });

  const shifted = (dir: -1 | 1) => {
    const idx = periods.findIndex((p) => p.value === period);
    const next = periods[idx + (dir === 1 ? -1 : 1)];
    if (next) setPeriod(next.value);
  };

  const filtered = useMemo(() => {
    const rows = dash.data?.clients ?? [];
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === 'monthly' && r.filing_frequency !== 'monthly') return false;
      if (filter === 'quarterly' && r.filing_frequency !== 'quarterly') return false;
      if (filter === 'needs_action') {
        const anyOverdue = [r.gstr1, r.gstr2b, r.gstr3b].some((c) => c?.state === 'overdue' || c?.state === 'due');
        if (!anyOverdue) return false;
      }
      if (needle && !r.name.toLowerCase().includes(needle) && !r.gstin.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [dash.data, filter, q]);

  return (
    <div className="m-gst space-y-4">
      <div className="flex items-start justify-between gap-3">
        <PageHeader
          title={focusKind ? FOCUS_LABEL[focusKind].title : 'GST'}
          subtitle={focusKind ? FOCUS_LABEL[focusKind].subtitle : "Every client's GSTR-1 → GSTR-2B → GSTR-3B for the selected period."}
        />
        <div className="flex items-center gap-1 shrink-0">
          <button type="button" onClick={() => shifted(-1)} aria-label="Previous period"
                  className="h-9 w-9 text-13 border border-neutral-300 rounded hover:border-neutral-400">◂</button>
          <select className="h-9 px-2 text-13 bg-white border border-neutral-300 rounded"
                  value={period} onChange={(e) => setPeriod(e.target.value)}>
            {periods.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <button type="button" onClick={() => shifted(1)} aria-label="Next period"
                  className="h-9 w-9 text-13 border border-neutral-300 rounded hover:border-neutral-400">▸</button>
        </div>
      </div>

      <QueryState query={dash}>
        {(d) => {
          const periodReturns = clientReturnStats(d.clients);
          const tiles: Array<[label: string, value: number, filter: Filter | '', tone?: 'red' | 'amber']> = [
            ['Total GSTINs', d.counters.total_clients, ''],
            ['Monthly', d.counters.monthly, 'monthly'],
            ['Quarterly', d.counters.quarterly, 'quarterly'],
            ['Returns filed', periodReturns.filed, ''],
            ['Overdue', d.counters.overdue, 'needs_action', 'red'],
            ['Due ≤ 3 days', d.counters.due_soon, 'needs_action', 'amber'],
          ];
          return (
            <>
              {/* Summary tiles — same visual as the Private Limited dashboard. */}
              <div className="reg-tiles grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                {tiles.map(([label, value, f, tone]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => f && setFilter(f as Filter)}
                    disabled={!f}
                    className="reg-tile bg-white border border-neutral-200 rounded-lg px-4 py-3 text-left hover:border-primary/40 hover:shadow-raised transition-all disabled:cursor-default disabled:hover:border-neutral-200 disabled:hover:shadow-none"
                  >
                    <div className="text-12 text-neutral-500">{label}</div>
                    <div className={
                      'text-[24px] leading-tight font-semibold mt-1 tabular-nums ' +
                      (tone === 'red' && value > 0 ? 'text-red'
                        : tone === 'amber' && value > 0 ? 'text-amber'
                        : 'text-neutral-900')
                    }>{value}</div>
                  </button>
                ))}
              </div>

              <UpcomingRemindersPanel period={period} />

              <Card
                title={`Client progress — ${periodLabel(period)}`}
                right={<span className="text-12 text-neutral-500">{filtered.length} of {d.clients.length}</span>}
              >
                <FilterBar>
                  <SearchInput value={q} onChange={setQ} placeholder="Client or GSTIN" />
                  <div className="flex flex-wrap items-center gap-1">
                    {([
                      ['all', 'All'],
                      ['monthly', 'Monthly'],
                      ['quarterly', 'Quarterly'],
                      ['needs_action', 'Needs action'],
                    ] as const).map(([key, label]) => (
                      <button key={key} type="button" onClick={() => setFilter(key)}
                              className={
                                'px-3 h-8 text-13 rounded border ' +
                                (filter === key
                                  ? 'bg-primary text-white border-primary'
                                  : 'bg-white text-neutral-700 border-neutral-300 hover:border-neutral-400')
                              }>
                        {label}
                      </button>
                    ))}
                  </div>
                </FilterBar>
                {filtered.length === 0 ? (
                  <div className="px-4 py-6 text-13 text-neutral-500">No clients match these filters.</div>
                ) : (
                  <Table head={['Client', 'Filing', 'Returns', 'Status', 'Next due', 'Assigned']}>
                    {filtered.map((r) => (
                      <GstClientRow
                        key={r.client_id}
                        row={r}
                        assigneeName={assigneeNameOf(r.assigned_employee_id)}
                        onOpenClient={() => navigate(`../clients/${r.client_id}`)}
                        onOpenCase={(kind) => openCase.mutate({ row: r, kind })}
                        openCasePending={openCase.isPending}
                      />
                    ))}
                  </Table>
                )}
                <div className="px-4 py-2 text-11 text-neutral-500 border-t border-neutral-100">
                  Click a client to open the client view, or click a return pill to open that case.
                </div>
              </Card>
            </>
          );
        }}
      </QueryState>
    </div>
  );
}

/**
 * Count how many return cells across every client are already filed vs
 * pending for the selected period. Used by the top tiles — "4 of 15 filed"
 * is more useful than any single-column average.
 */
function clientReturnStats(rows: ClientDashboardRow[]): { filed: number; applicable: number } {
  let filed = 0;
  let applicable = 0;
  for (const r of rows) {
    for (const k of ['gstr1', 'gstr2b', 'gstr3b'] as const) {
      const c = r[k];
      if (!c) continue;
      applicable += 1;
      if (c.state === 'done') filed += 1;
    }
  }
  return { filed, applicable };
}

const KIND_LABEL: Record<'GSTR1' | 'GSTR2B' | 'GSTR3B', string> = {
  GSTR1: 'GSTR-1', GSTR2B: 'IMS + 2B', GSTR3B: 'GSTR-3B',
};

const RETURN_KEYS: Array<['gstr1' | 'gstr2b' | 'gstr3b', 'GSTR1' | 'GSTR2B' | 'GSTR3B']> = [
  ['gstr1', 'GSTR1'],
  ['gstr2b', 'GSTR2B'],
  ['gstr3b', 'GSTR3B'],
];

/**
 * Render a tiny ✓ / ! / ○ pill per return cell so the row shows the whole
 * cycle at a glance: "G1 ✓ · 2B ✓ · 3B ○" instead of three cryptic dates.
 */
function ReturnPills({ row, onOpenCase, busy }: {
  row: ClientDashboardRow;
  onOpenCase: (kind: 'GSTR1' | 'GSTR2B' | 'GSTR3B') => void;
  busy: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-1">
      {RETURN_KEYS.map(([k, kind]) => {
        const cell = row[k];
        const short = kind === 'GSTR1' ? 'G1' : kind === 'GSTR2B' ? '2B' : '3B';
        if (!cell) {
          return (
            <span key={k} title={`${KIND_LABEL[kind]} — not due`} className="inline-flex items-center h-6 px-1.5 rounded bg-neutral-100 text-neutral-400 text-11 font-semibold">
              {short}
            </span>
          );
        }
        const chip =
          cell.state === 'done' ? 'bg-success/10 text-success hover:bg-success/15'
          : cell.state === 'overdue' ? 'bg-danger/10 text-danger hover:bg-danger/15'
          : cell.state === 'due' ? 'bg-warning/10 text-warning hover:bg-warning/15'
          : 'bg-neutral-100 text-inkMuted hover:bg-neutral-200';
        const Icon = cell.state === 'done' ? Check : cell.state === 'overdue' ? AlertTriangle : Circle;
        return (
          <button
            key={k}
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpenCase(kind); }}
            disabled={busy}
            title={`${KIND_LABEL[kind]} — ${cell.state === 'done' ? 'filed' : cell.state === 'overdue' ? 'overdue' : cell.state === 'due' ? 'due' : 'not started'}`}
            className={'inline-flex items-center gap-1 h-6 px-1.5 rounded text-11 font-semibold transition-colors disabled:opacity-60 ' + chip}
          >
            <Icon size={11} strokeWidth={2.4} />
            {short}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Pick the single most urgent pending return and render it as a sentence —
 * "GSTR-3B · 22 Oct · in 7 days" or "GSTR-1 · 8 days overdue" — so the
 * operator reads what they need to do, not a raw date.
 */
function NextDue({ row }: { row: ClientDashboardRow }) {
  const applicable = RETURN_KEYS
    .map(([k, kind]) => ({ kind, cell: row[k] }))
    .filter((x): x is { kind: 'GSTR1' | 'GSTR2B' | 'GSTR3B'; cell: ClientDashboardCell } =>
      !!x.cell && x.cell.state !== 'done');
  if (applicable.length === 0) return <span className="text-12 text-neutral-500">All filed</span>;

  // Overdue wins; then the earliest due date.
  const overdue = applicable.find((x) => x.cell.state === 'overdue');
  const pick = overdue ?? applicable
    .filter((x) => x.cell.due_date)
    .sort((a, b) => (a.cell.due_date! < b.cell.due_date! ? -1 : 1))[0] ?? applicable[0];
  const cell = pick.cell;
  const date = cell.due_date;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dueMs = date ? Date.parse(date + 'T00:00:00') : null;
  const days = dueMs !== null ? Math.round((dueMs - today.getTime()) / 86_400_000) : null;
  const dateStr = date
    ? new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
    : '—';
  const label =
    cell.state === 'overdue' && days !== null
      ? `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`
      : days === null ? ''
      : days === 0 ? 'today'
      : days < 0 ? `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`
      : `in ${days} day${days === 1 ? '' : 's'}`;
  const tint =
    cell.state === 'overdue' ? 'text-danger'
    : days !== null && days <= 3 ? 'text-warning'
    : 'text-neutral-700';
  return (
    <div className="min-w-0">
      <div className="text-13 font-medium text-neutral-900">{KIND_LABEL[pick.kind]}</div>
      <div className={`text-12 ${tint}`}>{dateStr}{label ? ` · ${label}` : ''}</div>
    </div>
  );
}

/**
 * Derived single-line status for a client row.
 */
function statusLabel(row: ClientDashboardRow): { label: string; tint: string } {
  const cells = RETURN_KEYS.map(([k]) => row[k]).filter((c): c is ClientDashboardCell => !!c);
  if (cells.length === 0) return { label: 'Not due', tint: 'bg-neutral-100 text-neutral-500' };
  if (cells.some((c) => c.state === 'overdue')) return { label: 'Overdue', tint: 'bg-danger/10 text-danger' };
  if (cells.every((c) => c.state === 'done')) return { label: 'All filed', tint: 'bg-success/10 text-success' };
  if (cells.some((c) => c.state === 'due')) return { label: 'Due soon', tint: 'bg-warning/10 text-warning' };
  const done = cells.filter((c) => c.state === 'done').length;
  if (done > 0) return { label: `In progress ${done}/${cells.length}`, tint: 'bg-info/10 text-info' };
  return { label: 'Not started', tint: 'bg-neutral-100 text-neutral-600' };
}

function GstClientRow({ row, assigneeName, onOpenClient, onOpenCase, openCasePending }: {
  row: ClientDashboardRow;
  assigneeName: string | null;
  onOpenClient: () => void;
  onOpenCase: (kind: 'GSTR1' | 'GSTR2B' | 'GSTR3B') => void;
  openCasePending: boolean;
}) {
  const status = statusLabel(row);
  return (
    <Row onClick={onOpenClient}>
      <Cell>
        <div className="font-medium text-neutral-900">{row.name}</div>
        <div className="text-11 font-mono text-neutral-500">{row.gstin}</div>
      </Cell>
      <Cell muted className="capitalize">{row.filing_frequency}</Cell>
      <Cell>
        <ReturnPills row={row} onOpenCase={onOpenCase} busy={openCasePending} />
      </Cell>
      <Cell>
        <span className={`inline-flex items-center h-6 px-2 rounded-full text-11 font-semibold whitespace-nowrap ${status.tint}`}>{status.label}</span>
      </Cell>
      <Cell>
        <NextDue row={row} />
      </Cell>
      <Cell muted>{assigneeName ?? '—'}</Cell>
    </Row>
  );
}

/**
 * Upcoming reminders panel — the top-of-dashboard surface that lists every
 * return in the operator's visible set that is due within three days or
 * already overdue. Mirrors the data the scheduled job uses for bell
 * notifications so the operator sees the same list in context, with a
 * "Send to client" affordance on each row.
 */
function UpcomingRemindersPanel({ period }: { period: string }) {
  const [sendTarget, setSendTarget] = useState<UpcomingReminderRow | null>(null);
  const q = useQuery({
    queryKey: ['gst', 'reminders', 'upcoming', period],
    queryFn: () => gstApi.upcomingReminders(period),
  });
  const items = q.data?.items ?? [];
  if (q.isLoading || items.length === 0) return null;
  const overdueCount = items.filter((i) => i.state === 'overdue').length;
  const dueCount = items.length - overdueCount;
  return (
    <>
      <Card className="p-3">
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="text-13 font-semibold text-neutral-800">
            Upcoming reminders
            <span className="text-11 font-normal text-neutral-500 ml-2">
              {overdueCount > 0 ? <span className="text-red">{overdueCount} overdue · </span> : null}
              {dueCount} due in the next 3 days
            </span>
          </div>
        </div>
        <ul className="divide-y divide-neutral-100">
          {items.map((item) => {
            const pill =
              item.state === 'overdue'
                ? 'bg-danger/10 text-danger'
                : 'bg-warning/10 text-warning';
            const label =
              item.state === 'overdue'
                ? `${Math.abs(item.days_to_due)} day${Math.abs(item.days_to_due) === 1 ? '' : 's'} overdue`
                : item.days_to_due === 0
                  ? 'due today'
                  : `due in ${item.days_to_due} day${item.days_to_due === 1 ? '' : 's'}`;
            return (
              <li key={item.key} className="py-2 flex items-center gap-3">
                <span className={`text-11 px-2 py-0.5 rounded-full font-semibold whitespace-nowrap ${pill}`}>{label}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-13 text-neutral-900 truncate">{item.client_name}</div>
                  <div className="text-11 text-neutral-500 truncate">
                    {item.kind.replace('GSTR', 'GSTR-')} · {periodLabel(item.period)} · due {new Date(`${item.due_date}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' })}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSendTarget(item)}
                  className="h-7 px-2 text-11 border border-neutral-300 rounded hover:border-neutral-500 inline-flex items-center gap-1"
                  title={item.client_email ? `Send reminder to ${item.client_email}` : 'Send reminder (client email will be collected)'}
                >
                  <Mail size={11} strokeWidth={2} />
                  Send reminder
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
      {sendTarget ? <SendReminderModal row={sendTarget} onClose={() => setSendTarget(null)} /> : null}
    </>
  );
}

/**
 * Send modal — pre-fills subject + body from the backend template, and
 * uses the client record's email as the recipient default. The operator
 * can override any field before sending. On success the modal closes with
 * a lightweight success note; on failure (SMTP missing, bad address,
 * network) the error renders inline so nothing is silently dropped.
 */
function SendReminderModal({ row, onClose }: { row: UpcomingReminderRow; onClose: () => void }) {
  const tpl = useQuery({
    queryKey: ['gst', 'reminders', 'template', row.client_id, row.kind, row.period, row.due_date],
    queryFn: () => gstApi.reminderTemplate({
      client_id: row.client_id, kind: row.kind, period: row.period, due_date: row.due_date,
    }),
  });
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sent, setSent] = useState<{ to: string; at: string } | null>(null);

  // Pre-fill once the template loads.
  useMemo(() => {
    if (tpl.data) {
      setTo((prev) => prev || tpl.data!.to || '');
      setSubject((prev) => prev || tpl.data!.subject || '');
      setBody((prev) => prev || tpl.data!.body || '');
    }
  }, [tpl.data]);

  const send = useMutation({
    mutationFn: () => gstApi.sendReminder({
      client_id: row.client_id, kind: row.kind, period: row.period, due_date: row.due_date,
      case_id: row.case_id ?? undefined, to, subject, body,
    }),
    onSuccess: (r) => setSent({ to: r.to, at: r.sentAt }),
  });
  const err = send.error instanceof Error ? send.error.message : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded shadow-lg w-full max-w-[640px] max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-neutral-200 flex items-center justify-between">
          <div>
            <h2 className="text-14 font-semibold text-neutral-900">Send reminder — {row.client_name}</h2>
            <p className="text-11 text-neutral-500 mt-0.5">
              {row.kind.replace('GSTR', 'GSTR-')} · {periodLabel(row.period)} · due {new Date(`${row.due_date}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-neutral-400 hover:text-neutral-700"><X size={16} /></button>
        </div>

        {sent ? (
          <div className="p-6 flex-1">
            <div className="text-13 text-neutral-800">Reminder sent to <strong>{sent.to}</strong>.</div>
            <div className="text-11 text-neutral-500 mt-1">{new Date(sent.at).toLocaleString('en-IN')}</div>
            <div className="mt-4"><button type="button" onClick={onClose} className="h-8 px-3 text-12 bg-neutral-900 text-white rounded">Close</button></div>
          </div>
        ) : tpl.isLoading ? (
          <div className="p-6 text-13 text-neutral-500 flex-1">Loading template…</div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <label className="block text-11 text-neutral-500">
                To
                <input value={to} onChange={(e) => setTo(e.target.value)} type="email" placeholder="client@example.com"
                  className="mt-1 h-8 w-full px-2 text-12 border border-neutral-300 rounded focus:outline-none focus:border-neutral-500" />
                {!row.client_email ? <span className="text-11 text-amber-600 block mt-1">No email on the client record — enter one to send.</span> : null}
              </label>
              <label className="block text-11 text-neutral-500">
                Subject
                <input value={subject} onChange={(e) => setSubject(e.target.value)}
                  className="mt-1 h-8 w-full px-2 text-12 border border-neutral-300 rounded focus:outline-none focus:border-neutral-500" />
              </label>
              <label className="block text-11 text-neutral-500">
                Message
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10}
                  className="mt-1 w-full px-2 py-1 text-12 font-sans border border-neutral-300 rounded focus:outline-none focus:border-neutral-500" />
              </label>
              {err ? <div className="text-12 text-danger">{err}</div> : null}
            </div>
            <div className="px-4 py-3 border-t border-neutral-200 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="h-8 px-3 text-12 border border-neutral-300 rounded">Cancel</button>
              <button type="button" onClick={() => send.mutate()}
                disabled={!to.trim() || !subject.trim() || !body.trim() || send.isPending}
                className="h-8 px-3 text-12 bg-neutral-900 text-white rounded disabled:opacity-60 inline-flex items-center gap-1">
                <Mail size={11} strokeWidth={2} /> {send.isPending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
