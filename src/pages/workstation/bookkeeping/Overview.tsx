import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '@/services/api';
import { human, opts } from '@/modules/bookkeeping/format';
import type {
  OverviewResponse, OverviewPeriodRow, Task,
} from '@/modules/bookkeeping/types';
import { bookkeepingApi } from '@/modules/bookkeeping/api';
import {
  Card, Cell, FilterBar, PageHeader, QueryState, Row, SearchInput, Select,
  Status, Table,
} from '@/modules/workstation/components';
import { fmtDate } from '@/lib/format';

/**
 * OVERVIEW — the "what needs doing?" screen (spec §6.1).
 *
 * The five tiles at the top are the ONLY entry points to filter the table
 * below. Each tile shows an unfiltered aggregate over the caller's visible
 * clients; clicking one sets the `?tile=` URL param, which re-queries with
 * that filter and re-renders both the tiles (unchanged) and the table
 * (filtered). The tiles are never computed on the client — the endpoint
 * returns `{ tiles, rows }` together so the two answers cannot drift.
 *
 * `?group=` toggles between one-row-per-period (default; each row shows the
 * period's current stage) and one-row-per-task (the old Tasks tab view).
 */

type TileKey = 'overdue' | 'blocked' | 'due_soon' | 'review' | 'closed';
const TILES: { key: TileKey; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'due_soon', label: 'Due ≤7d' },
  { key: 'review', label: 'Review' },
  { key: 'closed', label: 'Closed' },
];

export function BookkeepingOverviewPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = {
    tile: (params.get('tile') ?? '') as TileKey | '',
    group: (params.get('group') ?? 'period') as 'period' | 'task',
    client_id: params.get('client_id') ?? '',
    employee_id: params.get('employee_id') ?? '',
    stage: params.get('stage') ?? '',
    status: params.get('status') ?? '',
    q: params.get('q') ?? '',
  };
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };

  const overview = useQuery({
    queryKey: ['bookkeeping', 'overview', filters],
    queryFn: () => api.get<OverviewResponse>(
      `/api/bookkeeping/overview?${new URLSearchParams(
        Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '')),
      ).toString()}`,
    ),
  });
  const settings = useQuery({ queryKey: ['bookkeeping', 'settings'], queryFn: bookkeepingApi.settings });
  const clients = useQuery({
    queryKey: ['bookkeeping', 'clients', {}],
    queryFn: () => bookkeepingApi.listClients(),
  });

  return (
    <div>
      <PageHeader
        title="Bookkeeping"
        subtitle="What needs doing, across every open client. Tiles are filter shortcuts."
      />
      <QueryState query={overview}>
        {(data) => (
          <div className="space-y-4">
            {/* Tile row — every tile is a filter, none is decoration. */}
            <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
              {TILES.map((t) => {
                const active = filters.tile === t.key;
                return (
                  <button
                    key={t.key}
                    onClick={() => setParam('tile', active ? '' : t.key)}
                    className={
                      'text-left bg-white border rounded px-4 py-3 transition-colors ' +
                      (active
                        ? 'border-gold ring-1 ring-gold'
                        : 'border-neutral-200 hover:border-neutral-400')
                    }
                  >
                    <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
                      {t.label}
                    </div>
                    <div className="text-24 font-semibold text-neutral-900 mt-1 tabular-nums">
                      {data.tiles[t.key]}
                    </div>
                  </button>
                );
              })}
            </div>

            <FilterBar>
              <Select
                label="Client" value={filters.client_id}
                onChange={(v) => setParam('client_id', v)}
                options={(clients.data?.items ?? []).map((c) => ({
                  value: c.client_id, label: c.client_name ?? '—',
                }))}
              />
              <Select
                label="Stage" value={filters.stage}
                onChange={(v) => setParam('stage', v)}
                options={(settings.data?.workflow_stages ?? []).map((s) => ({
                  value: s.slug, label: s.name,
                }))}
              />
              <Select
                label="Status" value={filters.status}
                onChange={(v) => setParam('status', v)}
                options={filters.group === 'task'
                  ? opts(settings.data?.task_statuses)
                  : opts(settings.data?.period_statuses)}
              />
              <SearchInput
                value={filters.q} onChange={(v) => setParam('q', v)}
                placeholder={filters.group === 'task' ? 'Task title' : 'Client name'}
              />
              <div className="ml-auto flex items-center gap-2">
                <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">
                  Group by
                </span>
                <div className="inline-flex rounded overflow-hidden border border-neutral-300">
                  {(['period', 'task'] as const).map((g) => (
                    <button
                      key={g}
                      onClick={() => setParam('group', g === 'period' ? '' : g)}
                      className={
                        'px-3 h-8 text-13 ' +
                        (filters.group === g
                          ? 'bg-neutral-900 text-white'
                          : 'bg-white text-neutral-700 hover:bg-neutral-50')
                      }
                    >
                      {human(g)}
                    </button>
                  ))}
                </div>
              </div>
            </FilterBar>

            <Card>
              {data.count === 0 ? (
                <div className="px-4 py-6 text-13 text-neutral-500">
                  Nothing matches these filters.
                </div>
              ) : data.group === 'task' ? (
                <TaskRows rows={data.rows as Task[]} />
              ) : (
                <PeriodRows
                  rows={data.rows as OverviewPeriodRow[]}
                  onOpen={(id) => navigate(`monthly-work/${id}`)}
                />
              )}
              <div className="px-4 py-2 text-11 text-neutral-500 border-t border-neutral-100">
                {data.count} {data.group === 'task' ? 'task' : 'period'}
                {data.count === 1 ? '' : 's'} shown
                {data.count >= 200 && data.group === 'task' ? ' · capped at 200' : ''}
              </div>
            </Card>
          </div>
        )}
      </QueryState>
    </div>
  );
}

function PeriodRows({
  rows, onOpen,
}: { rows: OverviewPeriodRow[]; onOpen: (id: string) => void }) {
  return (
    <Table head={['Client', 'Period', 'Stage', 'Due', 'Owner', 'Blocked']}>
      {rows.map((p) => (
        <Row key={p.id} status={p.status} onClick={() => onOpen(p.id)}>
          <Cell>{p.client_name ?? '—'}</Cell>
          <Cell>{p.label}</Cell>
          <Cell muted>
            {p.current_stage
              ? `${p.current_stage.sequence}. ${p.current_stage.name}`
              : <Status value={p.status} />}
          </Cell>
          <Cell muted>{p.due_date ? fmtDate(p.due_date) : '—'}</Cell>
          <Cell muted>{p.assigned_employee?.full_name ?? '—'}</Cell>
          <Cell>
            {p.blocked_count > 0 ? (
              <span className="text-12 text-red-600 tabular-nums">⚠ {p.blocked_count}</span>
            ) : (
              <span className="text-12 text-neutral-400">—</span>
            )}
          </Cell>
        </Row>
      ))}
    </Table>
  );
}

function TaskRows({ rows }: { rows: Task[] }) {
  return (
    <Table head={['Client', 'Period', 'Stage', 'Task', 'Due', 'Owner', 'Status']}>
      {rows.map((t) => (
        <Row key={t.id} status={t.status}>
          <Cell>{t.client_name ?? '—'}</Cell>
          <Cell muted>{t.period_label ?? '—'}</Cell>
          <Cell muted>
            {t.stage ? `${t.stage.sequence}. ${t.stage.name}` : 'Ad-hoc'}
          </Cell>
          <Cell>{t.title}</Cell>
          <Cell muted>{t.due_date ? fmtDate(t.due_date) : '—'}</Cell>
          <Cell muted>{t.assigned_employee?.full_name ?? '—'}</Cell>
          <Cell><Status value={t.status} /></Cell>
        </Row>
      ))}
    </Table>
  );
}
