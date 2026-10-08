/**
 * Live updates for the signed-in shell (§8.7, §8.9).
 *
 * One Socket.IO connection per tab, authenticated by the same httpOnly session
 * cookie as the API (same origin through the proxy). The server pushes:
 *
 *   notification:new → refresh the bell + a live toast (and the app badge)
 *   chat:activity     → refresh chat lists/threads (Messages)
 *
 * Anything emitted while the socket was down is not replayed, so every
 * (re)connect refetches. While disconnected, the bell falls back to polling
 * — see `useRealtimeConnected`.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { Bell, X } from 'lucide-react';
import { notificationsApi } from '@/platform/notifications/api';
import { resyncPush } from '@/platform/pwa/push';
import type { Notification } from '@/data/models';

// ── connection state, readable from any component ─────────────────────────
let connected = false;
const listeners = new Set<() => void>();
function setConnected(v: boolean) {
  if (connected === v) return;
  connected = v;
  listeners.forEach((l) => l());
}
export function useRealtimeConnected(): boolean {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => connected,
    () => false,
  );
}

interface Live { key: string; n: Notification }

/**
 * Screens that summarise what a notification is about, refreshed alongside
 * the bell. Read-only lists and dashboards only — never a key an open form
 * or builder is initialised from, so nobody's unsaved edits get replaced.
 */
const REFRESH_BY_MODULE: Record<string, (readonly unknown[])[]> = {
  leave: [['leaves']],
  expense: [['expenses']],
  attendance: [['attendance']],
  payroll: [['payroll', 'runs'], ['payroll', 'payslips']],
  document: [['documents']],
  message: [['chats']],
};

function setBadge(unread: number) {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (unread > 0) void nav.setAppBadge?.(unread).catch(() => {});
  else void nav.clearAppBadge?.().catch(() => {});
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [live, setLive] = useState<Live[]>([]);
  const socketRef = useRef<Socket | null>(null);

  const refreshNotifications = async () => {
    await qc.invalidateQueries({ queryKey: ['notifications'] });
    const list = await notificationsApi.list(1).catch(() => null);
    if (list) setBadge(list.unread);
  };

  useEffect(() => {
    void resyncPush();
    const socket = io({ path: '/socket.io', withCredentials: true, transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      void refreshNotifications();
      void qc.invalidateQueries({ queryKey: ['chats'] });
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    socket.on('notification:new', (n: Notification) => {
      void refreshNotifications();
      for (const key of [['dashboard'], ['sidebar'], ...(REFRESH_BY_MODULE[n.module] ?? [])]) {
        void qc.invalidateQueries({ queryKey: key });
      }
      setLive((prev) => [{ key: `${n.id}-${Date.now()}`, n }, ...prev].slice(0, 4));
    });
    socket.on('chat:activity', () => {
      void qc.invalidateQueries({ queryKey: ['chats'] });
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Messages from the service worker: a notification click in another window,
  // or a push that arrived while this tab was focused.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'NAVIGATE' && typeof e.data.url === 'string') {
        const url = new URL(e.data.url);
        if (e.data.id) void notificationsApi.markRead(e.data.id).then(refreshNotifications).catch(() => {});
        navigate(url.pathname + url.search + url.hash);
      } else if (e.data?.type === 'PUSH_RECEIVED') {
        void refreshNotifications();
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  // Coming back to the tab: clear the system badge drift and catch up.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshNotifications(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = (key: string) => setLive((prev) => prev.filter((l) => l.key !== key));
  const open = (l: Live) => {
    dismiss(l.key);
    void notificationsApi.markRead(l.n.id).then(refreshNotifications).catch(() => {});
    navigate(l.n.action_url ?? '/notifications');
  };

  return (
    <>
      {children}
      <div className="live-toasts fixed z-[60] right-4 top-[76px] flex flex-col gap-2 w-[360px] max-w-[calc(100vw-32px)] pointer-events-none" aria-live="polite" role="status">
        {live.map((l) => <LiveToast key={l.key} item={l} onOpen={() => open(l)} onClose={() => dismiss(l.key)} />)}
      </div>
    </>
  );
}

function LiveToast({ item, onOpen, onClose }: { item: Live; onOpen: () => void; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 7000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="live-toast pointer-events-auto flex items-start gap-3 bg-surface border border-border rounded-[16px] shadow-drawer p-3" data-testid="live-toast">
      <span className="h-9 w-9 shrink-0 rounded-[11px] grid place-items-center bg-coral/15 text-coral"><Bell size={17} /></span>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="block text-13 font-bold text-ink truncate">{item.n.title}</span>
        {item.n.body ? <span className="block text-12 text-inkMuted line-clamp-2">{item.n.body}</span> : null}
        <span className="block text-11 font-semibold text-gold mt-1">Open →</span>
      </button>
      <button type="button" onClick={onClose} aria-label="Dismiss" className="h-7 w-7 shrink-0 grid place-items-center rounded-md text-inkFaint hover:text-ink hover:bg-canvas">
        <X size={15} />
      </button>
    </div>
  );
}
