/**
 * Roles + Permissions matrix, read-only.
 *
 * Editing the matrix at runtime is out of scope for this phase; the matrix
 * itself is defined in code (`platform/rbac/matrix.ts`). This view exists so
 * HR/MD can inspect who-can-do-what without spelunking the source.
 */
import { useQuery } from '@tanstack/react-query';
import { SectionShell } from './SectionShell';
import { settingsApi } from './api';
import type { RoleCode } from '@/data/models';

const SCOPE_SHORT: Record<'self' | 'department' | 'organisation', string> = {
  self: 'S',
  department: 'D',
  organisation: 'O',
};

export function RolesSection() {
  const q = useQuery({ queryKey: ['settings', 'roles'], queryFn: settingsApi.roles.get });

  if (q.isLoading) return <SectionShell title="Roles & permissions"><div className="h-40 bg-neutral-100" /></SectionShell>;
  if (!q.data) return <SectionShell title="Roles & permissions"><div className="text-13 text-neutral-500">Unavailable.</div></SectionShell>;

  const { roles, matrix } = q.data;
  // Union of all permission codes across roles for the column list.
  const permCodes = Array.from(
    new Set(Object.values(matrix).flatMap((grants) => grants.map((g) => g.permission))),
  ).sort();

  return (
    <SectionShell
      title="Roles & permissions"
      description="Read-only. The matrix is defined in code per §4/§5; runtime editing lands with the Permissions redesign."
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
                  const g = matrix[r.code as RoleCode]?.find((x) => x.permission === p);
                  return (
                    <td key={r.id} className="px-3 py-2 text-13 text-neutral-700">
                      {g ? SCOPE_SHORT[g.scope] : <span className="text-neutral-400">—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-11 text-neutral-500">
        Scope key: <span className="text-neutral-700">S</span> = self · <span className="text-neutral-700">D</span> = department · <span className="text-neutral-700">O</span> = organisation
      </div>
    </SectionShell>
  );
}
