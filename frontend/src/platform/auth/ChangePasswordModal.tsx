import { useState, type FormEvent } from 'react';
import { useAuth } from './AuthContext';
import { passwordProblem } from './password';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import type { ApiError } from '@/services/api';

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { changePassword } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(next) ?? (next !== confirm ? 'The two new passwords do not match.' : null);
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    try {
      await changePassword(current, next);
      toast.push('success', 'Password changed. Other devices have been signed out.');
      onClose();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="Change password">
      <form onSubmit={onSubmit} className="dash-card bg-surface w-full max-w-[400px] p-5 space-y-4">
        <h2 className="text-[18px] font-bold text-ink">Change password</h2>
        <Input label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        <Input label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        <Input label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        <p className="text-12 text-inkMuted">At least 8 characters, with letters and numbers.</p>
        {error ? <div className="text-12 text-red border-l-2 border-red pl-2">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Change password'}</Button>
        </div>
      </form>
    </div>
  );
}
