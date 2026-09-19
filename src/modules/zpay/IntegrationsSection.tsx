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
    <li className="bg-white border border-neutral-200 rounded p-4 flex items-start justify-between gap-4 flex-wrap">
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
        {conn.accounts.length > 0 ? (
          <ul className="mt-3 space-y-1">
            {conn.accounts.map((a) => (
              <li key={a.id} className="text-12 text-neutral-700">
                <span className="font-medium">{a.label}</span>
                {a.isGstRegistered ? ' · GST-registered' : ' · not GST-registered'}
                {a.gstin ? ` · ${a.gstin}` : ''}
                {a.lastSyncAt ? ` · synced ${formatWhen(a.lastSyncAt)}` : ' · never synced'}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {action ? (
        <Button variant="primary" onClick={onAuthorize} disabled={busy}>
          {busy ? 'Redirecting…' : action}
        </Button>
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
