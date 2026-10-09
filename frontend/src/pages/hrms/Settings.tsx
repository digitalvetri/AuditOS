/**
 * /hrms/settings — Part 1's configuration hub (§8.11).
 *
 * Left-rail sub-navigation because there are enough sections that tabs would
 * scroll. Each section is a self-contained component; the page just switches
 * on the section URL param.
 */
import { useSearchParams } from 'react-router-dom';
import {
  BadgePercent, Building2, CalendarDays, CalendarRange, KeyRound, Receipt, ShieldCheck, Users,
} from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { HolidaysSection } from '@/modules/settings/HolidaysSection';
import { LeaveTypesSection } from '@/modules/settings/LeaveTypesSection';
import { ExpenseCategoriesSection } from '@/modules/settings/ExpenseCategoriesSection';
import { StatutoryRatesSection } from '@/modules/settings/StatutoryRatesSection';
import { RolesSection } from '@/modules/settings/RolesSection';
import { UsersSection } from '@/modules/settings/UsersSection';
import { DataProtectionSection } from '@/modules/settings/DataProtectionSection';

type Section =
  | 'holidays'
  | 'leave-types'
  | 'expense-categories'
  | 'statutory-rates'
  | 'users'
  | 'roles'
  | 'data-protection';

/** Each group's tint for the menu's icon squares (the dashboard palette). */
const GROUP_TINT: Record<string, { bg: string; fg: string }> = {
  Organisation: { bg: '#e9f9f1', fg: '#047857' },
  'Time & Leave': { bg: '#efeafd', fg: '#6941d9' },
  Finance: { bg: '#fff7e6', fg: '#b45309' },
  Access: { bg: '#f5f1ff', fg: '#5b33c4' },
};

const SECTIONS: { id: Section; label: string; group: string; icon: typeof Building2 }[] = [
  { id: 'holidays', label: 'Holiday calendar', group: 'Time & Leave', icon: CalendarDays },
  { id: 'leave-types', label: 'Leave types', group: 'Time & Leave', icon: CalendarRange },
  { id: 'expense-categories', label: 'Expense categories', group: 'Finance', icon: Receipt },
  { id: 'statutory-rates', label: 'Statutory rates', group: 'Finance', icon: BadgePercent },
  { id: 'users', label: 'Users', group: 'Access', icon: Users },
  { id: 'roles', label: 'Roles & permissions', group: 'Access', icon: KeyRound },
  { id: 'data-protection', label: 'Data protection', group: 'Access', icon: ShieldCheck },
];

export function SettingsPage() {
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'settings.manage', 'organisation');
  const [params, setParams] = useSearchParams();
  const section = (params.get('section') as Section | null) ?? 'holidays';

  if (!canManage) {
    return (
      <div className="w-full max-w-[720px] mx-auto dash-card p-4 md:p-6">
        <span className="inline-flex items-center h-6 px-3 rounded-full text-12 font-medium bg-[#fef2f2] text-[#b91c1c]">Access denied</span>
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900">
          Settings are HR/MD only.
        </h1>
        <p className="text-13 text-neutral-500 mt-2">
          Ask an administrator if you need a value changed.
        </p>
      </div>
    );
  }

  const setSection = (s: Section) => setParams({ section: s });
  // Users is account administration: Super Admin and Admin only.
  const isAdmin = session?.role.code === 'md' || session?.role.code === 'hr_admin';
  // Users and Data protection are account administration: Admins only.
  const sections = SECTIONS.filter((s) => (s.id !== 'users' && s.id !== 'data-protection') || isAdmin);
  const groups = Array.from(new Set(sections.map((s) => s.group)));

  return (
    <div className="m-page">
      <header>
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900">Settings</h1>
        <p className="text-13 text-neutral-500 mt-1">Organisation, time &amp; leave, finance and access — set once, used everywhere.</p>
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
            className="w-full h-9 px-3 text-13 bg-white text-neutral-900 border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60"
          >
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {sections.filter((x) => x.group === g).map((x) => (
                  <option key={x.id} value={x.id}>{x.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-0 md:mt-6 grid grid-cols-1 md:grid-cols-[240px_1fr] gap-6 items-start">
        <aside data-testid="settings-nav" className="hidden md:block dash-card p-3 md:sticky md:top-4">
          {groups.map((g) => (
            <div key={g} className="mb-3 last:mb-0">
              <div className="text-12 font-semibold text-neutral-500 px-3 mb-1 mt-1">{g}</div>
              {sections.filter((s) => s.group === g).map((s) => {
                const active = s.id === section;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSection(s.id)}
                    data-testid={`settings-nav-${s.id}`}
                    className={
                      'flex items-center gap-3 h-10 px-2 text-13 w-full text-left rounded-lg transition-colors ' +
                      (active
                        ? 'bg-[#f1edff] text-primary font-medium'
                        : 'text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900')
                    }
                  >
                    {/* A tinted icon square per item, coloured by group — as the Reports menu. */}
                    <span className="shrink-0 rounded-lg inline-flex items-center justify-center"
                      style={{ width: 28, height: 28, background: GROUP_TINT[s.group]?.bg ?? '#f1f5f9', color: GROUP_TINT[s.group]?.fg ?? '#475569' }} aria-hidden>
                      <s.icon size={14} strokeWidth={1.9} />
                    </span>
                    {s.label}
                  </button>
                );
              })}
            </div>
          ))}
        </aside>
        <main data-testid={`settings-section-${section}`} className="m-form min-w-0">
          {section === 'holidays' ? <HolidaysSection /> : null}
          {section === 'leave-types' ? <LeaveTypesSection /> : null}
          {section === 'expense-categories' ? <ExpenseCategoriesSection /> : null}
          {section === 'statutory-rates' ? <StatutoryRatesSection /> : null}
          {section === 'users' && isAdmin ? <UsersSection /> : null}
          {section === 'roles' ? <RolesSection /> : null}
          {section === 'data-protection' && isAdmin ? <DataProtectionSection /> : null}
        </main>
      </div>
    </div>
  );
}
