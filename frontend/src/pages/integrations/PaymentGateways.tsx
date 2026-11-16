/**
 * /integrations/payment-gateways — the firm's Razorpay / Cashfree keys for
 * invoice payment links.
 *
 * One card per gateway: mode (live / test), key id, secret key and (Razorpay)
 * webhook secret, Test / Save / Remove / "Make default", and the webhook URL
 * to paste in the gateway dashboard. Secrets are encrypted at rest and never
 * returned. The default gateway is what the invoice "Payment link" button
 * uses. Zoho Payments keeps its own page (its links are for invoices
 * imported from Zoho Books).
 *
 * Permission: integrations.access@organisation.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, ExternalLink, KeyRound, Loader2, Trash2, XCircle } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { Card, Field, inputClass } from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { api } from '@/services/api';
import { confirmAction } from '@/components/ConfirmDialog';

type Gateway = 'razorpay' | 'cashfree';
type Mode = 'live' | 'test';

interface GatewayRow {
  gateway: Gateway;
  label: string;
  key_id_label: string;
  dashboard_url: string;
  configured: boolean;
  mode: Mode | null;
  key_id: string | null;
  has_webhook_secret: boolean;
  is_default: boolean;
  updated_at: string | null;
}

interface Overview {
  public_url_configured: boolean;
  webhook_urls: Record<Gateway, string>;
  gateways: GatewayRow[];
}

const gwApi = {
  overview: () => api.get<Overview>('/api/integrations/payment-gateways'),
  save: (body: { gateway: Gateway; mode: Mode; key_id: string; key_secret?: string; webhook_secret?: string }) =>
    api.put<Overview>('/api/integrations/payment-gateways', body),
  test: (body: { gateway: Gateway; mode?: Mode; key_id?: string; key_secret?: string }) =>
    api.post<{ ok: true; gateway: Gateway; mode: Mode }>('/api/integrations/payment-gateways/test', body),
  makeDefault: (gateway: Gateway) => api.post<Overview>(`/api/integrations/payment-gateways/${gateway}/default`),
  remove: (gateway: Gateway) => api.delete<void>(`/api/integrations/payment-gateways/${gateway}`),
};

const QUERY_KEY = ['integrations', 'payment-gateways'] as const;

/** Where the webhook is set up, and what to tick there. */
const WEBHOOK_HELP: Record<Gateway, string> = {
  razorpay: 'In the Razorpay Dashboard → Accounts & Settings → Webhooks, add this URL with a secret of your choice (enter the same secret below) and tick the payment_link.paid, payment_link.partially_paid, payment_link.expired and payment_link.cancelled events.',
  cashfree: 'Links made from AuditOS carry this URL as their notify URL when the app runs on https, so nothing needs pasting. To also add it in the Cashfree dashboard (Developers → Webhooks), choose the Payment Links event. Cashfree signs webhooks with your secret key — no separate webhook secret.',
};

export function PaymentGatewaysIntegrationPage() {
  const { session } = useAuth();
  if (!can(session?.role.code, 'integrations.access', 'organisation')) {
    return (
      <div className="w-full max-w-[720px] mx-auto bg-white border border-neutral-200 rounded p-4 md:p-6">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Access denied</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">Integrations are Finance / MD only.</h1>
        <p className="text-13 text-neutral-500 mt-2">Ask a partner or finance admin to set up payment gateways.</p>
      </div>
    );
  }
  return <GatewaysPage />;
}

function GatewaysPage() {
  const q = useQuery({ queryKey: QUERY_KEY, queryFn: () => gwApi.overview() });
  const data = q.data;
  const current = data?.gateways.find((g) => g.is_default) ?? null;

  return (
    <div className="m-page">
      <header>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Integrations</div>
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900 mt-1">Payment gateways</h1>
        <p className="text-13 text-neutral-500 mt-1 max-w-[640px]">
          Add your firm's Razorpay or Cashfree keys to send a payment link from any invoice. When the client pays,
          the gateway tells AuditOS and the payment is recorded on the invoice automatically — or press
          "Check status" on the invoice. Keys are encrypted at rest and never shown again after saving.
        </p>
      </header>

      <div className="mt-6 space-y-4">
        {q.isLoading ? (
          <div className="flex items-center gap-2 text-13 text-neutral-500">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : q.isError || !data ? (
          <div className="text-13 text-danger">Could not load the payment gateway settings.</div>
        ) : (
          <>
            {current ? (
              <div className="flex items-center gap-3 p-3 border border-success/40 bg-success/5 rounded text-13">
                <CheckCircle2 size={16} className="text-success" />
                <div className="flex-1">
                  <span className="font-medium text-neutral-900">Default: {current.label}</span>
                  <span className="text-neutral-500"> · {current.mode === 'test' ? 'test mode' : 'live'} · used by the invoice "Payment link" button</span>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 p-3 border border-amber/40 bg-amber/5 rounded text-13">
                <XCircle size={16} className="text-amber" />
                <div className="flex-1">
                  <div className="font-medium text-neutral-900">No payment gateway set up.</div>
                  <div className="text-12 text-neutral-500">Invoices cannot offer a payment link until you save keys below.</div>
                </div>
              </div>
            )}
            {!data.public_url_configured ? (
              <div className="p-3 border border-amber/40 bg-amber/5 rounded text-13 text-neutral-700">
                PUBLIC_APP_URL is not set on the server, so the webhook URLs below are incomplete. Payments can
                still be recorded with "Check status" on the invoice.
              </div>
            ) : null}
            {data.gateways.map((g) => (
              <GatewayCard key={g.gateway} row={g} webhookUrl={data.webhook_urls[g.gateway]} />
            ))}
            <Card title="Zoho Payments">
              <div className="p-5 text-13 text-neutral-500">
                Zoho Payments links are made for invoices imported from Zoho Books, and their payments reach AuditOS
                through the Zoho sync. Use the <Link to="/integrations/zoho-payments" className="text-primary hover:underline">Zoho Payments page</Link> for those.
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function StatusPill({ row }: { row: GatewayRow }) {
  if (row.is_default) return <span className="h-6 px-3 inline-flex items-center rounded-full text-12 font-medium bg-success/10 text-success">Default</span>;
  if (row.configured) return <span className="h-6 px-3 inline-flex items-center rounded-full text-12 font-medium bg-neutral-100 text-neutral-700">Configured</span>;
  return <span className="h-6 px-3 inline-flex items-center rounded-full text-12 font-medium bg-neutral-100 text-neutral-500">Not configured</span>;
}

function GatewayCard({ row, webhookUrl }: { row: GatewayRow; webhookUrl: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>(row.mode ?? 'live');
  const [keyId, setKeyId] = useState(row.key_id ?? '');
  const [secret, setSecret] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: QUERY_KEY });
  const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

  const save = useMutation({
    mutationFn: () => gwApi.save({
      gateway: row.gateway, mode, key_id: keyId.trim(),
      key_secret: secret.trim() || undefined, webhook_secret: webhookSecret.trim() || undefined,
    }),
    onSuccess: () => {
      toast.push('success', `${row.label} keys saved.`);
      setSecret('');
      setWebhookSecret('');
      void refresh();
    },
    onError: (e) => toast.push('error', errMsg(e, 'Save failed.')),
  });
  // With a typed secret, test what is typed; otherwise the saved keys (in the chosen mode).
  const test = useMutation({
    mutationFn: () => gwApi.test({ gateway: row.gateway, mode, key_id: keyId.trim() || undefined, key_secret: secret.trim() || undefined }),
    onSuccess: (r) => toast.push('success', `${row.label} accepted the keys (${r.mode}).`),
    onError: (e) => toast.push('error', errMsg(e, 'Test failed.')),
  });
  const makeDefault = useMutation({
    mutationFn: () => gwApi.makeDefault(row.gateway),
    onSuccess: () => { toast.push('success', `Payment links now use ${row.label}.`); void refresh(); },
    onError: (e) => toast.push('error', errMsg(e, 'Could not switch.')),
  });
  const remove = useMutation({
    mutationFn: () => gwApi.remove(row.gateway),
    onSuccess: () => { toast.push('success', `${row.label} keys removed.`); setKeyId(''); void refresh(); },
    onError: (e) => toast.push('error', errMsg(e, 'Remove failed.')),
  });
  const copy = async () => {
    try { await navigator.clipboard.writeText(webhookUrl); toast.push('success', 'Webhook URL copied.'); }
    catch { toast.push('error', 'Could not copy. Select the URL and copy it manually.'); }
  };

  const canSave = !!keyId.trim() && (row.configured || !!secret.trim());
  const canTest = !!keyId.trim() && (row.configured || !!secret.trim());
  const dashHost = row.dashboard_url.replace(/^https:\/\//, '').split('/')[0];

  return (
    <Card title={row.label} right={<StatusPill row={row} />}>
      <div className="p-5 space-y-4">
        {row.configured ? (
          <div className="flex flex-wrap items-center gap-3 p-3 border border-neutral-200 rounded text-13">
            <KeyRound size={16} className="text-neutral-500" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-neutral-900">
                Keys saved — {row.key_id_label} <span className="font-mono">{row.key_id}</span> · {row.mode === 'test' ? 'test mode' : 'live'}
              </div>
              <div className="text-12 text-neutral-500">
                {row.gateway === 'razorpay' ? (row.has_webhook_secret ? 'Webhook secret saved.' : 'No webhook secret yet — payments are recorded only via "Check status".') : 'Webhooks are signed with the secret key.'}
                {row.updated_at ? <><span className="mx-2">·</span>Updated {new Date(row.updated_at).toLocaleString('en-IN')}</> : null}
              </div>
            </div>
            {!row.is_default ? (
              <button type="button" onClick={() => makeDefault.mutate()} disabled={makeDefault.isPending}
                className="h-8 px-3 text-12 border border-neutral-300 rounded hover:border-neutral-400 disabled:opacity-60">
                {makeDefault.isPending ? 'Switching…' : 'Make default'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={async () => {
                if (await confirmAction(`Remove the ${row.label} keys? Existing links stay payable at ${row.label}, but AuditOS can no longer verify their webhooks or check them.`)) remove.mutate();
              }}
              disabled={remove.isPending}
              className="inline-flex items-center gap-1 h-8 px-2 text-12 text-neutral-500 hover:text-danger disabled:opacity-60"
            >
              <Trash2 size={13} /> Remove
            </button>
          </div>
        ) : null}

        <Field label="Mode" hint={row.gateway === 'cashfree' ? 'Test uses the Cashfree sandbox.' : 'Test keys start with rzp_test_, live keys with rzp_live_.'}>
          <select className={inputClass} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="live">Live</option>
            <option value="test">Test</option>
          </select>
        </Field>

        <Field
          label={row.key_id_label}
          hint={
            <span className="inline-flex flex-wrap items-center gap-1">
              From{' '}
              <a href={row.dashboard_url} target="_blank" rel="noopener noreferrer" className="underline inline-flex items-center gap-0.5">
                {dashHost} <ExternalLink size={11} />
              </a>
            </span>
          }
        >
          <input className={inputClass} spellCheck={false} value={keyId} onChange={(e) => setKeyId(e.target.value)}
            placeholder={row.gateway === 'razorpay' ? 'rzp_live_...' : 'App ID'} />
        </Field>

        <Field label="Secret key">
          <input type="password" autoComplete="new-password" spellCheck={false} className={inputClass} value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder={row.configured ? 'Leave blank to keep the saved secret' : 'Secret key'} />
        </Field>

        {row.gateway === 'razorpay' ? (
          <Field label="Webhook secret" hint="The secret you set on the Razorpay webhook. Payments are recorded automatically only with it.">
            <input type="password" autoComplete="new-password" spellCheck={false} className={inputClass} value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder={row.has_webhook_secret ? 'Leave blank to keep the saved webhook secret' : 'Webhook secret'} />
          </Field>
        ) : null}

        <div>
          <div className="text-12 font-medium text-neutral-700 mb-1">Webhook URL</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 px-3 py-2 bg-neutral-50 border border-neutral-200 rounded text-12 font-mono break-all">{webhookUrl}</code>
            <button type="button" onClick={() => void copy()}
              className="inline-flex items-center gap-1 h-8 px-2 text-12 border border-neutral-300 rounded hover:border-neutral-400">
              <Copy size={13} /> Copy
            </button>
          </div>
          <p className="text-12 text-neutral-500 mt-1">{WEBHOOK_HELP[row.gateway]}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
            {save.isPending ? (
              <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Saving…</span>
            ) : (
              <span className="inline-flex items-center gap-2"><KeyRound size={14} /> Save keys</span>
            )}
          </Button>
          <button type="button" onClick={() => test.mutate()} disabled={!canTest || test.isPending}
            className="h-9 px-3 text-13 border border-neutral-300 rounded hover:border-neutral-400 disabled:opacity-60">
            {test.isPending ? 'Testing…' : 'Test keys'}
          </button>
          <div className="text-12 text-neutral-500">
            {secret.trim() ? 'Tests the keys you just typed.' : row.configured ? 'Tests the saved keys.' : 'Type the keys to test them.'}
          </div>
        </div>
      </div>
    </Card>
  );
}
