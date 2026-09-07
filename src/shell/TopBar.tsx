import { useLocation, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/platform/auth/AuthContext';
import { NotificationsBell } from '@/platform/notifications/NotificationsBell';
import { messagesApi } from '@/modules/messages/api';

/**
 * Top bar (§6.1):
 *   breadcrumb · global search (⌘K / Ctrl+K) · notifications bell · messages badge · profile menu
 *
 * Notifications and Messages are NOT sidebar items — they live here as
 * counters. Wired but non-functional in this session; module handlers land
 * in later sessions.
 */
export function TopBar({ onOpenMobileNav }: { onOpenMobileNav?: () => void }) {
  const { session, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="h-14 shrink-0 bg-white border-b border-neutral-200 flex items-center px-3 lg:px-4 gap-2 lg:gap-4">
      {/* Drawer trigger — the only way to reach navigation below `lg`. */}
      <button
        type="button"
        onClick={onOpenMobileNav}
        className="lg:hidden h-8 w-8 shrink-0 flex items-center justify-center text-neutral-700 border border-neutral-200 rounded hover:text-neutral-900 hover:border-neutral-300"
        aria-label="Open navigation"
      >
        <MenuIcon />
      </button>

      <Breadcrumb path={location.pathname} />

      <div className="flex-1" />

      {/* A ⌘K hint is meaningless on a touch device, and the button is the
          widest thing in the bar — it goes first when space runs out. */}
      <button
        type="button"
        className="hidden md:inline-block h-8 px-3 text-13 text-neutral-500 border border-neutral-200 rounded hover:text-neutral-900 hover:border-neutral-300"
        aria-label="Global search"
        onClick={() => {/* global search opens later */}}
      >
        Search <span className="ml-2 text-11 text-neutral-400">⌘K</span>
      </button>

      <NotificationsBell />

      <MessagesBadge onOpen={() => navigate('/hrms/messages')} />

      <div className="relative">
        <button
          type="button"
          className="h-8 shrink-0 pl-2 pr-2 md:pr-3 text-13 text-neutral-900 border border-neutral-200 rounded hover:border-neutral-300 flex items-center gap-2"
          onClick={() => setMenuOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <span className="inline-block w-6 h-6 rounded bg-neutral-200 text-neutral-700 text-11 leading-6 text-center">
            {session?.employee?.full_name.slice(0, 1) ?? 'A'}
          </span>
          <span className="hidden md:inline">{session?.employee?.full_name ?? session?.user.email}</span>
        </button>
        {menuOpen ? (
          <div
            className="absolute right-0 top-9 w-[220px] bg-white border border-neutral-200 rounded shadow-drawer py-1 z-40"
            role="menu"
          >
            <MenuItem label="My Profile" onClick={() => { setMenuOpen(false); navigate('/me/profile'); }} />
            <MenuItem label="My Attendance" onClick={() => { setMenuOpen(false); navigate('/me/attendance'); }} />
            <MenuItem label="My Leave" onClick={() => { setMenuOpen(false); navigate('/me/leave'); }} />
            <MenuItem label="My Expenses" onClick={() => { setMenuOpen(false); navigate('/me/expenses'); }} />
            <MenuItem label="My Payslips" onClick={() => { setMenuOpen(false); navigate('/me/payslips'); }} />
            <div className="h-px bg-neutral-200 my-1" />
            <MenuItem label="Log out" onClick={async () => { setMenuOpen(false); await logout(); navigate('/login', { replace: true }); }} />
          </div>
        ) : null}
      </div>
    </header>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block w-full text-left h-8 px-3 text-13 text-neutral-900 hover:bg-neutral-50"
    >
      {label}
    </button>
  );
}

function Breadcrumb({ path }: { path: string }) {
  // Minimal deterministic breadcrumb from the URL. Real implementation reads
  // route handles when the router config grows.
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return <span className="text-13 text-neutral-500">Dashboard</span>;
  return (
    // `min-w-0` + `truncate`: a deep path must give way rather than push the
    // bell and profile menu off a narrow screen.
    <nav
      aria-label="Breadcrumb"
      className="text-13 text-neutral-500 flex items-center gap-2 min-w-0 truncate"
    >
      {segments.map((s, i) => {
        const isLast = i === segments.length - 1;
        return (
          <span key={i} className={isLast ? 'text-neutral-900' : ''}>
            {i > 0 ? <span className="mx-1 text-neutral-400">/</span> : null}
            {titleCase(s)}
          </span>
        );
      })}
    </nav>
  );
}

function titleCase(s: string): string {
  // Small special-case for well-known acronyms so the breadcrumb reads right.
  const acronyms: Record<string, string> = {
    hrms: 'HRMS',
    gst: 'GST',
    eway: 'E-way Bills',
    'follow-ups': 'Follow-ups',
  };
  if (acronyms[s.toLowerCase()]) return acronyms[s.toLowerCase()];
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' ');
}

function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M2 4h12M2 8h12M2 12h12" />
    </svg>
  );
}

function MessagesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 4h12v7H5l-3 2V4z" />
    </svg>
  );
}

function MessagesBadge({ onOpen }: { onOpen: () => void }) {
  const q = useQuery({
    queryKey: ['chats', 'list'],
    queryFn: messagesApi.listChats,
    refetchInterval: 15_000,
  });
  const total = q.data?.total_unread ?? 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative h-8 w-8 text-13 text-neutral-700 border border-neutral-200 rounded hover:text-neutral-900 flex items-center justify-center"
      aria-label={total > 0 ? `${total} unread messages` : 'Messages'}
      data-testid="messages-badge"
    >
      <MessagesIcon />
      {total > 0 ? (
        <span
          className="absolute -top-1 -right-1 h-4 min-w-[16px] px-1 text-11 leading-[16px] text-white bg-gold rounded"
          data-testid="messages-unread"
        >
          {total > 9 ? '9+' : total}
        </span>
      ) : null}
    </button>
  );
}
