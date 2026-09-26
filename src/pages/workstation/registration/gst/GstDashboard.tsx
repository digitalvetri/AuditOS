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
import { Check, Circle, AlertTriangle } from 'lucide-react';
import {
  Card, PageHeader, QueryState, Table, Row, Cell, FilterBar, SearchInput,
} from '@/modules/workstation/components';
import {
  gstApi, periodLabel, recentPeriods,
  type ClientDashboardRow, type ClientDashboardCell,
} from '@/modules/workstation/gst/api';
import { SERVICES } from '../partnership/shared';
import type { RegistrationKind } from '@/modules/partnership/api';

/** Cell renderer: ✓ done / ▍ due / ▍ overdue / ○ not started / — not this month. */
function ReturnCell({ cell, onOpen, busy }: {
  cell: ClientDashboardCell | null;
  onOpen: (() => void) | null;
  busy: boolean;
}) {
  if (!cell) return <span className="text-neutral-400">—</span>;
  const label =
    cell.state === 'done' ? (cell.due_date ? new Date(cell.due_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : 'done')
    : cell.state === 'overdue' ? 'overdue'
    : cell.state === 'due' && cell.due_date ? new Date(cell.due_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
    : cell.due_date ? new Date(cell.due_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
    : 'not started';
  const Icon = cell.state === 'done' ? Check : cell.state === 'overdue' ? AlertTriangle : Circle;
  const iconTint =
    cell.state === 'done' ? 'text-green'
    : cell.state === 'overdue' ? 'text-red'
    : cell.state === 'due' ? 'text-amber'
    : 'text-neutral-400';
  const bar = cell.state === 'due' || cell.state === 'overdue';
  return (
    <button
      type="button"
      onClick={onOpen ? (e) => { e.stopPropagation(); onOpen(); } : undefined}
      disabled={!onOpen || busy}
      className={
        'inline-flex items-center gap-1.5 text-13 disabled:opacity-60 ' +
        (onOpen ? 'hover:underline cursor-pointer' : 'cursor-default')
      }
    >
      {bar ? <span className="w-[3px] self-stretch bg-amber inline-block" aria-hidden /> : null}
      <Icon size={13} strokeWidth={2} className={iconTint} aria-hidden />
      <span className={cell.state === 'overdue' ? 'text-red' : 'text-neutral-900'}>{label}</span>
      {cell.arn ? <span className="font-mono text-11 text-neutral-500 ml-1">ARN ⋯{cell.arn.slice(-5)}</span> : null}
    </button>
  );
}

type Filter = 'all' | 'monthly' | 'quarterly' | 'needs_action';
const STAGE_TO_KIND: Record<'gstr1' | 'gstr2b' | 'gstr3b', RegistrationKind> = {
  gstr1: 'GSTR1', gstr2b: 'GSTR2B', gstr3b: 'GSTR3B',
};

export function GstDashboard() {
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
        <PageHeader title="GST" subtitle="Every client's GSTR-1 → GSTR-2B → GSTR-3B for the selected period." />
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
        {(d) => (
          <>
            {/* Counter strip — five numbers, no cards. */}
            <div className="text-13 text-neutral-700 flex flex-wrap gap-x-6 gap-y-1">
              <span><strong className="tabular-nums">{d.counters.total_clients}</strong> clients</span>
              <span><strong className="tabular-nums">{d.counters.monthly}</strong> monthly</span>
              <span><strong className="tabular-nums">{d.counters.quarterly}</strong> quarterly</span>
              <span className={d.counters.overdue ? 'text-red' : ''}>
                <strong className="tabular-nums">{d.counters.overdue}</strong> overdue
              </span>
              <span className={d.counters.due_soon ? 'text-amber' : ''}>
                <strong className="tabular-nums">{d.counters.due_soon}</strong> due ≤3 days
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1">
              {([
                ['all', 'All'],
                ['monthly', `Monthly ${d.counters.monthly}`],
                ['quarterly', `Quarterly ${d.counters.quarterly}`],
                ['needs_action', 'Needs action'],
              ] as const).map(([key, label]) => (
                <button key={key} type="button" onClick={() => setFilter(key)}
                        className={
                          'px-3 h-8 text-13 rounded border ' +
                          (filter === key
                            ? 'bg-neutral-900 text-white border-neutral-900'
                            : 'bg-white text-neutral-700 border-neutral-300 hover:border-neutral-400')
                        }>
                  {label}
                </button>
              ))}
            </div>

            <Card
              title={`Clients — ${periodLabel(period)}`}
              right={<span className="text-12 text-neutral-500">{filtered.length} of {d.clients.length}</span>}
            >
              <FilterBar>
                <SearchInput value={q} onChange={setQ} placeholder="Client or GSTIN" />
              </FilterBar>
              {filtered.length === 0 ? (
                <div className="px-4 py-6 text-13 text-neutral-500">No clients match these filters.</div>
              ) : (
                <Table head={['Client', 'GSTIN', 'Type', 'GSTR-1', 'IMS + 2B', 'GSTR-3B']}>
                  {filtered.map((r) => (
                    <Row key={r.client_id} onClick={() => navigate(`../clients/${r.client_id}`)}>
                      <Cell><span className="font-medium">{r.name}</span></Cell>
                      <Cell muted><span className="font-mono text-12">{r.gstin}</span></Cell>
                      <Cell muted className="capitalize">{r.filing_frequency}</Cell>
                      {(['gstr1', 'gstr2b', 'gstr3b'] as const).map((k) => (
                        <Cell key={k}>
                          <ReturnCell
                            cell={r[k]}
                            onOpen={r[k] ? () => openCase.mutate({ row: r, kind: STAGE_TO_KIND[k] }) : null}
                            busy={openCase.isPending}
                          />
                        </Cell>
                      ))}
                    </Row>
                  ))}
                </Table>
              )}
              <div className="px-4 py-2 text-11 text-neutral-500 border-t border-neutral-100">
                ✓ done · ▍ due or overdue · ○ not started · — not this month
              </div>
            </Card>
          </>
        )}
      </QueryState>
    </div>
  );
}
