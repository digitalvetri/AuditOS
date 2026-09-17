/**
 * THE CENTRAL GST COMPLIANCE DASHBOARD (§6–§10).
 *
 * Every number on this screen is counted by the database and every status is
 * derived on the server — nothing here is hardcoded and nothing is computed
 * from a full client list held in the browser. The filters are query
 * parameters, so narrowing the view re-queries rather than hiding rows.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Check, Circle, AlertTriangle, ChevronRight } from 'lucide-react';
import {
  Card, PageHeader, QueryState, Table, Row, Cell, Status, FilterBar, Select, SearchInput,
} from '@/modules/workstation/components';
import { gstApi, periodLabel, type GstPeriod, type PeriodFilters } from '@/modules/workstation/gst/api';

/** §10 — a stage reads as an icon AND a word, never colour alone. */
function StageChip({ label, status }: { label: string; status: string }) {
  const done = ['filed', 'completed', 'reconciliation_completed', 'completed_with_exceptions'].includes(status);
  const problem = ['exceptions_found', 'rework_required', 'overdue'].includes(status);
  const Icon = done ? Check : problem ? AlertTriangle : Circle;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <Icon
        size={13}
        strokeWidth={2}
        className={done ? 'text-green' : problem ? 'text-red' : 'text-neutral-400'}
        aria-hidden
      />
      <span className="text-12 text-neutral-500">{label}</span>
    </span>
  );
}

/** The §10 flow, laid out left-to-right with the arrow between stages. */
function StageFlow({ p }: { p: GstPeriod }) {
  const s = p.stage_status;
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap">
      <StageChip label="1" status={s.gstr1} />
      <ChevronRight size={11} className="text-neutral-300" aria-hidden />
      <StageChip label="2B" status={s.gstr2b} />
      <ChevronRight size={11} className="text-neutral-300" aria-hidden />
      <StageChip label="Recon" status={s.reconciliation} />
      <ChevronRight size={11} className="text-neutral-300" aria-hidden />
      <StageChip label="3B" status={s.gstr3b} />
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
                  <Metric label="Filed" value={o.gstr1.filed} tone="good" />
                  <Metric label="Pending" value={o.gstr1.pending} />
                  <Metric label="Overdue" value={o.gstr1.overdue} tone={o.gstr1.overdue ? 'bad' : 'plain'} />
                </div>
              </Card>
              {/* §4: GSTR-2B is never "filed" — it is an auto-drafted ITC
                  statement, so its vocabulary is availability and recon. */}
              <Card title="GSTR-2B — auto-drafted, not filed">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 p-3">
                  <Metric label="Available" value={o.gstr2b.available} />
                  <Metric label="Pending" value={o.gstr2b.pending} />
                  <Metric label="Recon pending" value={o.gstr2b.reconciliation_pending} />
                  <Metric label="Reconciled" value={o.gstr2b.reconciled} tone="good" />
                </div>
              </Card>
              <Card title="GSTR-3B">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 p-3">
                  <Metric label="Filed" value={o.gstr3b.filed} tone="good" />
                  <Metric label="Pending" value={o.gstr3b.pending} />
                  <Metric label="Payment pending" value={o.gstr3b.payment_pending}
                          tone={o.gstr3b.payment_pending ? 'warn' : 'plain'} />
                  <Metric label="Overdue" value={o.gstr3b.overdue} tone={o.gstr3b.overdue ? 'bad' : 'plain'} />
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
                    onClick={() => navigate(`../periods/${p.id}`)}
                  >
                    <Cell>{p.client_name ?? '—'}</Cell>
                    <Cell muted><span className="font-mono text-12">{p.gstin}</span></Cell>
                    <Cell>{periodLabel(p.period)}</Cell>
                    <Cell><StageFlow p={p} /></Cell>
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
