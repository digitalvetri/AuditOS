/**
 * UI-BUILD-PROMPT §3 Sidebar.
 *
 * Sage green, filled active pill (NOT the 2px left bar in §7). 246px expanded,
 * 64px collapsed rail. Brand top, nav, brand panel, collapse row bottom.
 *
 * Order (top → bottom):
 *   Dashboard (no section label)
 *   AUDIT      — 10 items
 *   WORKSTATION — Tools
 */
import { NavLink, useLocation } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  BookOpen,
  CalendarDays,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  FileText,
  Home,
  IndianRupee,
  MessageSquare,
  ReceiptIndianRupee,
  Settings,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

const COLLAPSED_KEY = 'audit-os:sidebar-collapsed';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  visible: boolean;
}
interface NavGroup {
  label: string | null; // null = no section header (Dashboard row)
  items: NavItem[];
}

interface Props {
  mobileOpen: boolean;
  onMobileClose: () => void;
}

export function Sidebar({ mobileOpen, onMobileClose }: Props) {
  const { session } = useAuth();
  const role = session?.role.code;

  // Role-scoped nav (§6.1). `can()` here is menu-rendering only — the API
  // is what actually enforces access. Employee: no Employees / Accounts /
  // Reports / Settings; no Tools if `workstation.access` is not granted.
  const nav = useMemo<NavGroup[]>(() => {
    const auditItems: NavItem[] = [
      { to: '/hrms/employees',  label: 'Employees',  icon: Users,                visible: can(role, 'employee.read', 'department') },
      { to: '/hrms/attendance', label: 'Attendance', icon: Clock,                visible: can(role, 'attendance.read', 'self') },
      { to: '/hrms/leave',      label: 'Leave',      icon: CalendarDays,         visible: can(role, 'leave.read', 'self') },
      { to: '/hrms/payroll',    label: 'Payroll',    icon: IndianRupee,          visible: can(role, 'payroll.view.own', 'self') || can(role, 'payroll.view', 'organisation') },
      { to: '/hrms/expenses',   label: 'Expenses',   icon: ReceiptIndianRupee,   visible: can(role, 'expense.submit', 'self') || can(role, 'expense.approve', 'department') },
      { to: '/hrms/accounts',   label: 'Accounts',   icon: BookOpen,             visible: can(role, 'accounts.read', 'organisation') || can(role, 'accounts.manage', 'organisation') },
      { to: '/hrms/messages',   label: 'Messages',   icon: MessageSquare,        visible: can(role, 'chat.participate', 'organisation') },
      { to: '/hrms/documents',  label: 'Documents',  icon: FileText,             visible: can(role, 'document.read', 'self') },
      { to: '/hrms/reports',    label: 'Reports',    icon: BarChart3,            visible: can(role, 'reports.hr', 'department') || can(role, 'reports.finance', 'organisation') || can(role, 'reports.all', 'organisation') },
      { to: '/hrms/settings',   label: 'Settings',   icon: Settings,             visible: can(role, 'settings.manage', 'organisation') },
    ];
    const workstationItems: NavItem[] = [
      { to: '/tools', label: 'Tools', icon: Wrench, visible: can(role, 'workstation.access', 'self') },
    ];
    return [
      { label: null, items: [{ to: '/', label: 'Dashboard', icon: Home, end: true, visible: true }] },
      { label: 'AUDIT', items: auditItems.filter((i) => i.visible) },
      { label: 'WORKSTATION', items: workstationItems.filter((i) => i.visible) },
    ].filter((g) => g.items.length > 0);
  }, [role]);

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  });
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const location = useLocation();
  // Close the mobile drawer on route change — same pattern the shipped app uses.
  useEffect(() => {
    onMobileClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onMobileClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, onMobileClose]);

  // Track desktop breakpoint so we can drive width via inline style. This
  // avoids the Tailwind class-order trap where a base `w-[246px]` for the
  // mobile drawer competes with `lg:w-16` at equal specificity — the fight
  // depends on source order in the emitted CSS and can flip silently.
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : true,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const asideWidth = isDesktop ? (collapsed ? 72 : 264) : 264;
  const drawer = mobileOpen ? 'translate-x-0' : '-translate-x-full invisible lg:visible';

  return (
    <>
      {/* Scrim */}
      <div
        className={
          'fixed inset-0 z-40 bg-black/[0.32] transition-opacity lg:hidden ' +
          (mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0')
        }
        onClick={onMobileClose}
        aria-hidden
      />

      <aside
        className={
          'flex flex-col bg-sidebar text-sidebarText ' +
          'fixed inset-y-0 left-0 z-50 max-w-[82vw] ' +
          `${drawer} ` +
          'lg:static lg:z-auto lg:h-full lg:translate-x-0 lg:visible ' +
          'transition-[transform,width,visibility] shrink-0'
        }
        style={{ width: asideWidth }}
        aria-label="Primary navigation"
      >
        <Brand collapsed={collapsed} />

        <nav className="flex-1 min-h-0 overflow-y-auto pt-1 pb-2">
          {nav.map((group, i) => (
            <Section key={i} group={group} collapsed={collapsed} first={i === 0} />
          ))}
        </nav>
        <Collapse collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      </aside>
    </>
  );
}

// ── Alignment grid ────────────────────────────────────────────────────────
//
// One left rail. Every icon (brand chip, nav row, section header text,
// COLLAPSE glyph) starts its content at x=20 from the aside edge.
//
//   aside padding (via ul px-2 + a px-3)  = 20
//   nav icon 20 → icon-right              = 40
//   gap-3                                 = 12  → label starts at x=52
//   brand chip 36 → chip-right            = 56
//   brand gap-3                           = 12  → text starts at x=68
//
// Brand text ends up 16px to the right of nav labels — accepted; a brand
// cluster reads as a header, not another nav row.

function Brand({ collapsed }: { collapsed: boolean }) {
  // Same height as TopBar (h-20) so brand chip and search bar sit on one
  // line. Divider on the bottom lines up with the TopBar's border so the
  // header reads as one continuous strip across the shell.
  return (
    <div className={'h-20 flex items-center shrink-0 border-b border-sidebarHover ' + (collapsed ? 'justify-center px-0' : 'pl-6 pr-4')}>
      <span
        className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-sidebarActive text-sidebarText shrink-0"
        aria-hidden
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="8" />
          <path d="M12 4v4M20 12h-4M12 20v-4M4 12h4" />
        </svg>
      </span>
      {!collapsed ? (
        <span className="ml-4 text-20 font-semibold text-sidebarText tracking-tight">Audit OS</span>
      ) : null}
    </div>
  );
}

function Section({ group, collapsed, first }: { group: NavGroup; collapsed: boolean; first: boolean }) {
  return (
    <div>
      {group.label && !collapsed ? (
        <div className={
          'pl-6 pr-4 pb-1 text-11 font-bold uppercase tracking-[0.12em] text-sidebarMuted ' +
          (first ? 'pt-3' : 'pt-4')
        }>
          {group.label}
        </div>
      ) : null}
      <ul className={collapsed ? 'px-2 space-y-1' : 'px-2 space-y-px'}>
        {group.items.map((it) => (
          <li key={it.to}>
            <NavItemRow item={it} collapsed={collapsed} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function NavItemRow({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) => {
        const base = 'flex items-center gap-3 h-11 rounded-lg text-15 transition-colors';
        const spacing = collapsed ? 'justify-center px-0' : 'px-3';
        const state = isActive
          ? 'bg-sidebarActive text-sidebarText font-semibold'
          : 'text-sidebarText font-medium hover:bg-sidebarHover';
        return `${base} ${spacing} ${state}`;
      }}
      title={collapsed ? item.label : undefined}
    >
      <Icon size={20} strokeWidth={2} className="shrink-0" />
      {!collapsed ? <span className="truncate">{item.label}</span> : null}
    </NavLink>
  );
}

function Collapse({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? ChevronsRight : ChevronsLeft;
  return (
    <button
      type="button"
      onClick={onToggle}
      className={
        'h-11 flex items-center gap-2 text-sidebarMuted hover:text-ink text-11 font-semibold uppercase tracking-[0.1em] ' +
        (collapsed ? 'justify-center px-0' : 'pl-5 pr-4')
      }
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    >
      <Icon size={16} strokeWidth={1.75} />
      {!collapsed ? <span>COLLAPSE</span> : null}
    </button>
  );
}
