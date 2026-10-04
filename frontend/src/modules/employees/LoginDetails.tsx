/**
 * Login details shown once after an admin sets an employee's password (on
 * create or from the profile). The password can't be fetched again, so the
 * admin copies it here and hands it over.
 */
import { useState } from 'react';
import { Button } from '@/components/Button';
import type { CreatedLogin } from './api';

/** Roles a login can be given. Super Admin is never offered. */
export const LOGIN_ROLE_OPTIONS = [
  { code: 'employee', name: 'Associate' },
  { code: 'intern', name: 'Intern' },
  { code: 'dept_manager', name: 'Senior Associate' },
  { code: 'hr_admin', name: 'Admin' },
];

interface Props {
  name: string;
  login: CreatedLogin;
  title: string;
  onDone: () => void;
}

export function LoginDetails({ name, login, title, onDone }: Props) {
  const [copied, setCopied] = useState(false);
  const text = `Login for ${name}\nURL: ${window.location.origin}/login\nEmail: ${login.email}\nPassword: ${login.password}`;
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false));
  };
  const row = 'flex justify-between gap-4 py-2 border-b border-neutral-100 text-13';

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-40 grid place-items-center bg-neutral-900/30 p-4" data-testid="employee-login-details">
      <div className="w-full max-w-[540px] bg-white border border-neutral-200 rounded shadow-drawer p-6">
        <h2 className="text-20 font-semibold text-neutral-900">{title}</h2>
        <p className="text-13 text-neutral-500 mt-1">
          Share these details with {name}. The password is shown only once — copy it now.
        </p>
        <div className="mt-4">
          <div className={row}><span className="text-neutral-500">Email</span><span className="text-neutral-900">{login.email}</span></div>
          <div className={row}><span className="text-neutral-500">Role</span><span className="text-neutral-900">{login.role}</span></div>
          <div className={row}>
            <span className="text-neutral-500">Password{login.generated ? ' (generated)' : ''}</span>
            <code className="text-neutral-900 font-mono select-all" data-testid="employee-login-password">{login.password}</code>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="ghost" type="button" onClick={copy}>{copied ? 'Copied' : 'Copy details'}</Button>
          <Button variant="primary" type="button" onClick={onDone}>Done</Button>
        </div>
      </div>
    </div>
  );
}
