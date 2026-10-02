import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { workstationApi } from '@/modules/workstation/api';
import { QueryState } from '@/modules/workstation/components';
import {
  ListCard, ListEmpty, ListHeader, ListRow, ListTable, StatusChip, TD, TwoLine, fmtDay,
} from '@/modules/workstation/listUi';
import type { DashboardResponse } from '@/modules/workstation/types';
import { fmtTime } from '@/lib/format';
import {
  AlertTriangle, Briefcase, Building2, CalendarClock, ChevronRight, Clock, FileText, Hourglass, TrendingUp, UserPlus,
  Users, type LucideIcon,
} from 'lucide-react';

/**
 * THE WORKSTATION DASHBOARD (§7.1).
 *
 * This is the Workstation overview — a screen INSIDE Workstation. It is not
 * the main AUDIT OS dashboard and does not replace it: `/` still renders
 * src/pages/Dashboard.tsx with HRMS · Workstation · Tools, untouched.
 *
 * Every number here is scoped server-side, so a GST executive's "Active
 * Clients" counts their assignments rather than the firm's.
 */
export function WorkstationDashboardPage() {
  const query = useQuery({
    queryKey: ['workstation', 'dashboard'],
    queryFn: workstationApi.dashboard,
  });

  const meta = query.data
    ? <>Showing {query.data.scope === 'organisation' ? 'all firm records' : 'records assigned to you'} · {fmtDay(new Date().toISOString())}</>
    : "Leads, clients, services, follow-ups and documents for the firm's own clients.";

  return (
    <div className="m-page max-w-[1400px]">
      {/* The page title lives in the banner once data is in; until then, the plain header. */}
      {query.data ? null : <ListHeader title="Workstation" meta={meta} />}
      <QueryState query={query}>
        {(data: DashboardResponse) => <DashboardBody data={data} meta={meta} />}
      </QueryState>
    </div>
  );
}

const viewAll = 'inline-flex items-center min-h-[44px] md:min-h-0 text-12 font-medium text-primary hover:underline';

// ── Tiles ─────────────────────────────────────────────────────────────

const TINT = {
  blue: { bg: '#eaf2ff', fg: '#1d4ed8', ring: '#d4e3fb' },
  indigo: { bg: '#eef0ff', fg: '#4338ca', ring: '#dcdffb' },
  green: { bg: '#e9f9f1', fg: '#047857', ring: '#cdeede' },
  teal: { bg: '#e6f8f6', fg: '#0f766e', ring: '#c9eeea' },
  amber: { bg: '#fff7e6', fg: '#b45309', ring: '#fde7bf' },
} as const;
type Tint = keyof typeof TINT;

function KpiTile({ label, value, to, icon: Icon, tint, attention }: {
  label: string; value: number; to: string; icon: LucideIcon; tint: Tint; attention?: boolean;
}) {
  const t = TINT[attention ? 'amber' : tint];
  return (
    <Link to={to} className={'group dash-card card-zoom flex flex-col gap-2 px-4 py-3 min-h-[44px] ' + (attention ? 'ws-attention' : '')}>
      <span className="flex items-center justify-between gap-2">
        <span className="h-9 w-9 rounded-lg inline-flex items-center justify-center shrink-0"
          style={{ background: t.bg, color: t.fg, boxShadow: `inset 0 0 0 1px ${t.ring}` }}>
          <Icon size={17} strokeWidth={1.9} />
        </span>
        <span className={`num-display text-[26px] leading-none ${attention ? 'text-[#b45309]' : 'text-neutral-900'}`}>{value}</span>
      </span>
      <span className="flex items-center gap-2 text-12 font-medium text-neutral-500 group-hover:text-primary transition-colors">
        {attention ? <span className="ws-pulse rounded-full shrink-0" style={{ background: '#f59e0b', width: 6, height: 6 }} /> : null}
        <span className="min-w-0 flex-1">{label}</span>
        <ChevronRight size={14} strokeWidth={2} className="shrink-0 text-neutral-300 group-hover:text-primary transition-colors" />
      </span>
    </Link>
  );
}

// ── Banner ────────────────────────────────────────────────────────────

/**
 * The navy banner: title, scope line and three headline figures on the
 * left; on the right, "practice health" — three concentric rings that draw
 * themselves in, one per ratio the pipeline card below does not show:
 * win rate, follow-ups on time, and services on track.
 */
function Hero({ data, meta }: { data: DashboardResponse; meta: ReactNode }) {
  const won = data.pipeline.find((p) => p.status === 'won')?.count ?? 0;
  const lost = data.pipeline.find((p) => p.status === 'lost')?.count ?? 0;
  const winRate = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : null;
  const k = data.kpis;
  const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null);
  const rings: Ring[] = [
    { label: 'Win rate', note: `${won} won · ${lost} lost`, value: winRate, color: '#5eead4', color2: '#14b8a6', to: '/workstation/leads?status=won' },
    { label: 'Follow-ups on time', note: `${k.overdue_follow_ups} of ${k.pending_follow_ups} overdue`, value: pct(Math.max(0, k.pending_follow_ups - k.overdue_follow_ups), k.pending_follow_ups), color: '#60a5fa', color2: '#2563eb', to: '/workstation/follow-ups?range=overdue' },
    { label: 'Services on track', note: `${k.services_due_soon} of ${k.active_services} due soon`, value: pct(Math.max(0, k.active_services - k.services_due_soon), k.active_services), color: '#eeb4b4', color2: '#cd9b9b', to: '/workstation/services?due=soon' },
  ];
  const stats: { label: string; value: string }[] = [
    { label: 'Total leads', value: String(k.total_leads) },
    { label: 'Active clients', value: String(k.active_clients) },
    { label: 'Active services', value: String(k.active_services) },
  ];
  return (
    <section className="dash-hero relative overflow-hidden rounded-[14px] px-6 py-6 md:px-8 md:py-7 text-white">
      <div className="relative z-[1] grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] items-center">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-2 h-6 px-3 rounded-full text-11 font-semibold uppercase tracking-[0.12em] text-[#a7f3d0] bg-white/[0.08] ring-1 ring-inset ring-white/15">
            <TrendingUp size={12} strokeWidth={2.25} /> Practice overview
          </span>
          <h1 className="mt-3 text-[30px] md:text-[34px] leading-[1.1] font-semibold tracking-[-0.02em]">Workstation</h1>
          <p className="mt-2 text-14 text-white/70">{meta}</p>
          <div className="mt-5 flex flex-wrap gap-3">
            {stats.map((st) => (
              <div key={st.label} className="ws-hero-stat rounded-lg px-4 py-2 min-w-[112px]">
                <div className="num-display text-[24px] leading-tight">{st.value}</div>
                <div className="text-11 text-white/65 mt-0.5">{st.label}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="hidden md:flex items-start gap-5 lg:justify-end">
          {rings.map((r) => <LevelMeter key={r.label} ring={r} />)}
        </div>
      </div>
    </section>
  );
}

interface Ring { label: string; note: string; value: number | null; color: string; color2: string; to: string }

const CELLS = 10;

/**
 * A segmented level meter, like a battery gauge: ten blocks stacked bottom
 * to top, as many lit as the percentage reaches. The lit blocks switch on
 * one after another when the page opens.
 */
function LevelMeter({ ring: r }: { ring: Ring }) {
  const lit = r.value === null ? 0 : Math.round(r.value / 10);
  return (
    <Link to={r.to} className="group flex flex-col items-center w-[124px] text-center">
      <span className="num-display text-[22px] leading-tight">{r.value === null ? '—' : `${r.value}%`}</span>
      <span className="ws-meter mt-2 flex flex-col-reverse gap-1 p-1 rounded-lg">
        {Array.from({ length: CELLS }, (_, i) => (
          <span
            key={i}
            className={'ws-cell block rounded-sm ' + (i < lit ? 'ws-cell-on' : '')}
            style={i < lit ? { background: `linear-gradient(90deg, ${r.color}, ${r.color2})`, boxShadow: `0 0 8px ${r.color}66`, animationDelay: `${i * 70}ms` } : undefined}
          />
        ))}
      </span>
      <span className="mt-2 text-12 leading-4 text-white/85 group-hover:text-white">{r.label}</span>
      <span className="mt-0.5 text-11 leading-4 text-white/55">{r.note}</span>
    </Link>
  );
}

function DashboardBody({ data, meta }: { data: DashboardResponse; meta: ReactNode }) {
  const navigate = useNavigate();
  const k = data.kpis;

  const kpis: { label: string; value: number; to: string; icon: LucideIcon; tint: Tint; attention?: boolean }[] = [
    { label: 'Total Leads', value: k.total_leads, to: '/workstation/leads', icon: Users, tint: 'blue' },
    { label: 'New Leads', value: k.new_leads, to: '/workstation/leads?status=new', icon: UserPlus, tint: 'indigo' },
    { label: 'Active Clients', value: k.active_clients, to: '/workstation/clients?status=active', icon: Building2, tint: 'green' },
    { label: 'Follow-ups Today', value: k.follow_ups_today, to: '/workstation/follow-ups?range=today', icon: CalendarClock, tint: 'teal' },
    { label: 'Pending Follow-ups', value: k.pending_follow_ups, to: '/workstation/follow-ups?status=pending', icon: Clock, tint: 'blue' },
    { label: 'Overdue Follow-ups', value: k.overdue_follow_ups, to: '/workstation/follow-ups?range=overdue', icon: AlertTriangle, tint: 'indigo', attention: k.overdue_follow_ups > 0 },
    { label: 'Active Services', value: k.active_services, to: '/workstation/services', icon: Briefcase, tint: 'indigo' },
    { label: 'Pending Documents', value: k.pending_documents, to: '/workstation/documents?status=requested', icon: FileText, tint: 'teal' },
    { label: 'Services Due Soon', value: k.services_due_soon, to: '/workstation/services?due=soon', icon: Hourglass, tint: 'green', attention: k.services_due_soon > 0 },
  ];

  const maxStage = Math.max(1, ...data.pipeline.map((p) => p.count));
  const totalStage = data.pipeline.reduce((n, p) => n + p.count, 0) || 1;

  return (
    <div className="space-y-5">
      <Hero data={data} meta={meta} />

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] gap-5 items-start">
        {/* KPI tiles — each one navigates to the list it counts, so no figure
            on this page is a dead end. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
          {kpis.map((kpi) => <KpiTile key={kpi.label} {...kpi} />)}
        </div>

        {/* Lead pipeline (§7.1), as numbered steps joined by a rail. A stage
            with zero leads still renders — a pipeline missing a stage reads
            as a bug rather than as emptiness. */}
        <div className="dash-card overflow-hidden">
          <div className="flex items-center gap-3 px-5 pt-4 pb-2">
            <div className="text-13 font-semibold text-neutral-900 flex-1">Lead pipeline</div>
            <Link to="/workstation/leads" className={viewAll}>View leads</Link>
          </div>
          <ol className="ws-steps px-5 pb-4">
            {data.pipeline.map((stage, i) => {
              const tone = stage.status === 'won' ? 'won' : stage.status === 'lost' ? 'lost' : 'open';
              return (
                <li key={stage.status}>
                  <Link to={`/workstation/leads?status=${stage.status}`} className="ws-step group flex items-center gap-3 rounded-lg -mx-2 px-2 h-10">
                    <span className={`ws-step-dot ws-step-${tone}`}>{i + 1}</span>
                    <span className="w-[150px] shrink-0 truncate text-13 text-neutral-700 group-hover:text-neutral-900">{stage.label}</span>
                    <span className="flex-1 h-2 bg-neutral-100 rounded-full overflow-hidden">
                      <span
                        className={`ws-step-bar ws-bar-${tone} block h-full rounded-full`}
                        style={{ width: `${Math.round((stage.count / maxStage) * 100)}%`, animationDelay: `${i * 70}ms` }}
                      />
                    </span>
                    <span className="num-display w-6 text-right text-13 text-neutral-900">{stage.count}</span>
                    <span className="w-9 text-right text-11 text-neutral-400 tabular-nums">{Math.round((stage.count / totalStage) * 100)}%</span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {/* Today's follow-ups (§7.1) */}
        <ListCard title="Today's follow-ups" right={<Link to="/workstation/follow-ups?range=today" className={viewAll}>View all</Link>}>
          {data.todays_follow_ups.length === 0 ? (
            <ListEmpty>Nothing scheduled for today.</ListEmpty>
          ) : (
            <ListTable float={false} cols={['Lead / Client', 'Service', 'Time', 'Assigned to', 'Status']}>
              {data.todays_follow_ups.map((f) => (
                <ListRow
                  key={f.id}
                  onOpen={() =>
                    navigate(
                      f.subject_type === 'lead'
                        ? `/workstation/leads/${f.lead_id}`
                        : `/workstation/clients/${f.client_id}`,
                    )
                  }
                >
                  <TD first><TwoLine top={f.subject_name} sub={f.title} /></TD>
                  <TD muted>{f.service_name ?? '—'}</TD>
                  <TD nowrap>{fmtTime(f.scheduled_at)}</TD>
                  <TD muted>{f.assigned_employee?.full_name ?? '—'}</TD>
                  <TD last><StatusChip value={f.status} /></TD>
                </ListRow>
              ))}
            </ListTable>
          )}
        </ListCard>

        {/* Client summary (§7.1) */}
        <ListCard title="Client summary" right={<Link to="/workstation/clients" className={viewAll}>View all</Link>}>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 px-4 py-4 border-b border-neutral-200">
            <Summary label="New" value={data.client_summary.new_clients} icon={UserPlus} tint="indigo" />
            <Summary label="Active" value={data.client_summary.active_clients} icon={Building2} tint="green" />
            <Summary label="Pending docs" value={data.client_summary.pending_documents} icon={FileText} tint="teal" />
            <Summary label="Services due" value={data.client_summary.services_due} icon={Hourglass} tint="amber" />
            <Summary label="Need follow-up" value={data.client_summary.requiring_follow_up} icon={CalendarClock} tint="blue" />
          </div>
          <ListTable float={false} cols={['Company', 'Status', { label: 'Docs', align: 'right' }]}>
            {data.client_summary.items.map((c) => (
              <ListRow key={c.id} onOpen={() => navigate(`/workstation/clients/${c.id}`)}>
                <TD first><TwoLine top={c.company_name} sub={c.client_id} /></TD>
                <TD><StatusChip value={c.status} /></TD>
                <TD last right muted nowrap>{c.pending_document_count > 0 ? `${c.pending_document_count} pending` : '—'}</TD>
              </ListRow>
            ))}
          </ListTable>
        </ListCard>
      </div>
    </div>
  );
}

function Summary({ label, value, icon: Icon, tint }: { label: string; value: number; icon: LucideIcon; tint: Tint }) {
  const t = TINT[tint];
  return (
    <div className="min-w-0 rounded-lg px-3 py-2" style={{ background: '#f7f9fc', boxShadow: 'inset 0 0 0 1px #e8ecf3' }}>
      <div className="flex items-center gap-2">
        <span className="h-6 w-6 rounded-md inline-flex items-center justify-center shrink-0" style={{ background: t.bg, color: t.fg }}>
          <Icon size={13} strokeWidth={2} />
        </span>
        <span className="num-display text-[18px] leading-tight text-neutral-900">{value}</span>
      </div>
      <div className="text-11 leading-4 text-neutral-500 mt-1">{label}</div>
    </div>
  );
}
