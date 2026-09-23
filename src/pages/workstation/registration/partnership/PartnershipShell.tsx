import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import type { RegistrationKind } from '@/modules/partnership/api';
import { ServiceProvider } from './shared';

/**
 * Partnership Firm Registration and LLP Registration — Workstation →
 * Services → Registration. One shell for both; `kind` picks the service.
 *
 * Tabs, the same way GST does it: the sidebar already nests three deep and is
 * generated from the registration catalogue, so this is the fourth level.
 * "Registration" is the original catalogue page (portal link, form, output), kept.
 */
export function PartnershipShell({ kind = 'PARTNERSHIP' }: { kind?: RegistrationKind }) {
  const { session } = useAuth();
  const tabs = [
    { to: 'dashboard', label: 'Dashboard' },
    { to: 'clients', label: 'Clients' },
    ...(can(session?.role.code, 'workstation.registration.template.manage', 'organisation')
      ? [{ to: 'template', label: 'Checklist Template' }]
      : []),
    { to: 'registration', label: 'Registration' },
  ];
  return (
    <ServiceProvider kind={kind}>
    <div className="m-page">
      <nav className="m-rail flex gap-1 border-b border-neutral-200 mb-4 overflow-x-auto">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) =>
              'px-3 min-h-[44px] md:min-h-0 md:h-9 flex items-center text-13 whitespace-nowrap border-b-2 -mb-px ' +
              (isActive ? 'border-gold text-neutral-900 font-medium' : 'border-transparent text-neutral-500 hover:text-neutral-900')
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
