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
 *                 Books (Zoho Books). One section, sibling rows.
 */
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  BookOpen,
  Briefcase,
  CalendarDays,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  FileSignature,
  ReceiptText,
  FileText,
  FolderKanban,
  Handshake,
  IndianRupee,
  Home,
  Landmark,
  LayoutGrid,
  ListChecks,
  MessageSquare,
  PhoneCall,
  Plug,
  Settings,
  Users,
  ScrollText,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { api } from '@/services/api';
import { Avatar } from '@/components/viz';
import { usePinnedClients } from '@/modules/workstation/pins';
import { workstationApi } from '@/modules/workstation/api';
import { gstApi } from '@/modules/workstation/gst/api';
import { filingStats, istToday, periodName, previousPeriod, returnCells } from '@/modules/dashboardV2/brief';
import { employeeApi } from '@/modules/employees/api';
import { TOOLS } from '@/modules/tools/registry';
// The rail lists the registrations from the same catalogue the pages
// render, so a service can never exist in one place and not the other.
import { REGISTRATION_SERVICES } from '@/pages/workstation/registration/services';

const COLLAPSED_KEY = 'audit-os:sidebar-collapsed';

/**
 * A row below the icon level. A child may carry its own children — Services →
 * Registration → the ten registrations — so the rail nests three deep.
 */
interface NavChild {
  to: string;
  label: string;
  children?: { to: string; label: string }[];
}
interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  visible: boolean;
  /** A count pill on the right (e.g. open approvals); `hot` draws it in the brand colour. */
  badge?: number;
  hot?: boolean;
  /** Service categories nested under Workstation → Services. Names only —
      each row deep-links to the Services page scoped by its slug. */
  children?: NavChild[];
}
interface NavGroup {
  label: string | null; // null = no section header (Dashboard row)
  items: NavItem[];
}

/**
 * The four modules shown as cards at the top of the rail. Each maps to one
 * nav group (by its label) and carries a live one-line stat.
 */
type ModuleKey = 'HRMS' | 'WORKSTATION' | 'TOOLS' | 'INTEGRATIONS';
const MODULE_META: Record<ModuleKey, { title: string; icon: LucideIcon }> = {
  HRMS: { title: 'HRMS', icon: Users },
  WORKSTATION: { title: 'Workstation', icon: Briefcase },
  TOOLS: { title: 'Tools', icon: Wrench },
  INTEGRATIONS: { title: 'Integrations', icon: Plug },
};
const MODULE_KEY = 'audit-os:sidebar-module';

/** Pastel chip tones for menu icons — [background, icon colour]. */
const CHIP_TONES: [string, string][] = [
  ['#e6f7ee', '#1f9d5a'], ['#fff0e6', '#e2742d'], ['#efe9ff', '#7a5af8'], ['#e6f1ff', '#2f6fed'],
  ['#ffe9f0', '#e0457b'], ['#e6fbfa', '#0f9d96'], ['#fff7d6', '#b98900'], ['#f3e8ff', '#a347d6'],
];
function chipStyle(to: string, active: boolean): React.CSSProperties {
  if (active) return { background: '#ffcf5c', color: '#1f1d2b' };
  let h = 0;
  for (let i = 0; i < to.length; i++) h = (h * 31 + to.charCodeAt(i)) >>> 0;
  const [bg, fg] = CHIP_TONES[h % CHIP_TONES.length];
  return { background: bg, color: fg };
}

/** Every navigable row (item, child, leaf) with the module it belongs to. */
function flatten(nav: NavGroup[]): { to: string; label: string; module: string | null }[] {
  return nav.flatMap((g) => g.items.flatMap((it) => [
    { to: it.to, label: it.label, module: g.label },
    ...(it.children ?? []).flatMap((c) => [
      { to: c.to, label: c.label, module: g.label },
      ...(c.children ?? []).map((l) => ({ to: l.to, label: l.label, module: g.label })),
    ]),
  ]));
}

/** The nav row a path belongs to — the longest matching prefix wins ('/' only matches itself). */
function matchRow(rows: ReturnType<typeof flatten>, path: string) {
  let best: (typeof rows)[number] | null = null;
  for (const r of rows) {
    const hit = r.to === '/' ? path === '/' : path === r.to || path.startsWith(r.to + '/');
    if (hit && (!best || r.to.length > best.to.length)) best = r;
  }
  return best;
}

interface Props {
  mobileOpen: boolean;
  onMobileClose: () => void;
}

export function Sidebar({ mobileOpen, onMobileClose }: Props) {
  const { session } = useAuth();
  const role = session?.role.code;

  // Count pills — the same queries (and cache keys) the dashboard uses, so
  // they cost nothing extra once the dashboard has loaded.
  const approves = can(role, 'leave.approve', 'department') || can(role, 'expense.approve', 'department')
    || can(role, 'attendance.correct.approve', 'department');
  const pending = useQuery({
    queryKey: ['dashboard', 'pending'],
    queryFn: () => api.get<{ items: unknown[]; count: number }>('/api/dashboard/pending-actions'),
    enabled: approves, staleTime: 60_000,
  });
  const seesClients = can(role, 'workstation.client.read', 'self');
  const clients = useQuery({
    queryKey: ['sidebar', 'client-count'],
    queryFn: () => workstationApi.listClients({}),
    enabled: seesClients, staleTime: 300_000,
  });
  const pendingCount = pending.data?.count ?? 0;
  const clientCount = clients.data?.count;
  // People stat for the HRMS card — shares the top bar's "who's in" cache.
  const seesPeople = can(role, 'employee.read', 'department');
  const people = useQuery({
    queryKey: ['employees', 'who-is-in'],
    queryFn: () => employeeApi.list({}),
    enabled: seesPeople, staleTime: 120_000,
  });

  // Role-scoped nav (§6.1). `can()` here is menu-rendering only — the API
  // is what actually enforces access. Employee: no Employees / Accounts /
  // Reports / Settings; no Tools if `tools.access` is not granted.
  const nav = useMemo<NavGroup[]>(() => {
    // Payroll and Expenses used to be top-level sidebar entries; they
    // are now tabs INSIDE Accounts (§6.1). One "Accounts" row here,
    // visible to any role with access to any sub-tab.
    const canAccountsRead =
      can(role, 'accounts.read', 'organisation')
      || can(role, 'accounts.manage', 'organisation')
      || can(role, 'payroll.view.own', 'self')
      || can(role, 'payroll.view', 'organisation')
      || can(role, 'expense.submit', 'self')
      || can(role, 'expense.approve', 'department')
    const auditItems: NavItem[] = [
      { to: '/hrms/employees',  label: 'Employees',  icon: Users,                visible: can(role, 'employee.read', 'department') },
      { to: '/hrms/attendance', label: 'Attendance', icon: Clock,                visible: can(role, 'attendance.read', 'self') },
      { to: '/hrms/leave',      label: 'Leave',      icon: CalendarDays,         visible: can(role, 'leave.read', 'self') },
      { to: '/hrms/accounts',   label: 'Accounts',   icon: BookOpen,             visible: canAccountsRead },
      { to: '/hrms/payment-summary', label: 'Payment summary', icon: IndianRupee, visible: can(role, 'payment_summary.read', 'organisation') },
      { to: '/hrms/messages',   label: 'Messages',   icon: MessageSquare,        visible: can(role, 'chat.participate', 'organisation') },
      { to: '/hrms/documents',  label: 'Employee Data', icon: FileText,             visible: can(role, 'document.read', 'self') },
      { to: '/hrms/reports',    label: 'Reports',    icon: BarChart3,            visible: can(role, 'reports.hr', 'department') || can(role, 'reports.finance', 'organisation') || can(role, 'reports.all', 'organisation') },
      { to: '/hrms/settings',   label: 'Settings',   icon: Settings,             visible: can(role, 'settings.manage', 'organisation') },
    ];
    // Workstation (teammate's module, per AUDIT_OS_WORKSTATION.md §4).
    // Sub-items follow the same can(role, ...) pattern; roles without a
    // workstation.access grant see nothing here.
    const workstationItems: NavItem[] = [
      { to: '/workstation',             label: 'Overview',   icon: LayoutGrid,    end: true, visible: can(role, 'workstation.access', 'self') },
      /* Quotation is its own module. Billing — invoices, receipts, what is
         actually charged — is a separate thing and gets its own row when it
         exists; a quotation is a proposal and is not billing. */
      { to: '/workstation/quotations',  label: 'Quotation',  icon: FileSignature, end: true, visible: can(role, 'workstation.quotation.read', 'self') },
      { to: '/workstation/invoices',    label: 'Invoice',    icon: ReceiptText,   end: true, visible: can(role, 'workstation.invoice.read', 'self') },
      { to: '/workstation/engagement',  label: 'Engagement', icon: ScrollText,    visible: can(role, 'workstation.engagement.read', 'self') },
      { to: '/workstation/doc',         label: 'Format',     icon: FileText,      visible: can(role, 'workstation.doc.read', 'self') },
      { to: '/workstation/leads',       label: 'Leads',      icon: PhoneCall,     visible: can(role, 'workstation.lead.read', 'self') },
      { to: '/workstation/clients',     label: 'Clients',    icon: Handshake,     visible: can(role, 'workstation.client.read', 'self'), badge: clientCount },
      { to: '/workstation/follow-ups',  label: 'Follow-ups', icon: Clock,         visible: can(role, 'workstation.followup.read', 'self') },
      { to: '/workstation/calendar',    label: 'Calendar',   icon: CalendarDays,  visible: can(role, 'workstation.followup.read', 'self') },
      { to: '/workstation/services',    label: 'Services',   icon: Briefcase,     end: true, visible: can(role, 'workstation.service.read', 'self'),
        children: [
          { to: '/workstation/services/tds',           label: 'TDS' },
          /* BOOKKEEPING-REBUILD §7 renames "Bookkeeping" (the
             accounting engine) to "Books". */
          { to: '/workstation/services/bookkeeping',   label: 'Books' },
          { to: '/workstation/services/tally-export',  label: 'Tally Export' },
          { to: '/workstation/services/registration',  label: 'Registration',
            children: REGISTRATION_SERVICES.map((r) => ({
              to: `/workstation/services/registration/${r.slug}`,
              label: r.name,
            })) },
        ] },
      { to: '/workstation/tasks',       label: 'Task',       icon: ListChecks,    visible: can(role, 'workstation.task.read', 'self') },
      { to: '/workstation/documents',   label: 'Documents',  icon: FolderKanban,  visible: can(role, 'workstation.document.read', 'self') },
    ];
    // TOOLS is one labelled section — a sibling of Workstation — holding
    // three tool modules as siblings inside it: Tools (converters), Repotic
    // (bank / GST / TDS pipelines) and Books (Zoho Books integration). The
    // native double-entry accounting engine (formerly "Tally") moved to
    // Services → Bookkeeping and is not a Tools row any more.
    const toolsItems: NavItem[] = [
      { to: '/tools', label: 'Tools', icon: Wrench,
        visible: can(role, 'tools.access', 'self') },
      { to: '/audit-automation', label: 'Repotic', icon: Landmark,
        visible: can(role, 'tools.audit_automation.access', 'self') },
      { to: '/books', label: 'Books', icon: Wallet,
        visible: can(role, 'books.access', 'organisation') },
    ];
    // INTEGRATIONS — third-party services the firm connects to (Zoho
    // Payments today; Books/Tally/banking as they land). Sibling of
    // Tools, not nested inside HRMS: this is firm-level infrastructure,
    // not an HR concern.
    const integrationsItems: NavItem[] = [
      { to: '/integrations/zoho-payments', label: 'Zoho Payments', icon: Plug,
        visible: can(role, 'integrations.access', 'organisation') },
    ];
    return [
      { label: null, items: [{ to: '/', label: 'Dashboard', icon: Home, end: true, visible: true, badge: pendingCount || undefined, hot: true }] },
      { label: 'HRMS', items: auditItems.filter((i) => i.visible) },
      { label: 'WORKSTATION', items: workstationItems.filter((i) => i.visible) },
      { label: 'TOOLS', items: toolsItems.filter((i) => i.visible) },
      { label: 'INTEGRATIONS', items: integrationsItems.filter((i) => i.visible) },
    ].filter((g) => g.items.length > 0);
  }, [role, pendingCount, clientCount]);

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

  // ── Modules ───────────────────────────────────────────────────────────
  const home = nav.find((g) => g.label === null);
  const modules = nav.filter((g): g is NavGroup & { label: ModuleKey } => !!g.label && g.label in MODULE_META);
  const rows = useMemo(() => flatten(nav), [nav]);
  const here = matchRow(rows, location.pathname);
  const [chosen, setChosen] = useState<string | null>(() => {
    try { return localStorage.getItem(MODULE_KEY); } catch { return null; }
  });
  // Landing on a page selects its module, so the menu always shows where you are.
  useEffect(() => { if (here?.module) setChosen(here.module); }, [here?.module]);
  useEffect(() => { try { if (chosen) localStorage.setItem(MODULE_KEY, chosen); } catch { /* ignore */ } }, [chosen]);
  const active = modules.find((m) => m.label === chosen) ?? modules[0];

  const stat = (key: ModuleKey, g: NavGroup): string => {
    const pages = `${g.items.length} page${g.items.length === 1 ? '' : 's'}`;
    if (key === 'HRMS' && people.data) {
      const list = people.data.items as { today_attendance?: { check_in_at: string | null } | null }[];
      const inToday = list.filter((r) => r.today_attendance?.check_in_at).length;
      return `${list.length} people · ${inToday} in`;
    }
    if (key === 'WORKSTATION' && clientCount !== undefined) return `${clientCount} client${clientCount === 1 ? '' : 's'}`;
    if (key === 'TOOLS' && can(role, 'tools.access', 'self')) return `${TOOLS.length} tools`;
    if (key === 'INTEGRATIONS') return g.items.map((i) => i.label).join(' · ');
    return pages;
  };

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
          'sb-creative flex flex-col bg-sidebar text-sidebarText lg:border-r lg:border-white/5 ' +
          'fixed inset-y-0 left-0 z-50 max-w-[82vw] ' +
          `${drawer} ` +
          'lg:relative lg:z-auto lg:h-full lg:translate-x-0 lg:visible ' +
          'transition-[transform,width,visibility] shrink-0'
        }
        style={{ width: asideWidth }}
        aria-label="Primary navigation"
      >
        <Brand collapsed={collapsed} />

        <nav className="sidebar-scroll sb-nav-limit flex-1 min-h-0 overflow-y-auto pt-1 pb-2">
          {home ? <Section group={home} collapsed={collapsed} first folded={false} /> : null}

          {/* Module switcher: cards when expanded, icon buttons on the rail. */}
          {modules.length > 1 ? (
            collapsed ? (
              <ul className="px-2 pt-3 mt-2 space-y-1 border-t border-white/[0.07]" aria-label="Modules">
                {modules.map((m) => {
                  const M = MODULE_META[m.label];
                  const on = m === active;
                  return (
                    <li key={m.label}>
                      <button type="button" onClick={() => setChosen(m.label)} title={M.title} aria-pressed={on}
                        data-mod={m.label}
                        className={'sb-modicon w-full h-10 grid place-items-center rounded-[12px] ' + (on ? 'is-on' : '')}>
                        <M.icon size={18} strokeWidth={1.9} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="grid grid-cols-2 gap-2 px-3 pt-3" role="tablist" aria-label="Modules">
                {modules.map((m) => {
                  const M = MODULE_META[m.label];
                  const on = m === active;
                  return (
                    <button key={m.label} type="button" role="tab" aria-selected={on} onClick={() => setChosen(m.label)}
                      data-mod={m.label}
                      className={'sb-modcard text-left rounded-[16px] px-3 pt-[10px] pb-[9px] ' + (on ? 'is-on' : '')}>
                      <span className="sb-modcard-ico h-7 w-7 rounded-[8px] grid place-items-center mb-2"><M.icon size={15} strokeWidth={2} /></span>
                      <span className="block text-13 font-semibold text-white leading-tight truncate">{M.title}</span>
                      <span className="block text-[11px] text-sidebarMuted leading-tight mt-0.5 truncate">{stat(m.label, m)}</span>
                    </button>
                  );
                })}
              </div>
            )
          ) : null}

          {/* The chosen module's pages — all visible, nothing to unfold. */}
          {active ? (
            <div className={collapsed ? 'mt-2 pt-2 border-t border-white/[0.07]' : ''}>
              {!collapsed ? (
                <div className="flex items-center justify-between pl-5 pr-4 pt-5 pb-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-sidebarMuted">
                  <span>{MODULE_META[active.label].title}</span>
                  <span className="tabular-nums normal-case tracking-normal">{active.items.length}</span>
                </div>
              ) : null}
              <Section group={{ label: null, items: active.items }} collapsed={collapsed} first={false} folded={false} />
            </div>
          ) : null}

          {!collapsed ? <Pinned /> : null}

        </nav>
        {!collapsed ? <FilingSeason /> : null}
        <Profile collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
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
  // Same height as TopBar (h-20) so the brand plate and search bar sit on one
  // line. Divider on the bottom lines up with the TopBar's border so the
  // header reads as one continuous strip across the shell. The brand mark is
  // the full lockup on a white plate — the logo already carries the wordmark,
  // so no separate text is rendered beside it.
  return (
    <div className={'h-20 flex items-center gap-3 shrink-0 ' + (collapsed ? 'justify-center px-0' : 'pl-4 pr-3')}>
      <span
        className="sb-logo inline-flex items-center justify-center shrink-0 rounded-[11px]"
        /* No white plate. The mark sits directly on the navy rail and is
           rendered white, so the brand reads as one piece with the sidebar
           instead of a card floating on it. The rail is navy in BOTH themes
           (--c-sidebar), so white is correct in each. */
        style={{ height: 40, width: collapsed ? 44 : 64, padding: '0 8px' }}
        aria-label="JNS Accounting Solutions"
      >
        <img
          src="/jns-mark.png"
          alt=""
          aria-hidden="true"
          /* The artwork is solid navy on transparent; brightness(0) flattens
             it to black and invert(1) lifts it to pure white, which keeps one
             asset serving both the white-background and dark-background
             lockups. The swoosh climbs above the cap height on the right, so
             a 1px lift optically centres the letterform mass. */
          className="sb-logo-img block max-h-full max-w-full object-contain -translate-y-px"
        />
      </span>
      {!collapsed ? (
        <div className="flex flex-col justify-center min-w-0">
          <span className="text-14 font-semibold text-sidebarText tracking-tight leading-tight truncate">JNS Accounting</span>
          <span className="text-12 font-medium text-sidebarMuted leading-tight mt-0.5 truncate">Practice workspace</span>
        </div>
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
            'group/sec flex items-center justify-between gap-2 w-full pl-5 pr-4 pb-2 text-[10.5px] font-semibold uppercase ' +
            'tracking-[0.1em] text-sidebarMuted hover:text-white transition-colors ' +
            (first ? 'pt-3' : 'pt-5')
          }
        >
          <span>{group.label}</span>
          <ChevronDown
            size={13}
            strokeWidth={2.5}
            className={'opacity-60 group-hover/sec:opacity-100 transition-[transform,opacity] ' + (folded ? '-rotate-90' : '')}
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
        const base = 'group/nav relative flex items-center gap-3 h-[38px] rounded-[10px] text-14 transition-colors';
        const spacing = collapsed ? 'justify-center px-0' : 'px-3';
        const grow = hasChildren ? ' flex-1 min-w-0' : '';
        const state = isActive
          ? 'sb-active relative text-white font-semibold before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[3px] before:rounded-full before:bg-[#a78bfa]'
          : 'text-white/70 font-medium sb-hover hover:text-white';
        return `${base} ${spacing} ${state}${grow}`;
      }}
      title={collapsed ? item.label : undefined}
    >
      {({ isActive }) => (
        <>
          {/* Each row's icon sits in its own pastel chip (stable colour per
              page); the selected row's chip turns sunny yellow on the ink pill. */}
          <span className="sb-chip shrink-0 h-7 w-7 rounded-[9px] grid place-items-center" style={chipStyle(item.to, isActive)}>
            <Icon size={15} strokeWidth={2} />
          </span>
          {!collapsed ? <span className="truncate">{item.label}</span> : null}
          {item.badge ? (
            collapsed
              ? <span className={'absolute top-[6px] right-2 h-2 w-2 rounded-full ' + (item.hot ? 'bg-coral' : 'bg-white/50')} aria-label={`${item.badge}`} />
              : <span className={'sb-count ml-auto ' + (item.hot ? 'is-hot' : '')}>{item.badge > 99 ? '99+' : item.badge}</span>
          ) : null}
        </>
      )}
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
          className="shrink-0 h-10 w-7 flex items-center justify-center rounded-lg text-white/60 hover:bg-white/[0.05] hover:text-white transition-colors"
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
              <NavChildRow child={child} />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/**
 * A second-level row. With grandchildren it is only a group header — the
 * whole row opens and closes the third level indented under it, and has no
 * page of its own; without, it is the plain link it always was.
 */
function NavChildRow({ child }: { child: NavChild }) {
  const location = useLocation();
  const hasKids = !!child.children?.length;
  const onBranch = location.pathname.startsWith(child.to);
  const [open, setOpen] = useState(onBranch);
  useEffect(() => { if (onBranch) setOpen(true); }, [onBranch]);

  if (!hasKids) {
    return (
      <NavLink
        to={child.to}
        className={({ isActive }) =>
          'flex items-center h-9 pl-11 pr-3 rounded-lg text-13 transition-colors ' +
          (isActive
            ? 'sb-active relative text-white font-semibold before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[3px] before:rounded-full before:bg-[#a78bfa]'
            : 'text-white/70 font-medium sb-hover hover:text-white')
        }
      >
        <span className="truncate">{child.label}</span>
      </NavLink>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={
          'w-full flex items-center h-9 pl-11 pr-0 rounded-lg text-13 hover:bg-white/[0.05] hover:text-white transition-colors ' +
          (onBranch ? 'text-white font-semibold' : 'text-white/70 font-medium')
        }
      >
        <span className="flex-1 min-w-0 truncate text-left">{child.label}</span>
        <span className="shrink-0 w-7 flex items-center justify-center" aria-hidden>
          <ChevronDown
            size={12}
            strokeWidth={2.5}
            className={'transition-transform ' + (open ? '' : '-rotate-90')}
          />
        </span>
      </button>
      {open ? (
        <ul className="mt-px space-y-px">
          {child.children!.map((leaf) => (
            <li key={leaf.to}>
              <NavLink
                to={leaf.to}
                /* Third level: indented past the child text, and titled —
                   "Private Limited Company Registration" cannot fit a 264px
                   rail, so the full name lives in the tooltip. */
                title={leaf.label}
                className={({ isActive }) =>
                  'flex items-center h-8 pl-[68px] pr-3 rounded-lg text-12 transition-colors ' +
                  (isActive
                    ? 'sb-active relative text-white font-semibold before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[3px] before:rounded-full before:bg-[#a78bfa]'
                    : 'text-white/55 font-medium sb-hover hover:text-white')
                }
              >
                <span className="truncate">{leaf.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** The user's pinned clients (toggled from the Client 360 panel). */
function Pinned() {
  const { session } = useAuth();
  const { pins } = usePinnedClients();
  if (!pins.length || !can(session?.role.code, 'workstation.client.read', 'self')) return null;
  return (
    <div>
      <div className="pl-5 pr-4 pt-5 pb-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-sidebarMuted">Pinned</div>
      <ul className="px-2 space-y-px">
        {pins.map((p) => (
          <li key={p.id}>
            <NavLink to={`/workstation/clients/${p.id}`} title={p.name}
              className={({ isActive }) => 'flex items-center gap-3 h-8 px-3 rounded-[9px] text-13 transition-colors ' +
                (isActive ? 'sb-active text-white font-semibold' : 'text-white/70 sb-hover hover:text-white')}>
              <Avatar name={p.name} size={20} square />
              <span className="truncate">{p.name}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * This month's GST filing progress — the same return-case data and period
 * the dashboard gauge uses (modules/dashboardV2/brief.ts), so they agree.
 */
function FilingSeason() {
  const { session } = useAuth();
  const seesGst = can(session?.role.code, 'workstation.gst.read', 'self');
  const period = previousPeriod(istToday());
  const gst = useQuery({
    queryKey: ['gst', 'client-dashboard', period],
    queryFn: () => gstApi.clientDashboard(period),
    enabled: seesGst, staleTime: 120_000,
  });
  if (!seesGst || !gst.data) return null;
  const st = filingStats(returnCells(gst.data));
  if (!st.total) return null;
  const pct = Math.round(st.progress * 100);
  return (
    <Link to="/workstation/services/registration/gst/dashboard"
      className="sb-season mx-3 mb-2 mt-2 block rounded-[12px] px-3 py-[10px] shrink-0">
      <div className="flex items-center justify-between text-12 font-medium text-white/85">
        <span>GST · {periodName(period)} returns</span>
        <span className="font-semibold text-[#a78bfa]">{pct}%</span>
      </div>
      <div className="h-[6px] rounded-full bg-white/10 my-2 overflow-hidden">
        <i className="sb-season-bar block h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
      <div className="text-11 text-sidebarMuted">
        {st.filed} of {st.total} filed{st.atRisk ? ` · ${st.atRisk} at risk` : ''}
      </div>
    </Link>
  );
}

/** Signed-in person, with the rail collapse toggle beside them. */
function Profile({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { session } = useAuth();
  const name = session?.employee?.full_name ?? session?.user.email ?? '';
  const Icon = collapsed ? ChevronsRight : ChevronsLeft;
  return (
    <div className={'shrink-0 flex items-center gap-3 border-t border-white/[0.07] ' + (collapsed ? 'flex-col py-3 px-2' : 'px-4 py-3')}>
      <Link to="/me/profile" className="flex items-center gap-3 min-w-0 flex-1" title={collapsed ? name : undefined}>
        <Avatar name={name} src={session?.employee?.photo_url} size={32} style={{ boxShadow: '0 0 0 2px rgb(255 255 255 / 0.12)' }} />
        {!collapsed ? (
          <span className="min-w-0">
            <span className="block text-13 font-semibold text-white truncate">{name}</span>
            <span className="block text-11 text-sidebarMuted truncate">{session?.role.name}</span>
          </span>
        ) : null}
      </Link>
      <button
        type="button"
        onClick={onToggle}
        className="shrink-0 h-8 w-8 grid place-items-center rounded-[9px] text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <Icon size={16} strokeWidth={1.9} />
      </button>
    </div>
  );
}
