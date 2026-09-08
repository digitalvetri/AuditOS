/**
 * Right panel (top-bar PanelRight toggle). A slide-in for the signed-in
 * person: today's attendance card (the same one the Attendance page uses),
 * unread notifications, and the "My …" shortcuts. Closes on Esc, scrim
 * click, or route change.
 */
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { notificationsApi } from '@/platform/notifications/api';
import { TodayCard } from '@/modules/attendance/TodayCard';

export function RightPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { session } = useAuth();
  const location = useLocation();
  const unread = useQuery({ queryKey: ['notifications', 'list'], queryFn: () => notificationsApi.list(8), enabled: open });

  useEffect(() => { onClose(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const links = [
    { to: '/me/profile', label: 'My profile' },
    { to: '/me/attendance', label: 'My attendance' },
    { to: '/me/leave', label: 'My leave' },
    { to: '/me/expenses', label: 'My expenses' },
    { to: '/me/payslips', label: 'My payslips' },
    { to: '/notifications', label: 'Notifications' },
  ];

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/[0.16]" onClick={onClose} aria-hidden />
      <aside
        className="fixed inset-y-0 right-0 z-50 w-full sm:w-[400px] bg-surface border-l border-border shadow-drawer flex flex-col"
        role="dialog"
        aria-label="Quick panel"
        data-testid="right-panel"
      >
        <div className="h-12 px-4 flex items-center border-b border-border shrink-0">
          <span className="text-13 font-medium text-ink">{session?.employee?.full_name ?? session?.user.email}</span>
          <span className="ml-2 text-12 text-inkMuted">{session?.role.name}</span>
          <div className="flex-1" />
          <button type="button" onClick={onClose} aria-label="Close panel" className="inline-flex items-center justify-center w-8 h-8 text-inkMuted hover:text-ink"><X size={16} strokeWidth={1.75} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
          {session?.employee ? (
            <section>
              <h3 className="text-11 uppercase tracking-[0.06em] text-inkFaint mb-2">Today</h3>
              <TodayCard />
            </section>
          ) : null}
          <section>
            <h3 className="text-11 uppercase tracking-[0.06em] text-inkFaint mb-2">Notifications</h3>
            <div className="text-13 text-ink">
              {unread.data ? (unread.data.unread > 0 ? `${unread.data.unread} unread` : "You're all caught up.") : 'Loading…'}
            </div>
            {unread.data?.items.slice(0, 3).map((n) => (
              <Link key={n.id} to={n.action_url ?? '/notifications'} className="block mt-2 text-13 text-inkMuted hover:text-ink truncate">{n.title}</Link>
            ))}
          </section>
          <section>
            <h3 className="text-11 uppercase tracking-[0.06em] text-inkFaint mb-2">Shortcuts</h3>
            <ul className="divide-y divide-border border border-border rounded-md overflow-hidden">
              {links.filter((l) => l.to === '/notifications' || session?.employee).map((l) => (
                <li key={l.to}><Link to={l.to} className="block h-10 px-3 leading-10 text-13 text-ink hover:bg-canvas">{l.label}</Link></li>
              ))}
            </ul>
          </section>
        </div>
      </aside>
    </>
  );
}
