/**
 * Balances chip strip — one chip per leave type showing availed / entitled
 * and pending (if any). Dashboard secondary widget and also embedded in the
 * Leave page's Balances tab.
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/platform/auth/AuthContext';
import { Award, CalendarDays, HeartPulse, Infinity as InfinityIcon, Repeat, Sun } from 'lucide-react';
import { leaveApi } from './api';

export function BalancesCard() {
  const { session } = useAuth();
  const employeeId = session?.employee?.id;
  const q = useQuery({
    queryKey: ['leaves', 'balances', employeeId],
    queryFn: () => leaveApi.balances(employeeId!),
    enabled: !!employeeId,
  });

  if (!employeeId) return null;
  if (q.isLoading) return <div className="dash-card h-28" aria-label="Loading balances" />;
  if (q.isError || !q.data) return <div className="dash-card p-4 text-13 text-neutral-500">Balances unavailable.</div>;

  return (
    <div data-testid="leave-balances">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-15 font-semibold text-neutral-900">Leave balances</h2>
        <span className="text-12 text-neutral-500">available of entitled, this year</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        {q.data.items.map((row) => {
          const total = row.entitled + row.carried_forward;
          const available = total - row.availed - row.pending;
          const isUnlimited = row.type.code === 'lop';
          const look = LEAVE_LOOK[row.type.code] ?? LEAVE_LOOK.default;
          const usedPct = !isUnlimited && total > 0 ? Math.min(100, Math.round(((row.availed + row.pending) / total) * 100)) : 0;
          return (
            <div key={row.type.id} className="dash-card p-4">
              <div className="flex items-center gap-3">
                <span className="h-9 w-9 shrink-0 rounded-lg inline-flex items-center justify-center" style={{ background: look.bg, color: look.fg }} aria-hidden>
                  <look.Icon size={17} strokeWidth={1.9} />
                </span>
                <span className="text-13 font-medium text-neutral-700 truncate">{row.type.name}</span>
              </div>
              <div className="mt-3 flex items-baseline gap-1">
                <span className={`num-display text-[28px] leading-none ${available < 0 ? 'text-danger' : 'text-neutral-900'}`}>
                  {isUnlimited ? '∞' : available.toFixed(1)}
                </span>
                {!isUnlimited ? <span className="text-13 font-semibold text-neutral-400">/ {total.toFixed(1)}</span> : null}
              </div>
              {!isUnlimited ? (
                <div className="mt-3 rounded-full overflow-hidden" style={{ background: '#eef1f5', height: 6 }} aria-label={`${usedPct}% used`}>
                  <div className="h-full rounded-full" style={{ width: `${usedPct}%`, background: look.fg }} />
                </div>
              ) : <div className="mt-3" style={{ height: 6 }} aria-hidden />}
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center h-5 px-2 rounded-full text-11 font-medium bg-[#f1f5f9] text-[#475569]">
                  {row.availed.toFixed(1)} availed
                </span>
                {row.pending > 0 ? (
                  <span className="inline-flex items-center h-5 px-2 rounded-full text-11 font-medium bg-[#fffbeb] text-[#b45309]">
                    {row.pending.toFixed(1)} pending
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A colour and icon per leave type, so each reads at a glance. */
const LEAVE_LOOK: Record<string, { bg: string; fg: string; Icon: typeof Sun }> = {
  casual: { bg: '#e4f5f3', fg: '#0c7a7a', Icon: Sun },
  cl: { bg: '#e4f5f3', fg: '#0c7a7a', Icon: Sun },
  sick: { bg: '#fef2f2', fg: '#dc2626', Icon: HeartPulse },
  sl: { bg: '#fef2f2', fg: '#dc2626', Icon: HeartPulse },
  earned: { bg: '#e9f9f1', fg: '#059669', Icon: Award },
  el: { bg: '#e9f9f1', fg: '#059669', Icon: Award },
  comp_off: { bg: '#fff1ec', fg: '#d9603f', Icon: Repeat },
  co: { bg: '#fff1ec', fg: '#d9603f', Icon: Repeat },
  lop: { bg: '#fff7e6', fg: '#b45309', Icon: InfinityIcon },
  default: { bg: '#f1f5f9', fg: '#475569', Icon: CalendarDays },
};
