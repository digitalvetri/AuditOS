/**
 * Aggregated pending-actions queue for approvers (§6.2 "Pending Actions").
 * Rolls up leave approvals + attendance corrections. Each row deep-links.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from './api';
import { fmtDateTime } from '@/lib/format';

export function PendingActionsWidget() {
  const q = useQuery({
    queryKey: ['dashboard', 'pending-actions'],
    queryFn: dashboardApi.pendingActions,
  });

  const count = q.data?.count ?? 0;

  return (
    <div data-testid="pending-actions">
      <div className="flex items-baseline justify-between">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Pending actions</div>
        <span className="text-11 text-neutral-500 tabular-nums">{count}</span>
      </div>
      <div className="mt-3">
        {q.isLoading ? (
          <div className="h-16 bg-neutral-100" aria-label="Loading" />
        ) : count === 0 ? (
          <div className="text-13 text-neutral-500">Nothing needs your attention.</div>
        ) : (
          <ul className="space-y-1">
            {q.data!.items.slice(0, 6).map((it) => (
              <li key={`${it.kind}-${it.id}`} className="border-l-2 border-amber pl-3 py-1">
                <Link
                  to={it.action_url}
                  className="block text-13 text-neutral-900 hover:text-gold"
                  data-testid={`pending-item-${it.id}`}
                >
                  {it.title}
                </Link>
                <div className="text-11 text-neutral-500 tabular-nums">
                  {it.subtitle} · {fmtDateTime(it.created_at)}
                </div>
              </li>
            ))}
            {q.data!.items.length > 6 ? (
              <li className="text-11 text-neutral-500 pl-3 pt-1">
                and {q.data!.items.length - 6} more…
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </div>
  );
}
