/**
 * MOBILE BOTTOM NAV (≤767px only).
 *
 * One nav design, reused by every page — not six variants. It renders only
 * below Tailwind's `md` breakpoint, so the desktop sidebar and the 768–1023px
 * tablet drawer are both untouched.
 *
 * Five slots is the ceiling: at 320px that is 64px per item, which is the
 * narrowest a 44px touch target plus a readable label can sit in. Everything
 * beyond the five primary destinations stays reachable through the existing
 * hamburger drawer, which the last slot opens.
 *
 * Role scoping reuses the sidebar's `can()` grants verbatim, so a user never
 * sees a tab that would 403 — and the tab set degrades to whatever they do
 * have rather than collapsing.
 */
import { NavLink, useLocation } from 'react-router-dom';
import { useMemo } from 'react';
import {
  BarChart3,
  Briefcase,
  ClipboardCheck,
  Home,
  LayoutGrid,
  MessageSquare,
  MoreHorizontal,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

interface Props {
  /** Opens the existing drawer — the overflow for everything not in the bar. */
  onOpenMore: () => void;
}

interface Tab {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  visible: boolean;
}

export function MobileNav({ onOpenMore }: Props) {
  const { session } = useAuth();
  const role = session?.role.code;
  const hasStaffRecord = Boolean(session?.employee);
  const location = useLocation();

  const tabs = useMemo<Tab[]>(() => {
    const all: Tab[] = [
      { to: '/', label: 'Home', icon: Home, end: true, visible: true },
      {
        to: '/workstation',
        label: 'Work',
        icon: LayoutGrid,
        visible: can(role, 'workstation.access', 'self'),
      },
      {
        to: '/hrms/messages',
        label: 'Messages',
        icon: MessageSquare,
        // Chats are between staff; the owner logins have no staff record.
        visible: can(role, 'chat.participate', 'organisation') && hasStaffRecord,
      },
      {
        to: '/hrms/reports',
        label: 'Reports',
        icon: BarChart3,
        visible:
          can(role, 'reports.hr', 'department') ||
          can(role, 'reports.finance', 'organisation') ||
          can(role, 'reports.all', 'organisation'),
      },
      {
        to: '/hrms/settings',
        label: 'Settings',
        icon: Settings,
        visible: can(role, 'settings.manage', 'organisation'),
      },
      // Audit files: a slot when there is room, and always while the user
      // is inside one (see "current" below).
      {
        to: '/workstation/audits',
        label: 'Audits',
        icon: ClipboardCheck,
        visible: can(role, 'workstation.audit.read', 'self'),
      },
      // Fallbacks so a narrowly-scoped role still gets a populated bar
      // rather than one lonely Home tab.
      {
        to: '/hrms/employees',
        label: 'People',
        icon: Users,
        visible: can(role, 'employee.read', 'department'),
      },
      {
        to: '/workstation/services',
        label: 'Services',
        icon: Briefcase,
        visible: can(role, 'workstation.service.read', 'self'),
      },
    ];
    const visible = all.filter((t) => t.visible);
    // Four primary slots; the fifth is always More.
    const shown = visible.slice(0, 4);
    // A page the user is standing on must be represented in the bar, or the
    // active state reads as "you are nowhere". If the current section was cut
    // by the slice, it takes the last slot.
    // The MOST specific matching tab is the current section: '/workstation'
    // is a prefix of every Workstation page, so it must not count as
    // representing '/workstation/audits/…' when an Audits tab exists.
    const matches = (t: Tab) =>
      t.end ? location.pathname === t.to : location.pathname === t.to || location.pathname.startsWith(t.to + '/');
    const current = visible.filter(matches).sort((a, b) => b.to.length - a.to.length)[0];
    if (current && !shown.includes(current)) shown[shown.length - 1] = current;
    return shown;
  }, [role, hasStaffRecord, location.pathname]);

  // Exactly one tab may be active. `/workstation` and `/workstation/services`
  // are both prefixes of `/workstation/services/tds`, so "does the path
  // start with this tab" lights two at once — the winner is the longest
  // matching `to`, i.e. the most specific tab.
  const activeTo = tabs
    .filter((t) =>
      t.end
        ? location.pathname === t.to
        : location.pathname === t.to || location.pathname.startsWith(t.to + '/'),
    )
    .sort((a, b) => b.to.length - a.to.length)[0]?.to ?? null;

  return (
    <nav className="m-nav md:hidden" aria-label="Primary">
      {tabs.map((t) => {
        const Icon = t.icon;
        const active = t.to === activeTo;
        return (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className="m-nav-item"
            data-active={active}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={20} strokeWidth={active ? 2.25 : 1.75} aria-hidden />
            <span className="m-nav-label">{t.label}</span>
          </NavLink>
        );
      })}
      <button type="button" onClick={onOpenMore} className="m-nav-item" data-active={false}>
        <MoreHorizontal size={20} strokeWidth={1.75} aria-hidden />
        <span className="m-nav-label">More</span>
      </button>
    </nav>
  );
}
