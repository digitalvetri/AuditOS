/**
 * THE CENTRAL GST COMPLIANCE DASHBOARD (§6–§10).
 *
 * Every number on this screen is counted by the database and every status is
 * derived on the server — nothing here is hardcoded and nothing is computed
 * from a full client list held in the browser. The filters are query
 * parameters, so narrowing the view re-queries rather than hiding rows.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Check, Circle, AlertTriangle, ChevronRight } from 'lucide-react';
import {
  Card, PageHeader, QueryState, Table, Row, Cell, Status, FilterBar, Select, SearchInput,
} from '@/modules/workstation/components';
import { gstApi, periodLabel, type GstPeriod, type PeriodFilters } from '@/modules/workstation/gst/api';
import { SERVICES } from '../partnership/shared';
import type { RegistrationKind } from '@/modules/partnership/api';

/** Each chain node in the 1 › 2B › Recon › 3B flow opens the matching case (§9-4). */
type ChainNode = { kind: RegistrationKind; label: '1' | '2B' | 'Recon' | '3B'; status: string };

/** §10 — a stage reads as an icon AND a word, never colour alone. */
function StageChip({ label, status, onClick, disabled }: { label: string; status: string; onClick?: () => void; disabled?: boolean }) {
  const done = ['filed', 'completed', 'reconciliation_completed', 'completed_with_exceptions'].includes(status);
  const problem = ['exceptions_found', 'rework_required', 'overdue'].includes(status);
  const Icon = done ? Check : problem ? AlertTriangle : Circle;
  return (
    <button
      type="button"
      onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
      disabled={disabled || !onClick}
      className={
        'inline-flex items-center gap-1 whitespace-nowrap ' +
        (onClick ? 'hover:bg-neutral-100 rounded px-1 -mx-1 cursor-pointer disabled:cursor-wait disabled:opacity-60' : '')
      }
    >
      <Icon
        size={13}
        strokeWidth={2}
        className={done ? 'text-green' : problem ? 'text-red' : 'text-neutral-400'}
        aria-hidden
      />
      <span className="text-12 text-neutral-500">{label}</span>
    </button>
  );
}

/** The §10 flow, laid out left-to-right with the arrow between stages.
    Each chip is a link into the matching case for that period (§9-4). */
function StageFlow({ p, onOpen, busy }: { p: GstPeriod; onOpen: (n: ChainNode) => void; busy: boolean }) {
  const s = p.stage_status;
  const nodes: ChainNode[] = [
    { kind: 'GSTR1', label: '1', status: s.gstr1 },
    { kind: 'GSTR2B', label: '2B', status: s.gstr2b },
    // Reconciliation is a stage inside the GSTR-2B case (§7.3), not its
    // own kind. The chip still routes there but reads a different status.
    { kind: 'GSTR2B', label: 'Recon', status: s.reconciliation },
    { kind: 'GSTR3B', label: '3B', status: s.gstr3b },
  ];
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      {nodes.map((n, i) => (
        <span key={`${n.label}-${i}`} className="inline-flex items-center gap-1.5">
          <StageChip label={n.label} status={n.status} onClick={p.client_id ? () => onOpen(n) : undefined} disabled={busy} />
          {i < nodes.length - 1 ? <ChevronRight size={11} className="text-neutral-300" aria-hidden /> : null}
        </span>
      ))}
    </span>
  );
}

function Metric({
  label, value, tone = 'plain', onClick,
}: { label: string; value: number; tone?: 'plain' | 'warn' | 'bad' | 'good'; onClick?: () => void }) {
  const tint =
    tone === 'bad' ? 'text-red' : tone === 'warn' ? 'text-amber' : tone === 'good' ? 'text-green' : 'text-neutral-900';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={
        'text-left px-3 py-2.5 rounded border border-neutral-200 bg-white min-h-[56px] ' +
        (onClick ? 'hover:border-neutral-300 cursor-pointer' : 'cursor-default')
      }
    >
      <div className={`text-20 font-semibold tabular-nums ${tint}`}>{value}</div>
      <div className="text-11 text-neutral-500 mt-0.5 leading-tight">{label}</div>
    </button>
  );
}

export function GstDashboard() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<PeriodFilters>({ page: 1, page_size: 25 });
  const set = (patch: Partial<PeriodFilters>) => setFilters((f) => ({ ...f, ...patch, page: 1 }));

  const overview = useQuery({
    queryKey: ['gst', 'overview', filters.fy, filters.period],
    queryFn: () => gstApi.overview({ fy: filters.fy, period: filters.period }),
  });
  const periods = useQuery({
    queryKey: ['gst', 'periods', filters],
    queryFn: () => gstApi.periods(filters),
  });

  /**
   * Open (or return) the case for a client × return kind × period and
   * navigate to it. Same open-or-return semantics as GstStagePage — this
   * is what powers the 1 › 2B › Recon › 3B chain (§9-4) and replaces the
   * pre-rebuild "click the row → flat panel" flow.
   */
  const openChainCase = useMutation({
    mutationFn: async ({ p, node }: { p: GstPeriod; node: ChainNode }) => {
      const svc = SERVICES[node.kind];
      const r = await svc.api.openForPeriod({
        client_id: p.client_id!, period: p.period,
        period_type: p.period_type === 'quarterly' ? 'quarterly' : 'monthly',
        assigned_employee_id: p.assigned_employee_id ?? undefined,
        reviewer_employee_id: p.reviewer_employee_id ?? undefined,
      });
      return { url: svc.caseUrl(r.id) };
    },
    onSuccess: (r) => navigate(r.url),
    onError: (e) => window.alert(e instanceof Error ? e.message : 'Could not open case'),
  });

  /** Deep link into a return tab pre-filtered — the whole point of §9-4. */
  const goReturn = (kind: 'gstr1' | 'gstr2b' | 'gstr3b', query: Record<string, string> = {}) => {
    const period = filters.period ?? new Date().toISOString().slice(0, 7);
    const qs = new URLSearchParams({ period, ...query }).toString();
    navigate(`../${kind}?${qs}`);
  };

  // Financial years and periods offered by the data itself — §36 forbids
  // hardcoding a year, so the options come from what exists.
  const { years, periodOptions } = useMemo(() => {
    const items = periods.data?.items ?? [];
    return {
      years: Array.from(new Set(items.map((i) => i.financial_year))).sort().reverse(),
      periodOptions: Array.from(new Set(items.map((i) => i.period))).sort().reverse(),
    };
  }, [periods.data]);

  return (
    <div className="m-gst space-y-4">
      <PageHeader
        title="GST Compliance"
        subtitle="Every client's GSTR-1 → GSTR-2B → reconciliation → GSTR-3B cycle, in one place."
      />

      <QueryState query={overview}>
        {(o) => (
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
              <Metric label="GST clients" value={o.total_clients} />
              <Metric label="Periods tracked" value={o.total_periods} />
              <Metric label="Due today" value={o.due_today} tone={o.due_today ? 'warn' : 'plain'}
                      onClick={() => set({ due: 'today' })} />
              <Metric label="Due in 7 days" value={o.due_soon} tone={o.due_soon ? 'warn' : 'plain'}
                      onClick={() => set({ due: 'soon' })} />
              <Metric label="Overdue" value={o.overdue} tone={o.overdue ? 'bad' : 'plain'}
                      onClick={() => set({ due: 'overdue' })} />
              <Metric label="Exceptions" value={o.exceptions} tone={o.exceptions ? 'bad' : 'plain'} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <Card title="GSTR-1">
                <div className="grid grid-cols-3 gap-2 p-3">
                  <Metric label="Filed" value={o.gstr1.filed} tone="good"
                          onClick={() => goReturn('gstr1', { status: 'COMPLETED' })} />
                  <Metric label="Pending" value={o.gstr1.pending}
                          onClick={() => goReturn('gstr1', { status: 'IN_PROGRESS' })} />
                  <Metric label="Overdue" value={o.gstr1.overdue} tone={o.gstr1.overdue ? 'bad' : 'plain'}
                          onClick={() => goReturn('gstr1', { due: 'overdue' })} />
                </div>
              </Card>
              {/* §4: GSTR-2B is never "filed" — it is an auto-drafted ITC
                  statement, so its vocabulary is availability and recon. */}
              <Card title="GSTR-2B — auto-drafted, not filed">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 p-3">
                  <Metric label="Available" value={o.gstr2b.available} onClick={() => goReturn('gstr2b')} />
                  <Metric label="Pending" value={o.gstr2b.pending}
                          onClick={() => goReturn('gstr2b', { status: 'NOT_STARTED' })} />
                  <Metric label="Recon pending" value={o.gstr2b.reconciliation_pending}
                          onClick={() => goReturn('gstr2b', { stage: 'RECONCILIATION' })} />
                  <Metric label="Reconciled" value={o.gstr2b.reconciled} tone="good"
                          onClick={() => goReturn('gstr2b', { stage: 'FINALISE' })} />
                </div>
              </Card>
              <Card title="GSTR-3B">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 p-3">
                  <Metric label="Filed" value={o.gstr3b.filed} tone="good"
                          onClick={() => goReturn('gstr3b', { status: 'COMPLETED' })} />
                  <Metric label="Pending" value={o.gstr3b.pending}
                          onClick={() => goReturn('gstr3b', { status: 'IN_PROGRESS' })} />
                  <Metric label="Payment pending" value={o.gstr3b.payment_pending}
                          tone={o.gstr3b.payment_pending ? 'warn' : 'plain'}
                          onClick={() => goReturn('gstr3b', { stage: 'PAYMENT' })} />
                  <Metric label="Overdue" value={o.gstr3b.overdue} tone={o.gstr3b.overdue ? 'bad' : 'plain'}
                          onClick={() => goReturn('gstr3b', { due: 'overdue' })} />
                </div>
              </Card>
            </div>
          </div>
        )}
      </QueryState>

      <Card
        title="Clients by period"
        right={
          periods.data ? (
            <span className="text-12 text-neutral-500">
              {periods.data.count} of {periods.data.total}
            </span>
          ) : null
        }
      >
        <FilterBar>
          <SearchInput
            value={filters.q ?? ''}
            onChange={(v) => set({ q: v })}
            placeholder="Client, GSTIN or PAN"
          />
          <Select
            label="Financial year"
            value={filters.fy ?? ''}
            onChange={(v) => set({ fy: v || undefined })}
            allLabel="All years"
            options={years.map((y) => ({ value: y, label: `FY ${y}` }))}
          />
          <Select
            label="Period"
            value={filters.period ?? ''}
            onChange={(v) => set({ period: v || undefined })}
            allLabel="All periods"
            options={periodOptions.map((p) => ({ value: p, label: periodLabel(p) }))}
          />
          <Select
            label="Status"
            value={filters.status ?? ''}
            onChange={(v) => set({ status: v || undefined })}
            allLabel="All statuses"
            options={[
              { value: 'not_started', label: 'Not started' },
              { value: 'in_progress', label: 'In progress' },
              { value: 'completed', label: 'Completed' },
              { value: 'overdue', label: 'Overdue' },
              { value: 'exception', label: 'Exception' },
            ]}
          />
          <Select
            label="Due"
            value={filters.due ?? ''}
            onChange={(v) => set({ due: v || undefined })}
            allLabel="Any time"
            options={[
              { value: 'today', label: 'Due today' },
              { value: 'soon', label: 'Due in 7 days' },
              { value: 'overdue', label: 'Overdue' },
            ]}
          />
        </FilterBar>

        <QueryState
          query={periods}
          empty={<div className="px-4 py-6 text-13 text-neutral-500">No GST periods match these filters.</div>}
        >
          {(d) =>
            d.items.length === 0 ? (
              <div className="px-4 py-6 text-13 text-neutral-500">No GST periods match these filters.</div>
            ) : (
              <Table
                head={['Client', 'GSTIN', 'Period', 'Progress', 'Overall', 'Assigned', 'Reviewer', 'Next due']}
              >
                {d.items.map((p) => (
                  <Row
                    key={p.id}
                    status={p.overall_status}
                    /* Row is intentionally not clickable — each chain node
                        below is the click target (§7.1 mockup). Opening a
                        case is a decision per return, not per row. */
                  >
                    <Cell>{p.client_name ?? '—'}</Cell>
                    <Cell muted><span className="font-mono text-12">{p.gstin}</span></Cell>
                    <Cell>{periodLabel(p.period)}</Cell>
                    <Cell><StageFlow p={p} busy={openChainCase.isPending} onOpen={(node) => openChainCase.mutate({ p, node })} /></Cell>
                    <Cell><Status value={p.overall_status} /></Cell>
                    <Cell muted>{p.assigned_employee_name ?? '—'}</Cell>
                    <Cell muted>{p.reviewer_employee_name ?? '—'}</Cell>
                    <Cell muted>
                      {p.next_due_date ? (
                        <span className={p.days_remaining !== null && p.days_remaining < 0 ? 'text-red' : ''}>
                          {p.due_label}
                        </span>
                      ) : '—'}
                    </Cell>
                  </Row>
                ))}
              </Table>
            )
          }
        </QueryState>
      </Card>
    </div>
  );
}
