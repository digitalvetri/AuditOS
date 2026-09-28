import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Ban, ChevronDown, Download, Mail, MessageCircle, Pencil, Printer, Send, Trash2, Wallet } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  invoicesApi, TERM_LABEL, type Invoice,
} from '@/modules/workstation/invoices/api';
import { downloadFile } from '@/modules/workstation/invoices/download';
import {
  DEFAULT_COMPANY, DEFAULT_LAYOUT, computeTotals, defaultBlocks, inrAmount, lineKey, stateName,
  type BlockSpec, type CompanyInfo, type LayoutConfig,
} from '@/modules/workstation/invoices/document';
import { InvoiceDocument, type InvoiceDoc } from './InvoiceDocument';
import { StatusPill } from './InvoiceBuilder';
import {
  Card, Detail, Field, Modal, PageHeader, QueryState, fieldErrors, inputClass,
} from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { fmtDate } from '@/lib/format';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';
import { SendEmailDialog } from '@/modules/workstation/SendEmailDialog';
import { SendWhatsAppDialog } from '@/modules/workstation/SendWhatsAppDialog';

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
    invoiceNumber: inv.invoice_number,
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
      amountPaidPaise: inv.amount_paid_paise,
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


  // Share as a PDF FILE: WhatsApp via the share sheet (or download + WhatsApp
  // Web), email sent by the server with the PDF attached.
  const [emailing, setEmailing] = useState(false);
  const fileName = `${inv.invoice_number ?? 'invoice'}.pdf`;
  const note =
    `Dear ${inv.billing_name || inv.client_name || 'Sir/Madam'},\n\nPlease find attached invoice ${inv.invoice_number} dated ${fmtDate(inv.invoice_date)}.\n`
    + `Amount: ₹${inrAmount(inv.total_paise)}`
    + (inv.balance_due_paise > 0 && inv.due_date ? `\nBalance due: ₹${inrAmount(inv.balance_due_paise)} by ${fmtDate(inv.due_date)}` : '')
    + `\n\nRegards`;
  const [whatsapping, setWhatsapping] = useState(false);

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
        open={emailing} onClose={() => setEmailing(false)} kind="invoice" id={inv.id} fileName={fileName}
        to={inv.party_email} subject={`Invoice ${inv.invoice_number} from ${docFromInvoice(inv).company.name}`} message={note}
      />
      <SendWhatsAppDialog
        open={whatsapping} onClose={() => setWhatsapping(false)} kind="invoice" id={inv.id} phone={inv.party_contact_number}
        fileName={fileName} note={note} issueUrl={() => invoicesApi.pdfUrl(inv.id)}
      />
      <div className="qdoc-screen-only">
        <PageHeader
          title={inv.invoice_number}
          subtitle={<>{inv.billing_name || inv.client_name} · <StatusPill status={inv.status} /></>}
          action={
            <span className="flex gap-2 flex-wrap">
              {mayWrite && inv.stored_status === 'draft' ? (
                <Button variant="primary" disabled={send.isPending} onClick={() => send.mutate()}>Send</Button>
              ) : null}
              {mayWrite && inv.balance_due_paise > 0 && inv.stored_status !== 'draft' && inv.stored_status !== 'cancelled' ? (
                <Button variant="primary" onClick={() => setPayOpen(true)}>Record payment</Button>
              ) : null}
              <Button
                disabled={!inv.party_contact_number}
                title={inv.party_contact_number ? undefined : 'No contact number on the client record'}
                onClick={() => setWhatsapping(true)}
              >
                <MessageCircle size={14} /> WhatsApp
              </Button>
              <InvoiceActionsMenu
                inv={inv} mayWrite={mayWrite} pdfBusy={pdf.isPending}
                onDownload={() => pdf.mutate()} onWhatsApp={() => setWhatsapping(true)} onEmail={() => setEmailing(true)}
                onSend={() => send.mutate()} onPay={() => setPayOpen(true)} onCancel={() => setCancelOpen(true)}
                onDelete={() => setDeleting(true)}
              />
            </span>
          }
        />

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
  const [amount, setAmount] = useState(String(inv.balance_due_paise / 100));
  const pay = useMutation({
    mutationFn: () => invoicesApi.recordPayment(inv.id, Math.round((Number(amount) || 0) * 100)),
    onSuccess: (i) => { onDone(i); onClose(); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  return (
    <Modal
      open={open} title="Record a payment" onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={pay.isPending} onClick={() => pay.mutate()}>Record</Button>
        </>
      }
    >
      <Field label="Amount (₹)" error={fieldErrors(pay.error).amount_paise} hint={`At most ₹ ${inrAmount(inv.balance_due_paise)}.`}>
        <input className={inputClass} type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
      <p className="text-12 text-neutral-500">
        The status follows the money: paying the balance in full marks the invoice paid, anything less
        marks it partially paid. Overpayment is refused, because credit is not modelled.
      </p>
    </Modal>
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
      open={open} title={`Cancel ${inv.invoice_number}?`} onClose={onClose}
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
function InvoiceActionsMenu({ inv, mayWrite, pdfBusy, onDownload, onWhatsApp, onEmail, onSend, onPay, onCancel, onDelete }: {
  inv: Invoice; mayWrite: boolean; pdfBusy: boolean;
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
