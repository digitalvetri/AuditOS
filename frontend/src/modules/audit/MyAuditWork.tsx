import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck } from 'lucide-react';
import { Card } from '@/modules/dashboardV2/Card';
import { auditApi } from './api';
import { auditTypeLabel, daysUntil, useMe } from './components';
import type { AuditListItem } from './types';

/**
 * Dashboard → "My audit work". One request (`/api/audits?mine=1`): the files
 * the caller is on, what is still to prepare, the review notes waiting, and
 * the files they sign whose 60-day assembly window closes within 15 days.
 * Per-caller counts come from `mine` when the server sends it; otherwise the
 * file's own progress stands in.
 */
export function MyAuditWork() {
  const me = useMe();
  const q = useQuery({ queryKey: ['audits', 'list', { mine: true }], queryFn: () => auditApi.list({ mine: true }), staleTime: 60_000 });
  const items = (q.data?.items ?? []).filter((a) => a.status !== 'archived');

  const toPrepare = (a: AuditListItem) =>
    a.mine?.working_papers_to_prepare ?? Math.max(0, (a.progress?.working_papers.total ?? 0) - (a.progress?.working_papers.prepared ?? 0));
  const notes = (a: AuditListItem) =>
    a.mine && (a.mine.review_notes_to_respond !== undefined || a.mine.review_notes_to_clear !== undefined)
      ? (a.mine.review_notes_to_respond ?? 0) + (a.mine.review_notes_to_clear ?? 0)
      : a.progress?.review_notes_open ?? 0;
  const assemblyDue = (a: AuditListItem) => {
    if (a.locked || a.locked_at || !me.isMe(a.signing_partner_id)) return null;
    const d = daysUntil(a.assembly_due_date);
    return d !== null && d <= 15 ? d : null;
  };

  const perCaller = items.some((a) => a.mine);
  const prepTotal = items.reduce((s, a) => s + (a.report_date ? 0 : toPrepare(a)), 0);
  const noteTotal = items.reduce((s, a) => s + notes(a), 0);
  const due = items.filter((a) => assemblyDue(a) !== null);

  const ranked = [...items]
    .map((a) => ({ a, due: assemblyDue(a), n: notes(a), p: a.report_date ? 0 : toPrepare(a) }))
    .filter((x) => x.due !== null || x.n > 0 || x.p > 0)
    .sort((x, y) => (x.due ?? 999) - (y.due ?? 999) || y.n - x.n || y.p - x.p)
    .slice(0, 5);

  return (
    <Card title="My audit work" subtitle={`${items.length} open audit file${items.length === 1 ? '' : 's'}`} icon={<ClipboardCheck size={17} />}
      action={{ label: 'Audits', href: '/workstation/audits' }}
      loading={q.isLoading} error={q.isError ? (q.error as Error).message : null}
      empty={items.length === 0} emptyMessage="You are not on any open audit file.">
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Stat value={prepTotal} label={perCaller ? 'Papers to prepare' : 'Papers not prepared'} />
        <Stat value={noteTotal} label={perCaller ? 'Notes awaiting you' : 'Review notes open'} warn={noteTotal > 0} />
        <Stat value={due.length} label="Assembly due ≤ 15 days" warn={due.length > 0} />
      </div>
      {ranked.length === 0 ? <p className="text-13 text-inkMuted">Nothing waiting on you.</p> : (
        <ul className="divide-y divide-border">
          {ranked.map(({ a, due: d, n, p }) => (
            <li key={a.id}>
              <Link to={`/workstation/audits/${a.id}${n > 0 ? '?tab=notes' : p > 0 ? '?tab=papers' : ''}`} className="flex items-center gap-3 py-2 hover:bg-neutral-50 rounded">
                <div className="min-w-0 flex-1">
                  <div className="text-13 font-semibold text-ink truncate">{a.client?.company_name ?? a.audit_code}</div>
                  <div className="text-12 text-inkMuted truncate">{a.audit_code} · {auditTypeLabel(a.audit_type)} · FY {a.financial_year}</div>
                </div>
                <div className="text-12 text-right whitespace-nowrap">
                  {d !== null ? <div className={d < 0 ? 'text-danger font-semibold' : 'text-warning font-semibold'}>{d < 0 ? `Assembly ${-d}d overdue` : `Assemble in ${d}d`}</div> : null}
                  {n > 0 ? <div className="text-ink">{n} note{n === 1 ? '' : 's'}</div> : null}
                  {p > 0 && d === null ? <div className="text-inkMuted">{p} to prepare</div> : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const Stat = ({ value, label, warn }: { value: number; label: string; warn?: boolean }) => (
  <div className="rounded-lg bg-neutral-50 px-3 py-2 min-w-0">
    <div className={`text-20 font-semibold tabular-nums ${warn ? 'text-danger' : 'text-ink'}`}>{value}</div>
    <div className="text-11 text-inkMuted truncate">{label}</div>
  </div>
);
