/**
 * The employee's role (Super Admin … Intern). Settings managers get a
 * dropdown that saves on change; everyone else sees the role name. Nobody
 * changes their own role — the server refuses it too.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { employeeApi } from './api';
import { settingsApi } from '@/modules/settings/api';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { useToast } from '@/components/Toast';

interface Props {
  employeeId: string;
  role: { id: string; code: string; name: string } | null;
}

export function RoleField({ employeeId, role }: Props) {
  const { session } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const isSelf = session?.employee?.id === employeeId;
  const editable = !!role && !isSelf && can(session?.role.code, 'settings.manage', 'organisation');

  const roles = useQuery({
    queryKey: ['settings', 'role-modules'],
    queryFn: settingsApi.roles.modules,
    enabled: editable,
  });

  const save = useMutation({
    mutationFn: (roleId: string) => employeeApi.setRole(employeeId, roleId),
    onSuccess: (res) => {
      setError(null);
      toast.push('success', `Role changed to ${res.role.name}.`);
      qc.invalidateQueries({ queryKey: ['employee', employeeId] });
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Role</div>
      {editable ? (
        <select
          aria-label="Role"
          value={role.id}
          disabled={save.isPending || !roles.data}
          onChange={(e) => save.mutate(e.currentTarget.value)}
          className="mt-1 bg-white border border-neutral-200 rounded-lg h-8 px-2 text-13 text-neutral-900 focus:outline-none focus:border-primary/60"
        >
          {roles.data?.roles.some((r) => r.id === role.id) ? null : <option value={role.id}>{role.name}</option>}
          {(roles.data?.roles ?? []).map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
      ) : (
        <div className="text-13 text-neutral-900 mt-1">{role?.name ?? 'No login'}</div>
      )}
      {error ? <div className="text-12 text-red-700 mt-1">{error}</div> : null}
    </div>
  );
}
