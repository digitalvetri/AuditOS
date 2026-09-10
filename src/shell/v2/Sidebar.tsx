/**
 * UI-BUILD-PROMPT §3 Sidebar.
 *
 * Sage green, filled active pill (NOT the 2px left bar in §7). 246px expanded,
 * 64px collapsed rail. Brand top, nav, brand panel, collapse row bottom.
 *
 * Order (top → bottom):
 *   Dashboard (no section label)
 *   HRMS        — 10 items
 *   WORKSTATION — 6 items
 *   TOOLS       — 3 items: Tools (converters), Repotic (bank/GST/TDS),
 *                 Books (native bookkeeping). One section, three siblings.
 */
import { NavLink, useLocation } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  BookOpen,
  Briefcase,
  CalendarDays,
  Calculator,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  FileText,
  FolderKanban,
  Handshake,
  Home,
  IndianRupee,
  Landmark,
  LayoutGrid,
  MessageSquare,
  PhoneCall,
  ReceiptIndianRupee,
  Settings,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

const COLLAPSED_KEY = 'audit-os:sidebar-collapsed';
const SECTIONS_COLLAPSED_KEY = 'audit-os:sidebar-sections-collapsed';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  visible: boolean;
  /** Service categories nested under Workstation → Services. Names only —
      each row deep-links to the Services page scoped by its slug. */
  children?: { to: string; label: string }[];
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
  // Reports / Settings; no Tools if `tools.access` is not granted.
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
    // Workstation (teammate's module, per AUDIT_OS_WORKSTATION.md §4).
    // Sub-items follow the same can(role, ...) pattern; roles without a
    // workstation.access grant see nothing here.
    const workstationItems: NavItem[] = [
      { to: '/workstation',             label: 'Overview',   icon: LayoutGrid,    end: true, visible: can(role, 'workstation.access', 'self') },
      { to: '/workstation/leads',       label: 'Leads',      icon: PhoneCall,     visible: can(role, 'workstation.lead.read', 'self') },
      { to: '/workstation/clients',     label: 'Clients',    icon: Handshake,     visible: can(role, 'workstation.client.read', 'self') },
      { to: '/workstation/follow-ups',  label: 'Follow-ups', icon: Clock,         visible: can(role, 'workstation.followup.read', 'self') },
      { to: '/workstation/services',    label: 'Services',   icon: Briefcase,     end: true, visible: can(role, 'workstation.service.read', 'self'),
        children: [
          { to: '/workstation/services/gst',           label: 'GST' },
          { to: '/workstation/services/tds',           label: 'TDS' },
          { to: '/workstation/services/e-way-bill',    label: 'E-Way Bill' },
          { to: '/workstation/services/bookkeeping',   label: 'Bookkeeping' },
          { to: '/workstation/services/incorporation', label: 'Incorporation' },
          { to: '/workstation/services/e-invoice',     label: 'E-Invoice' },
        ] },
      { to: '/workstation/documents',   label: 'Documents',  icon: FolderKanban,  visible: can(role, 'workstation.document.read', 'self') },
    ];
    // TOOLS is one labelled section — a sibling of Workstation — holding
    // four tool modules as siblings inside it: Tools (converters), Repotic
    // (bank / GST / TDS pipelines), Tally (native double-entry accounting)
    // and Books (native bookkeeping). Each row keeps its own grant, so a
    // role with only one of them still sees just that row.
    const toolsItems: NavItem[] = [
      { to: '/tools', label: 'Tools', icon: Wrench,
        visible: can(role, 'tools.access', 'self') },
      { to: '/audit-automation', label: 'Repotic', icon: Landmark,
        visible: can(role, 'tools.audit_automation.access', 'self') },
      { to: '/tally', label: 'Tally', icon: Calculator,
        visible: can(role, 'tools.audit_automation.tally.access', 'self') },
      { to: '/books', label: 'Books', icon: Wallet,
        visible: can(role, 'books.access', 'self') },
    ];
    return [
      { label: null, items: [{ to: '/', label: 'Dashboard', icon: Home, end: true, visible: true }] },
      { label: 'HRMS', items: auditItems.filter((i) => i.visible) },
      { label: 'WORKSTATION', items: workstationItems.filter((i) => i.visible) },
      { label: 'TOOLS', items: toolsItems.filter((i) => i.visible) },
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

  // Per-section collapse — keyed by section label (AUDIT, WORKSTATION, TOOLS).
  // Dashboard has no label so it's never collapsible. Persisted in
  // localStorage so a user's fold state survives reload.
  const [sectionsCollapsed, setSectionsCollapsed] = useState<Set<string>>(() => {
    if (typeof localStorage === 'undefined') return new Set();
    try {
      const raw = localStorage.getItem(SECTIONS_COLLAPSED_KEY);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch { return new Set(); }
  });
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SECTIONS_COLLAPSED_KEY, JSON.stringify([...sectionsCollapsed]));
  }, [sectionsCollapsed]);
  const toggleSection = (label: string) => {
    setSectionsCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      return next;
    });
  };

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
          'flex flex-col bg-sidebar text-sidebarText lg:border-r lg:border-border ' +
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
            <Section
              key={i}
              group={group}
              collapsed={collapsed}
              first={i === 0}
              folded={group.label ? sectionsCollapsed.has(group.label) : false}
              onToggle={group.label ? () => toggleSection(group.label!) : undefined}
            />
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

interface SectionProps {
  group: NavGroup;
  collapsed: boolean;   // rail collapsed (icon-only mode)
  first: boolean;
  folded: boolean;      // this section's items hidden
  onToggle?: () => void;
}
function Section({ group, collapsed, first, folded, onToggle }: SectionProps) {
  // A group without a label (Dashboard) is never foldable — always renders
  // its lone row. Labeled groups (AUDIT, WORKSTATION) get a chevron button.
  const showHeader = group.label && !collapsed;
  return (
    <div>
      {showHeader ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!folded}
          className={
            'flex items-center gap-2 w-full pl-6 pr-4 pb-2 text-13 font-bold uppercase ' +
            'tracking-[0.14em] text-sidebarText hover:text-ink transition-colors ' +
            (first ? 'pt-4' : 'pt-5')
          }
        >
          <span>{group.label}</span>
          <ChevronDown
            size={14}
            strokeWidth={2.5}
            className={'transition-transform ' + (folded ? '-rotate-90' : '')}
          />
        </button>
      ) : null}
      {!folded || !group.label ? (
        <ul className={collapsed ? 'px-2 space-y-1' : 'px-2 space-y-px'}>
          {group.items.map((it) => (
            <li key={it.to}>
              <NavItemRow item={it} collapsed={collapsed} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function NavItemRow({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const Icon = item.icon;
  const location = useLocation();
  const hasChildren = !collapsed && !!item.children?.length;
  // Open whenever the user is anywhere under the parent (e.g. a service
  // category), so a deep link lands with its row already revealed.
  const onBranch = location.pathname.startsWith(item.to);
  const [open, setOpen] = useState(onBranch);
  useEffect(() => { if (onBranch) setOpen(true); }, [onBranch]);

  const row = (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) => {
        const base = 'flex items-center gap-3 h-11 rounded-lg text-15 transition-colors';
        const spacing = collapsed ? 'justify-center px-0' : 'px-3';
        const grow = hasChildren ? ' flex-1 min-w-0' : '';
        const state = isActive
          ? 'bg-sidebarActive text-sidebarText font-semibold'
          : 'text-sidebarText font-medium hover:bg-sidebarHover';
        return `${base} ${spacing} ${state}${grow}`;
      }}
      title={collapsed ? item.label : undefined}
    >
      <Icon size={20} strokeWidth={2} className="shrink-0" />
      {!collapsed ? <span className="truncate">{item.label}</span> : null}
    </NavLink>
  );

  if (!hasChildren) return row;

  return (
    <>
      <div className="flex items-center">
        {row}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={(open ? 'Collapse' : 'Expand') + ' ' + item.label}
          className="shrink-0 h-11 w-7 flex items-center justify-center rounded-lg text-sidebarText hover:bg-sidebarHover transition-colors"
        >
          <ChevronDown
            size={14}
            strokeWidth={2.5}
            className={'transition-transform ' + (open ? '' : '-rotate-90')}
          />
        </button>
      </div>
      {open ? (
        <ul className="mt-px space-y-px">
          {item.children!.map((child) => (
            <li key={child.to}>
              <NavLink
                to={child.to}
                className={({ isActive }) =>
                  'flex items-center h-9 pl-11 pr-3 rounded-lg text-14 transition-colors ' +
                  (isActive
                    ? 'bg-sidebarActive text-sidebarText font-semibold'
                    : 'text-sidebarText font-medium hover:bg-sidebarHover')
                }
              >
                <span className="truncate">{child.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      ) : null}
    </>
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
