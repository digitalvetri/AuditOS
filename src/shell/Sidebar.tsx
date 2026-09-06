import { NavLink, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

const COLLAPSED_KEY = 'audit-os:sidebar-collapsed';

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
 */
export function Sidebar() {
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

  const hrmsOpen = location.pathname.startsWith('/hrms') || location.pathname === '/';

  const width = collapsed ? 'w-12' : 'w-[240px]';

  return (
    <aside
      className={`${width} shrink-0 h-screen bg-white border-r border-neutral-200 transition-[width] flex flex-col`}
      aria-label="Primary navigation"
    >
      {/* Brand */}
      <div className="h-14 flex items-center border-b border-neutral-200 px-3">
        {collapsed ? (
          <span className="text-16 font-semibold text-neutral-900">AO</span>
        ) : (
          <span className="text-16 font-semibold text-neutral-900">Audit OS</span>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 py-2 overflow-y-auto">
        <TopItem to="/" label="Dashboard" collapsed={collapsed} />
        <TopItem
          to="/hrms"
          label="HRMS"
          collapsed={collapsed}
          expanded={hrmsOpen}
          subItems={hrmsSubItems.filter((s) => s.visible)}
        />
        <TopItem to="/workstation" label="Workstation" collapsed={collapsed} reserved />
        <TopItem to="/tools" label="Tools" collapsed={collapsed} reserved />
      </nav>

      {/* Collapse toggle */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="h-8 mx-2 mb-2 text-11 uppercase tracking-[0.06em] text-neutral-500 hover:text-neutral-900 border border-neutral-200 rounded"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? '›' : '‹ Collapse'}
      </button>
    </aside>
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
          const active = isActive || (expanded && !!subItems);
          const bar = active ? 'border-l-2 border-gold' : 'border-l-2 border-transparent';
          const color = reserved
            ? 'text-neutral-400'
            : active
              ? 'text-neutral-900'
              : 'text-neutral-700';
          return `flex items-center h-8 pl-3 pr-2 text-13 font-medium ${bar} ${color} hover:text-neutral-900`;
        }}
      >
        {!collapsed && <span>{label}</span>}
        {collapsed && <span className="text-11">{label.slice(0, 1)}</span>}
      </NavLink>
      {expanded && subItems && !collapsed ? (
        <div className="mt-1 mb-2">
          {subItems.map((s) => (
            <NavLink
              key={s.to}
              to={s.to}
              className={({ isActive }) => {
                const bar = isActive ? 'border-l-2 border-gold' : 'border-l-2 border-transparent';
                const color = isActive ? 'text-neutral-900' : 'text-neutral-700';
                return `flex items-center h-7 pl-8 pr-2 text-13 ${bar} ${color} hover:text-neutral-900`;
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
