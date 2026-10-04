/**
 * Main Dashboard → Post-Registration Compliance. Same data as the Private
 * Limited case screen (one endpoint). Summary cards filter the list; every
 * row shows its status in words with the due date and days remaining, and
 * View opens that company's Post-Registration Compliance tab.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fmtDate } from '@/lib/format';
import { postRegistrationApi, postRegistrationKeys, type ComplianceItem, type ComplianceStatus } from './api';
import { ComplianceStatusBadge, daysClass, daysText } from './ui';

type Filter = 'PENDING' | 'UPCOMING' | 'DUE_SOON' | 'OVERDUE' | 'COMPLETED';

const caseUrl = (i: ComplianceItem) => `/workstation/services/registration/private-limited/clients/${i.case.id}?tab=compliance`;

/** Pending = not completed; Due Soon includes Due Today; Upcoming includes Not Started (no date yet). */
const matches = (f: Filter, s: ComplianceStatus) =>
  f === 'PENDING' ? s !== 'COMPLETED' : (f === 'DUE_SOON' ? s === 'DUE_SOON' || s === 'DUE_TODAY' : f === 'UPCOMING' ? s === 'UPCOMING' || s === 'NOT_STARTED' : s === f);

export function PostRegistrationDashboardSection() {
  const q = useQuery({ queryKey: postRegistrationKeys.list({ kind: 'PRIVATE_LIMITED' }), queryFn: () => postRegistrationApi.list({ kind: 'PRIVATE_LIMITED' }) });
  const [filter, setFilter] = useState<Filter>('PENDING');
  const items = useMemo(() => (q.data?.items ?? []).filter((i) => matches(filter, i.status)), [q.data, filter]);

  if (!q.data || q.data.summary.total === 0) return null; // nothing to track yet — no empty panel on the dashboard
  const s = q.data.summary;
  const companies = new Set(q.data.items.map((i) => i.client.id)).size;
  const cards: { key: Filter; label: string; value: number; note: string; tone: string }[] = [
    { key: 'PENDING', label: 'Pending', value: s.total - s.completed, note: `${companies} compan${companies === 1 ? 'y' : 'ies'}`, tone: 'bg-surface' },
    { key: 'UPCOMING', label: 'Upcoming', value: s.upcoming + s.not_started, note: s.not_started ? `${s.not_started} awaiting a date` : 'On track', tone: 'bg-blue-50' },
    { key: 'DUE_SOON', label: 'Due Soon', value: s.due_soon + s.due_today, note: s.due_today ? `${s.due_today} due today` : 'Approaching', tone: 'bg-amber-50' },
    { key: 'OVERDUE', label: 'Overdue', value: s.overdue, note: s.overdue ? 'Needs action now' : 'None overdue', tone: 'bg-red-50' },
    { key: 'COMPLETED', label: 'Completed', value: s.completed, note: 'Kept as history', tone: 'bg-green-50' },
  ];

  return (
    <section className="dash-card dash-rise min-w-0 overflow-hidden" data-testid="post-registration-compliance">
      <div className="px-5 pt-4 pb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-15 font-semibold text-ink tracking-[-0.015em]">Post-Registration Compliance</h2>
        <span className="text-12 text-inkMuted">Private Limited · INC-20A (180 days) and ADTC (30 days) · today {fmtDate(q.data.today)}</span>
        <Link className="ml-auto text-12 underline text-ink" to="/workstation/services/registration/private-limited/compliance">All companies</Link>
      </div>

      <div className="px-5 grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" role="group" aria-label="Filter post-registration compliance">
        {cards.map((c) => (
          <button
            key={c.key}
            type="button"
            aria-pressed={filter === c.key}
            onClick={() => setFilter(filter === c.key && c.key !== 'PENDING' ? 'PENDING' : c.key)}
            className={`text-left rounded-xl px-4 py-3 border transition ${c.tone} ${filter === c.key ? 'border-neutral-900 ring-1 ring-neutral-900' : 'border-transparent hover:border-neutral-300'}`}
          >
            <div className="text-12 text-inkMuted">{c.label}</div>
            <div className="text-[24px] font-semibold text-ink leading-tight tabular-nums">{c.value}</div>
            <div className="text-11 text-inkMuted mt-0.5">{c.note}</div>
          </button>
        ))}
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-13">
          <thead>
            <tr className="text-left text-11 uppercase tracking-[0.06em] text-inkMuted border-y border-neutral-200">
              <th className="px-5 py-2 font-medium">Company</th>
              <th className="px-3 py-2 font-medium">Compliance</th>
              <th className="px-3 py-2 font-medium">Due date</th>
              <th className="px-3 py-2 font-medium">Days remaining</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-5 py-2 font-medium text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan={6} className="px-5 py-6 text-inkMuted">Nothing in this view.</td></tr>
            ) : items.slice(0, 50).map((i) => (
              <tr key={i.id} className="border-b border-neutral-100 last:border-b-0">
                <td className="px-5 py-2.5 text-ink font-medium">{i.client.name}</td>
                <td className="px-3 py-2.5">{i.label}</td>
                <td className="px-3 py-2.5 whitespace-nowrap tabular-nums">{i.due_date ? fmtDate(i.due_date) : <span className="text-inkMuted">Date not entered</span>}</td>
                <td className={`px-3 py-2.5 whitespace-nowrap ${daysClass(i)}`}>{daysText(i)}</td>
                <td className="px-3 py-2.5"><ComplianceStatusBadge status={i.status} /></td>
                <td className="px-5 py-2.5 text-right"><Link className="underline text-ink" to={caseUrl(i)}>View</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length > 50 ? <div className="px-5 py-2 text-12 text-inkMuted">Showing the 50 most urgent of {items.length}.</div> : null}
      </div>
    </section>
  );
}
