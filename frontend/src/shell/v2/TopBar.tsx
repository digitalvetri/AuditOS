/**
 * UI-BUILD-PROMPT §4 TopBar.
 *
 * 64px sticky. Left: global search flex-1 max-width 940px. Right: 4 lucide
 * icons (Search = focus the box / ⌘K, Sun|Moon = theme, Bell = notifications
 * menu, PanelRight = quick panel), 1px divider, avatar + name + ChevronDown as
 * dropdown trigger.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown, FileSignature, Handshake, Menu, Moon, PanelRight, PhoneCall, Plane, Plus, ReceiptText, Receipt,
  ScrollText, Search, Sun, UserPlus,
} from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { Avatar } from '@/components/viz';
import { employeeApi } from '@/modules/employees/api';
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
    <header className="sticky top-0 z-30 h-14 md:h-20 bg-surface md:bg-canvas border-b border-border md:border-transparent flex items-center px-3 md:px-8 gap-2 md:gap-8">
      {/* Mobile hamburger */}
      <button
        type="button"
        onClick={onOpenMobileNav}
        className="lg:hidden inline-flex items-center justify-center w-11 h-11 md:w-9 md:h-9 shrink-0 rounded-md text-inkMuted hover:text-ink hover:bg-canvas"
        aria-label="Open navigation"
      >
        <Menu size={20} strokeWidth={1.75} />
      </button>

      {/* Global search, flex-1, pill-shaped to match target UI. Hidden below
          `md`: at 320px the input cannot coexist with the icon cluster, so
          the wordmark takes the space and the magnifier still opens search. */}
      <div className="hidden md:block flex-1 max-w-[560px]">
        <GlobalSearch ref={searchRef} />
      </div>
      {/* The brand at phone widths, where the search field is hidden. The
          sidebar's plate is off-screen here, so this is the only mark on the
          page — it uses the same asset rather than a text stand-in. */}
      {/* The bar is white here, so the mark stays in its own navy/blue —
          the inverse of the sidebar, which renders the same asset white on
          the navy rail. One asset, two treatments, picked by background. */}
      <span className="md:hidden flex-1 min-w-0 flex items-center">
        <img
          src="/jns-mark.png"
          alt="JNS Accounting Solutions"
          className="m-brand-mark block h-7 w-auto max-w-full object-contain object-left"
        />
      </span>

      {/* Right cluster */}
      <div className="flex items-center gap-0.5 md:gap-3 shrink-0 md:ml-auto">
        <WhoIsIn />
        <IconBtn className="hidden md:inline-flex" label="Search (⌘K)" onClick={() => searchRef.current?.focus()} data-testid="topbar-search">
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
        <IconBtn className="hidden md:inline-flex" label={panelOpen ? 'Close quick panel' : 'Open quick panel'} onClick={() => setPanelOpen((v) => !v)} data-testid="topbar-panel" aria-pressed={panelOpen}>
          <PanelRight size={20} strokeWidth={1.75} />
        </IconBtn>

        <CreateMenu />

        <span className="hidden md:block h-6 w-px bg-border" aria-hidden />

        {/* Avatar dropdown trigger */}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 h-11 md:h-10 pr-1 pl-1 rounded-md hover:bg-canvas"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <Avatar name={session?.employee?.full_name ?? session?.user.email} src={session?.employee?.photo_url} size={34} />
            <span className="hidden xl:inline text-14 font-medium text-ink">
              {session?.employee?.full_name ?? session?.user.email ?? ''}
            </span>
            <ChevronDown size={16} strokeWidth={1.75} className="text-inkMuted" />
          </button>
          {menuOpen ? (
            <div
              className="absolute right-0 top-12 w-[220px] bg-surface border border-border rounded-lg shadow-drawer py-1 z-40"
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
  className = '',
  ...rest
}: {
  children: React.ReactNode;
  label: string;
  onClick?: () => void;
  className?: string;
} & Record<string, unknown>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'inline-flex items-center justify-center w-11 h-11 md:w-9 md:h-9 shrink-0 ' +
        'rounded-md md:rounded-lg text-inkMuted hover:text-ink hover:bg-canvas md:bg-surface md:shadow-card md:hover:bg-surface md:hover:shadow-raised transition-shadow ' +
        className
      }
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

// ── Who's in ───────────────────────────────────────────────────────────────

/**
 * Faces of colleagues checked in today (on time, late or from home), from the
 * employee list's `today_attendance`. Only for roles that can see the team.
 */
function WhoIsIn() {
  const { session } = useAuth();
  const seesTeam = can(session?.role.code, 'employee.read', 'department');
  const list = useQuery({
    queryKey: ['employees', 'who-is-in'],
    queryFn: () => employeeApi.list({}),
    enabled: seesTeam, staleTime: 120_000,
  });
  if (!seesTeam || !list.data) return null;
  const rows = (list.data.items as { id: string; full_name: string; photo_url?: string | null; today_attendance?: { status: string; check_in_at: string | null } | null }[]);
  const inToday = rows.filter((r) => r.today_attendance?.check_in_at);
  if (!inToday.length) return null;
  const shown = inToday.slice(0, 3);
  return (
    <Link to="/hrms/attendance" className="hidden lg:flex items-center pl-2 mr-1" title={`In today: ${inToday.map((r) => r.full_name).join(', ')}`}>
      {shown.map((r, i) => (
        <Avatar key={r.id} name={r.full_name} src={r.photo_url} size={30}
          style={{ marginLeft: i ? -8 : 0, boxShadow: '0 0 0 2px rgb(var(--c-canvas))' }} />
      ))}
      {inToday.length > shown.length ? (
        <span className="h-[30px] min-w-[30px] px-1 -ml-2 rounded-full grid place-items-center text-11 font-semibold text-inkMuted bg-neutral-100"
          style={{ boxShadow: '0 0 0 2px rgb(var(--c-canvas))' }}>+{inToday.length - shown.length}</span>
      ) : null}
    </Link>
  );
}

// ── Create ─────────────────────────────────────────────────────────────────

/** One menu for every "new …" the signed-in role may start. Links only — each opens the existing form. */
function CreateMenu() {
  const { session } = useAuth();
  const role = session?.role.code;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const items = [
    { to: '/workstation/invoices/new', label: 'Invoice', icon: ReceiptText, show: can(role, 'workstation.invoice.manage', 'self') },
    { to: '/workstation/quotations/new', label: 'Quotation', icon: FileSignature, show: can(role, 'workstation.quotation.manage', 'self') },
    { to: '/workstation/engagement/new', label: 'Engagement letter', icon: ScrollText, show: can(role, 'workstation.engagement.manage', 'self') },
    { to: '/workstation/clients?add=1', label: 'Client', icon: Handshake, show: can(role, 'workstation.client.manage', 'self') },
    { to: '/workstation/leads?add=1', label: 'Lead', icon: PhoneCall, show: can(role, 'workstation.lead.manage', 'self') },
    { to: '/hrms/employees?add=1', label: 'Employee', icon: UserPlus, show: can(role, 'employee.manage', 'organisation') },
    { to: '/me/leave', label: 'Leave request', icon: Plane, show: can(role, 'leave.request', 'self') },
    { to: '/me/expenses', label: 'Expense claim', icon: Receipt, show: can(role, 'expense.submit', 'self') },
  ].filter((i) => i.show);
  if (!items.length) return null;

  return (
    <div className="relative hidden md:block" ref={ref}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
        className="inline-flex items-center gap-2 h-9 pl-3 pr-[14px] rounded-lg bg-primary text-white text-13 font-semibold">
        <Plus size={15} strokeWidth={2.5} /> Create
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 top-11 w-[230px] bg-surface border border-border rounded-lg shadow-drawer p-1 z-40">
          <div className="px-3 pt-2 pb-1 text-11 font-semibold uppercase tracking-[0.08em] text-inkFaint">New</div>
          {items.map(({ to, label, icon: Icon }) => (
            <Link key={to} to={to} role="menuitem" onClick={() => setOpen(false)}
              className="flex items-center gap-3 h-9 px-3 rounded-md text-13 text-ink hover:bg-canvas">
              <Icon size={16} strokeWidth={1.9} className="text-inkMuted" />{label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
