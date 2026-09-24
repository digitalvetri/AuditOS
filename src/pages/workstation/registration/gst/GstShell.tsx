import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { ServiceProvider } from '../partnership/shared';

/**
 * GST — Workstation → Services → Registration → GST Registration.
 *
 * The registration reference (REG-01 → GSTIN) and the ongoing compliance
 * cycle share one page, because they are two halves of the same client
 * relationship: you register a client once, then file for them every month.
 *
 * Wraps everything in a ServiceProvider keyed to GST so the shared
 * Partnership screens (case, template, client list) resolve to the GST
 * master template and the /api/gst-registration base. Same COMPONENT,
 * different DATA — that is the whole point of the ServiceProvider.
 */
export function GstShell() {
  const { session } = useAuth();
  const tabs = [
    // Order follows the work: today's position first, then the cycle
    // (GSTR-1 → 2B → 3B), then the client roster, and finally the one-time
    // REG-01 reference — which is read once per client, not every month.
    { to: 'dashboard', label: 'Dashboard' },
    { to: 'gstr1', label: 'GSTR-1' },
    { to: 'gstr2b', label: 'GSTR-2B' },
    { to: 'gstr3b', label: 'GSTR-3B' },
    { to: 'clients', label: 'Clients' },
    { to: 'registration', label: 'Registration' },
    ...(can(session?.role.code, 'workstation.registration.template.manage', 'organisation')
      ? [{ to: 'template', label: 'Checklist Template' }]
      : []),
  ];
  return (
    <ServiceProvider kind="GST">
      <div className="m-page">
        <nav className="m-rail flex gap-1 border-b border-neutral-200 mb-4 overflow-x-auto">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
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
    </ServiceProvider>
  );
}
