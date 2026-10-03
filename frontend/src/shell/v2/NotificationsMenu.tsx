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
import { useRealtimeConnected } from '@/platform/realtime/RealtimeProvider';
import { AlertsNudge } from '@/platform/pwa/PwaUi';

export function NotificationsMenu() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  // Live socket pushes new notifications; poll only as a fallback.
  const live = useRealtimeConnected();

  const q = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => notificationsApi.list(8),
    refetchInterval: live ? 5 * 60_000 : 30_000,
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
        className="inline-flex items-center justify-center w-11 h-11 md:w-9 md:h-9 shrink-0 rounded-md md:rounded-lg text-inkMuted hover:text-ink hover:bg-canvas md:bg-surface md:shadow-card md:hover:bg-surface md:hover:shadow-raised transition-shadow"
        aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'}
        title="Notifications"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="topbar-bell"
      >
        <span className="relative inline-flex">
          <Bell size={20} strokeWidth={1.75} />
          {unread > 0 ? (
            <span className="absolute -top-[7px] -right-[9px] min-w-[16px] h-4 px-1 rounded-full bg-coral text-white text-[10px] font-bold leading-4 text-center shadow-card" aria-hidden data-testid="topbar-unread-dot">
              {unread > 9 ? '9+' : unread}
            </span>
          ) : null}
        </span>
      </button>

      {open ? (
        <div className="gs-panel absolute right-0 top-12 w-[380px] max-w-[calc(100vw-32px)] bg-surface border border-border rounded-[14px] shadow-drawer z-40 overflow-hidden" role="menu" data-testid="notifications-menu">
          <div className="h-12 px-4 flex items-center border-b border-border">
            <span className="text-14 font-semibold text-ink">Notifications</span>
            {unread > 0 ? <span className="ml-2 h-5 px-2 rounded-full bg-primary/10 text-primary text-11 font-semibold grid place-items-center">{unread} new</span> : null}
            <div className="flex-1" />
            {unread > 0 ? (
              <button type="button" onClick={() => markAll.mutate()} disabled={markAll.isPending} className="text-12 text-gold hover:text-gold-hover">Mark all read</button>
            ) : null}
          </div>
          <AlertsNudge />
          <div className="max-h-[420px] overflow-y-auto">
            {q.isLoading ? (
              <div className="h-16 m-3 rounded bg-border" aria-label="Loading" />
            ) : (q.data?.items.length ?? 0) === 0 ? (
              <div className="px-4 py-8 text-center">
                <div className="mx-auto h-10 w-10 rounded-[12px] grid place-items-center bg-primary/10 text-primary mb-2"><Bell size={18} /></div>
                <div className="text-13 font-semibold text-ink">You're all caught up</div>
                <div className="text-12 text-inkMuted">New approvals, filings and messages appear here.</div>
              </div>
            ) : (
              <ul>
                {q.data!.items.map((n) => (
                  <li key={n.id} className="border-b border-border last:border-b-0">
                    <button
                      type="button"
                      onClick={() => onOpen(n)}
                      className={'flex w-full text-left gap-3 px-4 py-3 transition-colors ' + (n.is_read ? 'hover:bg-canvas' : 'bg-primary/[0.04] hover:bg-primary/[0.08]')}
                    >
                      <span className={'mt-[6px] h-2 w-2 shrink-0 rounded-full ' + (n.is_read ? 'bg-transparent' : 'bg-primary')} aria-hidden />
                      <span className="min-w-0">
                        <span className={'block text-13 ' + (n.is_read ? 'text-inkMuted' : 'text-ink font-semibold')}>{n.title}</span>
                        {n.body ? <span className="block text-12 text-inkMuted line-clamp-2">{n.body}</span> : null}
                        <span className="block text-11 text-inkFaint mt-0.5 tabular-nums">{fmtDateTime(n.created_at)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="h-11 px-4 flex items-center border-t border-border bg-neutral-50">
            <button type="button" onClick={() => { setOpen(false); navigate('/notifications'); }} className="text-13 font-semibold text-primary">View all notifications →</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
