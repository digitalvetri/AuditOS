/**
 * Recent activity feed for HR/MD — actor · action · target · timestamp.
 */
import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from './api';
import { fmtDateTime } from '@/lib/format';

export function ActivityFeedWidget() {
  const q = useQuery({
    queryKey: ['dashboard', 'activity'],
    queryFn: dashboardApi.activity,
  });

  if (q.isLoading) return <div className="h-40 bg-neutral-100" aria-label="Loading" />;
  if (q.isError) {
    return <div className="text-13 text-neutral-500 border-l-2 border-neutral-400 pl-3">Audit access required.</div>;
  }
  const rows = q.data?.items ?? [];

  return (
    <div data-testid="activity-feed">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Recent activity</div>
      <div className="mt-3">
        {rows.length === 0 ? (
          <div className="text-13 text-neutral-500">No activity yet.</div>
        ) : (
          <ul className="space-y-1">
            {rows.slice(0, 8).map((r) => (
              <li key={r.id} className="border-l-2 border-neutral-200 pl-3 py-1">
                <div className="text-13 text-neutral-900">
                  <span className="text-neutral-500">{r.actor_label}</span>{' '}
                  {r.action}
                </div>
                <div className="text-11 text-neutral-500 tabular-nums">
                  {r.entity_type} · {fmtDateTime(r.created_at)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
