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
  const asideWidth = isDesktop ? (collapsed ? 64 : 246) : 246;
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

        <nav className="flex-1 min-h-0 overflow-y-auto py-2">
          {nav.map((group, i) => (
            <Section key={i} group={group} collapsed={collapsed} />
          ))}
        </nav>

        <BrandPanel collapsed={collapsed} />
        <Collapse collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      </aside>
    </>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  // Circular white chip with an aperture mark inside — matches the target's
  // brand cluster in the top-left of the sidebar.
  return (
    <div className="h-16 flex items-center px-6 shrink-0">
      <span
        className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-white text-sidebarText shrink-0"
        aria-hidden
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="8" />
          <path d="M12 4v4M20 12h-4M12 20v-4M4 12h4" />
        </svg>
      </span>
      {!collapsed ? (
        <span className="ml-3 text-16 font-semibold text-sidebarText tracking-tight">Audit OS</span>
      ) : null}
    </div>
  );
}

function Section({ group, collapsed }: { group: NavGroup; collapsed: boolean }) {
  return (
    <div className="mb-1">
      {group.label && !collapsed ? (
        <div
          className="px-6 pt-5 pb-2 text-11 font-semibold uppercase tracking-[0.1em] text-sidebarMuted"
        >
          {group.label}
        </div>
      ) : null}
      <ul className={collapsed ? 'px-2 space-y-1' : 'px-3 space-y-0.5'}>
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
        const base = 'flex items-center h-11 rounded-lg text-14 font-medium transition-colors';
        const spacing = collapsed ? 'justify-center px-0' : 'px-3';
        const state = isActive
          ? 'bg-sidebarActive text-sidebarText shadow-card'
          : 'text-sidebarText hover:bg-sidebarHover';
        return `${base} ${spacing} ${state}`;
      }}
      title={collapsed ? item.label : undefined}
    >
      <Icon size={18} strokeWidth={1.75} className="shrink-0" />
      {!collapsed ? <span className="ml-3 truncate">{item.label}</span> : null}
    </NavLink>
  );
}

function BrandPanel({ collapsed }: { collapsed: boolean }) {
  if (collapsed) return null;
  // Reference art already contains the AUDIT wordmark and the "Smarter
  // Audits, Better Tomorrow" tagline — no overlay needed. Rendered clean at
  // the bottom of the rail, sized to match the target proportions.
  return (
    <div className="mx-3 mb-3 rounded-lg overflow-hidden" style={{ height: 200 }}>
      <img
        src="/brand/audit-panel.jpg"
        alt=""
        className="w-full h-full object-cover"
        onError={(e) => {
          e.currentTarget.style.display = 'none';
        }}
      />
    </div>
  );
}

function Collapse({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? ChevronsRight : ChevronsLeft;
  return (
    <button
      type="button"
      onClick={onToggle}
      className={
        'h-12 flex items-center text-sidebarMuted hover:bg-sidebarHover text-12 font-semibold uppercase tracking-[0.08em] ' +
        (collapsed ? 'justify-center' : 'px-6')
      }
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    >
      <Icon size={16} strokeWidth={1.75} />
      {!collapsed ? <span className="ml-2">COLLAPSE</span> : null}
    </button>
  );
}
