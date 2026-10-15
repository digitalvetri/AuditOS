/**
 * Roles + Permissions — one column per role (Super Admin … Intern), one row
 * per module (HRMS, Workstation, Tools, Integrations) that expands into its
 * SECTIONS (Employees, Attendance, Tasks, each tool…).
 *
 * Each section cell is a dropdown of the levels that section offers: No
 * access, Own records (HRMS personal sections), View, Full access — some with
 * their own words ("Allowed" for a tool, "All clients" for client
 * visibility). A role whose rows match no level reads back as "Custom".
 *
 * The module cell is a shortcut: Full access sets every section in it to its
 * top level, No access clears them; a mix reads "Custom".
 *
 * Two lockout guards are enforced server-side and surfaced as inline errors:
 *   - The caller cannot remove Settings from their own role.
 *   - The last role holding Settings cannot lose it.
 *
 * Which role a person has is set on the employee (Edit → Role).
 */
import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Search } from 'lucide-react';
import { SectionShell } from './SectionShell';
import { settingsApi, type ModuleAccess, type ModuleCode, type RoleSection, type SectionLevel } from './api';

/** The brand's navy header gradient (as on the register header strips). */
const NAVY = {
  background: 'linear-gradient(180deg, rgb(255 255 255 / 0.08), transparent 55%), linear-gradient(180deg, #3a3358 0%, #2d2944 100%)',
};

/** Border/text tint per level, so a column reads at a glance. */
function tint(value: string, failed: boolean): string {
  if (failed) return 'border-red-400 text-red-700';
  if (value === 'full') return 'border-emerald-200 text-emerald-800';
  if (value === 'view') return 'border-sky-200 text-sky-800';
  if (value === 'own') return 'border-amber-200 text-amber-800';
  if (value === 'custom' || value === 'partial') return 'border-violet-200 text-violet-800';
  return 'border-neutral-200 text-neutral-600';
}

const count = (n: number) => `${n} ${n === 1 ? 'section' : 'sections'}`;

const SELECT = 'bg-white border rounded-lg h-8 px-2 text-13 focus:outline-none focus:border-primary/60';

export function RolesSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'role-modules'], queryFn: settingsApi.roles.modules });
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<ModuleCode>>(new Set());
  const [query, setQuery] = useState('');

  const mutation = useMutation({
    mutationFn: async (v: { roleId: string; module: ModuleCode; access: 'full' | 'none' } | { roleId: string; section: string; level: SectionLevel }): Promise<unknown> =>
      'section' in v ? settingsApi.roles.setSection(v.roleId, v.section, v.level) : settingsApi.roles.setModule(v.roleId, v.module, v.access),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'role-modules'] }),
  });

  // Sections per module, in catalogue order, filtered by the search box.
  const byModule = useMemo(() => {
    const m = new Map<ModuleCode, RoleSection[]>();
    const needle = query.trim().toLowerCase();
    for (const s of q.data?.sections ?? []) {
      if (needle && !`${s.name} ${s.group ?? ''}`.toLowerCase().includes(needle)) continue;
      m.set(s.module, [...(m.get(s.module) ?? []), s]);
    }
    return m;
  }, [q.data, query]);

  if (q.isLoading) return <SectionShell title="Roles & permissions"><div className="dash-card h-40" /></SectionShell>;
  if (!q.data) return <SectionShell title="Roles & permissions"><div className="text-13 text-neutral-500">Unavailable.</div></SectionShell>;

  const { roles, modules } = q.data;
  const searching = query.trim() !== '';
  const allOpen = modules.every((m) => open.has(m.code));

  async function save(key: string, v: Parameters<typeof mutation.mutateAsync>[0]) {
    setSavingKey(key);
    setErrorKey(null);
    setErrorMessage(null);
    try {
      await mutation.mutateAsync(v);
    } catch (err) {
      setErrorKey(key);
      setErrorMessage(err instanceof Error ? err.message : 'Could not save the change.');
    } finally {
      setSavingKey(null);
    }
  }

  const toggle = (code: ModuleCode) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  return (
    <SectionShell
      title="Roles & permissions"
      description="Choose what each role can open, section by section. Expand a module to set its sections. Change a person's role from their employee record (Edit → Role)."
    >
      <div className="flex items-center gap-2 flex-wrap">
        <label className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Find a section — e.g. attendance, invoices, GSTR-2B"
            aria-label="Find a section"
            className="w-full bg-white border border-neutral-200 rounded-lg h-9 pl-8 pr-3 text-13 focus:outline-none focus:border-primary/60"
          />
        </label>
        <button
          type="button"
          onClick={() => setOpen(allOpen ? new Set() : new Set(modules.map((m) => m.code)))}
          className="h-9 px-3 rounded-lg border border-neutral-200 bg-white text-13 text-neutral-700 hover:bg-neutral-50"
        >
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      <div className="dash-card overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="text-left text-11 uppercase tracking-[0.08em] text-white/90 px-4 h-10 font-medium sticky left-0 z-10 whitespace-nowrap" style={NAVY}>
                Permission
              </th>
              {roles.map((r) => (
                <th key={r.id} className="text-left text-11 uppercase tracking-[0.08em] text-white/90 px-3 h-10 font-medium whitespace-nowrap" style={NAVY}>
                  {r.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modules.map((m) => {
              const sections = byModule.get(m.code) ?? [];
              if (searching && !sections.length) return null;
              const expanded = searching || open.has(m.code);
              let lastGroup: string | null = null;
              return (
                <Fragment key={m.code}>
                  <tr className="border-b border-neutral-100 bg-neutral-50/60">
                    <td className="px-2 py-3 text-13 font-semibold text-neutral-900 sticky left-0 bg-[#faf9fd] whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => toggle(m.code)}
                        aria-expanded={expanded}
                        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-neutral-100"
                      >
                        <ChevronRight size={15} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden />
                        {m.name}
                        <span style={{ marginLeft: 6 }} className="text-11 font-normal text-neutral-500">{count(q.data.sections.filter((s) => s.module === m.code).length)}</span>
                      </button>
                    </td>
                    {roles.map((r) => {
                      const key = `${r.id}:${m.code}`;
                      const value: ModuleAccess = r.modules[m.code];
                      return (
                        <td key={r.id} className="px-3 py-3 text-13 whitespace-nowrap">
                          <select
                            aria-label={`${r.name} — ${m.name}`}
                            value={value}
                            disabled={savingKey === key || mutation.isPending}
                            onChange={(e) => save(key, { roleId: r.id, module: m.code, access: e.currentTarget.value as 'full' | 'none' })}
                            // Inline so the phone layer's `min-width: 0` can't squeeze it;
                            // the matrix scrolls sideways inside its card instead.
                            style={{ minWidth: 132 }}
                            className={`${SELECT} font-medium ${tint(value, errorKey === key)} ${savingKey === key ? 'opacity-60' : ''}`}
                          >
                            {value === 'partial' ? <option value="partial" disabled>Custom</option> : null}
                            <option value="full">Full access</option>
                            <option value="none">No access</option>
                          </select>
                        </td>
                      );
                    })}
                  </tr>
                  {expanded ? sections.map((s) => {
                    const heading = s.group && s.group !== lastGroup ? s.group : null;
                    lastGroup = s.group;
                    return (
                      <Fragment key={s.code}>
                        {heading ? (
                          <tr>
                            <td colSpan={roles.length + 1} className="pl-11 pt-3 pb-1 text-11 uppercase tracking-[0.08em] text-neutral-500 sticky left-0">
                              {heading}
                            </td>
                          </tr>
                        ) : null}
                        <tr className="border-b border-neutral-100 last:border-b-0 hover:bg-[#f9f8ff]">
                          <td className="pl-11 pr-4 py-2 text-13 text-neutral-800 sticky left-0 bg-white whitespace-nowrap">{s.name}</td>
                          {roles.map((r) => {
                            const key = `${r.id}:${s.code}`;
                            const value = r.sections[s.code] ?? 'none';
                            return (
                              <td key={r.id} className="px-3 py-2 text-13 whitespace-nowrap">
                                <select
                                  aria-label={`${r.name} — ${m.name} — ${s.name}`}
                                  value={value}
                                  disabled={savingKey === key || mutation.isPending}
                                  onChange={(e) => save(key, { roleId: r.id, section: s.code, level: e.currentTarget.value as SectionLevel })}
                                  style={{ minWidth: 132 }}
                                  className={`${SELECT} ${tint(value, errorKey === key)} ${savingKey === key ? 'opacity-60' : ''}`}
                                >
                                  {value === 'custom' ? <option value="custom" disabled>Custom</option> : null}
                                  {s.levels.map((l) => <option key={l.level} value={l.level}>{l.label}</option>)}
                                </select>
                              </td>
                            );
                          })}
                        </tr>
                      </Fragment>
                    );
                  }) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {errorMessage ? (
        <div className="text-12 text-red-700" role="status">{errorMessage}</div>
      ) : null}
      <div className="text-11 text-neutral-500 space-y-0.5">
        <div><strong className="font-medium">Own records</strong>: only the person's own attendance, leave, payslips, claims or documents. <strong className="font-medium">View</strong>: everyone's, read-only. <strong className="font-medium">Full access</strong>: view and change.</div>
        <div>Client visibility decides whether Workstation shows all clients or only the ones a person is assigned to.</div>
        <div>Access changes take effect immediately; a person's menus update when they reload the page.</div>
      </div>
    </SectionShell>
  );
}
