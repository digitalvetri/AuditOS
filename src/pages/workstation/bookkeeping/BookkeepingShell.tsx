import { NavLink, Outlet } from 'react-router-dom';

/**
 * BOOKKEEPING SERVICE shell.
 *
 * Lives under Workstation → Services → Bookkeeping and owns nothing
 * financial: every accounting figure belongs to Books, which this module
 * links out to rather than reimplements.
 *
 * The tab strip scrolls horizontally on a narrow screen instead of wrapping
 * into a second row that pushes the page content down on mobile.
 */
const TABS: { to: string; label: string; end?: boolean }[] = [
  { to: '.', label: 'Overview', end: true },
  { to: 'clients', label: 'Clients' },
  { to: 'monthly-work', label: 'Monthly Work' },
  { to: 'tasks', label: 'Tasks' },
  { to: 'pending-items', label: 'Pending Items' },
  { to: 'documents', label: 'Documents' },
  { to: 'deliverables', label: 'Deliverables' },
  { to: 'reminders', label: 'Reminders' },
  { to: 'settings', label: 'Settings' },
];

export function BookkeepingShell() {
  return (
    <div>
      <nav className="flex gap-1 border-b border-neutral-200 mb-4 overflow-x-auto">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              'px-3 h-9 flex items-center text-13 whitespace-nowrap border-b-2 -mb-px ' +
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
