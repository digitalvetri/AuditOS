import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { Modal } from '@/modules/workstation/components';
import { booksApi } from '@/modules/books/api';
import { Field, inputCls, MoneyInput, Money, Notice, selectCls } from '@/modules/books/components';
import { DOC_LABEL, bp, fromPaise, isSalesKind, today, toPaise } from '@/modules/books/format';
import type { BooksDocument, DocKind } from '@/modules/books/types';

/**
 * One editor for every document kind. It mirrors the server's arithmetic
 * (compute.ts) so the totals a user sees while typing match what is posted;
 * the server recomputes on save and its numbers are the ones stored.
 */
interface LineDraft { key: string; item_id: string; description: string; hsn_sac: string; quantity: string; rate: string; discount_percent_bp: string; tax_rate_id: string; ledger_id: string }

let seq = 0;
const emptyLine = (): LineDraft => ({ key: `l${++seq}`, item_id: '', description: '', hsn_sac: '', quantity: '1', rate: '', discount_percent_bp: '', tax_rate_id: '', ledger_id: '' });

export function DocumentEditor({ orgId, kind, documentId, onClose, onSaved }: { orgId: string; kind: DocKind; documentId?: string; onClose: () => void; onSaved: (d: BooksDocument) => void }) {
  const toast = useToast();
  const sales = isSalesKind(kind);
  const api = booksApi.org(orgId);
  const [error, setError] = useState<string | null>(null);
  const [head, setHead] = useState({ contact_id: '', date: today(), due_date: '', reference_no: '', currency: '', exchange_rate: '', place_of_supply: '', tax_inclusive: false, discount_percent_bp: '', tds_rate_id: '', notes: '' });
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);

  const org = useQuery({ queryKey: ['books', orgId, 'org'], queryFn: api.get });
  const contacts = useQuery({ queryKey: ['books', orgId, 'contacts', sales ? 'customer' : 'vendor'], queryFn: () => api.contacts.list({ type: sales ? 'customer' : 'vendor' }) });
  const items = useQuery({ queryKey: ['books', orgId, 'items'], queryFn: () => api.items.list() });
  const taxes = useQuery({ queryKey: ['books', orgId, 'tax-rates'], queryFn: () => api.taxRates.list() });
  const ledgers = useQuery({ queryKey: ['books', orgId, 'ledgers', sales ? 'income' : 'expense'], queryFn: () => api.chart.ledgers({ root: sales ? 'income' : 'expense' }) });
  const existing = useQuery({ queryKey: ['books', orgId, 'document', kind, documentId], queryFn: () => api.documents.get(kind, documentId!), enabled: Boolean(documentId) });

  useEffect(() => {
    const d = existing.data?.document;
    if (!d) return;
    setHead({
      contact_id: d.contact_id, date: d.date, due_date: d.due_date ?? '', reference_no: d.reference_no ?? '', currency: d.currency, exchange_rate: d.exchange_rate === 1 ? '' : String(d.exchange_rate),
      place_of_supply: d.place_of_supply ?? '', tax_inclusive: d.tax_inclusive, discount_percent_bp: d.discount_percent_bp ? String(d.discount_percent_bp / 100) : '', tds_rate_id: d.tds_rate_id ?? '', notes: d.notes ?? '',
    });
    setLines(d.lines.map((l) => ({ key: l.id, item_id: l.item_id ?? '', description: l.description, hsn_sac: l.hsn_sac ?? '', quantity: String(l.quantity), rate: fromPaise(l.rate), discount_percent_bp: l.discount_percent_bp ? String(l.discount_percent_bp / 100) : '', tax_rate_id: l.tax_rate_id ?? '', ledger_id: l.ledger_id })));
  }, [existing.data]);

  const contact = contacts.data?.items.find((c) => c.id === head.contact_id);
  const gstRates = (taxes.data?.items ?? []).filter((t) => t.type === 'gst');
  const tdsRates = (taxes.data?.items ?? []).filter((t) => t.type === 'tds');
  const baseCurrency = org.data?.base_currency ?? 'INR';
  const currency = head.currency || contact?.currency || baseCurrency;
  const orgState = org.data?.state_code ?? null;
  const pos = head.place_of_supply || contact?.place_of_supply_state || orgState || '';
  const interState = Boolean(orgState && pos && orgState !== pos);
  const gstExempt = contact?.gst_treatment === 'overseas' || !org.data?.gstin;

  // Local mirror of the server's document arithmetic.
  const totals = useMemo(() => {
    const rate = (l: LineDraft) => toPaise(l.rate || '0');
    const qty = (l: LineDraft) => Number(l.quantity || '0');
    const gross = lines.map((l) => Math.round(rate(l) * qty(l)));
    const lineDisc = lines.map((l, i) => Math.round((gross[i] * Number(l.discount_percent_bp || '0') * 100) / 10000));
    const net = gross.map((g, i) => g - lineDisc[i]);
    const netSum = net.reduce((a, b) => a + b, 0);
    const docDisc = Math.round((netSum * Number(head.discount_percent_bp || '0') * 100) / 10000);
    const share = netSum === 0 ? net.map(() => 0) : net.map((n) => Math.round((docDisc * n) / netSum));
    let taxable = 0, cgst = 0, sgst = 0, igst = 0;
    const rows = lines.map((l, i) => {
      const afterDisc = net[i] - share[i];
      const b = gstExempt ? 0 : (gstRates.find((t) => t.id === (l.tax_rate_id || items.data?.items.find((x) => x.id === l.item_id)?.tax_rate_id))?.percentage_bp ?? 0);
      const t = head.tax_inclusive && b > 0 ? Math.round((afterDisc * 10000) / (10000 + b)) : afterDisc;
      const tax = Math.round((t * b) / 10000);
      taxable += t;
      if (interState) igst += tax; else { const c = Math.round(tax / 2); cgst += c; sgst += tax - c; }
      return { taxable: t, tax, total: t + tax, bp: b };
    });
    const taxTotal = cgst + sgst + igst;
    const tdsRate = tdsRates.find((t) => t.id === head.tds_rate_id);
    const tdsBp = kind === 'bill' && tdsRate ? (contact?.pan ? tdsRate.percentage_bp : tdsRate.no_pan_percentage_bp ?? tdsRate.percentage_bp) : 0;
    const tds = Math.round((taxable * tdsBp) / 10000);
    const before = taxable + taxTotal;
    const total = currency === 'INR' ? Math.round(before / 100) * 100 : before;
    return { rows, subtotal: gross.reduce((a, b) => a + b, 0), discount: lineDisc.reduce((a, b) => a + b, 0) + docDisc, taxable, cgst, sgst, igst, taxTotal, tds, roundOff: total - before, total, payable: total - tds };
  }, [lines, head, gstRates, tdsRates, interState, gstExempt, contact, items.data, currency, kind]);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        contact_id: head.contact_id, date: head.date, due_date: head.due_date || null, reference_no: head.reference_no || null,
        currency, exchange_rate: head.exchange_rate ? Number(head.exchange_rate) : undefined, place_of_supply: head.place_of_supply || null,
        tax_inclusive: head.tax_inclusive, discount_percent_bp: Math.round(Number(head.discount_percent_bp || '0') * 100), tds_rate_id: head.tds_rate_id || null, notes: head.notes || null,
        lines: lines.filter((l) => l.rate !== '' || l.item_id).map((l) => ({
          item_id: l.item_id || null, description: l.description || undefined, hsn_sac: l.hsn_sac || null, quantity: Number(l.quantity || '1'),
          rate: toPaise(l.rate || '0'), discount_percent_bp: Math.round(Number(l.discount_percent_bp || '0') * 100), tax_rate_id: l.tax_rate_id || null, ledger_id: l.ledger_id || null,
        })),
      };
      return documentId ? api.documents.update(kind, documentId, payload) : api.documents.create(kind, payload);
    },
    onSuccess: (d) => { toast.push('success', `${DOC_LABEL[kind]} ${d.number} saved as a draft.`); onSaved(d); },
    onError: (e: Error) => { setError(e.message); },
  });

  const setLine = (key: string, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const pickItem = (key: string, itemId: string) => {
    const it = items.data?.items.find((i) => i.id === itemId);
    setLine(key, { item_id: itemId, ...(it ? { description: it.name, rate: fromPaise(sales ? it.sell_rate : it.purchase_rate), hsn_sac: it.hsn_sac ?? '', tax_rate_id: it.tax_rate_id ?? '' } : {}) });
  };

  const submit = () => {
    setError(null);
    if (!head.contact_id) return setError(`Choose a ${sales ? 'customer' : 'vendor'}.`);
    if (!lines.some((l) => toPaise(l.rate || '0') > 0)) return setError('Add at least one line with an amount.');
    if (currency !== baseCurrency && !head.exchange_rate) return setError(`Enter the exchange rate for ${currency}.`);
    save.mutate();
  };

  return (
    <Modal open title={`${documentId ? 'Edit' : 'New'} ${DOC_LABEL[kind].toLowerCase()}`} onClose={onClose} width="w-[980px]"
      footer={<><Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button variant="primary" size="sm" onClick={submit} disabled={save.isPending} data-testid="document-save">{save.isPending ? 'Saving…' : 'Save draft'}</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label={sales ? 'Customer' : 'Vendor'} className="col-span-2">
            <select value={head.contact_id} onChange={(e) => setHead((h) => ({ ...h, contact_id: e.target.value }))} className={selectCls} data-testid="document-contact">
              <option value="">Select…</option>
              {(contacts.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.display_name}{c.gstin ? ` · ${c.gstin}` : ''}</option>)}
            </select>
          </Field>
          <Field label="Date"><input type="date" value={head.date} onChange={(e) => setHead((h) => ({ ...h, date: e.target.value }))} className={inputCls} /></Field>
          <Field label="Due date"><input type="date" value={head.due_date} onChange={(e) => setHead((h) => ({ ...h, due_date: e.target.value }))} className={inputCls} /></Field>
          <Field label="Reference"><input value={head.reference_no} onChange={(e) => setHead((h) => ({ ...h, reference_no: e.target.value }))} className={inputCls} /></Field>
          <Field label="Currency">
            <select value={currency} onChange={(e) => setHead((h) => ({ ...h, currency: e.target.value }))} className={selectCls}>
              {[...new Set([baseCurrency, currency, 'USD', 'EUR', 'GBP', 'AED'])].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          {currency !== baseCurrency ? <Field label={`Rate (1 ${currency} = ? ${baseCurrency})`}><input value={head.exchange_rate} onChange={(e) => setHead((h) => ({ ...h, exchange_rate: e.target.value }))} className={inputCls} inputMode="decimal" /></Field> : null}
          <Field label="Place of supply" hint={interState ? 'Inter-state → IGST' : 'Intra-state → CGST + SGST'}>
            <input value={pos} onChange={(e) => setHead((h) => ({ ...h, place_of_supply: e.target.value }))} className={inputCls} maxLength={2} placeholder="33" />
          </Field>
        </div>

        <div className="border border-neutral-200 rounded overflow-x-auto">
          <table className="w-full border-collapse" style={{ minWidth: 860 }}>
            <thead>
              <tr className="border-b border-neutral-200">
                {['Item / description', 'HSN', 'Qty', 'Rate', 'Disc %', 'GST', 'Account', 'Amount', ''].map((h) => (
                  <th key={h} className="h-8 px-2 text-11 uppercase tracking-[0.06em] font-medium text-neutral-500 text-left whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.key} className="border-b border-neutral-200 last:border-0 align-top">
                  <td className="px-2 py-1 min-w-[220px]">
                    <select value={l.item_id} onChange={(e) => pickItem(l.key, e.target.value)} className={`${selectCls} mb-1`}>
                      <option value="">Custom line…</option>
                      {(items.data?.items ?? []).map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                    </select>
                    <input value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} placeholder="Description" className={inputCls} data-testid={`line-description-${i}`} />
                  </td>
                  <td className="px-2 py-1 w-[90px]"><input value={l.hsn_sac} onChange={(e) => setLine(l.key, { hsn_sac: e.target.value })} className={inputCls} /></td>
                  <td className="px-2 py-1 w-[70px]"><input value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value.replace(/[^\d.]/g, '') })} className={`${inputCls} text-right tabular-nums`} inputMode="decimal" /></td>
                  <td className="px-2 py-1 w-[110px]"><MoneyInput value={l.rate} onChange={(v) => setLine(l.key, { rate: v })} data-testid={`line-rate-${i}`} /></td>
                  <td className="px-2 py-1 w-[70px]"><input value={l.discount_percent_bp} onChange={(e) => setLine(l.key, { discount_percent_bp: e.target.value.replace(/[^\d.]/g, '') })} className={`${inputCls} text-right tabular-nums`} inputMode="decimal" /></td>
                  <td className="px-2 py-1 w-[120px]">
                    <select value={l.tax_rate_id || items.data?.items.find((x) => x.id === l.item_id)?.tax_rate_id || ''} onChange={(e) => setLine(l.key, { tax_rate_id: e.target.value })} className={selectCls} disabled={gstExempt}>
                      <option value="">None</option>
                      {gstRates.map((t) => <option key={t.id} value={t.id}>{bp(t.percentage_bp)}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1 w-[150px]">
                    <select value={l.ledger_id} onChange={(e) => setLine(l.key, { ledger_id: e.target.value })} className={selectCls}>
                      <option value="">Default</option>
                      {(ledgers.data?.items ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1 text-right whitespace-nowrap"><Money value={totals.rows[i]?.total ?? 0} currency={currency} zero="0" /></td>
                  <td className="px-1 py-1">
                    <button type="button" onClick={() => setLines((ls) => (ls.length === 1 ? [emptyLine()] : ls.filter((x) => x.key !== l.key)))} className="text-neutral-400 hover:text-red" aria-label="Remove line"><X size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={() => setLines((ls) => [...ls, emptyLine()])} className="inline-flex items-center gap-1 h-8 px-3 text-12 text-neutral-700 hover:text-neutral-900" data-testid="line-add">
            <Plus size={14} strokeWidth={2} />Add line
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Discount on total (%)" className="w-[150px]"><input value={head.discount_percent_bp} onChange={(e) => setHead((h) => ({ ...h, discount_percent_bp: e.target.value.replace(/[^\d.]/g, '') }))} className={`${inputCls} text-right tabular-nums`} inputMode="decimal" /></Field>
              <label className="flex items-center gap-2 text-13 text-neutral-900 h-8"><input type="checkbox" checked={head.tax_inclusive} onChange={(e) => setHead((h) => ({ ...h, tax_inclusive: e.target.checked }))} className="accent-[#C8952E]" />Rates include GST</label>
            </div>
            {kind === 'bill' ? (
              <Field label="TDS section" hint={contact && !contact.pan ? 'No PAN on file — the higher rate applies' : undefined}>
                <select value={head.tds_rate_id} onChange={(e) => setHead((h) => ({ ...h, tds_rate_id: e.target.value }))} className={selectCls} data-testid="document-tds">
                  <option value="">No TDS</option>
                  {tdsRates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
            ) : null}
            <Field label="Notes"><textarea value={head.notes} onChange={(e) => setHead((h) => ({ ...h, notes: e.target.value }))} rows={2} className={`${inputCls} h-auto py-1`} /></Field>
          </div>

          <div className="bg-neutral-50 border border-neutral-200 rounded p-3 text-13" data-testid="document-totals">
            <Line label="Subtotal" value={totals.subtotal} currency={currency} />
            {totals.discount > 0 ? <Line label="Discount" value={-totals.discount} currency={currency} /> : null}
            <Line label="Taxable value" value={totals.taxable} currency={currency} bold />
            {interState ? <Line label="IGST" value={totals.igst} currency={currency} /> : <><Line label="CGST" value={totals.cgst} currency={currency} /><Line label="SGST" value={totals.sgst} currency={currency} /></>}
            {totals.roundOff !== 0 ? <Line label="Round off" value={totals.roundOff} currency={currency} /> : null}
            <div className="border-t border-neutral-300 mt-2 pt-2"><Line label="Total" value={totals.total} currency={currency} bold /></div>
            {totals.tds > 0 ? <><Line label="Less: TDS" value={-totals.tds} currency={currency} /><Line label="Payable to vendor" value={totals.payable} currency={currency} bold /></> : null}
          </div>
        </div>

        {error ? <Notice tone="error">{error}</Notice> : (
          <Notice>Saving creates a draft — nothing reaches the ledger until you post it. {kind === 'retainer_invoice' ? 'A retainer posts to Unearned Revenue; revenue is recognised only when you apply it to an invoice.' : ''}</Notice>
        )}
      </div>
    </Modal>
  );
}

function Line({ label, value, currency, bold }: { label: string; value: number; currency: string; bold?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-0.5">
      <span className={bold ? 'text-neutral-900 font-medium' : 'text-neutral-500'}>{label}</span>
      <Money value={value} currency={currency} bold={bold} zero="0" />
    </div>
  );
}
