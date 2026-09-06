/**
 * Balances chip strip — one chip per leave type showing availed / entitled
 * and pending (if any). Dashboard secondary widget and also embedded in the
 * Leave page's Balances tab.
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/platform/auth/AuthContext';
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
  if (q.isLoading) return <div className="h-24 bg-neutral-100" aria-label="Loading balances" />;
  if (q.isError || !q.data) return <div className="text-13 text-neutral-500">Balances unavailable.</div>;

  return (
    <div data-testid="leave-balances">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Leave balances</div>
      <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-3 tabular-nums">
        {q.data.items.map((row) => {
          const available =
            row.entitled + row.carried_forward - row.availed - row.pending;
          const isUnlimited = row.type.code === 'lop';
          return (
            <div key={row.type.id} className="border-l-2 border-neutral-200 pl-3">
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
                {row.type.name}
              </div>
              <div className="text-16 text-neutral-900 mt-1">
                {isUnlimited ? '∞' : `${available.toFixed(1)}`}
                {!isUnlimited ? (
                  <span className="text-13 text-neutral-500"> / {(row.entitled + row.carried_forward).toFixed(1)}</span>
                ) : null}
              </div>
              <div className="text-11 text-neutral-500 mt-1">
                {isUnlimited
                  ? `${row.availed.toFixed(1)} availed`
                  : row.pending > 0
                    ? `${row.availed.toFixed(1)} availed · ${row.pending.toFixed(1)} pending`
                    : `${row.availed.toFixed(1)} availed`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
