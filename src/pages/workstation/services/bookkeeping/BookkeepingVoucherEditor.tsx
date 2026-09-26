import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Wand2 } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import {
  bookkeepingApi, bookkeepingAccountingApi,
  type BookkeepingLedger, type BookkeepingVoucherType, type CreateVoucherInput, type BookkeepingStockItem,
} from '@/modules/tools/audit-automation/bookkeeping';
import { Money, Panel, Loading, usePeriod, ErrorNote } from '@/modules/tools/bookkeeping/ui';
import type { ApiError } from '@/services/api';

/**
 * Voucher entry — /vouchers/new and /vouchers/:voucherId/edit.
 *
 * The screen keeps the accountant's grammar: pick a voucher type, key the
 * debit and credit lines, watch the difference reach zero. The Dr/Cr
 * totals update as you type and the Save button stays disabled while the
 * voucher is out of balance — the same rule the server enforces, shown
 * early rather than as a rejection.
 *
 * For sales and purchase vouchers the item grid can BUILD the accounting
 * lines: taxable value to the sales/purchase ledger, tax to the GST
 * ledgers, total to the party. The generated lines stay editable.
 */

interface EntryDraft {
  key: string;
  ledgerId: string;
  entryType: 'dr' | 'cr';
  amountRupees: string;
  narration: string;
  billRef: string;
}

interface ItemDraft {
  key: string;
  stockItemId: string;
  qty: string;
  rate: string;
  discountPct: string;
  godownId: string;
}

const uid = () => Math.random().toString(36).slice(2, 9);
const emptyEntry = (): EntryDraft => ({ key: uid(), ledgerId: '', entryType: 'dr', amountRupees: '', narration: '', billRef: '' });
const emptyItem = (): ItemDraft => ({ key: uid(), stockItemId: '', qty: '', rate: '', discountPct: '', godownId: '' });
const toPaise = (v: string) => Math.round((Number(String(v).replace(/[₹,\s]/g, '')) || 0) * 100);
const toMilli = (v: string) => Math.round((Number(String(v).replace(/[,\s]/g, '')) || 0) * 1000);

export function BookkeepingVoucherEditor() {
  const { companyId = '', voucherId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { from } = usePeriod();
  const isEdit = Boolean(voucherId);
  const base = `/tally/companies/${companyId}`;

  const typesQ = useQuery({ queryKey: ['tally.voucherTypes', companyId], queryFn: () => bookkeepingAccountingApi.listVoucherTypes(companyId) });
  const ledgersQ = useQuery({ queryKey: ['tally.ledgers', companyId, ''], queryFn: () => bookkeepingApi.listLedgers(companyId) });
  const groupsQ = useQuery({ queryKey: ['tally.groups', companyId], queryFn: () => bookkeepingApi.listGroups(companyId) });
  const itemsQ = useQuery({ queryKey: ['tally.stockItems', companyId], queryFn: () => bookkeepingAccountingApi.listStockItems(companyId) });
  const godownsQ = useQuery({ queryKey: ['tally.godowns', companyId], queryFn: () => bookkeepingAccountingApi.listGodowns(companyId) });
  const existingQ = useQuery({
    queryKey: ['tally.voucher', companyId, voucherId],
    enabled: isEdit,
    queryFn: () => bookkeepingAccountingApi.getVoucher(companyId, voucherId!),
  });

  const [typeId, setTypeId] = useState('');
  const [date, setDate] = useState(() => params.get('date') || new Date().toISOString().slice(0, 10));
  const [voucherNumber, setVoucherNumber] = useState('');
  const [reference, setReference] = useState('');
  const [narration, setNarration] = useState('');
  const [partyLedgerId, setPartyLedgerId] = useState('');
  const [placeOfSupply, setPlaceOfSupply] = useState('');
  const [entries, setEntries] = useState<EntryDraft[]>([emptyEntry(), emptyEntry()]);
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const types = typesQ.data?.items ?? [];
  const ledgers = ledgersQ.data?.items ?? [];
  const activeType: BookkeepingVoucherType | undefined = types.find((t) => t.id === typeId);

  // Pick a sensible default type: the one asked for in the URL, else Payment.
  useEffect(() => {
    if (typeId || !types.length) return;
    const wanted = params.get('type');
    setTypeId((wanted ? types.find((t) => t.code === wanted)?.id : undefined) ?? types.find((t) => t.code === 'payment')?.id ?? types[0].id);
  }, [types, typeId, params]);

  // Load an existing voucher into the form.
  useEffect(() => {
    const v = existingQ.data;
    if (!v) return;
    setTypeId(v.voucher_type_id);
    setDate(v.date);
    setVoucherNumber(v.voucher_number);
    setReference(v.reference_number ?? '');
    setNarration(v.narration ?? '');
    setPartyLedgerId(v.party_ledger_id ?? '');
    setPlaceOfSupply(v.place_of_supply ?? '');
    setEntries((v.entries ?? []).map((e) => ({
      key: uid(), ledgerId: e.ledger_id, entryType: e.entry_type,
      amountRupees: (e.amount_paise / 100).toFixed(2), narration: e.narration ?? '',
      billRef: e.bill_allocations[0]?.bill_ref ?? '',
    })));
    setItems((v.items ?? []).map((i) => ({
      key: uid(), stockItemId: i.stock_item_id, qty: String(i.qty_milli / 1000),
      rate: (i.rate_paise / 100).toFixed(2), discountPct: String(i.discount_pct || ''), godownId: i.godown_id ?? '',
    })));
  }, [existingQ.data]);

  const totals = useMemo(() => {
    const dr = entries.filter((e) => e.entryType === 'dr').reduce((s, e) => s + toPaise(e.amountRupees), 0);
    const cr = entries.filter((e) => e.entryType === 'cr').reduce((s, e) => s + toPaise(e.amountRupees), 0);
    return { dr, cr, diff: dr - cr };
  }, [entries]);

  const save = useMutation({
    mutationFn: () => {
      const payload: CreateVoucherInput = {
        voucher_type_id: typeId,
        date,
        voucher_number: voucherNumber.trim() || undefined,
        reference_number: reference.trim() || null,
        narration: narration.trim() || null,
        party_ledger_id: partyLedgerId || null,
        place_of_supply: placeOfSupply.trim() || null,
        entries: activeType?.affects_accounts
          ? entries.filter((e) => e.ledgerId && toPaise(e.amountRupees) > 0).map((e) => ({
              ledger_id: e.ledgerId,
              entry_type: e.entryType,
              amount_paise: toPaise(e.amountRupees),
              narration: e.narration.trim() || null,
              is_party_ledger: e.ledgerId === partyLedgerId,
              bill_allocations: e.billRef.trim()
                ? [{
                    bill_ref: e.billRef.trim(),
                    method: (e.ledgerId === partyLedgerId && (activeType?.code === 'sales' || activeType?.code === 'purchase') ? 'new' : 'against') as 'new' | 'against',
                    amount_paise: toPaise(e.amountRupees),
                  }]
                : undefined,
            }))
          : undefined,
        items: items.filter((i) => i.stockItemId && toMilli(i.qty) > 0).map((i) => {
          const item = itemsQ.data?.items.find((x) => x.id === i.stockItemId);
          const qtyMilli = toMilli(i.qty);
          const ratePaise = toPaise(i.rate);
          const gross = Math.round((ratePaise * qtyMilli) / 1000);
          const discount = Math.round((gross * (Number(i.discountPct) || 0)) / 100);
          return {
            stock_item_id: i.stockItemId,
            godown_id: i.godownId || null,
            direction: inwardType(activeType?.code) ? ('in' as const) : ('out' as const),
            qty_milli: qtyMilli,
            rate_paise: ratePaise,
            discount_pct: Number(i.discountPct) || 0,
            amount_paise: gross - discount,
            hsn_code: item?.hsn_code ?? null,
            gst_rate_bp: item?.gst_rate_bp ?? 0,
            ...splitTax(gross - discount, item?.gst_rate_bp ?? 0, isInterState(placeOfSupply, ledgers, partyLedgerId)),
          };
        }),
      };
      return isEdit
        ? bookkeepingAccountingApi.updateVoucher(companyId, voucherId!, payload)
        : bookkeepingAccountingApi.createVoucher(companyId, payload);
    },
    onSuccess: async (v) => {
      await qc.invalidateQueries({ queryKey: ['tally.vouchers', companyId] });
      await qc.invalidateQueries({ queryKey: ['tally.dashboard', companyId] });
      toast.push('success', `${v.voucher_type_name ?? 'Voucher'} ${v.voucher_number} ${isEdit ? 'updated' : 'posted'}.`);
      navigate(`${base}/vouchers/${v.id}`);
    },
    onError: (e: ApiError) => setErr(e.message),
  });

  function submit() {
    setErr(null);
    if (!typeId) { setErr('Choose a voucher type.'); return; }
    if (activeType?.affects_accounts) {
      const usable = entries.filter((e) => e.ledgerId && toPaise(e.amountRupees) > 0);
      if (usable.length < 2) { setErr('An accounting voucher needs at least one debit and one credit line.'); return; }
      if (totals.diff !== 0) { setErr('Debits must equal credits before this voucher can be saved.'); return; }
    }
    if (activeType?.affects_stock && !activeType.affects_accounts && !items.some((i) => i.stockItemId)) {
      setErr('This voucher type needs at least one stock line.'); return;
    }
    save.mutate();
  }

  /** Build the accounting lines from the item grid (sales / purchase). */
  function buildFromItems() {
    const list = itemsQ.data?.items ?? [];
    const interState = isInterState(placeOfSupply, ledgers, partyLedgerId);
    let taxable = 0, cgst = 0, sgst = 0, igst = 0;
    for (const i of items) {
      const item = list.find((x) => x.id === i.stockItemId);
      if (!item || !toMilli(i.qty)) continue;
      const gross = Math.round((toPaise(i.rate) * toMilli(i.qty)) / 1000);
      const net = gross - Math.round((gross * (Number(i.discountPct) || 0)) / 100);
      const tax = splitTax(net, item.gst_rate_bp, interState);
      taxable += net; cgst += tax.cgst_paise; sgst += tax.sgst_paise; igst += tax.igst_paise;
    }
    if (!taxable) { setErr('Add at least one item line with a quantity and a rate first.'); return; }
    const isSale = activeType?.code === 'sales' || activeType?.code === 'credit_note';
    const tradeLedger = ledgers.find((l) => groupNameOf(l, groupsQ.data?.items ?? []) === (isSale ? 'Sales Accounts' : 'Purchase Accounts'));
    if (!tradeLedger) { setErr(`Create a ledger under ${isSale ? 'Sales Accounts' : 'Purchase Accounts'} first.`); return; }
    if (!partyLedgerId) { setErr('Choose the party ledger first.'); return; }

    const taxLedger = (component: string) => ledgers.find((l) => {
      const cfg = l.tax_config as { gst_component?: string; gst_direction?: string } | null;
      return cfg?.gst_component === component && cfg?.gst_direction === (isSale ? 'output' : 'input');
    });

    const rows: EntryDraft[] = [];
    const total = taxable + cgst + sgst + igst;
    const money = (p: number) => (p / 100).toFixed(2);
    if (isSale) {
      rows.push({ key: uid(), ledgerId: partyLedgerId, entryType: 'dr', amountRupees: money(total), narration: '', billRef: voucherNumber });
      rows.push({ key: uid(), ledgerId: tradeLedger.id, entryType: 'cr', amountRupees: money(taxable), narration: '', billRef: '' });
    } else {
      rows.push({ key: uid(), ledgerId: tradeLedger.id, entryType: 'dr', amountRupees: money(taxable), narration: '', billRef: '' });
    }
    for (const [component, amount] of [['cgst', cgst], ['sgst', sgst], ['igst', igst]] as const) {
      if (!amount) continue;
      const led = taxLedger(component);
      if (!led) { setErr(`No ${isSale ? 'Output' : 'Input'} ${component.toUpperCase()} ledger found.`); return; }
      rows.push({ key: uid(), ledgerId: led.id, entryType: isSale ? 'cr' : 'dr', amountRupees: money(amount), narration: '', billRef: '' });
    }
    if (!isSale) {
      rows.push({ key: uid(), ledgerId: partyLedgerId, entryType: 'cr', amountRupees: money(total), narration: '', billRef: reference || voucherNumber });
    }
    setEntries(rows);
    setErr(null);
  }

  if (typesQ.isLoading || ledgersQ.isLoading || (isEdit && existingQ.isLoading)) return <Loading />;

  const showItems = Boolean(activeType?.affects_stock);
  const showParty = ['sales', 'purchase', 'receipt', 'payment', 'debit_note', 'credit_note', 'sales_order', 'purchase_order', 'delivery_note', 'receipt_note', 'quotation'].includes(activeType?.code ?? '');

  return (
    <div data-testid="tally-voucher-editor">
      <header className="flex items-start justify-between gap-4 mb-4 flex-wrap">
        <div>
          <h2 className="text-16 font-semibold text-neutral-900">{isEdit ? 'Alter voucher' : 'New voucher'}</h2>
          <p className="text-12 text-neutral-500 mt-0.5">
            {isEdit
              ? 'Altering a posted voucher is recorded in the audit trail with a before-and-after snapshot.'
              : 'The voucher is validated and posted server-side; the balances update the moment it saves.'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => navigate(-1)}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={save.isPending || (Boolean(activeType?.affects_accounts) && totals.diff !== 0)}>
            {save.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Post voucher'}
          </Button>
        </div>
      </header>

      {err ? <div className="mb-3"><ErrorNote message={err} /></div> : null}

      <Panel className="mb-3">
        <div className="p-3 grid grid-cols-1 md:grid-cols-4 gap-3">
          <Field label="Voucher type" required>
            <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className={inputCls} disabled={isEdit}>
              {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Date" required>
            <input type="date" value={date} min={from || undefined} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </Field>
          <Field label={`Voucher no.${activeType?.numbering_method === 'auto' ? ' (auto)' : ''}`}>
            <input
              value={voucherNumber} onChange={(e) => setVoucherNumber(e.target.value)}
              placeholder={activeType?.numbering_method === 'auto' ? `${activeType.prefix ?? ''}${String(activeType.current_number + 1).padStart(4, '0')}` : 'Required'}
              className={inputCls}
            />
          </Field>
          <Field label="Reference">
            <input value={reference} onChange={(e) => setReference(e.target.value)} className={inputCls} />
          </Field>
          {showParty ? (
            <Field label="Party">
              <select value={partyLedgerId} onChange={(e) => setPartyLedgerId(e.target.value)} className={inputCls}>
                <option value="">None</option>
                {ledgers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
          ) : null}
          {showItems ? (
            <Field label="Place of supply (state code)">
              <input value={placeOfSupply} onChange={(e) => setPlaceOfSupply(e.target.value)} placeholder="e.g. 33" className={inputCls} maxLength={2} />
            </Field>
          ) : null}
        </div>
      </Panel>

      {showItems ? (
        <Panel
          title="Items"
          className="mb-3"
          actions={
            <div className="flex gap-2">
              <button type="button" onClick={() => setItems((s) => [...s, emptyItem()])} className="text-12 text-gold hover:underline inline-flex items-center gap-1">
                <Plus size={12} /> Add item
              </button>
              {activeType?.affects_accounts ? (
                <button type="button" onClick={buildFromItems} className="text-12 text-gold hover:underline inline-flex items-center gap-1">
                  <Wand2 size={12} /> Build entries from items
                </button>
              ) : null}
            </div>
          }
        >
          {items.length === 0 ? (
            <div className="px-3 py-4 text-13 text-neutral-500">No item lines. Add one to move stock with this voucher.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-13" style={{ minWidth: '720px' }}>
                <thead>
                  <tr className="text-left text-11 text-neutral-500 border-b border-neutral-100">
                    <th className="px-3 py-2 font-normal">ITEM</th>
                    <th className="px-3 py-2 font-normal">GODOWN</th>
                    <th className="px-3 py-2 font-normal text-right">QTY</th>
                    <th className="px-3 py-2 font-normal text-right">RATE</th>
                    <th className="px-3 py-2 font-normal text-right">DISC %</th>
                    <th className="px-3 py-2 font-normal text-right">AMOUNT</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((i, idx) => {
                    const gross = Math.round((toPaise(i.rate) * toMilli(i.qty)) / 1000);
                    const net = gross - Math.round((gross * (Number(i.discountPct) || 0)) / 100);
                    return (
                      <tr key={i.key} className="border-t border-neutral-100">
                        <td className="px-3 py-1.5">
                          <select
                            value={i.stockItemId}
                            onChange={(e) => setItems((s) => s.map((x, n) => (n === idx ? { ...x, stockItemId: e.target.value, rate: x.rate || defaultRate(itemsQ.data?.items ?? [], e.target.value, activeType?.code) } : x)))}
                            className={cellCls}
                          >
                            <option value="">Select…</option>
                            {(itemsQ.data?.items ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-1.5">
                          <select value={i.godownId} onChange={(e) => setItems((s) => s.map((x, n) => (n === idx ? { ...x, godownId: e.target.value } : x)))} className={cellCls}>
                            <option value="">—</option>
                            {(godownsQ.data?.items ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-1.5"><input value={i.qty} onChange={(e) => setItems((s) => s.map((x, n) => (n === idx ? { ...x, qty: e.target.value } : x)))} className={`${cellCls} text-right font-mono`} /></td>
                        <td className="px-3 py-1.5"><input value={i.rate} onChange={(e) => setItems((s) => s.map((x, n) => (n === idx ? { ...x, rate: e.target.value } : x)))} className={`${cellCls} text-right font-mono`} /></td>
                        <td className="px-3 py-1.5"><input value={i.discountPct} onChange={(e) => setItems((s) => s.map((x, n) => (n === idx ? { ...x, discountPct: e.target.value } : x)))} className={`${cellCls} text-right font-mono`} /></td>
                        <td className="px-3 py-1.5 text-right"><Money paise={net} /></td>
                        <td className="px-2">
                          <button type="button" onClick={() => setItems((s) => s.filter((_, n) => n !== idx))} className="text-neutral-400 hover:text-danger" aria-label="Remove line">
                            <Trash2 size={13} strokeWidth={1.75} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : null}

      {activeType?.affects_accounts ? (
        <Panel
          title="Accounting entries"
          actions={
            <button type="button" onClick={() => setEntries((s) => [...s, emptyEntry()])} className="text-12 text-gold hover:underline inline-flex items-center gap-1">
              <Plus size={12} /> Add line
            </button>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full text-13" style={{ minWidth: '720px' }}>
              <thead>
                <tr className="text-left text-11 text-neutral-500 border-b border-neutral-100">
                  <th className="px-3 py-2 font-normal">LEDGER</th>
                  <th className="px-3 py-2 font-normal w-[90px]">DR / CR</th>
                  <th className="px-3 py-2 font-normal text-right w-[140px]">AMOUNT (₹)</th>
                  <th className="px-3 py-2 font-normal">BILL REF</th>
                  <th className="px-3 py-2 font-normal">LINE NARRATION</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {entries.map((e, idx) => (
                  <tr key={e.key} className="border-t border-neutral-100">
                    <td className="px-3 py-1.5">
                      <select value={e.ledgerId} onChange={(ev) => setEntries((s) => s.map((x, n) => (n === idx ? { ...x, ledgerId: ev.target.value } : x)))} className={cellCls} data-testid={`entry-ledger-${idx}`}>
                        <option value="">Select ledger…</option>
                        {ledgers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-1.5">
                      <select value={e.entryType} onChange={(ev) => setEntries((s) => s.map((x, n) => (n === idx ? { ...x, entryType: ev.target.value as 'dr' | 'cr' } : x)))} className={`${cellCls} uppercase`}>
                        <option value="dr">Dr</option>
                        <option value="cr">Cr</option>
                      </select>
                    </td>
                    <td className="px-3 py-1.5">
                      <input
                        value={e.amountRupees}
                        onChange={(ev) => setEntries((s) => s.map((x, n) => (n === idx ? { ...x, amountRupees: ev.target.value } : x)))}
                        className={`${cellCls} text-right font-mono`} placeholder="0.00"
                        data-testid={`entry-amount-${idx}`}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <input value={e.billRef} onChange={(ev) => setEntries((s) => s.map((x, n) => (n === idx ? { ...x, billRef: ev.target.value } : x)))} className={cellCls} placeholder="optional" />
                    </td>
                    <td className="px-3 py-1.5">
                      <input value={e.narration} onChange={(ev) => setEntries((s) => s.map((x, n) => (n === idx ? { ...x, narration: ev.target.value } : x)))} className={cellCls} />
                    </td>
                    <td className="px-2">
                      <button type="button" onClick={() => setEntries((s) => s.filter((_, n) => n !== idx))} className="text-neutral-400 hover:text-danger" aria-label="Remove line">
                        <Trash2 size={13} strokeWidth={1.75} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-neutral-200">
                <tr>
                  <td className="px-3 py-2 text-12 text-neutral-500" colSpan={2}>Totals</td>
                  <td className="px-3 py-2 text-right">
                    <div className="text-12 text-neutral-500">Dr <Money paise={totals.dr} /></div>
                    <div className="text-12 text-neutral-500">Cr <Money paise={totals.cr} /></div>
                  </td>
                  <td className="px-3 py-2" colSpan={3}>
                    {totals.diff === 0 ? (
                      <span className="text-12 text-emerald-700">Balanced</span>
                    ) : (
                      <span className="text-12 text-danger" data-testid="voucher-difference">
                        Out of balance by ₹{(Math.abs(totals.diff) / 100).toFixed(2)} ({totals.diff > 0 ? 'excess debit' : 'excess credit'})
                      </span>
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Panel>
      ) : null}

      <div className="mt-3">
        <Panel title="Narration">
          <div className="p-3">
            <textarea value={narration} onChange={(e) => setNarration(e.target.value)} rows={2} className="w-full px-2 py-1 text-13 border border-neutral-300 rounded focus:outline-none focus:border-gold" placeholder="What this voucher is for." />
          </div>
        </Panel>
      </div>
    </div>
  );
}

const inputCls = 'h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold';
const cellCls = 'h-8 w-full px-1.5 text-13 border border-neutral-200 rounded bg-white focus:outline-none focus:border-gold';

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-12 font-medium text-neutral-700 mb-1">{label}{required ? <span className="text-danger"> *</span> : null}</span>
      {children}
    </label>
  );
}

/** Purchases, receipt notes and rejections-in bring stock IN; the rest send it out. */
function inwardType(code?: string): boolean {
  return ['purchase', 'receipt_note', 'rejections_in', 'credit_note', 'physical_stock'].includes(code ?? '');
}

function splitTax(taxablePaise: number, rateBp: number, interState: boolean) {
  const total = Math.round((taxablePaise * rateBp) / 10000);
  if (!rateBp) return { cgst_paise: 0, sgst_paise: 0, igst_paise: 0 };
  if (interState) return { cgst_paise: 0, sgst_paise: 0, igst_paise: total };
  const half = Math.round(total / 2);
  return { cgst_paise: half, sgst_paise: total - half, igst_paise: 0 };
}

/** Inter-state when the party's GSTIN state code differs from the place of supply. */
function isInterState(placeOfSupply: string, ledgers: BookkeepingLedger[], partyLedgerId: string): boolean {
  if (!placeOfSupply) return false;
  const party = ledgers.find((l) => l.id === partyLedgerId);
  const partyState = party?.gstin?.slice(0, 2);
  return Boolean(partyState && partyState !== placeOfSupply);
}

function groupNameOf(ledger: BookkeepingLedger, groups: { id: string; name: string }[]): string {
  return groups.find((g) => g.id === ledger.group_id)?.name ?? '';
}

function defaultRate(items: BookkeepingStockItem[], id: string, typeCode?: string): string {
  const item = items.find((i) => i.id === id);
  if (!item) return '';
  const paise = inwardType(typeCode) ? item.standard_cost_paise : item.standard_price_paise;
  return paise ? (paise / 100).toFixed(2) : '';
}
