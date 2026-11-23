/**
 * UI-BUILD-PROMPT §3 Sidebar.
 *
 * Sage green, filled active pill (NOT the 2px left bar in §7). 246px expanded,
 * 64px collapsed rail. Brand top, nav, brand panel, collapse row bottom.
 *
 * Order (top → bottom):
 *   Dashboard (no section label)
 *   Blocks, as cards: Lead & Client, Office Files, Official Docs,
 *   Workstation, HR & Admin, Tools. Every row carries a page-access key
 *   (backend src/platform/pages.ts) an Admin can switch off per employee.
 */
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  BookOpen,
  Briefcase,
  CalendarDays,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  ClipboardCheck,
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
  CalendarClock, FileWarning, GitCompareArrows, KeyRound, GraduationCap, X,
  type LucideIcon,
} from 'lucide-react';
import { tracksHr, useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { api } from '@/services/api';
import { Avatar } from '@/components/viz';
import { usePinnedClients } from '@/modules/workstation/pins';
import { clientsBulkApi } from '@/modules/workstation/clientImport';
import { gstFilingApi } from '@/modules/workstation/gst/api';
import { istToday, periodName, previousPeriod } from '@/modules/dashboardV2/brief';
import { employeeApi } from '@/modules/employees/api';
import { TOOLS } from '@/modules/tools/registry';
// The rail lists the registrations from the same catalogue the pages
// render, so a service can never exist in one place and not the other.
import { REGISTRATION_SERVICES } from '@/pages/workstation/registration/services';

const COLLAPSED_KEY = 'audit-os:sidebar-collapsed';
const FOLDED_KEY = 'audit-os:sidebar-folded-sections';

/**
 * A row below the icon level. A child may carry its own children — Services →
 * Registration → the ten registrations — so the rail nests three deep.
 */
export interface NavChild {
  to: string;
  label: string;
  children?: { to: string; label: string }[];
}
export interface NavItem {
  to: string;
  label: string;
  /** Page-access key (backend src/platform/pages.ts). An Admin can switch
      the page off per employee; its children go with it. */
  page: string;
  icon: LucideIcon;
  end?: boolean;
  visible: boolean;
  /** A count pill on the right (e.g. open approvals); `hot` draws it in the brand colour. */
  badge?: number;
  hot?: boolean;
  /** Service categories nested under Workstation → Services. Names only —
      each row deep-links to the Services page scoped by its slug. */
  children?: NavChild[];
  /** Sub-heading the row sits under inside its module ("Clients", "Billing"…).
      Rows keep the order given; a heading shows once, before its first row. */
  section?: string;
}
export interface NavGroup {
  label: string | null; // null = no section header (Dashboard row)
  items: NavItem[];
}

/**
 * The blocks shown as cards at the top of the rail. Each maps to one nav group
 * (by its label) and carries a live one-line stat. The first four are the
 * firm's working blocks; HR & Admin and Tools hold everything else.
 */
export type ModuleKey = 'LEAD_CLIENT' | 'OFFICE_FILES' | 'OFFICIAL_DOCS' | 'WORKSTATION' | 'HR_ADMIN' | 'TOOLS';
export const MODULE_META: Record<ModuleKey, { title: string; icon: LucideIcon }> = {
  LEAD_CLIENT: { title: 'Lead & Client', icon: Handshake },
  OFFICE_FILES: { title: 'Office Files', icon: ReceiptText },
  OFFICIAL_DOCS: { title: 'Official Docs', icon: BookOpen },
  WORKSTATION: { title: 'Workstation', icon: Briefcase },
  HR_ADMIN: { title: 'HR & Admin', icon: Users },
  TOOLS: { title: 'Tools', icon: Wrench },
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

/** A permission check: the signed-in role's by default, or a given role's (page-access editor). */
export type Allow = (permission: Parameters<typeof can>[1], scope?: Parameters<typeof can>[2]) => boolean;

export interface NavOptions {
  pendingCount?: number;
  clientCount?: number;
  /** Check another login's grants instead of the signed-in role (page-access editor). */
  allow?: Allow;
  /** Keep rows switched off for the login (the editor lists them). Default: drop them. */
  keepHidden?: boolean;
  /** Keep rows the role cannot see too, with `visible` false (the editor greys them). */
  keepInvisible?: boolean;
}

/**
 * The navigation: one source for the Sidebar, the global search's page list
 * (GlobalSearch), the page-access guard and the page-access editor. The
 * permission checks here are menu-rendering only — the API enforces access.
 */
export function buildNav(
  role: Parameters<typeof can>[0],
  session: { employee: { exclude_from_hr?: boolean } | null; hidden_pages?: string[] } | null | undefined,
  { pendingCount = 0, clientCount, allow: allowOpt, keepHidden = false, keepInvisible = false }: NavOptions = {},
): NavGroup[] {
  const allow: Allow = allowOpt ?? ((p, sc = 'self') => can(role, p, sc));
  const hidden = new Set(keepHidden ? [] : session?.hidden_pages ?? []);
  // Payroll and Expenses are tabs inside Accounts: one row, visible to any
  // role with access to any of its tabs.
  const canAccountsRead =
    allow('accounts.read', 'organisation')
    || allow('accounts.manage', 'organisation')
    || allow('payroll.view.own', 'self')
    || allow('payroll.view', 'organisation')
    || allow('expense.submit', 'self')
    || allow('expense.approve', 'department');
  // Every staff member with an attendance record checks in and applies for
  // leave as themselves — even without HR access (Associates). Those reach
  // only their own rows (/me/…); the API keeps everyone else's closed.
  const ownHr = tracksHr(session);
  const seesAttendance = allow('attendance.read', 'self');
  const seesLeave = allow('leave.read', 'self');
  const services = allow('workstation.service.read', 'self');
  const invoices = allow('workstation.invoice.read', 'self');

  // ── Lead & Client ──
  const leadClient: NavItem[] = [
    { page: 'clients',    to: '/workstation/clients',    label: 'Clients',    icon: Handshake,    visible: allow('workstation.client.read'), badge: clientCount },
    { page: 'leads',      to: '/workstation/leads',      label: 'Leads',      icon: PhoneCall,    visible: allow('workstation.lead.read') },
    { page: 'follow_ups', to: '/workstation/follow-ups', label: 'Follow-ups', icon: Clock,        visible: allow('workstation.followup.read') },
    { page: 'documents',  to: '/workstation/documents',  label: 'Documents',  icon: FolderKanban, visible: allow('workstation.document.read') },
    { page: 'calendar',   to: '/workstation/calendar',   label: 'Calendar',   icon: CalendarDays, visible: allow('workstation.followup.read') },
  ];
  // ── Office Files: what the firm issues ──
  const officeFiles: NavItem[] = [
    { page: 'quotations',         to: '/workstation/quotations',         label: 'Quotations',         icon: FileSignature, end: true, visible: allow('workstation.quotation.read') },
    { page: 'engagement_letters', to: '/workstation/engagement',         label: 'Engagement letters', icon: ScrollText,    visible: allow('workstation.engagement.read') },
    { page: 'invoices',           to: '/workstation/invoices',           label: 'Invoices',           icon: ReceiptText,   end: true, visible: invoices },
    { page: 'recurring_invoices', to: '/workstation/recurring-invoices', label: 'Recurring invoices', icon: Wallet,        visible: invoices },
    { page: 'credit_notes',       to: '/workstation/credit-notes',       label: 'Credit notes',       icon: IndianRupee,   visible: invoices },
    { page: 'receivables',        to: '/hrms/payment-summary',           label: 'Receivables',        icon: BarChart3,     visible: allow('payment_summary.read', 'organisation') },
  ];
  // ── Official Docs: the firm's own registers and records ──
  const officialDocs: NavItem[] = [
    { page: 'sales_register',   to: '/workstation/sales-register', label: 'Sales register',     icon: ReceiptText, visible: invoices },
    { page: 'payroll_expenses', to: '/hrms/accounts',              label: 'Payroll & expenses', icon: BookOpen,    visible: canAccountsRead },
    { page: 'finance_mis',      to: '/hrms/reports',               label: 'Finance MIS',        icon: BarChart3,   visible: allow('reports.hr', 'department') || allow('reports.finance', 'organisation') || allow('reports.all', 'organisation') },
    { page: 'employee_records', to: '/hrms/documents',             label: 'Employee records',   icon: FileText,    visible: allow('document.read', 'self') },
    { page: 'attendance',       to: seesAttendance ? '/hrms/attendance' : '/me/attendance', label: 'Attendance', icon: Clock, visible: seesAttendance || ownHr },
    { page: 'audit_trail',      to: '/hrms/audit-log',             label: 'Audit trail',        icon: ScrollText,  visible: allow('audit.read.all', 'organisation') || allow('audit.read.hr', 'organisation') || allow('audit.read.finance', 'organisation') },
  ];
  // ── Workstation: the filing and audit work itself ──
  const workstation: NavItem[] = [
    { page: 'ws_overview', to: '/workstation', label: 'Overview', icon: LayoutGrid, end: true, visible: allow('workstation.access') },
    { page: 'tasks',       to: '/workstation/tasks', label: 'Tasks', icon: ListChecks, visible: allow('workstation.task.read') },
    { page: 'registration', to: '/workstation/services/registration', label: 'Registration', icon: Landmark, visible: services,
      children: REGISTRATION_SERVICES.map((r) => ({ to: `/workstation/services/registration/${r.slug}`, label: r.name })) },
    { section: 'Returns', page: 'gst_filing', to: '/workstation/services/gst-filing', label: 'GST filing', icon: FileText, visible: services && allow('workstation.gst.read') },
    { section: 'Returns', page: 'tds_filing', to: '/workstation/services/tds',        label: 'TDS filing', icon: FileText, visible: services },
    { section: 'IT filing', page: 'it_filing', to: '/workstation/it-filing', label: 'IT returns',          icon: FileText,         visible: services },
    { section: 'IT filing', page: 'it_26as',   to: '/workstation/tds-recon', label: '26AS reconciliation', icon: GitCompareArrows, visible: services || allow('tools.audit_automation.access') },
    { section: 'IT filing', page: 'it_ais',    to: '/workstation/ais-recon', label: 'AIS reconciliation',  icon: GitCompareArrows, visible: services },
    { section: 'MCA filing', page: 'mca_llp',     to: '/workstation/services/registration/llp/compliance',             label: 'LLP forms',               icon: Landmark, visible: services },
    { section: 'MCA filing', page: 'mca_company', to: '/workstation/services/registration/private-limited/compliance', label: 'Pvt Ltd / Section 8 forms', icon: Landmark, visible: services },
    { section: 'Other work', page: 'eway_bill',    to: '/workstation/services/e-way-bill', label: 'E-way bill generation', icon: ReceiptText, visible: allow('workstation.eway.read') },
    { section: 'Other work', page: 'notice_reply', to: '/workstation/notices',  label: 'Notice reply', icon: FileWarning, visible: allow('workstation.notice.read') || allow('workstation.notice.manage') },
    { section: 'Other work', page: 'dsc_register', to: '/workstation/dsc',      label: 'DSC register', icon: KeyRound,    visible: allow('workstation.dsc.read') || allow('workstation.dsc.manage') },
    { section: 'Other work', page: 'compliance_calendar', to: '/workstation/compliance', label: 'Compliance calendar', icon: CalendarClock, visible: allow('workstation.compliance.read') },
    { section: 'Other work', page: 'document_formats',    to: '/workstation/doc',        label: 'Document formats',    icon: FileText,      visible: allow('workstation.doc.read') },
    /* BOOKKEEPING-REBUILD §7: the native accounting engine is where data is entered. */
    { section: 'Bookkeeping', page: 'data_entry',   to: '/workstation/services/bookkeeping',  label: 'Data entry',   icon: BookOpen, visible: services },
    { section: 'Bookkeeping', page: 'tally_export', to: '/workstation/services/tally-export', label: 'Tally export', icon: FileText, visible: services },
    { section: 'Bookkeeping', page: 'zoho_books',   to: '/books',                             label: 'Zoho Books',   icon: Wallet,   visible: allow('books.access', 'organisation') },
    { section: 'Audit section', page: 'audit_section', to: '/workstation/audits', label: 'Audit files', icon: ClipboardCheck, end: true, visible: allow('workstation.audit.read'),
      children: [
        { to: '/workstation/audits/type/internal',  label: 'Internal audit' },
        { to: '/workstation/audits/type/tax',       label: 'Tax audit' },
        { to: '/workstation/audits/type/statutory', label: 'Statutory audit' },
        { to: '/workstation/audits/udins',          label: 'UDIN register' },
      ] },
  ];
  // ── HR & Admin ──
  const hrAdmin: NavItem[] = [
    { page: 'employees',   to: '/hrms/employees',   label: 'Employees',   icon: Users,         visible: allow('employee.read', 'department') },
    { page: 'leave',       to: seesLeave ? '/hrms/leave' : '/me/leave', label: 'Leave', icon: CalendarDays, visible: seesLeave || ownHr },
    // Chats are between staff; the owner logins have no staff record.
    { page: 'messages',    to: '/hrms/messages',    label: 'Messages',    icon: MessageSquare, visible: allow('chat.participate', 'organisation') && Boolean(session?.employee) },
    { page: 'articleship', to: '/hrms/articleship', label: 'Articleship', icon: GraduationCap, visible: allow('employee.manage', 'organisation') || allow('employee.read', 'organisation') },
    { page: 'settings',    to: '/hrms/settings',    label: 'Settings',    icon: Settings,      visible: allow('settings.manage', 'organisation') },
  ];
  // ── Tools: converters, Repotic pipelines, connected services ──
  const tools: NavItem[] = [
    { page: 'tools', to: '/tools', label: 'Tools', icon: Wrench, visible: allow('tools.access') },
    { page: 'repotic', to: '/audit-automation', label: 'Repotic', icon: Landmark, visible: allow('tools.audit_automation.access'),
      children: [
        { to: '/audit-automation/bank', label: 'Bank → Tally' },
        { to: '/audit-automation/ecommerce', label: 'Ecommerce GSTR-1' },
        ...(allow('tools.audit_automation.gst.view') ? [{ to: '/audit-automation/gst', label: 'GSTR-2B reconciliation' }] : []),
      ] },
    { page: 'integrations', to: '/integrations/zoho-payments', label: 'Integrations', icon: Plug, visible: allow('integrations.access', 'organisation'),
      children: [
        { to: '/integrations/zoho-payments', label: 'Zoho Payments' },
        { to: '/integrations/ai-provider', label: 'AI provider' },
        { to: '/integrations/payment-gateways', label: 'Payment gateways' },
      ] },
  ];
  const keep = (items: NavItem[]) => items.filter((i) => (keepInvisible || i.visible) && !hidden.has(i.page));
  return [
    { label: null, items: [{ page: 'dashboard', to: '/', label: 'Dashboard', icon: Home, end: true, visible: true, badge: pendingCount || undefined, hot: true }] },
    { label: 'LEAD_CLIENT', items: keep(leadClient) },
    { label: 'OFFICE_FILES', items: keep(officeFiles) },
    { label: 'OFFICIAL_DOCS', items: keep(officialDocs) },
    { label: 'WORKSTATION', items: keep(workstation) },
    { label: 'HR_ADMIN', items: keep(hrAdmin) },
    { label: 'TOOLS', items: keep(tools) },
  ].filter((g) => g.items.length > 0);
}

/**
 * The page a path belongs to, judged against the full menu (switched-off rows
 * included) — so the shell can say "switched off" instead of rendering it.
 */
export function pageKeyForPath(
  role: Parameters<typeof can>[0],
  session: Parameters<typeof buildNav>[1],
  path: string,
): string | null {
  const nav = buildNav(role, session, { keepHidden: true });
  const rows = nav.flatMap((g) => g.items.flatMap((it) => [
    { to: it.to, page: it.page },
    ...(it.children ?? []).flatMap((c) => [{ to: c.to, page: it.page }, ...(c.children ?? []).map((l) => ({ to: l.to, page: it.page }))]),
  ]));
  let best: { to: string; page: string } | null = null;
  for (const r of rows) {
    const hit = r.to === '/' ? path === '/' : path === r.to || path.startsWith(r.to + '/');
    if (hit && (!best || r.to.length > best.to.length)) best = r;
  }
  return best && best.page !== 'dashboard' ? best.page : null;
}

/** Split a module's rows into its sub-headed runs, keeping their order. */
function sectionsOf(items: NavItem[]): { title: string | null; items: NavItem[] }[] {
  const out: { title: string | null; items: NavItem[] }[] = [];
  for (const it of items) {
    const title = it.section ?? null;
    const last = out[out.length - 1];
    if (last && last.title === title) last.items.push(it);
    else out.push({ title, items: [it] });
  }
  return out;
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
    // One row is enough: `count` is the total the caller can see.
    queryFn: () => clientsBulkApi.page({ page_size: 1 }),
    enabled: seesClients, staleTime: 300_000,
  });
  const pendingCount = pending.data?.count ?? 0;
  const clientCount = clients.data?.count;
  // People stat for the HR & Admin card — shares the top bar's "who's in" cache.
  const seesPeople = can(role, 'employee.read', 'department');
  const people = useQuery({
    queryKey: ['employees', 'who-is-in'],
    queryFn: () => employeeApi.list({}),
    enabled: seesPeople, staleTime: 120_000,
  });

  const nav = useMemo(() => buildNav(role, session, { pendingCount, clientCount }), [role, session, pendingCount, clientCount]);

  const [collapsedPref, setCollapsed] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  });
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(COLLAPSED_KEY, collapsedPref ? '1' : '0');
  }, [collapsedPref]);

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
  // The icon rail is a desktop preference: the phone/tablet drawer always
  // opens full width with labels, even if the rail was collapsed on desktop.
  const collapsed = isDesktop && collapsedPref;
  const asideWidth = collapsed ? 72 : 264;

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
  // Sub-groups the user folded ("WORKSTATION:Bookkeeping"), remembered per browser.
  const [foldedSecs, setFoldedSecs] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]') as string[]; } catch { return []; }
  });
  const toggleSec = (key: string) => setFoldedSecs((cur) => {
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
    try { localStorage.setItem(FOLDED_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });

  const stat = (key: ModuleKey, g: NavGroup): string => {
    const pages = `${g.items.length} page${g.items.length === 1 ? '' : 's'}`;
    if (key === 'HR_ADMIN' && people.data) {
      const list = people.data.items as { today_attendance?: { check_in_at: string | null } | null }[];
      const inToday = list.filter((r) => r.today_attendance?.check_in_at).length;
      return `${list.length} people · ${inToday} in`;
    }
    if (key === 'LEAD_CLIENT' && clientCount !== undefined) return `${clientCount} client${clientCount === 1 ? '' : 's'}`;
    if (key === 'TOOLS' && can(role, 'tools.access', 'self')) return `${TOOLS.length} tools`;
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
        <Brand collapsed={collapsed} onClose={mobileOpen ? onMobileClose : undefined} />

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
              {sectionsOf(active.items).map((sec, i) => {
                const key = `${active.label}:${sec.title}`;
                // The group holding the current page never folds away.
                const holdsHere = sec.items.some((it) => it.to === here?.to || (it.children ?? []).some((c) => c.to === here?.to || (c.children ?? []).some((l) => l.to === here?.to)));
                const isFolded = !!sec.title && !collapsed && foldedSecs.includes(key) && !holdsHere;
                return (
                  <div key={sec.title ?? `s${i}`} className={i > 0 && collapsed ? 'mt-1 pt-1 border-t border-white/[0.07]' : ''}>
                    {sec.title && !collapsed ? (
                      <button type="button" onClick={() => toggleSec(key)} aria-expanded={!isFolded}
                        className="group/sub flex w-full items-center justify-between pl-5 pr-4 pt-3 pb-1 text-[11px] font-medium text-sidebarMuted/80 hover:text-white transition-colors">
                        <span>{sec.title}</span>
                        <ChevronDown size={12} strokeWidth={2.5} className={'opacity-0 group-hover/sub:opacity-80 transition-[transform,opacity] ' + (isFolded ? '-rotate-90 opacity-60' : '')} />
                      </button>
                    ) : null}
                    {isFolded ? null : <Section group={{ label: null, items: sec.items }} collapsed={collapsed} first={false} folded={false} />}
                  </div>
                );
              })}
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

function Brand({ collapsed, onClose }: { collapsed: boolean; onClose?: () => void }) {
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
      {/* Drawer only (below 1024px): an explicit way out besides the scrim. */}
      {onClose ? (
        <button type="button" onClick={onClose} aria-label="Close menu"
          className="lg:hidden ml-auto shrink-0 h-10 w-10 grid place-items-center rounded-[10px] text-sidebarMuted hover:text-sidebarText hover:bg-white/[0.08] transition-colors">
          <X size={18} strokeWidth={2} />
        </button>
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
 * This month's GST filing progress — the GSTR-1 / GSTR-3B returns recorded on
 * Services → GST Filing (`/api/gst/filing-board`), so the card and that page
 * agree. Shares the page's query key, so filing a return there updates it.
 */
function FilingSeason() {
  const { session } = useAuth();
  const seesGst = can(session?.role.code, 'workstation.gst.read', 'self');
  const period = previousPeriod(istToday());
  const board = useQuery({
    queryKey: ['gst-filing', period],
    queryFn: () => gstFilingApi.board(period),
    enabled: seesGst, staleTime: 120_000,
  });
  if (!seesGst || !board.data) return null;
  const st = board.data.tiles.returns;
  if (!st?.total) return null;
  const pct = Math.round((st.filed / st.total) * 100);
  return (
    <Link to="/workstation/services/gst-filing"
      className="sb-season mx-3 mb-2 mt-2 block rounded-[12px] px-3 py-[10px] shrink-0">
      <div className="flex items-center justify-between text-12 font-medium text-white/85">
        <span>GST · {periodName(period)} returns</span>
        <span className="font-semibold text-[#a78bfa]">{pct}%</span>
      </div>
      <div className="h-[6px] rounded-full bg-white/10 my-2 overflow-hidden">
        <i className="sb-season-bar block h-full rounded-full" style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
      <div className="text-11 text-sidebarMuted">
        {st.filed} of {st.total} filed{st.overdue ? ` · ${st.overdue} at risk` : ''}
      </div>
    </Link>
  );
}

function ProfileLink({ hasProfile, className, title, children }: { hasProfile: boolean; className: string; title?: string; children: ReactNode }) {
  return hasProfile
    ? <Link to="/me/profile" className={className} title={title}>{children}</Link>
    : <div className={className} title={title}>{children}</div>;
}

/** Signed-in person, with the rail collapse toggle beside them. */
function Profile({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { session } = useAuth();
  const name = session?.employee?.full_name ?? session?.user.email ?? '';
  const Icon = collapsed ? ChevronsRight : ChevronsLeft;
  return (
    <div className={'shrink-0 flex items-center gap-3 border-t border-white/[0.07] ' + (collapsed ? 'flex-col py-3 px-2' : 'px-4 py-3')}>
      {/* Only staff with an employee record have a profile page — the Super
          Admin / Admin owner accounts would land on "Page not found". */}
      <ProfileLink hasProfile={Boolean(session?.employee)} className="flex items-center gap-3 min-w-0 flex-1" title={collapsed ? name : undefined}>
        <Avatar name={name} src={session?.employee?.photo_url} size={32} style={{ boxShadow: '0 0 0 2px rgb(255 255 255 / 0.12)' }} />
        {!collapsed ? (
          <span className="min-w-0">
            <span className="block text-13 font-semibold text-white truncate">{name}</span>
            <span className="block text-11 text-sidebarMuted truncate">{session?.role.name}</span>
          </span>
        ) : null}
      </ProfileLink>
      <button
        type="button"
        onClick={onToggle}
        className="hidden lg:grid shrink-0 h-8 w-8 place-items-center rounded-[9px] text-white/60 hover:text-white hover:bg-white/[0.08] transition-colors"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <Icon size={16} strokeWidth={1.9} />
      </button>
    </div>
  );
}
