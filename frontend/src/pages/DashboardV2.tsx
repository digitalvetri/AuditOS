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
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, ArrowUpRight, BellRing, Building2, CalendarCheck, ChevronRight, ClockAlert, FileWarning, Inbox,
  Landmark, Plane, Receipt, Users, UserX, Wallet,
} from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { api } from '@/services/api';
import { Card } from '@/modules/dashboardV2/Card';
import { AuditOrbit } from '@/modules/dashboardV2/AuditOrbit';
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
  const counts = today.data?.counts;
  const showSide = seesTeam || seesActivity;

  return (
    <div className="dash-v3">
      <div className={`grid gap-5 grid-cols-1 ${showSide ? 'xl:grid-cols-[minmax(0,1fr)_340px]' : ''}`}>
        {/* ── Main column ─────────────────────────────────────────────── */}
        <div className="space-y-5 min-w-0">
          <Hero counts={counts} waiting={approves ? pending.data?.count : undefined} seesTeam={seesTeam} />

          {checksIn ? <TodayCard /> : null}
          {/* Staff without a team view get their own leave position instead. */}
          {checksIn && !seesTeam ? <BalancesCard /> : null}

          {(seesPayroll || seesLedger || approves || (seesTeam && counts)) ? (
            <section className="grid gap-4 grid-cols-1 sm:grid-cols-2 2xl:grid-cols-4" data-testid="overview-tiles">
              {approves ? (
                <Tile label="Waiting on you" href="/hrms/leave?tab=queue" icon={Inbox} tint="amber"
                  value={pending.data ? String(pending.data.count) : '—'}
                  note={pending.data ? pendingNote(pending.data.items) : 'Leave, expenses, corrections'}
                  emphasis={!!pending.data?.count} />
              ) : null}
              {seesTeam && counts ? (
                <Tile label="Headcount" href="/hrms/employees" icon={Users} tint="blue" value={String(counts.total)} note="Active employees" />
              ) : null}
              {seesPayroll ? <PayrollTile runs={runs.data?.items} loading={runs.isLoading} /> : null}
              {seesLedger ? (
                <Tile label="Ledger balance" href="/hrms/accounts" icon={Landmark} tint="indigo"
                  value={ledger.data ? paise(ledger.data.totals.balance_paise) : '—'}
                  note={ledger.data
                    ? `This month · out ${paise(ledger.data.this_month.debit_paise)} · in ${paise(ledger.data.this_month.credit_paise)}`
                    : 'Accounts'} />
              ) : null}
            </section>
          ) : null}

          {approves ? (
            <Card title="Needs your attention" subtitle="Approvals and expiring records waiting on you"
              icon={<BellRing size={16} strokeWidth={1.9} />}
              action={{ label: 'Open queue', href: '/hrms/leave?tab=queue' }}
              loading={pending.isLoading} error={err(pending)}
              empty={!!pending.data && pending.data.items.length === 0}
              emptyMessage="Nothing is waiting on you.">
              {pending.data ? <PendingList items={pending.data.items} /> : null}
            </Card>
          ) : null}

          {seesTeam ? (
            <Card title="Departments today" subtitle="Who is in, by department"
              icon={<Building2 size={16} strokeWidth={1.9} />}
              action={{ label: 'Attendance', href: '/hrms/attendance' }}
              loading={departments.isLoading} error={err(departments)}
              empty={!!departments.data && departments.data.items.length === 0}>
              {departments.data ? <DepartmentsTable rows={departments.data.items} /> : null}
            </Card>
          ) : null}
        </div>

        {/* ── Side column ─────────────────────────────────────────────── */}
        {showSide ? (
          <aside className="space-y-5 min-w-0">
            {seesTeam ? (
              <Card title="Today" icon={<CalendarCheck size={16} strokeWidth={1.9} />}
                loading={today.isLoading} error={err(today)}>
                {counts ? <TodayOverview counts={counts} /> : null}
              </Card>
            ) : null}
            {seesActivity ? (
              <Card title="Recent activity" icon={<Activity size={16} strokeWidth={1.9} />}
                badge="Live"
                loading={activity.isLoading} error={err(activity)}
                empty={!!activity.data && activity.data.items.length === 0}
                emptyMessage="No changes recorded yet. Sign-ins are not listed here.">
                {activity.data ? <ActivityList items={activity.data.items.slice(0, 8)} /> : null}
              </Card>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

// ── Hero ──────────────────────────────────────────────────────────────

function Hero({ counts, waiting, seesTeam }: {
  counts: TodayResponse['counts'] | undefined; waiting: number | undefined; seesTeam: boolean;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const { session } = useAuth();
  const firstName = useMemo(() => session?.employee?.full_name?.trim().split(/\s+/)[0] ?? null, [session]);
  const h = now.getHours();
  const partOfDay = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const inToday = counts ? counts.present + counts.late + counts.wfh : null;
  const summary = [
    counts && inToday !== null ? `${inToday} of ${counts.total} in today` : null,
    waiting ? `${waiting} waiting on you` : null,
  ].filter(Boolean).join(' · ');
  return (
    <section className="dash-hero relative overflow-hidden rounded-[14px] px-6 py-6 md:px-8 md:py-7 text-white" data-testid="timestamp">
      <div className="relative z-[1] max-w-[560px]">
        <span className="inline-flex items-center gap-2 h-6 px-3 rounded-full text-11 font-semibold uppercase tracking-[0.12em] text-[#a7f3d0] bg-white/[0.08] ring-1 ring-inset ring-white/15">
          <span className="rounded-full" style={{ background: '#34d399', width: 6, height: 6 }} />
          {formatDate(now)} · {formatTime(now)}
        </span>
        <h1 className="mt-3 text-[30px] md:text-[34px] leading-[1.1] font-semibold tracking-[-0.02em]">
          {partOfDay}{firstName ? `, ${firstName}` : ''}.
        </h1>
        <p className="mt-2 text-14 text-white/70">
          {summary || 'Here is how the firm stands today.'}
        </p>
        {seesTeam ? (
          <Link to="/hrms/attendance"
            className="mt-5 inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-white text-[#0f2249] text-13 font-semibold hover:bg-white/90 transition-colors">
            Open attendance <ArrowUpRight size={15} strokeWidth={2} />
          </Link>
        ) : null}
      </div>
      {/* Decorative: audit instruments orbiting a shield; they scatter from
          the cursor and spring back onto the ring (AuditOrbit). */}
      <div aria-hidden className="hidden md:flex absolute inset-y-0 right-4 lg:right-10 w-[260px] items-center justify-center">
        <AuditOrbit />
      </div>
    </section>
  );
}

// ── Today overview (side) ─────────────────────────────────────────────
function TodayOverview({ counts }: { counts: NonNullable<TodayResponse['counts']> }) {
  const present = counts.present + counts.late + counts.wfh;
  const rows: Array<[string, number, string]> = [
    ['Present', counts.present, '#10b981'],
    ['Late', counts.late, '#f59e0b'],
    ['Work from home', counts.wfh, '#6366f1'],
    ['On leave', counts.on_leave, '#3b82f6'],
    ['Missing check-out', counts.missing_check_out, '#94a3b8'],
    ['Absent', counts.absent, '#ef4444'],
  ];
  return (
    <div data-testid="attendance-summary">
      <div className="num-display text-[34px] leading-none text-ink">
        {present}<span className="text-16 text-inkMuted font-semibold"> / {counts.total}</span>
      </div>
      <div className="text-12 text-inkMuted mt-1">In today — on time, late or from home</div>
      <div className="grid grid-cols-2 gap-2 mt-4">
        <MiniStat icon={<UserX size={15} strokeWidth={1.9} />} value={counts.absent} label="Absent" danger={counts.absent > 0} />
        <MiniStat icon={<Plane size={15} strokeWidth={1.9} />} value={counts.on_leave} label="On leave" />
      </div>
      <div className="text-11 font-semibold uppercase tracking-[0.1em] text-inkFaint mt-5 mb-2">Attendance breakdown</div>
      <ul className="space-y-1">
        {rows.map(([label, value, dot]) => (
          <li key={label} className="flex items-center gap-3 h-8 px-2 rounded-md hover:bg-[#f4f6fa]">
            <span className="rounded-full shrink-0" style={{ background: dot, width: 7, height: 7 }} />
            <span className="flex-1 text-13 text-ink">{label}</span>
            <span className="num-display text-14 text-ink">{value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MiniStat({ icon, value, label, danger }: { icon: ReactNode; value: number; label: string; danger?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-3 py-2" style={{ background: '#f4f6fa', border: '1px solid #e8ecf3' }}>
      <span className="h-7 w-7 rounded-md inline-flex items-center justify-center bg-white text-primary shadow-card">{icon}</span>
      <div className="min-w-0">
        <div className={`num-display text-18 leading-tight ${danger ? 'text-danger' : 'text-ink'}`}>{value}</div>
        <div className="text-11 text-inkMuted">{label}</div>
      </div>
    </div>
  );
}

// ── Overview tiles ────────────────────────────────────────────────────
const TILE_TINT = {
  amber: { bg: '#fff7e6', fg: '#b45309', ring: '#fde7bf' },
  blue: { bg: '#eaf2ff', fg: '#1d4ed8', ring: '#d4e3fb' },
  green: { bg: '#e9f9f1', fg: '#047857', ring: '#cdeede' },
  indigo: { bg: '#eef0ff', fg: '#4338ca', ring: '#dcdffb' },
};

function Tile({ label, value, note, href, emphasis, icon: Icon, tint }: {
  label: string; value: string; note: string; href: string; emphasis?: boolean;
  icon: typeof Users; tint: keyof typeof TILE_TINT;
}) {
  const t = TILE_TINT[tint];
  return (
    <Link to={href} className="group dash-card dash-card-link block p-5">
      <div className="flex items-start justify-between">
        <span className="h-10 w-10 rounded-lg inline-flex items-center justify-center" style={{ background: t.bg, color: t.fg, boxShadow: `inset 0 0 0 1px ${t.ring}` }}>
          <Icon size={18} strokeWidth={1.9} />
        </span>
        <span className="h-7 w-7 rounded-full inline-flex items-center justify-center bg-[#f1f4f9] text-inkMuted group-hover:bg-primary group-hover:text-white transition-colors">
          <ChevronRight size={14} strokeWidth={2} />
        </span>
      </div>
      <div className="text-13 font-medium text-inkMuted mt-3">{label}</div>
      <div className={`num-display text-28 leading-tight mt-1 ${emphasis ? 'text-danger' : 'text-ink'}`}>{value}</div>
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
    <Tile label="Payroll" href="/hrms/accounts/payroll" icon={Wallet} tint="green"
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
const KIND_ICON: Record<PendingAction['kind'], typeof Users> = {
  leave: Plane, expense: Receipt, correction: ClockAlert, document_expiring: FileWarning,
};
const KIND_TINT: Record<PendingAction['kind'], { bg: string; fg: string }> = {
  leave: { bg: '#eef2ff', fg: '#4338ca' },
  expense: { bg: '#ecfdf5', fg: '#047857' },
  correction: { bg: '#f1f5f9', fg: '#475569' },
  document_expiring: { bg: '#fffbeb', fg: '#b45309' },
};

function PendingList({ items }: { items: PendingAction[] }) {
  const shown = items.slice(0, 7);
  return (
    <div>
      <ul className="space-y-2">
        {shown.map((i) => (
          <li key={`${i.kind}-${i.id}`}>
            <Link to={i.action_url} className="dash-row flex items-center gap-3 px-4 py-3">
              <span className="shrink-0 h-9 w-9 rounded-lg inline-flex items-center justify-center"
                style={{ background: KIND_TINT[i.kind].bg, color: KIND_TINT[i.kind].fg }} aria-hidden>
                {(() => { const I = KIND_ICON[i.kind]; return <I size={16} strokeWidth={1.9} />; })()}
              </span>
              <span className="shrink-0 w-[96px] order-last hidden sm:block text-right">
                <span className="inline-flex items-center h-6 px-3 rounded-full text-12 font-medium"
                  style={{ background: KIND_TINT[i.kind].bg, color: KIND_TINT[i.kind].fg }}>
                  {KIND_LABEL[i.kind]}
                </span>
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-14 text-ink truncate">{i.title}</span>
                <span className="block text-12 text-inkMuted truncate">{i.subtitle}</span>
              </span>
              <ChevronRight size={14} strokeWidth={1.75} className="text-inkFaint shrink-0 order-last" />
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
    <div>
    <table className="hr-float w-full border-collapse tabular-nums" data-testid="departments-table">
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
    </div>
  );
}

// ── Recent activity ───────────────────────────────────────────────────
function ActivityList({ items }: { items: ActivityRow[] }) {
  const pretty = (a: string) => a.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return (
    <ul className="space-y-2">
      {items.map((a) => (
        <li key={a.id} className="dash-row flex items-start gap-3 px-3 py-2">
          <span className="shrink-0 h-8 w-8 rounded-full inline-flex items-center justify-center text-12 font-semibold text-white mt-px"
            style={{ background: 'linear-gradient(180deg, #2a4f8f, #1b3a6f)' }} aria-hidden>
            {a.actor_label.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '·'}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-13 font-semibold text-ink truncate">{a.actor_label}</span>
              <span className="shrink-0 text-11 text-inkFaint tabular-nums">{formatTime(new Date(a.created_at))}</span>
            </span>
            <span className="block text-12 text-inkMuted truncate">{pretty(a.action)} · {formatDate(new Date(a.created_at))}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
