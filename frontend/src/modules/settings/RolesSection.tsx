/**
 * Roles + Permissions — one row per module (HRMS, Workstation, Tools,
 * Integrations), one column per role (Super Admin … Intern).
 *
 * Each cell is a dropdown: Full access grants every permission in the module
 * at organisation scope; No access removes them all. A role whose grants were
 * edited code by code reads back as "Custom" until a choice is made here.
 *
 * Two lockout guards are enforced server-side and surfaced as inline errors:
 *   - The caller cannot remove HRMS (it holds settings.manage) from their own role.
 *   - The last role holding settings.manage cannot lose it.
 *
 * Which role a person has is set on the employee (Edit → Role).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionShell } from './SectionShell';
import { settingsApi, type ModuleAccess, type ModuleCode } from './api';

/** The brand's navy header gradient (as on the register header strips). */
const NAVY = {
  background: 'linear-gradient(180deg, rgb(255 255 255 / 0.08), transparent 55%), linear-gradient(180deg, #3a3358 0%, #2d2944 100%)',
};

export function RolesSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'role-modules'], queryFn: settingsApi.roles.modules });
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: ({ roleId, module, access }: { roleId: string; module: ModuleCode; access: 'full' | 'none' }) =>
      settingsApi.roles.setModule(roleId, module, access),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'role-modules'] }),
  });

  if (q.isLoading) return <SectionShell title="Roles & permissions"><div className="dash-card h-40" /></SectionShell>;
  if (!q.data) return <SectionShell title="Roles & permissions"><div className="text-13 text-neutral-500">Unavailable.</div></SectionShell>;

  const { roles, modules } = q.data;

  async function onChange(roleId: string, module: ModuleCode, access: 'full' | 'none') {
    const key = `${roleId}:${module}`;
    setSavingKey(key);
    setErrorKey(null);
    setErrorMessage(null);
    try {
      await mutation.mutateAsync({ roleId, module, access });
    } catch (err) {
      setErrorKey(key);
      setErrorMessage(err instanceof Error ? err.message : 'Could not save the change.');
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <SectionShell
      title="Roles & permissions"
      description="Choose which modules each role can open. Change a person's role from their employee record (Edit → Role)."
    >
      <div className="dash-card overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="text-left text-11 uppercase tracking-[0.08em] text-white/90 px-4 h-10 font-medium sticky left-0 whitespace-nowrap" style={NAVY}>
                Permission
              </th>
              {roles.map((r) => (
                <th
                  key={r.id}
                  className="text-left text-11 uppercase tracking-[0.08em] text-white/90 px-3 h-10 font-medium whitespace-nowrap"
                  style={NAVY}
                >
                  {r.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modules.map((m) => (
              <tr key={m.code} className="border-b border-neutral-100 last:border-b-0 hover:bg-[#f9f8ff]">
                <td className="px-4 py-3 text-13 font-medium text-neutral-900 sticky left-0 bg-white whitespace-nowrap">{m.name}</td>
                {roles.map((r) => {
                  const key = `${r.id}:${m.code}`;
                  const value: ModuleAccess = r.modules[m.code];
                  const saving = savingKey === key;
                  const failed = errorKey === key;
                  return (
                    <td key={r.id} className="px-3 py-3 text-13 whitespace-nowrap">
                      <select
                        aria-label={`${r.name} — ${m.name}`}
                        value={value}
                        disabled={saving || mutation.isPending}
                        onChange={(e) => onChange(r.id, m.code, e.currentTarget.value as 'full' | 'none')}
                        // Inline so the phone layer's `min-width: 0` can't squeeze it;
                        // the matrix scrolls sideways inside its card instead.
                        style={{ minWidth: 116 }}
                        className={`bg-white border rounded-lg h-8 px-2 text-13 focus:outline-none focus:border-primary/60 ${
                          failed
                            ? 'border-red-400 text-red-700'
                            : value === 'full'
                              ? 'border-emerald-200 text-emerald-800'
                              : 'border-neutral-200 text-neutral-600'
                        } ${saving ? 'opacity-60' : ''}`}
                      >
                        {value === 'partial' ? <option value="partial" disabled>Custom</option> : null}
                        <option value="full">Full access</option>
                        <option value="none">No access</option>
                      </select>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {errorMessage ? (
        <div className="text-12 text-red-700" role="status">{errorMessage}</div>
      ) : null}
      <div className="text-11 text-neutral-500">
        Access changes take effect immediately; a person's menus update when they reload the page.
      </div>
    </SectionShell>
  );
}
