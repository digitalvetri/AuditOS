import { NavLink, Outlet } from 'react-router-dom';

/**
 * GST — Workstation → Services → Registration → GST Registration.
 *
 * The registration reference (REG-01 → GSTIN) and the ongoing compliance
 * cycle share one page, because they are two halves of the same client
 * relationship: you register a client once, then file for them every month.
 * The Registration tab is the ORIGINAL page, unchanged.
 *
 * Tabs, not a fourth level of sidebar: the rail already nests three deep
 * (Workstation → Services → Registration) and generates the registration
 * list from the catalogue, so a fourth level would have to special-case GST.
 */
const TABS: { to: string; label: string; end?: boolean }[] = [
  { to: '.', label: 'Registration', end: true },
  { to: 'dashboard', label: 'Dashboard' },
  { to: 'clients', label: 'Clients' },
];

export function GstShell() {
  return (
    <div className="m-page">
      <nav className="m-rail flex gap-1 border-b border-neutral-200 mb-4 overflow-x-auto">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              'px-3 min-h-[44px] md:min-h-0 md:h-9 flex items-center text-13 whitespace-nowrap border-b-2 -mb-px ' +
              (isActive
                ? 'border-gold text-neutral-900 font-medium'
                : 'border-transparent text-neutral-500 hover:text-neutral-900')
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
