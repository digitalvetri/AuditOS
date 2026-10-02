/**
 * /notifications — full page. Same data as the bell dropdown, no cap.
 */
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notificationsApi } from '@/platform/notifications/api';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/components/Button';
import type { Notification } from '@/data/models';

export function NotificationsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['notifications', 'list', 'all'],
    queryFn: () => notificationsApi.list(100),
  });
  const markAll = useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const markRead = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const onOpen = (n: Notification) => {
    if (!n.is_read) markRead.mutate(n.id);
    if (n.action_url) navigate(n.action_url);
  };

  return (
    <div className="max-w-[840px] mx-auto space-y-6">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Platform</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">Notifications</h1>
        </div>
        {q.data && q.data.unread > 0 ? (
          <Button variant="secondary" onClick={() => markAll.mutate()} disabled={markAll.isPending}>
            Mark all read
          </Button>
        ) : null}
      </header>
      <div className="bg-white border border-neutral-200 rounded overflow-hidden">
        {q.isLoading ? (
          <div className="h-40 bg-neutral-100" aria-label="Loading" />
        ) : (q.data?.items.length ?? 0) === 0 ? (
          <div className="p-6 text-13 text-neutral-500">You're all caught up.</div>
        ) : (
          <ul>
            {q.data!.items.map((n) => (
              <li key={n.id} className="border-b border-neutral-200 last:border-b-0">
                <button
                  type="button"
                  onClick={() => onOpen(n)}
                  className={
                    'block w-full text-left px-4 py-3 hover:bg-neutral-50 border-l-2 ' +
                    (n.is_read ? 'border-l-transparent' : 'border-l-amber')
                  }
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <div className={'text-13 ' + (n.is_read ? 'text-neutral-700' : 'text-neutral-900 font-medium')}>
                      {n.title}
                    </div>
                    <div className="text-11 text-neutral-400 tabular-nums shrink-0">
                      {fmtDateTime(n.created_at)}
                    </div>
                  </div>
                  <div className="text-12 text-neutral-500 mt-1">{n.body}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
