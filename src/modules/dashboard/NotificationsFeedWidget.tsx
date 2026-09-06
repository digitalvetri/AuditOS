/**
 * Feed slot: recent notifications for the caller. Complements the bell —
 * gives the caller a full glance without needing to open the panel.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { notificationsApi } from '@/platform/notifications/api';
import { fmtDateTime } from '@/lib/format';

export function NotificationsFeedWidget() {
  const q = useQuery({
    queryKey: ['notifications', 'list', 'feed'],
    queryFn: () => notificationsApi.list(5),
    refetchInterval: 30_000,
  });
  return (
    <div data-testid="notifications-feed">
      <div className="flex items-baseline justify-between">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
          Recent notifications
        </div>
        <Link to="/notifications" className="text-11 text-gold hover:text-gold-hover">
          View all →
        </Link>
      </div>
      <div className="mt-3">
        {q.isLoading ? (
          <div className="h-16 bg-neutral-100" aria-label="Loading" />
        ) : (q.data?.items.length ?? 0) === 0 ? (
          <div className="text-13 text-neutral-500">You're all caught up.</div>
        ) : (
          <ul className="space-y-2">
            {q.data!.items.map((n) => (
              <li
                key={n.id}
                className={
                  'border-l-2 pl-3 py-1 ' +
                  (n.is_read ? 'border-transparent' : 'border-amber')
                }
              >
                <div
                  className={
                    'text-13 ' + (n.is_read ? 'text-neutral-700' : 'text-neutral-900 font-medium')
                  }
                >
                  {n.title}
                </div>
                <div className="text-11 text-neutral-500 tabular-nums">
                  {fmtDateTime(n.created_at)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
