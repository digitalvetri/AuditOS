/**
 * UI-BUILD-PROMPT §4 TopBar.
 *
 * 64px sticky. Left: global search flex-1 max-width 940px. Right: 4 lucide
 * icons (Search = focus the box / ⌘K, Sun|Moon = theme, Bell = notifications
 * menu, PanelRight = quick panel), 1px divider, avatar + name + ChevronDown as
 * dropdown trigger.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, Menu, Moon, PanelRight, Search, Sun, User } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { useTheme } from '@/platform/theme/theme';
import { GlobalSearch, type GlobalSearchHandle } from './GlobalSearch';
import { NotificationsMenu } from './NotificationsMenu';
import { RightPanel } from './RightPanel';

interface Props {
  onOpenMobileNav: () => void;
}

export function TopBar({ onOpenMobileNav }: Props) {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<GlobalSearchHandle | null>(null);
  const { theme, toggle: toggleTheme } = useTheme();

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

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

      {/* Global search, flex-1, pill-shaped to match target UI */}
      <div className="flex-1 max-w-[940px]">
        <GlobalSearch ref={searchRef} />
      </div>

      {/* Right cluster */}
      <div className="flex items-center gap-5">
        <IconBtn label="Search (⌘K)" onClick={() => searchRef.current?.focus()} data-testid="topbar-search">
          <Search size={20} strokeWidth={1.75} />
        </IconBtn>
        <IconBtn
          label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={toggleTheme}
          data-testid="topbar-theme"
          aria-pressed={theme === 'dark'}
        >
          {theme === 'dark' ? <Moon size={20} strokeWidth={1.75} /> : <Sun size={20} strokeWidth={1.75} />}
        </IconBtn>
        <NotificationsMenu />
        <IconBtn label={panelOpen ? 'Close quick panel' : 'Open quick panel'} onClick={() => setPanelOpen((v) => !v)} data-testid="topbar-panel" aria-pressed={panelOpen}>
          <PanelRight size={20} strokeWidth={1.75} />
        </IconBtn>

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
      <RightPanel open={panelOpen} onClose={() => setPanelOpen(false)} />
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
