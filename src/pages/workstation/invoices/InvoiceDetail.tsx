import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronDown, Download, Eye, Mail, MessageCircle, Printer, Trash2 } from 'lucide-react';
import {
  invoicesApi, TERM_LABEL, type Invoice,
} from '@/modules/workstation/invoices/api';
import { shareDocumentPdf, waNumber, type ShareChannel } from '@/modules/workstation/share';
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
  const [sharing, setSharing] = useState(false);
  const phone = waNumber(inv.client_contact_number);
  const shareMessage =
    `Invoice ${inv.invoice_number}\n${inv.billing_name ?? inv.client_name ?? ''}\n`
    + `Dated ${fmtDate(inv.invoice_date)} · Due ${fmtDate(inv.due_date)}`;
  const share = async (channel: ShareChannel) => {
    setSharing(true);
    try {
      await shareDocumentPdf({
        issueUrl: () => invoicesApi.pdfUrl(inv.id),
        fileName: `${inv.invoice_number ?? 'invoice'}.pdf`,
        subject: `Invoice ${inv.invoice_number}`,
        message: shareMessage,
        channel, phone, email: inv.client_email,
      });
    } catch (e) {
      toast.push('error', (e as { message?: string })?.message ?? 'The PDF could not be sent.');
    } finally {
      setSharing(false);
    }
  };

  function printDocument() {
    document.documentElement.classList.add('qdoc-printing');
    const done = () => {
      document.documentElement.classList.remove('qdoc-printing');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  }

  return (
    <>
      <div className="qdoc-screen-only">
        <PageHeader
          title={inv.invoice_number}
          subtitle={<>{inv.billing_name || inv.client_name} · <StatusPill status={inv.status} /></>}
          action={
            <span className="flex gap-2 flex-wrap items-center">
              {mayWrite && inv.is_editable ? (
                <Button onClick={() => navigate(`/workstation/invoices/${inv.id}/edit`)}>Edit draft</Button>
              ) : null}
              {mayWrite && inv.stored_status === 'draft' ? (
                <Button variant="primary" disabled={send.isPending} onClick={() => send.mutate()}>Send</Button>
              ) : null}
              {mayWrite && inv.balance_due_paise > 0 && inv.stored_status !== 'draft' && inv.stored_status !== 'cancelled' ? (
                <Button variant="primary" onClick={() => setPayOpen(true)}>Record payment</Button>
              ) : null}
              <ActionsMenu
                inv={inv}
                sharing={sharing}
                phone={phone}
                onPreview={() => navigate(`/workstation/invoices/${inv.id}/preview`)}
                onPrint={printDocument}
                onDownload={() => share('download')}
                onWhatsapp={() => share('whatsapp')}
                onEmail={() => share('email')}
                onCancel={() => setCancelOpen(true)}
                mayWrite={mayWrite}
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
 * Invoice Actions dropdown — mirrors EngagementActions and the quotation
 * Share menu so all three document pages open the same way. Utility
 * actions (Preview, Print, share as PDF, Cancel) live here; primary
 * workflow buttons (Edit draft, Send, Record payment) stay inline in the
 * header so a filer's next step is one click, not two.
 */
function ActionsMenu({
  inv, sharing, phone, mayWrite,
  onPreview, onPrint, onDownload, onWhatsapp, onEmail, onCancel,
}: {
  inv: Invoice;
  sharing: boolean;
  phone: string;
  mayWrite: boolean;
  onPreview: () => void;
  onPrint: () => void;
  onDownload: () => void;
  onWhatsapp: () => void;
  onEmail: () => void;
  onCancel: () => void;
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

  const run = (fn: () => void) => () => { setOpen(false); fn(); };
  const canCancel = mayWrite && inv.stored_status !== 'cancelled' && inv.stored_status !== 'paid';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
        className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50"
      >
        Actions <ChevronDown size={14} />
      </button>

      {open ? (
        <div role="menu" className="absolute right-0 top-9 z-20 w-64 py-1 bg-white border border-neutral-200 rounded-md shadow-lg text-13">
          <MenuItem onClick={run(onPreview)}><Eye size={14} /> Preview</MenuItem>
          <MenuItem onClick={run(onPrint)}><Printer size={14} /> Print / Save as PDF</MenuItem>
          <MenuItem disabled={sharing} onClick={run(onDownload)}><Download size={14} /> Download PDF</MenuItem>
          <MenuItem
            disabled={!phone || sharing}
            title={phone ? undefined : 'No contact number on the client record'}
            onClick={run(onWhatsapp)}
          ><MessageCircle size={14} /> Send on WhatsApp</MenuItem>
          <MenuItem
            disabled={!inv.client_email || sharing}
            title={inv.client_email ? undefined : 'No email on the client record'}
            onClick={run(onEmail)}
          ><Mail size={14} /> Send by email</MenuItem>

          {canCancel ? (
            <>
              <div className="my-1 border-t border-neutral-200" />
              <MenuItem danger onClick={run(onCancel)}><Trash2 size={14} /> Cancel invoice</MenuItem>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({ children, disabled, danger, title, onClick }: {
  children: ReactNode; disabled?: boolean; danger?: boolean; title?: string; onClick: () => void;
}) {
  const cls = 'w-full px-3 py-1.5 flex items-center gap-2 text-left '
    + (disabled ? 'text-neutral-400 cursor-not-allowed' : danger ? 'text-red hover:bg-neutral-50' : 'text-neutral-900 hover:bg-neutral-50');
  return (
    <button type="button" role="menuitem" title={title} disabled={disabled} onClick={onClick} className={cls}>
      {children}
    </button>
  );
}
