import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Search } from 'lucide-react';
import { QueryState, Status } from '@/modules/workstation/components';
import { checklistApi, type ChecklistOverviewRow } from '@/modules/workstation/checklist/api';
import { fmtDate } from '@/lib/format';

/**
 * Workstation → Services → GST → Client checklists.
 *
 * The cross-client view of work that is otherwise only visible one client at
 * a time. It is a REPORT: every figure is computed from the clients' own
 * checklist rows, and nothing here writes anything — the service catalogue on
 * the other tab is untouched by it, and a client's work is still edited on
 * that client's own GST tab, which each row links to.
 */
export function ClientChecklists() {
  const q = useQuery({ queryKey: ['checklist', 'gst', 'overview'], queryFn: () => checklistApi.overview() });
  const [query, setQuery] = useState('');
  const [only, setOnly] = useState<'all' | 'configured' | 'not-configured' | 'overdue'>('all');

  return (
    <QueryState query={q}>
      {(data) => {
        // Plain filtering, not useMemo: this runs inside QueryState's render
        // prop, and a hook there would change hook order between the loading
        // and loaded renders.
        const needle = query.trim().toLowerCase();
        const shown = data.items.filter((r) => {
          if (needle && !`${r.client_name} ${r.client_code} ${r.gstin ?? ''}`.toLowerCase().includes(needle)) return false;
          if (only === 'configured' && !r.has_checklist) return false;
          if (only === 'not-configured' && r.has_checklist) return false;
          if (only === 'overdue' && r.summary.overdue === 0) return false;
          return true;
        });

        return (
          <div className="space-y-4">
            <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Tile label="Clients" value={data.totals.clients} />
              <Tile label="With a checklist" value={data.totals.clients_with_checklist} />
              <Tile label="Items" value={data.totals.total} />
              <Tile label="Overdue" value={data.totals.overdue} tone={data.totals.overdue > 0 ? 'bad' : undefined} />
              <Tile label="Completed" value={`${data.totals.progress_percent}%`} />
            </section>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search clients…"
                  className="w-full h-9 pl-9 pr-3 text-13 bg-white border border-neutral-200 rounded-md focus:outline-none focus:border-gold"
                />
              </div>
              <select
                value={only}
                onChange={(e) => setOnly(e.target.value as typeof only)}
                className="h-9 px-2 text-13 bg-white border border-neutral-200 rounded-md"
              >
                <option value="all">All clients</option>
                <option value="configured">Checklist configured</option>
                <option value="not-configured">No checklist yet</option>
                <option value="overdue">Has overdue work</option>
              </select>
            </div>

            <section className="bg-white border border-neutral-200 rounded-lg shadow-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] border-collapse">
                  <thead>
                    <tr className="border-b border-neutral-200">
                      {['Client', 'Items', 'Completed', 'Overdue', 'Progress', 'Next due', ''].map((h, i) => (
                        <th key={i} className="h-9 px-4 text-11 uppercase tracking-[0.06em] font-medium text-neutral-500 text-left whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.length === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-8 text-center text-13 text-neutral-500">No clients match.</td></tr>
                    ) : shown.map((r) => <OverviewRow key={r.client_id} row={r} />)}
                  </tbody>
                </table>
              </div>
            </section>

            <p className="text-11 text-neutral-500">
              Read-only roll-up. Statuses, assignees and due dates are edited on each client's own
              GST tab — a client's work never lives on the service catalogue.
            </p>
          </div>
        );
      }}
    </QueryState>
  );
}

function OverviewRow({ row }: { row: ChecklistOverviewRow }) {
  const to = `/workstation/clients/${row.client_id}/gst`;
  return (
    <tr className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50">
      <td className="px-4 py-2.5">
        <Link to={to} className="text-13 text-neutral-900 hover:text-gold">{row.client_name}</Link>
        <div className="text-11 text-neutral-500">{row.client_code}{row.gstin ? ` · ${row.gstin}` : ''}</div>
      </td>
      {!row.has_checklist ? (
        <td colSpan={5} className="px-4 py-2.5 text-13 text-neutral-500">
          No checklist yet —{' '}
          <Link to={to} className="underline hover:text-gold">set one up</Link>
        </td>
      ) : (
        <>
          <td className="px-4 py-2.5 text-13 text-neutral-900 tabular-nums">{row.summary.total}</td>
          <td className="px-4 py-2.5 text-13 text-neutral-900 tabular-nums">{row.summary.completed}</td>
          <td className="px-4 py-2.5 text-13 tabular-nums">
            {row.summary.overdue > 0
              ? <span className="text-red font-medium">{row.summary.overdue}</span>
              : <span className="text-neutral-500">0</span>}
          </td>
          <td className="px-4 py-2.5 w-[180px]">
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 rounded bg-neutral-200 overflow-hidden">
                <div className="h-full bg-gold" style={{ width: `${row.summary.progress_percent}%` }} />
              </div>
              <span className="text-11 text-neutral-500 tabular-nums w-9 text-right">{row.summary.progress_percent}%</span>
            </div>
          </td>
          <td className="px-4 py-2.5 text-13 text-neutral-500 whitespace-nowrap">
            {row.next_due ? (
              <span className="inline-flex items-center gap-2">
                {row.next_due.due_date ? fmtDate(row.next_due.due_date) : '—'}
                <span className="text-neutral-400">·</span>
                <span className="text-neutral-900">{row.next_due.name}</span>
                {row.next_due.status === 'overdue' ? <Status value="overdue" /> : null}
              </span>
            ) : '—'}
          </td>
        </>
      )}
      <td className="px-4 py-2.5 text-right">
        <Link to={to} className="text-neutral-400 hover:text-neutral-900 inline-flex"><ChevronRight size={16} /></Link>
      </td>
    </tr>
  );
}

function Tile({ label, value, tone }: { label: string; value: number | string; tone?: 'bad' }) {
  return (
    <div className="bg-white border border-neutral-200 rounded-lg px-4 py-3">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className={`text-20 font-semibold tabular-nums ${tone === 'bad' ? 'text-red' : 'text-neutral-900'}`}>{value}</div>
    </div>
  );
}
