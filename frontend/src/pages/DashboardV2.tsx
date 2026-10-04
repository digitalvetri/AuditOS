/**
 * Home dashboard — the firm's morning brief.
 *
 *   Brief (hero) ...... greeting, up to three insights worth acting on, and a
 *                       GST filing gauge (or today's attendance ring).
 *   KPI row ........... billed this month, receivables, filings due in 7 days,
 *                       team in today — or, for roles without those, waiting
 *                       on you / ledger / today's schedule.
 *   Cash flow ......... billed vs collected, last 6 months.
 *   Deadlines ......... GST and TDS work falling due in the next 30 days.
 *   Approval queue .... pending items with single and bulk approve.
 *   Team today / Activity (side column).
 *   Everyone except the MD keeps their own Check in / Check out (TodayCard).
 *
 * Every figure comes from the API (see modules/dashboardV2/brief.ts for the
 * derivations). Each section is fetched and shown only for roles holding its
 * permission, so nobody sees an empty or broken card.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PostRegistrationDashboardSection } from '@/modules/postRegistration/DashboardSection';
import {
  AlertTriangle, ArrowUpRight, CalendarClock, CalendarDays, Check, CheckCircle2, ChevronRight, ClockAlert,
  FileText, FileWarning, Inbox, Landmark, Plane, Receipt, Users, Wallet,
} from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { api } from '@/services/api';
import { useToast } from '@/components/Toast';
import { AreaChart, Avatar, Donut, Gauge, SegBar, Sparkline } from '@/components/viz';
import { formatDate, formatINR, formatTime } from '@/modules/dashboardV2/format';
import {
  addDaysISO, buildInsights, deadlines as buildDeadlines, dueWithin, filingStats, inrCompact, istToday,
  periodName, previousPeriod, returnCells, type Deadline, type Insight,
} from '@/modules/dashboardV2/brief';
import { TodayCard } from '@/modules/attendance/TodayCard';
import { BalancesCard } from '@/modules/leave/BalancesCard';
import { attendanceApi, type TodayResponse } from '@/modules/attendance/api';
import { accountsApi } from '@/modules/accounts/api';
import { workstationApi } from '@/modules/workstation/api';
import { paymentSummaryApi } from '@/modules/paymentSummary/api';
import { gstApi } from '@/modules/workstation/gst/api';
import { tdsApi } from '@/modules/tds/api';
import { leaveApi } from '@/modules/leave/api';
import { expensesApi } from '@/modules/expenses/api';
import { fyLabelForDate } from '@/pages/workstation/tds/config';
import type { FollowUp } from '@/modules/workstation/types';

/** Roles that run the firm rather than clock in to it. */
const NO_CHECK_IN_ROLES = ['md'];

interface PendingAction {
  kind: 'leave' | 'correction' | 'document_expiring' | 'expense';
  id: string; title: string; subtitle: string; action_url: string; created_at: string;
  /** The server's verdict: can this viewer approve it in one click? */
  approvable?: boolean;
}
interface ActivityRow { id: string; action: string; entity_type: string; created_at: string; actor_label: string }

const dashboardApi = {
  pending: () => api.get<{ items: PendingAction[]; count: number }>('/api/dashboard/pending-actions'),
  activity: () => api.get<{ items: ActivityRow[] }>('/api/dashboard/activity'),
};

const paise = (p: number) => formatINR(p / 100);
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

export function DashboardV2Page() {
  const { session } = useAuth();
  const role = session?.role.code;
  const today = istToday();
  const period = previousPeriod(today);

  const checksIn = !!session?.employee && !NO_CHECK_IN_ROLES.includes(role ?? '');
  const seesTeam = can(role, 'attendance.read', 'department');
  const approves = can(role, 'leave.approve', 'department') || can(role, 'expense.approve', 'department')
    || can(role, 'attendance.correct.approve', 'department');
  const seesLedger = can(role, 'accounts.read', 'organisation') || can(role, 'accounts.manage', 'organisation');
  const seesActivity = can(role, 'audit.read.all', 'organisation') || can(role, 'audit.read.hr', 'organisation');
  const seesCalendar = can(role, 'workstation.followup.read', 'self');
  const seesBilling = can(role, 'payment_summary.read', 'organisation');
  const seesGst = can(role, 'workstation.gst.read', 'self');
  const seesTds = can(role, 'workstation.service.read', 'self');

  const attendance = useQuery({ queryKey: ['attendance', 'today'], queryFn: attendanceApi.today, enabled: seesTeam });
  const pending = useQuery({ queryKey: ['dashboard', 'pending'], queryFn: dashboardApi.pending, enabled: approves });
  const ledger = useQuery({ queryKey: ['accounts', 'summary'], queryFn: accountsApi.summary, enabled: seesLedger });
  const activity = useQuery({ queryKey: ['dashboard', 'activity'], queryFn: dashboardApi.activity, enabled: seesActivity });
  const schedule = useQuery({
    queryKey: ['workstation', 'follow-ups', 'today'],
    queryFn: () => workstationApi.listFollowUps({ range: 'today' }),
    enabled: seesCalendar,
  });
  const money = useQuery({ queryKey: ['payment-summary'], queryFn: () => paymentSummaryApi.summary(), enabled: seesBilling });
  const monthly = useQuery({ queryKey: ['payment-summary', 'monthly', 6], queryFn: () => paymentSummaryApi.monthly(6), enabled: seesBilling });
  const gst = useQuery({ queryKey: ['gst', 'client-dashboard', period], queryFn: () => gstApi.clientDashboard(period), enabled: seesGst });
  const fy = fyLabelForDate(new Date());
  const tds = useQuery({ queryKey: ['tds', 'overview', fy], queryFn: () => tdsApi.overview(fy), enabled: seesTds });

  const counts = attendance.data?.counts ?? null;
  const cells = useMemo(() => returnCells(gst.data), [gst.data]);
  const stats = useMemo(() => filingStats(cells), [cells]);
  const deadlineList = useMemo(() => buildDeadlines(cells, period, tds.data, today), [cells, period, tds.data, today]);
  const due7 = dueWithin(deadlineList, today, 7);
  const firstDue = deadlineList.find((d) => d.date >= today)?.date ?? null;
  const todays = schedule.data?.items.filter((f) => f.status !== 'cancelled');

  const insights = buildInsights({
    money: money.data,
    gst: seesGst && gst.data ? { stats, period } : undefined,
    tds: tds.data,
    dueSoon: seesGst || seesTds ? { count: due7, firstDate: firstDue } : undefined,
    pendingCount: pending.data?.count,
    absent: counts?.absent,
    formatMoney: inrCompact,
    formatDay: dayLabel,
  });

  const hasDeadlines = (seesGst || seesTds) && (gst.isSuccess || tds.isSuccess);
  const showSide = seesTeam || seesActivity;

  const kpiTiles = [
    approves && pending.data ? <WaitingTile key="waiting" items={pending.data.items} /> : null,
    seesBilling && money.data ? <ReceivablesTile key="recv" data={money.data} /> : null,
    (seesGst || seesTds) && hasDeadlines ? <FilingsTile key="filings" due={due7} list={deadlineList} today={today} /> : null,
    seesTeam && counts ? <TeamTile key="team" counts={counts} /> : null,
    seesBilling && monthly.data ? <BilledTile key="billed" months={monthly.data.months} /> : null,
    seesLedger && ledger.data ? (
      <Kpi key="ledger" href="/hrms/accounts" icon={Landmark} tone="lavender" label="Ledger balance"
        value={paise(ledger.data.totals.balance_paise)}
        sub={`This month · out ${paise(ledger.data.this_month.debit_paise)} · in ${paise(ledger.data.this_month.credit_paise)}`} />
    ) : null,
    seesCalendar && todays ? (
      <Kpi key="schedule" href="/workstation/calendar" icon={CalendarDays} tone="blue" label="Today's schedule"
        value={String(todays.length)} sub={scheduleNote(todays)} />
    ) : null,
  ].filter(Boolean).slice(0, 4);
  const loadingBrief = [money, gst, tds, pending, attendance].some((q) => q.isLoading && q.fetchStatus !== 'idle');
  const gauge = seesGst && gst.data && stats.total > 0 ? { stats, period } : null;

  return (
    <div className="dash-v3 space-y-5">
      <Greeting insights={insights} counts={counts} waiting={pending.data?.count} seesTeam={seesTeam} />

      {checksIn ? <TodayCard /> : null}
      {/* Staff without a team view get their own leave position instead. */}
      {checksIn && !seesTeam ? <BalancesCard /> : null}

      {/* Bento: the dark brief tile beside a 2×2 of pastel figures. */}
      <section className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)]" data-testid="overview-tiles">
        <BriefTile insights={insights} loading={loadingBrief} className="sm:col-span-2 xl:col-span-1 xl:row-span-2" />
        {kpiTiles}
      </section>

      {/* Private Limited post-registration compliance (INC-20A, ADTC) — hidden until there is any. */}
      {seesTds ? <PostRegistrationDashboardSection /> : null}

      {seesBilling || gauge ? (
        <div className={`grid gap-5 grid-cols-1 ${seesBilling && gauge ? 'xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,1fr)]' : ''}`}>
          {seesBilling ? <CashFlowCard months={monthly.data?.months} avgDays={monthly.data?.avg_days_to_collect ?? null} money={money.data} loading={monthly.isLoading} error={!!monthly.error} /> : null}
          {gauge ? <GstTile {...gauge} /> : null}
        </div>
      ) : null}

      {approves || showSide || hasDeadlines ? (
        <div className={`grid gap-5 grid-cols-1 ${approves && (showSide || hasDeadlines) ? 'xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]' : ''}`}>
          {approves ? <ApprovalQueue data={pending.data} loading={pending.isLoading} error={!!pending.error} /> : null}
          {showSide || hasDeadlines ? (
            <aside className="space-y-5 min-w-0">
              {hasDeadlines ? <DeadlinesCard list={deadlineList} today={today} /> : null}
              {seesTeam ? <TeamToday counts={counts} loading={attendance.isLoading} error={!!attendance.error} /> : null}
              {seesActivity ? <ActivityCard data={activity.data} loading={activity.isLoading} error={!!activity.error} /> : null}
            </aside>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Shared card shell ─────────────────────────────────────────────────────

function Panel({ title, sub, right, children, className = '', id }: {
  title: string; sub?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; id?: string;
}) {
  return (
    <section id={id} className={'dash-card dash-rise min-w-0 overflow-hidden ' + className}>
      <header className="flex items-center gap-3 px-5 pt-4 pb-3 flex-wrap">
        <h2 className="text-15 font-semibold text-ink tracking-[-0.015em]">{title}</h2>
        {sub ? <span className="text-12 text-inkMuted">{sub}</span> : null}
        <span className="flex-1" />
        {right}
      </header>
      {children}
    </section>
  );
}

function State({ loading, error, empty, emptyText, children }: {
  loading?: boolean; error?: boolean; empty?: boolean; emptyText?: ReactNode; children: ReactNode;
}) {
  if (loading) return <div className="mx-5 mb-5 h-24 rounded-lg bg-neutral-100" aria-label="Loading" />;
  if (error) return <div className="px-5 pb-5 text-13 text-danger" role="alert">Could not load.</div>;
  if (empty) return <div className="px-5 pb-6 text-13 text-inkMuted">{emptyText}</div>;
  return <>{children}</>;
}

// ── Hero / morning brief ──────────────────────────────────────────────────

function Greeting({ insights, counts, waiting, seesTeam }: {
  insights: Insight[]; counts: TodayResponse['counts'] | null; waiting: number | undefined; seesTeam: boolean;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const { session } = useAuth();
  const firstName = useMemo(() => session?.employee?.full_name?.trim().split(/\s+/)[0] ?? null, [session]);
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(now));
  const partOfDay = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const inToday = counts ? counts.present + counts.late + counts.wfh : null;
  const weekday = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' });
  const lead = insights.length
    ? `${weekday} — ${insights.length === 1 ? 'one thing needs' : `${insights.length} things need`} you today`
    : [weekday, counts && inToday !== null ? `${inToday} of ${counts.total} in today` : null].filter(Boolean).join(' · ');
  return (
    <header className="dash-greet dash-rise flex flex-col md:flex-row md:items-end gap-x-6 gap-y-4" data-testid="timestamp">
      <div className="min-w-0 w-full md:flex-1">
        <h1 className="text-[30px] md:text-[34px] leading-tight font-extrabold tracking-[-0.03em] text-ink">
          {partOfDay}{firstName ? `, ${firstName}` : ''} <span aria-hidden>👋</span>
        </h1>
        <p className="mt-1 text-14 font-medium text-inkMuted">{lead}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {seesTeam ? (
          <Link to="/hrms/attendance" className="inline-flex items-center gap-2 h-10 px-4 rounded-[14px] bg-surface text-ink text-13 font-bold shadow-card hover:shadow-raised transition-shadow">
            Open attendance <ArrowUpRight size={15} strokeWidth={2} />
          </Link>
        ) : null}
        {waiting ? (
          <a href="#approvals" className="inline-flex items-center gap-2 h-10 px-4 rounded-[14px] bg-primary text-white text-13 font-bold">
            Review approvals <span className="h-5 min-w-[20px] px-[6px] rounded-full bg-[#ffcf5c] text-[#1f1d2b] text-12 grid place-items-center tabular-nums">{waiting}</span>
          </a>
        ) : null}
      </div>
    </header>
  );
}

/** Pastel number chip for each brief row. */
const BRIEF_CHIP: Record<Insight['tone'], string> = {
  danger: 'bg-[#ff8fa3]', warning: 'bg-[#ffcf5c]', success: 'bg-[#a5e8c8]', info: 'bg-[#c9b8ff]',
};

/** "Today's brief" — the dark bento tile: each insight as a numbered row. */
function BriefTile({ insights, loading, className = '' }: { insights: Insight[]; loading: boolean; className?: string }) {
  return (
    <section className={'dash-hero dash-rise relative overflow-hidden p-5 md:p-6 text-white flex flex-col ' + className}>
      <span className="text-11 font-bold uppercase tracking-[0.12em] text-white/50">Today’s brief</span>
      <h2 className="mt-1 text-[22px] font-extrabold tracking-[-0.02em] leading-tight">
        {insights.length ? `${insights.length} thing${insights.length === 1 ? '' : 's'} need you` : 'All caught up'}
      </h2>
      {insights.length ? (
        <ul className="mt-4 space-y-[10px] flex-1">
          {insights.map((i) => {
            const m = i.title.match(/^([₹\d][\d.,]*\s?(?:L|K|Cr)?)\s+(.*)$/);
            const chip = m ? m[1] : '!';
            const rest = m ? m[2].charAt(0).toUpperCase() + m[2].slice(1) : i.title;
            const inner = (
              <>
                <span className={'h-8 min-w-[32px] px-2 shrink-0 rounded-[10px] grid place-items-center text-13 font-extrabold text-[#1f1d2b] ' + BRIEF_CHIP[i.tone]}>{chip}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-13 font-bold text-white truncate">{rest}</span>
                  <span className="block text-11 text-white/55 truncate">{i.detail}</span>
                </span>
                <ChevronRight size={15} className="shrink-0 text-white/40 transition-transform group-hover:translate-x-0.5" />
              </>
            );
            const cls = 'dash-tile group flex items-center gap-3 rounded-[14px] px-3 py-[10px]';
            return (
              <li key={i.key}>
                {i.href.startsWith('#') ? <a href={i.href} className={cls}>{inner}</a> : <Link to={i.href} className={cls}>{inner}</Link>}
              </li>
            );
          })}
        </ul>
      ) : loading ? <div className="mt-4 flex-1 min-h-[120px] rounded-[14px] bg-white/[0.05]" /> : (
        <p className="mt-3 text-13 text-white/60">Nothing urgent right now. New deadlines, overdue money and approvals will show up here.</p>
      )}
    </section>
  );
}

/** GST progress for the current return period — the aqua bento tile. */
function GstTile({ stats, period }: { stats: ReturnType<typeof filingStats>; period: string }) {
  return (
    <Link to="/workstation/services/registration/gst/dashboard"
      className="pastel-tile dash-rise flex flex-col p-5" style={{ background: '#e6fbfa', ['--blob' as string]: '#9ee6e1' }}
      title="Share of this period's GSTR-1 and GSTR-3B returns marked filed. At risk = past due and not filed.">
      <span className="text-13 font-bold text-ink/70">GST · {periodName(period)} returns</span>
      <div className="flex items-center gap-5 mt-3 relative z-[1]">
        <div className="relative">
          <Gauge value={stats.progress} size={170} track="rgb(15 157 150 / 0.15)" />
          <div className="absolute inset-x-0 bottom-0 text-center num-display text-[28px] leading-none text-ink">{Math.round(stats.progress * 100)}%</div>
        </div>
        <ul className="space-y-2 text-13 font-semibold text-ink">
          <li className="flex items-center gap-2"><i className="h-[10px] w-[10px] rounded-full bg-success" />{stats.filed} filed</li>
          <li className="flex items-center gap-2"><i className="h-[10px] w-[10px] rounded-full bg-[#7a5af8]" />{stats.inProgress} in progress</li>
          <li className="flex items-center gap-2"><i className="h-[10px] w-[10px] rounded-full bg-danger" />{stats.atRisk} at risk</li>
        </ul>
      </div>
      <span className="mt-auto pt-3 text-12 font-bold text-ink/60">{stats.filed} of {stats.total} filed · open GST →</span>
    </Link>
  );
}

// ── KPI row ───────────────────────────────────────────────────────────────

/** Pastel tile tones — [tile background, blob, icon colour]. */
const KPI_TONE = {
  pink: ['#ffe3ea', '#ffb3c5', '#e0457b'],
  blue: ['#e3f0ff', '#b6d4ff', '#2f6fed'],
  mint: ['#e3f8ee', '#a5e8c8', '#1f9d5a'],
  yellow: ['#fff4d6', '#ffe08a', '#b98900'],
  lavender: ['#efe9ff', '#c9b8ff', '#7a5af8'],
} as const;

function Kpi({ href, icon: Icon, tone, label, value, prefix, sub, badge, footer }: {
  href: string; icon: typeof Users; tone: keyof typeof KPI_TONE; label: string; value: string; prefix?: string;
  sub: ReactNode; badge?: ReactNode; footer?: ReactNode;
}) {
  const [bg, blob, fg] = KPI_TONE[tone];
  const cls = 'group pastel-tile dash-rise block';
  const style = { background: bg, ['--blob' as string]: blob } as React.CSSProperties;
  const body = (
    <>
      <div className="relative z-[1] px-5 pt-4">
        <div className="flex items-center gap-2 text-13 font-bold text-ink/70">
          <span className="h-8 w-8 rounded-[10px] inline-grid place-items-center bg-white" style={{ color: fg }}><Icon size={15} strokeWidth={2.2} /></span>
          <span className="truncate">{label}</span>
          <span className="flex-1" />
          {badge}
        </div>
        <div className="num-display text-[34px] leading-tight mt-3 text-ink">
          {prefix ? <span className="text-18 text-ink/50 font-bold mr-0.5">{prefix}</span> : null}{value}
        </div>
        <div className="text-12 font-semibold text-ink/60 mt-0.5 truncate">{sub}</div>
      </div>
      <div className="relative z-[1] mt-3">{footer ?? <div className="h-4" />}</div>
    </>
  );
  // In-page targets (#approvals) need a plain anchor; React Router's Link only pushes the hash.
  return href.startsWith('#')
    ? <a href={href} className={cls} style={style}>{body}</a>
    : <Link to={href} className={cls} style={style}>{body}</Link>;
}

function Pill({ tone, children }: { tone: 'up' | 'down' | 'warn' | 'info'; children: ReactNode }) {
  const cls = {
    up: 'bg-[#e9f9f1] text-[#047857]', down: 'bg-[#fef2f2] text-[#b91c1c]',
    warn: 'bg-[#fff7e6] text-[#b45309]', info: 'bg-[#f1edff] text-[#6941d9]',
  }[tone];
  return <span className={'inline-flex items-center h-6 px-2 rounded-full text-11 font-semibold whitespace-nowrap shrink-0 ' + cls}>{children}</span>;
}

function BilledTile({ months }: { months: { billed_paise: number; collected_paise: number }[] }) {
  const cur = months[months.length - 1]?.billed_paise ?? 0;
  const prev = months[months.length - 2]?.billed_paise ?? 0;
  const delta = prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null;
  return (
    <Kpi href="/workstation/invoices" icon={FileText} tone="blue" label="Billed this month"
      prefix="₹" value={formatINR(cur / 100).replace('₹', '')}
      sub={prev > 0 ? `vs ${paise(prev)} last month` : 'Invoices raised this month'}
      badge={delta !== null ? <Pill tone={delta >= 0 ? 'up' : 'down'}>{delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}%</Pill> : null}
      footer={months.some((m) => m.billed_paise > 0) ? <Sparkline values={months.map((m) => m.billed_paise)} height={46} /> : <div className="h-4" />} />
  );
}

function ReceivablesTile({ data }: { data: import('@/modules/paymentSummary/api').SummaryResponse }) {
  const a = data.ageing;
  const overdueClients = data.clients.filter((c) => c.overdue_paise > 0).length;
  return (
    <Kpi href="/hrms/payment-summary" icon={Wallet} tone="yellow" label="Receivables"
      prefix="₹" value={formatINR(data.totals.pending_paise / 100).replace('₹', '')}
      sub={`${data.clients.reduce((s, c) => s + c.open_invoices, 0)} open invoices · ${data.totals.clients_with_dues} clients`}
      badge={overdueClients ? <Pill tone="down">{overdueClients} overdue</Pill> : null}
      footer={<div className="px-5 pb-4"><SegBar parts={[
        { value: a.current, color: 'rgb(var(--c-success))', label: 'Not yet due' },
        { value: a.d1_30, color: 'rgb(var(--c-warning))', label: '1–30 days overdue' },
        { value: a.d31_60 + a.d61_90 + a.d90_plus, color: 'rgb(var(--c-danger))', label: '31+ days overdue' },
      ]} /></div>} />
  );
}

function FilingsTile({ due, list, today }: { due: number; list: Deadline[]; today: string }) {
  const overdue = list.filter((d) => d.date < today).reduce((s, d) => s + (d.total - d.done), 0);
  const week = list.filter((d) => d.date >= today && d.date <= addDaysISO(today, 7));
  const done = week.reduce((s, d) => s + d.done, 0);
  const total = week.reduce((s, d) => s + d.total, 0);
  return (
    <Kpi href="/workstation/services/registration/gst/dashboard" icon={CalendarClock} tone="lavender" label="Due in 7 days"
      value={String(due)} sub={total ? `${done} of ${total} done this week` : 'GST and TDS work due this week'}
      badge={overdue ? <Pill tone="warn">{overdue} overdue</Pill> : null}
      footer={<div className="px-5 pb-4"><SegBar parts={[
        { value: done, color: 'rgb(var(--c-primary))', label: 'Done' },
        { value: Math.max(0, total - done), color: 'rgb(var(--c-neutral-200))', label: 'Open' },
      ]} /></div>} />
  );
}

function TeamTile({ counts }: { counts: NonNullable<TodayResponse['counts']> }) {
  const inToday = counts.present + counts.late + counts.wfh;
  const pct = counts.total ? Math.round((inToday / counts.total) * 1000) / 10 : 0;
  return (
    <Kpi href="/hrms/attendance" icon={Users} tone="mint" label="Team in today"
      value={String(inToday)} prefix={undefined}
      sub={`of ${counts.total} · ${counts.late} late · ${counts.on_leave} on leave · ${counts.wfh} WFH`}
      badge={<Pill tone={pct >= 80 ? 'up' : 'warn'}>{pct}%</Pill>}
      footer={<div className="px-5 pb-4"><SegBar parts={[
        { value: counts.present, color: 'rgb(var(--c-success))', label: 'On time' },
        { value: counts.late, color: 'rgb(var(--c-warning))', label: 'Late' },
        { value: counts.wfh, color: 'rgb(var(--c-coral))', label: 'Work from home' },
        { value: counts.on_leave, color: 'rgb(var(--c-primary))', label: 'On leave' },
        { value: counts.absent, color: 'rgb(var(--c-neutral-200))', label: 'Not in' },
      ]} /></div>} />
  );
}

function WaitingTile({ items }: { items: PendingAction[] }) {
  return (
    <Kpi href="#approvals" icon={Inbox} tone="pink" label="Waiting on you"
      value={String(items.length)} sub={pendingNote(items)}
      badge={items.length ? <Pill tone="warn">Action</Pill> : <Pill tone="up">Clear</Pill>} />
  );
}

// ── Cash flow ─────────────────────────────────────────────────────────────

function CashFlowCard({ months, avgDays, money, loading, error }: {
  months: { month: string; billed_paise: number; collected_paise: number }[] | undefined;
  avgDays: number | null;
  money: import('@/modules/paymentSummary/api').SummaryResponse | undefined; loading: boolean; error: boolean;
}) {
  const [range, setRange] = useState<3 | 6>(6);
  const shown = months?.slice(-range) ?? [];
  const billed = shown.reduce((s, m) => s + m.billed_paise, 0);
  const collected = shown.reduce((s, m) => s + m.collected_paise, 0);
  const empty = !!months && shown.every((m) => m.billed_paise === 0 && m.collected_paise === 0);
  return (
    <Panel title="Cash flow" sub="Billed vs collected"
      right={(
        <div className="flex items-center gap-3">
          <span className="hidden sm:flex items-center gap-3 text-12 text-inkMuted">
            <span className="flex items-center gap-[6px]"><i className="inline-block h-2 w-2 rounded-sm bg-primary" />Billed</span>
            <span className="flex items-center gap-[6px]"><i className="inline-block h-2 w-2 rounded-sm bg-coral" />Collected</span>
          </span>
          <Seg value={range} onChange={(v) => setRange(v as 3 | 6)} options={[[3, '3M'], [6, '6M']]} />
        </div>
      )}>
      <State loading={loading} error={error} empty={empty}
        emptyText={<EmptyIllo icon={Receipt} title="No invoices in this window yet"
          text="Billed and collected amounts appear here once invoices are raised and payments recorded."
          cta={{ label: 'Create invoice', href: '/workstation/invoices/new' }} />}>
        <div className="px-2 pb-1">
          <AreaChart
            points={shown.map((m) => ({ label: new Date(`${m.month}-01T00:00:00`).toLocaleString('en-IN', { month: 'short' }), a: m.billed_paise, b: m.collected_paise }))}
            labels={{ a: 'Billed', b: 'Collected' }} format={inrCompact} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-y-3 border-t border-border mx-5 py-3 text-12 text-inkMuted">
          <div><div className="num-display text-[17px] text-ink">{inrCompact(billed)}</div>Billed · {range} months</div>
          <div><div className="num-display text-[17px] text-ink">{inrCompact(collected)}</div>Collected{billed ? ` · ${Math.round((collected / billed) * 100)}%` : ''}</div>
          <div><div className={`num-display text-[17px] ${money && money.totals.overdue_paise ? 'text-danger' : 'text-ink'}`}>{money ? inrCompact(money.totals.pending_paise) : '—'}</div>Outstanding now</div>
          <div title="Average days from invoice date to payment, weighted by amount, for payments in the last 6 months">
            <div className="num-display text-[17px] text-ink">{avgDays === null ? '—' : `${avgDays} days`}</div>Avg. time to collect
          </div>
        </div>
      </State>
    </Panel>
  );
}

function Seg({ value, onChange, options }: { value: number | string; onChange: (v: number | string) => void; options: [number | string, string][] }) {
  return (
    <div className="flex p-[3px] rounded-[9px] bg-neutral-100">
      {options.map(([v, l]) => (
        <button key={String(v)} type="button" onClick={() => onChange(v)}
          className={'px-[10px] h-6 rounded-[7px] text-12 font-medium transition-colors ' + (value === v ? 'bg-surface text-ink shadow-card' : 'text-inkMuted hover:text-ink')}>
          {l}
        </button>
      ))}
    </div>
  );
}

function EmptyIllo({ icon: Icon, title, text, cta }: { icon: typeof Users; title: string; text: string; cta?: { label: string; href: string } }) {
  return (
    <div className="flex flex-col items-center text-center py-8 px-4">
      <span className="h-12 w-12 rounded-[16px] inline-grid place-items-center bg-[#f1edff] text-[#6941d9] mb-3"><Icon size={22} strokeWidth={1.8} /></span>
      <div className="text-14 font-semibold text-ink">{title}</div>
      <div className="text-13 text-inkMuted mt-1 max-w-[360px]">{text}</div>
      {cta ? <Link to={cta.href} className="mt-4 inline-flex items-center h-8 px-3 rounded-lg bg-primary text-white text-13 font-semibold">{cta.label}</Link> : null}
    </div>
  );
}

// ── Deadlines ─────────────────────────────────────────────────────────────

function DeadlinesCard({ list, today }: { list: Deadline[]; today: string }) {
  const week = Array.from({ length: 7 }, (_, i) => addDaysISO(today, i));
  const onDay = (d: string) => list.filter((x) => x.date === d);
  // Upcoming first; anything already past due is summarised in one row.
  const upcoming = list.filter((d) => d.date >= today);
  const overdue = list.filter((d) => d.date < today);
  const overdueCount = overdue.reduce((s, d) => s + (d.total - d.done), 0);
  return (
    <Panel id="deadlines" title="Deadlines" sub="Next 30 days" className="pastel-panel"
      right={<Link to="/workstation/calendar" className="inline-flex items-center h-7 px-[10px] rounded-lg text-12 font-medium text-inkMuted bg-neutral-100 hover:text-ink">Calendar →</Link>}>
      <div className="grid grid-cols-7 gap-[6px] px-5 pb-2">
        {week.map((d) => {
          const items = onDay(d);
          const isToday = d === today;
          const dt = new Date(`${d}T00:00:00`);
          return (
            <div key={d} title={items.map((i) => i.title).join('\n') || undefined}
              className={'rounded-[10px] text-center py-[6px] border transition-colors ' + (isToday ? 'bg-ink border-ink text-surface' : 'border-border hover:bg-neutral-50')}>
              <div className={'text-[10px] font-semibold tracking-[0.06em] ' + (isToday ? 'text-surface/70' : 'text-inkFaint')}>
                {dt.toLocaleDateString('en-IN', { weekday: 'short' }).toUpperCase()}
              </div>
              <div className="num-display text-16 leading-tight">{dt.getDate()}</div>
              <div className="flex justify-center gap-[2px] h-[5px] mt-0.5">
                {items.slice(0, 3).map((i) => <i key={i.key} className="h-[5px] w-[5px] rounded-full" style={{ background: i.tag === 'GST' ? 'rgb(var(--c-primary))' : 'rgb(var(--c-coral))' }} />)}
              </div>
            </div>
          );
        })}
      </div>
      {list.length === 0 ? (
        <EmptyIllo icon={CheckCircle2} title="Nothing due in the next 30 days" text="GST and TDS deadlines for your clients show up here." />
      ) : (
        <ul className="px-3 pb-3 max-h-[300px] overflow-y-auto">
          {overdue.length ? (
            <li>
              <Link to={overdue[0].href} className="group flex items-center gap-3 px-2 py-[10px] mb-1 rounded-[10px] bg-danger/10 hover:bg-danger/15">
                <span className="h-9 w-[44px] shrink-0 rounded-[9px] grid place-items-center bg-danger text-white"><AlertTriangle size={16} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-13 font-semibold text-danger">{overdueCount} overdue item{overdueCount === 1 ? '' : 's'}</span>
                  <span className="block text-12 text-inkMuted truncate">{overdue.length} deadline{overdue.length === 1 ? '' : 's'} passed · oldest {new Date(`${overdue[0].date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                </span>
                <ChevronRight size={15} className="text-inkFaint group-hover:text-ink" />
              </Link>
            </li>
          ) : null}
          {upcoming.length === 0 ? <li className="px-2 py-3 text-13 text-inkMuted">Nothing else due in the next 30 days.</li> : null}
          {upcoming.slice(0, 8).map((d) => {
            const late = d.date < today;
            const dt = new Date(`${d.date}T00:00:00`);
            const pct = d.total ? d.done / d.total : 0;
            return (
              <li key={d.key}>
                <Link to={d.href} className="group grid grid-cols-[44px_1fr_auto] gap-3 items-center px-2 py-[10px] rounded-[10px] hover:bg-neutral-50">
                  <span className={'rounded-[9px] text-center py-1 ' + (late ? 'bg-[#fef2f2] text-[#b91c1c]' : 'bg-neutral-100 text-ink')}>
                    <span className="num-display block text-15 leading-tight">{dt.getDate()}</span>
                    <span className="block text-[9.5px] font-semibold tracking-[0.06em] opacity-70">{dt.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase()}</span>
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-13 font-semibold text-ink">
                      <span className="truncate">{d.title}</span>
                      <span className={'shrink-0 text-[10px] font-semibold px-[6px] rounded ' + (d.tag === 'GST' ? 'bg-[#f1edff] text-[#6941d9]' : 'bg-[#f5f1ff] text-[#5b33c4]')}>{d.tag}</span>
                    </span>
                    <span className="flex items-center gap-2 mt-1 text-12 text-inkMuted">
                      {d.tag === 'GST' ? (
                        <>
                          <span className="flex-1 h-[5px] rounded bg-neutral-100 overflow-hidden"><i className="block h-full rounded bg-primary" style={{ width: `${pct * 100}%` }} /></span>
                          <span className="shrink-0 tabular-nums">{d.done} / {d.total} filed</span>
                        </>
                      ) : <span>{d.total} client{d.total === 1 ? '' : 's'} open{late ? ' · overdue' : ''}</span>}
                    </span>
                  </span>
                  <ChevronRight size={15} className="text-inkFaint group-hover:text-ink" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

// ── Approval queue ────────────────────────────────────────────────────────

const KIND_LABEL: Record<PendingAction['kind'], string> = {
  leave: 'Leave', expense: 'Expense', correction: 'Correction', document_expiring: 'Expiring',
};
const KIND_ICON: Record<PendingAction['kind'], typeof Users> = {
  leave: Plane, expense: Receipt, correction: ClockAlert, document_expiring: FileWarning,
};
const KIND_PILL: Record<PendingAction['kind'], string> = {
  leave: 'bg-[#f5f1ff] text-[#5b33c4]',
  expense: 'bg-[#ecfdf5] text-[#047857]',
  correction: 'bg-[#f1f5f9] text-[#475569]',
  document_expiring: 'bg-[#fffbeb] text-[#b45309]',
};
/** Kinds that can be approved in one click; an expiring document needs a person to act. */
const APPROVE: Partial<Record<PendingAction['kind'], (id: string) => Promise<unknown>>> = {
  leave: leaveApi.approve,
  expense: expensesApi.approve,
  correction: attendanceApi.approveCorrection,
};

function ApprovalQueue({ data, loading, error }: { data: { items: PendingAction[]; count: number } | undefined; loading: boolean; error: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'all' | PendingAction['kind']>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const items = data?.items ?? [];
  const shown = tab === 'all' ? items : items.filter((i) => i.kind === tab);
  const keyOf = (i: PendingAction) => `${i.kind}:${i.id}`;
  const approvable = (i: PendingAction) => !!APPROVE[i.kind] && i.approvable !== false;

  const run = useMutation({
    mutationFn: async (targets: PendingAction[]) => Promise.allSettled(targets.map((t) => APPROVE[t.kind]!(t.id))),
    onSuccess: (results, targets) => {
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;
      if (ok) toast.push('success', `${ok} approved`);
      if (failed) {
        const first = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
        const why = first?.reason instanceof Error ? first.reason.message : 'not allowed';
        toast.push('error', `${failed} of ${targets.length} not approved — ${why}`);
      }
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
  });

  const toggle = (i: PendingAction) => setSelected((s) => {
    const n = new Set(s); const k = keyOf(i);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });
  const picked = items.filter((i) => selected.has(keyOf(i)));
  const tabs: ['all' | PendingAction['kind'], string][] = [
    ['all', 'All'], ['leave', 'Leave'], ['expense', 'Expenses'], ['correction', 'Corrections'], ['document_expiring', 'Expiring'],
  ];

  return (
    <Panel id="approvals" title="Approval queue" className="relative"
      sub={data ? <Pill tone="info">{data.count} open</Pill> : undefined}
      right={(
        <div className="flex p-[3px] rounded-[9px] bg-neutral-100 overflow-x-auto max-w-full">
          {tabs.filter(([k]) => k === 'all' || items.some((i) => i.kind === k)).map(([k, l]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={'px-[10px] h-6 rounded-[7px] text-12 font-medium whitespace-nowrap transition-colors ' + (tab === k ? 'bg-surface text-ink shadow-card' : 'text-inkMuted hover:text-ink')}>
              {l}
            </button>
          ))}
        </div>
      )}>
      <State loading={loading} error={error} empty={!!data && items.length === 0}
        emptyText={<EmptyIllo icon={CheckCircle2} title="Nothing is waiting on you" text="Leave, expenses, corrections and expiring records land here." />}>
        <div className="overflow-x-auto">
          <table className="w-full text-13">
            <thead>
              <tr className="text-left text-11 font-semibold uppercase tracking-[0.06em] text-inkFaint bg-neutral-50 border-y border-border">
                <th className="w-10 pl-5 py-2" />
                <th className="py-2 pr-3">Item</th>
                <th className="py-2 pr-3 hidden md:table-cell">Type</th>
                <th className="py-2 pr-3 hidden lg:table-cell">Raised</th>
                <th className="py-2 pr-5 w-[200px]" />
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 12).map((i) => {
                const k = keyOf(i);
                const I = KIND_ICON[i.kind];
                const isSel = selected.has(k);
                return (
                  <tr key={k} className={'group border-b border-border last:border-0 transition-colors ' + (isSel ? 'bg-[#f1edff]' : 'hover:bg-neutral-50')}>
                    <td className="pl-5 py-3 align-middle">
                      {approvable(i) ? (
                        <button type="button" onClick={() => toggle(i)} aria-pressed={isSel} aria-label={`Select ${i.title}`}
                          className={'h-4 w-4 rounded-[5px] border-[1.5px] grid place-items-center transition-colors ' + (isSel ? 'bg-primary border-primary text-white' : 'border-neutral-300 bg-surface')}>
                          {isSel ? <Check size={11} strokeWidth={3} /> : null}
                        </button>
                      ) : null}
                    </td>
                    <td className="py-3 pr-3 min-w-0">
                      <Link to={i.action_url} className="flex items-center gap-3 min-w-0">
                        <span className={'h-8 w-8 shrink-0 rounded-[9px] inline-grid place-items-center ' + KIND_PILL[i.kind]}><I size={15} strokeWidth={1.9} /></span>
                        <span className="min-w-0">
                          <span className="block font-semibold text-ink truncate">{i.title}</span>
                          <span className="block text-12 text-inkMuted truncate">{i.subtitle}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="py-3 pr-3 hidden md:table-cell">
                      <span className={'inline-flex items-center gap-[6px] h-6 px-[10px] rounded-full text-11 font-semibold ' + KIND_PILL[i.kind]}>{KIND_LABEL[i.kind]}</span>
                    </td>
                    <td className="py-3 pr-3 hidden lg:table-cell text-12 text-inkMuted whitespace-nowrap">{formatDate(new Date(i.created_at))}</td>
                    <td className="py-3 pr-5">
                      <div className="flex justify-end gap-[6px] md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                        <Link to={i.action_url} className="inline-flex items-center h-7 px-[10px] rounded-md text-12 font-semibold bg-neutral-100 text-ink hover:bg-neutral-200">Open</Link>
                        {approvable(i) ? (
                          <button type="button" disabled={run.isPending} onClick={() => run.mutate([i])}
                            className="inline-flex items-center h-7 px-[10px] rounded-md text-12 font-semibold bg-primary text-white disabled:opacity-60">Approve</button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {shown.length > 12 ? <div className="px-5 py-2 text-12 text-inkMuted">+{shown.length - 12} more</div> : null}
      </State>

      <div className={'dash-bulk ' + (picked.length ? 'is-on' : '')} aria-hidden={!picked.length}>
        <span className="text-13 font-medium">{picked.length} selected</span>
        <button type="button" onClick={() => setSelected(new Set())} className="h-7 px-[10px] rounded-md text-12 font-semibold bg-surface/15 hover:bg-surface/25">Clear</button>
        <button type="button" disabled={run.isPending} onClick={() => run.mutate(picked)}
          className="h-7 px-3 rounded-md text-12 font-semibold bg-primary text-white disabled:opacity-60">
          {run.isPending ? 'Approving…' : 'Approve all'}
        </button>
      </div>
    </Panel>
  );
}

// ── Team today (side) ─────────────────────────────────────────────────────

function TeamToday({ counts, loading, error }: { counts: TodayResponse['counts'] | null; loading: boolean; error: boolean }) {
  const rows: [string, number, string][] = counts ? [
    ['On time', counts.present, 'rgb(var(--c-success))'],
    ['Late', counts.late, 'rgb(var(--c-warning))'],
    ['Work from home', counts.wfh, 'rgb(var(--c-coral))'],
    ['On leave', counts.on_leave, 'rgb(var(--c-primary))'],
    ['Missing check-out', counts.missing_check_out, 'rgb(var(--c-neutral-400))'],
    ['Absent', counts.absent, 'rgb(var(--c-danger))'],
  ] : [];
  const inToday = counts ? counts.present + counts.late + counts.wfh : 0;
  return (
    <Panel title="Team today" sub={counts ? `${counts.total} people` : undefined}
      right={<Link to="/hrms/attendance" className="text-12 font-semibold text-primary">Attendance →</Link>}>
      <State loading={loading} error={error} empty={!counts} emptyText="Attendance isn't available for your view.">
        {counts ? (
          <div className="px-5 pb-5 flex items-center gap-5" data-testid="attendance-summary">
            <Donut size={104} stroke={12} segments={rows.slice(0, 4).map(([, v, c]) => ({ value: v, color: c }))
              .concat([{ value: Math.max(0, counts.total - inToday - counts.on_leave), color: 'rgb(var(--c-neutral-100))' }])}>
              <span>
                <span className="num-display block text-[22px] leading-none text-ink">{counts.total ? Math.round((inToday / counts.total) * 100) : 0}%</span>
                <span className="text-[10px] font-semibold tracking-[0.08em] text-inkFaint">PRESENT</span>
              </span>
            </Donut>
            <ul className="flex-1 space-y-[6px] min-w-0">
              {rows.map(([label, value, color]) => (
                <li key={label} className="flex items-center gap-2 text-13 text-ink">
                  <i className="h-2 w-2 rounded-[2px] shrink-0" style={{ background: color }} />
                  <span className="truncate">{label}</span>
                  <span className="ml-auto num-display text-13">{value}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </State>
    </Panel>
  );
}

// ── Activity (side) ───────────────────────────────────────────────────────

function ActivityCard({ data, loading, error }: { data: { items: ActivityRow[] } | undefined; loading: boolean; error: boolean }) {
  const named: Record<string, string> = { 'auth.login': 'Logged in', 'auth.logout': 'Logged out' };
  const pretty = (a: string) => named[a] ?? a.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  const items = data?.items.slice(0, 7) ?? [];
  return (
    <Panel title="Activity"
      right={<span className="inline-flex items-center gap-[6px] text-12 font-semibold text-success"><i className="dash-live h-[7px] w-[7px] rounded-full bg-success" />Live</span>}>
      <State loading={loading} error={error} empty={!!data && items.length === 0}
        emptyText="No changes recorded yet. Sign-ins are not listed here.">
        <ol className="px-5 pb-4">
          {items.map((a, idx) => (
            <li key={a.id} className="relative grid grid-cols-[30px_1fr] gap-3 py-2">
              {idx < items.length - 1 ? <span className="absolute left-[14.5px] top-[38px] bottom-[-8px] w-px bg-border" aria-hidden /> : null}
              <Avatar name={a.actor_label} size={30} style={{ boxShadow: '0 0 0 3px rgb(var(--c-surface))' }} />
              <div className="min-w-0">
                <p className="text-13 text-inkMuted"><b className="font-semibold text-ink">{a.actor_label}</b> · {pretty(a.action)}</p>
                <p className="text-12 text-inkFaint">{formatDate(new Date(a.created_at))} · {formatTime(new Date(a.created_at))}</p>
              </div>
            </li>
          ))}
        </ol>
      </State>
    </Panel>
  );
}

// ── Notes ─────────────────────────────────────────────────────────────────

/** "2 pending · 1 done · next 11:30 AM" for today's calendar follow-ups. */
function scheduleNote(items: FollowUp[]): string {
  if (items.length === 0) return 'Nothing scheduled today';
  const open = items.filter((f) => f.status === 'pending' || f.status === 'rescheduled');
  const done = items.filter((f) => f.status === 'completed').length;
  const missed = items.filter((f) => f.status === 'missed').length;
  const next = open
    .map((f) => f.scheduled_at)
    .filter((at) => new Date(at).getTime() >= Date.now())
    .sort()[0];
  const parts = [`${open.length} pending`];
  if (done) parts.push(`${done} done`);
  if (missed) parts.push(`${missed} missed`);
  if (next) parts.push(`next ${formatTime(next)}`);
  return parts.join(' · ');
}

function pendingNote(items: PendingAction[]): string {
  const n = (k: PendingAction['kind']) => items.filter((i) => i.kind === k).length;
  const parts = [
    [n('leave'), 'leave'], [n('expense'), 'expense'], [n('correction'), 'correction'], [n('document_expiring'), 'expiring doc'],
  ].filter(([c]) => (c as number) > 0).map(([c, l]) => `${c} ${l}${c === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'All clear';
}

