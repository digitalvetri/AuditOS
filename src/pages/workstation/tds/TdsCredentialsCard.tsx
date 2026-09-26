/**
 * TDS portal login credentials for the selected client — User ID (TAN) +
 * password, with Copy / Show / Edit / Delete.
 *
 * The password is never part of the cached record. Show and Copy each fetch
 * it from POST /reveal (audited server-side); a shown value lives only in
 * component state and is dropped on Hide, on client change, and after
 * AUTO_HIDE_SECONDS. The card is keyed by client id in the parent, so no
 * state can carry over from one client to another.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ClipboardCopy, Eye, EyeOff, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { tdsPortalApi } from '@/modules/tdsPortal/api';
import type { ApiError } from '@/services/api';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

const AUTO_HIDE_SECONDS = 30;
const MASK = '•'.repeat(12);

const btn = 'inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed';
const primaryBtn = 'inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-white bg-primary hover:bg-primaryHover rounded-md disabled:opacity-50 disabled:cursor-not-allowed';
const input = 'w-full h-9 px-3 text-13 bg-white border border-neutral-300 rounded-md focus:outline-none focus:border-gold';

export function TdsCredentialsCard({ client }: { client: { id: string; company_name: string; tan?: string | null } }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['tds-portal', client.id];
  const query = useQuery({ queryKey: key, queryFn: () => tdsPortalApi.get(client.id), retry: false });
  const record = query.data?.record ?? null;
  const { session } = useAuth();
  // Decrypting needs its own grant; without it the password stays masked.
  const canReveal = can(session?.role.code, 'workstation.tds.portal.reveal', 'self');

  const [mode, setMode] = useState<'view' | 'form' | 'confirm-delete'>('view');
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState<'user' | 'password' | null>(null);

  useEffect(() => {
    if (shown === null) return;
    const t = setTimeout(() => setShown(null), AUTO_HIDE_SECONDS * 1000);
    return () => clearTimeout(t);
  }, [shown]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['tds-portal', 'status'] });
  };

  const del = useMutation({
    mutationFn: () => tdsPortalApi.remove(client.id),
    onSuccess: () => { setShown(null); setMode('view'); refresh(); toast.push('success', 'TDS credentials deleted.'); },
    onError: (e: Error) => toast.push('error', e.message),
  });

  async function copy(which: 'user' | 'password') {
    try {
      const value = which === 'user' ? record!.user_id : shown ?? (await tdsPortalApi.reveal(client.id)).value;
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
      toast.push('success', which === 'user' ? 'User ID copied' : 'Password copied');
    } catch (e) {
      toast.push('error', (e as Error).message || 'Could not copy to clipboard.');
    }
  }

  async function toggleShow() {
    if (shown !== null) { setShown(null); return; }
    try {
      setShown((await tdsPortalApi.reveal(client.id)).value);
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  if (query.isLoading) {
    return <Card><div className="text-13 text-neutral-500">Loading TDS credentials…</div></Card>;
  }
  if (query.isError) {
    const status = (query.error as ApiError).status;
    return (
      <Card>
        <div className="text-13 text-neutral-500">
          {status === 403 ? 'You don’t have access to TDS portal credentials.' : (query.error as Error).message}
        </div>
      </Card>
    );
  }

  if (mode === 'form') {
    return (
      <Card>
        <CredentialForm
          client={client}
          existingUserId={record?.user_id ?? null}
          onCancel={() => setMode('view')}
          onSaved={(updated) => {
            setShown(null);
            setMode('view');
            refresh();
            toast.push('success', updated ? 'TDS credentials updated successfully.' : 'TDS credentials saved.');
          }}
        />
      </Card>
    );
  }

  if (!record) {
    return (
      <Card status={false}>
        <div className="text-13 text-neutral-600">TDS portal credentials have not been configured for this client.</div>
        <button type="button" className={primaryBtn + ' mt-3'} onClick={() => setMode('form')}>
          <Plus size={14} strokeWidth={2} /> Add TDS Credentials
        </button>
      </Card>
    );
  }

  return (
    <Card status>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="User ID (TAN)">
          <span className="flex-1 min-w-0 text-13 font-mono text-neutral-900 truncate">{record.user_id}</span>
          <button type="button" className={btn} onClick={() => copy('user')}>
            {copied === 'user' ? <Check size={12} strokeWidth={2.5} /> : <ClipboardCopy size={12} strokeWidth={2} />}
            {copied === 'user' ? 'Copied' : 'Copy'}
          </button>
        </Field>
        <Field label="Password">
          <span className={'flex-1 min-w-0 text-13 font-mono truncate ' + (shown === null ? 'text-neutral-500 tracking-widest' : 'text-neutral-900')}>
            {shown ?? MASK}
          </span>
          <button type="button" className={btn} onClick={toggleShow} disabled={!record.password_present} hidden={!canReveal}>
            {shown === null ? <Eye size={12} strokeWidth={2} /> : <EyeOff size={12} strokeWidth={2} />}
            {shown === null ? 'Show' : 'Hide'}
          </button>
          <button type="button" className={btn} onClick={() => copy('password')} disabled={!record.password_present} hidden={!canReveal}>
            {copied === 'password' ? <Check size={12} strokeWidth={2.5} /> : <ClipboardCopy size={12} strokeWidth={2} />}
            {copied === 'password' ? 'Copied' : 'Copy'}
          </button>
        </Field>
      </div>

      {mode === 'confirm-delete' ? (
        <div className="mt-4 p-3 border border-neutral-200 rounded-md bg-neutral-50">
          <div className="text-13 font-medium text-neutral-900">Delete TDS credentials?</div>
          <div className="text-12 text-neutral-600 mt-1">This will remove the saved TDS portal credentials for this client.</div>
          <div className="flex gap-2 mt-3">
            <button type="button" className={btn} onClick={() => setMode('view')} disabled={del.isPending}>Cancel</button>
            <button
              type="button"
              className="inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-white bg-red-600 hover:bg-red-700 rounded-md disabled:opacity-50"
              onClick={() => del.mutate()}
              disabled={del.isPending}
            >
              <Trash2 size={12} strokeWidth={2} /> Delete
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 mt-4">
          <button type="button" className={btn} onClick={() => setMode('form')}>
            <Pencil size={12} strokeWidth={2} /> Edit Credentials
          </button>
          <button type="button" className={btn} onClick={() => setMode('confirm-delete')}>
            <Trash2 size={12} strokeWidth={2} /> Delete
          </button>
          <span className="text-11 text-neutral-500 ml-auto">
            Show and Copy are audit-logged. Password hides after {AUTO_HIDE_SECONDS}s.
          </span>
        </div>
      )}
    </Card>
  );
}

function CredentialForm({
  client, existingUserId, onCancel, onSaved,
}: {
  client: { id: string; company_name: string; tan?: string | null };
  existingUserId: string | null;
  onCancel: () => void;
  onSaved: (updated: boolean) => void;
}) {
  const editing = existingUserId !== null;
  const [userId, setUserId] = useState(existingUserId ?? client.tan ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => tdsPortalApi.save(client.id, {
      user_id: userId.trim(),
      ...(password ? { password } : {}),
    }),
    onSuccess: () => onSaved(editing),
    onError: (e: Error) => setError(e.message),
  });

  const canSave = userId.trim().length > 0 && (editing || password.length > 0) && !save.isPending;

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (canSave) { setError(null); save.mutate(); } }}
      className="space-y-3"
      autoComplete="off"
    >
      <div className="text-13 font-medium text-neutral-900">{editing ? 'Edit TDS Credentials' : 'Add TDS Credentials'}</div>
      <label className="block">
        <span className="block text-11 text-neutral-500 mb-1">Client</span>
        <input className={input + ' bg-neutral-50'} value={client.company_name} readOnly />
      </label>
      <label className="block">
        <span className="block text-11 text-neutral-500 mb-1">User ID (TAN)</span>
        <input
          className={input + ' font-mono'}
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="Enter TAN / User ID"
          maxLength={100}
          autoComplete="off"
        />
      </label>
      <label className="block">
        <span className="block text-11 text-neutral-500 mb-1">Password</span>
        <input
          type="password"
          className={input}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={editing ? 'Leave blank to keep the current password' : 'Enter Password'}
          maxLength={200}
          autoComplete="new-password"
        />
      </label>
      {error ? <div className="text-12 text-red-600">{error}</div> : null}
      <div className="flex gap-2">
        <button type="button" className={btn} onClick={onCancel} disabled={save.isPending}>Cancel</button>
        <button type="submit" className={primaryBtn} disabled={!canSave}>
          {save.isPending ? 'Saving…' : 'Save Credentials'}
        </button>
      </div>
    </form>
  );
}

function Card({ status, children }: { status?: boolean; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-neutral-200 rounded-lg shadow-card p-4" aria-label="TDS portal login credentials">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 text-14 font-semibold text-neutral-900">
          <KeyRound size={16} strokeWidth={1.75} className="text-neutral-500" />
          TDS Portal Login Credentials
        </div>
        {status !== undefined ? <CredentialStatus configured={status} /> : null}
      </div>
      {children}
    </section>
  );
}

export function CredentialStatus({ configured }: { configured: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-12 text-neutral-700">
      <span
        className="inline-block w-2 h-2 rounded-full border"
        style={configured ? { backgroundColor: '#166534', borderColor: '#166534' } : { borderColor: '#94A3B8' }}
        aria-hidden
      />
      {configured ? 'Configured' : 'Not Configured'}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-11 text-neutral-500 mb-1">{label}</div>
      <div className="flex items-center gap-2 h-10 px-3 border border-neutral-200 rounded-md bg-neutral-50">{children}</div>
    </div>
  );
}
