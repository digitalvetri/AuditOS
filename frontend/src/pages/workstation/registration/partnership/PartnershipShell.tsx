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
  const gst = kind === 'GST';
  const tabs = [
    // GST has its own dashboard one level up, in the GST module.
    ...(gst ? [] : [{ to: 'dashboard', label: 'Dashboard' }]),
    { to: 'clients', label: 'Clients' },
    ...(can(session?.role.code, 'workstation.registration.template.manage', 'organisation')
      ? [{ to: 'template', label: 'Checklist Template' }]
      : []),
    { to: 'registration', label: gst ? 'Reference' : 'Registration' },
    // Private Limited: INC-20A / ADTC for every incorporated company.
    ...(kind === 'PRIVATE_LIMITED' ? [{ to: 'compliance', label: 'Post-Registration Compliance' }] : []),
  ];
  return (
    <ServiceProvider kind={kind}>
    <div className={gst ? 'reg-m' : 'm-page reg-m'}>
      <nav className="m-rail flex gap-2 mb-5 overflow-x-auto pb-1">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) =>
              'px-3 min-h-[44px] md:min-h-0 md:h-8 flex items-center text-13 whitespace-nowrap rounded-full border transition-colors ' +
              (isActive ? 'bg-[#f1edff] border-[#cbbdf2] text-primary font-medium' : 'bg-white border-neutral-200 text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50')
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
