/**
 * Login and reference details a client holds for one registration — Private
 * Limited, LLP, Partnership Firm, MSME Udyam, Shops & Establishment, IEC, PF, ESI, E-Invoice, E-Way Bill. Entered
 * once per client; after that the card shows what is on file.
 *
 * The fields come from the server (`spec`), so each registration asks for
 * exactly its own details. The password follows the TDS card's rules: never
 * part of the cached record, fetched on Show / Copy (audited server-side),
 * dropped on Hide and after AUTO_HIDE_SECONDS. The parent keys this card by
 * client + registration, so no state carries across.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, ClipboardCopy, Eye, EyeOff, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { workstationApi } from '@/modules/workstation/api';
import {
  inMode, registrationCredentialsApi, requiredIn,
  type RegistrationCredential, type RegistrationMode, type RegistrationSpec,
} from '@/modules/registrationCredentials/api';
import type { ApiError } from '@/services/api';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { CredentialStatus } from '../tds/TdsCredentialsCard';

const AUTO_HIDE_SECONDS = 30;
const MASK = '•'.repeat(12);

const btn = 'inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-neutral-700 border border-neutral-200 rounded-md hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed';
const primaryBtn = 'inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-white bg-primary hover:bg-primaryHover rounded-md disabled:opacity-50 disabled:cursor-not-allowed';
const input = 'w-full h-9 px-3 text-13 bg-white border border-neutral-300 rounded-md focus:outline-none focus:border-gold';

export function RegistrationCredentialsCard({
  type, client,
}: {
  type: string;
  client: { id: string; company_name: string };
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['registration-credentials', type, client.id];
  const query = useQuery({ queryKey: key, queryFn: () => registrationCredentialsApi.get(type, client.id), retry: false });
  const spec = query.data?.spec ?? null;
  const record = query.data?.record ?? null;
  const { session } = useAuth();
  const canReveal = can(session?.role.code, 'workstation.registration.portal.reveal', 'self');

  const [mode, setMode] = useState<'view' | 'form' | 'confirm-delete'>('view');
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  useEffect(() => {
    if (shown === null) return;
    const t = setTimeout(() => setShown(null), AUTO_HIDE_SECONDS * 1000);
    return () => clearTimeout(t);
  }, [shown]);

  const title = spec ? `${spec.title} — Credentials` : 'Registration Credentials';

  const del = useMutation({
    mutationFn: () => registrationCredentialsApi.remove(type, client.id),
    onSuccess: () => {
      setShown(null); setMode('view');
      void qc.invalidateQueries({ queryKey: key });
      toast.push('success', 'Saved details deleted.');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  function flashCopied(which: string) {
    setCopied(which);
    setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
  }

  async function copyText(which: string, value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      flashCopied(which);
      toast.push('success', `${label} copied`);
    } catch {
      toast.push('error', 'Could not copy to clipboard.');
    }
  }

  async function copyPassword() {
    try {
      const value = shown ?? (await registrationCredentialsApi.reveal(type, client.id, 'copy')).value;
      await navigator.clipboard.writeText(value);
      flashCopied('password');
      toast.push('success', 'Password copied');
    } catch (e) {
      toast.push('error', (e as Error).message || 'Could not copy to clipboard.');
    }
  }

  async function toggleShow() {
    if (shown !== null) { setShown(null); return; }
    try {
      setShown((await registrationCredentialsApi.reveal(type, client.id, 'show')).value);
    } catch (e) {
      toast.push('error', (e as Error).message);
    }
  }

  if (query.isLoading) {
    return <Card title={title}><div className="text-13 text-neutral-500">Loading saved details…</div></Card>;
  }
  if (query.isError || !spec) {
    const status = (query.error as ApiError | null)?.status;
    return (
      <Card title={title}>
        <div className="text-13 text-neutral-500">
          {status === 403 ? 'You don’t have access to registration credentials.' : (query.error as Error | null)?.message ?? 'Could not load.'}
        </div>
      </Card>
    );
  }

  if (mode === 'form') {
    return (
      <Card title={title}>
        <CredentialForm
          type={type}
          spec={spec}
          client={client}
          existing={record}
          onCancel={() => setMode('view')}
          onSaved={(updated) => {
            setShown(null);
            setMode('view');
            void qc.invalidateQueries({ queryKey: key });
            toast.push('success', updated ? 'Details updated.' : 'Details saved for this client.');
          }}
        />
      </Card>
    );
  }

  if (!record) {
    return (
      <Card title={title} status={false}>
        <div className="text-13 text-neutral-600">
          No {spec.title} details saved for {client.company_name} yet. Save them once — next time they show here.
        </div>
        <button type="button" className={primaryBtn + ' mt-3'} onClick={() => setMode('form')}>
          <Plus size={14} strokeWidth={2} /> Add Details
        </button>
      </Card>
    );
  }

  const recMode = record.mode;
  const saved = spec.fields.filter((f) => inMode(f.modes, recMode) && record.fields[f.key]);
  // The login leads; what the first-time application needed stays folded.
  const visible = saved.filter((f) => f.group !== 'details');
  const details = saved.filter((f) => f.group === 'details');
  const showPassword = !!spec.password && inMode(spec.password.modes, recMode);
  const modeLabel = spec.modes?.find((m) => m.key === recMode)?.label;

  return (
    <Card title={title} status>
      {modeLabel ? (
        <div className="mb-3">
          <span className="inline-flex items-center h-6 px-2 text-11 font-medium rounded bg-neutral-100 text-neutral-700">{modeLabel}</span>
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {visible.map((f) => (
          <Field key={f.key} label={f.label} tall={f.kind === 'textarea'}>
            <span className={'flex-1 min-w-0 text-13 text-neutral-900 ' + (f.kind === 'textarea' ? 'whitespace-pre-wrap break-words py-2' : 'truncate') + (f.mono ? ' font-mono' : '')}>
              {record.fields[f.key]}
            </span>
            <button type="button" className={btn} onClick={() => copyText(f.key, record.fields[f.key], f.label)}>
              {copied === f.key ? <Check size={12} strokeWidth={2.5} /> : <ClipboardCopy size={12} strokeWidth={2} />}
              {copied === f.key ? 'Copied' : 'Copy'}
            </button>
          </Field>
        ))}
        {showPassword ? (
          <Field label={spec.password!.label}>
            <span className={'flex-1 min-w-0 text-13 font-mono truncate ' + (shown === null ? 'text-neutral-500 tracking-widest' : 'text-neutral-900')}>
              {record.password_present ? (shown ?? MASK) : <span className="tracking-normal font-sans text-neutral-400">Not saved yet</span>}
            </span>
            <button type="button" className={btn} onClick={toggleShow} disabled={!record.password_present} hidden={!canReveal}>
              {shown === null ? <Eye size={12} strokeWidth={2} /> : <EyeOff size={12} strokeWidth={2} />}
              {shown === null ? 'Show' : 'Hide'}
            </button>
            <button type="button" className={btn} onClick={copyPassword} disabled={!record.password_present} hidden={!canReveal}>
              {copied === 'password' ? <Check size={12} strokeWidth={2.5} /> : <ClipboardCopy size={12} strokeWidth={2} />}
              {copied === 'password' ? 'Copied' : 'Copy'}
            </button>
          </Field>
        ) : null}
      </div>

      {details.length > 0 ? (
        <div className="mt-4 border border-neutral-200 rounded-md">
          <button
            type="button"
            className="w-full flex items-center gap-1 h-9 px-3 text-12 font-medium text-neutral-700 hover:bg-neutral-50"
            onClick={() => setDetailsOpen((o) => !o)}
            aria-expanded={detailsOpen}
          >
            {detailsOpen ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
            Registration details ({details.length})
          </button>
          {detailsOpen ? (
            <div className="grid gap-4 md:grid-cols-2 p-3 pt-1">
              {details.map((f) => (
                <Field key={f.key} label={f.label} tall={f.kind === 'textarea'}>
                  <span className={'flex-1 min-w-0 text-13 text-neutral-900 ' + (f.kind === 'textarea' ? 'whitespace-pre-wrap break-words py-2' : 'truncate') + (f.mono ? ' font-mono' : '')}>
                    {record.fields[f.key]}
                  </span>
                  <button type="button" className={btn} onClick={() => copyText(f.key, record.fields[f.key], f.label)}>
                    {copied === f.key ? <Check size={12} strokeWidth={2.5} /> : <ClipboardCopy size={12} strokeWidth={2} />}
                    {copied === f.key ? 'Copied' : 'Copy'}
                  </button>
                </Field>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {mode === 'confirm-delete' ? (
        <div className="mt-4 p-3 border border-neutral-200 rounded-md bg-neutral-50">
          <div className="text-13 font-medium text-neutral-900">Delete saved details?</div>
          <div className="text-12 text-neutral-600 mt-1">This removes the saved {spec.title} details for this client.</div>
          <div className="flex gap-2 mt-3">
            <button type="button" className={btn} onClick={() => setMode('view')} disabled={del.isPending}>Cancel</button>
            <button
              type="button"
              className="inline-flex items-center gap-1 h-8 px-3 text-12 font-medium text-white bg-danger hover:opacity-90 rounded-md disabled:opacity-50"
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
            <Pencil size={12} strokeWidth={2} /> Edit Details
          </button>
          <button type="button" className={btn} onClick={() => setMode('confirm-delete')}>
            <Trash2 size={12} strokeWidth={2} /> Delete
          </button>
          {showPassword ? (
            <span className="text-11 text-neutral-500 ml-auto">
              Show and Copy are audit-logged. Password hides after {AUTO_HIDE_SECONDS}s.
            </span>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function CredentialForm({
  type, spec, client, existing, onCancel, onSaved,
}: {
  type: string;
  spec: RegistrationSpec;
  client: { id: string; company_name: string };
  existing: RegistrationCredential | null;
  onCancel: () => void;
  onSaved: (updated: boolean) => void;
}) {
  const editing = existing !== null;
  const [regMode, setRegMode] = useState<RegistrationMode | null>(existing?.mode ?? spec.modes?.[0]?.key ?? null);
  const [values, setValues] = useState<Record<string, string>>(existing?.fields ?? {});
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // First entry: fill what the client record already knows (GSTIN, contact).
  const detail = useQuery({
    queryKey: ['workstation', 'client', client.id],
    queryFn: () => workstationApi.getClient(client.id),
    enabled: !editing,
  });
  useEffect(() => {
    if (editing || !detail.data) return;
    const c = detail.data;
    const src: Record<string, string | null | undefined> = { gstin: c.gstin, contact_number: c.contact_number, email: c.email };
    setValues((v) => {
      const next = { ...v };
      for (const f of spec.fields) if (f.prefill && !next[f.key] && src[f.prefill]) next[f.key] = src[f.prefill]!;
      return next;
    });
  }, [editing, detail.data, spec.fields]);

  const fields = spec.fields.filter((f) => inMode(f.modes, regMode));
  const usesPassword = !!spec.password && inMode(spec.password.modes, regMode);
  const passwordRequired = usesPassword && !existing?.password_present && requiredIn(spec.password!.required, regMode);

  const save = useMutation({
    mutationFn: () => registrationCredentialsApi.save(type, client.id, {
      mode: regMode,
      fields: Object.fromEntries(fields.map((f) => [f.key, (values[f.key] ?? '').trim()])),
      ...(usesPassword && password ? { password } : {}),
    }),
    onSuccess: () => onSaved(editing),
    onError: (e: Error & { details?: unknown }) => {
      const d = (e.details ?? {}) as Record<string, string>;
      setErrors(Object.fromEntries(Object.entries(d).map(([k, v]) => [k.replace(/^fields\./, ''), v])));
      setError(e.message);
    },
  });

  const missing = fields.some((f) => requiredIn(f.required, regMode) && !(values[f.key] ?? '').trim())
    || (passwordRequired && !password);

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (!missing && !save.isPending) { setError(null); setErrors({}); save.mutate(); } }}
      className="space-y-3"
      autoComplete="off"
    >
      <div className="text-13 font-medium text-neutral-900">{editing ? 'Edit Details' : 'Add Details'}</div>
      <label className="block">
        <span className="block text-11 text-neutral-500 mb-1">Client</span>
        <input className={input + ' bg-neutral-50'} value={client.company_name} readOnly />
      </label>

      {spec.modes ? (
        <div>
          <div className="flex border border-neutral-200 rounded-md w-fit overflow-hidden">
            {spec.modes.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => { setRegMode(m.key); setErrors({}); }}
                className={`h-8 px-3 text-12 font-medium ${regMode === m.key ? 'bg-primary text-white' : 'bg-white text-neutral-700 hover:bg-neutral-50'}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className="text-11 text-neutral-500 mt-1">{spec.modes.find((m) => m.key === regMode)?.hint}</p>
        </div>
      ) : null}

      {fields.map((f, i) => {
        const req = requiredIn(f.required, regMode);
        const set = (v: string) => setValues((cur) => ({ ...cur, [f.key]: v }));
        const startsDetails = f.group === 'details' && fields[i - 1]?.group !== 'details';
        return (
          <div key={f.key}>
          {startsDetails ? (
            <div className="text-12 font-semibold text-neutral-700 pt-2 mb-2 border-t border-neutral-200">Registration details</div>
          ) : null}
          <label className="block">
            <span className="block text-11 text-neutral-500 mb-1">
              {f.label}{req ? <span className="text-danger"> *</span> : null}
            </span>
            {f.kind === 'select' ? (
              <select className={input} value={values[f.key] ?? ''} onChange={(e) => set(e.target.value)}>
                <option value="">Select…</option>
                {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.kind === 'textarea' ? (
              <textarea
                className={input + ' h-auto min-h-[72px] py-2'}
                value={values[f.key] ?? ''}
                onChange={(e) => set(e.target.value)}
                placeholder={f.placeholder}
                maxLength={500}
              />
            ) : (
              <input
                className={input + (f.mono || f.kind === 'gstin' ? ' font-mono' : '')}
                type={f.kind === 'email' ? 'email' : f.kind === 'phone' ? 'tel' : f.kind === 'date' ? 'date' : 'text'}
                value={values[f.key] ?? ''}
                onChange={(e) => set(f.kind === 'gstin' ? e.target.value.toUpperCase() : e.target.value)}
                placeholder={f.kind === 'date' ? undefined : f.placeholder ?? `Enter ${f.label}`}
                maxLength={f.kind === 'gstin' ? 15 : 200}
                autoComplete="off"
              />
            )}
            {errors[f.key] ? <span className="block text-12 text-danger mt-1">{errors[f.key]}</span> : null}
          </label>
          </div>
        );
      })}

      {usesPassword ? (
        <label className="block">
          <span className="block text-11 text-neutral-500 mb-1">
            {spec.password!.label}{passwordRequired ? <span className="text-danger"> *</span> : null}
          </span>
          <input
            type="password"
            className={input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={existing?.password_present ? 'Leave blank to keep the current password' : regMode === 'new' ? 'Enter once issued after registration' : 'Enter Password'}
            maxLength={200}
            autoComplete="new-password"
          />
          {errors.password ? <span className="block text-12 text-danger mt-1">{errors.password}</span> : null}
        </label>
      ) : null}

      {error && Object.keys(errors).length === 0 ? <div className="text-12 text-danger">{error}</div> : null}
      <div className="flex gap-2">
        <button type="button" className={btn} onClick={onCancel} disabled={save.isPending}>Cancel</button>
        <button type="submit" className={primaryBtn} disabled={missing || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save Details'}
        </button>
      </div>
    </form>
  );
}

function Card({ title, status, children }: { title: string; status?: boolean; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-neutral-200 rounded-lg shadow-card p-4" aria-label={title}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 text-14 font-semibold text-neutral-900">
          <KeyRound size={16} strokeWidth={1.75} className="text-neutral-500" />
          {title}
        </div>
        {status !== undefined ? <CredentialStatus configured={status} /> : null}
      </div>
      {children}
    </section>
  );
}

function Field({ label, tall = false, children }: { label: string; tall?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-11 text-neutral-500 mb-1">{label}</div>
      <div className={`flex items-center gap-2 ${tall ? 'min-h-10' : 'h-10'} px-3 border border-neutral-200 rounded-md bg-neutral-50`}>{children}</div>
    </div>
  );
}
