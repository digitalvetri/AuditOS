/**
 * Bell dropdown — the eight most recent notifications, mark-all-read, and
 * a link to the full page. Opening an item marks it read and follows its
 * action URL. The unread dot is driven by the same query the TopBar polls.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { notificationsApi } from '@/platform/notifications/api';
import { fmtDateTime } from '@/lib/format';
import type { Notification } from '@/data/models';

export function NotificationsMenu() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const q = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => notificationsApi.list(8),
    refetchInterval: 30_000,
  });
  const markAll = useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const markRead = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const unread = q.data?.unread ?? 0;
  const onOpen = (n: Notification) => {
    if (!n.is_read) markRead.mutate(n.id);
    setOpen(false);
    navigate(n.action_url ?? '/notifications');
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center justify-center w-11 h-11 md:w-9 md:h-9 shrink-0 rounded-md text-inkMuted hover:text-ink hover:bg-canvas"
        aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'}
        title="Notifications"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="topbar-bell"
      >
        <span className="relative inline-flex">
          <Bell size={20} strokeWidth={1.75} />
          {unread > 0 ? <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-sm bg-danger" aria-hidden data-testid="topbar-unread-dot" /> : null}
        </span>
      </button>

      {open ? (
        <div className="absolute right-0 top-11 w-[360px] max-w-[calc(100vw-32px)] bg-surface border border-border rounded-md shadow-raised z-40" role="menu" data-testid="notifications-menu">
          <div className="h-10 px-4 flex items-center border-b border-border">
            <span className="text-13 font-medium text-ink">Notifications</span>
            {unread > 0 ? <span className="ml-2 text-12 text-inkMuted">{unread} unread</span> : null}
            <div className="flex-1" />
            {unread > 0 ? (
              <button type="button" onClick={() => markAll.mutate()} disabled={markAll.isPending} className="text-12 text-gold hover:text-gold-hover">Mark all read</button>
            ) : null}
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {q.isLoading ? (
              <div className="h-16 m-3 rounded bg-border" aria-label="Loading" />
            ) : (q.data?.items.length ?? 0) === 0 ? (
              <div className="px-4 py-4 text-13 text-inkMuted">You're all caught up.</div>
            ) : (
              <ul>
                {q.data!.items.map((n) => (
                  <li key={n.id} className="border-b border-border last:border-b-0">
                    <button
                      type="button"
                      onClick={() => onOpen(n)}
                      className={'block w-full text-left px-4 py-2.5 hover:bg-canvas border-l-2 ' + (n.is_read ? 'border-l-transparent' : 'border-l-amber')}
                    >
                      <div className={'text-13 ' + (n.is_read ? 'text-inkMuted' : 'text-ink font-medium')}>{n.title}</div>
                      {n.body ? <div className="text-12 text-inkMuted line-clamp-2">{n.body}</div> : null}
                      <div className="text-11 text-inkFaint mt-0.5 tabular-nums">{fmtDateTime(n.created_at)}</div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="h-10 px-4 flex items-center border-t border-border">
            <button type="button" onClick={() => { setOpen(false); navigate('/notifications'); }} className="text-13 text-ink hover:text-gold">View all notifications</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
