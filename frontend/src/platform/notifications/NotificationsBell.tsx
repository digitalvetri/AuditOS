/**
 * TopBar bell — unread count + panel dropdown. Full list at /notifications.
 *
 * Polls every 30s while mounted. Not real-time; upgrades to Socket.IO when
 * the real backend lands. UI-only concern.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notificationsApi } from './api';
import { fmtDateTime } from '@/lib/format';
import type { Notification } from '@/data/models';

export function NotificationsBell() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const q = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => notificationsApi.list(10),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const markAll = useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const unread = q.data?.unread ?? 0;
  const items = q.data?.items ?? [];

  const onClickItem = (n: Notification) => {
    if (!n.is_read) markRead.mutate(n.id);
    setOpen(false);
    if (n.action_url) navigate(n.action_url);
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        className="relative h-8 w-8 text-13 text-neutral-700 border border-neutral-200 rounded hover:text-neutral-900 flex items-center justify-center"
        aria-label={unread > 0 ? `${unread} unread notifications` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="notifications-bell"
      >
        <BellIcon />
        {unread > 0 ? (
          <span
            className="absolute -top-1 -right-1 h-4 min-w-[16px] px-1 text-11 leading-[16px] text-white bg-gold rounded"
            data-testid="notifications-unread"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className="absolute right-0 top-9 w-[360px] bg-white border border-neutral-200 rounded shadow-drawer z-40"
          role="dialog"
          aria-label="Notifications"
        >
          <div className="flex items-center justify-between h-10 px-3 border-b border-neutral-200">
            <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">
              Notifications
            </span>
            {unread > 0 ? (
              <button
                type="button"
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending}
                className="text-11 text-gold hover:text-gold-hover"
              >
                Mark all read
              </button>
            ) : null}
          </div>
          <div className="max-h-[360px] overflow-y-auto" data-testid="notifications-panel">
            {q.isLoading ? (
              <div className="h-16 bg-neutral-100" aria-label="Loading" />
            ) : items.length === 0 ? (
              <div className="p-4 text-13 text-neutral-500">You're all caught up.</div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onClickItem(n)}
                  className={
                    'block w-full text-left px-3 py-2 border-b border-neutral-200 hover:bg-neutral-50 border-l-2 ' +
                    (n.is_read ? 'border-l-transparent' : 'border-l-amber')
                  }
                >
                  <div className={'text-13 ' + (n.is_read ? 'text-neutral-700' : 'text-neutral-900 font-medium')}>
                    {n.title}
                  </div>
                  <div className="text-12 text-neutral-500 mt-0.5">{n.body}</div>
                  <div className="text-11 text-neutral-400 mt-1 tabular-nums">
                    {fmtDateTime(n.created_at)}
                  </div>
                </button>
              ))
            )}
          </div>
          <div className="h-10 px-3 border-t border-neutral-200 flex items-center">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate('/notifications');
              }}
              className="text-11 text-gold hover:text-gold-hover"
            >
              View all →
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BellIcon() {
  // 16px monochrome inheritance-coloured SVG, 1.5px stroke — §7.
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M13 11H3l1.6-2.4V6a3.4 3.4 0 016.8 0v2.6L13 11z" />
      <path d="M6.5 13a1.5 1.5 0 003 0" />
    </svg>
  );
}
