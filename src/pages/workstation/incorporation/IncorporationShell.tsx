import { NavLink, Outlet } from 'react-router-dom';

/**
 * INCORPORATION SERVICE shell.
 *
 * Lives under Workstation → Services → Incorporation. It owns no files (the
 * Documents module does), no task engine (the platform Task model does) and
 * no accounting (Books does) — it links out to each.
 *
 * There is deliberately NO Documents tab up here: document requests belong to
 * a case, and the cross-case view of what is outstanding is Pending Items.
 *
 * The tab strip scrolls horizontally on a narrow screen instead of wrapping
 * into a second row that pushes the page content down on mobile.
 */
const TABS: { to: string; label: string; end?: boolean }[] = [
  { to: '.', label: 'Overview', end: true },
  { to: 'cases', label: 'Cases' },
  { to: 'tasks', label: 'Tasks' },
  { to: 'pending-items', label: 'Pending Items' },
  { to: 'deliverables', label: 'Deliverables' },
  { to: 'settings', label: 'Settings' },
];

export function IncorporationShell() {
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
