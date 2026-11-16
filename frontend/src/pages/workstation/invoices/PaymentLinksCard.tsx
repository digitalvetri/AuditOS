/**
 * Payment links on a saved invoice — Razorpay / Cashfree, set up under
 * Integrations → Payment gateways. "Payment link" makes a link for the
 * balance due (an open one for the same amount is reused); Copy / Open share
 * it; "Check status" asks the gateway and records any payment the webhook has
 * not already recorded. Payments land in the Payments card above.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, Link2, RefreshCw } from 'lucide-react';
import { invoicesApi, type Invoice, type InvoicePaymentLink } from '@/modules/workstation/invoices/api';
import { inrAmount } from '@/modules/workstation/invoices/document';
import { Card, QueryState, inputClass } from '@/modules/workstation/components';
import { StatusChip, fmtDay } from '@/modules/workstation/listUi';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

export function PaymentLinksCard({ inv, mayWrite }: { inv: Invoice; mayWrite: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { session } = useAuth();
  const canSetUp = can(session?.role.code, 'integrations.access', 'organisation');
  const q = useQuery({ queryKey: ['invoices.paymentLinks', inv.id], queryFn: () => invoicesApi.paymentLinks(inv.id) });
  const [gateway, setGateway] = useState<'' | 'razorpay' | 'cashfree'>('');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['invoices.paymentLinks', inv.id] });
    void qc.invalidateQueries({ queryKey: ['invoices.payments', inv.id] });
    void qc.invalidateQueries({ queryKey: ['invoices.get', inv.id] });
    void qc.invalidateQueries({ queryKey: ['invoices.list'] });
    void qc.invalidateQueries({ queryKey: ['invoices.summary'] });
  };

  const create = useMutation({
    mutationFn: () => invoicesApi.createPaymentLink(inv.id, gateway || undefined),
    onSuccess: (r) => {
      refresh();
      toast.push('success', r.reused ? 'An open link for this amount already exists — showing it.' : `${r.link.gateway_label} payment link created.`);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const check = useMutation({
    mutationFn: (l: InvoicePaymentLink) => invoicesApi.checkPaymentLink(inv.id, l.id),
    onSuccess: (r) => {
      refresh();
      toast.push('success', r.recorded > 0
        ? `${r.recorded} new payment${r.recorded > 1 ? 's' : ''} recorded.`
        : 'No new payments on this link.');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); toast.push('success', 'Link copied.'); }
    catch { toast.push('error', 'Could not copy. Select the link and copy it manually.'); }
  };

  const canCreate = mayWrite && inv.balance_due_paise > 0 && inv.stored_status !== 'cancelled';

  return (
    <div className="mb-4">
      <QueryState query={q}>
        {(data) => {
          if (data.gateways.length === 0 && data.items.length === 0) {
            if (!mayWrite) return null;
            return (
              <Card title="Payment links">
                <div className="px-5 py-4 text-13 text-neutral-500">
                  Collect online with a Razorpay or Cashfree link that marks this invoice paid automatically.{' '}
                  {canSetUp ? (
                    <Link to="/integrations/payment-gateways" className="text-primary hover:underline">Set up a payment gateway</Link>
                  ) : 'Ask a partner or finance admin to set up a payment gateway.'}
                </div>
              </Card>
            );
          }
          return (
            <Card
              title="Payment links"
              right={canCreate && data.gateways.length > 0 ? (
                <div className="flex items-center gap-2">
                  {data.gateways.length > 1 ? (
                    <select
                      aria-label="Gateway"
                      className={`${inputClass} h-8 w-auto text-12`}
                      value={gateway}
                      onChange={(e) => setGateway(e.target.value as typeof gateway)}
                    >
                      <option value="">Default ({data.gateways.find((g) => g.is_default)?.label ?? data.gateways[0].label})</option>
                      {data.gateways.map((g) => <option key={g.gateway} value={g.gateway}>{g.label}</option>)}
                    </select>
                  ) : null}
                  <Button variant="primary" onClick={() => create.mutate()} disabled={create.isPending}>
                    <span className="inline-flex items-center gap-2"><Link2 size={14} /> {create.isPending ? 'Creating…' : 'Payment link'}</span>
                  </Button>
                </div>
              ) : null}
            >
              {data.items.length === 0 ? (
                <div className="px-5 py-4 text-13 text-neutral-500">
                  No payment link yet. One is made for the balance due of ₹{inrAmount(inv.balance_due_paise)}.
                </div>
              ) : (
                <div>
                  {data.items.map((l) => (
                    <div key={l.id} className="px-5 py-3 border-b border-neutral-100 last:border-b-0">
                      <div className="flex flex-wrap items-center gap-3 text-13">
                        <span className="font-medium text-neutral-900">{l.gateway_label}</span>
                        <span className="tabular-nums text-neutral-900">₹{inrAmount(l.amount_paise)}</span>
                        <StatusChip value={l.status} />
                        <span className="text-12 text-neutral-500">Created {fmtDay(l.created_at.slice(0, 10))}</span>
                        <div className="flex-1" />
                        <button type="button" onClick={() => void copy(l.url)}
                          className="inline-flex items-center gap-1 h-8 px-2 text-12 border border-neutral-300 rounded hover:border-neutral-400">
                          <Copy size={13} /> Copy link
                        </button>
                        <a href={l.url} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 h-8 px-2 text-12 border border-neutral-300 rounded hover:border-neutral-400">
                          <ExternalLink size={13} /> Open
                        </a>
                        {mayWrite ? (
                          <button type="button" onClick={() => check.mutate(l)} disabled={check.isPending}
                            className="inline-flex items-center gap-1 h-8 px-2 text-12 border border-neutral-300 rounded hover:border-neutral-400 disabled:opacity-60">
                            <RefreshCw size={13} className={check.isPending && check.variables?.id === l.id ? 'animate-spin' : ''} /> Check status
                          </button>
                        ) : null}
                      </div>
                      <div className="mt-1 text-12 text-neutral-500 break-all">{l.url}</div>
                      {l.paid_paise > 0 ? (
                        <div className="mt-1 text-12 text-success">₹{inrAmount(l.paid_paise)} recorded on this invoice through this link.</div>
                      ) : null}
                      {l.excess_paise > 0 ? (
                        <div className="mt-1 text-12 text-amber">
                          ₹{inrAmount(l.excess_paise)} was paid at {l.gateway_label} above the balance due (or after the invoice was
                          cancelled) and was NOT recorded — refund it at the gateway or account for it by hand.
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          );
        }}
      </QueryState>
    </div>
  );
}
