import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { fmtDate } from '@/lib/format';
import { Modal } from '@/modules/workstation/components';
import { booksApi } from '@/modules/books/api';
import { Field, inputCls, MoneyInput, Money, Notice, selectCls } from '@/modules/books/components';
import { fromPaise, money, today, toPaise } from '@/modules/books/format';

/**
 * Record a payment. Allocation is explicit: the user picks which open
 * invoices or bills this money settles and how much against each. Anything
 * unallocated is recorded as an advance, never netted silently.
 */
export function PaymentModal({ orgId, kind, baseCurrency, onClose, onSaved }: { orgId: string; kind: 'received' | 'made'; baseCurrency: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const api = booksApi.org(orgId);
  const received = kind === 'received';
  const [f, setF] = useState({ contact_id: '', date: today(), amount: '', currency: baseCurrency, exchange_rate: '', deposit_ledger_id: '', bank_charges: '', tds_amount: '', mode: 'bank_transfer', reference: '' });
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const contacts = useQuery({ queryKey: ['books', orgId, 'contacts', received ? 'customer' : 'vendor'], queryFn: () => api.contacts.list({ type: received ? 'customer' : 'vendor' }) });
  const accounts = useQuery({ queryKey: ['books', orgId, 'banking', 'accounts'], queryFn: () => api.banking.accounts() });
  const open = useQuery({ queryKey: ['books', orgId, 'open-items', received ? 'debit' : 'credit', f.contact_id], queryFn: () => api.openItems({ side: received ? 'debit' : 'credit', contact_id: f.contact_id }), enabled: Boolean(f.contact_id) });

  const contact = contacts.data?.items.find((c) => c.id === f.contact_id);
  const currency = f.currency || contact?.currency || baseCurrency;
  const items = (open.data?.items ?? []).filter((b) => b.document && b.currency === currency);
  const amount = toPaise(f.amount || '0');
  const tds = received ? toPaise(f.tds_amount || '0') : 0;
  const settles = amount + tds;
  const allocated = useMemo(() => Object.values(alloc).reduce((t, v) => t + toPaise(v || '0'), 0), [alloc]);
  const advance = settles - allocated;

  const create = useMutation({
    mutationFn: () => api.payments.create(kind, {
      contact_id: f.contact_id, date: f.date, amount, currency, exchange_rate: f.exchange_rate ? Number(f.exchange_rate) : undefined,
      deposit_ledger_id: f.deposit_ledger_id, bank_charges: toPaise(f.bank_charges || '0'), tds_amount: tds, mode: f.mode, reference: f.reference || null,
      allocations: Object.entries(alloc).filter(([, v]) => toPaise(v || '0') > 0).map(([document_id, v]) => ({ document_id, amount: toPaise(v) })),
    }),
    onSuccess: (p) => { toast.push('success', `Payment ${p.number} recorded.`); onSaved(); },
    onError: (e: Error) => setError(e.message),
  });

  const submit = () => {
    setError(null);
    if (!f.contact_id) return setError(`Choose a ${received ? 'customer' : 'vendor'}.`);
    if (amount <= 0) return setError('Enter the amount.');
    if (!f.deposit_ledger_id) return setError(received ? 'Choose where the money was deposited.' : 'Choose which account paid.');
    if (currency !== baseCurrency && !f.exchange_rate) return setError(`Enter the exchange rate for ${currency}.`);
    if (allocated > settles) return setError('Allocations exceed the amount being settled.');
    create.mutate();
  };
  const fillAll = () => {
    let left = settles;
    const next: Record<string, string> = {};
    for (const b of items) { if (left <= 0) break; const take = Math.min(left, b.fx_balance); next[b.source_id] = fromPaise(take); left -= take; }
    setAlloc(next);
  };

  return (
    <Modal open title={received ? 'Record payment received' : 'Record payment made'} onClose={onClose} width="w-[680px]"
      footer={<><Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button variant="primary" size="sm" onClick={submit} disabled={create.isPending} data-testid="payment-save">{create.isPending ? 'Saving…' : 'Record payment'}</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Field label={received ? 'Customer' : 'Vendor'} className="col-span-2">
            <select value={f.contact_id} onChange={(e) => { setF((x) => ({ ...x, contact_id: e.target.value })); setAlloc({}); }} className={selectCls} data-testid="payment-contact">
              <option value="">Select…</option>
              {(contacts.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
            </select>
          </Field>
          <Field label="Date"><input type="date" value={f.date} onChange={(e) => setF((x) => ({ ...x, date: e.target.value }))} className={inputCls} /></Field>
          <Field label="Amount"><MoneyInput value={f.amount} onChange={(v) => setF((x) => ({ ...x, amount: v }))} data-testid="payment-amount" /></Field>
          <Field label="Currency">
            <select value={currency} onChange={(e) => { setF((x) => ({ ...x, currency: e.target.value })); setAlloc({}); }} className={selectCls}>
              {[...new Set([baseCurrency, currency, 'USD', 'EUR', 'GBP', 'AED'])].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          {currency !== baseCurrency ? <Field label={`Rate (1 ${currency})`}><input value={f.exchange_rate} onChange={(e) => setF((x) => ({ ...x, exchange_rate: e.target.value }))} className={inputCls} inputMode="decimal" /></Field> : null}
          <Field label={received ? 'Deposit to' : 'Paid from'} className="col-span-2">
            <select value={f.deposit_ledger_id} onChange={(e) => setF((x) => ({ ...x, deposit_ledger_id: e.target.value }))} className={selectCls} data-testid="payment-account">
              <option value="">Select…</option>
              {(accounts.data?.items ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Mode">
            <select value={f.mode} onChange={(e) => setF((x) => ({ ...x, mode: e.target.value }))} className={selectCls}>
              {['bank_transfer', 'cash', 'cheque', 'upi', 'card', 'other'].map((m) => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}
            </select>
          </Field>
          <Field label="Bank charges"><MoneyInput value={f.bank_charges} onChange={(v) => setF((x) => ({ ...x, bank_charges: v }))} /></Field>
          {received ? <Field label="TDS deducted by customer" hint="Posts to TDS Receivable"><MoneyInput value={f.tds_amount} onChange={(v) => setF((x) => ({ ...x, tds_amount: v }))} data-testid="payment-tds" /></Field> : null}
          <Field label="Reference"><input value={f.reference} onChange={(e) => setF((x) => ({ ...x, reference: e.target.value }))} className={inputCls} /></Field>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">Apply to open {received ? 'invoices' : 'bills'}</span>
            {items.length ? <button type="button" onClick={fillAll} className="text-12 text-gold hover:text-gold-hover">Fill oldest first</button> : null}
          </div>
          <div className="border border-neutral-200 rounded max-h-[240px] overflow-y-auto">
            {!f.contact_id ? <div className="px-3 py-4 text-13 text-neutral-500">Choose a {received ? 'customer' : 'vendor'} to see their open items.</div>
              : items.length === 0 ? <div className="px-3 py-4 text-13 text-neutral-500">Nothing outstanding. The whole amount will be recorded as an advance.</div> : (
                <table className="w-full border-collapse">
                  <tbody>
                    {items.map((b) => (
                      <tr key={b.id} className="border-b border-neutral-200 last:border-0">
                        <td className="px-3 py-2 text-13">
                          <div className="text-neutral-900">{b.document!.number}</div>
                          <div className="text-11 text-neutral-500">{fmtDate(`${b.date}T00:00:00Z`)}{b.due_date ? ` · due ${fmtDate(`${b.due_date}T00:00:00Z`)}` : ''} · outstanding {money(b.fx_balance, b.currency)}</div>
                        </td>
                        <td className="px-3 py-2 w-[150px]">
                          <MoneyInput value={alloc[b.source_id] ?? ''} onChange={(v) => setAlloc((a) => ({ ...a, [b.source_id]: v }))} placeholder={fromPaise(b.fx_balance)} data-testid={`payment-alloc-${b.document!.number}`} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </div>
        </div>

        <div className="bg-neutral-50 border border-neutral-200 rounded p-3 text-13">
          <div className="flex items-baseline justify-between py-0.5"><span className="text-neutral-500">Amount</span><Money value={amount} currency={currency} zero="0" /></div>
          {tds > 0 ? <div className="flex items-baseline justify-between py-0.5"><span className="text-neutral-500">TDS deducted</span><Money value={tds} currency={currency} zero="0" /></div> : null}
          <div className="flex items-baseline justify-between py-0.5"><span className="text-neutral-500">Allocated</span><Money value={allocated} currency={currency} zero="0" /></div>
          <div className="flex items-baseline justify-between py-0.5 border-t border-neutral-300 mt-1 pt-1"><span className="text-neutral-900 font-medium">{advance >= 0 ? 'Unallocated (advance)' : 'Over-allocated'}</span><Money value={advance} currency={currency} bold zero="0" /></div>
        </div>

        {error ? <Notice tone="error">{error}</Notice> : advance > 0 && f.contact_id ? <Notice>{money(advance, currency)} will be held as an advance against this {received ? 'customer' : 'vendor'} and can be applied to a future {received ? 'invoice' : 'bill'}.</Notice> : null}
      </div>
    </Modal>
  );
}
