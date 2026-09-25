/**
 * Home dashboard — the firm's HR and finance overview.
 *
 * Deliberately NOT a copy of the Workstation dashboard: clients, leads and
 * services live there. This page is what the people running the firm need
 * first — who is in today, what is waiting on them, and where payroll and
 * the ledger stand.
 *
 *   Everyone except the MD ... their own Check in / Check out (the real,
 *                              GPS-verified TodayCard from Attendance);
 *                              staff without a team view also get their
 *                              leave balances.
 *   The MD .................. no check-in — the page opens on the team.
 *   Team-scoped viewers ..... present / absent today, by department.
 *   Approvers ............... what is waiting on them.
 *   HR / Finance / MD ....... payroll, ledger, recent activity.
 *
 * Every figure comes from the API. Each section is shown only to roles that
 * hold its permission, so nobody sees an empty card they cannot use.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { api } from '@/services/api';
import { Card } from '@/modules/dashboardV2/Card';
import { formatDate, formatINR, formatTime } from '@/modules/dashboardV2/format';
import { TodayCard } from '@/modules/attendance/TodayCard';
import { BalancesCard } from '@/modules/leave/BalancesCard';
import { attendanceApi, type TodayResponse } from '@/modules/attendance/api';
import { payrollApi } from '@/modules/payroll/api';
import { accountsApi } from '@/modules/accounts/api';
import type { PayrollRun } from '@/data/models';

/** Roles that run the firm rather than clock in to it. */
const NO_CHECK_IN_ROLES = ['md'];

interface DepartmentRow { id: string; name: string; headcount: number; present: number; absent: number; on_leave: number }
interface PendingAction {
  kind: 'leave' | 'correction' | 'document_expiring' | 'expense';
  id: string; title: string; subtitle: string; action_url: string; created_at: string;
}
interface ActivityRow { id: string; action: string; entity_type: string; created_at: string; actor_label: string }

const dashboardApi = {
  departments: () => api.get<{ items: DepartmentRow[] }>('/api/dashboard/departments'),
  pending: () => api.get<{ items: PendingAction[]; count: number }>('/api/dashboard/pending-actions'),
  activity: () => api.get<{ items: ActivityRow[] }>('/api/dashboard/activity'),
};

const paise = (p: number) => formatINR(p / 100);

export function DashboardV2Page() {
  const { session } = useAuth();
  const role = session?.role.code;

  const checksIn = !!session?.employee && !NO_CHECK_IN_ROLES.includes(role ?? '');
  const seesTeam = can(role, 'attendance.read', 'department');
  const approves = can(role, 'leave.approve', 'department') || can(role, 'expense.approve', 'department')
    || can(role, 'attendance.correct.approve', 'department');
  const seesPayroll = can(role, 'payroll.view', 'organisation');
  const seesLedger = can(role, 'accounts.read', 'organisation') || can(role, 'accounts.manage', 'organisation');
  const seesActivity = can(role, 'audit.read.all', 'organisation') || can(role, 'audit.read.hr', 'organisation');

  const today = useQuery({ queryKey: ['attendance', 'today'], queryFn: attendanceApi.today, enabled: seesTeam });
  const departments = useQuery({ queryKey: ['dashboard', 'departments'], queryFn: dashboardApi.departments, enabled: seesTeam });
  const pending = useQuery({ queryKey: ['dashboard', 'pending'], queryFn: dashboardApi.pending, enabled: approves });
  const runs = useQuery({ queryKey: ['payroll', 'runs'], queryFn: payrollApi.runs.list, enabled: seesPayroll });
  const ledger = useQuery({ queryKey: ['accounts', 'summary'], queryFn: accountsApi.summary, enabled: seesLedger });
  const activity = useQuery({ queryKey: ['dashboard', 'activity'], queryFn: dashboardApi.activity, enabled: seesActivity });

  const err = (q: { error: unknown }) => (q.error ? 'Could not load.' : null);

  return (
    <div className="space-y-5">
      <GreetingLine />

      {checksIn ? <TodayCard /> : null}

      {/* Staff without a team view get their own leave position instead. */}
      {checksIn && !seesTeam ? <BalancesCard /> : null}

      {/* Attendance first — who is in today is what the day is run from. */}
      {seesTeam ? (
        <div className="grid gap-5 grid-cols-1 lg:grid-cols-5">
          <Card title="Today's attendance" className="lg:col-span-3"
            action={{ label: 'Attendance', href: '/hrms/attendance' }}
            loading={today.isLoading} error={err(today)}>
            {today.data?.counts ? <AttendanceSummary counts={today.data.counts} /> : null}
          </Card>
          <Card title="Departments today" className="lg:col-span-2"
            loading={departments.isLoading} error={err(departments)}
            empty={!!departments.data && departments.data.items.length === 0}>
            {departments.data ? <DepartmentsTable rows={departments.data.items} /> : null}
          </Card>
        </div>
      ) : null}

      {(seesPayroll || seesLedger || approves) ? (
        <section className="grid gap-5 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4" data-testid="overview-tiles">
          {approves ? (
            <Tile label="Waiting on you" href="/hrms/leave?tab=queue"
              value={pending.data ? String(pending.data.count) : '—'}
              note={pending.data ? pendingNote(pending.data.items) : 'Leave, expenses, corrections'}
              emphasis={!!pending.data?.count} />
          ) : null}
          {seesTeam && today.data?.counts ? (
            <Tile label="Headcount" href="/hrms/employees" value={String(today.data.counts.total)} note="Active employees" />
          ) : null}
          {seesPayroll ? <PayrollTile runs={runs.data?.items} loading={runs.isLoading} /> : null}
          {seesLedger ? (
            <Tile label="Ledger balance" href="/hrms/accounts"
              value={ledger.data ? paise(ledger.data.totals.balance_paise) : '—'}
              note={ledger.data
                ? `This month · out ${paise(ledger.data.this_month.debit_paise)} · in ${paise(ledger.data.this_month.credit_paise)}`
                : 'Accounts'} />
          ) : null}
        </section>
      ) : null}

      {approves ? (
        <Card title="Needs your attention"
          loading={pending.isLoading} error={err(pending)}
          empty={!!pending.data && pending.data.items.length === 0}
          emptyMessage="Nothing is waiting on you.">
          {pending.data ? <PendingList items={pending.data.items} /> : null}
        </Card>
      ) : null}

      {seesActivity ? (
        <Card title="Recent activity" loading={activity.isLoading} error={err(activity)}
          empty={!!activity.data && activity.data.items.length === 0}
          emptyMessage="No changes recorded yet. Sign-ins are not listed here.">
          {activity.data ? <ActivityList items={activity.data.items.slice(0, 8)} /> : null}
        </Card>
      ) : null}
    </div>
  );
}

// ── Greeting ───────────────────────────────────────────────────────────
function GreetingLine() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const { session } = useAuth();
  const firstName = useMemo(() => session?.employee?.full_name?.trim().split(/\s+/)[0] ?? null, [session]);
  const h = now.getHours();
  const partOfDay = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return (
    <div data-testid="timestamp">
      <div className="text-20 font-semibold text-ink">{partOfDay}{firstName ? `, ${firstName}` : ''}</div>
      <div className="text-13 text-inkMuted mt-1">{formatDate(now)} · {formatTime(now)}</div>
    </div>
  );
}

// ── Attendance: present and absent first, the rest beside them ─────────
function AttendanceSummary({ counts }: { counts: NonNullable<TodayResponse['counts']> }) {
  // Present here means "in today" — on time, late or working from home —
  // the same rule the Departments table uses, so the two agree.
  const present = counts.present + counts.late + counts.wfh;
  const pct = counts.total ? Math.round((present / counts.total) * 100) : 0;
  const minor: Array<[string, number]> = [
    ['Late', counts.late],
    ['Work from home', counts.wfh],
    ['On leave', counts.on_leave],
    ['Missing check-out', counts.missing_check_out],
  ];
  return (
    <div data-testid="attendance-summary">
      <div className="grid grid-cols-2 gap-4">
        <BigStat label="Present" value={present} of={counts.total} tone="success" />
        <BigStat label="Absent" value={counts.absent} of={counts.total} tone={counts.absent > 0 ? 'danger' : 'muted'} />
      </div>
      <div className="mt-4 h-2 rounded-full bg-border overflow-hidden" aria-label={`${pct}% present`}>
        <div className="h-full bg-success" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-12 text-inkMuted">{pct}% of {counts.total} in today</div>
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
        {minor.map(([label, value]) => (
          <div key={label} className="rounded-md border border-border px-3 py-2">
            <div className="text-18 font-semibold tabular-nums text-ink">{value}</div>
            <div className="text-11 uppercase tracking-[0.06em] text-inkFaint mt-0.5">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BigStat({ label, value, of, tone }: { label: string; value: number; of: number; tone: 'success' | 'danger' | 'muted' }) {
  const colour = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-ink';
  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <div className="text-11 font-medium uppercase tracking-[0.06em] text-inkFaint">{label}</div>
      <div className="flex items-baseline gap-2 mt-1">
        <span className={`text-34 font-semibold tabular-nums leading-none ${colour}`}>{value}</span>
        <span className="text-13 text-inkMuted tabular-nums">/ {of}</span>
      </div>
    </div>
  );
}

// ── Overview tiles ────────────────────────────────────────────────────
function Tile({ label, value, note, href, emphasis }: {
  label: string; value: string; note: string; href: string; emphasis?: boolean;
}) {
  return (
    <Link to={href}
      className="group block bg-surface border border-border rounded-lg shadow-card p-5 hover:border-gold transition-colors">
      <div className="flex items-center justify-between">
        <span className="text-11 font-semibold uppercase tracking-[0.06em] text-inkFaint">{label}</span>
        <ChevronRight size={14} strokeWidth={1.75} className="text-inkFaint group-hover:text-gold" />
      </div>
      <div className={`text-28 font-semibold tabular-nums mt-2 ${emphasis ? 'text-danger' : 'text-ink'}`}>{value}</div>
      <div className="text-12 text-inkMuted mt-1 truncate" title={note}>{note}</div>
    </Link>
  );
}

const STAGE_LABEL: Record<string, string> = {
  draft: 'Draft', hr_review: 'HR review', finance_review: 'Finance review',
  approved: 'Approved', processed: 'Processed', paid: 'Paid',
};

function PayrollTile({ runs, loading }: { runs: PayrollRun[] | undefined; loading: boolean }) {
  // The run for the most recent period is the one anyone asks about.
  const latest = runs?.slice().sort((a, b) => (a.period_start < b.period_start ? 1 : -1))[0];
  const period = latest
    ? new Date(`${latest.period_start}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
    : null;
  return (
    <Tile label="Payroll" href="/hrms/payroll"
      value={loading ? '—' : latest ? paise(latest.net_total_paise) : 'No run yet'}
      note={latest ? `${period} · ${STAGE_LABEL[latest.stage] ?? latest.stage} · ${latest.headcount} employees` : 'Start this month’s run'} />
  );
}

function pendingNote(items: PendingAction[]): string {
  const n = (k: PendingAction['kind']) => items.filter((i) => i.kind === k).length;
  const parts = [
    [n('leave'), 'leave'], [n('expense'), 'expense'], [n('correction'), 'correction'], [n('document_expiring'), 'expiring doc'],
  ].filter(([c]) => (c as number) > 0).map(([c, l]) => `${c} ${l}${c === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'All clear';
}

// ── Needs your attention ───────────────────────────────────────────────
const KIND_LABEL: Record<PendingAction['kind'], string> = {
  leave: 'Leave', expense: 'Expense', correction: 'Correction', document_expiring: 'Expiring',
};

function PendingList({ items }: { items: PendingAction[] }) {
  const shown = items.slice(0, 7);
  return (
    <div>
      <ul className="divide-y divide-border">
        {shown.map((i) => (
          <li key={`${i.kind}-${i.id}`}>
            <Link to={i.action_url} className="flex items-center gap-3 py-2.5 hover:bg-canvas -mx-2 px-2 rounded-md">
              <span className="shrink-0 w-[84px] text-11 font-semibold uppercase tracking-[0.06em] text-inkFaint">
                {KIND_LABEL[i.kind]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-14 text-ink truncate">{i.title}</span>
                <span className="block text-12 text-inkMuted truncate">{i.subtitle}</span>
              </span>
              <ChevronRight size={14} strokeWidth={1.75} className="text-inkFaint shrink-0" />
            </Link>
          </li>
        ))}
      </ul>
      {items.length > shown.length ? (
        <div className="text-12 text-inkMuted mt-2">+{items.length - shown.length} more</div>
      ) : null}
    </div>
  );
}

// ── Departments ───────────────────────────────────────────────────────
function DepartmentsTable({ rows }: { rows: DepartmentRow[] }) {
  return (
    <table className="w-full border-collapse tabular-nums" data-testid="departments-table">
      <thead>
        <tr>
          {['Department', 'Staff', 'Present', 'Absent', 'Leave'].map((c, i) => (
            <th key={c} className={`${i ? 'text-right' : 'text-left'} text-11 font-semibold uppercase tracking-[0.06em] text-inkFaint py-2 border-b border-border`}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="h-9 border-b border-border last:border-b-0">
            <td className="text-14 text-ink">{r.name}</td>
            <td className="text-14 text-inkMuted text-right">{r.headcount}</td>
            <td className="text-14 text-ink text-right">{r.present}</td>
            <td className={`text-14 text-right ${r.absent > 0 ? 'text-danger font-medium' : 'text-inkMuted'}`}>{r.absent}</td>
            <td className="text-14 text-inkMuted text-right">{r.on_leave}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Recent activity ───────────────────────────────────────────────────
function ActivityList({ items }: { items: ActivityRow[] }) {
  const pretty = (a: string) => a.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return (
    <ul className="divide-y divide-border">
      {items.map((a) => (
        <li key={a.id} className="flex items-center justify-between gap-3 py-2">
          <span className="min-w-0 text-14 text-ink truncate">
            <span className="font-medium">{a.actor_label}</span>
            <span className="text-inkMuted"> · {pretty(a.action)}</span>
          </span>
          <span className="shrink-0 text-12 text-inkFaint tabular-nums">
            {formatDate(new Date(a.created_at))} {formatTime(new Date(a.created_at))}
          </span>
        </li>
      ))}
    </ul>
  );
}
