import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/platform/auth/AuthContext';
import { passwordProblem } from '@/platform/auth/password';
import { BrandLogo } from '@/components/BrandLogo';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';
import type { ApiError } from '@/services/api';

/**
 * Shown after signing in with a password an Admin issued. The API refuses
 * everything else until this succeeds, so this is the only screen that works.
 */
export function SetPasswordPage() {
  const { session, loading, changePassword, logout } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (loading) return null;
  if (!session) return <Navigate to="/login" replace />;
  if (!session.must_change_password) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(next) ?? (next !== confirm ? 'The two new passwords do not match.' : null);
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    try {
      await changePassword(current, next);
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-canvas p-4">
      <form onSubmit={onSubmit} className="dash-card w-full max-w-[420px] p-6 space-y-4" data-testid="set-password">
        <BrandLogo src="/jns-logo-tight.png" alt="JNS Accounting Solutions" className="h-12" />
        <div>
          <h1 className="text-[22px] font-extrabold text-ink">Set your new password</h1>
          <p className="text-13 text-inkMuted mt-1">
            You signed in with a temporary password. Choose your own to continue — at least 8 characters, with letters and numbers.
          </p>
        </div>
        <Input label="Temporary password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        <Input label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        <Input label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        {error ? <div className="text-12 text-red border-l-2 border-red pl-2">{error}</div> : null}
        <Button variant="primary" type="submit" disabled={saving} className="w-full">{saving ? 'Saving…' : 'Save and continue'}</Button>
        <button type="button" onClick={async () => { await logout(); navigate('/login', { replace: true }); }} className="w-full text-13 text-inkMuted hover:text-ink">
          Sign out
        </button>
      </form>
    </div>
  );
}
