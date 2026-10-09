/**
 * Dashboard → "My work this week", for every user. One card, four sources,
 * each only when the role may read it:
 *
 *   Tasks       GET /api/tasks?employee_id=me&due_to=+7d       due or overdue
 *   Filings     GET /api/compliance/items?mine=1&to=+7d        open, due ≤ 7 days
 *   Audit work  GET /api/audits?mine=1                         papers to prepare, notes waiting, assembly due
 *   Notices     GET /api/notices-register?mine=1               reply due ≤ 7 days
 *
 * It replaces the separate "My audit work" card (same request and cache key).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, ClipboardCheck, FileWarning, ListChecks, Sun } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { Card } from './Card';
import { istToday } from './brief';
import { tasksApi } from '@/modules/workstation/tasks/api';
import { complianceApi } from '@/modules/compliance/api';
import { noticesRegisterApi } from '@/modules/noticesRegister/api';
import { auditApi } from '@/modules/audit/api';
import type { AuditListItem } from '@/modules/audit/types';

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysFrom = (today: string, iso: string | null | undefined) =>
  iso ? Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
const CLOSED_FILING = new Set(['filed', 'not_applicable']);
const CLOSED_TASK = new Set(['completed', 'cancelled']);

interface Item { key: string; kind: string; title: string; sub: string; days: number | null; href: string }

export function MyWorkWeek() {
  const { session } = useAuth();
  const role = session?.role.code;
  const me = session?.employee?.id ?? null;
  const today = istToday();
  const week = addDays(today, 7);

  const seesTasks = can(role, 'workstation.task.read', 'self');
  const seesFilings = can(role, 'workstation.compliance.read', 'self') || can(role, 'workstation.compliance.manage', 'self');
  const seesAudits = can(role, 'workstation.audit.read', 'self');
  const seesNotices = can(role, 'workstation.notice.read', 'self') || can(role, 'workstation.notice.manage', 'self');

  // Two narrow reads: everything overdue (the server keeps only open tasks),
  // and what falls due this week.
  const tasks = useQuery({
    queryKey: ['tasks', 'list', { mine: me, week: today }],
    queryFn: async () => {
      const [late, soon] = await Promise.all([
        tasksApi.list({ employee_id: me!, overdue: true, sort: 'due_date', limit: 100 }),
        tasksApi.list({ employee_id: me!, due_from: today, due_to: week, sort: 'due_date', limit: 100 }),
      ]);
      const seen = new Set<string>();
      return { items: [...late.items, ...soon.items].filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true))) };
    },
    enabled: seesTasks && !!me, staleTime: 60_000,
  });
  const filings = useQuery({
    queryKey: ['compliance', 'items', { mine: true, to: week }],
    // No lower bound: overdue items count too. open_only keeps filed ones out.
    queryFn: () => complianceApi.items({ mine: true, to: week, open_only: true } as Parameters<typeof complianceApi.items>[0]),
    enabled: seesFilings && !!me, staleTime: 60_000,
  });
  // Same key as the audit module's own "mine" list, so the cache is shared.
  const audits = useQuery({
    queryKey: ['audits', 'list', { mine: true }],
    queryFn: () => auditApi.list({ mine: true }),
    enabled: seesAudits && !!me, staleTime: 60_000,
  });
  const notices = useQuery({
    queryKey: ['notices-register', 'list', { mine: true }],
    queryFn: () => noticesRegisterApi.list({ mine: true }),
    enabled: seesNotices && !!me, staleTime: 60_000,
  });

  if (!seesTasks && !seesFilings && !seesAudits && !seesNotices) return null;

  if (!me) {
    return (
      <Card title="My work this week" icon={<Sun size={17} />}>
        <p className="text-13 text-inkMuted">Your login is not linked to a staff record, so no tasks, filings or audit papers are assigned to you.</p>
      </Card>
    );
  }

  const openTasks = (tasks.data?.items ?? []).filter((t) => !CLOSED_TASK.has(t.status) && t.due_date);
  const overdueTasks = openTasks.filter((t) => t.overdue || (daysFrom(today, t.due_date) ?? 0) < 0).length;
  const openFilings = (filings.data ?? []).filter((i) => !CLOSED_FILING.has(i.status));
  const overdueFilings = openFilings.filter((i) => (daysFrom(today, i.due_date) ?? 0) < 0).length;
  const noticesDue = (notices.data ?? []).filter((n) => {
    const d = n.days_left !== undefined ? n.days_left : (n.status === 'closed' ? null : daysFrom(today, n.response_due_date));
    return d !== null && d !== undefined && d <= 7;
  });

  const auditFiles = (audits.data?.items ?? []).filter((a) => a.status !== 'archived');
  const toPrepare = (a: AuditListItem) => (a.report_date ? 0 : a.mine?.working_papers_to_prepare
    ?? Math.max(0, (a.progress?.working_papers.total ?? 0) - (a.progress?.working_papers.prepared ?? 0)));
  const notesWaiting = (a: AuditListItem) => a.mine?.review_notes_waiting
    ?? ((a.mine?.review_notes_to_respond ?? 0) + (a.mine?.review_notes_to_clear ?? 0) || (a.mine ? 0 : a.progress?.review_notes_open ?? 0));
  const assemblyIn = (a: AuditListItem) => {
    if (a.locked || a.locked_at || a.signing_partner_id !== me) return null;
    const d = daysFrom(today, a.assembly_due_date);
    return d !== null && d <= 15 ? d : null;
  };
  const prepTotal = auditFiles.reduce((s, a) => s + toPrepare(a), 0);
  const notesTotal = auditFiles.reduce((s, a) => s + notesWaiting(a), 0);
  const assemblyDue = auditFiles.filter((a) => assemblyIn(a) !== null).length;

  // One list, nearest first: what to pick up next.
  const items: Item[] = [
    ...openTasks.map((t) => ({
      key: `t-${t.id}`, kind: 'Task', title: t.title, sub: t.client_name ?? t.priority,
      days: daysFrom(today, t.due_date), href: `/workstation/tasks/${t.id}`,
    })),
    ...openFilings.map((i) => ({
      key: `f-${i.id}`, kind: i.form_name ?? i.form_code, title: i.client_name ?? i.form_code, sub: i.period_label ?? i.period_key,
      days: daysFrom(today, i.due_date), href: '/workstation/compliance?mine=1&within=7',
    })),
    ...noticesDue.map((n) => ({
      key: `n-${n.id}`, kind: 'Notice reply', title: n.client_name ?? n.section ?? 'Notice', sub: [n.authority, n.section].filter(Boolean).join(' · '),
      days: n.days_left ?? daysFrom(today, n.response_due_date), href: '/workstation/notices',
    })),
    ...auditFiles
      .filter((a) => toPrepare(a) > 0 || notesWaiting(a) > 0 || assemblyIn(a) !== null)
      .map((a) => {
        const n = notesWaiting(a);
        const p = toPrepare(a);
        return {
          key: `a-${a.id}`, kind: 'Audit', title: a.client?.company_name ?? a.audit_code,
          sub: [a.audit_code, n ? `${n} note${n === 1 ? '' : 's'} waiting` : '', p ? `${p} paper${p === 1 ? '' : 's'} to prepare` : ''].filter(Boolean).join(' · '),
          days: assemblyIn(a), href: `/workstation/audits/${a.id}${n > 0 ? '?tab=notes' : p > 0 ? '?tab=papers' : ''}`,
        };
      }),
  ].sort((x, y) => (x.days ?? 999) - (y.days ?? 999)).slice(0, 7);

  const loading = [tasks, filings, audits, notices].some((q) => q.isLoading && q.fetchStatus !== 'idle');
  const errors = [tasks, filings, audits, notices].filter((q) => q.isError);
  const error = errors.length === 4 ? ((errors[0].error as Error)?.message ?? 'Could not load your work.') : null;

  return (
    <Card title="My work this week" subtitle="Assigned to you, due in the next 7 days" icon={<Sun size={17} />}
      loading={loading && !items.length} error={error} data-testid="my-work-week">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {seesTasks ? (
          <Tile to="/workstation/tasks" icon={<ListChecks size={15} />} label="Tasks due" value={openTasks.length}
            sub={overdueTasks ? `${overdueTasks} overdue` : 'none overdue'} warn={overdueTasks > 0} failed={tasks.isError} />
        ) : null}
        {seesFilings ? (
          <Tile to="/workstation/compliance?mine=1&within=7" icon={<CalendarClock size={15} />} label="Filings due" value={openFilings.length}
            sub={overdueFilings ? `${overdueFilings} overdue` : 'within 7 days'} warn={overdueFilings > 0} failed={filings.isError} />
        ) : null}
        {seesAudits ? (
          <Tile to="/workstation/audits" icon={<ClipboardCheck size={15} />} label="Audit papers" value={prepTotal}
            sub={`${notesTotal} review note${notesTotal === 1 ? '' : 's'} waiting${assemblyDue ? ` · ${assemblyDue} to assemble` : ''}`}
            warn={notesTotal > 0 || assemblyDue > 0} failed={audits.isError} />
        ) : null}
        {seesNotices ? (
          <Tile to="/workstation/notices" icon={<FileWarning size={15} />} label="Notice replies" value={noticesDue.length}
            sub="reply due ≤ 7 days" warn={noticesDue.length > 0} failed={notices.isError} />
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="text-13 text-inkMuted">{loading ? 'Loading…' : 'Nothing due from you this week.'}</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((it) => (
            <li key={it.key}>
              <Link to={it.href} className="flex items-center gap-3 py-2 px-1 rounded hover:bg-neutral-50">
                <span className="shrink-0 w-[92px] text-11 font-semibold uppercase tracking-[0.04em] text-inkFaint truncate">{it.kind}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-13 font-semibold text-ink truncate">{it.title}</span>
                  {it.sub ? <span className="block text-12 text-inkMuted truncate">{it.sub}</span> : null}
                </span>
                <Due days={it.days} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Tile({ to, icon, label, value, sub, warn, failed }: {
  to: string; icon: ReactNode; label: string; value: number; sub: string; warn?: boolean; failed?: boolean;
}) {
  return (
    <Link to={to} className="rounded-lg bg-neutral-50 px-3 py-2 min-w-0 hover:bg-neutral-100 transition-colors">
      <span className="flex items-center gap-2 text-11 text-inkMuted truncate">{icon}{label}</span>
      <span className={`block text-20 font-semibold tabular-nums ${warn ? 'text-danger' : 'text-ink'}`}>{failed ? '—' : value}</span>
      <span className="block text-11 text-inkMuted truncate">{failed ? 'could not load' : sub}</span>
    </Link>
  );
}

function Due({ days }: { days: number | null }) {
  if (days === null) return null;
  const text = days < 0 ? `${-days}d overdue` : days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days}d`;
  return <span className={`shrink-0 text-12 font-semibold whitespace-nowrap ${days < 0 ? 'text-danger' : days <= 1 ? 'text-warning' : 'text-inkMuted'}`}>{text}</span>;
}
