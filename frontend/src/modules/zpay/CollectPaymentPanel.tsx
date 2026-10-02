/**
 * The step after an invoice import: collect payment. For each invoice the
 * file carried — new or already imported — raise a Zoho Payments link, send
 * it to the client, and check whether it has been paid.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { waNumber } from '@/modules/workstation/share';
import { zpayCollect, type InvoicePaymentState } from './api';

const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATE_TONE: Record<InvoicePaymentState['state'], string> = {
  unpaid: 'bg-amber/10 text-amber border-amber/40',
  part_paid: 'bg-primary/10 text-primary border-primary/30',
  paid: 'bg-success/10 text-success border-success/40',
};
const STATE_LABEL: Record<InvoicePaymentState['state'], string> = { unpaid: 'Unpaid', part_paid: 'Part-paid', paid: 'Paid' };

export function CollectPaymentPanel({ invoiceIds, onClose }: { invoiceIds: string[]; onClose: () => void }) {
  if (invoiceIds.length === 0) return null;
  return (
    <div className="mt-3 border border-primary/30 bg-white rounded p-3 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="text-13 font-medium text-neutral-900">Next step — collect payment</div>
          <div className="text-12 text-neutral-500">
            Create a Zoho Payments link for each invoice and send it to the client. Their payment syncs back and marks the invoice paid.
          </div>
        </div>
        <button type="button" onClick={onClose} className="text-12 text-neutral-500 hover:text-neutral-900">Done</button>
      </div>
      {invoiceIds.map((id) => <InvoiceCollect key={id} invoiceId={id} />)}
    </div>
  );
}

function InvoiceCollect({ invoiceId }: { invoiceId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['zpay', 'invoice-payment', invoiceId];
  const q = useQuery({ queryKey: key, queryFn: () => zpayCollect.state(invoiceId) });
  const [form, setForm] = useState<{ email: string; phone: string; expires_at: string; notify_email: boolean; notify_sms: boolean } | null>(null);
  const put = (s: InvoicePaymentState) => qc.setQueryData(key, s);

  const create = useMutation({
    mutationFn: () => zpayCollect.createLink(invoiceId, {
      email: form?.email || undefined, phone: form?.phone || undefined, expires_at: form?.expires_at || undefined,
      notify_email: form?.notify_email, notify_sms: form?.notify_sms,
    }),
    onSuccess: (r) => { put(r.state); toast.push('success', r.reused ? 'This invoice already has an open payment link — here it is.' : 'Payment link created in Zoho Payments.'); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const check = useMutation({
    mutationFn: (linkId: string) => zpayCollect.refreshLink(linkId),
    onSuccess: (r) => {
      put(r.state);
      qc.invalidateQueries({ queryKey: ['zpay', 'queue'] });
      toast.push('success', r.state.state === 'paid' ? 'Paid in full.'
        : r.unsynced ? `${r.unsynced} payment${r.unsynced === 1 ? '' : 's'} made — press Sync now on the account to bring ${r.unsynced === 1 ? 'it' : 'them'} in.`
        : 'No payment yet.');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  if (q.isLoading) return <div className="text-12 text-neutral-500">Loading…</div>;
  if (q.error || !q.data) return <div className="text-12 text-red-700">Couldn’t load this invoice: {(q.error as Error)?.message}</div>;
  const s = q.data;
  const inv = s.invoice;
  const link = s.links.find((l) => l.status === 'active' || l.status === 'partially_paid');
  const startForm = () => setForm({ email: inv.client_email ?? '', phone: inv.client_phone ?? '', expires_at: '', notify_email: false, notify_sms: false });
  const message = link
    ? `Dear ${inv.client_name ?? 'Sir/Madam'}, please pay ${inr(link.amount_paise - link.amount_paid_paise)} for invoice ${inv.invoice_number} using this secure link: ${link.url}`
    : '';

  return (
    <div className="border border-neutral-200 rounded p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-13 font-medium text-neutral-900">{inv.invoice_number}</span>
            <span className={`inline-flex items-center h-5 px-2 rounded-full border text-11 ${STATE_TONE[s.state]}`}>{STATE_LABEL[s.state]}</span>
          </div>
          <div className="text-12 text-neutral-500">
            {inv.client_name ? `${inv.client_name} · ` : ''}{inr(inv.amount_paise)}
            {s.paid_paise ? ` · paid ${inr(s.paid_paise)}` : ''}{s.owed_paise && s.paid_paise ? ` · owed ${inr(s.owed_paise)}` : ''}
          </div>
        </div>
        {s.state !== 'paid' && !link && !form ? (
          <Button variant="primary" onClick={startForm} disabled={!s.connected} title={s.connected ? undefined : 'Connect this Zoho Payments account first'}>
            Create payment link
          </Button>
        ) : null}
      </div>

      {!s.connected && s.state !== 'paid' && !link ? (
        <p className="text-12 text-amber mt-2">Connect this Zoho Payments account (above) before raising a payment link.</p>
      ) : null}

      {form && !link && s.state !== 'paid' ? (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
          <label className="text-12 text-neutral-600">Client email
            <input className="mt-1 h-8 w-full px-2 text-13 border border-neutral-300 rounded" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="text-12 text-neutral-600">Client mobile
            <input className="mt-1 h-8 w-full px-2 text-13 border border-neutral-300 rounded" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="10 digits" />
          </label>
          <label className="text-12 text-neutral-600">Link expires on (optional)
            <input className="mt-1 h-8 w-full px-2 text-13 border border-neutral-300 rounded" type="date" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />
          </label>
          <div className="sm:col-span-3 flex items-center gap-4 flex-wrap text-12 text-neutral-700">
            <label className="inline-flex items-center gap-1.5"><input type="checkbox" disabled={!form.email} checked={form.notify_email} onChange={(e) => setForm({ ...form, notify_email: e.target.checked })} />Zoho emails the link</label>
            <label className="inline-flex items-center gap-1.5"><input type="checkbox" disabled={!form.phone} checked={form.notify_sms} onChange={(e) => setForm({ ...form, notify_sms: e.target.checked })} />Zoho sends it by SMS</label>
            <span className="text-neutral-500">Amount: {inr(s.owed_paise)} · reference {inv.invoice_number}</span>
            <div className="flex-1" />
            <button type="button" className="text-12 text-neutral-500 hover:text-neutral-900" onClick={() => setForm(null)}>Cancel</button>
            <Button variant="primary" onClick={() => create.mutate()} disabled={create.isPending}>{create.isPending ? 'Creating…' : `Create link for ${inr(s.owed_paise)}`}</Button>
          </div>
        </div>
      ) : null}

      {link ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <input readOnly value={link.url} className="h-8 flex-1 min-w-0 px-2 text-12 font-mono bg-neutral-50 border border-neutral-200 rounded" onFocus={(e) => e.target.select()} />
            <Button variant="secondary" onClick={() => { void navigator.clipboard?.writeText(link.url).then(() => toast.push('success', 'Link copied.')); }}>Copy</Button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="secondary" onClick={() => window.open(`https://wa.me/${waNumber(link.phone ?? inv.client_phone)}?text=${encodeURIComponent(message)}`, '_blank', 'noopener')}>Send on WhatsApp</Button>
            <Button variant="secondary" onClick={() => { window.location.href = `mailto:${link.email ?? inv.client_email ?? ''}?subject=${encodeURIComponent(`Payment for invoice ${inv.invoice_number}`)}&body=${encodeURIComponent(message)}`; }}>Email</Button>
            <Button variant="secondary" onClick={() => window.open(link.url, '_blank', 'noopener')}>Open link</Button>
            <div className="flex-1" />
            <Button variant="secondary" onClick={() => check.mutate(link.id)} disabled={check.isPending}>{check.isPending ? 'Checking…' : 'Check payment'}</Button>
          </div>
          <div className="text-11 text-neutral-500">
            Link for {inr(link.amount_paise)}{link.amount_paid_paise ? ` · ${inr(link.amount_paid_paise)} paid so far` : ''}{link.expires_at ? ` · expires ${link.expires_at}` : ''}
            {link.last_checked_at ? ` · last checked ${new Date(link.last_checked_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}
          </div>
        </div>
      ) : null}

      {s.payments.length ? (
        <ul className="mt-2 text-12 text-success space-y-0.5">
          {s.payments.map((p) => (
            <li key={p.id}>✓ {inr(p.amount_paise)} received {new Date(p.paid_at).toLocaleDateString('en-IN', { dateStyle: 'medium' })}{p.mode ? ` by ${p.mode.replace('_', ' ')}` : ''} · Zoho {p.zoho_payment_id}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
