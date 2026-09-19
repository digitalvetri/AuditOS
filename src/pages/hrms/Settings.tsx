/**
 * /hrms/settings — Part 1's configuration hub (§8.11).
 *
 * Left-rail sub-navigation because there are enough sections that tabs would
 * scroll. Each section is a self-contained component; the page just switches
 * on the section URL param.
 */
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import type { PermissionCode, Scope } from '@/platform/rbac/matrix';
import type { RoleCode } from '@/data/models';
import { DepartmentsSection } from '@/modules/settings/DepartmentsSection';
import { DesignationsSection } from '@/modules/settings/DesignationsSection';
import { WorkLocationsSection } from '@/modules/settings/WorkLocationsSection';
import { HolidaysSection } from '@/modules/settings/HolidaysSection';
import { LeaveTypesSection } from '@/modules/settings/LeaveTypesSection';
import { ExpenseCategoriesSection } from '@/modules/settings/ExpenseCategoriesSection';
import { StatutoryRatesSection } from '@/modules/settings/StatutoryRatesSection';
import { RolesSection } from '@/modules/settings/RolesSection';
import { ZpayIntegrationsSection } from '@/modules/zpay/IntegrationsSection';

type Section =
  | 'departments'
  | 'designations'
  | 'work-locations'
  | 'holidays'
  | 'leave-types'
  | 'expense-categories'
  | 'statutory-rates'
  | 'roles'
  | 'integrations-zoho-payments';

interface SectionDef {
  id: Section;
  label: string;
  group: string;
  /** Per-section permission gate. Defaults to settings.manage@organisation. */
  permission?: PermissionCode;
  scope?: Scope;
}

const SECTIONS: SectionDef[] = [
  { id: 'departments', label: 'Departments', group: 'Organisation' },
  { id: 'designations', label: 'Designations', group: 'Organisation' },
  { id: 'work-locations', label: 'Work locations', group: 'Organisation' },
  { id: 'holidays', label: 'Holiday calendar', group: 'Time & Leave' },
  { id: 'leave-types', label: 'Leave types', group: 'Time & Leave' },
  { id: 'expense-categories', label: 'Expense categories', group: 'Finance' },
  { id: 'statutory-rates', label: 'Statutory rates', group: 'Finance' },
  { id: 'roles', label: 'Roles & permissions', group: 'Access' },
  // The Zoho Payments row is behind the FINANCE permission, not the HR one —
  // spec §1: "the connect action lives in Settings under a finance permission,
  // not on a client record."
  {
    id: 'integrations-zoho-payments',
    label: 'Zoho Payments',
    group: 'Integrations',
    permission: 'accounts.manage',
    scope: 'organisation',
  },
];

function isSectionVisible(role: RoleCode | undefined, s: SectionDef): boolean {
  if (s.permission) return can(role, s.permission, s.scope ?? 'self');
  return can(role, 'settings.manage', 'organisation');
}

export function SettingsPage() {
  const { session } = useAuth();
  const role = session?.role.code;
  const [params, setParams] = useSearchParams();
  const visibleSections = SECTIONS.filter((s) => isSectionVisible(role, s));
  // Fall back to the first visible section if the URL param names one the
  // caller cannot see, so a finance_admin who bookmarks ?section=departments
  // does not land on a blank pane.
  const requested = params.get('section') as Section | null;
  const section: Section =
    requested && visibleSections.some((s) => s.id === requested)
      ? requested
      : visibleSections[0]?.id ?? 'departments';

  if (visibleSections.length === 0) {
    return (
      <div className="w-full max-w-[720px] mx-auto bg-white border border-neutral-200 rounded p-4 md:p-6">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Access denied</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">
          Nothing here for your role.
        </h1>
        <p className="text-13 text-neutral-500 mt-2">
          Ask an administrator if you need a value changed.
        </p>
      </div>
    );
  }

  const setSection = (s: Section) => setParams({ section: s });
  const groups = Array.from(new Set(visibleSections.map((s) => s.group)));

  return (
    <div className="m-page">
      <header>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">HRMS</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">Settings</h1>
      </header>

      {/* Mobile category nav. A <select> rather than a chip rail: there are
          eight sections in four groups, and the optgroup keeps the grouping
          the desktop rail shows in its headers. One tap, no sideways hunting. */}
      <div className="md:hidden m-form" data-testid="settings-nav-mobile">
        <label className="block">
          <span className="m-section-title block mb-1">Section</span>
          <select
            value={section}
            onChange={(e) => setSection(e.target.value as Section)}
            className="w-full px-3 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
          >
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {visibleSections.filter((x) => x.group === g).map((x) => (
                  <option key={x.id} value={x.id}>{x.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-0 md:mt-6 grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6">
        <aside data-testid="settings-nav" className="hidden md:block">
          {groups.map((g) => (
            <div key={g} className="mb-4">
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 mb-1">{g}</div>
              {visibleSections.filter((s) => s.group === g).map((s) => {
                const active = s.id === section;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSection(s.id)}
                    data-testid={`settings-nav-${s.id}`}
                    className={
                      'flex items-center h-8 pl-3 pr-2 text-13 w-full text-left border-l-2 ' +
                      (active
                        ? 'border-gold text-neutral-900 font-medium'
                        : 'border-transparent text-neutral-700 hover:text-neutral-900')
                    }
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          ))}
        </aside>
        <main data-testid={`settings-section-${section}`} className="m-form min-w-0">
          {section === 'departments' ? <DepartmentsSection /> : null}
          {section === 'designations' ? <DesignationsSection /> : null}
          {section === 'work-locations' ? <WorkLocationsSection /> : null}
          {section === 'holidays' ? <HolidaysSection /> : null}
          {section === 'leave-types' ? <LeaveTypesSection /> : null}
          {section === 'expense-categories' ? <ExpenseCategoriesSection /> : null}
          {section === 'statutory-rates' ? <StatutoryRatesSection /> : null}
          {section === 'roles' ? <RolesSection /> : null}
          {section === 'integrations-zoho-payments' ? <ZpayIntegrationsSection /> : null}
        </main>
      </div>
    </div>
  );
}
