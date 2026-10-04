/**
 * Login on the employee profile. HR/MD set or reset the password here (blank
 * generates one); an employee with no login yet gets one, with a role. Only a
 * Super Admin sets a Super Admin's password — the server refuses it too.
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { employeeApi, type CreatedLogin } from './api';
import { LOGIN_ROLE_OPTIONS, LoginDetails } from './LoginDetails';

interface Props {
  employeeId: string;
  employeeName: string;
  role: { id: string; code: string; name: string } | null;
}

export function PasswordField({ employeeId, employeeName, role }: Props) {
  const { session } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [roleCode, setRoleCode] = useState('employee');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ login: CreatedLogin; created: boolean } | null>(null);

  const allowed =
    can(session?.role.code, 'employee.manage', 'organisation') &&
    (role?.code !== 'md' || session?.role.code === 'md');

  const save = useMutation({
    mutationFn: () => employeeApi.setPassword(employeeId, {
      password: password || undefined,
      role_code: role ? undefined : roleCode,
    }),
    onSuccess: (res) => {
      setOpen(false);
      setDone(res);
      qc.invalidateQueries({ queryKey: ['employee', employeeId] });
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!allowed) return null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password && password.length < 8) return setError('Password must be at least 8 characters.');
    save.mutate();
  };
  const reset = () => { setPassword(''); setRoleCode('employee'); setError(null); };
  const selectCls = 'h-8 px-2 text-13 bg-white border border-neutral-300 rounded w-full';

  return (
    <div>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Login</div>
      <button
        type="button"
        onClick={() => { reset(); setOpen(true); }}
        className="text-13 text-primary hover:underline mt-1"
        data-testid="employee-set-password"
      >
        {role ? 'Set password' : 'Create login'}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-40 grid place-items-center bg-neutral-900/30 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <form onSubmit={onSubmit} className="w-full max-w-[440px] bg-white border border-neutral-200 rounded shadow-drawer p-6 space-y-3">
            <h2 className="text-20 font-semibold text-neutral-900">{role ? 'Set password' : 'Create login'}</h2>
            <p className="text-13 text-neutral-500">
              {role
                ? `${employeeName}'s current password stops working once you save.`
                : `${employeeName} will sign in with their employee email.`}
            </p>
            <Input
              label="New password"
              type="text"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to generate one"
              data-testid="employee-password-input"
            />
            {!role ? (
              <label className="block">
                <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Login role</span>
                <select value={roleCode} onChange={(e) => setRoleCode(e.target.value)} className={selectCls}>
                  {LOGIN_ROLE_OPTIONS.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
                </select>
              </label>
            ) : null}
            {error ? <div className="text-12 text-red border-l-2 border-red pl-2">{error}</div> : null}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" type="button" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : role ? 'Set password' : 'Create login'}
              </Button>
            </div>
          </form>
        </div>
      ) : null}

      {done ? (
        <LoginDetails
          name={employeeName}
          login={done.login}
          title={done.created ? 'Login created' : 'Password set'}
          onDone={() => setDone(null)}
        />
      ) : null}
    </div>
  );
}
