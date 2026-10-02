/**
 * TDS firm-wide board — shown on Workstation → Services → TDS until a
 * client is picked. Every client TAN in the caller's scope with its
 * overdue and due-soon challans, returns and certificates, open TRACES
 * defaults and the last notice check, worst first. Reads GET /api/tds/overview;
 * the same computation drives the reminder notifications.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, ChevronRight, SearchCheck, ShieldAlert } from 'lucide-react';
import { tdsApi, type TdsOverviewRow } from '@/modules/tds/api';
import { fmtDate } from './status';

type Filter = 'all' | 'overdue' | 'due_soon' | 'check_due' | 'no_tan';

const STANDING: Record<TdsOverviewRow['standing'], { label: string; bg: string; fg: string }> = {
  overdue:   { label: 'Overdue',        bg: '#FDE7EA', fg: '#B91C1C' },
  due_soon:  { label: 'Due this week',  bg: '#FEF3C7', fg: '#B45309' },
  check_due: { label: 'TRACES check due', bg: '#E6EEFC', fg: '#1D4ED8' },
  ok:        { label: 'Up to date',     bg: '#E7F5EE', fg: '#166534' },
  no_tan:    { label: 'No TAN',         bg: '#EEF0F3', fg: '#475569' },
};

export function TdsOverviewBoard({ fy, onOpen }: { fy: string; onOpen: (clientId: string, tan: string | null, primary: boolean) => void }) {
  const q = useQuery({ queryKey: ['tds-overview', fy], queryFn: () => tdsApi.overview(fy) });
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const rows = q.data?.rows ?? [];

  const counts = useMemo(() => ({
    clientsOverdue: new Set(rows.filter((r) => r.standing === 'overdue').map((r) => r.client_id)).size,
    itemsOverdue: rows.reduce((s, r) => s + r.overdue, 0),
    dueSoon: rows.reduce((s, r) => s + r.due_soon, 0),
    checksDue: rows.filter((r) => r.tan && r.notice_check_stale).length,
    noTan: rows.filter((r) => r.standing === 'no_tan').length,
  }), [rows]);

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return rows.filter((r) =>
      (filter === 'all' || (filter === 'check_due' ? r.tan && r.notice_check_stale : filter === 'due_soon' ? r.due_soon > 0 : r.standing === filter))
      && (!s || [r.client_name, r.client_code, r.tan, r.account_manager].some((v) => v?.toLowerCase().includes(s))));
  }, [rows, filter, search]);

  if (q.isLoading) return <section className="bg-white border border-neutral-200 rounded-lg shadow-card p-6 text-13 text-neutral-500">Loading every client’s TDS position…</section>;
  if (q.isError) return <section className="bg-white border border-neutral-200 rounded-lg shadow-card p-6 text-13 text-danger">{(q.error as Error).message}</section>;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Tile icon={<AlertTriangle size={16} />} tone="#B91C1C" bg="#FDE7EA" label="Clients with overdue TDS" value={counts.clientsOverdue} sub={`${counts.itemsOverdue} overdue item${counts.itemsOverdue === 1 ? '' : 's'}`} onClick={() => setFilter('overdue')} active={filter === 'overdue'} />
        <Tile icon={<CalendarClock size={16} />} tone="#B45309" bg="#FEF3C7" label={`Due in the next ${q.data?.due_soon_days ?? 7} days`} value={counts.dueSoon} sub="challans, returns, certificates" onClick={() => setFilter('due_soon')} active={filter === 'due_soon'} />
        <Tile icon={<SearchCheck size={16} />} tone="#1D4ED8" bg="#E6EEFC" label="TRACES checks due" value={counts.checksDue} sub="not checked in 7 days" onClick={() => setFilter('check_due')} active={filter === 'check_due'} />
        <Tile icon={<ShieldAlert size={16} />} tone="#475569" bg="#EEF0F3" label="Clients without a TAN" value={counts.noTan} sub="record it under TDS Registration" onClick={() => setFilter('no_tan')} active={filter === 'no_tan'} />
      </div>

      <section className="bg-white border border-neutral-200 rounded-lg shadow-card overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-neutral-100">
          <div className="text-14 font-medium text-neutral-900 mr-auto">All clients · FY {q.data?.fy}</div>
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter">
            {(['all', 'overdue', 'due_soon', 'check_due', 'no_tan'] as Filter[]).map((f) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
                className={'h-8 px-3 text-12 rounded-md border ' + (filter === f ? 'bg-primary text-white border-primary' : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50')}>
                {f === 'all' ? `All (${rows.length})` : f === 'due_soon' ? 'Due this week' : f === 'check_due' ? 'TRACES check due' : STANDING[f].label}
              </button>
            ))}
          </div>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search client, TAN, manager…"
            className="h-8 px-3 text-13 bg-white border border-neutral-300 rounded-md focus:outline-none focus:border-gold w-[220px]" />
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-13 text-neutral-500">
            No client has TDS set up yet. Pick a client above and record its TAN under <span className="text-neutral-900">TDS Registration</span>.
          </div>
        ) : shown.length === 0 ? (
          <div className="px-4 py-8 text-center text-13 text-neutral-500">Nothing matches this filter.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="hr-float w-full min-w-[560px] text-13">
              <thead>
                <tr className="text-11 uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-100">
                  <th className="text-left font-medium px-4 py-2">Client</th>
                  <th className="text-left font-medium px-3 py-2">Status</th>
                  <th className="text-left font-medium px-3 py-2">TRACES</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const st = STANDING[r.standing];
                  return (
                    <tr key={`${r.client_id}-${r.tan ?? 'none'}`} className="border-b border-neutral-100 last:border-b-0 align-top hover:bg-neutral-50 cursor-pointer"
                      onClick={() => onOpen(r.client_id, r.tan, r.is_primary_tan)}>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-neutral-900">{r.client_name}</div>
                        <div className="text-11 text-neutral-500">
                          {r.tan ? <span className="font-mono">{r.tan}{r.is_primary_tan ? '' : ' · branch'}</span> : 'No TAN'}
                          {r.account_manager ? ` · ${r.account_manager}` : ''}
                          {r.tan && !r.deductor_type ? <span className="text-danger"> · deductor type not set</span> : null}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center h-6 px-2 text-11 font-medium rounded-md whitespace-nowrap" style={{ backgroundColor: st.bg, color: st.fg }}>{st.label}</span>
                        {r.overdue ? <div className="text-11 text-danger mt-1">{r.overdue} overdue</div> : r.due_soon ? <div className="text-11 text-[#B45309] mt-1">{r.due_soon} due this week</div> : null}
                        {r.open_notices ? <div className="text-11 text-danger">{r.open_notices} open default{r.open_notices === 1 ? '' : 's'}</div> : null}
                      </td>
                      <td className="px-3 py-2.5 text-12 whitespace-nowrap">
                        {!r.tan ? '—' : r.last_notice_check
                          ? <span className={r.notice_check_stale ? 'text-[#1D4ED8]' : 'text-neutral-600'}>checked {fmtDate(r.last_notice_check)}</span>
                          : <span className="text-[#1D4ED8]">never checked</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right"><ChevronRight size={16} className="inline text-neutral-400" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="text-11 text-neutral-500">
        Account managers also get a bell notification when an item is due within {q.data?.due_soon_days ?? 7} days, when it goes overdue, and when the weekly TRACES check is due.
      </p>
    </div>
  );
}

function Tile({ icon, tone, bg, label, value, sub, onClick, active }: {
  icon: React.ReactNode; tone: string; bg: string; label: string; value: number; sub: string; onClick: () => void; active: boolean;
}) {
  return (
    <button type="button" onClick={onClick}
      className={'text-left bg-white border rounded-lg shadow-card p-4 transition-colors hover:bg-neutral-50 ' + (active ? 'border-primary' : 'border-neutral-200')}>
      <span className="inline-flex items-center justify-center w-8 h-8 rounded-md mb-2" style={{ backgroundColor: bg, color: tone }}>{icon}</span>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className="text-20 font-semibold tabular-nums" style={{ color: value ? tone : undefined }}>{value}</div>
      <div className="text-11 text-neutral-500">{sub}</div>
    </button>
  );
}
