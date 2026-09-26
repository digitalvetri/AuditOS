import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { workstationApi } from '@/modules/workstation/api';
import { invoicesApi, TERM_LABEL, GST_RATES, QR_MODE_LABEL, type BankSnapshot, type Invoice, type QrMode, type Term } from '@/modules/workstation/invoices/api';
import { downloadFile } from '@/modules/workstation/invoices/download';
import {
  BLOCK_LABEL, DEFAULT_COMPANY, DEFAULT_FOOTER_NOTE, DEFAULT_LAYOUT, DEFAULT_NOTES,
  STATES, blockId, computeTotals, defaultBlocks, inrAmount, lineKey, newLine, stateName,
  type BlockSpec, type CompanyInfo, type LayoutConfig, type Line,
} from '@/modules/workstation/invoices/document';
import { InvoiceDocument, type InvoiceDoc } from './InvoiceDocument';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { Field, Modal, fieldErrors, inputClass, textareaClass } from '@/modules/workstation/components';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';

/**
 * INVOICE BUILDER — Workstation → Invoice → Create / Edit.
 *
 * Left: the editor. Right: the live A4 document. One state object drives
 * both, so there is no "save then preview" step and nothing to refresh —
 * every keystroke re-renders the same component that print and the PDF use.
 *
 * WHY THE PREVIEW CAN BE TRUSTED. The figures it shows come from
 * `invoices/document.ts#computeTotals`, a faithful mirror of the server's
 * `invoice/totals.ts`. The mirror exists only so the preview can update
 * without a round trip; the server still recomputes everything on save and
 * its numbers are what get stored. Whenever a saved invoice is open, the
 * document prefers the SERVER's total-in-words over the mirror's, so the
 * document never shows a figure the API did not produce.
 */

const today = () => new Date().toISOString().slice(0, 10);

type Tab = 'details' | 'items' | 'payment' | 'layout' | 'blocks';
const TABS: { id: Tab; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'items', label: 'Items' },
  { id: 'payment', label: 'Payment' },
  { id: 'layout', label: 'Layout' },
  { id: 'blocks', label: 'Blocks' },
];

export function InvoiceBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { session } = useAuth();
  const mayWrite = can(session?.role.code, 'workstation.invoice.manage', 'self');
  const [params] = useSearchParams();
  const prefillClientId = params.get('client_id');
  const prefilled = useRef(false);

  const existingQ = useQuery({
    queryKey: ['invoices.get', id], queryFn: () => invoicesApi.get(id!), enabled: isEdit,
  });
  const clientsQ = useQuery({ queryKey: ['invoices.clients'], queryFn: () => workstationApi.listClients() });
  const banksQ = useQuery({ queryKey: ['invoices.banks'], queryFn: () => invoicesApi.bankAccounts() });

  // ── One state object. Everything the document shows lives here. ────────
  const [clientId, setClientId] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [terms, setTerms] = useState<Term>('due_on_receipt');
  const [dueDate, setDueDate] = useState(today());
  const [placeOfSupply, setPlaceOfSupply] = useState('Tamil Nadu');
  const [isInterState, setIsInterState] = useState(false);
  const [billingName, setBillingName] = useState('');
  const [billingAddress, setBillingAddress] = useState('');
  const [shipSame, setShipSame] = useState(true);
  const [shippingName, setShippingName] = useState('');
  const [shippingAddress, setShippingAddress] = useState('');
  const [customerGstin, setCustomerGstin] = useState('');
  const [discountText, setDiscountText] = useState('');
  const [notes, setNotes] = useState(DEFAULT_NOTES);
  const [bankAccountId, setBankAccountId] = useState('');
  const [signatoryName, setSignatoryName] = useState('');
  const [signatoryDesignation, setSignatoryDesignation] = useState('');
  const [footerNote, setFooterNote] = useState(DEFAULT_FOOTER_NOTE);
  const [qrMode, setQrMode] = useState<QrMode>('upi_amount');
  const [qrValue, setQrValue] = useState('');
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [company, setCompany] = useState<CompanyInfo>(DEFAULT_COMPANY);
  const [layout, setLayout] = useState<LayoutConfig>(DEFAULT_LAYOUT);
  const [blocks, setBlocks] = useState<BlockSpec[]>(defaultBlocks);
  const [lines, setLines] = useState<Line[]>([newLine()]);

  const [tab, setTab] = useState<Tab>('details');
  const [mobileView, setMobileView] = useState<'edit' | 'preview'>('edit');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const saved = existingQ.data;
  const frozen = Boolean(saved && !saved.is_editable);

  // Hydrate once when editing — a second pass would stamp on typing.
  if (isEdit && saved && !loaded) {
    const cfg = (saved.layout_config ?? {}) as Partial<LayoutConfig> & { company?: Partial<CompanyInfo> };
    setClientId(saved.client_id);
    setInvoiceDate(saved.invoice_date);
    setTerms(saved.terms);
    setDueDate(saved.due_date);
    setPlaceOfSupply(stateName(saved.place_of_supply ?? 'Tamil Nadu'));
    setIsInterState(saved.is_inter_state);
    setBillingName(saved.billing_name ?? '');
    setBillingAddress(saved.billing_address ?? '');
    setShipSame(saved.ship_same_as_bill);
    setShippingName(saved.shipping_name ?? '');
    setShippingAddress(saved.shipping_address ?? '');
    setCustomerGstin(saved.customer_gstin ?? '');
    setDiscountText(saved.discount_paise ? String(saved.discount_paise / 100) : '');
    setNotes(saved.notes ?? '');
    setBankAccountId(saved.bank_account_id ?? '');
    setSignatoryName(saved.signatory_name ?? '');
    setSignatoryDesignation(saved.signatory_designation ?? '');
    setFooterNote(saved.footer_note ?? '');
    setQrMode(saved.qr_mode ?? 'upi_amount');
    setQrValue(saved.qr_value ?? '');
    setQrImage(saved.qr_image ?? null);
    setCompany({ ...DEFAULT_COMPANY, ...(cfg.company ?? {}) });
    setLayout({ ...DEFAULT_LAYOUT, ...cfg });
    if (Array.isArray(saved.block_config) && saved.block_config.length) {
      setBlocks(saved.block_config as unknown as BlockSpec[]);
    }
    setLines(saved.items.map((i) => ({
      key: lineKey(),
      itemName: i.item_name,
      description: i.description ?? '',
      hsnSac: i.hsn_sac ?? '',
      quantityCenti: i.quantity_centi,
      unit: i.unit ?? 'Nos',
      ratePaise: i.rate_paise,
      discountPercent: i.discount_percent,
      gstRatePercent: i.gst_rate_percent,
    })));
    setLoaded(true);
  }

  /** New invoice from a client workspace arrives as ?client_id=…. */
  useEffect(() => {
    if (id || prefilled.current || !prefillClientId || !clientsQ.data) return;
    if (!clientsQ.data.items.some((c) => c.id === prefillClientId)) return;
    prefilled.current = true;
    chooseClient(prefillClientId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, prefillClientId, clientsQ.data]);

  /**
   * Seed the default bank account ONCE, when the list first arrives.
   *
   * `bankAccountId` must not gate this. It used to, and the effect listed it
   * as a dependency — so choosing "None" emptied the field, the effect
   * re-fired, saw an empty field and put the default straight back. The
   * selection snapped back before the user let go of the mouse, which read as
   * "None does nothing". A ref fires this exactly once, so a deliberate None
   * survives.
   */
  const bankSeeded = useRef(false);
  useEffect(() => {
    if (bankSeeded.current || isEdit || !banksQ.data?.items.length) return;
    bankSeeded.current = true;
    setBankAccountId(banksQ.data.items[0].id);
  }, [banksQ.data, isEdit]);

  /**
   * §24 — the term drives the due date. 'custom' stops driving it, which is
   * the manual override; any other term recomputes, so changing the invoice
   * date moves the due date with it instead of silently leaving a stale one.
   */
  useEffect(() => {
    if (terms === 'custom') return;
    const days = { due_on_receipt: 0, net_7: 7, net_15: 15, net_30: 30, net_45: 45 }[terms];
    const d = new Date(`${invoiceDate}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return;
    d.setUTCDate(d.getUTCDate() + days);
    setDueDate(d.toISOString().slice(0, 10));
  }, [terms, invoiceDate]);

  /**
   * Selecting a client fills the invoice's OWN copies of name, address and
   * GSTIN. It never writes back to the client master (§9), and it overwrites
   * whatever was there because picking a different client is an explicit
   * instruction to re-address the invoice.
   */
  function chooseClient(cid: string) {
    setClientId(cid);
    const c = (clientsQ.data?.items ?? []).find((x) => x.id === cid);
    if (!c) return;
    setBillingName(c.company_name);
    setBillingAddress(c.address ?? '');
    setCustomerGstin(c.gstin ?? '');
  }

  const discountPaise = Math.max(0, Math.round((Number(discountText) || 0) * 100));
  const totals = useMemo(
    () => computeTotals(lines, { invoiceDiscountPaise: discountPaise, isInterState, amountPaidPaise: saved?.amount_paid_paise ?? 0 }),
    [lines, discountPaise, isInterState, saved?.amount_paid_paise],
  );

  /* An empty bankAccountId means "None", so the preview must show no bank
     block. Falling back to the saved snapshot here made None look ignored:
     the document kept printing the account the invoice was last saved with.
     The saved snapshot is only a fallback while the account list is still
     loading and a bank IS selected. */
  const bank = bankAccountId
    ? (banksQ.data?.items ?? []).find((b) => b.id === bankAccountId) ?? saved?.bank_snapshot ?? null
    : null;

  const doc: InvoiceDoc = {
    layout, blocks, company,
    invoiceNumber: saved?.invoice_number ?? 'Draft — number on save',
    invoiceDate,
    termsLabel: TERM_LABEL[terms],
    dueDate,
    placeOfSupply,
    isInterState,
    billingName, billingAddress,
    shippingName: shipSame ? billingName : shippingName,
    shippingAddress: shipSame ? billingAddress : shippingAddress,
    customerGstin,
    lines, totals, notes, bank,
    signatoryName, signatoryDesignation, footerNote,
    qrMode, qrValue, qrImage,
    amountPaidPaise: saved?.amount_paid_paise ?? 0,
    // Prefer the server's words whenever they exist for THESE figures.
    totalInWords: saved && saved.total_paise === totals.totalPaise ? saved.total_in_words : undefined,
  };

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!clientId) e.client_id = 'Choose a client.';
    if (!invoiceDate) e.invoice_date = 'Set the invoice date.';
    const real = lines.filter((l) => l.itemName.trim());
    if (real.length === 0) e.items = 'Add at least one item with a name.';
    if (lines.some((l) => l.hsnSac && !/^\d{4,8}$/.test(l.hsnSac))) {
      e.items = 'HSN/SAC must be 4 to 8 digits.';
    }
    setErrors(e);
    // The Save draft button lives at the top; a client / date / items error
    // would render further down the form and often below the fold, so the
    // user saw the click do "nothing." Toast + scroll makes the failure
    // reason visible without having to hunt.
    if (Object.keys(e).length > 0) {
      const first = Object.keys(e)[0];
      toast.push('error', e[first] ?? 'Fill in the highlighted fields before saving.');
      // requestAnimationFrame so the DOM has painted the highlight state.
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-field="${first}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return false;
    }
    return true;
  }

  function payload() {
    return {
      client_id: clientId,
      invoice_date: invoiceDate,
      terms,
      due_date: dueDate,
      place_of_supply: placeOfSupply,
      is_inter_state: isInterState,
      discount_paise: discountPaise,
      notes,
      billing_name: billingName,
      billing_address: billingAddress,
      ship_same_as_bill: shipSame,
      shipping_name: shipSame ? null : shippingName,
      shipping_address: shipSame ? null : shippingAddress,
      customer_gstin: customerGstin,
      bank_account_id: bankAccountId || null,
      template_id: 'tax-invoice',
      signatory_name: signatoryName,
      signatory_designation: signatoryDesignation,
      footer_note: footerNote,
      qr_mode: qrMode,
      qr_value: qrValue || null,
      qr_image: qrImage,
      layout_config: { ...layout, company } as Record<string, unknown>,
      block_config: blocks as unknown as Record<string, unknown>[],
      items: lines.filter((l) => l.itemName.trim()).map((l) => ({
        item_name: l.itemName,
        description: l.description || null,
        hsn_sac: l.hsnSac || null,
        quantity_centi: l.quantityCenti,
        unit: l.unit,
        rate_paise: l.ratePaise,
        discount_percent: l.discountPercent,
        gst_rate_percent: l.gstRatePercent,
      })),
    };
  }

  const save = useMutation({
    mutationFn: () => (isEdit ? invoicesApi.update(id!, payload()) : invoicesApi.create(payload())),
    onSuccess: (inv: Invoice) => {
      void qc.invalidateQueries({ queryKey: ['invoices.get', inv.id] });
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', `Invoice ${inv.invoice_number} saved.`);
      if (!isEdit) navigate(`/workstation/invoices/${inv.id}/edit`, { replace: true });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const send = useMutation({
    mutationFn: () => invoicesApi.send(id!),
    onSuccess: (inv) => {
      void qc.invalidateQueries({ queryKey: ['invoices.get', inv.id] });
      toast.push('success', `Invoice ${inv.invoice_number} sent. It is now locked.`);
      navigate(`/workstation/invoices/${inv.id}`);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  /** §28/§34 — print the document, never the application around it. */
  function printDocument() {
    document.documentElement.classList.add('qdoc-printing');
    const done = () => {
      document.documentElement.classList.remove('qdoc-printing');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  }

  const downloadPdf = useMutation({
    mutationFn: () => invoicesApi.pdfUrl(id!),
    onSuccess: (r) => downloadFile(r.url, `${saved?.invoice_number ?? 'invoice'}.pdf`),
    onError: (e: Error) => toast.push('error', e.message),
  });

  const serverErrors = fieldErrors(save.error);
  const err = (k: string) => errors[k] ?? serverErrors[k];

  return (
    <>
      <header className="flex items-start gap-3 flex-wrap mb-4 qdoc-screen-only">
        <div className="flex-1 min-w-[200px]">
          <h1 className="text-18 font-semibold text-neutral-900">Invoice builder</h1>
          <p className="text-12 text-neutral-500 mt-1">
            {saved
              ? <>{saved.invoice_number} · <StatusPill status={saved.status} /> {frozen ? '· issued, so the document is locked' : ''}</>
              : 'A number is allocated when you first save — never before, so nothing is reserved by a draft you abandon.'}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {mayWrite && !frozen ? (
            <Button variant="primary" disabled={save.isPending} onClick={() => { if (validate()) save.mutate(); }}>
              {save.isPending ? 'Saving…' : 'Save draft'}
            </Button>
          ) : null}
          <Button onClick={() => (isEdit ? navigate(`/workstation/invoices/${id}/preview`) : setPreviewOpen(true))}>
            Preview
          </Button>
          <Button onClick={printDocument}>Print</Button>
          {isEdit ? <Button disabled={downloadPdf.isPending} onClick={() => downloadPdf.mutate()}>Download PDF</Button> : null}
          {mayWrite && isEdit && saved?.stored_status === 'draft' ? (
            <Button disabled={send.isPending} onClick={() => send.mutate()}>Send</Button>
          ) : null}
        </div>
      </header>

      {frozen ? (
        <div className="border-l-2 border-neutral-400 bg-white px-3 py-2 text-13 mb-3 qdoc-screen-only">
          This invoice has been issued, so its figures are fixed. Record a payment or cancel it from the
          invoice page — editing an issued tax invoice is not something the API allows.
        </div>
      ) : null}

      {err('items') ? (
        <div data-field="items" className="border-l-2 border-red pl-3 text-13 mb-3 qdoc-screen-only">{err('items')}</div>
      ) : null}

      <div className="md:hidden flex gap-2 mb-3 qdoc-screen-only">
        {(['edit', 'preview'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setMobileView(v)}
            className={`h-8 px-4 text-13 rounded border ${mobileView === v ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white border-neutral-300'}`}
          >
            {v === 'edit' ? 'Edit' : 'Preview'}
          </button>
        ))}
      </div>

      {previewOpen ? (
        <FullPreview doc={doc} onClose={() => setPreviewOpen(false)} onPrint={printDocument} />
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
        {/* LEFT — the editor. */}
        <div className={`qdoc-screen-only ${mobileView === 'preview' ? 'hidden md:block' : ''}`}>
          <div className="flex gap-1 border-b border-neutral-200 mb-3">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`h-8 px-3 text-13 -mb-px border-b-2 ${tab === t.id ? 'border-neutral-900 text-neutral-900 font-medium' : 'border-transparent text-neutral-500'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <fieldset disabled={frozen} className={frozen ? 'opacity-60' : ''}>
            {tab === 'details' ? (
              <DetailsTab
                clients={clientsQ.data?.items ?? []}
                clientId={clientId} chooseClient={chooseClient}
                invoiceDate={invoiceDate} setInvoiceDate={setInvoiceDate}
                terms={terms} setTerms={setTerms}
                dueDate={dueDate} setDueDate={setDueDate}
                placeOfSupply={placeOfSupply} setPlaceOfSupply={setPlaceOfSupply}
                isInterState={isInterState} setIsInterState={setIsInterState}
                billingName={billingName} setBillingName={setBillingName}
                billingAddress={billingAddress} setBillingAddress={setBillingAddress}
                shipSame={shipSame} setShipSame={setShipSame}
                shippingName={shippingName} setShippingName={setShippingName}
                shippingAddress={shippingAddress} setShippingAddress={setShippingAddress}
                customerGstin={customerGstin} setCustomerGstin={setCustomerGstin}
                err={err}
              />
            ) : null}

            {tab === 'items' ? (
              <ItemsTab
                lines={lines} setLines={setLines}
                discountText={discountText} setDiscountText={setDiscountText}
                totals={totals} isInterState={isInterState}
              />
            ) : null}

            {tab === 'payment' ? (
              <PaymentTab
                banks={banksQ.data?.items ?? []}
                onBankAdded={(b) => { void banksQ.refetch(); setBankAccountId(b.id); }}
                bankAccountId={bankAccountId} setBankAccountId={setBankAccountId}
                notes={notes} setNotes={setNotes}
                signatoryName={signatoryName} setSignatoryName={setSignatoryName}
                signatoryDesignation={signatoryDesignation} setSignatoryDesignation={setSignatoryDesignation}
                footerNote={footerNote} setFooterNote={setFooterNote}
                qrMode={qrMode} setQrMode={setQrMode}
                qrValue={qrValue} setQrValue={setQrValue}
                qrImage={qrImage} setQrImage={setQrImage}
              />
            ) : null}

            {tab === 'layout' ? (
              <LayoutTab layout={layout} setLayout={setLayout} company={company} setCompany={setCompany} />
            ) : null}

            {tab === 'blocks' ? <BlocksTab blocks={blocks} setBlocks={setBlocks} /> : null}
          </fieldset>
        </div>

        {/* RIGHT — the live document. */}
        <div className={mobileView === 'edit' ? 'hidden md:block' : ''}>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2 qdoc-screen-only">
            Live preview
          </div>
          <PreviewPane doc={doc} />
        </div>
      </div>
    </>
  );
}

/**
 * Full-screen preview of the invoice being built, BEFORE it has been saved.
 *
 * A saved invoice has /workstation/invoices/:id/preview, which is a real
 * route with no CRM chrome around it. A draft has no id yet, so there is
 * nothing to route to — and making people save just to look at the document
 * is the "Save → Preview" workflow the brief rules out. This renders the same
 * InvoiceDocument from the live editor state instead.
 *
 * `qdoc-screen-only` on the toolbar keeps it off paper, and the document is
 * the same component print and the PDF use, so what is shown here is what
 * comes out.
 */
function FullPreview({ doc, onClose, onPrint }: {
  doc: InvoiceDoc; onClose: () => void; onPrint: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    // The page behind must not scroll under the overlay.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-neutral-100 overflow-auto print:bg-white print:static print:overflow-visible">
      <div className="max-w-[860px] print:max-w-none mx-auto py-6 print:py-0 px-3 print:px-0">
        <div className="flex items-center gap-2 mb-4 qdoc-screen-only print:hidden">
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50"
          >
            Close
          </button>
          <span className="text-12 text-neutral-500">
            Unsaved draft — save it to get a shareable link and the PDF.
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onPrint}
            className="h-8 px-3 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800"
          >
            Print
          </button>
        </div>
        <InvoiceDocument doc={doc} scale={1} />
      </div>
    </div>
  );
}

/**
 * The document at true paper size, scaled to whatever width the pane has.
 * Scaling the STACK rather than the content keeps text wrapping identical to
 * the PDF — scale the font instead and the preview stops predicting paper.
 */
function PreviewPane({ doc }: { doc: InvoiceDoc }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const pageWidth = 210 * (96 / 25.4);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScale(Math.min(1, (el.clientWidth - 8) / pageWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pageWidth]);

  return (
    <div ref={ref} className="qb-preview">
      <InvoiceDocument doc={doc} scale={scale} />
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone: Record<string, string> = {
    draft: 'bg-neutral-100 text-neutral-700',
    sent: 'bg-blue-50 text-blue-700',
    partially_paid: 'bg-amber-50 text-amber-700',
    paid: 'bg-green-50 text-green-700',
    overdue: 'bg-red-50 text-red-700',
    cancelled: 'bg-neutral-100 text-neutral-500 line-through',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-11 ${tone[status] ?? tone.draft}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

// ── DETAILS ───────────────────────────────────────────────────────────────

function Two({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-2">{children}</div>;
}

function DetailsTab(p: {
  clients: { id: string; company_name: string }[];
  clientId: string; chooseClient: (id: string) => void;
  invoiceDate: string; setInvoiceDate: (v: string) => void;
  terms: Term; setTerms: (v: Term) => void;
  dueDate: string; setDueDate: (v: string) => void;
  placeOfSupply: string; setPlaceOfSupply: (v: string) => void;
  isInterState: boolean; setIsInterState: (v: boolean) => void;
  billingName: string; setBillingName: (v: string) => void;
  billingAddress: string; setBillingAddress: (v: string) => void;
  shipSame: boolean; setShipSame: (v: boolean) => void;
  shippingName: string; setShippingName: (v: string) => void;
  shippingAddress: string; setShippingAddress: (v: string) => void;
  customerGstin: string; setCustomerGstin: (v: string) => void;
  err: (k: string) => string | undefined;
}) {
  return (
    <div>
      <div data-field="client_id">
        <Field label="Client" error={p.err('client_id')}>
          <select className={inputClass} value={p.clientId} onChange={(e) => p.chooseClient(e.target.value)}>
            <option value="">Select a client…</option>
            {p.clients.map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)}
          </select>
        </Field>
      </div>

      <Two>
        <div data-field="invoice_date">
          <Field label="Invoice date" error={p.err('invoice_date')}>
            <input type="date" className={inputClass} value={p.invoiceDate} onChange={(e) => p.setInvoiceDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Terms">
          <select className={inputClass} value={p.terms} onChange={(e) => p.setTerms(e.target.value as Term)}>
            {(Object.keys(TERM_LABEL) as Term[]).map((t) => <option key={t} value={t}>{TERM_LABEL[t]}</option>)}
          </select>
        </Field>
      </Two>

      <Field
        label="Due date"
        hint={p.terms === 'custom' ? 'Set it yourself.' : 'Derived from the term — choose Custom to override.'}
      >
        <input
          type="date" className={inputClass} value={p.dueDate}
          disabled={p.terms !== 'custom'}
          onChange={(e) => p.setDueDate(e.target.value)}
        />
      </Field>

      <Two>
        <Field label="Place of supply">
          <select className={inputClass} value={p.placeOfSupply} onChange={(e) => p.setPlaceOfSupply(e.target.value)}>
            {STATES.map((s) => <option key={s.code} value={s.name}>{s.name} ({s.code})</option>)}
          </select>
        </Field>
        <Field label="Tax split" hint={p.isInterState ? 'IGST' : 'CGST + SGST'}>
          <label className="flex items-center gap-2 text-13 h-9">
            <input type="checkbox" checked={p.isInterState} onChange={(e) => p.setIsInterState(e.target.checked)} />
            Inter-state supply
          </label>
        </Field>
      </Two>

      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mt-4 mb-2">Bill to</div>
      <Field label="Name">
        <input className={inputClass} value={p.billingName} onChange={(e) => p.setBillingName(e.target.value)} />
      </Field>
      <Field label="Address" hint="One line per line — the document keeps the breaks.">
        <textarea className={textareaClass} rows={3} value={p.billingAddress} onChange={(e) => p.setBillingAddress(e.target.value)} />
      </Field>
      <Field label="Customer GSTIN">
        <input className={inputClass} value={p.customerGstin} onChange={(e) => p.setCustomerGstin(e.target.value.toUpperCase())} />
      </Field>

      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mt-4 mb-2">Ship to</div>
      <label className="flex items-center gap-2 text-13 mb-2">
        <input type="checkbox" checked={p.shipSame} onChange={(e) => p.setShipSame(e.target.checked)} />
        Same as Bill To
      </label>
      {!p.shipSame ? (
        <>
          <Field label="Shipping name">
            <input className={inputClass} value={p.shippingName} onChange={(e) => p.setShippingName(e.target.value)} />
          </Field>
          <Field label="Shipping address">
            <textarea className={textareaClass} rows={3} value={p.shippingAddress} onChange={(e) => p.setShippingAddress(e.target.value)} />
          </Field>
        </>
      ) : null}

      <p className="text-12 text-neutral-500 mt-3">
        These are the invoice's own copies. Editing them here never changes the client master, and the
        saved invoice keeps them as a snapshot, so correcting a client's address later leaves invoices
        you have already issued exactly as they were sent.
      </p>
    </div>
  );
}

// ── ITEMS ─────────────────────────────────────────────────────────────────

const UNITS = ['Nos', 'Hours', 'Month', 'Year', 'Set', 'Pcs'];

function ItemsTab(p: {
  lines: Line[]; setLines: (f: (ls: Line[]) => Line[]) => void;
  discountText: string; setDiscountText: (v: string) => void;
  totals: ReturnType<typeof computeTotals>; isInterState: boolean;
}) {
  const set = (i: number, patch: Partial<Line>) =>
    p.setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const move = (i: number, by: number) =>
    p.setLines((ls) => {
      const j = i + by;
      if (j < 0 || j >= ls.length) return ls;
      const n = [...ls];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  return (
    <div>
      {p.lines.map((l, i) => {
        const t = p.totals.lines[i];
        return (
          <div key={l.key} className="border border-neutral-200 rounded p-3 mb-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">Item {i + 1}</span>
              <span className="flex gap-1">
                <IconBtn label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>↑</IconBtn>
                <IconBtn label="Move down" onClick={() => move(i, 1)} disabled={i === p.lines.length - 1}>↓</IconBtn>
                <IconBtn label="Duplicate" onClick={() => p.setLines((ls) => [...ls.slice(0, i + 1), { ...l, key: lineKey() }, ...ls.slice(i + 1)])}>⧉</IconBtn>
                <IconBtn label="Delete" onClick={() => p.setLines((ls) => (ls.length === 1 ? [newLine()] : ls.filter((_, j) => j !== i)))}>✕</IconBtn>
              </span>
            </div>

            <Field label="Item / service">
              <input className={inputClass} value={l.itemName} onChange={(e) => set(i, { itemName: e.target.value })} />
            </Field>
            <Field label="Description">
              <input className={inputClass} value={l.description} onChange={(e) => set(i, { description: e.target.value })} />
            </Field>
            <Two>
              <Field label="HSN / SAC" hint="4–8 digits, per item.">
                <input className={inputClass} value={l.hsnSac} onChange={(e) => set(i, { hsnSac: e.target.value.replace(/\D/g, '') })} />
              </Field>
              <Field label="Unit">
                <select className={inputClass} value={l.unit} onChange={(e) => set(i, { unit: e.target.value })}>
                  {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </Field>
            </Two>
            <Two>
              <Field label="Quantity">
                <input
                  className={inputClass} type="number" step="0.01" min="0.01"
                  value={l.quantityCenti / 100}
                  onChange={(e) => set(i, { quantityCenti: Math.max(1, Math.round((Number(e.target.value) || 0) * 100)) })}
                />
              </Field>
              <Field label="Rate (₹)">
                <input
                  className={inputClass} type="number" step="0.01" min="0"
                  value={l.ratePaise / 100}
                  onChange={(e) => set(i, { ratePaise: Math.max(0, Math.round((Number(e.target.value) || 0) * 100)) })}
                />
              </Field>
            </Two>
            <Two>
              <Field label="GST slab" hint={p.isInterState ? 'Charged as IGST.' : 'Split into CGST + SGST.'}>
                <select
                  className={inputClass} value={l.gstRatePercent}
                  onChange={(e) => set(i, { gstRatePercent: Number(e.target.value) })}
                >
                  {GST_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
                </select>
              </Field>
              <Field label="Line discount (%)">
                <input
                  className={inputClass} type="number" min="0" max="100"
                  value={l.discountPercent}
                  onChange={(e) => set(i, { discountPercent: Math.min(100, Math.max(0, Math.trunc(Number(e.target.value) || 0))) })}
                />
              </Field>
            </Two>

            {/* The derived figures, shown where they are produced — the Amount
                column is the TAXABLE base, with tax on top, as the document
                prints it. */}
            {t ? (
              <div className="text-12 text-neutral-600 mt-1">
                Amount {inrAmount(t.taxableAmountPaise)}
                {p.isInterState
                  ? <> · IGST {t.igstRatePercent}% {inrAmount(t.igstAmountPaise)}</>
                  : <> · CGST {t.cgstRatePercent}% {inrAmount(t.cgstAmountPaise)} · SGST {t.sgstRatePercent}% {inrAmount(t.sgstAmountPaise)}</>}
                {' '}· line total {inrAmount(t.totalAmountPaise)}
              </div>
            ) : null}
          </div>
        );
      })}

      <Button onClick={() => p.setLines((ls) => [...ls, newLine()])}>+ Add item</Button>

      <div className="mt-4">
        <Field label="Invoice discount (₹)" hint="Spread across the items pro rata, because tax is per item.">
          <input className={inputClass} type="number" step="0.01" min="0" value={p.discountText} onChange={(e) => p.setDiscountText(e.target.value)} />
        </Field>
      </div>

      <div className="border-t border-neutral-200 mt-3 pt-3 text-13">
        <Row k="Sub total" v={inrAmount(p.totals.subtotalPaise)} />
        {p.totals.discountPaise > 0 ? <Row k="Discount" v={`- ${inrAmount(p.totals.discountPaise)}`} /> : null}
        {p.isInterState
          ? <Row k="IGST" v={inrAmount(p.totals.igstPaise)} />
          : <>
              <Row k="CGST" v={inrAmount(p.totals.cgstPaise)} />
              <Row k="SGST" v={inrAmount(p.totals.sgstPaise)} />
            </>}
        {p.totals.roundOffPaise !== 0 ? <Row k="Round off" v={inrAmount(p.totals.roundOffPaise)} /> : null}
        <Row k="Total" v={inrAmount(p.totals.totalPaise)} strong />
        <Row k="Balance due" v={inrAmount(p.totals.balanceDuePaise)} strong />
      </div>
    </div>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between py-0.5 ${strong ? 'font-semibold' : ''}`}>
      <span>{k}</span><span>{v}</span>
    </div>
  );
}

function IconBtn({ children, label, onClick, disabled }: {
  children: React.ReactNode; label: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button
      type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}
      className="h-6 w-6 text-12 border border-neutral-300 rounded disabled:opacity-40 bg-white"
    >
      {children}
    </button>
  );
}

/**
 * Upload the firm's own QR — the PNG a bank or payment app hands over.
 *
 * Read in the browser and carried as a data URL, so there is no upload
 * endpoint, no file to lose and no second place for the image to live. It is
 * saved onto the invoice with everything else, which is what makes it part of
 * the snapshot: replacing the firm's QR next year cannot change where an
 * invoice already sent points a payer.
 *
 * The image is printed AS SUPPLIED, never re-encoded — whatever the bank
 * generated is exactly what a payer scans.
 */
function QrUpload({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const MAX = 400_000;

  function pick(file: File | undefined) {
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(file.type)) {
      toast.push('error', 'Use a PNG, JPEG or WebP image.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      // The data URL is ~33% larger than the file, and the API caps the
      // stored string — so check the encoded length, not the file size.
      if (url.length > MAX) {
        toast.push('error', 'That image is too large. Around 280 KB on disk is the limit.');
        return;
      }
      onChange(url);
    };
    reader.onerror = () => toast.push('error', 'That file could not be read.');
    reader.readAsDataURL(file);
  }

  return (
    <div className="mb-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }}
      />
      {value ? (
        <div className="flex items-start gap-3 border border-neutral-200 rounded p-3 bg-white">
          <img src={value} alt="Payment QR" className="w-24 h-24 object-contain border border-neutral-200 rounded" />
          <div>
            <div className="text-13 text-neutral-900 mb-1">Your QR code</div>
            <div className="text-12 text-neutral-500 mb-2">Printed on the invoice exactly as uploaded.</div>
            <div className="flex gap-2">
              <Button onClick={() => inputRef.current?.click()}>Replace</Button>
              <Button onClick={() => onChange(null)}>Remove</Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="border border-dashed border-neutral-300 rounded p-4 text-center bg-white">
          <div className="text-13 text-neutral-700 mb-1">No QR image yet</div>
          <div className="text-12 text-neutral-500 mb-3">PNG, JPEG or WebP. Nothing prints until you add one.</div>
          <Button onClick={() => inputRef.current?.click()}>Choose file</Button>
        </div>
      )}
    </div>
  );
}

// ── LAYOUT ────────────────────────────────────────────────────────────────

function LayoutTab(p: {
  layout: LayoutConfig; setLayout: (f: (l: LayoutConfig) => LayoutConfig) => void;
  company: CompanyInfo; setCompany: (f: (c: CompanyInfo) => CompanyInfo) => void;
}) {
  const sel = <K extends keyof LayoutConfig>(k: K, label: string, opts: LayoutConfig[K][]) => (
    <Field label={label}>
      <select
        className={inputClass} value={String(p.layout[k])}
        onChange={(e) => p.setLayout((l) => ({ ...l, [k]: e.target.value as LayoutConfig[K] }))}
      >
        {opts.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
      </select>
    </Field>
  );

  return (
    <div>
      <Two>
        {sel('pageSize', 'Page size', ['A4', 'Letter'])}
        {sel('orientation', 'Orientation', ['portrait', 'landscape'])}
      </Two>
      <Two>
        {sel('margin', 'Margins', ['narrow', 'normal', 'wide'])}
        {sel('font', 'Font', ['sans', 'serif'])}
      </Two>
      <Two>
        <Field label="Font size">
          <input
            className={inputClass} type="number" min={8} max={14} value={p.layout.fontSize}
            onChange={(e) => p.setLayout((l) => ({ ...l, fontSize: Math.min(14, Math.max(8, Number(e.target.value) || 10)) }))}
          />
        </Field>
        {sel('headingSize', 'Heading size', ['compact', 'normal', 'large'])}
      </Two>
      <Two>
        {sel('lineHeight', 'Line spacing', ['tight', 'normal', 'relaxed'])}
        {sel('tableStyle', 'Table style', ['lined', 'striped', 'plain'])}
      </Two>
      <Two>
        {sel('headerStyle', 'Header style', ['bar', 'rule', 'plain'])}
        {sel('logoPosition', 'Logo position', ['left', 'center', 'right'])}
      </Two>

      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mt-4 mb-2">Company</div>
      <p className="text-12 text-neutral-500 mb-2">
        Snapshotted onto the invoice when you save, so a later change of letterhead does not redraw an
        invoice that has already gone out.
      </p>
      {([
        ['name', 'Name'], ['addressLine1', 'Address line 1'], ['addressLine2', 'Address line 2'],
        ['city', 'City'], ['state', 'State'], ['pin', 'PIN'], ['phone', 'Phone'],
        ['email', 'Email'], ['website', 'Website'], ['gstin', 'GSTIN'], ['logo', 'Logo URL'],
      ] as [keyof CompanyInfo, string][]).map(([k, label]) => (
        <Field key={k} label={label}>
          <input className={inputClass} value={p.company[k]} onChange={(e) => p.setCompany((c) => ({ ...c, [k]: e.target.value }))} />
        </Field>
      ))}

    </div>
  );
}

// ── PAYMENT ───────────────────────────────────────────────────────────────

/**
 * Bank details, signature and the closing text.
 *
 * These used to sit at the bottom of the Layout tab, which was wrong twice
 * over: they are document CONTENT, not page format, and nobody looking for
 * "bank details" thinks to open a tab called Layout. §5 explicitly allows a
 * Payment tab, so they live here.
 *
 * The account list comes from the FirmBankAccount table, so which account is
 * printed is a choice rather than a hardcoded block (§26), and the chosen one
 * is SNAPSHOTTED onto the invoice on save — closing the account later cannot
 * blank an invoice that has already gone out.
 */
function PaymentTab(p: {
  banks: BankSnapshot[];
  onBankAdded: (b: BankSnapshot) => void;
  bankAccountId: string; setBankAccountId: (v: string) => void;
  notes: string; setNotes: (v: string) => void;
  signatoryName: string; setSignatoryName: (v: string) => void;
  signatoryDesignation: string; setSignatoryDesignation: (v: string) => void;
  footerNote: string; setFooterNote: (v: string) => void;
  qrMode: QrMode; setQrMode: (v: QrMode) => void;
  qrValue: string; setQrValue: (v: string) => void;
  qrImage: string | null; setQrImage: (v: string | null) => void;
}) {
  const chosen = p.banks.find((b) => b.id === p.bankAccountId);
  const [addOpen, setAddOpen] = useState(false);
  return (
    <div>
      <Field label="Bank account" hint="Printed in the Bank Details block, and snapshotted on save.">
        <select className={inputClass} value={p.bankAccountId} onChange={(e) => p.setBankAccountId(e.target.value)}>
          <option value="">None — hide the bank block</option>
          {p.banks.map((b) => <option key={b.id} value={b.id}>{b.label} · {b.bank_name}</option>)}
        </select>
      </Field>

      {chosen ? (
        <div className="border border-neutral-200 rounded bg-white px-3 py-2 text-12 text-neutral-600 mb-3">
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">On the document</div>
          <div>A/c {chosen.account_number} · {chosen.bank_name} · IFSC {chosen.ifsc_code}</div>
          {chosen.upi_id ? <div>UPI {chosen.upi_id}</div> : null}
        </div>
      ) : (
        <p className="text-12 text-neutral-500 mb-3">
          With no account chosen the Bank Details block is left off the document entirely, rather than
          printing an empty box.
        </p>
      )}

      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mt-4 mb-2">Payment QR</div>
      <Field label="QR code" hint="Printed beside the bank details on the PDF.">
        <select className={inputClass} value={p.qrMode} onChange={(e) => p.setQrMode(e.target.value as QrMode)}>
          {(Object.keys(QR_MODE_LABEL) as QrMode[]).map((m) => (
            <option key={m} value={m}>{QR_MODE_LABEL[m]}</option>
          ))}
        </select>
      </Field>
      {p.qrMode === 'custom' ? (
        <Field label="QR content" hint="A payment page, a portal link, or any text to encode.">
          <input className={inputClass} value={p.qrValue} onChange={(e) => p.setQrValue(e.target.value)} />
        </Field>
      ) : null}
      {p.qrMode === 'image' ? <QrUpload value={p.qrImage} onChange={p.setQrImage} /> : null}
      {p.qrMode === 'upi_amount' ? (
        <p className="text-12 text-neutral-500 mb-2">
          The balance due is baked into the code. Convenient, but it stops matching once a part payment
          is recorded — choose "UPI — no amount" if the payer should type the figure.
        </p>
      ) : null}
      {(p.qrMode === 'upi_amount' || p.qrMode === 'upi_only') && chosen && !chosen.upi_id ? (
        <p className="text-12 text-neutral-500 mb-2">
          This account has no UPI ID, so no QR will be printed. Add one to the account, or choose a
          custom code.
        </p>
      ) : null}

      <div className="flex items-center gap-2 mb-4 mt-3">
        <Button onClick={() => setAddOpen(true)}>+ Add bank account</Button>
        <span className="text-12 text-neutral-500">
          Added once, then available on every invoice.
        </span>
      </div>

      <AddBankModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(b) => { p.onBankAdded(b); setAddOpen(false); }}
      />

      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mt-4 mb-2">Signature</div>
      <Two>
        <Field label="Signatory name" hint="Leave blank for a bare signature line.">
          <input className={inputClass} value={p.signatoryName} onChange={(e) => p.setSignatoryName(e.target.value)} />
        </Field>
        <Field label="Signatory designation">
          <input className={inputClass} value={p.signatoryDesignation} onChange={(e) => p.setSignatoryDesignation(e.target.value)} />
        </Field>
      </Two>

      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mt-4 mb-2">Closing text</div>
      <Field label="Notes">
        <textarea className={textareaClass} rows={3} value={p.notes} onChange={(e) => p.setNotes(e.target.value)} />
      </Field>
      <Field label="Footer note">
        <input className={inputClass} value={p.footerNote} onChange={(e) => p.setFooterNote(e.target.value)} />
      </Field>
    </div>
  );
}

/**
 * Add a bank account, without leaving the invoice being built.
 *
 * The account is created immediately and server-side, not held as part of the
 * invoice draft: it belongs to the firm, not to this document, and the next
 * invoice should find it in the list. On success the new account is selected
 * here, because someone who just added one meant to use it.
 */
function AddBankModal({ open, onClose, onAdded }: {
  open: boolean; onClose: () => void; onAdded: (b: BankSnapshot) => void;
}) {
  const toast = useToast();
  const blank = {
    label: '', account_number: '', account_type: 'Current', account_holder: '',
    bank_name: '', branch_name: '', ifsc_code: '', upi_id: '', is_default: false,
  };
  const [f, setF] = useState(blank);
  const set = (k: keyof typeof f, v: string | boolean) => setF((p) => ({ ...p, [k]: v }));

  const create = useMutation({
    mutationFn: () => invoicesApi.createBankAccount({
      label: f.label,
      account_number: f.account_number,
      account_type: f.account_type,
      account_holder: f.account_holder,
      bank_name: f.bank_name,
      branch_name: f.branch_name || null,
      ifsc_code: f.ifsc_code,
      upi_id: f.upi_id || null,
      is_default: f.is_default,
    }),
    onSuccess: (b) => {
      toast.push('success', `${b.label} added.`);
      setF(blank);
      onAdded(b);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const e = fieldErrors(create.error);

  return (
    <Modal
      open={open} title="Add a bank account" onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Adding…' : 'Add account'}
          </Button>
        </>
      }
    >
      <Field label="Label" error={e.label} hint="How it appears in the picker, e.g. 'Primary current account'.">
        <input className={inputClass} value={f.label} onChange={(ev) => set('label', ev.target.value)} />
      </Field>
      <Two>
        <Field label="Account number" error={e.account_number}>
          <input className={inputClass} value={f.account_number} onChange={(ev) => set('account_number', ev.target.value)} />
        </Field>
        <Field label="Account type" error={e.account_type}>
          <select className={inputClass} value={f.account_type} onChange={(ev) => set('account_type', ev.target.value)}>
            {['Current', 'Savings', 'OD', 'CC'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
      </Two>
      <Field label="Account holder" error={e.account_holder}>
        <input className={inputClass} value={f.account_holder} onChange={(ev) => set('account_holder', ev.target.value)} />
      </Field>
      <Two>
        <Field label="Bank" error={e.bank_name}>
          <input className={inputClass} value={f.bank_name} onChange={(ev) => set('bank_name', ev.target.value)} />
        </Field>
        <Field label="Branch" error={e.branch_name}>
          <input className={inputClass} value={f.branch_name} onChange={(ev) => set('branch_name', ev.target.value)} />
        </Field>
      </Two>
      <Two>
        <Field label="IFSC code" error={e.ifsc_code} hint="11 characters, e.g. KKBK0008660.">
          <input
            className={inputClass} value={f.ifsc_code}
            onChange={(ev) => set('ifsc_code', ev.target.value.toUpperCase().replace(/\s/g, ''))}
          />
        </Field>
        <Field label="UPI ID" error={e.upi_id} hint="Drives the QR on the PDF.">
          <input className={inputClass} value={f.upi_id} onChange={(ev) => set('upi_id', ev.target.value)} />
        </Field>
      </Two>
      <label className="flex items-center gap-2 text-13 mt-1">
        <input type="checkbox" checked={f.is_default} onChange={(ev) => set('is_default', ev.target.checked)} />
        Use as the default account on new invoices
      </label>
      <p className="text-12 text-neutral-500 mt-3">
        Invoices already issued keep the account they were written with — each one stores its own copy
        of the bank details, so adding or changing an account never rewrites a document already sent.
      </p>
    </Modal>
  );
}

// ── BLOCKS ────────────────────────────────────────────────────────────────

/**
 * Which blocks appear and in what order. Reordering is by arrows rather than
 * drag-and-drop: the same affordance the rest of the builder uses, and it
 * works with a keyboard, which a bare drag handle does not.
 */
function BlocksTab({ blocks, setBlocks }: { blocks: BlockSpec[]; setBlocks: (f: (b: BlockSpec[]) => BlockSpec[]) => void }) {
  const move = (i: number, by: number) =>
    setBlocks((bs) => {
      const j = i + by;
      if (j < 0 || j >= bs.length) return bs;
      const n = [...bs];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  return (
    <div>
      <p className="text-12 text-neutral-500 mb-3">
        Turning a block off removes it from the document and from the PDF. The order here is the order
        on paper, and pagination is recomputed as you change it.
      </p>
      {blocks.map((b, i) => (
        <div key={b.id} className="flex items-center gap-2 border border-neutral-200 rounded px-3 py-2 mb-2">
          <input
            type="checkbox" checked={b.enabled}
            onChange={(e) => setBlocks((bs) => bs.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))}
          />
          <span className="flex-1 text-13">{BLOCK_LABEL[b.key]}</span>
          <IconBtn label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>↑</IconBtn>
          <IconBtn label="Move down" onClick={() => move(i, 1)} disabled={i === blocks.length - 1}>↓</IconBtn>
        </div>
      ))}
      <Button
        onClick={() => setBlocks(() => defaultBlocks().map((b) => ({ ...b, id: blockId() })))}
      >
        Reset to the default order
      </Button>
    </div>
  );
}
