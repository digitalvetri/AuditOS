import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, BellRing, ChevronDown, Download, FileMinus, Mail, MessageCircle, Pencil, Printer, Receipt, Repeat, Send, Trash2, Wallet } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  invoicesApi, TERM_LABEL, TDS_SECTIONS, type Invoice, type InvoicePayment, type TdsSection,
} from '@/modules/workstation/invoices/api';
import { creditNotesApi, CREDIT_NOTE_REASON_LABEL, type CreditNote } from '@/modules/workstation/creditNotes/api';
import { ListTable, ListRow, TD, StatusChip, Money, fmtDay } from '@/modules/workstation/listUi';
import { downloadFile } from '@/modules/workstation/invoices/download';
import {
  DEFAULT_COMPANY, DEFAULT_LAYOUT, computeTotals, defaultBlocks, inrAmount, lineKey, stateName,
  type BlockSpec, type CompanyInfo, type LayoutConfig,
} from '@/modules/workstation/invoices/document';
import { InvoiceDocument, type InvoiceDoc } from './InvoiceDocument';
import { StatusPill } from './InvoiceBuilder';
import {
  Card, Detail, Field, Modal, QueryState, fieldErrors, inputClass,
} from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { fmtDate } from '@/lib/format';
import { istToday } from '@/lib/dates';
import { PAYMENT_MODE_LABEL, type PaymentMode } from '@/modules/paymentSummary/api';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';
import { SendEmailDialog } from '@/modules/workstation/SendEmailDialog';
import { SendWhatsAppDialog } from '@/modules/workstation/SendWhatsAppDialog';
import { EntityHeader, HeaderTag } from '@/components/EntityHeader';

/** Whole days between a due date and today (IST). */
function daysLate(due: string | null | undefined): number {
  if (!due) return 0;
  const ms = new Date(`${istToday()}T00:00:00Z`).getTime() - new Date(`${due.slice(0, 10)}T00:00:00Z`).getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

/**
 * A saved invoice: the document as issued, plus the actions an issued invoice
 * still accepts — record a payment, cancel, share, print.
 *
 * The document here is rebuilt from the STORED row, not from editor state, so
 * this page is also the proof that a saved draft reconstructs exactly (§46):
 * if what you see here differs from the builder, the round trip lost
 * something.
 */
export function InvoiceDetailPage() {
  const { id = '' } = useParams();
  const query = useQuery({ queryKey: ['invoices.get', id], queryFn: () => invoicesApi.get(id) });
  return <QueryState query={query}>{(inv: Invoice) => <Body inv={inv} />}</QueryState>;
}

/** Rebuild the renderer's input from a stored invoice. */
export function docFromInvoice(inv: Invoice): InvoiceDoc {
  const cfg = (inv.layout_config ?? {}) as Partial<LayoutConfig> & { company?: Partial<CompanyInfo> };
  const lines = inv.items.map((i) => ({
    key: lineKey(),
    itemName: i.item_name,
    description: i.description ?? '',
    hsnSac: i.hsn_sac ?? '',
    quantityCenti: i.quantity_centi,
    unit: i.unit ?? 'Nos',
    ratePaise: i.rate_paise,
    discountPercent: i.discount_percent,
    gstRatePercent: i.gst_rate_percent,
  }));
  const blocks = (Array.isArray(inv.block_config) && inv.block_config.length
    ? (inv.block_config as unknown as BlockSpec[])
    : defaultBlocks());

  return {
    layout: { ...DEFAULT_LAYOUT, ...cfg },
    blocks,
    company: { ...DEFAULT_COMPANY, ...(cfg.company ?? {}) },
    invoiceNumber: inv.invoice_number ?? 'DRAFT',
    invoiceDate: inv.invoice_date,
    termsLabel: TERM_LABEL[inv.terms] ?? inv.terms,
    dueDate: inv.due_date,
    placeOfSupply: stateName(inv.place_of_supply ?? ''),
    isInterState: inv.is_inter_state,
    billingName: inv.billing_name ?? '',
    billingAddress: inv.billing_address ?? '',
    shippingName: inv.shipping_name ?? '',
    shippingAddress: inv.shipping_address ?? '',
    customerGstin: inv.customer_gstin ?? '',
    lines,
    totals: computeTotals(lines, {
      invoiceDiscountPaise: inv.discount_paise,
      isInterState: inv.is_inter_state,
      // Settled = cash + TDS + credit notes, so the balance (and a UPI QR
      // carrying it) matches the server's balance_due_paise.
      amountPaidPaise: inv.amount_paid_paise + (inv.tds_deducted_paise ?? 0) + (inv.credited_paise ?? 0),
    }),
    notes: inv.notes ?? '',
    bank: inv.bank_snapshot,
    signatoryName: inv.signatory_name ?? '',
    signatoryDesignation: inv.signatory_designation ?? '',
    footerNote: inv.footer_note ?? '',
    qrMode: inv.qr_mode ?? 'upi_amount',
    qrValue: inv.qr_value ?? '',
    qrImage: inv.qr_image ?? null,
    amountPaidPaise: inv.amount_paid_paise,
    // The stored row is authoritative here — never the mirror.
    totalInWords: inv.total_in_words,
  };
}

function Body({ inv }: { inv: Invoice }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { session } = useAuth();
  const mayWrite = can(session?.role.code, 'workstation.invoice.manage', 'self');
  const [payOpen, setPayOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const remove = useMutation({
    mutationFn: () => invoicesApi.remove(inv.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invoices.list'] });
      void qc.invalidateQueries({ queryKey: ['invoices.summary'] });
      toast.push('success', 'Draft invoice deleted.');
      navigate('/workstation/invoices');
    },
    onError: (e: Error) => { setDeleting(false); toast.push('error', e.message); },
  });

  const after = (msg: string) => (updated: Invoice) => {
    void qc.invalidateQueries({ queryKey: ['invoices.get', updated.id] });
    void qc.invalidateQueries({ queryKey: ['invoices.list'] });
    void qc.invalidateQueries({ queryKey: ['invoices.summary'] });
    toast.push('success', msg);
  };

  const send = useMutation({
    mutationFn: () => invoicesApi.send(inv.id),
    onSuccess: after('Invoice sent. Its figures are now fixed.'),
    onError: (e: Error) => toast.push('error', e.message),
  });
  const pdf = useMutation({
    mutationFn: () => invoicesApi.pdfUrl(inv.id),
    onSuccess: (r) => downloadFile(r.url, `${inv.invoice_number ?? 'invoice'}.pdf`),
    onError: (e: Error) => toast.push('error', e.message),
  });


  // Share as a public download LINK: email and WhatsApp both carry the link
  // in the message body; the recipient opens the PDF from any device.
  const [emailing, setEmailing] = useState(false);
  const note =
    `Dear ${inv.billing_name || inv.client_name || 'Sir/Madam'},\n\nPlease download invoice ${inv.invoice_number ?? 'Draft'} dated ${fmtDate(inv.invoice_date)} from the link below.\n`
    + `Amount: ₹${inrAmount(inv.total_paise)}`
    + (inv.balance_due_paise > 0 && inv.due_date ? `\nBalance due: ₹${inrAmount(inv.balance_due_paise)} by ${fmtDate(inv.due_date)}` : '')
    + `\n\nRegards`;
  const [whatsapping, setWhatsapping] = useState(false);
  // Payment reminder — same email / WhatsApp dialogs, with a reminder note.
  const [reminding, setReminding] = useState<null | 'menu' | 'email' | 'whatsapp'>(null);
  const reminder =
    `Dear ${inv.billing_name || inv.client_name || 'Sir/Madam'},\n\nThis is a gentle reminder that invoice ${inv.invoice_number ?? 'Draft'} dated ${fmtDate(inv.invoice_date)}`
    + ` has a balance of ₹${inrAmount(inv.balance_due_paise)}${inv.due_date ? `, which was due on ${fmtDate(inv.due_date)}` : ''}.`
    + `\nYou can download the invoice from the link below. Kindly arrange the payment at the earliest, or let us know if it has already been made.\n\nThank you,\nRegards`;
  const canRemind = mayWrite && inv.balance_due_paise > 0 && inv.stored_status !== 'draft' && inv.stored_status !== 'cancelled';
  // The server-sent reminder email (with the PDF link), logged in the reminder history.
  const canServerRemind = canRemind && inv.status === 'overdue' && Boolean(inv.party_email);
  const remind = useMutation({
    mutationFn: () => invoicesApi.remind(inv.id),
    onSuccess: (r) => {
      setReminding(null);
      void qc.invalidateQueries({ queryKey: ['invoices.reminders', inv.id] });
      toast.push('success', `Reminder emailed to ${r.to.join(', ')}.`);
    },
    onError: (e: Error) => { setReminding(null); toast.push('error', e.message); },
  });
  const mayCredit = mayWrite && ['sent', 'partially_paid', 'paid'].includes(inv.stored_status);
  const settledPaise = inv.total_paise - inv.balance_due_paise;

  return (
    <>
      <Modal open={deleting} title="Delete draft invoice?" onClose={() => setDeleting(false)} footer={
        <>
          <Button onClick={() => setDeleting(false)}>Cancel</Button>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? 'Deleting…' : 'Delete invoice'}</Button>
        </>
      }>
        <p className="p-4 text-13 text-neutral-700">This draft has no invoice number yet and is removed permanently.</p>
      </Modal>
      <SendEmailDialog
        open={emailing} onClose={() => setEmailing(false)} kind="invoice" id={inv.id}
        to={inv.party_email} subject={`Invoice ${inv.invoice_number ?? 'Draft'} from ${docFromInvoice(inv).company.name}`} message={note}
      />
      <SendWhatsAppDialog
        open={whatsapping} onClose={() => setWhatsapping(false)} kind="invoice" id={inv.id} phone={inv.party_contact_number}
        note={note}
      />
      <SendEmailDialog
        open={reminding === 'email'} onClose={() => setReminding(null)} kind="invoice" id={inv.id}
        to={inv.party_email} subject={`Payment reminder — invoice ${inv.invoice_number ?? 'Draft'}`} message={reminder}
      />
      <SendWhatsAppDialog
        open={reminding === 'whatsapp'} onClose={() => setReminding(null)} kind="invoice" id={inv.id} phone={inv.party_contact_number}
        note={reminder}
      />
      <div className="qdoc-screen-only">
        <EntityHeader
          name={inv.billing_name || inv.client_name || 'Invoice'}
          square
          title={<span className="font-mono tracking-[-0.01em]">{inv.invoice_number ?? 'Draft invoice'}</span>}
          idLine={<>
            <span className="font-sans">{inv.billing_name || inv.client_name}</span>
            <span>· {fmtDate(inv.invoice_date)}</span>
          </>}
          chips={<>
            <StatusPill status={inv.status} />
            {inv.is_overdue ? <HeaderTag tone="bad">● {daysLate(inv.due_date)} days overdue</HeaderTag> : null}
            {inv.recurring_profile_id ? (
              <Link to="/workstation/recurring-invoices" title="Raised by a recurring retainer profile">
                <HeaderTag tone="teal"><Repeat size={12} />From recurring profile</HeaderTag>
              </Link>
            ) : null}
          </>}
          stats={[
            { label: 'Total', value: `₹${inrAmount(inv.total_paise)}` },
            { label: 'Paid', value: `₹${inrAmount(inv.amount_paid_paise)}`, tone: inv.amount_paid_paise > 0 ? 'ok' : undefined },
            { label: 'Balance due', value: `₹${inrAmount(inv.balance_due_paise)}`, tone: inv.balance_due_paise > 0 && inv.is_overdue ? 'bad' : undefined },
            { label: 'Due date', value: inv.due_date ? fmtDate(inv.due_date) : '—', tone: inv.is_overdue ? 'bad' : undefined },
          ]}
          actions={
            <span className="flex gap-2 flex-wrap">
              {canRemind ? (
                <span className="relative">
                  <button type="button" onClick={() => setReminding(reminding === 'menu' ? null : 'menu')}
                    className={'inline-flex items-center gap-[6px] h-9 px-3 rounded-[10px] text-13 font-semibold shadow-card ' + (inv.is_overdue ? 'bg-danger text-white' : 'bg-surface text-ink')}
                    aria-haspopup="menu" aria-expanded={reminding === 'menu'}>
                    <Send size={14} />Send reminder
                  </button>
                  {reminding === 'menu' ? (
                    <span role="menu" className="gs-panel absolute right-0 top-11 z-30 w-[220px] p-1 bg-surface border border-border rounded-[12px] shadow-drawer flex flex-col">
                      {canServerRemind ? (
                        <button type="button" role="menuitem" disabled={remind.isPending} onClick={() => remind.mutate()}
                          title={`Emails ${inv.party_email} a reminder with the invoice link`}
                          className="flex items-center gap-2 h-9 px-3 rounded-md text-13 text-ink hover:bg-canvas disabled:opacity-50"><BellRing size={15} />{remind.isPending ? 'Sending…' : 'Email reminder now'}</button>
                      ) : null}
                      <button type="button" role="menuitem" onClick={() => setReminding('whatsapp')} className="flex items-center gap-2 h-9 px-3 rounded-md text-13 text-ink hover:bg-canvas"><MessageCircle size={15} />On WhatsApp</button>
                      <button type="button" role="menuitem" onClick={() => setReminding('email')} className="flex items-center gap-2 h-9 px-3 rounded-md text-13 text-ink hover:bg-canvas"><Mail size={15} />By email</button>
                    </span>
                  ) : null}
                </span>
              ) : null}
              {mayWrite && inv.stored_status === 'draft' ? (
                <Button variant="primary" disabled={send.isPending} onClick={() => send.mutate()}>Send</Button>
              ) : null}
              {mayWrite && inv.balance_due_paise > 0 && inv.stored_status !== 'draft' && inv.stored_status !== 'cancelled' ? (
                <Button variant="primary" onClick={() => setPayOpen(true)}>Record payment</Button>
              ) : null}
              <InvoiceActionsMenu
                inv={inv} mayWrite={mayWrite} pdfBusy={pdf.isPending}
                onDownload={() => pdf.mutate()} onWhatsApp={() => setWhatsapping(true)} onEmail={() => setEmailing(true)}
                onSend={() => send.mutate()} onPay={() => setPayOpen(true)} onCancel={() => setCancelOpen(true)}
                onDelete={() => setDeleting(true)} mayCredit={mayCredit}
              />
            </span>
          }
        >
          {inv.total_paise > 0 && inv.stored_status !== 'draft' ? (
            <div className="mt-5">
              <div className="flex justify-between text-12 text-inkMuted mb-[6px]">
                <span>Settled {Math.round((settledPaise / inv.total_paise) * 100)}%</span>
                <span>{inv.balance_due_paise > 0 ? `₹${inrAmount(inv.balance_due_paise)} to collect` : 'Fully settled'}</span>
              </div>
              <div className="h-2 rounded-full bg-neutral-100 overflow-hidden">
                <i className="block h-full rounded-full bg-success transition-[width]" style={{ width: `${Math.min(100, Math.max(0, (settledPaise / inv.total_paise) * 100))}%` }} />
              </div>
            </div>
          ) : null}
        </EntityHeader>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
          <Card title="Invoice">
            <div className="p-4">
              <Detail label="Invoice date" value={fmtDate(inv.invoice_date)} />
              <Detail label="Terms" value={TERM_LABEL[inv.terms] ?? inv.terms} />
              <Detail label="Due date" value={fmtDate(inv.due_date)} />
              <Detail label="Place of supply" value={inv.place_of_supply ?? '—'} />
              <Detail label="Tax" value={inv.is_inter_state ? 'IGST (inter-state)' : 'CGST + SGST'} />
            </div>
          </Card>
          <Card title="Money">
            <div className="p-4">
              <Detail label="Sub total" value={`₹ ${inrAmount(inv.subtotal_paise)}`} />
              {inv.discount_paise > 0 ? <Detail label="Discount" value={`- ₹ ${inrAmount(inv.discount_paise)}`} /> : null}
              {inv.is_inter_state
                ? <Detail label="IGST" value={`₹ ${inrAmount(inv.igst_paise)}`} />
                : <>
                    <Detail label="CGST" value={`₹ ${inrAmount(inv.cgst_paise)}`} />
                    <Detail label="SGST" value={`₹ ${inrAmount(inv.sgst_paise)}`} />
                  </>}
              {inv.round_off_paise !== 0 ? <Detail label="Round off" value={`₹ ${inrAmount(inv.round_off_paise)}`} /> : null}
              <Detail label="Total" value={`₹ ${inrAmount(inv.total_paise)}`} />
              <Detail label="Paid" value={`₹ ${inrAmount(inv.amount_paid_paise)}`} />
              {inv.tds_deducted_paise > 0 ? <Detail label="TDS deducted" value={`₹ ${inrAmount(inv.tds_deducted_paise)}`} /> : null}
              {inv.credited_paise > 0 ? <Detail label="Credit notes" value={`- ₹ ${inrAmount(inv.credited_paise)}`} /> : null}
              <Detail label="Balance due" value={`₹ ${inrAmount(inv.balance_due_paise)}`} />
            </div>
          </Card>
          <Card title="Bill to">
            <div className="p-4">
              <Detail label="Name" value={inv.billing_name ?? '—'} />
              <Detail label="Address" value={inv.billing_address ?? '—'} />
              <Detail label="GSTIN" value={inv.customer_gstin ?? '—'} />
              <Detail
                label="Ship to"
                value={inv.ship_same_as_bill ? 'Same as Bill To' : `${inv.shipping_name ?? ''}`}
              />
              <span className="block text-12 text-neutral-500 mt-2">
                A snapshot taken when the invoice was written. Editing the client master does not change it.
              </span>
            </div>
          </Card>
        </div>

        {inv.stored_status !== 'draft' ? (
          <>
            <PaymentsCard inv={inv} mayWrite={mayWrite} />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
              <CreditNotesCard inv={inv} mayCredit={mayCredit} />
              <RemindersCard inv={inv} />
            </div>
          </>
        ) : null}

        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">Document</div>
      </div>

      <DocumentPane inv={inv} />

      <PaymentModal inv={inv} open={payOpen} onClose={() => setPayOpen(false)} onDone={after('Payment recorded.')} />
      <CancelModal inv={inv} open={cancelOpen} onClose={() => setCancelOpen(false)} onDone={after('Invoice cancelled.')} />
    </>
  );
}

function DocumentPane({ inv }: { inv: Invoice }) {
  const doc = docFromInvoice(inv);
  return (
    <div className="qb-preview">
      <InvoiceDocument doc={doc} scale={1} />
    </div>
  );
}

function PaymentModal({ inv, open, onClose, onDone }: {
  inv: Invoice; open: boolean; onClose: () => void; onDone: (i: Invoice) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [tds, setTds] = useState('');
  const [tdsSection, setTdsSection] = useState<TdsSection>('194J');
  const [certReceived, setCertReceived] = useState(false);
  const [paidOn, setPaidOn] = useState(istToday());
  const [mode, setMode] = useState<PaymentMode>('bank_transfer');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  // Fresh form each time it opens, defaulting to the full balance.
  useEffect(() => {
    if (!open) return;
    setAmount(String(inv.balance_due_paise / 100));
    setTds('');
    setTdsSection('194J');
    setCertReceived(false);
    setPaidOn(istToday());
    setMode('bank_transfer');
    setReference('');
    setNote('');
  }, [open, inv.balance_due_paise]);

  const toPaise = (v: string) => Math.max(0, Math.round((Number(v) || 0) * 100));
  const amountPaise = toPaise(amount);
  const tdsPaise = toPaise(tds);
  const after = inv.balance_due_paise - amountPaise - tdsPaise;
  // Typing a TDS figure while the cash amount still settles the whole balance
  // takes the TDS out of the cash, so the pair keeps settling the invoice.
  const changeTds = (v: string) => {
    const next = toPaise(v);
    if (amountPaise + tdsPaise === inv.balance_due_paise) {
      setAmount(String(Math.max(0, inv.balance_due_paise - next) / 100));
    }
    setTds(v);
  };
  const pay = useMutation({
    mutationFn: () => invoicesApi.recordPayment(inv.id, amountPaise, {
      paid_on: paidOn, mode, reference: reference.trim() || undefined, note: note.trim() || undefined,
      ...(tdsPaise > 0 ? { tds_paise: tdsPaise, tds_section: tdsSection, tds_certificate_received: certReceived } : {}),
    }),
    onSuccess: (i) => {
      void qc.invalidateQueries({ queryKey: ['payment-summary'] });
      void qc.invalidateQueries({ queryKey: ['invoices.payments', inv.id] });
      onDone(i);
      onClose();
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const quick = (fraction: number) => setAmount(String(Math.max(0, Math.round(inv.balance_due_paise * fraction) - tdsPaise) / 100));
  const errs = fieldErrors(pay.error);
  return (
    <Modal
      open={open} title="Record a payment" onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={pay.isPending || amountPaise + tdsPaise <= 0 || after < 0} onClick={() => pay.mutate()}>Record</Button>
        </>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Amount received (₹)" error={errs.amount_paise}>
          <input className={inputClass} type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="TDS deducted (₹, optional)" error={errs.tds_paise}>
          <input className={inputClass} type="number" step="0.01" min="0" value={tds} placeholder="0.00" onChange={(e) => changeTds(e.target.value)} />
        </Field>
      </div>
      <p className={'text-12 -mt-1 mb-3 ' + (after < 0 ? 'text-red' : 'text-neutral-500')}>
        Amount + TDS settles the invoice.{' '}
        {after > 0
          ? `₹ ${inrAmount(after)} will still be pending — record the rest as another instalment later.`
          : after === 0 ? 'This clears the invoice.' : `Amount + TDS can be at most ₹ ${inrAmount(inv.balance_due_paise)}.`}
      </p>
      <div className="flex gap-2 -mt-1 mb-3 flex-wrap">
        {([['Full', 1], ['Half', 0.5], ['A third', 1 / 3], ['A quarter', 0.25]] as const).map(([label, f]) => (
          <button key={label} type="button" onClick={() => quick(f)}
            className="h-7 px-3 text-12 rounded-full border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50">
            {label}
          </button>
        ))}
      </div>
      {tdsPaise > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="TDS section" error={errs.tds_section}>
            <select className={inputClass} value={tdsSection} onChange={(e) => setTdsSection(e.target.value as TdsSection)}>
              {TDS_SECTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <label className="flex items-center gap-2 text-13 text-neutral-700 mb-3 sm:mt-6">
            <input type="checkbox" checked={certReceived} onChange={(e) => setCertReceived(e.target.checked)} />
            TDS certificate (Form 16A) received
          </label>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Received on">
          <input className={inputClass} type="date" max={istToday()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label="Mode">
          <select className={inputClass} value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)}>
            {(Object.keys(PAYMENT_MODE_LABEL) as PaymentMode[]).map((m) => <option key={m} value={m}>{PAYMENT_MODE_LABEL[m]}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Reference (UTR, cheque no., UPI ID…)">
        <input className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
      </Field>
      <Field label="Note">
        <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. 1st of 3 agreed instalments" />
      </Field>
      <p className="text-12 text-neutral-500">
        Each payment is kept as an instalment with its own receipt — see them all under HRMS → Payment summary. Overpayment is refused.
      </p>
    </Modal>
  );
}

/** Every payment against the invoice, with its receipt and the TDS it carried. */
function PaymentsCard({ inv, mayWrite }: { inv: Invoice; mayWrite: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['invoices.payments', inv.id], queryFn: () => invoicesApi.payments(inv.id) });
  const cert = useMutation({
    mutationFn: (p: { id: string; on: boolean }) => invoicesApi.setTdsCertificate(inv.id, p.id, p.on),
    onSuccess: (_r, p) => {
      void qc.invalidateQueries({ queryKey: ['invoices.payments', inv.id] });
      toast.push('success', p.on ? 'Form 16A marked received.' : 'Form 16A marked not received.');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const receipt = useMutation({
    mutationFn: (p: InvoicePayment) => invoicesApi.receiptUrl(inv.id, p.id),
    onSuccess: (r, p) => downloadFile(r.url, `${p.receipt_number}.pdf`),
    onError: (e: Error) => toast.push('error', e.message),
  });
  return (
    <div className="mb-4">
      <Card title="Payments">
        <QueryState query={q} empty={<>No payments recorded yet.</>}>
          {(data) => (
            <ListTable float={false} cols={[
              'Receipt', 'Received on', 'Mode', { label: 'Cash', align: 'right' }, { label: 'TDS', align: 'right' },
              'Form 16A', { label: '', key: 'dl' },
            ]}>
              {data.items.map((p) => (
                <ListRow key={p.id}>
                  <TD first strong nowrap className="tracking-[0.02em]">{p.receipt_number}</TD>
                  <TD muted nowrap>{fmtDay(p.paid_on)}</TD>
                  <TD muted>
                    {p.mode ? (PAYMENT_MODE_LABEL[p.mode as PaymentMode] ?? p.mode) : '—'}
                    {p.reference ? <span className="block text-11 text-neutral-500">{p.reference}</span> : null}
                  </TD>
                  <TD right nowrap className="tabular-nums"><Money value={`₹${inrAmount(p.amount_paise)}`} /></TD>
                  <TD right nowrap className="tabular-nums">
                    {p.tds_paise > 0 ? <><Money value={`₹${inrAmount(p.tds_paise)}`} />{p.tds_section ? <span className="text-11 text-neutral-500"> · {p.tds_section}</span> : null}</> : '—'}
                  </TD>
                  <TD>
                    {p.tds_paise > 0 ? (
                      <label className="inline-flex items-center gap-2 text-13 text-neutral-700 whitespace-nowrap">
                        <input type="checkbox" checked={p.tds_certificate_received} disabled={!mayWrite || cert.isPending}
                          onChange={(e) => cert.mutate({ id: p.id, on: e.target.checked })} />
                        {p.tds_certificate_received ? 'Received' : 'Pending'}
                      </label>
                    ) : <span className="text-neutral-500">—</span>}
                  </TD>
                  <TD last>
                    <button type="button" disabled={receipt.isPending} onClick={() => receipt.mutate(p)}
                      className="inline-flex items-center gap-1 text-13 text-primary hover:underline whitespace-nowrap disabled:opacity-50">
                      <Receipt size={13} /> Receipt
                    </button>
                  </TD>
                </ListRow>
              ))}
            </ListTable>
          )}
        </QueryState>
      </Card>
    </div>
  );
}

/** Credit notes raised against this invoice. */
function CreditNotesCard({ inv, mayCredit }: { inv: Invoice; mayCredit: boolean }) {
  const q = useQuery({
    queryKey: ['creditNotes.list', { invoice_id: inv.id }],
    queryFn: () => creditNotesApi.list({ invoice_id: inv.id }),
  });
  return (
    <Card title="Credit notes" right={mayCredit ? (
      <Link to={`/workstation/credit-notes/new?invoice=${inv.id}`} className="text-13 text-primary hover:underline whitespace-nowrap">Issue credit note</Link>
    ) : undefined}>
      <QueryState query={q} empty={<>No credit notes against this invoice.</>}>
        {(data) => (
          <div>
            {data.items.map((cn: CreditNote) => (
              <Link key={cn.id} to={`/workstation/credit-notes/${cn.id}`}
                className="flex items-center gap-3 px-5 py-3 border-b border-neutral-100 last:border-b-0 hover:bg-neutral-50">
                <span className="min-w-0 flex-1">
                  <span className="block text-13 font-semibold text-neutral-900">{cn.display_number}</span>
                  <span className="block text-11 text-neutral-500 truncate">{fmtDay(cn.note_date)} · {CREDIT_NOTE_REASON_LABEL[cn.reason] ?? cn.reason}</span>
                </span>
                <span className="text-13 tabular-nums text-neutral-900 whitespace-nowrap"><Money value={`₹${inrAmount(cn.total_paise)}`} /></span>
                <StatusChip value={cn.status} />
              </Link>
            ))}
          </div>
        )}
      </QueryState>
    </Card>
  );
}

const REMINDER_STAGE: Record<string, string> = { manual: 'Manual', d7: '7 days overdue', d15: '15 days overdue', d30: '30 days overdue' };

/** The reminder emails sent for this invoice (manual and automatic). */
function RemindersCard({ inv }: { inv: Invoice }) {
  const q = useQuery({ queryKey: ['invoices.reminders', inv.id], queryFn: () => invoicesApi.reminders(inv.id) });
  return (
    <Card title="Reminders sent">
      <QueryState query={q} empty={<>No reminder emails sent yet.</>}>
        {(data) => (
          <div>
            {data.items.map((r, i) => (
              <div key={`${r.at}:${i}`} className="flex items-baseline gap-3 px-5 py-2 border-b border-neutral-100 last:border-b-0 text-13">
                <span className="text-neutral-900 whitespace-nowrap">{fmtDate(r.at)}</span>
                <span className="text-neutral-500 min-w-0 flex-1 truncate" title={r.to.join(', ')}>{r.to.join(', ')}</span>
                <span className="text-11 text-neutral-500 whitespace-nowrap">{REMINDER_STAGE[r.stage] ?? r.stage}{r.by ? ` · ${r.by}` : ''}</span>
              </div>
            ))}
          </div>
        )}
      </QueryState>
    </Card>
  );
}

function CancelModal({ inv, open, onClose, onDone }: {
  inv: Invoice; open: boolean; onClose: () => void; onDone: (i: Invoice) => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => invoicesApi.cancel(inv.id, reason || undefined),
    onSuccess: (i) => { onDone(i); onClose(); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  return (
    <Modal
      open={open} title={`Cancel ${inv.invoice_number ?? 'Draft'}?`} onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button variant="primary" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancel invoice</Button>
        </>
      }
    >
      <p className="text-13 mb-3">
        The invoice stays on the books with its number — a cancelled tax invoice is not deleted, because
        the number must remain accounted for.
      </p>
      <Field label="Reason" error={fieldErrors(cancel.error).reason}>
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

/**
 * Everything an invoice supports, in one menu — the same shape as the
 * quotation's Actions menu. Each item is enabled only in the states the
 * server accepts it.
 */
function InvoiceActionsMenu({ inv, mayWrite, pdfBusy, onDownload, onWhatsApp, onEmail, onSend, onPay, onCancel, onDelete, mayCredit }: {
  inv: Invoice; mayWrite: boolean; pdfBusy: boolean; mayCredit: boolean;
  onDownload: () => void; onWhatsApp: () => void; onEmail: () => void;
  onSend: () => void; onPay: () => void; onCancel: () => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const st = inv.stored_status;
  const canPay = inv.balance_due_paise > 0 && st !== 'draft' && st !== 'cancelled';
  const item = (disabled?: boolean, danger?: boolean) =>
    'w-full flex items-center gap-2 px-3 py-2 text-left ' +
    (disabled ? 'text-neutral-400 cursor-not-allowed' : danger ? 'text-red hover:bg-neutral-50' : 'text-neutral-800 hover:bg-neutral-50');
  const act = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
        className="h-10 px-4 inline-flex items-center gap-1.5 text-14 font-medium rounded-md border border-border bg-surface hover:bg-canvas"
      >
        Actions <ChevronDown size={14} />
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 top-11 z-20 w-64 py-1 bg-white border border-neutral-200 rounded-md shadow-lg text-13">
          <Link to={`/workstation/invoices/${inv.id}/preview`} className={item()} onClick={() => setOpen(false)}>
            <Printer size={14} /> Print / Save as PDF
          </Link>
          <button type="button" className={item(pdfBusy)} disabled={pdfBusy} onClick={act(onDownload)}><Download size={14} /> Download PDF</button>
          <button type="button" className={item()} onClick={act(onWhatsApp)}><MessageCircle size={14} /> Send on WhatsApp</button>
          <button type="button" className={item(!inv.party_email)} disabled={!inv.party_email}
            title={inv.party_email ? undefined : 'No email address for this client'} onClick={act(onEmail)}>
            <Mail size={14} /> Send by email
          </button>
          <div className="my-1 border-t border-neutral-200" />
          {mayWrite && inv.is_editable ? (
            <Link to={`/workstation/invoices/${inv.id}/edit`} className={item()} onClick={() => setOpen(false)}>
              <Pencil size={14} /> Edit invoice
            </Link>
          ) : (
            <button type="button" className={item(true)} disabled title={mayWrite ? 'A sent invoice is fixed — cancel it and raise a new one' : 'Your role cannot edit invoices'}>
              <Pencil size={14} /> Edit invoice
            </button>
          )}
          <button type="button" className={item(!mayWrite || st !== 'draft')} disabled={!mayWrite || st !== 'draft'}
            title={st === 'draft' ? undefined : 'Only a draft can be marked sent'} onClick={act(onSend)}>
            <Send size={14} /> Mark as sent
          </button>
          <button type="button" className={item(!mayWrite || !canPay)} disabled={!mayWrite || !canPay}
            title={canPay ? undefined : st === 'draft' ? 'Send the invoice first' : 'Nothing is due on this invoice'} onClick={act(onPay)}>
            <Wallet size={14} /> Record payment
          </button>
          {mayCredit ? (
            <Link to={`/workstation/credit-notes/new?invoice=${inv.id}`} className={item()} onClick={() => setOpen(false)}>
              <FileMinus size={14} /> Issue credit note
            </Link>
          ) : (
            <button type="button" className={item(true)} disabled title={mayWrite ? 'Only a sent or paid invoice can be credited' : 'Your role cannot issue credit notes'}>
              <FileMinus size={14} /> Issue credit note
            </button>
          )}
          <button type="button" className={item(!mayWrite || st === 'cancelled' || st === 'paid')} disabled={!mayWrite || st === 'cancelled' || st === 'paid'}
            title={st === 'cancelled' ? 'Already cancelled' : st === 'paid' ? 'A paid invoice cannot be cancelled' : undefined} onClick={act(onCancel)}>
            <Ban size={14} /> Cancel invoice
          </button>
          <div className="my-1 border-t border-neutral-200" />
          <button type="button" className={item(!mayWrite || !inv.is_editable, true)} disabled={!mayWrite || !inv.is_editable}
            title={inv.is_editable ? undefined : 'Only a draft can be deleted — cancel a sent invoice instead'} onClick={act(onDelete)}>
            <Trash2 size={14} /> Delete invoice
          </button>
        </div>
      ) : null}
    </div>
  );
}
