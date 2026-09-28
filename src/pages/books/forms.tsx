import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { booksApi, errorText, type ZRecord } from '@/modules/books/api';
import { useOrg } from '@/modules/books/context';
import { Btn, Field, Modal, Notice, NumberInput, Select, TextArea, TextInput, inputCls, money, today } from '@/modules/books/ui';

/**
 * Record forms for the Books tool. Each builds the JSON body the Zoho Books
 * API documents for that resource and sends it through Audit OS; Zoho
 * validates and computes (taxes, totals, numbering). A rejection is shown
 * as Zoho's own message — the form never claims success on its own.
 */

// ── lookups ───────────────────────────────────────────────────────────────
export function useLookup(entity: string, params: Record<string, string> = {}, enabled = true) {
  const org = useOrg();
  return useQuery({
    queryKey: ['books', org.id, 'lookup', entity, params],
    queryFn: () => booksApi.org(org.id).list(entity, { per_page: 200, ...params }),
    staleTime: 5 * 60_000,
    enabled,
  });
}

function useDebounced<T>(v: T, ms = 300): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/** A searchable picker backed by a server-side Zoho search. */
export function SearchPicker({ entity, params = {}, value, label, onChange, idField, nameField, placeholder = 'Search…', disabled }: {
  entity: string; params?: Record<string, string>; value: string; label: string; onChange: (id: string, rec: ZRecord | null) => void;
  idField: string; nameField: string; placeholder?: string; disabled?: boolean;
}) {
  const org = useOrg();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const q = useDebounced(text);
  const box = useRef<HTMLDivElement>(null);
  const res = useQuery({
    queryKey: ['books', org.id, 'search', entity, params, q],
    queryFn: () => booksApi.org(org.id).list(entity, { per_page: 25, ...params, search_text: q || undefined }),
    enabled: open, staleTime: 60_000,
  });
  useEffect(() => {
    const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div ref={box} className="relative">
      <input className={inputCls} disabled={disabled} placeholder={value ? label : placeholder} value={open ? text : label}
        onFocus={() => { setOpen(true); setText(''); }} onChange={(e) => setText(e.target.value)} />
      {open ? (
        <div className="absolute z-50 mt-1 w-full max-h-64 overflow-y-auto bg-surface border border-border rounded shadow-card">
          {res.isLoading ? <div className="px-3 py-2 text-12 text-inkMuted">Searching…</div> : null}
          {res.isError ? <div className="px-3 py-2 text-12 text-danger">{errorText(res.error)}</div> : null}
          {value ? <button type="button" className="block w-full text-left px-3 py-1.5 text-12 text-inkMuted hover:bg-canvas" onClick={() => { onChange('', null); setOpen(false); }}>Clear</button> : null}
          {(res.data?.items ?? []).map((r) => (
            <button type="button" key={r[idField]} className="block w-full text-left px-3 py-1.5 text-13 text-ink hover:bg-canvas"
              onClick={() => { onChange(String(r[idField]), r); setOpen(false); }}>
              {r[nameField]}{r.company_name && r.company_name !== r[nameField] ? <span className="text-inkMuted"> · {r.company_name}</span> : null}
            </button>
          ))}
          {res.data && res.data.items.length === 0 ? <div className="px-3 py-2 text-12 text-inkMuted">No matches.</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export const ContactPicker = ({ kind, value, label, onChange, disabled }: { kind: 'customer' | 'vendor'; value: string; label: string; onChange: (id: string, rec: ZRecord | null) => void; disabled?: boolean }) =>
  <SearchPicker entity={kind === 'customer' ? 'customers' : 'vendors'} idField="contact_id" nameField="contact_name" value={value} label={label} onChange={onChange} disabled={disabled} placeholder={`Search ${kind}s…`} />;

function useTaxOptions() {
  const t = useLookup('taxes');
  return useMemo(() => (t.data?.items ?? []).map((x) => ({ value: String(x.tax_id), label: `${x.tax_name} (${x.tax_percentage}%)` })), [t.data]);
}
export function useAccountOptions(filter: (a: ZRecord) => boolean) {
  const a = useLookup('accounts', { filter_by: 'AccountType.Active' });
  return useMemo(() => (a.data?.items ?? []).filter(filter).map((x) => ({ value: String(x.account_id), label: x.account_name })), [a.data, filter]);
}
const isExpenseAcct = (a: ZRecord) => ['expense', 'cost_of_goods_sold', 'other_expense', 'fixed_asset', 'other_current_asset'].includes(a.account_type);
const isIncomeAcct = (a: ZRecord) => ['income', 'other_income'].includes(a.account_type);
const isCashAcct = (a: ZRecord) => ['bank', 'cash', 'credit_card', 'other_current_liability', 'payment_clearing'].includes(a.account_type);
export { isExpenseAcct, isIncomeAcct, isCashAcct };

/** Shared save plumbing: create or update, toast, invalidate the org's cached queries. */
function useSave(entity: string, id: string | undefined, onDone: (rec: ZRecord) => void) {
  const org = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: ZRecord) => (id ? booksApi.org(org.id).update(entity, id, body) : booksApi.org(org.id).create(entity, body)),
    onSuccess: (rec) => {
      void qc.invalidateQueries({ queryKey: ['books', org.id] });
      toast.push('success', id ? 'Saved to Zoho Books.' : 'Created in Zoho Books.');
      onDone(rec);
    },
  });
}

function FormModal({ title, onClose, onSubmit, saving, error, children, wide }: { title: string; onClose: () => void; onSubmit: () => void; saving: boolean; error: unknown; children: ReactNode; wide?: boolean }) {
  return (
    <Modal title={title} onClose={onClose} wide={wide} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" loading={saving} onClick={onSubmit}>Save</Btn></>}>
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }} className="space-y-4">
        {error ? <Notice tone="error">{errorText(error)}</Notice> : null}
        {children}
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const n = (v: string) => (v.trim() === '' ? undefined : Number(v));

/**
 * Whether the Zoho organisation is registered for GST. Zoho rejects every GST
 * field (gst_treatment, gst_no, place_of_contact, hsn_or_sac…) with
 * "Invalid Element" on an organisation that is not — INR currency alone is
 * not enough. Unknown while loading, so GST fields stay hidden until known.
 */
export function useGstRegistered(): boolean {
  const org = useOrg();
  const q = useQuery({ queryKey: ['books', org.id, 'organization'], queryFn: () => booksApi.org(org.id).organization(), staleTime: 5 * 60_000 });
  return q.data?.is_registered_for_gst === true;
}

const NoGstNote = () => (
  <p className="text-12 text-inkMuted md:col-span-2">
    GST fields are hidden: this Zoho Books organisation is not registered for GST. Turn GST on in Zoho Books → Settings → Taxes → GST Settings, then they appear here.
  </p>
);

// ── contacts ──────────────────────────────────────────────────────────────
const GST_TREATMENTS = [
  { value: 'business_gst', label: 'Registered business (GST)' }, { value: 'business_none', label: 'Unregistered business' },
  { value: 'consumer', label: 'Consumer' }, { value: 'overseas', label: 'Overseas' },
];
function Address({ label, value, onChange }: { label: string; value: ZRecord; onChange: (v: ZRecord) => void }) {
  const f = (k: string) => (v: string) => onChange({ ...value, [k]: v });
  return (
    <fieldset className="space-y-2">
      <legend className="text-11 uppercase tracking-[0.06em] text-inkMuted mb-1">{label}</legend>
      <TextInput value={s(value.attention)} onChange={f('attention')} placeholder="Attention" />
      <TextInput value={s(value.address)} onChange={f('address')} placeholder="Street" />
      <div className="grid grid-cols-2 gap-2">
        <TextInput value={s(value.city)} onChange={f('city')} placeholder="City" />
        <TextInput value={s(value.state)} onChange={f('state')} placeholder="State" />
        <TextInput value={s(value.zip)} onChange={f('zip')} placeholder="PIN / ZIP" />
        <TextInput value={s(value.country)} onChange={f('country')} placeholder="Country" />
      </div>
    </fieldset>
  );
}

export function ContactForm({ kind, record, onClose, onSaved }: { kind: 'customer' | 'vendor'; record?: ZRecord; onClose: () => void; onSaved: (r: ZRecord) => void }) {
  const org = useOrg();
  const india = org.currency_code === 'INR';
  const gst = useGstRegistered();
  const primary = (record?.contact_persons as ZRecord[] | undefined)?.find((p) => p.is_primary_contact) ?? {};
  const [v, setV] = useState({
    contact_name: s(record?.contact_name), company_name: s(record?.company_name), website: s(record?.website),
    email: s(primary.email ?? record?.email), phone: s(primary.phone ?? record?.phone), payment_terms: s(record?.payment_terms),
    gst_treatment: s(record?.gst_treatment), gst_no: s(record?.gst_no), place_of_contact: s(record?.place_of_contact), notes: s(record?.notes),
  });
  const [billing, setBilling] = useState<ZRecord>(record?.billing_address ?? {});
  const [shipping, setShipping] = useState<ZRecord>(record?.shipping_address ?? {});
  const [err, setErr] = useState<string | null>(null);
  const save = useSave(kind === 'customer' ? 'customers' : 'vendors', record?.contact_id, onSaved);
  const set = (k: keyof typeof v) => (x: string) => setV({ ...v, [k]: x });
  const submit = () => {
    if (!v.contact_name.trim()) return setErr('Name is required.');
    if (v.gst_treatment === 'business_gst' && !/^[0-9A-Z]{15}$/.test(v.gst_no.trim().toUpperCase())) return setErr('A registered business needs a 15-character GSTIN.');
    setErr(null);
    const body: ZRecord = {
      contact_name: v.contact_name.trim(), company_name: v.company_name || undefined, website: v.website || undefined,
      payment_terms: n(v.payment_terms), notes: v.notes || undefined, billing_address: billing, shipping_address: shipping,
    };
    if (gst && v.gst_treatment) Object.assign(body, { gst_treatment: v.gst_treatment, gst_no: v.gst_no.toUpperCase() || undefined, place_of_contact: v.place_of_contact || undefined });
    // Contact persons are only sent on create: on update Zoho matches them by
    // id, and replacing the list could drop people added in Zoho.
    if (!record && (v.email || v.phone)) body.contact_persons = [{ first_name: v.contact_name.trim(), email: v.email || undefined, phone: v.phone || undefined, is_primary_contact: true }];
    save.mutate(body);
  };
  return (
    <FormModal title={`${record ? 'Edit' : 'New'} ${kind}`} onClose={onClose} onSubmit={submit} saving={save.isPending} error={err ?? save.error} wide>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Display name *"><TextInput value={v.contact_name} onChange={set('contact_name')} autoFocus /></Field>
        <Field label="Company name"><TextInput value={v.company_name} onChange={set('company_name')} /></Field>
        <Field label="Email" hint={record ? 'Contact persons are edited in Zoho Books.' : undefined}><TextInput type="email" value={v.email} onChange={set('email')} disabled={Boolean(record)} /></Field>
        <Field label="Phone"><TextInput value={v.phone} onChange={set('phone')} disabled={Boolean(record)} /></Field>
        <Field label="Website"><TextInput value={v.website} onChange={set('website')} /></Field>
        <Field label="Payment terms (days)"><NumberInput value={v.payment_terms} onChange={set('payment_terms')} /></Field>
        {india && !gst ? <NoGstNote /> : null}
        {gst ? <>
          <Field label="GST treatment"><Select value={v.gst_treatment} onChange={set('gst_treatment')} options={GST_TREATMENTS} placeholder="—" /></Field>
          <Field label="GSTIN"><TextInput value={v.gst_no} onChange={set('gst_no')} maxLength={15} /></Field>
          <Field label="Place of supply (state code)" hint="Two-letter state code, e.g. TN (Tamil Nadu), KA, MH, DL"><TextInput value={v.place_of_contact} onChange={set('place_of_contact')} maxLength={3} /></Field>
        </> : null}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Address label="Billing address" value={billing} onChange={setBilling} />
        <div>
          <Address label="Shipping address" value={shipping} onChange={setShipping} />
          <button type="button" className="text-12 text-inkMuted hover:text-ink mt-1" onClick={() => setShipping({ ...billing })}>Copy billing address</button>
        </div>
      </div>
      <Field label="Notes"><TextArea value={v.notes} onChange={set('notes')} /></Field>
    </FormModal>
  );
}

// ── items ─────────────────────────────────────────────────────────────────
export function ItemForm({ record, onClose, onSaved }: { record?: ZRecord; onClose: () => void; onSaved: (r: ZRecord) => void }) {
  const gst = useGstRegistered();
  const taxes = useTaxOptions();
  const income = useAccountOptions(isIncomeAcct);
  const expense = useAccountOptions(isExpenseAcct);
  const [v, setV] = useState({
    name: s(record?.name), sku: s(record?.sku), unit: s(record?.unit), product_type: s(record?.product_type || 'service'), description: s(record?.description),
    rate: s(record?.rate), purchase_rate: s(record?.purchase_rate), purchase_description: s(record?.purchase_description), tax_id: s(record?.tax_id),
    hsn_or_sac: s(record?.hsn_or_sac), account_id: s(record?.account_id), purchase_account_id: s(record?.purchase_account_id),
    inter_tax_id: s(((record?.item_tax_preferences as ZRecord[] | undefined) ?? []).find((p) => p.tax_specification === 'inter')?.tax_id),
  });
  const [err, setErr] = useState<string | null>(null);
  const save = useSave('items', record?.item_id, onSaved);
  const set = (k: keyof typeof v) => (x: string) => setV({ ...v, [k]: x });
  /** On edit a cleared field is sent empty — left out, Zoho would keep the old value. */
  const clr = (x: string) => x.trim() || (record ? '' : undefined);
  const submit = () => {
    if (!v.name.trim()) return setErr('Name is required.');
    if (v.rate === '' || Number.isNaN(Number(v.rate))) return setErr('Selling price is required.');
    setErr(null);
    save.mutate({
      name: v.name.trim(), sku: clr(v.sku), unit: clr(v.unit), product_type: v.product_type, description: clr(v.description),
      rate: Number(v.rate), purchase_rate: n(v.purchase_rate), purchase_description: clr(v.purchase_description), tax_id: clr(v.tax_id),
      hsn_or_sac: gst ? clr(v.hsn_or_sac) : undefined, account_id: v.account_id || undefined, purchase_account_id: v.purchase_account_id || undefined,
      // Zoho picks the intra-state tax within the state and the inter-state one across states.
      item_tax_preferences: gst && (v.tax_id || v.inter_tax_id)
        ? [...(v.tax_id ? [{ tax_specification: 'intra', tax_id: v.tax_id }] : []), ...(v.inter_tax_id ? [{ tax_specification: 'inter', tax_id: v.inter_tax_id }] : [])]
        : undefined,
    });
  };
  return (
    <FormModal title={record ? 'Edit item' : 'New item'} onClose={onClose} onSubmit={submit} saving={save.isPending} error={err ?? save.error} wide>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Name *" className="md:col-span-2"><TextInput value={v.name} onChange={set('name')} autoFocus /></Field>
        <Field label="Type"><Select value={v.product_type} onChange={set('product_type')} options={[{ value: 'service', label: 'Service' }, { value: 'goods', label: 'Goods' }]} /></Field>
        <Field label="SKU"><TextInput value={v.sku} onChange={set('sku')} /></Field>
        <Field label="Unit"><TextInput value={v.unit} onChange={set('unit')} placeholder="e.g. pcs, hrs" /></Field>
        {gst ? <Field label={v.product_type === 'goods' ? 'HSN code' : 'SAC code'}><TextInput value={v.hsn_or_sac} onChange={set('hsn_or_sac')} /></Field> : <div />}
        <Field label="Selling price *"><NumberInput value={v.rate} onChange={set('rate')} /></Field>
        <Field label="Sales account"><Select value={v.account_id} onChange={set('account_id')} options={income} placeholder="Zoho default" /></Field>
        <Field label={gst ? 'Tax within the state' : 'Tax'}><Select value={v.tax_id} onChange={set('tax_id')} options={taxes} placeholder="None" /></Field>
        {gst ? <Field label="Tax to other states (IGST)"><Select value={v.inter_tax_id} onChange={set('inter_tax_id')} options={taxes} placeholder="None" /></Field> : null}
        <Field label="Cost price"><NumberInput value={v.purchase_rate} onChange={set('purchase_rate')} /></Field>
        <Field label="Purchase account"><Select value={v.purchase_account_id} onChange={set('purchase_account_id')} options={expense} placeholder="Zoho default" /></Field>
      </div>
      <Field label="Sales description"><TextArea value={v.description} onChange={set('description')} rows={2} /></Field>
      <Field label="Purchase description"><TextArea value={v.purchase_description} onChange={set('purchase_description')} rows={2} /></Field>
      <p className="text-12 text-inkMuted">Stock tracking is managed in Zoho (Inventory); Books edits the item’s sales and purchase details only.</p>
    </FormModal>
  );
}

// ── transactions (estimates, sales orders, invoices, POs, bills, credit/debit notes) ──
export interface TxnSpec {
  entity: string; idField: string; title: string; party: 'customer' | 'vendor'; numberField: string; numberLabel: string; numberRequired?: boolean;
  secondDate?: { field: string; label: string }; purchase?: boolean;
}
export const TXN: Record<string, TxnSpec> = {
  estimates: { entity: 'estimates', idField: 'estimate_id', title: 'estimate', party: 'customer', numberField: 'estimate_number', numberLabel: 'Estimate #', secondDate: { field: 'expiry_date', label: 'Expiry date' } },
  salesorders: { entity: 'salesorders', idField: 'salesorder_id', title: 'sales order', party: 'customer', numberField: 'salesorder_number', numberLabel: 'Sales order #', secondDate: { field: 'shipment_date', label: 'Expected shipment' } },
  invoices: { entity: 'invoices', idField: 'invoice_id', title: 'invoice', party: 'customer', numberField: 'invoice_number', numberLabel: 'Invoice #', secondDate: { field: 'due_date', label: 'Due date' } },
  creditnotes: { entity: 'creditnotes', idField: 'creditnote_id', title: 'credit note', party: 'customer', numberField: 'creditnote_number', numberLabel: 'Credit note #' },
  purchaseorders: { entity: 'purchaseorders', idField: 'purchaseorder_id', title: 'purchase order', party: 'vendor', numberField: 'purchaseorder_number', numberLabel: 'PO #', secondDate: { field: 'delivery_date', label: 'Delivery date' }, purchase: true },
  bills: { entity: 'bills', idField: 'bill_id', title: 'bill', party: 'vendor', numberField: 'bill_number', numberLabel: 'Bill #', numberRequired: true, secondDate: { field: 'due_date', label: 'Due date' }, purchase: true },
  vendorcredits: { entity: 'vendorcredits', idField: 'vendor_credit_id', title: 'debit note', party: 'vendor', numberField: 'vendor_credit_number', numberLabel: 'Debit note #', purchase: true },
};

interface Line {
  line_item_id?: string; item_id: string; item_label: string; account_id: string; description: string; quantity: string; rate: string; discount: string; tax_id: string;
  /** Line id in the source document when converting (estimate/SO → invoice, PO → bill). */
  src_line_id?: string;
  /** The item's GST taxes: CGST+SGST within the state, IGST across states. */
  prefs?: { intra?: string; inter?: string };
}
const blankLine = (): Line => ({ item_id: '', item_label: '', account_id: '', description: '', quantity: '1', rate: '', discount: '', tax_id: '' });
/** "10%" of `base`, or a flat amount. */
const discountOf = (base: number, raw: string) => {
  const d = raw.trim();
  return d.endsWith('%') ? base * (Number(d.slice(0, -1)) || 0) / 100 : Number(d) || 0;
};
const lineGross = (l: Line) => (Number(l.quantity) || 0) * (Number(l.rate) || 0);
const hasValue = (raw: string) => raw.trim() !== '' && Number(raw.trim().replace(/%$/, '')) !== 0;

/** Zoho documents `discount_type` / `place_of_supply` only on these. */
const DISCOUNT_TYPE_DOCS = new Set(['invoices', 'estimates', 'salesorders']);
const PLACE_OF_SUPPLY_DOCS = new Set(['invoices', 'estimates', 'salesorders']);

/** The organisation's home state code (e.g. "TN") and whether it is GST-registered. */
function useOrgGst() {
  const org = useOrg();
  const q = useQuery({ queryKey: ['books', org.id, 'organization'], queryFn: () => booksApi.org(org.id).organization(), staleTime: 5 * 60_000 });
  const address = (q.data?.address ?? {}) as ZRecord;
  return { gst: q.data?.is_registered_for_gst === true, home: s(address.state_code).toUpperCase() };
}

/** The item's intra/inter tax for this supply; falls back to the item's single tax. */
function taxFor(prefs: Line['prefs'], fallback: string, home: string, pos: string): string {
  if (!prefs || (!prefs.intra && !prefs.inter)) return fallback;
  const inter = Boolean(home && pos && pos.toUpperCase() !== home);
  return (inter ? prefs.inter : prefs.intra) || fallback;
}

/**
 * `record` = edit that document. `prefill` = start a new document from
 * another one (estimate → invoice): its party and lines are copied, and the
 * source number goes into the reference field.
 */
export function TxnEditor({ spec, record, prefill, onClose, onSaved }: { spec: TxnSpec; record?: ZRecord; prefill?: ZRecord; onClose: () => void; onSaved: (r: ZRecord) => void }) {
  const org = useOrg();
  const src = record ?? prefill;
  const partyId = spec.party === 'customer' ? 'customer_id' : 'vendor_id';
  const partyName = spec.party === 'customer' ? 'customer_name' : 'vendor_name';
  const taxes = useTaxOptions();
  const accounts = useAccountOptions(spec.purchase ? isExpenseAcct : isIncomeAcct);
  const items = useLookup('items', { filter_by: 'Status.Active' });
  const { gst, home } = useOrgGst();
  // Zoho: bills take no discount at all; purchase orders only one on the total.
  const lineDiscountOk = !spec.purchase;
  const headDiscountOk = !spec.purchase || spec.entity === 'purchaseorders';
  const itemLevelSource = s(src?.discount_type) === 'item_level';
  const [head, setHead] = useState({
    party: s(src?.[partyId]), partyLabel: s(src?.[partyName]),
    number: record ? s(record[spec.numberField]) : '', reference: record ? s(record.reference_number) : s(prefill?.estimate_number ?? prefill?.salesorder_number ?? prefill?.reference_number),
    date: record ? s(record.date) : today(), second: record && spec.secondDate ? s(record[spec.secondDate.field]) : '',
    discount: itemLevelSource ? '' : s(src?.discount_percent ? `${src.discount_percent}%` : src?.discount || ''), notes: s(src?.notes), terms: s(src?.terms),
    pos: s(src?.place_of_supply).toUpperCase(),
  });
  const [lines, setLines] = useState<Line[]>(() => {
    const ls = (src?.line_items as ZRecord[] | undefined) ?? [];
    return ls.length ? ls.map((l) => ({
      line_item_id: record ? s(l.line_item_id) : undefined, src_line_id: prefill ? s(l.line_item_id) : undefined,
      item_id: s(l.item_id), item_label: s(l.name), account_id: s(l.account_id), description: s(l.description),
      quantity: s(l.quantity ?? 1), rate: s(l.rate), discount: lineDiscountOk ? s(l.discount || '') : '', tax_id: s(l.tax_id),
    })) : [blankLine()];
  });
  const [err, setErr] = useState<string | null>(null);
  const save = useSave(spec.entity, record ? String(record[spec.idField]) : undefined, onSaved);
  const setL = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const itemOptions = (items.data?.items ?? []).map((x) => ({ value: String(x.item_id), label: x.name }));

  // The list row has one tax; the intra/inter pair is only on the item itself.
  const pickItem = (i: number, id: string) => {
    const it = (items.data?.items ?? []).find((x) => String(x.item_id) === id);
    setL(i, { item_id: id, item_label: it?.name ?? '', prefs: undefined, description: it ? s(spec.purchase ? it.purchase_description || it.description : it.description) : lines[i].description, rate: it ? s(spec.purchase ? it.purchase_rate ?? it.rate : it.rate) : lines[i].rate, tax_id: it ? s(it.tax_id) : lines[i].tax_id });
    if (!gst || !id) return;
    void booksApi.org(org.id).get('items', id).then((full) => {
      const ps = (full.item_tax_preferences as ZRecord[] | undefined) ?? [];
      const prefs = { intra: s(ps.find((p) => p.tax_specification === 'intra')?.tax_id), inter: s(ps.find((p) => p.tax_specification === 'inter')?.tax_id) };
      setLines((ls) => ls.map((l, j) => (j === i && l.item_id === id ? { ...l, prefs, tax_id: taxFor(prefs, l.tax_id, home, head.pos) } : l)));
    }).catch(() => undefined);
  };
  // A new place of supply re-picks the tax on lines that still carry the item's own tax.
  const setPos = (pos: string) => {
    const p = pos.toUpperCase().slice(0, 2);
    setHead((h) => ({ ...h, pos: p }));
    setLines((ls) => ls.map((l) => (l.prefs && [l.prefs.intra, l.prefs.inter].includes(l.tax_id) ? { ...l, tax_id: taxFor(l.prefs, l.tax_id, home, p) } : l)));
  };
  const pickParty = (id: string, r: ZRecord | null) => {
    setHead((h) => ({ ...h, party: id, partyLabel: r?.contact_name ?? '' }));
    if (!gst || !id) return;
    // place_of_contact is on the contact itself, not in the picker's list rows.
    void booksApi.org(org.id).get(spec.party === 'customer' ? 'customers' : 'vendors', id).then((c) => { if (c.place_of_contact) setPos(s(c.place_of_contact)); }).catch(() => undefined);
  };

  const lineAmount = (l: Line) => lineGross(l) - (lineDiscountOk ? discountOf(lineGross(l), l.discount) : 0);
  const itemLevel = lineDiscountOk && lines.some((l) => hasValue(l.discount));
  const subtotal = lines.reduce((t, l) => t + lineAmount(l), 0);
  const headDiscount = headDiscountOk && !itemLevel ? discountOf(subtotal, head.discount) : 0;
  const interState = gst && Boolean(home && head.pos && head.pos !== home);
  const inclusive = src?.is_inclusive_tax === true;

  const submit = () => {
    if (!head.party) return setErr(`Choose a ${spec.party}.`);
    if (spec.numberRequired && !head.number.trim()) return setErr(`${spec.numberLabel} is required.`);
    if (!head.date) return setErr('Date is required.');
    const used = lines.filter((l) => l.item_id || l.description.trim() || l.rate);
    if (!used.length) return setErr('Add at least one line.');
    for (const l of used) {
      if (!(Number(l.quantity) > 0)) return setErr('Every line needs a quantity above zero.');
      if (l.rate === '' || Number.isNaN(Number(l.rate))) return setErr('Every line needs a rate.');
      if (!l.item_id && !l.description.trim()) return setErr('Every line needs an item or a description.');
      if (spec.purchase && !l.item_id && !l.account_id) return setErr('A purchase line without an item needs an account.');
    }
    if (head.second && head.second < head.date) return setErr(`${spec.secondDate?.label} cannot be before the date.`);
    if (gst && head.pos && !/^[A-Z]{2}$/.test(head.pos)) return setErr('Place of supply is a two-letter state code, e.g. TN or KA.');
    setErr(null);
    // On edit, a field left out of the PUT keeps its old value in Zoho — so a
    // cleared field is sent empty, not dropped.
    const cleared = (v: string, empty: string | number) => (v.trim() === '' ? (record ? empty : undefined) : v);
    const anyDiscount = itemLevel || hasValue(head.discount);
    const body: ZRecord = {
      [partyId]: head.party, date: head.date,
      reference_number: cleared(head.reference, ''), notes: cleared(head.notes, ''), terms: cleared(head.terms, ''),
      discount: headDiscountOk ? (itemLevel ? (record ? 0 : undefined) : cleared(head.discount, 0)) : undefined,
      line_items: used.map((l) => ({
        line_item_id: l.line_item_id, item_id: l.item_id || undefined, account_id: l.account_id || undefined, name: l.item_id ? undefined : l.description.slice(0, 100),
        description: cleared(l.description, ''), quantity: Number(l.quantity), rate: Number(l.rate),
        discount: lineDiscountOk ? cleared(l.discount, 0) : undefined, tax_id: cleared(l.tax_id, ''),
        // Source links, so the estimate / sales order / PO shows as invoiced or billed.
        ...(prefill && l.src_line_id && spec.entity === 'invoices' && prefill.salesorder_id ? { salesorder_item_id: l.src_line_id } : {}),
        ...(prefill && l.src_line_id && spec.entity === 'bills' && prefill.purchaseorder_id ? { purchaseorder_item_id: l.src_line_id } : {}),
      })),
    };
    if (DISCOUNT_TYPE_DOCS.has(spec.entity) && (anyDiscount || record)) body.discount_type = itemLevel ? 'item_level' : 'entity_level';
    if (headDiscountOk && anyDiscount) body.is_discount_before_tax = true;
    if (gst && PLACE_OF_SUPPLY_DOCS.has(spec.entity) && head.pos) body.place_of_supply = head.pos;
    if (typeof src?.is_inclusive_tax === 'boolean') body.is_inclusive_tax = src.is_inclusive_tax;
    if (prefill && spec.entity === 'invoices' && prefill.estimate_id && !prefill.salesorder_id) body.invoiced_estimate_id = prefill.estimate_id;
    if (prefill && spec.entity === 'bills' && prefill.purchaseorder_id) body.purchaseorder_ids = [prefill.purchaseorder_id];
    if (head.number.trim()) body[spec.numberField] = head.number.trim();
    if (spec.secondDate && head.second) body[spec.secondDate.field] = head.second;
    save.mutate(body);
  };

  return (
    <FormModal title={`${record ? 'Edit' : 'New'} ${spec.title}`} onClose={onClose} onSubmit={submit} saving={save.isPending} error={err ?? save.error} wide>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Field label={`${spec.party === 'customer' ? 'Customer' : 'Vendor'} *`} className="sm:col-span-2">
          <ContactPicker kind={spec.party} value={head.party} label={head.partyLabel} onChange={pickParty} disabled={Boolean(record)} />
        </Field>
        <Field label={`${spec.numberLabel}${spec.numberRequired ? ' *' : ''}`} hint={spec.numberRequired ? undefined : 'Leave blank for Zoho’s next number'}><TextInput value={head.number} onChange={(x) => setHead({ ...head, number: x })} /></Field>
        <Field label="Reference #"><TextInput value={head.reference} onChange={(x) => setHead({ ...head, reference: x })} /></Field>
        <Field label="Date *"><TextInput type="date" value={head.date} onChange={(x) => setHead({ ...head, date: x })} /></Field>
        {spec.secondDate ? <Field label={spec.secondDate.label}><TextInput type="date" value={head.second} onChange={(x) => setHead({ ...head, second: x })} /></Field> : null}
        {gst && PLACE_OF_SUPPLY_DOCS.has(spec.entity) ? (
          <Field label="Place of supply" hint={interState ? `Inter-state (${home} → ${head.pos}): IGST applies` : home ? `State code; ${home} is intra-state` : 'Two-letter state code, e.g. TN'}>
            <TextInput value={head.pos} onChange={setPos} placeholder="TN" />
          </Field>
        ) : null}
      </div>

      <div className="overflow-x-auto border border-border rounded">
        <table className="w-full min-w-[900px] border-collapse">
          <thead><tr className="border-b border-border text-11 uppercase tracking-[0.06em] text-inkMuted">
            <th className="text-left px-2 h-8 font-medium w-[22%]">Item</th>
            {spec.purchase ? <th className="text-left px-2 font-medium w-[16%]">Account</th> : null}
            <th className="text-left px-2 font-medium">Description</th>
            <th className="text-right px-2 font-medium w-20">Qty</th>
            <th className="text-right px-2 font-medium w-28">Rate</th>
            {lineDiscountOk ? <th className="text-right px-2 font-medium w-24">Discount</th> : null}
            <th className="text-left px-2 font-medium w-36">Tax</th>
            <th className="text-right px-2 font-medium w-28">Amount</th>
            <th className="w-8" />
          </tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className="border-b border-border last:border-b-0 align-top">
                <td className="p-1"><Select value={l.item_id} onChange={(v) => pickItem(i, v)} options={itemOptions.some((o) => o.value === l.item_id) || !l.item_id ? itemOptions : [{ value: l.item_id, label: l.item_label }, ...itemOptions]} placeholder={items.isLoading ? 'Loading…' : '— Item —'} /></td>
                {spec.purchase ? <td className="p-1"><Select value={l.account_id} onChange={(v) => setL(i, { account_id: v })} options={accounts} placeholder="From item" /></td> : null}
                <td className="p-1"><TextInput value={l.description} onChange={(v) => setL(i, { description: v })} /></td>
                <td className="p-1"><NumberInput value={l.quantity} onChange={(v) => setL(i, { quantity: v })} /></td>
                <td className="p-1"><NumberInput value={l.rate} onChange={(v) => setL(i, { rate: v })} /></td>
                {lineDiscountOk ? (
                  <td className="p-1" title={hasValue(head.discount) ? 'Clear the discount on the total to discount lines' : undefined}>
                    <NumberInput value={l.discount} onChange={(v) => setL(i, { discount: v })} placeholder="0 or 10%" disabled={hasValue(head.discount)} />
                  </td>
                ) : null}
                <td className="p-1"><Select value={l.tax_id} onChange={(v) => setL(i, { tax_id: v })} options={taxes} placeholder="None" /></td>
                <td className="p-1 pt-2.5 text-right text-13 tabular-nums">{money(lineAmount(l))}</td>
                <td className="p-1 pt-2"><button type="button" aria-label="Remove line" className="text-inkMuted hover:text-danger disabled:opacity-30" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 size={15} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <Btn variant="ghost" onClick={() => setLines([...lines, blankLine()])}><Plus size={14} />Add line</Btn>
        <div className="flex-1" />
        <div className="w-full sm:w-72 space-y-2">
          {headDiscountOk ? (
            <Field label="Discount on total" hint={itemLevel ? 'Lines have discounts — Zoho takes one or the other' : 'Amount or percentage, e.g. 5%'}>
              <NumberInput value={itemLevel ? '' : head.discount} onChange={(x) => setHead({ ...head, discount: x })} disabled={itemLevel} />
            </Field>
          ) : null}
          <div className="flex justify-between text-13"><span className="text-inkMuted">Sub-total</span><span className="tabular-nums">{money(subtotal, org.currency_code)}</span></div>
          {headDiscount ? <div className="flex justify-between text-13"><span className="text-inkMuted">Discount</span><span className="tabular-nums">−{money(headDiscount, org.currency_code)}</span></div> : null}
          {headDiscount ? <div className="flex justify-between text-13 font-medium"><span>After discount, before tax</span><span className="tabular-nums">{money(subtotal - headDiscount, org.currency_code)}</span></div> : null}
          <p className="text-12 text-inkMuted">{inclusive ? 'Rates include tax. ' : ''}Tax, rounding and the final total are calculated by Zoho Books when saved.</p>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label={spec.party === 'customer' ? 'Customer notes' : 'Notes'}><TextArea value={head.notes} onChange={(x) => setHead({ ...head, notes: x })} /></Field>
        <Field label="Terms & conditions"><TextArea value={head.terms} onChange={(x) => setHead({ ...head, terms: x })} /></Field>
      </div>
    </FormModal>
  );
}

// ── expenses ──────────────────────────────────────────────────────────────
export function ExpenseForm({ record, onClose, onSaved }: { record?: ZRecord; onClose: () => void; onSaved: (r: ZRecord) => void }) {
  const org = useOrg();
  const expense = useAccountOptions(isExpenseAcct);
  const paid = useAccountOptions(isCashAcct);
  const taxes = useTaxOptions();
  const [v, setV] = useState({
    account_id: s(record?.account_id), date: s(record?.date) || today(), amount: s(record?.amount ?? record?.total), is_inclusive_tax: record?.is_inclusive_tax === true, paid_through_account_id: s(record?.paid_through_account_id),
    vendor_id: s(record?.vendor_id), vendor_label: s(record?.vendor_name), customer_id: s(record?.customer_id), customer_label: s(record?.customer_name),
    is_billable: Boolean(record?.is_billable), tax_id: s(record?.tax_id), reference_number: s(record?.reference_number), description: s(record?.description),
  });
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const save = useSave('expenses', record?.expense_id, async (rec) => {
    if (file) {
      try { await booksApi.org(org.id).attachReceipt(String(rec.expense_id), file); } catch (e) { toast.push('error', `Expense saved, but the receipt was not attached: ${errorText(e)}`); }
    }
    onSaved(rec);
  });
  const submit = () => {
    if (!v.account_id) return setErr('Choose an expense account.');
    if (!(Number(v.amount) > 0)) return setErr('Amount must be above zero.');
    if (!v.paid_through_account_id) return setErr('Choose the account it was paid through.');
    setErr(null);
    save.mutate({
      // `total` already has the tax in it; sending it back as `amount` taxed it again on every edit.
      account_id: v.account_id, date: v.date, amount: Number(v.amount), is_inclusive_tax: v.tax_id ? v.is_inclusive_tax : undefined, paid_through_account_id: v.paid_through_account_id,
      vendor_id: v.vendor_id || (record ? '' : undefined), customer_id: v.customer_id || (record ? '' : undefined), is_billable: v.customer_id ? v.is_billable : undefined,
      tax_id: v.tax_id || (record ? '' : undefined), reference_number: v.reference_number || (record ? '' : undefined), description: v.description || (record ? '' : undefined),
    });
  };
  return (
    <FormModal title={record ? 'Edit expense' : 'New expense'} onClose={onClose} onSubmit={submit} saving={save.isPending} error={err ?? save.error} wide>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Expense account *"><Select value={v.account_id} onChange={(x) => setV({ ...v, account_id: x })} options={expense} placeholder="—" /></Field>
        <Field label="Date *"><TextInput type="date" value={v.date} onChange={(x) => setV({ ...v, date: x })} /></Field>
        <Field label="Amount *"><NumberInput value={v.amount} onChange={(x) => setV({ ...v, amount: x })} /></Field>
        <Field label="Paid through *"><Select value={v.paid_through_account_id} onChange={(x) => setV({ ...v, paid_through_account_id: x })} options={paid} placeholder="—" /></Field>
        <Field label="Tax" hint={v.tax_id ? <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={v.is_inclusive_tax} onChange={(e) => setV({ ...v, is_inclusive_tax: e.target.checked })} />Amount includes tax</label> : undefined}>
          <Select value={v.tax_id} onChange={(x) => setV({ ...v, tax_id: x })} options={taxes} placeholder="None" />
        </Field>
        <Field label="Reference #"><TextInput value={v.reference_number} onChange={(x) => setV({ ...v, reference_number: x })} /></Field>
        <Field label="Vendor"><ContactPicker kind="vendor" value={v.vendor_id} label={v.vendor_label} onChange={(id, r) => setV({ ...v, vendor_id: id, vendor_label: r?.contact_name ?? '' })} /></Field>
        <Field label="Customer (to bill)"><ContactPicker kind="customer" value={v.customer_id} label={v.customer_label} onChange={(id, r) => setV({ ...v, customer_id: id, customer_label: r?.contact_name ?? '' })} /></Field>
        <Field label="Billable"><label className="inline-flex items-center gap-2 h-9 text-13"><input type="checkbox" disabled={!v.customer_id} checked={v.is_billable} onChange={(e) => setV({ ...v, is_billable: e.target.checked })} />Bill to the customer</label></Field>
      </div>
      <Field label="Description"><TextArea value={v.description} onChange={(x) => setV({ ...v, description: x })} rows={2} /></Field>
      <Field label="Receipt" hint="PDF or image, up to 10 MB. Uploaded to Zoho Books after saving."><input type="file" accept="application/pdf,image/png,image/jpeg,image/gif" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-13" /></Field>
    </FormModal>
  );
}

// ── payments ──────────────────────────────────────────────────────────────
const MODES = ['Cash', 'Bank Transfer', 'Cheque', 'Credit Card', 'UPI', 'Bank Remittance', 'Others'].map((m) => ({ value: m, label: m }));

/**
 * Record a customer payment (applied to invoices) or a vendor payment
 * (applied to bills). `against` pre-selects one document to settle.
 */

/**
 * A party's invoices or bills that still have something to pay. One Zoho
 * status filter misses some (Status.Unpaid / Status.Open leave out overdue
 * and part-paid ones), so each status is fetched and merged, as the
 * dashboard's ageing does. Up to 200 per status.
 */
const OPEN_FILTERS = { invoices: ['Status.Unpaid', 'Status.PartiallyPaid', 'Status.OverDue'], bills: ['Status.Open', 'Status.PartiallyPaid', 'Status.Overdue'] } as const;
async function listOpenDocs(orgId: string, docKey: 'invoices' | 'bills', partyField: string, party: string): Promise<ZRecord[]> {
  const idField = docKey === 'invoices' ? 'invoice_id' : 'bill_id';
  const pages = await Promise.all(OPEN_FILTERS[docKey].map((filter_by) => booksApi.org(orgId).list(docKey, { [partyField]: party, filter_by, per_page: 200 })));
  const seen = new Map<string, ZRecord>();
  for (const d of pages.flatMap((p) => p.items as ZRecord[])) {
    if (Number(d.balance) > 0 && d.status !== 'draft' && d.status !== 'void') seen.set(String(d[idField]), d);
  }
  return [...seen.values()].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
}

export function PaymentForm({ side, record, against, onClose, onSaved }: { side: 'customer' | 'vendor'; record?: ZRecord; against?: ZRecord; onClose: () => void; onSaved: (r: ZRecord) => void }) {
  const org = useOrg();
  const cust = side === 'customer';
  const partyField = cust ? 'customer_id' : 'vendor_id';
  const docKey = cust ? 'invoices' : 'bills';
  const docId = cust ? 'invoice_id' : 'bill_id';
  const docNo = cust ? 'invoice_number' : 'bill_number';
  const accounts = useAccountOptions(isCashAcct);
  const [v, setV] = useState({
    party: s(record?.[partyField] ?? against?.[partyField]), partyLabel: s(record?.[cust ? 'customer_name' : 'vendor_name'] ?? against?.[cust ? 'customer_name' : 'vendor_name']),
    amount: s(record?.amount ?? against?.balance), date: s(record?.date) || today(), payment_mode: s(record?.payment_mode) || 'Bank Transfer',
    reference_number: s(record?.reference_number), account: s(record?.[cust ? 'account_id' : 'paid_through_account_id']), description: s(record?.description),
  });
  const [applied, setApplied] = useState<Record<string, string>>(() => {
    if (against) return { [String(against[docId])]: s(against.balance) };
    const out: Record<string, string> = {};
    for (const d of (record?.[docKey] as ZRecord[] | undefined) ?? []) out[String(d[docId])] = s(d.amount_applied);
    return out;
  });
  // TDS the customer deducted, per invoice (Zoho: invoices[].tax_amount_withheld).
  const [withheld, setWithheld] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const d of (record?.[docKey] as ZRecord[] | undefined) ?? []) if (Number(d.tax_amount_withheld) > 0) out[String(d[docId])] = s(d.tax_amount_withheld);
    return out;
  });
  const open = useQuery({
    queryKey: ['books', org.id, 'open-docs', docKey, v.party],
    queryFn: () => listOpenDocs(org.id, docKey, partyField, v.party),
    enabled: Boolean(v.party) && !record,
  });
  // On edit, the applied documents come from the payment itself; their
  // outstanding amount is `balance_amount` there, not `balance`.
  const docs = record
    ? ((record[docKey] as ZRecord[] | undefined) ?? []).map((d): ZRecord => ({ ...d, balance: d.balance ?? d.balance_amount }))
    : (open.data ?? []);
  const totalApplied = Object.values(applied).reduce((t, x) => t + (Number(x) || 0), 0);
  const [err, setErr] = useState<string | null>(null);
  const save = useSave(cust ? 'customerpayments' : 'vendorpayments', record?.payment_id, onSaved);
  const submit = () => {
    if (!v.party) return setErr(`Choose a ${side}.`);
    if (!(Number(v.amount) > 0)) return setErr('Amount must be above zero.');
    if (totalApplied > Number(v.amount) + 0.001) return setErr('Amounts applied cannot exceed the payment amount.');
    for (const d of docs) {
      const id = String(d[docId]);
      if ((Number(applied[id]) || 0) + (Number(withheld[id]) || 0) > Number(d.balance) + 0.001) return setErr(`Payment plus TDS on ${String(d[docNo])} is more than its balance.`);
    }
    setErr(null);
    const body: ZRecord = {
      [partyField]: v.party, amount: Number(v.amount), date: v.date, payment_mode: v.payment_mode, reference_number: v.reference_number || undefined, description: v.description || undefined,
      [cust ? 'account_id' : 'paid_through_account_id']: v.account || undefined,
      [docKey]: [...new Set([...Object.keys(applied), ...Object.keys(withheld)])]
        .filter((id) => Number(applied[id]) > 0 || Number(withheld[id]) > 0)
        .map((id) => ({ [docId]: id, amount_applied: Number(applied[id]) || 0, ...(cust && Number(withheld[id]) > 0 ? { tax_amount_withheld: Number(withheld[id]) } : {}) })),
    };
    save.mutate(body);
  };
  return (
    <FormModal title={`${record ? 'Edit' : 'Record'} ${cust ? 'payment received' : 'payment made'}`} onClose={onClose} onSubmit={submit} saving={save.isPending} error={err ?? save.error} wide>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label={`${cust ? 'Customer' : 'Vendor'} *`}><ContactPicker kind={side} value={v.party} label={v.partyLabel} disabled={Boolean(record || against)} onChange={(id, r) => { setV({ ...v, party: id, partyLabel: r?.contact_name ?? '' }); setApplied({}); }} /></Field>
        <Field label="Amount *"><NumberInput value={v.amount} onChange={(x) => setV({ ...v, amount: x })} /></Field>
        <Field label="Date *"><TextInput type="date" value={v.date} onChange={(x) => setV({ ...v, date: x })} /></Field>
        <Field label="Payment mode"><Select value={v.payment_mode} onChange={(x) => setV({ ...v, payment_mode: x })} options={MODES} /></Field>
        <Field label={cust ? 'Deposit to' : 'Paid through'}><Select value={v.account} onChange={(x) => setV({ ...v, account: x })} options={accounts} placeholder="Zoho default" /></Field>
        <Field label="Reference #"><TextInput value={v.reference_number} onChange={(x) => setV({ ...v, reference_number: x })} /></Field>
      </div>
      {v.party ? (
        <div className="border border-border rounded overflow-x-auto">
          <table className="w-full min-w-[560px]">
            <thead><tr className="border-b border-border text-11 uppercase tracking-[0.06em] text-inkMuted"><th className="text-left px-3 h-8 font-medium">{cust ? 'Invoice' : 'Bill'}</th><th className="text-left px-3 font-medium">Date</th><th className="text-right px-3 font-medium">Balance</th><th className="text-right px-3 font-medium w-40">Apply</th>{cust ? <th className="text-right px-3 font-medium w-32">TDS deducted</th> : null}</tr></thead>
            <tbody>
              {open.isLoading ? <tr><td colSpan={cust ? 5 : 4} className="px-3 py-2 text-12 text-inkMuted">Loading open {docKey}…</td></tr> : null}
              {docs.map((d) => (
                <tr key={d[docId]} className="border-b border-border last:border-b-0">
                  <td className="px-3 py-1 text-13">{d[docNo]}</td><td className="px-3 text-13 text-inkMuted">{d.date}</td>
                  <td className="px-3 text-right text-13 tabular-nums">{money(d.balance, d.currency_code ?? org.currency_code)}</td>
                  <td className="px-3 py-1"><NumberInput value={applied[String(d[docId])] ?? ''} onChange={(x) => setApplied({ ...applied, [String(d[docId])]: x })} /></td>
                  {cust ? <td className="px-3 py-1"><NumberInput value={withheld[String(d[docId])] ?? ''} onChange={(x) => setWithheld({ ...withheld, [String(d[docId])]: x })} placeholder="0" /></td> : null}
                </tr>
              ))}
              {!open.isLoading && docs.length === 0 ? <tr><td colSpan={cust ? 5 : 4} className="px-3 py-2 text-12 text-inkMuted">No open {docKey}; the payment is recorded as an advance.</td></tr> : null}
            </tbody>
          </table>
          <div className="px-3 py-2 text-12 text-inkMuted text-right">Applied {money(totalApplied, org.currency_code)} of {money(Number(v.amount) || 0, org.currency_code)}</div>
        </div>
      ) : null}
      <Field label="Notes"><TextArea value={v.description} onChange={(x) => setV({ ...v, description: x })} rows={2} /></Field>
    </FormModal>
  );
}

// ── small forms ───────────────────────────────────────────────────────────
export function TaxForm({ record, onClose, onSaved }: { record?: ZRecord; onClose: () => void; onSaved: (r: ZRecord) => void }) {
  const [v, setV] = useState({ tax_name: s(record?.tax_name), tax_percentage: s(record?.tax_percentage) });
  const [err, setErr] = useState<string | null>(null);
  const save = useSave('taxes', record?.tax_id, onSaved);
  const submit = () => {
    if (!v.tax_name.trim()) return setErr('Name is required.');
    const p = Number(v.tax_percentage);
    if (v.tax_percentage === '' || !(p >= 0 && p <= 100)) return setErr('Rate must be between 0 and 100.');
    setErr(null);
    save.mutate({ tax_name: v.tax_name.trim(), tax_percentage: p });
  };
  return (
    <FormModal title={record ? 'Edit tax' : 'New tax'} onClose={onClose} onSubmit={submit} saving={save.isPending} error={err ?? save.error}>
      <Field label="Tax name *"><TextInput value={v.tax_name} onChange={(x) => setV({ ...v, tax_name: x })} autoFocus /></Field>
      <Field label="Rate (%) *"><NumberInput value={v.tax_percentage} onChange={(x) => setV({ ...v, tax_percentage: x })} /></Field>
      <p className="text-12 text-inkMuted">GST component taxes (CGST/SGST/IGST) and tax groups are defined in Zoho Books; they appear here once created.</p>
    </FormModal>
  );
}

export function BankAccountForm({ record, onClose, onSaved }: { record?: ZRecord; onClose: () => void; onSaved: (r: ZRecord) => void }) {
  const [v, setV] = useState({ account_name: s(record?.account_name), account_type: s(record?.account_type) || 'bank', account_number: s(record?.account_number), bank_name: s(record?.bank_name), routing_number: s(record?.routing_number), description: s(record?.description) });
  const [err, setErr] = useState<string | null>(null);
  const save = useSave('bankaccounts', record?.account_id, onSaved);
  const submit = () => {
    if (!v.account_name.trim()) return setErr('Account name is required.');
    setErr(null);
    save.mutate({ account_name: v.account_name.trim(), account_type: v.account_type, account_number: v.account_number || undefined, bank_name: v.bank_name || undefined, routing_number: v.routing_number || undefined, description: v.description || undefined });
  };
  return (
    <FormModal title={record ? 'Edit bank account' : 'New bank account'} onClose={onClose} onSubmit={submit} saving={save.isPending} error={err ?? save.error}>
      <Field label="Account name *"><TextInput value={v.account_name} onChange={(x) => setV({ ...v, account_name: x })} autoFocus /></Field>
      <Field label="Type"><Select value={v.account_type} onChange={(x) => setV({ ...v, account_type: x })} options={[{ value: 'bank', label: 'Bank' }, { value: 'credit_card', label: 'Credit card' }]} disabled={Boolean(record)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Account number"><TextInput value={v.account_number} onChange={(x) => setV({ ...v, account_number: x })} /></Field>
        <Field label="Bank name"><TextInput value={v.bank_name} onChange={(x) => setV({ ...v, bank_name: x })} /></Field>
        <Field label="IFSC / routing"><TextInput value={v.routing_number} onChange={(x) => setV({ ...v, routing_number: x })} /></Field>
      </div>
      <Field label="Description"><TextArea value={v.description} onChange={(x) => setV({ ...v, description: x })} rows={2} /></Field>
    </FormModal>
  );
}

/** Generic action modal: email, apply credit, refund. Posts to an entity action. */
export function ActionForm({ title, entity, id, action, fields, initial, onClose, onDone, note }: {
  title: string; entity: string; id: string; action: string; note?: ReactNode;
  fields: { key: string; label: string; type?: 'text' | 'number' | 'date' | 'textarea' | 'account' }[];
  initial?: ZRecord; onClose: () => void; onDone: () => void;
}) {
  const org = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const accounts = useAccountOptions(isCashAcct);
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, s(initial?.[f.key])])));
  const m = useMutation({
    mutationFn: (body: ZRecord) => booksApi.org(org.id).action(entity, id, action, body),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['books', org.id] }); toast.push('success', r.message || 'Done.'); onDone(); },
  });
  const submit = () => {
    const body: ZRecord = {};
    for (const f of fields) {
      const x = v[f.key]?.trim();
      if (!x) continue;
      body[f.key] = f.type === 'number' ? Number(x) : f.key === 'to_mail_ids' ? x.split(/[,;\s]+/).filter(Boolean) : x;
    }
    m.mutate(body);
  };
  return (
    <FormModal title={title} onClose={onClose} onSubmit={submit} saving={m.isPending} error={m.error}>
      {note}
      {fields.map((f) => (
        <Field key={f.key} label={f.label}>
          {f.type === 'textarea' ? <TextArea value={v[f.key]} onChange={(x) => setV({ ...v, [f.key]: x })} rows={5} />
            : f.type === 'number' ? <NumberInput value={v[f.key]} onChange={(x) => setV({ ...v, [f.key]: x })} />
            : f.type === 'account' ? <Select value={v[f.key]} onChange={(x) => setV({ ...v, [f.key]: x })} options={accounts} placeholder="—" />
            : <TextInput type={f.type === 'date' ? 'date' : 'text'} value={v[f.key]} onChange={(x) => setV({ ...v, [f.key]: x })} />}
        </Field>
      ))}
    </FormModal>
  );
}

/** Apply a credit note to invoices, or a vendor credit to bills. */
export function ApplyCreditForm({ entity, record, onClose, onDone }: { entity: 'creditnotes' | 'vendorcredits'; record: ZRecord; onClose: () => void; onDone: () => void }) {
  const org = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const cust = entity === 'creditnotes';
  const docKey = cust ? 'invoices' : 'bills';
  const docId = cust ? 'invoice_id' : 'bill_id';
  const party = cust ? record.customer_id : record.vendor_id;
  const open = useQuery({ queryKey: ['books', org.id, 'open-docs', docKey, party], queryFn: () => listOpenDocs(org.id, docKey, cust ? 'customer_id' : 'vendor_id', String(party)) });
  const [applied, setApplied] = useState<Record<string, string>>({});
  const available = Number(record.balance ?? record.total ?? 0);
  const total = Object.values(applied).reduce((t, x) => t + (Number(x) || 0), 0);
  const m = useMutation({
    mutationFn: () => booksApi.org(org.id).action(entity, String(record[cust ? 'creditnote_id' : 'vendor_credit_id']), 'apply', { [docKey]: Object.entries(applied).filter(([, a]) => Number(a) > 0).map(([id, a]) => ({ [docId]: id, amount_applied: Number(a) })) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['books', org.id] }); toast.push('success', 'Credit applied in Zoho Books.'); onDone(); },
  });
  const docs = open.data ?? [];
  return (
    <FormModal title={`Apply ${cust ? 'credit note' : 'debit note'}`} onClose={onClose} onSubmit={() => (total > available + 0.001 ? undefined : m.mutate())} saving={m.isPending} error={total > available + 0.001 ? 'Applied amount exceeds the available credit.' : m.error}>
      <p className="text-13 text-inkMuted">Available credit: {money(available, record.currency_code ?? org.currency_code)}</p>
      {open.isLoading ? <p className="text-12 text-inkMuted">Loading…</p> : docs.length === 0 ? <p className="text-13 text-inkMuted">No open {docKey} for this {cust ? 'customer' : 'vendor'}.</p> : docs.map((d) => (
        <div key={d[docId]} className="flex items-center gap-3">
          <span className="flex-1 text-13">{d[cust ? 'invoice_number' : 'bill_number']} · balance {money(d.balance, d.currency_code ?? org.currency_code)}</span>
          <div className="w-36"><NumberInput value={applied[String(d[docId])] ?? ''} onChange={(x) => setApplied({ ...applied, [String(d[docId])]: x })} /></div>
        </div>
      ))}
    </FormModal>
  );
}
