/**
 * Home dashboard → Compliance: overdue / due this week / due this month
 * (all and mine) from GET /api/compliance/summary, plus notices with a reply
 * due within 7 days and DSCs expiring within 30. Every figure links to the
 * filtered page. Hidden for roles without `workstation.compliance.read`.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { istToday } from '@/modules/dashboardV2/brief';
import { complianceApi, complianceKeys, type SummaryBucket } from './api';
import { daysUntil } from './ui';
import { noticesRegisterApi, noticesRegisterKeys } from '@/modules/noticesRegister/api';
import { dscApi, dscKeys } from '@/modules/dsc/api';

const n7 = (b?: SummaryBucket & { due_in_7_days?: number }) => b?.due_7 ?? b?.due_in_7_days;
const n30 = (b?: SummaryBucket & { due_in_30_days?: number }) => b?.due_30 ?? b?.due_in_30_days;

export function DashboardComplianceCard() {
  const { session } = useAuth();
  const role = session?.role.code;
  const seesCompliance = can(role, 'workstation.compliance.read', 'self') || can(role, 'workstation.compliance.manage', 'self');
  const seesNotices = can(role, 'workstation.notice.read', 'self') || can(role, 'workstation.notice.manage', 'self');
  const seesDsc = can(role, 'workstation.dsc.read', 'self') || can(role, 'workstation.dsc.manage', 'self');
  const today = istToday();

  const summary = useQuery({ queryKey: complianceKeys.summary, queryFn: complianceApi.summary, enabled: seesCompliance, staleTime: 60_000 });
  const notices = useQuery({ queryKey: noticesRegisterKeys.list({}), queryFn: () => noticesRegisterApi.list({}), enabled: seesNotices, staleTime: 60_000 });
  const dsc = useQuery({ queryKey: dscKeys.list({ expiring_within_days: 30 }), queryFn: () => dscApi.list({ expiring_within_days: 30 }), enabled: seesDsc, staleTime: 300_000 });

  if (!seesCompliance && !seesNotices && !seesDsc) return null;
  // Nothing to show at all (module not set up / endpoints missing) — keep the dashboard clean.
  if ((!seesCompliance || summary.isError) && (!seesNotices || notices.isError) && (!seesDsc || dsc.isError)) return null;

  const s = summary.data;
  const noticesDue = notices.data?.filter((n) => {
    // days_left is null once a reply is no longer owed (replied, hearing, closed …).
    const d = 'days_left' in n ? n.days_left ?? null : n.status === 'closed' ? null : daysUntil(n.response_due_date, today);
    return d !== null && d <= 7;
  }).length;
  const dscExpiring = dsc.data?.length; // includes already-expired DSCs still on the register

  return (
    <section className="dash-card dash-rise min-w-0 overflow-hidden" data-testid="dashboard-compliance">
      <header className="flex items-center gap-3 px-5 pt-4 pb-3 flex-wrap">
        <h2 className="text-15 font-semibold text-ink tracking-[-0.015em]">Compliance</h2>
        <span className="text-12 text-inkMuted">Statutory due dates, notices and DSCs across clients</span>
        <span className="flex-1" />
        {seesCompliance ? <Link to="/workstation/compliance" className="inline-flex items-center gap-1 text-12 font-semibold text-primary hover:underline">
          Open calendar <ChevronRight size={14} />
        </Link> : null}
      </header>
      <div className="grid gap-3 px-5 pb-5 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        {seesCompliance ? <>
        <Tile to="/workstation/compliance?overdue=1" bg="#ffe3ea" label="Overdue" value={s?.overdue} loading={summary.isLoading}
          sub={s?.mine?.overdue !== undefined ? `${s.mine.overdue} mine` : undefined} />
        <Tile to="/workstation/compliance?within=7" bg="#fff4d6" label="Due this week" value={n7(s)} loading={summary.isLoading}
          sub={n7(s?.mine) !== undefined ? `${n7(s?.mine)} mine` : undefined} />
        <Tile to="/workstation/compliance?within=30" bg="#e3f0ff" label="Due this month" value={n30(s)} loading={summary.isLoading}
          sub={n30(s?.mine) !== undefined ? `${n30(s?.mine)} mine` : undefined} />
        <Tile to="/workstation/compliance?mine=1&within=30" bg="#efe9ff" label="Mine, next 30 days" value={n30(s?.mine)} loading={summary.isLoading}
          sub={s?.mine?.overdue ? `${s.mine.overdue} overdue` : undefined} />
        </> : null}
        {seesNotices ? <Tile to="/workstation/notices?due=7" bg="#ffe3ea" label="Notices — reply due ≤ 7 days" value={noticesDue} loading={notices.isLoading} /> : null}
        {seesDsc ? <Tile to="/workstation/dsc?expiring=30" bg="#e3f8ee" label="DSCs expired or expiring ≤ 30 days" value={dscExpiring} loading={dsc.isLoading} /> : null}
      </div>
    </section>
  );
}

function Tile({ to, bg, label, value, sub, loading }: {
  to: string; bg: string; label: string; value: number | undefined; sub?: ReactNode; loading?: boolean;
}) {
  return (
    <Link to={to} className="group rounded-lg p-4 flex flex-col min-w-0 transition-shadow hover:shadow-card" style={{ background: bg }}>
      <span className="text-12 font-bold text-ink/70 leading-tight">{label}</span>
      <span className="num-display text-28 leading-tight text-ink mt-2">{loading ? '…' : value ?? '—'}</span>
      <span className="text-11 font-semibold text-ink/60 mt-auto pt-1 truncate">{sub ?? ' '}</span>
    </Link>
  );
}
