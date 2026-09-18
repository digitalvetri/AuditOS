/**
 * Settings → Integrations → Zoho Payments (docs/zoho-payments/README.md §5).
 *
 * Firm-collections integration. Two accounts, external invoicing — the row
 * a user manages here is a ZpayConnection, which in turn holds one or more
 * ZpayAccounts (depending on the Zoho login topology; see §2 of the spec).
 *
 * All five connection states surface in the pill; the CTA per row depends
 * on the state:
 *   not_connected     → "Connect"
 *   consent_pending   → "Continue in Zoho" (link back to the last authorize
 *                       URL is not persisted server-side; we regenerate)
 *   connected         → "Reconnect" (rare — used after a scope change)
 *   expired           → "Reconnect"
 *   revoked           → "Reconnect"  (spec §3: STOP RETRYING; user consents)
 *   error             → "Retry"
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionShell } from '../settings/SectionShell';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import {
  zpayApi,
  type CreateAccountInput,
  type ZpayAccountSummary,
  type ZpayConnectionSummary,
  type ZpayStatus,
} from './api';

const STATUS_LABEL: Record<ZpayStatus, string> = {
  not_connected: 'Not connected',
  consent_pending: 'Awaiting consent',
  connected: 'Connected',
  revoked: 'Revoked in Zoho',
  expired: 'Session expired',
  error: 'Error',
};

const STATUS_TONE: Record<ZpayStatus, string> = {
  not_connected: 'bg-neutral-100 text-neutral-700 border-neutral-200',
  consent_pending: 'bg-amber-50 text-amber-800 border-amber-200',
  connected: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  revoked: 'bg-red-50 text-red-800 border-red-200',
  expired: 'bg-amber-50 text-amber-800 border-amber-200',
  error: 'bg-red-50 text-red-800 border-red-200',
};

function actionLabelFor(status: ZpayStatus): string | null {
  switch (status) {
    case 'not_connected':
      return 'Connect';
    case 'consent_pending':
      return 'Continue in Zoho';
    case 'connected':
      return 'Reconnect';
    case 'expired':
    case 'revoked':
      return 'Reconnect';
    case 'error':
      return 'Retry';
  }
}

export function ZpayIntegrationsSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');

  const q = useQuery({
    queryKey: ['zpay', 'connections'],
    queryFn: zpayApi.list,
  });

  const create = useMutation({
    mutationFn: () => zpayApi.create({ zohoOrgLabel: label.trim() }),
    onSuccess: () => {
      toast.push('success', 'Connection added. Now click Connect to authorise it.');
      qc.invalidateQueries({ queryKey: ['zpay', 'connections'] });
      setAdding(false);
      setLabel('');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const authorize = useMutation({
    mutationFn: (id: string) => zpayApi.authorize(id),
    onSuccess: (result) => {
      // Full-page navigation to Zoho. In fake mode the browser hits the
      // in-process /fake-zoho router and comes right back to /callback.
      window.location.href = result.authorizeUrl;
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  return (
    <SectionShell
      title="Zoho Payments"
      description="Firm-collections integration. Connect the firm's Zoho Payments accounts (GST-registered entity and non-GST entity) so payments captured there can be matched against invoices raised elsewhere."
      addLabel={adding ? undefined : 'Add account'}
      onAdd={adding ? undefined : () => setAdding(true)}
    >
      {adding ? (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!label.trim()) return;
            create.mutate();
          }}
          className="bg-white border border-neutral-200 rounded p-4 flex items-end gap-3 flex-wrap"
        >
          <label className="flex-1 min-w-[240px]">
            <span className="text-11 uppercase tracking-[0.06em] text-neutral-500 block mb-1">
              Label
            </span>
            <Input
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. GST entity"
            />
            <span className="text-11 text-neutral-500 block mt-1">
              What you call this Zoho Payments account internally. Doesn't need
              to match Zoho's naming.
            </span>
          </label>
          <div className="flex gap-2">
            <Button
              variant="primary"
              type="submit"
              disabled={!label.trim() || create.isPending}
            >
              {create.isPending ? 'Adding…' : 'Add'}
            </Button>
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                setAdding(false);
                setLabel('');
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {q.isLoading ? (
        <div className="text-13 text-neutral-500">Loading connections…</div>
      ) : q.error ? (
        <div className="text-13 text-red-700 bg-red-50 border border-red-200 rounded p-3">
          Failed to load: {(q.error as Error).message}
        </div>
      ) : q.data && q.data.items.length === 0 ? (
        <div className="text-13 text-neutral-500 bg-neutral-50 border border-neutral-200 rounded p-4">
          No connections yet. Add one for each Zoho Payments account (typically
          two — the GST-registered entity and the non-GST entity).
        </div>
      ) : (
        <ul className="space-y-2">
          {q.data?.items.map((conn) => (
            <ConnectionRow
              key={conn.id}
              conn={conn}
              busy={authorize.isPending && authorize.variables === conn.id}
              onAuthorize={() => authorize.mutate(conn.id)}
            />
          ))}
        </ul>
      )}
    </SectionShell>
  );
}

function ConnectionRow({
  conn,
  busy,
  onAuthorize,
}: {
  conn: ZpayConnectionSummary;
  busy: boolean;
  onAuthorize: () => void;
}) {
  const action = actionLabelFor(conn.status);
  return (
    <li className="bg-white border border-neutral-200 rounded p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-14 font-medium text-neutral-900">{conn.zohoOrgLabel}</span>
            <span
              className={
                'inline-flex items-center h-5 px-2 rounded-full border text-11 ' +
                STATUS_TONE[conn.status]
              }
            >
              {STATUS_LABEL[conn.status]}
            </span>
          </div>
          <div className="text-12 text-neutral-500 mt-1">
            {conn.status === 'connected' && conn.connectedAt
              ? `Connected ${formatWhen(conn.connectedAt)}`
              : conn.lastErrorCode
              ? `Last error: ${conn.lastErrorCode}${conn.lastErrorAt ? ` · ${formatWhen(conn.lastErrorAt)}` : ''}`
              : 'No accounts synced yet.'}
          </div>
        </div>
        {action ? (
          <Button variant="primary" onClick={onAuthorize} disabled={busy}>
            {busy ? 'Redirecting…' : action}
          </Button>
        ) : null}
      </div>
      {conn.status === 'connected' ? <AccountsBlock conn={conn} /> : null}
    </li>
  );
}

// ── Accounts under a connected connection ────────────────────────────

function AccountsBlock({ conn }: { conn: ZpayConnectionSummary }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="mt-4 border-t border-neutral-200 pt-4">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
          Accounts under this connection
        </div>
        {!adding ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="text-12 text-navy-700 hover:underline"
          >
            + Add account
          </button>
        ) : null}
      </div>
      {adding ? (
        <AddAccountForm connectionId={conn.id} onDone={() => setAdding(false)} />
      ) : null}
      {conn.accounts.length === 0 && !adding ? (
        <p className="text-12 text-neutral-500 bg-neutral-50 border border-neutral-200 rounded p-3">
          No accounts yet. Zoho's account identifier (from{' '}
          <span className="font-mono">payments.zoho.in</span> settings) is what
          this row needs.
        </p>
      ) : (
        <ul className="space-y-2">
          {conn.accounts.map((a) => (
            <AccountRow key={a.id} connectionId={conn.id} account={a} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AddAccountForm({
  connectionId,
  onDone,
}: {
  connectionId: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<CreateAccountInput>({
    accountId: '',
    label: '',
    isGstRegistered: false,
    legalEntityName: '',
    gstin: '',
    invoiceSeriesPrefix: '',
  });
  const set = <K extends keyof CreateAccountInput>(k: K, v: CreateAccountInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: () =>
      zpayApi.createAccount(connectionId, {
        ...form,
        gstin: form.isGstRegistered ? (form.gstin || null) : null,
      }),
    onSuccess: () => {
      toast.push('success', 'Account added.');
      qc.invalidateQueries({ queryKey: ['zpay', 'connections'] });
      onDone();
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const disabled =
    !form.accountId.trim() ||
    !form.label.trim() ||
    !form.legalEntityName.trim() ||
    !form.invoiceSeriesPrefix.trim() ||
    (form.isGstRegistered && !(form.gstin ?? '').trim()) ||
    create.isPending;

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (disabled) return;
        create.mutate();
      }}
      className="bg-neutral-50 border border-neutral-200 rounded p-3 mb-3 grid gap-3"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <FieldSm label="Zoho account ID" hint="The value Zoho requires on every API call.">
          <Input
            value={form.accountId}
            onChange={(e) => set('accountId', e.target.value)}
            placeholder="e.g. 5432109876"
          />
        </FieldSm>
        <FieldSm label="Label" hint='"GST" or "Non-GST" — your shorthand.'>
          <Input
            value={form.label}
            onChange={(e) => set('label', e.target.value)}
            placeholder="GST"
          />
        </FieldSm>
        <FieldSm label="Legal entity name" hint="Whoever the invoice is raised from.">
          <Input
            value={form.legalEntityName}
            onChange={(e) => set('legalEntityName', e.target.value)}
            placeholder="Vetri & Associates LLP"
          />
        </FieldSm>
        <FieldSm label="Invoice series prefix" hint="e.g. INV/2026/ — used for exact matching.">
          <Input
            value={form.invoiceSeriesPrefix}
            onChange={(e) => set('invoiceSeriesPrefix', e.target.value)}
            placeholder="INV/2026/"
          />
        </FieldSm>
      </div>
      <label className="flex items-center gap-2 text-12 text-neutral-700">
        <input
          type="checkbox"
          checked={form.isGstRegistered}
          onChange={(e) => set('isGstRegistered', e.target.checked)}
        />
        This account is GST-registered
      </label>
      {form.isGstRegistered ? (
        <FieldSm label="GSTIN">
          <Input
            value={form.gstin ?? ''}
            onChange={(e) => set('gstin', e.target.value)}
            placeholder="33AAACR5055K1Z1"
          />
        </FieldSm>
      ) : null}
      <div className="flex gap-2">
        <Button variant="primary" type="submit" disabled={disabled}>
          {create.isPending ? 'Adding…' : 'Add account'}
        </Button>
        <Button variant="secondary" type="button" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function FieldSm({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-11 uppercase tracking-[0.06em] text-neutral-500 block mb-1">
        {label}
      </span>
      {children}
      {hint ? <span className="text-11 text-neutral-500 block mt-1">{hint}</span> : null}
    </label>
  );
}

function AccountRow({
  connectionId,
  account,
}: {
  connectionId: string;
  account: ZpayAccountSummary;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [importing, setImporting] = useState(false);
  const sync = useMutation({
    mutationFn: () => zpayApi.syncAccount(connectionId, account.id),
    onSuccess: (outcome) => {
      if (outcome.status === 'success') {
        toast.push(
          'success',
          `Synced ${outcome.paymentsFetched} payments, ${outcome.refundsFetched} refunds.`,
        );
      } else {
        toast.push(
          'error',
          `Sync ${outcome.status}: ${outcome.errorCode ?? 'see run for detail'}`,
        );
      }
      qc.invalidateQueries({ queryKey: ['zpay', 'connections'] });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const importInvoices = useMutation({
    mutationFn: (file: File) => zpayApi.importInvoices(account.id, file),
    onSuccess: (outcome) => {
      const parts = [`${outcome.inserted} new`, `${outcome.updated} updated`];
      if (outcome.probableProposed > 0) parts.push(`${outcome.probableProposed} probable matches proposed`);
      if (outcome.errors.length > 0) parts.push(`${outcome.errors.length} errors`);
      if (outcome.warnings.length > 0) parts.push(`${outcome.warnings.length} warnings`);
      toast.push(
        outcome.errors.length > 0 ? 'error' : 'success',
        `Import: ${parts.join(', ')}.`,
      );
      qc.invalidateQueries({ queryKey: ['zpay', 'queue'] });
      qc.invalidateQueries({ queryKey: ['zpay', 'billing-slice'] });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  return (
    <li className="bg-white border border-neutral-200 rounded p-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-13 text-neutral-900">
            <span className="font-medium">{account.label}</span>
            <span className="text-neutral-500"> · </span>
            <span className="font-mono text-11">{account.accountId}</span>
          </div>
          <div className="text-11 text-neutral-500 mt-0.5">
            {account.isGstRegistered ? `GST-registered${account.gstin ? ` · ${account.gstin}` : ''}` : 'Not GST-registered'}
            {account.lastSyncAt
              ? ` · ${account.lastSyncStatus ?? 'synced'} ${formatWhen(account.lastSyncAt)}`
              : ' · never synced'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setImporting((v) => !v)}
            className="text-12 text-navy-700 hover:underline"
          >
            {importing ? 'Cancel import' : 'Import invoices'}
          </button>
          <Button variant="secondary" onClick={() => sync.mutate()} disabled={sync.isPending}>
            {sync.isPending ? 'Syncing…' : 'Sync now'}
          </Button>
        </div>
      </div>
      {importing ? (
        <div className="mt-3 bg-neutral-50 border border-neutral-200 rounded p-3 space-y-2">
          <div className="text-12 text-neutral-600">
            Upload a CSV of open + paid invoices raised from this account.
            Required columns: <code>invoice_number</code>, <code>issued_on</code>,{' '}
            <code>amount</code>. Optional: <code>status</code>,{' '}
            <code>due_date</code>, <code>client_code</code> (matched to a
            client in AuditOS). Re-uploading is idempotent — same invoice
            number updates in place.
          </div>
          <input
            type="file"
            accept=".csv,text/csv"
            className="text-13"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importInvoices.mutate(file);
              e.target.value = '';
            }}
            disabled={importInvoices.isPending}
          />
          {importInvoices.isPending ? (
            <div className="text-11 text-neutral-500">Uploading…</div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
