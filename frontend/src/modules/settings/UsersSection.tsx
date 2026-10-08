import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionShell } from './SectionShell';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/platform/auth/AuthContext';
import { generatePassword, passwordProblem } from '@/platform/auth/password';
import { usersApi, type RoleOption, type UserRow } from '@/modules/users/api';

const KEY = ['settings', 'users'];

function fmt(iso: string | null) {
  return iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'Never';
}

/** Temporary password field with a Generate button. */
function TempPassword({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-end gap-2">
      <Input label="Temporary password" value={value} onChange={(e) => onChange(e.target.value)} required autoComplete="off" />
      <Button type="button" variant="ghost" onClick={() => onChange(generatePassword())}>Generate</Button>
    </div>
  );
}

function RoleSelect({ roles, value, onChange }: { roles: RoleOption[]; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-11 uppercase tracking-[0.06em] text-inkFaint mb-1">Role</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} required
        className="h-9 px-3 text-13 bg-white text-neutral-900 border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60">
        <option value="" disabled>Choose…</option>
        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
    </label>
  );
}

/** Shows a just-issued temporary password once, with Copy. */
function IssuedPassword({ email, password, onDone }: { email: string; password: string; onDone: () => void }) {
  const toast = useToast();
  return (
    <div className="dash-card p-4 space-y-2" role="status">
      <div className="text-13 text-ink">Temporary password for <b>{email}</b> — share it privately. They will choose their own at first sign-in.</div>
      <div className="flex items-center gap-2">
        <code className="px-3 py-1.5 rounded-lg bg-canvas text-14 font-mono text-ink select-all">{password}</code>
        <Button type="button" variant="ghost" onClick={async () => {
          try { await navigator.clipboard.writeText(password); toast.push('success', 'Copied.'); } catch { toast.push('error', 'Copy failed — select and copy it manually.'); }
        }}>Copy</Button>
        <Button type="button" variant="ghost" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

export function UsersSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const list = useQuery({ queryKey: KEY, queryFn: usersApi.list });
  const roles = useQuery({ queryKey: [...KEY, 'roles'], queryFn: usersApi.roles });
  const roleOptions = roles.data?.items ?? [];

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', joining_date: '', role_id: '', temp_password: '' });
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);
  const [resetFor, setResetFor] = useState<UserRow | null>(null);
  const [resetPw, setResetPw] = useState('');
  const [loginFor, setLoginFor] = useState<{ id: string; email: string } | null>(null);
  const [loginRole, setLoginRole] = useState('');
  const [loginPw, setLoginPw] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: KEY });
  const fail = (e: Error) => toast.push('error', e.message);
  const checkPw = (pw: string) => { const p = passwordProblem(pw); if (p) { toast.push('error', p); return false; } return true; };

  const create = useMutation({
    mutationFn: () => usersApi.create({
      ...form, phone: form.phone || undefined, joining_date: form.joining_date || undefined,
    }),
    onSuccess: (r) => {
      setIssued({ email: r.user.email, password: form.temp_password });
      setAdding(false);
      setForm({ first_name: '', last_name: '', email: '', phone: '', joining_date: '', role_id: '', temp_password: '' });
      refresh();
    },
    onError: fail,
  });
  const fromEmployee = useMutation({
    mutationFn: () => usersApi.createFromEmployee(loginFor!.id, { role_id: loginRole, temp_password: loginPw }),
    onSuccess: (r) => { setIssued({ email: r.user.email, password: loginPw }); setLoginFor(null); setLoginPw(''); setLoginRole(''); refresh(); },
    onError: fail,
  });
  const reset = useMutation({
    mutationFn: () => usersApi.resetPassword(resetFor!.id, resetPw),
    onSuccess: (r) => { setIssued({ email: r.user.email, password: resetPw }); setResetFor(null); setResetPw(''); refresh(); },
    onError: fail,
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { role_id?: string; is_active?: boolean } }) => usersApi.patch(id, body),
    onSuccess: () => { toast.push('success', 'User updated.'); refresh(); },
    onError: fail,
  });

  const users = list.data?.items ?? [];
  const noLogin = list.data?.employees_without_login ?? [];

  return (
    <SectionShell
      title="Users"
      description="Everyone who can sign in. Add a user to create their employee record and login together; they choose their own password at first sign-in."
      addLabel={adding ? undefined : 'Add user'}
      onAdd={adding ? undefined : () => { setAdding(true); setForm((f) => ({ ...f, temp_password: generatePassword() })); }}
    >
      {issued ? <IssuedPassword email={issued.email} password={issued.password} onDone={() => setIssued(null)} /> : null}

      {adding ? (
        <form
          onSubmit={(e: FormEvent) => { e.preventDefault(); if (checkPw(form.temp_password)) create.mutate(); }}
          className="dash-card p-4 grid grid-cols-1 md:grid-cols-2 gap-3"
          data-testid="add-user-form"
        >
          <Input label="First name" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} required />
          <Input label="Last name" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} required />
          <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <Input label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <Input label="Joining date" type="date" value={form.joining_date} onChange={(e) => setForm({ ...form, joining_date: e.target.value })} />
          <RoleSelect roles={roleOptions} value={form.role_id} onChange={(v) => setForm({ ...form, role_id: v })} />
          <TempPassword value={form.temp_password} onChange={(v) => setForm({ ...form, temp_password: v })} />
          <div className="flex items-end gap-2 md:col-span-2">
            <Button variant="primary" type="submit" disabled={create.isPending}>{create.isPending ? 'Adding…' : 'Add user'}</Button>
            <Button variant="ghost" type="button" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </form>
      ) : null}

      {resetFor ? (
        <form
          onSubmit={(e: FormEvent) => { e.preventDefault(); if (checkPw(resetPw)) reset.mutate(); }}
          className="dash-card p-4 flex items-end gap-3 flex-wrap"
        >
          <div className="text-13 text-ink w-full">Reset password for <b>{resetFor.full_name ?? resetFor.email}</b>. They’ll be signed out everywhere and must choose a new password.</div>
          <TempPassword value={resetPw} onChange={setResetPw} />
          <Button variant="primary" type="submit" disabled={reset.isPending}>Reset password</Button>
          <Button variant="ghost" type="button" onClick={() => setResetFor(null)}>Cancel</Button>
        </form>
      ) : null}

      <div className="bg-white border border-neutral-200 rounded overflow-x-auto">
        <table className="hr-float w-full border-collapse" data-testid="users-table">
          <thead>
            <tr>
              {['Name', 'Email', 'Role', 'Status', 'Last sign-in', 'Actions'].map((c) => (
                <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const self = u.id === session?.user.id;
              return (
                <tr key={u.id} className="border-b border-neutral-200">
                  <td className="px-3 py-2 text-13 text-neutral-900">{u.full_name ?? '—'}{u.must_change_password ? <span className="ml-2 text-11 text-[#b45309]">temporary password</span> : null}</td>
                  <td className="px-3 py-2 text-13 text-neutral-700">{u.email}</td>
                  <td className="px-3 py-2 text-13">
                    {self ? u.role.name : (
                      <select value={u.role.id} onChange={(e) => patch.mutate({ id: u.id, body: { role_id: e.target.value } })}
                        aria-label={`Role for ${u.email}`}
                        className="h-8 px-2 text-13 bg-white border border-neutral-200 rounded-lg">
                        {roleOptions.some((r) => r.id === u.role.id) ? null : <option value={u.role.id}>{u.role.name}</option>}
                        {roleOptions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="px-3 py-2 text-13">{u.is_active ? 'Active' : <span className="text-neutral-500">Inactive</span>}</td>
                  <td className="px-3 py-2 text-13 text-neutral-500">{fmt(u.last_login_at)}</td>
                  <td className="px-3 py-2 text-13">
                    {self ? <span className="text-neutral-400">You</span> : (
                      <div className="flex gap-2">
                        <Button size="sm" variant="ghost" onClick={() => { setResetFor(u); setResetPw(generatePassword()); }}>Reset password</Button>
                        <Button size="sm" variant="ghost" onClick={() => patch.mutate({ id: u.id, body: { is_active: !u.is_active } })}>
                          {u.is_active ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {noLogin.length > 0 ? (
        <div className="dash-card p-4 space-y-2">
          <h3 className="text-13 font-semibold text-ink">Employees without a login</h3>
          {noLogin.map((e) => (
            <div key={e.id} className="flex items-center justify-between gap-2 flex-wrap text-13">
              <span>{e.full_name} <span className="text-neutral-500">· {e.email}</span></span>
              {loginFor?.id === e.id ? (
                <form className="flex items-end gap-2 flex-wrap"
                  onSubmit={(ev: FormEvent) => { ev.preventDefault(); if (checkPw(loginPw)) fromEmployee.mutate(); }}>
                  <RoleSelect roles={roleOptions} value={loginRole} onChange={setLoginRole} />
                  <TempPassword value={loginPw} onChange={setLoginPw} />
                  <Button variant="primary" type="submit" disabled={fromEmployee.isPending}>Create login</Button>
                  <Button variant="ghost" type="button" onClick={() => setLoginFor(null)}>Cancel</Button>
                </form>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => { setLoginFor({ id: e.id, email: e.email }); setLoginPw(generatePassword()); }}>Create login</Button>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </SectionShell>
  );
}
