import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@/components/Button';
import { StatusLabel } from '@/components/StatusRow';
import { fmtDate } from '@/lib/format';
import { booksApi } from '@/modules/books/api';
import { Cell, Empty, Money, Row, Section, Select, Table, useBooks, inputCls } from '@/modules/books/components';
import { DOC_LABEL, DOC_PLURAL, docStatus, isSalesKind } from '@/modules/books/format';
import type { BooksDocument, DocKind } from '@/modules/books/types';
import { DocumentEditor } from './DocumentEditor';
import { DocumentDrawer } from './DocumentDrawer';
import { PaymentModal } from './PaymentModal';

const SALES_TABS: DocKind[] = ['invoice', 'estimate', 'sales_order', 'retainer_invoice', 'credit_note'];
const PURCHASE_TABS: DocKind[] = ['bill', 'purchase_order', 'vendor_credit'];

/** /books/:orgId/sales and /purchases — a tab per document kind, plus payments. */
export function BooksDocumentsPage({ side }: { side: 'sales' | 'purchases' }) {
  const { orgId, org, canWrite } = useBooks();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tabs = side === 'sales' ? SALES_TABS : PURCHASE_TABS;
  const paymentKind = side === 'sales' ? 'received' : 'made';
  const tab = (params.get('tab') ?? tabs[0]) as DocKind | 'payments';
  const kind = tab === 'payments' ? tabs[0] : (tab as DocKind);
  const [editing, setEditing] = useState<{ kind: DocKind; id?: string } | null>(null);
  const [open, setOpen] = useState<{ kind: DocKind; id: string } | null>(null);
  const [paying, setPaying] = useState(false);

  const status = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };

  const docs = useQuery({
    queryKey: ['books', orgId, 'documents', kind, { status, q }],
    queryFn: () => booksApi.org(orgId).documents.list(kind, { status, q }),
    enabled: tab !== 'payments',
  });
  const payments = useQuery({
    queryKey: ['books', orgId, 'payments', paymentKind],
    queryFn: () => booksApi.org(orgId).payments.list(paymentKind),
    enabled: tab === 'payments',
  });
  const contacts = useQuery({ queryKey: ['books', orgId, 'contacts', side], queryFn: () => booksApi.org(orgId).contacts.list({ type: side === 'sales' ? 'customer' : 'vendor' }) });
  const contactName = useMemo(() => new Map((contacts.data?.items ?? []).map((c) => [c.id, c.display_name])), [contacts.data]);

  const refresh = () => { qc.invalidateQueries({ queryKey: ['books', orgId] }); };

  return (
    <div className="space-y-4" data-testid={`books-${side}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {[...tabs, 'payments' as const].map((t) => (
            <button key={t} type="button" onClick={() => setParam('tab', t)}
              className={'h-8 px-3 text-13 rounded border ' + (tab === t ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-50')}
              data-testid={`books-tab-${t}`}>
              {t === 'payments' ? (side === 'sales' ? 'Payments received' : 'Payments made') : DOC_PLURAL[t]}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {canWrite ? (
          tab === 'payments'
            ? <Button variant="primary" size="sm" onClick={() => setPaying(true)} data-testid="books-new-payment"><Plus size={14} strokeWidth={2} className="mr-1" />Record payment</Button>
            : <Button variant="primary" size="sm" onClick={() => setEditing({ kind })} data-testid="books-new-document"><Plus size={14} strokeWidth={2} className="mr-1" />New {DOC_LABEL[kind].toLowerCase()}</Button>
        ) : null}
      </div>

      {tab === 'payments' ? (
        <Section title={side === 'sales' ? 'Payments received' : 'Payments made'}>
          {payments.isLoading ? <div className="h-24 bg-neutral-100" /> : (payments.data?.items.length ?? 0) === 0 ? <Empty>No payments recorded.</Empty> : (
            <Table head={['Number', 'Date', side === 'sales' ? 'Customer' : 'Vendor', 'Mode', 'Reference', { label: 'Amount', align: 'right' }, 'Status']}>
              {payments.data!.items.map((p) => (
                <Row key={p.id} border={p.status === 'void' ? 'red' : null} muted={p.status === 'void'}>
                  <Cell className="font-medium whitespace-nowrap">{p.number}</Cell>
                  <Cell muted className="whitespace-nowrap tabular-nums">{fmtDate(`${p.date}T00:00:00Z`)}</Cell>
                  <Cell muted>{contactName.get(p.contact_id) ?? '—'}</Cell>
                  <Cell muted className="capitalize">{p.mode.replace(/_/g, ' ')}</Cell>
                  <Cell muted>{p.reference ?? '—'}</Cell>
                  <Cell right><Money value={p.fx_amount} currency={p.currency} zero="0" /></Cell>
                  <Cell><StatusLabel variant={p.status === 'void' ? 'problem' : 'ok'} label={p.status === 'void' ? 'Void' : 'Posted'} /></Cell>
                </Row>
              ))}
            </Table>
          )}
        </Section>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Search</span>
              <input value={q} onChange={(e) => setParam('q', e.target.value)} placeholder="Number or reference" className={`${inputCls} w-[200px]`} />
            </label>
            <label className="block">
              <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Status</span>
              <Select value={status} onChange={(v) => setParam('status', v)} className="w-[160px]" placeholder="All"
                options={(kind === 'estimate' || kind === 'sales_order' || kind === 'purchase_order'
                  ? ['draft', 'sent', 'accepted', 'declined', 'closed']
                  : ['draft', 'posted', 'partially_paid', 'paid', 'closed', 'void']).map((s) => ({ value: s, label: docStatus(s as never).label }))} />
            </label>
          </div>
          <Section title={DOC_PLURAL[kind]}>
            {docs.isLoading ? <div className="h-24 bg-neutral-100" /> : (docs.data?.items.length ?? 0) === 0 ? (
              <Empty>No {DOC_PLURAL[kind].toLowerCase()} yet.</Empty>
            ) : (
              <Table head={['Number', 'Date', isSalesKind(kind) ? 'Customer' : 'Vendor', 'Due', { label: 'Total', align: 'right' }, { label: 'Balance', align: 'right' }, 'Status']}>
                {docs.data!.items.map((d) => <DocRow key={d.id} d={d} name={contactName.get(d.contact_id)} onOpen={() => setOpen({ kind, id: d.id })} />)}
              </Table>
            )}
          </Section>
        </>
      )}

      {editing ? <DocumentEditor orgId={orgId} kind={editing.kind} documentId={editing.id} onClose={() => setEditing(null)} onSaved={(d) => { setEditing(null); refresh(); setOpen({ kind: d.kind, id: d.id }); }} /> : null}
      {open ? <DocumentDrawer orgId={open.id ? orgId : orgId} kind={open.kind} id={open.id} onClose={() => setOpen(null)} onChanged={refresh} onEdit={(id) => { setOpen(null); setEditing({ kind: open.kind, id }); }} /> : null}
      {paying ? <PaymentModal orgId={orgId} kind={paymentKind} baseCurrency={org.base_currency} onClose={() => setPaying(false)} onSaved={() => { setPaying(false); refresh(); }} /> : null}
    </div>
  );
}

function DocRow({ d, name, onOpen }: { d: BooksDocument; name?: string; onOpen: () => void }) {
  const s = docStatus(d.status);
  const overdue = d.status === 'posted' && d.due_date && d.due_date < new Date().toISOString().slice(0, 10);
  return (
    <Row onClick={onOpen} border={d.status === 'void' ? 'red' : overdue ? 'amber' : s.variant === 'awaiting' ? 'neutral' : null} muted={d.status === 'void'}>
      <Cell className="font-medium whitespace-nowrap">{d.number}</Cell>
      <Cell muted className="whitespace-nowrap tabular-nums">{fmtDate(`${d.date}T00:00:00Z`)}</Cell>
      <Cell muted className="max-w-[220px] truncate">{name ?? '—'}</Cell>
      <Cell muted className="whitespace-nowrap tabular-nums">{d.due_date ? fmtDate(`${d.due_date}T00:00:00Z`) : '—'}</Cell>
      <Cell right><Money value={d.total} currency={d.currency} zero="0" /></Cell>
      <Cell right><Money value={d.balance_due || d.credits_remaining} currency={d.currency} /></Cell>
      <Cell><StatusLabel {...s} /></Cell>
    </Row>
  );
}
