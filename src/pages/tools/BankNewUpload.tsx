import { useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Upload, Eye, EyeOff, Search, Plus, X, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { workstationApi } from '@/modules/workstation/api';
import type { ClientListItem } from '@/modules/workstation/types';
import { auditAutomationApi, type AaAccount, type AaBank } from '@/modules/tools/audit-automation/api';
import type { ApiError } from '@/services/api';

/**
 * /audit-automation/bank/new — the AMENDMENT-02 §3 wireframe.
 *
 * Validation order matches §3:
 *   Client + FY → Bank → Account → File → Password → Process
 *
 * All server-side validation runs before an AaJob is created (upload
 * pre-flight in AaUploadService). This page maps the API's typed error
 * codes to specific inline messages so the auditor sees why an upload
 * was refused, not "something went wrong".
 */
export function BankNewUploadPage() {
  const nav = useNavigate();
  const toast = useToast();

  const [clientId, setClientId] = useState<string>('');
  const [fy, setFy] = useState<string>(currentFyLabel());
  const [bankKey, setBankKey] = useState<string>('');
  const [bankQuery, setBankQuery] = useState<string>('');
  const [accountId, setAccountId] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState<string>('');
  const [showPwd, setShowPwd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<{ code: string; message: string; details?: unknown } | null>(null);
  const [mismatchState, setMismatchState] = useState<null | { message: string }>(null);
  const [showAddAccount, setShowAddAccount] = useState(false);

  const clientsQ = useQuery({
    queryKey: ['workstation.clients.for-aa'],
    queryFn: () => workstationApi.listClients(),
  });
  const banksQ = useQuery({
    queryKey: ['aa.banks'],
    queryFn: () => auditAutomationApi.banks(),
  });
  const accountsQ = useQuery({
    queryKey: ['aa.accounts', clientId, bankKey],
    enabled: Boolean(clientId && bankKey),
    queryFn: async () => {
      const banks = banksQ.data?.items ?? [];
      const bank = banks.find((b) => b.key === bankKey);
      if (!bank) return { items: [], count: 0 };
      return auditAutomationApi.accounts(clientId, bank.id);
    },
  });

  const filteredBanks = useMemo(() => {
    const list = banksQ.data?.items ?? [];
    const q = bankQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter((b) => b.name.toLowerCase().includes(q) || b.key.includes(q));
  }, [banksQ.data, bankQuery]);

  const selectedBank = banksQ.data?.items.find((b) => b.key === bankKey) ?? null;

  const canSubmit = Boolean(clientId && bankKey && accountId && file) && !submitting;

  async function submit(e: FormEvent, opts?: { overrideMismatch?: boolean }) {
    e.preventDefault();
    if (!canSubmit || !file) return;
    setSubmitting(true);
    setError(null);
    setProgress(0);
    try {
      const result = await auditAutomationApi.upload(
        { clientId, bankKey, bankAccountId: accountId, file, password: password || undefined, overrideAdapterMismatch: opts?.overrideMismatch },
        (pct) => setProgress(pct),
      );
      toast.push('success', `Statement queued — ${result.page_count} pages.`);
      nav(`/audit-automation/bank/jobs/${result.job.id}`);
    } catch (err) {
      const e = err as ApiError;
      const details = (e as unknown as { details?: unknown }).details;
      if (e.code === 'adapter_mismatch' && selectedBank) {
        setMismatchState({ message: `This does not look like a ${selectedBank.name} statement. Continue anyway, or choose a different bank?` });
        setError(null);
      } else if (e.code === 'duplicate_upload') {
        const jobId = (details as { existing_job_id?: string } | undefined)?.existing_job_id;
        setError({
          code: e.code,
          message: 'This statement is already uploaded for this client.',
          details: jobId ? { jobId } : undefined,
        });
      } else {
        setError({ code: e.code, message: e.message, details });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-[900px] mx-auto" data-testid="aa-bank-new">
      <div className="mb-4">
        <Link to="/audit-automation/bank" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> Bank statements
        </Link>
      </div>

      <header className="mb-5">
        <h1 className="text-20 font-semibold text-neutral-900">New bank statement</h1>
        <p className="text-13 text-neutral-500 mt-1">Upload a bank-generated PDF, exactly as the bank sent it.</p>
      </header>

      <form onSubmit={submit} className="bg-white border border-neutral-200 rounded p-5 md:p-6 space-y-6">
        {/* Client + FY ─────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-[1fr_180px] gap-4">
          <Field label="Client" required>
            <select
              value={clientId}
              onChange={(e) => { setClientId(e.target.value); setAccountId(''); }}
              className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
              data-testid="aa-client-select"
            >
              <option value="">Select client…</option>
              {(clientsQ.data?.items ?? []).map((c: ClientListItem) => (
                <option key={c.id} value={c.id}>
                  {c.company_name} · {c.client_id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Financial Year">
            <select
              value={fy}
              onChange={(e) => setFy(e.target.value)}
              className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
            >
              {fyOptions().map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </Field>
        </div>

        {/* Bank ────────────────────────────────────────────────────────── */}
        <div>
          <div className="text-13 font-medium text-neutral-900 mb-2">
            <span className="text-neutral-400 text-11 mr-1.5">1.</span>Bank <span className="text-danger">*</span>
          </div>
          <label className="relative block max-w-[420px] mb-3">
            <span className="absolute inset-y-0 left-2 flex items-center text-neutral-400"><Search size={14} strokeWidth={1.75} /></span>
            <input
              type="search"
              value={bankQuery}
              onChange={(e) => setBankQuery(e.target.value)}
              placeholder="Search banks…"
              className="h-8 w-full pl-7 pr-3 text-13 bg-white border border-neutral-300 rounded focus:outline-none focus:border-gold"
              data-testid="aa-bank-search"
            />
          </label>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Bank">
            {filteredBanks.map((b) => (
              <button
                type="button"
                key={b.id}
                role="radio"
                aria-checked={bankKey === b.key}
                onClick={() => { setBankKey(b.key); setAccountId(''); setMismatchState(null); }}
                className={
                  'h-8 px-3 text-13 rounded border transition-colors ' +
                  (bankKey === b.key
                    ? 'border-primary bg-primary text-white'
                    : b.key === 'generic'
                      ? 'border-dashed border-neutral-300 text-neutral-600 hover:border-neutral-500'
                      : 'border-neutral-300 bg-white text-neutral-900 hover:border-neutral-400')
                }
                data-testid={`aa-bank-${b.key}`}
              >
                {b.name}
                {b.key === 'generic' ? <span className="text-11 text-neutral-400 ml-1">· reduced accuracy</span> : null}
              </button>
            ))}
            {filteredBanks.length === 0 ? (
              <span className="text-13 text-neutral-500">No banks match “{bankQuery.trim()}”.</span>
            ) : null}
          </div>
        </div>

        {/* Account ─────────────────────────────────────────────────────── */}
        <div>
          <div className="text-13 font-medium text-neutral-900 mb-2">
            <span className="text-neutral-400 text-11 mr-1.5">2.</span>Account <span className="text-danger">*</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              disabled={!clientId || !bankKey}
              className="h-9 min-w-[280px] px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold disabled:bg-neutral-50 disabled:text-neutral-400"
              data-testid="aa-account-select"
            >
              <option value="">
                {!clientId || !bankKey
                  ? 'Select a client and bank first'
                  : accountsQ.isLoading
                    ? 'Loading accounts…'
                    : (accountsQ.data?.items.length ?? 0) === 0
                      ? 'No accounts — add one →'
                      : 'Select account…'}
              </option>
              {(accountsQ.data?.items ?? []).map((a: AaAccount) => (
                <option key={a.id} value={a.id}>{a.account_number_masked}{a.label ? ` — ${a.label}` : ''}</option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setShowAddAccount(true)}
              disabled={!clientId || !bankKey}
            >
              <Plus size={14} strokeWidth={1.75} className="mr-1" /> Add account
            </Button>
          </div>
        </div>

        {/* File ───────────────────────────────────────────────────────── */}
        <div>
          <div className="text-13 font-medium text-neutral-900 mb-2">
            <span className="text-neutral-400 text-11 mr-1.5">3.</span>Statement <span className="text-danger">*</span>
          </div>
          {file ? (
            <SelectedFile file={file} onRemove={() => setFile(null)} />
          ) : (
            <Dropzone onFile={setFile} />
          )}
          <ul className="text-12 text-neutral-500 mt-2 space-y-0.5">
            <li>· Do not remove any pages</li>
            <li>· Do not remove the password</li>
            <li>· Scanned copies cannot be processed</li>
          </ul>
        </div>

        {/* Password ────────────────────────────────────────────────────── */}
        <div>
          <div className="text-13 font-medium text-neutral-900 mb-1">
            <span className="text-neutral-400 text-11 mr-1.5">4.</span>Password <span className="text-neutral-500 font-normal">(if protected)</span>
          </div>
          <label className="relative block max-w-[420px]">
            <input
              type={showPwd ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              className="h-9 w-full pl-3 pr-9 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold font-mono tracking-wider"
              placeholder="••••••••"
              data-testid="aa-password"
            />
            <button
              type="button"
              onClick={() => setShowPwd((v) => !v)}
              aria-label={showPwd ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-2 flex items-center text-neutral-400 hover:text-neutral-700"
            >
              {showPwd ? <EyeOff size={14} strokeWidth={1.75} /> : <Eye size={14} strokeWidth={1.75} />}
            </button>
          </label>
          <p className="text-12 text-neutral-500 mt-1">Used once to open the file. Never stored.</p>
        </div>

        {/* Error region ─────────────────────────────────────────────────── */}
        {error ? (
          <ErrorNotice code={error.code} message={error.message} details={error.details}
            onRetryPassword={() => document.querySelector<HTMLInputElement>('[data-testid=aa-password]')?.focus()}
          />
        ) : null}

        {mismatchState ? (
          <MismatchNotice
            message={mismatchState.message}
            onContinue={(e) => { setMismatchState(null); submit(e as unknown as FormEvent, { overrideMismatch: true }); }}
            onCancel={() => setMismatchState(null)}
          />
        ) : null}

        {/* Progress + submit ────────────────────────────────────────────── */}
        {submitting ? (
          <div className="h-1.5 bg-neutral-100 rounded overflow-hidden" aria-label="Upload progress">
            <div className="h-full bg-gold transition-all" style={{ width: `${progress}%` }} />
          </div>
        ) : null}

        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {submitting ? `Uploading… ${progress}%` : 'Process statement'}
          </Button>
        </div>
      </form>

      {showAddAccount && clientId && selectedBank ? (
        <AddAccountModal
          clientId={clientId}
          bank={selectedBank}
          onClose={() => setShowAddAccount(false)}
          onCreated={(a) => { setShowAddAccount(false); setAccountId(a.id); accountsQ.refetch(); }}
        />
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-13 font-medium text-neutral-900 mb-1">{label} {required ? <span className="text-danger">*</span> : null}</span>
      {children}
    </label>
  );
}

function Dropzone({ onFile }: { onFile: (f: File) => void }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = Array.from(e.dataTransfer.files).find((x) => x.type === 'application/pdf' || x.name.toLowerCase().endsWith('.pdf'));
    if (f) onFile(f);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={
        'w-full rounded border border-dashed text-center px-4 py-6 cursor-pointer transition-colors ' +
        (over ? 'border-gold bg-neutral-50' : 'border-neutral-300 bg-white hover:bg-neutral-50')
      }
      data-testid="aa-dropzone"
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }}
      />
      <Upload size={22} strokeWidth={1.5} className="text-neutral-400 mx-auto mb-2" />
      <div className="text-13 text-neutral-900">
        Drop the PDF here, or <span className="text-gold font-medium">browse</span>
      </div>
      <div className="text-12 text-neutral-500 mt-1">Supported: PDF · max 25 MB</div>
    </div>
  );
}

function SelectedFile({ file, onRemove }: { file: File; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-3 bg-neutral-50 border border-neutral-200 rounded px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-13 text-neutral-900 truncate">{file.name}</div>
        <div className="text-12 text-neutral-500">{(file.size / 1024).toFixed(0)} KB</div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove file"
        className="text-neutral-400 hover:text-neutral-700"
      >
        <X size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
}

function ErrorNotice({ code, message, details, onRetryPassword }: {
  code: string; message: string; details?: unknown; onRetryPassword: () => void;
}) {
  const jobLink = code === 'duplicate_upload' && details && typeof details === 'object' && 'jobId' in details
    ? String((details as { jobId?: unknown }).jobId ?? '')
    : '';
  return (
    <div className="border-l-2 border-danger bg-canvas px-3 py-2 text-13" data-testid={`aa-error-${code}`}>
      <div className="text-neutral-900 font-medium">
        {code === 'wrong_password' ? 'Incorrect statement password' : code === 'password_required' ? 'Password required' : humanCode(code)}
      </div>
      <div className="text-neutral-500 mt-0.5">{message}</div>
      {code === 'wrong_password' || code === 'password_required' ? (
        <button type="button" onClick={onRetryPassword} className="text-12 text-gold mt-1 font-medium">
          Enter password →
        </button>
      ) : null}
      {jobLink ? (
        <Link to={`/audit-automation/bank/jobs/${jobLink}`} className="text-12 text-gold mt-1 font-medium inline-block">
          View existing job →
        </Link>
      ) : null}
    </div>
  );
}

function MismatchNotice({ message, onContinue, onCancel }: {
  message: string; onContinue: (e: React.MouseEvent) => void; onCancel: () => void;
}) {
  return (
    <div className="border-l-2 border-amber-500 bg-amber-50 px-3 py-2 text-13" data-testid="aa-error-adapter_mismatch">
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} strokeWidth={1.75} className="text-amber-700 mt-0.5" />
        <div className="flex-1">
          <div className="text-neutral-900 font-medium">Format mismatch</div>
          <div className="text-neutral-700 mt-0.5">{message}</div>
          <div className="flex gap-2 mt-2">
            <Button type="button" size="sm" variant="primary" onClick={onContinue as unknown as React.MouseEventHandler<HTMLButtonElement>}>
              Continue anyway
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={onCancel}>Choose different bank</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddAccountModal({ clientId, bank, onClose, onCreated }: {
  clientId: string;
  bank: AaBank;
  onClose: () => void;
  onCreated: (a: AaAccount) => void;
}) {
  const [masked, setMasked] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setErr(null);
    try {
      const a = await auditAutomationApi.createAccount({
        client_id: clientId,
        bank_id: bank.id,
        account_number_masked: masked.trim(),
        label: label.trim() || null,
      });
      toast.push('success', 'Account added.');
      onCreated(a);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={save} className="bg-white rounded shadow-lg w-full max-w-[420px]">
        <div className="px-5 py-3 border-b border-neutral-200 flex items-center justify-between">
          <h2 className="text-14 font-semibold text-neutral-900">Add account · {bank.name}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-neutral-400 hover:text-neutral-700">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <Field label="Account number (masked)" required>
            <input
              value={masked}
              onChange={(e) => setMasked(e.target.value)}
              placeholder="•••4471"
              className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold font-mono"
            />
            <span className="block text-11 text-neutral-500 mt-1">
              Only masked digits — the full number is not stored.
            </span>
          </Field>
          <Field label="Label (optional)">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Current — Payroll"
              className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
            />
          </Field>
          {err ? <div className="text-13 text-danger">{err}</div> : null}
        </div>
        <div className="px-5 py-3 border-t border-neutral-200 flex justify-end gap-2">
          <Button type="button" size="sm" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" variant="primary" disabled={!masked.trim() || saving}>
            {saving ? 'Saving…' : 'Add account'}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// helpers

function humanCode(code: string): string {
  switch (code) {
    case 'scanned_document': return 'Scanned PDF';
    case 'duplicate_upload': return 'Already uploaded';
    case 'unsupported_type': return 'Wrong file type';
    case 'too_large': return 'File too large';
    case 'empty': return 'File is empty';
    case 'unreadable': return 'Cannot read PDF';
    default: return 'Upload failed';
  }
}

function currentFyLabel(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  // Indian FY: Apr–Mar. If we're in Jan–Mar, FY started previous year.
  const start = m >= 4 ? y : y - 1;
  const end = (start + 1) % 100;
  return `${start}-${String(end).padStart(2, '0')}`;
}

function fyOptions(): string[] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const current = m >= 4 ? y : y - 1;
  const list: string[] = [];
  for (let s = current - 2; s <= current + 1; s++) {
    list.push(`${s}-${String((s + 1) % 100).padStart(2, '0')}`);
  }
  return list.reverse();
}
