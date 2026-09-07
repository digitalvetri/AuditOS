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
import { DepartmentsSection } from '@/modules/settings/DepartmentsSection';
import { DesignationsSection } from '@/modules/settings/DesignationsSection';
import { WorkLocationsSection } from '@/modules/settings/WorkLocationsSection';
import { HolidaysSection } from '@/modules/settings/HolidaysSection';
import { LeaveTypesSection } from '@/modules/settings/LeaveTypesSection';
import { ExpenseCategoriesSection } from '@/modules/settings/ExpenseCategoriesSection';
import { StatutoryRatesSection } from '@/modules/settings/StatutoryRatesSection';
import { RolesSection } from '@/modules/settings/RolesSection';

type Section =
  | 'departments'
  | 'designations'
  | 'work-locations'
  | 'holidays'
  | 'leave-types'
  | 'expense-categories'
  | 'statutory-rates'
  | 'roles';

const SECTIONS: { id: Section; label: string; group: string }[] = [
  { id: 'departments', label: 'Departments', group: 'Organisation' },
  { id: 'designations', label: 'Designations', group: 'Organisation' },
  { id: 'work-locations', label: 'Work locations', group: 'Organisation' },
  { id: 'holidays', label: 'Holiday calendar', group: 'Time & Leave' },
  { id: 'leave-types', label: 'Leave types', group: 'Time & Leave' },
  { id: 'expense-categories', label: 'Expense categories', group: 'Finance' },
  { id: 'statutory-rates', label: 'Statutory rates', group: 'Finance' },
  { id: 'roles', label: 'Roles & permissions', group: 'Access' },
];

export function SettingsPage() {
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'settings.manage', 'organisation');
  const [params, setParams] = useSearchParams();
  const section = (params.get('section') as Section | null) ?? 'departments';

  if (!canManage) {
    return (
      <div className="max-w-[720px] mx-auto bg-white border border-neutral-200 rounded p-6">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Access denied</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">
          Settings are HR/MD only.
        </h1>
        <p className="text-13 text-neutral-500 mt-2">
          Ask an administrator if you need a value changed.
        </p>
      </div>
    );
  }

  const setSection = (s: Section) => setParams({ section: s });
  const groups = Array.from(new Set(SECTIONS.map((s) => s.group)));

  return (
    <div className="">
      <header>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">HRMS</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">Settings</h1>
      </header>
      <div className="mt-6 grid grid-cols-1 md:grid-cols-[220px_1fr] gap-6">
        <aside data-testid="settings-nav">
          {groups.map((g) => (
            <div key={g} className="mb-4">
              <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 mb-1">{g}</div>
              {SECTIONS.filter((s) => s.group === g).map((s) => {
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
        <main data-testid={`settings-section-${section}`}>
          {section === 'departments' ? <DepartmentsSection /> : null}
          {section === 'designations' ? <DesignationsSection /> : null}
          {section === 'work-locations' ? <WorkLocationsSection /> : null}
          {section === 'holidays' ? <HolidaysSection /> : null}
          {section === 'leave-types' ? <LeaveTypesSection /> : null}
          {section === 'expense-categories' ? <ExpenseCategoriesSection /> : null}
          {section === 'statutory-rates' ? <StatutoryRatesSection /> : null}
          {section === 'roles' ? <RolesSection /> : null}
        </main>
      </div>
    </div>
  );
}
