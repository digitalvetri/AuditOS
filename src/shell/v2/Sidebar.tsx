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
import { useEffect, useState } from 'react';
import {
  Aperture,
  BarChart3,
  BookOpen,
  CalendarDays,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  FileText,
  IndianRupee,
  LayoutDashboard,
  MessageSquare,
  ReceiptIndianRupee,
  Settings,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

const COLLAPSED_KEY = 'audit-os:sidebar-collapsed';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}
interface NavGroup {
  label: string | null; // null = no section header (Dashboard row)
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    label: null,
    items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true }],
  },
  {
    label: 'AUDIT',
    items: [
      { to: '/hrms/employees',  label: 'Employees',  icon: Users },
      { to: '/hrms/attendance', label: 'Attendance', icon: Clock },
      { to: '/hrms/leave',      label: 'Leave',      icon: CalendarDays },
      { to: '/hrms/payroll',    label: 'Payroll',    icon: IndianRupee },
      { to: '/hrms/expenses',   label: 'Expenses',   icon: ReceiptIndianRupee },
      { to: '/hrms/accounts',   label: 'Accounts',   icon: BookOpen },
      { to: '/hrms/messages',   label: 'Messages',   icon: MessageSquare },
      { to: '/hrms/documents',  label: 'Documents',  icon: FileText },
      { to: '/hrms/reports',    label: 'Reports',    icon: BarChart3 },
      { to: '/hrms/settings',   label: 'Settings',   icon: Settings },
    ],
  },
  {
    label: 'WORKSTATION',
    items: [{ to: '/tools', label: 'Tools', icon: Wrench }],
  },
];

interface Props {
  mobileOpen: boolean;
  onMobileClose: () => void;
}

export function Sidebar({ mobileOpen, onMobileClose }: Props) {
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

  const width = collapsed ? 'lg:w-16' : 'lg:w-[246px]';
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
          'fixed inset-y-0 left-0 z-50 w-[246px] max-w-[82vw] ' +
          `${drawer} ` +
          `lg:static lg:z-auto lg:h-full lg:translate-x-0 lg:visible ${width} ` +
          'transition-[transform,width,visibility] shrink-0'
        }
        aria-label="Primary navigation"
      >
        <Brand collapsed={collapsed} />

        <nav className="flex-1 min-h-0 overflow-y-auto py-2">
          {NAV.map((group, i) => (
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
  return (
    <div className="h-16 flex items-center px-5 shrink-0">
      <span
        className="inline-flex items-center justify-center w-8 h-8 rounded border border-gold text-gold shrink-0"
        aria-hidden
      >
        <Aperture size={18} strokeWidth={1.75} />
      </span>
      {!collapsed ? (
        <span className="ml-3 text-16 font-semibold text-sidebarText">Audit OS</span>
      ) : null}
    </div>
  );
}

function Section({ group, collapsed }: { group: NavGroup; collapsed: boolean }) {
  return (
    <div className="mb-2">
      {group.label && !collapsed ? (
        <div
          className="px-5 pt-4 pb-1 text-11 font-semibold uppercase tracking-[0.08em] text-sidebarMuted"
        >
          {group.label}
        </div>
      ) : null}
      <ul className="px-2 space-y-0.5">
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
        const base = 'flex items-center h-10 rounded-md text-14 transition-colors';
        const spacing = collapsed ? 'justify-center px-0' : 'px-3';
        const state = isActive
          ? 'bg-sidebarActive text-sidebarText font-medium'
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
  return (
    <div className="mx-4 mb-2 rounded-md overflow-hidden bg-sidebarHover" style={{ height: 150 }}>
      {/*
        Real brand asset when present, otherwise a designed fallback so the
        panel never renders as a blank block. onError swaps to the fallback
        without a network round-trip.
      */}
      <img
        src="/brand/audit-panel.png"
        alt=""
        className="w-full h-full object-cover"
        onError={(e) => {
          const img = e.currentTarget;
          img.style.display = 'none';
          img.parentElement?.classList.add('flex', 'flex-col', 'items-center', 'justify-center', 'text-center');
          if (!img.parentElement?.querySelector('[data-brand-fallback]')) {
            const wrap = document.createElement('div');
            wrap.setAttribute('data-brand-fallback', 'true');
            wrap.innerHTML =
              '<div style="font-size:20px;font-weight:600;color:#EAF0EA">AUDIT</div>' +
              '<div style="font-size:11px;color:#B8CCBA;margin-top:4px">Smarter Audits, Better Tomorrow</div>';
            img.parentElement?.appendChild(wrap);
          }
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
        'h-11 flex items-center text-sidebarMuted hover:bg-sidebarHover text-12 font-medium uppercase tracking-[0.06em] ' +
        (collapsed ? 'justify-center' : 'px-5')
      }
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    >
      <Icon size={16} strokeWidth={1.75} />
      {!collapsed ? <span className="ml-2">COLLAPSE</span> : null}
    </button>
  );
}
