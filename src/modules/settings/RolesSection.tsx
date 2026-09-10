/**
 * Roles + Permissions matrix.
 *
 * The matrix rendered here is derived from the RolePermission rows the server
 * enforces, so what you see is what `can()` will check on the next request.
 * Each cell is a dropdown (—/S/D/O); a change PUTs the new scope and mutates
 * the DB row directly.
 *
 * Two lockout guards are enforced server-side and surfaced as inline errors:
 *   - The caller cannot remove `settings.manage` from their own role.
 *   - The last role holding `settings.manage` cannot lose it.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionShell } from './SectionShell';
import { settingsApi } from './api';
import type { RoleCode } from '@/data/models';
import type { Grant, Scope } from '@/platform/rbac/matrix';

const SCOPE_SHORT: Record<Scope, string> = {
  self: 'S',
  department: 'D',
  organisation: 'O',
};

type CellValue = Scope | '';

function cellValue(grants: Grant[] | undefined, permission: string): CellValue {
  return grants?.find((g) => g.permission === permission)?.scope ?? '';
}

export function RolesSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings', 'roles'], queryFn: settingsApi.roles.get });
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: ({ roleId, permission, scope }: { roleId: string; permission: string; scope: Scope | null }) =>
      settingsApi.roles.setGrant(roleId, permission, scope),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'roles'] }),
  });

  if (q.isLoading) return <SectionShell title="Roles & permissions"><div className="h-40 bg-neutral-100" /></SectionShell>;
  if (!q.data) return <SectionShell title="Roles & permissions"><div className="text-13 text-neutral-500">Unavailable.</div></SectionShell>;

  const { roles, matrix } = q.data;
  const permCodes = Array.from(
    new Set(Object.values(matrix).flatMap((grants) => grants.map((g) => g.permission))),
  ).sort();

  async function onChange(roleId: string, permission: string, next: CellValue) {
    const key = `${roleId}:${permission}`;
    setSavingKey(key);
    setErrorKey(null);
    setErrorMessage(null);
    try {
      await mutation.mutateAsync({ roleId, permission, scope: next === '' ? null : next });
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
      description="Edit a cell to change a role's scope for that permission. Dash means the role does not hold it."
    >
      <div className="bg-white border border-neutral-200 rounded overflow-x-auto">
        <table className="border-collapse tabular-nums">
          <thead>
            <tr>
              <th className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium sticky left-0 bg-white">
                Permission
              </th>
              {roles.map((r) => (
                <th
                  key={r.id}
                  className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium"
                >
                  {r.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {permCodes.map((p) => (
              <tr key={p} className="border-b border-neutral-200">
                <td className="px-3 py-2 text-13 text-neutral-900 sticky left-0 bg-white">{p}</td>
                {roles.map((r) => {
                  const key = `${r.id}:${p}`;
                  const value = cellValue(matrix[r.code as RoleCode], p);
                  const saving = savingKey === key;
                  const failed = errorKey === key;
                  return (
                    <td key={r.id} className="px-3 py-2 text-13">
                      <select
                        aria-label={`${r.name} — ${p}`}
                        value={value}
                        disabled={saving || mutation.isPending}
                        onChange={(e) => onChange(r.id, p, e.currentTarget.value as CellValue)}
                        className={`bg-white border rounded px-2 py-1 text-13 ${
                          failed ? 'border-red-400 text-red-700' : 'border-neutral-300 text-neutral-800'
                        } ${saving ? 'opacity-60' : ''}`}
                      >
                        <option value="">—</option>
                        <option value="self">S — self</option>
                        <option value="department">D — department</option>
                        <option value="organisation">O — organisation</option>
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
        Scope key: <span className="text-neutral-700">S</span> = self · <span className="text-neutral-700">D</span> = department · <span className="text-neutral-700">O</span> = organisation
      </div>
      <div className="text-11 text-neutral-400 flex gap-4">
        {(['self', 'department', 'organisation'] as Scope[]).map((s) => (
          <span key={s}>{SCOPE_SHORT[s]} = {s}</span>
        ))}
      </div>
    </SectionShell>
  );
}
