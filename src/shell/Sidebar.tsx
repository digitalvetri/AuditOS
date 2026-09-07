import { NavLink, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

const COLLAPSED_KEY = 'audit-os:sidebar-collapsed';

/** Matches Tailwind's `lg`. Below this the sidebar is a drawer, not a column. */
const DESKTOP_QUERY = '(min-width: 1024px)';

/**
 * The collapsed rail is a desktop idea, but `collapsed` also decides things
 * CSS cannot reach — whether `TopItem` renders "Dashboard" or "D". So the
 * breakpoint has to be readable from JS, not just from a `lg:` prefix.
 */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setIsDesktop(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isDesktop;
}

interface SubItem {
  to: string;
  label: string;
  visible: boolean;
}

/**
 * Four-item shell (§6.1). Order fixed:
 *   Dashboard · HRMS (expanded, sub-items) · Workstation (reserved) · Tools (reserved)
 *
 * Behaviour rules that are load-bearing:
 *   - Only one top-level section expands at a time. HRMS is expanded by default.
 *   - Sub-items derived from the caller's permission set.
 *   - Active item = 2px gold LEFT bar, nothing else. No background, no pill.
 *   - Collapsible to 48px icon rail; collapse state persists across sessions.
 *   - Reserved sections render at reduced emphasis but stay clickable.
 *
 * Below `lg` (1024px) the same element becomes an off-canvas drawer. A 240px
 * rail against a 390px phone leaves 150px of content, and a tablet in
 * portrait is not a narrow desktop — so the column leaves the flow entirely
 * and the shell hands it a full-width viewport. Nothing about the navigation
 * itself changes: same component, same permission filtering, same routes.
 */
export function Sidebar({
  mobileOpen,
  onMobileClose,
}: {
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const { session } = useAuth();
  const role = session?.role.code;
  const location = useLocation();

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  });

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  // Tapping a link in the drawer should navigate AND close it — otherwise the
  // destination renders behind a scrim the user has to dismiss by hand.
  useEffect(() => {
    onMobileClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onMobileClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, onMobileClose]);

  // HRMS sub-items — visibility follows §5 matrix.
  const hrmsSubItems: SubItem[] = [
    { to: '/hrms/employees', label: 'Employees', visible: can(role, 'employee.read', 'department') },
    { to: '/hrms/attendance', label: 'Attendance', visible: can(role, 'attendance.read', 'self') },
    { to: '/hrms/leave', label: 'Leave', visible: can(role, 'leave.read', 'self') },
    { to: '/hrms/payroll', label: 'Payroll', visible: can(role, 'payroll.view.own', 'self') || can(role, 'payroll.view', 'organisation') },
    { to: '/hrms/expenses', label: 'Expenses', visible: can(role, 'expense.submit', 'self') || can(role, 'expense.approve', 'department') },
    { to: '/hrms/accounts', label: 'Accounts', visible: can(role, 'accounts.read', 'organisation') || can(role, 'accounts.manage', 'organisation') },
    { to: '/hrms/messages', label: 'Messages', visible: can(role, 'chat.participate', 'organisation') },
    { to: '/hrms/documents', label: 'Documents', visible: can(role, 'document.read', 'self') },
    // §6.1 explicitly says Reports does NOT appear for Employee. Employee has
    // `reports.hr` at self scope (per §5) — but that reads via profile, not
    // the sidebar. Sidebar entry requires department scope or higher.
    { to: '/hrms/reports', label: 'Reports', visible: can(role, 'reports.hr', 'department') || can(role, 'reports.finance', 'organisation') || can(role, 'reports.all', 'organisation') },
    { to: '/hrms/settings', label: 'Settings', visible: can(role, 'settings.manage', 'organisation') },
  ];

  // Workstation sub-items (AUDIT_OS_WORKSTATION.md §4) — same permission-driven
  // pattern as HRMS above. A role with no workstation.* grant (hr_admin,
  // finance_admin) sees no Workstation section at all: an entry leading to a
  // screen that answers 403 is a dead click.
  const workstationSubItems: SubItem[] = [
    { to: '/workstation', label: 'Dashboard', visible: can(role, 'workstation.access', 'self') },
    { to: '/workstation/leads', label: 'Leads', visible: can(role, 'workstation.lead.read', 'self') },
    { to: '/workstation/clients', label: 'Clients', visible: can(role, 'workstation.client.read', 'self') },
    { to: '/workstation/follow-ups', label: 'Follow-ups', visible: can(role, 'workstation.followup.read', 'self') },
    { to: '/workstation/services', label: 'Services', visible: can(role, 'workstation.service.read', 'self') },
    { to: '/workstation/documents', label: 'Documents', visible: can(role, 'workstation.document.read', 'self') },
  ];
  const canWorkstation = can(role, 'workstation.access', 'self');

  const hrmsOpen = (location.pathname.startsWith('/hrms') || location.pathname === '/')
    && !location.pathname.startsWith('/workstation');
  const workstationOpen = location.pathname.startsWith('/workstation');

  const isDesktop = useIsDesktop();
  // A user who collapsed the rail on their desktop should not then find a
  // drawer full of single letters on their phone.
  const railCollapsed = collapsed && isDesktop;

  // Collapsing is a desktop affordance only — the drawer is always full width,
  // so the width classes are gated behind `lg:`.
  const width = collapsed ? 'lg:w-12' : 'lg:w-[240px]';

  // The drawer variant is fixed and off-canvas; `invisible` (not just the
  // translate) is what takes the links out of the tab order while it is shut.
  // Naming `visibility` in the transition is deliberate: the browser then
  // defers hiding until the slide-out finishes, so the animation survives.
  const drawer = mobileOpen
    ? 'translate-x-0'
    : '-translate-x-full invisible lg:visible';

  return (
    <>
      {/* Scrim — drawer only. Kept mounted so it can fade. */}
      <div
        className={`fixed inset-0 z-40 bg-black/[0.32] transition-opacity lg:hidden ${
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={onMobileClose}
        aria-hidden
      />

      <aside
        // `h-full`, not `h-screen`: the shell is already exactly one viewport
        // tall, so the sidebar inherits that height and stays put. `min-h-0`
        // lets the nav below become the sidebar's own scroll region when the
        // item list is longer than the column.
        className={
          'flex flex-col bg-white border-r border-neutral-200 ' +
          'fixed inset-y-0 left-0 z-50 w-[264px] max-w-[82vw] ' +
          `${drawer} ` +
          // No `lg:w-auto` here: it and `${width}` are both `lg:` utilities of
          // equal specificity, so source order decides and `auto` wins —
          // shrink-wrapping the column to ~114px. The mobile width is simply
          // overridden by the `lg:` width below.
          `lg:static lg:z-0 lg:max-w-none lg:translate-x-0 ${width} ` +
          'lg:shrink-0 lg:h-full lg:min-h-0 ' +
          'transition-[transform,visibility] lg:transition-[width]'
        }
        aria-label="Primary navigation"
      >
        {/* Brand */}
        <div className="h-14 shrink-0 flex items-center border-b border-neutral-200 px-3">
          {/* Aligned to the same 12px optical edge as the nav labels below. */}
          <span
            className={`text-14 font-semibold text-neutral-900 tracking-[-0.01em] ${
              railCollapsed ? 'mx-auto' : 'pl-1'
            }`}
          >
            {railCollapsed ? 'AO' : 'Audit OS'}
          </span>

          <div className="flex-1 lg:hidden" />
          <button
            type="button"
            onClick={onMobileClose}
            className="lg:hidden h-8 w-8 shrink-0 rounded text-13 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50 transition-colors"
            aria-label="Close navigation"
          >
            ✕
          </button>
        </div>

        {/* Nav — the only scroll region inside the column, so the visual below
            stays anchored no matter how long the permitted item list gets. */}
        <nav className="flex-1 min-h-0 overflow-y-auto py-2">
          <TopItem to="/" label="Dashboard" collapsed={railCollapsed} />
          <TopItem
            to="/hrms"
            label="HRMS"
            collapsed={railCollapsed}
            expanded={hrmsOpen}
            subItems={hrmsSubItems.filter((s) => s.visible)}
          />
          {/* Reserved sections are a separate group: a hairline divider says
              "these are not part of HRMS" without adding a heading. */}
          <div className="mt-2 pt-2 border-t border-neutral-200 mx-3" />
          {canWorkstation ? (
            <TopItem
              to="/workstation"
              label="Workstation"
              collapsed={railCollapsed}
              expanded={workstationOpen}
              subItems={workstationSubItems.filter((s) => s.visible)}
            />
          ) : null}
          <TopItem to="/tools" label="Tools" collapsed={railCollapsed} reserved />
        </nav>

        {/* Collapse toggle — desktop only; the drawer closes with the ✕ or the scrim. */}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="hidden lg:block h-8 shrink-0 mx-2 mb-2 text-11 uppercase tracking-[0.06em] text-neutral-500 hover:text-neutral-900 border border-neutral-200 rounded transition-colors"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? '›' : '‹ Collapse'}
        </button>
      </aside>
    </>
  );
}

function TopItem({
  to,
  label,
  collapsed,
  reserved = false,
  expanded = false,
  subItems,
}: {
  to: string;
  label: string;
  collapsed: boolean;
  reserved?: boolean;
  expanded?: boolean;
  subItems?: SubItem[];
}) {
  return (
    <div>
      <NavLink
        to={to}
        end={to === '/'}
        className={({ isActive }) => {
          // "Expanded" and "active" are deliberately different states. A
          // section header that merely has its children open keeps the gold
          // bar (it tells you where you are) but takes NO fill — otherwise the
          // header and the selected child both sit on a surface and the eye
          // cannot tell which row is actually current.
          const open = isActive || (expanded && !!subItems);
          const bar = open ? 'border-l-2 border-gold' : 'border-l-2 border-transparent';
          const color = reserved
            ? 'text-neutral-400'
            : open
              ? 'text-neutral-900'
              : 'text-neutral-700';
          const surface = isActive && !subItems ? 'bg-neutral-50' : 'hover:bg-neutral-50';
          return `flex items-center h-8 pl-3 pr-2 text-13 font-medium leading-5 ${bar} ${color} ${surface} hover:text-neutral-900 transition-colors`;
        }}
      >
        {!collapsed && <span>{label}</span>}
        {collapsed && <span className="text-11">{label.slice(0, 1)}</span>}
      </NavLink>
      {expanded && subItems && !collapsed ? (
        <div className="mb-1">
          {subItems.map((s) => (
            <NavLink
              key={s.to}
              to={s.to}
              className={({ isActive }) => {
                // Same 13px/20px as the parent — hierarchy comes from indent
                // and weight, not from shrinking the type.
                const bar = isActive ? 'border-l-2 border-gold' : 'border-l-2 border-transparent';
                const color = isActive ? 'text-neutral-900 font-medium' : 'text-neutral-600';
                const surface = isActive ? 'bg-neutral-50' : 'hover:bg-neutral-50';
                return `flex items-center h-7 pl-8 pr-2 text-13 leading-5 ${bar} ${color} ${surface} hover:text-neutral-900 transition-colors`;
              }}
            >
              {s.label}
            </NavLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}
