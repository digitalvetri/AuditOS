import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { Modal } from '@/modules/workstation/components';
import { booksApi } from '@/modules/books/api';
import { Cell, Empty, Field, Money, Notice, Row, Section, Table, inputCls, selectCls, useBooks } from '@/modules/books/components';
import { fromPaise, toPaise } from '@/modules/books/format';
import type { Contact } from '@/modules/books/types';

/** /books/:orgId/contacts — customers and vendors, and the items master. */
export function BooksContactsPage() {
  const { orgId, canWrite } = useBooks();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'contacts' | 'items'>('contacts');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [itemEditing, setItemEditing] = useState<'new' | string | null>(null);

  const contacts = useQuery({ queryKey: ['books', orgId, 'contacts', { type, q }], queryFn: () => booksApi.org(orgId).contacts.list({ type, q }) });
  const items = useQuery({ queryKey: ['books', orgId, 'items', q], queryFn: () => booksApi.org(orgId).items.list({ q }), enabled: tab === 'items' });
  const refresh = () => qc.invalidateQueries({ queryKey: ['books', orgId] });

  return (
    <div className="space-y-4" data-testid="books-contacts">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex gap-1">
          {(['contacts', 'items'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={'h-8 px-3 text-13 rounded border ' + (tab === t ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-50')}>
              {t === 'contacts' ? 'Contacts' : 'Items'}
            </button>
          ))}
        </div>
        <label className="block"><span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Search</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} className={`${inputCls} w-[200px]`} placeholder={tab === 'contacts' ? 'Name, GSTIN, email' : 'Name, SKU, HSN'} />
        </label>
        {tab === 'contacts' ? (
          <label className="block"><span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Type</span>
            <select value={type} onChange={(e) => setType(e.target.value)} className={`${selectCls} w-[140px]`}>
              <option value="">All</option><option value="customer">Customers</option><option value="vendor">Vendors</option>
            </select>
          </label>
        ) : null}
        <div className="flex-1" />
        {canWrite ? (
          <Button variant="primary" size="sm" onClick={() => (tab === 'contacts' ? setEditing('new') : setItemEditing('new'))} data-testid="books-new-contact">
            <Plus size={14} strokeWidth={2} className="mr-1" />New {tab === 'contacts' ? 'contact' : 'item'}
          </Button>
        ) : null}
      </div>

      {tab === 'contacts' ? (
        <Section title="Contacts">
          {contacts.isLoading ? <div className="h-24 bg-neutral-100" /> : (contacts.data?.items.length ?? 0) === 0 ? <Empty>No contacts yet.</Empty> : (
            <Table head={['Name', 'Type', 'GSTIN', 'PAN', 'State', 'Terms', 'Status']}>
              {contacts.data!.items.map((c) => (
                <Row key={c.id} onClick={canWrite ? () => setEditing(c) : undefined}>
                  <Cell className="font-medium">{c.display_name}{c.company_name && c.company_name !== c.display_name ? <div className="text-11 text-neutral-500">{c.company_name}</div> : null}</Cell>
                  <Cell muted className="capitalize">{c.type}</Cell>
                  <Cell muted className="tabular-nums">{c.gstin ?? '—'}</Cell>
                  <Cell muted className="tabular-nums">{c.pan ?? '—'}</Cell>
                  <Cell muted>{c.place_of_supply_state ?? '—'}</Cell>
                  <Cell muted className="tabular-nums">{c.payment_terms_days} days</Cell>
                  <Cell muted>{c.is_active ? 'Active' : 'Inactive'}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </Section>
      ) : (
        <Section title="Items">
          {items.isLoading ? <div className="h-24 bg-neutral-100" /> : (items.data?.items.length ?? 0) === 0 ? <Empty>No items yet.</Empty> : (
            <Table head={['Name', 'SKU', 'HSN / SAC', 'Type', { label: 'Sell rate', align: 'right' }, { label: 'Buy rate', align: 'right' }]}>
              {items.data!.items.map((i) => (
                <Row key={i.id} onClick={canWrite ? () => setItemEditing(i.id) : undefined}>
                  <Cell className="font-medium">{i.name}</Cell>
                  <Cell muted>{i.sku ?? '—'}</Cell>
                  <Cell muted className="tabular-nums">{i.hsn_sac ?? '—'}</Cell>
                  <Cell muted className="capitalize">{i.product_type}</Cell>
                  <Cell right><Money value={i.sell_rate} zero="0" /></Cell>
                  <Cell right><Money value={i.purchase_rate} zero="0" /></Cell>
                </Row>
              ))}
            </Table>
          )}
        </Section>
      )}

      {editing ? <ContactModal orgId={orgId} contact={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} /> : null}
      {itemEditing ? <ItemModal orgId={orgId} itemId={itemEditing === 'new' ? null : itemEditing} onClose={() => setItemEditing(null)} onSaved={() => { setItemEditing(null); refresh(); }} /> : null}
    </div>
  );
}

function ContactModal({ orgId, contact, onClose, onSaved }: { orgId: string; contact: Contact | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const api = booksApi.org(orgId);
  const [f, setF] = useState({
    type: contact?.type ?? 'customer', display_name: contact?.display_name ?? '', company_name: contact?.company_name ?? '', email: contact?.email ?? '', phone: contact?.phone ?? '',
    gstin: contact?.gstin ?? '', pan: contact?.pan ?? '', gst_treatment: contact?.gst_treatment ?? 'business_gst', place_of_supply_state: contact?.place_of_supply_state ?? '',
    currency: contact?.currency ?? 'INR', payment_terms_days: String(contact?.payment_terms_days ?? 30), credit_limit: contact ? fromPaise(contact.credit_limit) : '', tds_section: contact?.tds_section ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const payload = { ...f, gstin: f.gstin || null, pan: f.pan || null, company_name: f.company_name || null, email: f.email || null, phone: f.phone || null, place_of_supply_state: f.place_of_supply_state || null, tds_section: f.tds_section || null, payment_terms_days: Number(f.payment_terms_days || '30'), credit_limit: toPaise(f.credit_limit || '0') };
      return contact ? api.contacts.update(contact.id, payload) : api.contacts.create(payload);
    },
    onSuccess: () => { toast.push('success', 'Contact saved.'); onSaved(); },
    onError: (e: Error) => setError(e.message),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setError(null); if (!f.display_name.trim()) return setError('Name is required.'); save.mutate(); };
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  return (
    <Modal open title={contact ? 'Edit contact' : 'New contact'} onClose={onClose} width="w-[600px]"
      footer={<><Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button variant="primary" size="sm" onClick={submit} disabled={save.isPending} data-testid="contact-save">{save.isPending ? 'Saving…' : 'Save'}</Button></>}>
      <form onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label="Type"><select value={f.type} onChange={(e) => set('type', e.target.value)} className={selectCls}><option value="customer">Customer</option><option value="vendor">Vendor</option><option value="both">Both</option></select></Field>
        <Field label="Display name"><input value={f.display_name} onChange={(e) => set('display_name', e.target.value)} className={inputCls} required data-testid="contact-name" /></Field>
        <Field label="Company name" className="col-span-2"><input value={f.company_name} onChange={(e) => set('company_name', e.target.value)} className={inputCls} /></Field>
        <Field label="Email"><input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} className={inputCls} /></Field>
        <Field label="Phone"><input value={f.phone} onChange={(e) => set('phone', e.target.value)} className={inputCls} /></Field>
        <Field label="GSTIN"><input value={f.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase())} maxLength={15} className={inputCls} data-testid="contact-gstin" /></Field>
        <Field label="PAN" hint="Without a PAN, TDS applies at the higher rate"><input value={f.pan} onChange={(e) => set('pan', e.target.value.toUpperCase())} maxLength={10} className={inputCls} /></Field>
        <Field label="GST treatment"><select value={f.gst_treatment} onChange={(e) => set('gst_treatment', e.target.value)} className={selectCls}>
          <option value="business_gst">Registered business</option><option value="business_none">Unregistered business</option><option value="consumer">Consumer</option><option value="overseas">Overseas</option>
        </select></Field>
        <Field label="Place of supply (state code)"><input value={f.place_of_supply_state} onChange={(e) => set('place_of_supply_state', e.target.value)} maxLength={2} className={inputCls} /></Field>
        <Field label="Currency"><select value={f.currency} onChange={(e) => set('currency', e.target.value)} className={selectCls}>{['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'].map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
        <Field label="Payment terms (days)"><input value={f.payment_terms_days} onChange={(e) => set('payment_terms_days', e.target.value.replace(/\D/g, ''))} className={`${inputCls} text-right tabular-nums`} /></Field>
        <Field label="Credit limit"><input value={f.credit_limit} onChange={(e) => set('credit_limit', e.target.value.replace(/[^\d.]/g, ''))} className={`${inputCls} text-right tabular-nums`} /></Field>
        <Field label="Default TDS section" hint="Applied to this vendor's bills"><input value={f.tds_section} onChange={(e) => set('tds_section', e.target.value)} placeholder="194J" className={inputCls} /></Field>
        {error ? <div className="col-span-2"><Notice tone="error">{error}</Notice></div> : null}
      </form>
    </Modal>
  );
}

function ItemModal({ orgId, itemId, onClose, onSaved }: { orgId: string; itemId: string | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const api = booksApi.org(orgId);
  const existing = useQuery({ queryKey: ['books', orgId, 'items'], queryFn: () => api.items.list() });
  const item = existing.data?.items.find((i) => i.id === itemId);
  const taxes = useQuery({ queryKey: ['books', orgId, 'tax-rates', 'gst'], queryFn: () => api.taxRates.list('gst') });
  const [f, setF] = useState({ name: '', sku: '', unit: 'nos', product_type: 'service', sell_rate: '', purchase_rate: '', tax_rate_id: '', hsn_sac: '' });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (item && !ready) { setF({ name: item.name, sku: item.sku ?? '', unit: item.unit, product_type: item.product_type, sell_rate: fromPaise(item.sell_rate), purchase_rate: fromPaise(item.purchase_rate), tax_rate_id: item.tax_rate_id ?? '', hsn_sac: item.hsn_sac ?? '' }); setReady(true); }

  const save = useMutation({
    mutationFn: () => {
      const payload = { ...f, sku: f.sku || null, hsn_sac: f.hsn_sac || null, tax_rate_id: f.tax_rate_id || null, sell_rate: toPaise(f.sell_rate || '0'), purchase_rate: toPaise(f.purchase_rate || '0') };
      return itemId ? api.items.update(itemId, payload) : api.items.create(payload);
    },
    onSuccess: () => { toast.push('success', 'Item saved.'); onSaved(); },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal open title={itemId ? 'Edit item' : 'New item'} onClose={onClose} width="w-[520px]"
      footer={<><Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button variant="primary" size="sm" onClick={() => { setError(null); if (!f.name.trim()) return setError('Name is required.'); save.mutate(); }} disabled={save.isPending} data-testid="item-save">{save.isPending ? 'Saving…' : 'Save'}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" className="col-span-2"><input value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} className={inputCls} data-testid="item-name" /></Field>
        <Field label="SKU"><input value={f.sku} onChange={(e) => setF((x) => ({ ...x, sku: e.target.value }))} className={inputCls} /></Field>
        <Field label="HSN / SAC"><input value={f.hsn_sac} onChange={(e) => setF((x) => ({ ...x, hsn_sac: e.target.value }))} className={inputCls} /></Field>
        <Field label="Type"><select value={f.product_type} onChange={(e) => setF((x) => ({ ...x, product_type: e.target.value }))} className={selectCls}><option value="service">Service</option><option value="goods">Goods</option></select></Field>
        <Field label="Unit"><input value={f.unit} onChange={(e) => setF((x) => ({ ...x, unit: e.target.value }))} className={inputCls} /></Field>
        <Field label="Selling rate"><input value={f.sell_rate} onChange={(e) => setF((x) => ({ ...x, sell_rate: e.target.value.replace(/[^\d.]/g, '') }))} className={`${inputCls} text-right tabular-nums`} data-testid="item-rate" /></Field>
        <Field label="Purchase rate"><input value={f.purchase_rate} onChange={(e) => setF((x) => ({ ...x, purchase_rate: e.target.value.replace(/[^\d.]/g, '') }))} className={`${inputCls} text-right tabular-nums`} /></Field>
        <Field label="GST rate" className="col-span-2">
          <select value={f.tax_rate_id} onChange={(e) => setF((x) => ({ ...x, tax_rate_id: e.target.value }))} className={selectCls}>
            <option value="">None</option>
            {(taxes.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        {error ? <div className="col-span-2"><Notice tone="error">{error}</Notice></div> : null}
      </div>
    </Modal>
  );
}
