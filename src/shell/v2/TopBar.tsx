/**
 * UI-BUILD-PROMPT §4 TopBar.
 *
 * 64px sticky. Left: search input flex-1 max-width 940px. Right: 4 lucide icons
 * (Search, Sun, Bell, PanelRight), 1px divider, avatar + name + ChevronDown as
 * dropdown trigger.
 *
 * The Bell shows a small danger dot when there are unread notifications.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bell, ChevronDown, Menu, PanelRight, Search, Sun, User } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { notificationsApi } from '@/platform/notifications/api';

interface Props {
  onOpenMobileNav: () => void;
}

export function TopBar({ onOpenMobileNav }: Props) {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  const unreadQ = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => notificationsApi.list(1),
    refetchInterval: 30_000,
  });
  const hasUnread = (unreadQ.data?.unread ?? 0) > 0;

  // Target reference uses a plain silhouette in a grey chip; the display
  // name is read inline from the session inside the trigger button below.

  return (
    <header className="sticky top-0 z-30 h-20 bg-surface border-b border-border flex items-center px-8 gap-8">
      {/* Mobile hamburger */}
      <button
        type="button"
        onClick={onOpenMobileNav}
        className="lg:hidden inline-flex items-center justify-center w-9 h-9 rounded-md text-inkMuted hover:text-ink hover:bg-canvas"
        aria-label="Open navigation"
      >
        <Menu size={20} strokeWidth={1.75} />
      </button>

      {/* Search input, flex-1, pill-shaped to match target UI */}
      <div className="flex-1 max-w-[940px]">
        <label className="relative block">
          <span className="absolute inset-y-0 left-5 flex items-center text-inkMuted">
            <Search size={18} strokeWidth={1.75} />
          </span>
          <input
            type="search"
            placeholder="Search..."
            className="w-full h-12 pl-12 pr-5 text-15 bg-canvas text-ink placeholder:text-inkFaint border border-border rounded-full focus:outline-none focus:border-gold focus:bg-surface"
            aria-label="Global search"
          />
        </label>
      </div>

      {/* Right cluster */}
      <div className="flex items-center gap-5">
        <IconBtn label="Search commands (⌘K)"><Search size={20} strokeWidth={1.75} /></IconBtn>
        <IconBtn label="Toggle theme"><Sun size={20} strokeWidth={1.75} /></IconBtn>
        <IconBtn
          label={hasUnread ? 'Notifications (unread)' : 'Notifications'}
          onClick={() => navigate('/notifications')}
          data-testid="topbar-bell"
        >
          <span className="relative inline-flex">
            <Bell size={20} strokeWidth={1.75} />
            {hasUnread ? (
              <span
                className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-sm bg-danger"
                aria-hidden
                data-testid="topbar-unread-dot"
              />
            ) : null}
          </span>
        </IconBtn>
        <IconBtn label="Toggle right panel"><PanelRight size={20} strokeWidth={1.75} /></IconBtn>

        <span className="h-6 w-px bg-border" aria-hidden />

        {/* Avatar dropdown trigger */}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 h-10 pr-1 pl-1 rounded-md hover:bg-canvas"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="w-9 h-9 rounded-full bg-canvas border border-border text-inkMuted inline-flex items-center justify-center">
              <User size={20} strokeWidth={1.75} />
            </span>
            <span className="hidden md:inline text-14 font-medium text-ink">
              {session?.employee?.full_name ?? session?.user.email ?? ''}
            </span>
            <ChevronDown size={16} strokeWidth={1.75} className="text-inkMuted" />
          </button>
          {menuOpen ? (
            <div
              className="absolute right-0 top-11 w-[220px] bg-surface border border-border rounded-md shadow-raised py-1 z-40"
              role="menu"
            >
              <MenuItem onClick={() => { setMenuOpen(false); navigate('/me/profile'); }}>My Profile</MenuItem>
              <MenuItem onClick={() => { setMenuOpen(false); navigate('/me/attendance'); }}>My Attendance</MenuItem>
              <MenuItem onClick={() => { setMenuOpen(false); navigate('/me/leave'); }}>My Leave</MenuItem>
              <MenuItem onClick={() => { setMenuOpen(false); navigate('/me/expenses'); }}>My Expenses</MenuItem>
              <MenuItem onClick={() => { setMenuOpen(false); navigate('/me/payslips'); }}>My Payslips</MenuItem>
              <div className="h-px bg-border my-1" />
              <MenuItem
                onClick={async () => { setMenuOpen(false); await logout(); navigate('/login', { replace: true }); }}
              >
                Log out
              </MenuItem>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  ...rest
}: {
  children: React.ReactNode;
  label: string;
  onClick?: () => void;
} & Record<string, unknown>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center justify-center w-9 h-9 rounded-md text-inkMuted hover:text-ink hover:bg-canvas"
      aria-label={label}
      title={label}
      {...(rest as Record<string, string>)}
    >
      {children}
    </button>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block w-full text-left h-9 px-3 text-13 text-ink hover:bg-canvas"
    >
      {children}
    </button>
  );
}
