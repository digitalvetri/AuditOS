import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Copy, Minus, MoveVertical, Plus, Trash2 } from 'lucide-react';
import type { Quotation } from '@/modules/workstation/quotations/api';
import { inr, qty } from '@/modules/workstation/quotations/api';
import {
  DEFAULT_COMPANY, DEFAULT_LAYOUT, HEADING_SCALE, LINE_HEIGHT, defaultBlocks, pageGeometry,
  SPACE_MAX_PX, SPACE_MIN_PX, SPACE_STEP_PX, clampSpace, spaceHeightPx,
  type BlockSpec, type ClientSnapshot, type CompanyInfo, type LayoutConfig, type TemplateId,
  type WorkSection,
} from '@/modules/workstation/quotations/document';
import { caretOffset, setCaret } from '@/modules/workstation/engagement/richtext';
import { DateField, PlainField, forceSync, requestFocus } from '@/pages/workstation/engagement/Editable';

/**
 * THE QUOTATION RENDERER.
 *
 * One component draws the live preview, the on-screen document and the printed
 * page. That is the whole point: if the preview and the PDF were two layouts,
 * they would drift, and "preview looks right but the PDF is wrong" is the bug
 * this design exists to make impossible.
 *
 * It takes a plain `DocumentModel`, never an API row, so the builder can feed
 * it un-saved state on every keystroke and a saved quotation can be mapped in
 * with `documentFromApi`.
 *
 * Pagination is REAL: blocks are measured and packed into pages of the exact
 * paper size, so a long Nature of Work section flows onto page 2 instead of
 * being cut off — and the printed page breaks where the preview says it does.
 */

export interface DocItem {
  key: string;
  description: string;
  detail?: string;
  frequency?: string;
  /** The professional fee, or the line amount for the GST template. */
  amountPaise: number;
  /** GST-template only. */
  quantityCenti?: number;
  unitRatePaise?: number;
  gstRatePercent?: number;
  discountPercent?: number;
  /** The builder's values AS TYPED — present only when the page is editable. */
  raw?: { description: string; detail: string; frequency: string; feeText: string; qtyText: string };
}

export interface DocumentModel {
  templateId: TemplateId;
  quotationCode: string;
  quoteDate: string;
  validUntil: string;
  subject: string;
  placeOfSupply?: string | null;

  company: CompanyInfo;
  client: ClientSnapshot;
  clientAddress?: string | null;
  clientGstin?: string | null;
  clientEmail?: string | null;
  clientPhone?: string | null;

  introduction: string;
  closingText: string;
  preparedByName: string;
  preparedByDesignation: string;
  notes: string;
  terms: string;
  paymentDetails: string;

  layout: LayoutConfig;
  blocks: BlockSpec[];
  items: DocItem[];
  workSections: WorkSection[];

  totals: {
    subtotalPaise: number;
    discountPaise: number;
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    totalPaise: number;
    isInterState: boolean;
  };
}

/** A saved quotation, as the renderer wants it. */
export function documentFromApi(q: Quotation): DocumentModel {
  const layout = { ...DEFAULT_LAYOUT, ...((q.layout_config ?? {}) as Partial<LayoutConfig>) };
  const templateId = (q.template_id as TemplateId) ?? 'gst-line-item';
  const snap = (q.client_snapshot ?? {}) as Partial<ClientSnapshot>;
  const company = { ...DEFAULT_COMPANY, ...((q.layout_config as { company?: Partial<CompanyInfo> })?.company ?? {}) };
  return {
    templateId,
    quotationCode: q.quotation_code,
    quoteDate: q.quote_date,
    validUntil: q.valid_until,
    subject: q.subject,
    placeOfSupply: q.place_of_supply,
    company,
    client: {
      name: snap.name || q.party_name || '',
      client_type: snap.client_type ?? '',
      industry: snap.industry ?? '',
      location: snap.location ?? '',
      transactions: snap.transactions ?? '',
    },
    clientAddress: q.party_address,
    clientGstin: q.party_gstin,
    clientEmail: q.party_email,
    clientPhone: q.party_contact_number,
    introduction: q.introduction ?? '',
    closingText: q.closing_text ?? '',
    preparedByName: q.prepared_by_name ?? q.prepared_by?.full_name ?? '',
    preparedByDesignation: q.prepared_by_designation ?? '',
    notes: q.notes ?? '',
    terms: q.terms ?? '',
    paymentDetails: '',
    layout,
    blocks: (q.block_config as BlockSpec[] | null) ?? defaultBlocks(templateId),
    items: q.items.map((i) => ({
      key: i.id,
      description: i.description,
      detail: i.detail ?? undefined,
      frequency: i.frequency ?? undefined,
      amountPaise: i.amount_paise,
      quantityCenti: i.quantity_centi,
      unitRatePaise: i.unit_rate_paise,
      gstRatePercent: i.gst_rate_percent,
      discountPercent: i.discount_percent,
    })),
    workSections: (q.work_sections ?? []).map((w) => ({
      key: w.id,
      title: w.title,
      description: w.description ?? '',
      items: w.items.map((it) => it.content),
    })),
    totals: {
      subtotalPaise: q.subtotal_paise,
      discountPaise: q.discount_paise,
      taxablePaise: q.taxable_paise,
      cgstPaise: q.cgst_paise,
      sgstPaise: q.sgst_paise,
      igstPaise: q.igst_paise,
      totalPaise: q.total_paise,
      isInterState: q.is_inter_state,
    },
  };
}

// ── The document ──────────────────────────────────────────────────────────

/**
 * Everything the page can change, when it is editable. Implemented by the
 * builder over the SAME state its left-hand form writes, so the page and the
 * form are two views of one quotation.
 */
export type QuoteField =
  | 'subject' | 'quoteDate' | 'validUntil' | 'placeOfSupply' | 'introduction' | 'closingText'
  | 'preparedByName' | 'preparedByDesignation' | 'notes' | 'terms' | 'paymentDetails';
export type ItemPatch = Partial<{ description: string; detail: string; frequency: string; feeText: string; qtyText: string }>;

export interface QuoteEditApi {
  field: (k: QuoteField, v: string) => void;
  company: (k: keyof CompanyInfo, v: string) => void;
  client: (k: keyof ClientSnapshot, v: string) => void;
  block: (id: string, patch: Partial<BlockSpec>) => void;
  moveBlock: (id: string, by: -1 | 1) => void;
  removeBlock: (id: string) => void;
  addSpaceAfter: (id: string) => void;
  item: (key: string, patch: ItemPatch) => void;
  itemOp: (key: string, op: 'up' | 'down' | 'dup' | 'del') => void;
  addItem: () => string;
  section: (key: string, patch: { title?: string; description?: string }) => void;
  sectionItems: (key: string, fn: (items: string[]) => string[]) => void;
  sectionOp: (key: string, op: 'up' | 'down' | 'del') => void;
  addSection: () => string;
}

const SURFACE = 'q';
const REMOVABLE_BLOCK = new Set(['custom', 'spacer']);

/** Props every block renderer takes: the doc, and — when editing — the API. */
interface BP { doc: DocumentModel; e?: QuoteEditApi; live: boolean }

export function QuotationDocument({ doc, scale, edit }: {
  doc: DocumentModel;
  scale?: number;
  /** Present → every text on the page is directly editable. */
  edit?: QuoteEditApi;
}) {
  const geo = pageGeometry(doc.layout);
  const editing = Boolean(edit);
  const blocks = doc.blocks.filter((b) => b.enabled);
  // Each node is rendered twice: a static twin to measure, a live one to edit.
  const nodes = blocks
    .map((b) => ({ id: b.id, b, node: (live: boolean) => renderBlock(b, { doc, e: edit, live }) }))
    .filter((n) => n.node(false) !== null);
  const pages = usePagination(nodes.map((n) => n.id), geo.contentHeightPx, doc, editing);
  const blockIndex = new Map(doc.blocks.map((b, i) => [b.id, i]));

  const fontFamily = doc.layout.font === 'serif'
    ? 'Georgia, "Times New Roman", serif'
    : 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';

  const style = {
    '--qd-font-size': `${doc.layout.fontSize}pt`,
    '--qd-line-height': String(LINE_HEIGHT[doc.layout.lineHeight]),
    '--qd-heading-scale': String(HEADING_SCALE[doc.layout.headingSize]),
    fontFamily,
  } as React.CSSProperties;

  const scaled = Boolean(scale) && scale !== 1;
  const { stackRef, naturalHeight } = useNaturalHeight();

  const stack = (
    <div
      ref={stackRef}
      className={`qdoc-stack ${editing ? 'el-editing' : ''}`}
      data-edit-surface={editing ? SURFACE : undefined}
      style={{
        ...style,
        // The pages are laid out at true paper size; the preview pane scales
        // the whole stack down rather than reflowing it, so what is measured
        // is what prints.
        transform: scaled ? `scale(${scale})` : undefined,
        transformOrigin: 'top center',
      }}
    >
      {/* Measuring pass: same width and typography as a real page, off-screen
          and never printed. Heights from here decide the page breaks. */}
      <div
        ref={pages.measureRef}
        aria-hidden
        className="qdoc-measure"
        style={{ width: `${geo.widthPx - geo.marginPx * 2}px` }}
      >
        {nodes.map((n) => (
          <div key={n.id} data-block={n.id}>{n.node(false)}</div>
        ))}
      </div>

      <div ref={pages.pagesRef} className="contents">
        {pages.pages.map((ids, pageIndex) => (
          <section
            key={pageIndex}
            className="qdoc-page"
            style={{
              width: `${geo.widthMm}mm`,
              minHeight: `${geo.heightMm}mm`,
              padding: `${geo.marginMm}mm`,
            }}
          >
            <div className="qdoc-body">
              {ids.map((id) => {
                const found = nodes.find((n) => n.id === id);
                if (!found) return null;
                return (
                  <div key={id} className={editing ? 'el-unit relative' : undefined}>
                    {edit && found.b.key !== 'spacer' ? (
                      <BlockGutter b={found.b} e={edit}
                        isFirst={blockIndex.get(found.b.id) === 0}
                        isLast={blockIndex.get(found.b.id) === doc.blocks.length - 1} />
                    ) : null}
                    {found.node(true)}
                  </div>
                );
              })}
            </div>

            {doc.layout.footerStyle !== 'none' ? (
              <footer className="qdoc-footer">
                {doc.layout.footerStyle === 'company' ? (
                  <span>{doc.company.name}</span>
                ) : (
                  <span>Page {pageIndex + 1} of {pages.pages.length}</span>
                )}
              </footer>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );

  // A CSS transform shrinks the pixels but NOT the layout box, so a scaled
  // stack would keep reserving its full unscaled height and leave that
  // difference as dead white space under the document. The wrapper takes the
  // real measured height of the paper, multiplied by the scale actually
  // applied — a figure read off the content, not a guess — so the scroll area
  // ends on the last page. Unscaled (print, full width) it is left alone.
  if (!scaled) return stack;

  return (
    <div
      className="qdoc-scaler"
      style={{ height: naturalHeight === null ? undefined : naturalHeight * (scale ?? 1) }}
    >
      {stack}
    </div>
  );
}

/**
 * The stack's own height, before any transform, kept current as content
 * changes. A callback ref, because wrapping the stack once a scale arrives
 * re-parents it and React mounts a new node; offsetHeight, because it is the
 * pre-transform height and cannot feed back into the scale.
 */
function useNaturalHeight() {
  const [el, stackRef] = useState<HTMLDivElement | null>(null);
  const [naturalHeight, setNaturalHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!el) return;
    const read = () => setNaturalHeight((h) => (h === el.offsetHeight ? h : el.offsetHeight));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);

  return { stackRef, naturalHeight };
}

/**
 * Measure each block once it is on screen and pack the blocks into pages.
 *
 * Greedy and block-level: a block that does not fit starts the next page. A
 * block taller than a whole page keeps its own page and the browser breaks
 * inside it, which is the honest behaviour for a very long work section.
 *
 * While editing, a block whose text grows can cross onto the next page and
 * be remounted there — so the focused field and caret are captured and put
 * back, but only if the move actually dropped focus.
 */
function usePagination(ids: string[], contentHeightPx: number, doc: DocumentModel, editing: boolean) {
  const measureRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<string[][]>([ids]);
  const restore = useRef<{ editId: string; offset: number } | null>(null);
  // Everything that can change a height is in here — every text, and the
  // spacer sizes, whose whole purpose is to push content onto the next page.
  const signature = JSON.stringify({ ids, contentHeightPx, doc, editing });

  useLayoutEffect(() => {
    const root = measureRef.current;
    if (!root) return;
    const heights = new Map<string, number>();
    root.querySelectorAll<HTMLElement>('[data-block]').forEach((el) => {
      heights.set(el.dataset.block!, el.getBoundingClientRect().height);
    });

    const next: string[][] = [];
    let current: string[] = [];
    let used = 0;
    for (const id of ids) {
      const h = heights.get(id) ?? 0;
      if (current.length > 0 && used + h > contentHeightPx) {
        next.push(current);
        current = [];
        used = 0;
      }
      current.push(id);
      used += h;
    }
    if (current.length > 0 || next.length === 0) next.push(current);

    setPages((prev) => {
      if (JSON.stringify(prev) === JSON.stringify(next)) return prev;
      const a = document.activeElement as HTMLElement | null;
      if (a?.dataset.editId && pagesRef.current?.contains(a)) {
        restore.current = { editId: a.dataset.editId, offset: caretOffset(a) ?? 0 };
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useLayoutEffect(() => {
    const r = restore.current;
    if (!r) return;
    restore.current = null;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (!lost) return;
    const el = pagesRef.current?.querySelector<HTMLElement>(`[data-edit-id="${CSS.escape(r.editId)}"]`);
    if (el) { el.focus(); setCaret(el, r.offset); }
  }, [pages]);

  return { pages, measureRef, pagesRef };
}

// ── Editing controls (screen-only, never printed) ─────────────────────────

const gbtn = 'h-6 w-6 inline-flex items-center justify-center rounded border border-neutral-300 bg-white text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50 disabled:opacity-30';

function BlockGutter({ b, e, isFirst, isLast }: { b: BlockSpec; e: QuoteEditApi; isFirst: boolean; isLast: boolean }) {
  return (
    <div className="el-gutter qdoc-screen-only" onMouseDown={(ev) => ev.preventDefault()}>
      <button type="button" className={gbtn} disabled={isFirst} title="Move up" onClick={() => e.moveBlock(b.id, -1)}><ArrowUp size={12} /></button>
      <button type="button" className={gbtn} disabled={isLast} title="Move down" onClick={() => e.moveBlock(b.id, 1)}><ArrowDown size={12} /></button>
      <button type="button" className={gbtn} title="Add space below" onClick={() => e.addSpaceAfter(b.id)}><MoveVertical size={12} /></button>
      {REMOVABLE_BLOCK.has(b.key) ? (
        <button type="button" className={gbtn} title="Delete" onClick={() => e.removeBlock(b.id)}><Trash2 size={12} /></button>
      ) : null}
    </div>
  );
}

/** A plain editable, pre-wired to this surface. */
function F({ live, id, value, onChange, placeholder, multiline, as, style, className, fallback, onKey, onBlurValue }: {
  live: boolean; id: string; value: string; onChange?: (v: string) => void; placeholder?: string;
  multiline?: boolean; as?: 'span' | 'div'; style?: React.CSSProperties; className?: string; fallback?: string;
  onKey?: (ev: KeyboardEvent<HTMLElement>, el: HTMLElement) => boolean; onBlurValue?: (v: string) => void;
}) {
  return (
    <PlainField live={live} editId={`${SURFACE}:${id}`} value={value} onChange={onChange} placeholder={placeholder}
      multiline={multiline} as={as} style={style} className={className} fallback={fallback} onKey={onKey}
      onBlurValue={onBlurValue} />
  );
}

// ── Blocks ────────────────────────────────────────────────────────────────

function renderBlock(b: BlockSpec, p: BP): ReactNode {
  const { doc, e, live } = p;
  const editing = Boolean(e);
  const L = live && editing;
  switch (b.key) {
    case 'company_header': return <CompanyHeader {...p} />;
    case 'quotation_title': return <Title doc={doc} />;
    case 'quotation_meta': return <Meta {...p} />;
    case 'client_information': return <ClientBlock {...p} />;
    case 'subject': return <Subject {...p} />;
    case 'introduction':
      if (!editing && !doc.introduction.trim()) return null;
      return (
        <div className="qdoc-block">
          <F live={L} id="introduction" as="div" multiline className="qdoc-p" value={doc.introduction}
            placeholder="Introduction…" onChange={(v) => e?.field('introduction', v)} />
        </div>
      );
    case 'fee_table': return <FeeTable {...p} />;
    case 'nature_of_work': return <NatureOfWork {...p} />;
    case 'terms': return <Titled {...p} title="Terms & Conditions" field="terms" text={doc.terms} />;
    case 'payment_details': return <Titled {...p} title="Payment Details" field="paymentDetails" text={doc.paymentDetails} />;
    case 'notes': return <Titled {...p} title="Notes" field="notes" text={doc.notes} />;
    case 'closing': return <Closing {...p} />;
    // Blank paper, on purpose. It is a block like any other, so it moves,
    // deletes and paginates with the rest of the document.
    case 'spacer': {
      const h = spaceHeightPx(b);
      const spacer = (
        <div
          className="qdoc-spacer"
          aria-hidden="true"
          // Inline height, not a class: the printed PDF is produced from this
          // same tree, and an inline style is the one thing no print
          // stylesheet can drop.
          style={{ height: `${h}px`, flex: 'none' }}
        />
      );
      if (!L || !e) return spacer;
      const set = (px: number) => e.block(b.id, { heightPx: clampSpace(px), heightMm: undefined });
      return (
        <div className="el-space relative" style={{ height: `${h}px` }}>
          <div className="el-space-bar qdoc-screen-only" onMouseDown={(ev) => ev.preventDefault()}>
            <span>Space · {Math.round(h)}px</span>
            <button type="button" className={gbtn} title="Move up" onClick={() => e.moveBlock(b.id, -1)}><ArrowUp size={12} /></button>
            <button type="button" className={gbtn} title="Move down" onClick={() => e.moveBlock(b.id, 1)}><ArrowDown size={12} /></button>
            <button type="button" className={gbtn} title="Decrease height" disabled={h <= SPACE_MIN_PX} onClick={() => set(h - SPACE_STEP_PX)}><Minus size={12} /></button>
            <button type="button" className={gbtn} title="Increase height" disabled={h >= SPACE_MAX_PX} onClick={() => set(h + SPACE_STEP_PX)}><Plus size={12} /></button>
            <button type="button" className={gbtn} title="Delete space" onClick={() => e.removeBlock(b.id)}><Trash2 size={12} /></button>
          </div>
        </div>
      );
    }
    case 'custom':
      if (!editing && !b.title && !b.body) return null;
      return (
        <div className="qdoc-block">
          {(editing || b.title) ? (
            <F live={L} id={`custom-title:${b.id}`} as="div" className="qdoc-heading" value={b.title ?? ''}
              placeholder="Heading" onChange={(v) => e?.block(b.id, { title: v })} />
          ) : null}
          <F live={L} id={`custom-body:${b.id}`} as="div" multiline className="qdoc-p" value={b.body ?? ''}
            placeholder="Text…" onChange={(v) => e?.block(b.id, { body: v })} />
        </div>
      );
    default: return null;
  }
}

function CompanyHeader({ doc, e, live }: BP) {
  const c = doc.company;
  const editing = Boolean(e);
  const L = live && editing;
  const f = (k: keyof CompanyInfo, ph: string) => (
    <F live={L} id={`co:${k}`} value={c[k]} placeholder={ph} onChange={(v) => e?.company(k, v)} />
  );
  const align =
    doc.layout.logoPosition === 'center' ? 'items-center text-center'
      : doc.layout.logoPosition === 'right' ? 'items-end text-right'
        : 'items-start text-left';
  const show = (k: keyof CompanyInfo) => editing || Boolean(c[k]);
  return (
    <div className={`qdoc-block flex flex-col ${align} ${doc.layout.headerStyle === 'bar' ? 'qdoc-header-bar' : ''}`}>
      {c.logo ? <img src={c.logo} alt="" className="qdoc-logo" /> : null}
      <div className="qdoc-company-name">{f('name', 'Firm name')}</div>
      {(show('addressLine1') || show('addressLine2')) ? (
        <div className="qdoc-muted">
          {show('addressLine1') ? f('addressLine1', 'Address') : null}
          {c.addressLine1 && c.addressLine2 || editing ? ', ' : null}
          {show('addressLine2') ? f('addressLine2', 'Area') : null}
        </div>
      ) : null}
      {(show('city') || show('pin')) ? (
        <div className="qdoc-muted">
          {show('city') ? f('city', 'City') : null}
          {c.city && c.pin || editing ? ' – ' : null}
          {show('pin') ? f('pin', 'PIN') : null}
        </div>
      ) : null}
      <div className="qdoc-muted">
        {show('email') ? <>Mail – {f('email', 'Email')}</> : null}
        {(c.email && c.phone) || editing ? ' · ' : null}
        {show('phone') ? <>Phone – {f('phone', 'Phone')}</> : null}
      </div>
      {show('gstin') ? <div className="qdoc-muted">GSTIN – {f('gstin', 'GSTIN')}</div> : null}
      {show('website') ? <div className="qdoc-muted">{f('website', 'Website')}</div> : null}
      {doc.layout.headerStyle !== 'plain' ? <div className="qdoc-rule" /> : null}
    </div>
  );
}

function Title({ doc }: { doc: DocumentModel }) {
  return (
    <div className="qdoc-block qdoc-title">
      QUOTATION
      {/* The code is allocated by the server and is unique — never typed. */}
      <span className="qdoc-code">{doc.quotationCode}</span>
    </div>
  );
}

function Meta({ doc, e, live }: BP) {
  const editing = Boolean(e);
  const L = live && editing;
  return (
    <div className="qdoc-block qdoc-meta">
      <div><span className="qdoc-label">Date:</span>{' '}
        <DateField live={L} value={doc.quoteDate} display={fmt(doc.quoteDate)} onChange={(v) => e?.field('quoteDate', v)} />
      </div>
      {(editing || doc.validUntil) ? (
        <div><span className="qdoc-label">Valid until:</span>{' '}
          <DateField live={L} value={doc.validUntil} display={fmt(doc.validUntil)} onChange={(v) => e?.field('validUntil', v)} />
        </div>
      ) : null}
      {(editing || doc.client.name) ? (
        <div><span className="qdoc-label">Company Name:</span>{' '}
          {/* Shown in capitals, stored as typed. */}
          <F live={L} id="meta:client-name" value={doc.client.name} placeholder="Company name"
            style={{ textTransform: 'uppercase' }} onChange={(v) => e?.client('name', v)} />
        </div>
      ) : null}
      {(editing || doc.placeOfSupply) ? (
        <div><span className="qdoc-label">Place of supply:</span>{' '}
          <F live={L} id="meta:pos" value={doc.placeOfSupply ?? ''} placeholder="State"
            onChange={(v) => e?.field('placeOfSupply', v)} />
        </div>
      ) : null}
    </div>
  );
}

function Subject({ doc, e, live }: BP) {
  const editing = Boolean(e);
  if (!editing && !doc.subject.trim()) return null;
  return (
    <div className="qdoc-block">
      <span className="qdoc-label">Subject:</span>
      <F live={live && editing} id="subject" as="div" className="qdoc-subject" value={doc.subject}
        placeholder="Subject" onChange={(v) => e?.field('subject', v)} />
    </div>
  );
}

/** §8 — only the fields that carry a value; no empty rows on the paper. */
function ClientBlock({ doc, e, live }: BP) {
  const editing = Boolean(e);
  const L = live && editing;
  const c = doc.client;
  // Snapshot rows are editable; GSTIN, email and phone come from the client
  // record itself and are changed there.
  const snap: [keyof ClientSnapshot, string][] = [
    ['name', 'Name'], ['client_type', 'Client Type'], ['industry', 'Industry'],
    ['location', 'Location'], ['transactions', 'Transactions'],
  ];
  const fixed: [string, string][] = [
    ['GSTIN', doc.clientGstin ?? ''], ['Email', doc.clientEmail ?? ''], ['Phone', doc.clientPhone ?? ''],
  ];
  const rows = [
    ...snap.filter(([k]) => editing || String(c[k] ?? '').trim())
      .map(([k, label]) => ({ label, node: (
        <F live={L} id={`client:${k}`} value={String(c[k] ?? '')} placeholder={label}
          onChange={(v) => e?.client(k, v)} />
      ) })),
    ...fixed.filter(([, v]) => v.trim()).map(([label, v]) => ({ label, node: <>{v}</> })),
  ];
  if (rows.length === 0) return null;
  return (
    <div className="qdoc-block">
      <table className="qdoc-kv">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="qdoc-label">{r.label}</td>
              <td>{r.node}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Row controls for a service line, in the page margin. */
function RowGutter({ k, e, isFirst, isLast }: { k: string; e: QuoteEditApi; isFirst: boolean; isLast: boolean }) {
  return (
    <div className="el-gutter qdoc-screen-only" style={{ flexDirection: 'row', left: 'auto', right: '100%', marginRight: 6 }}
      onMouseDown={(ev) => ev.preventDefault()}>
      <button type="button" className={gbtn} disabled={isFirst} title="Move up" onClick={() => e.itemOp(k, 'up')}><ArrowUp size={12} /></button>
      <button type="button" className={gbtn} disabled={isLast} title="Move down" onClick={() => e.itemOp(k, 'down')}><ArrowDown size={12} /></button>
      <button type="button" className={gbtn} title="Duplicate" onClick={() => e.itemOp(k, 'dup')}><Copy size={12} /></button>
      <button type="button" className={gbtn} title="Delete" onClick={() => e.itemOp(k, 'del')}><Trash2 size={12} /></button>
    </div>
  );
}

function AddRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="qdoc-screen-only" style={{ marginTop: 6 }}>
      <button type="button" className="el-addfee" onMouseDown={(ev) => ev.preventDefault()} onClick={onClick}>{label}</button>
    </div>
  );
}

function FeeTable({ doc, e, live }: BP) {
  const editing = Boolean(e);
  const L = live && editing;
  const compliance = doc.templateId === 'jns-compliance';
  const t = doc.totals;
  const styleClass = `qdoc-table qdoc-table-${doc.layout.tableStyle}`;
  const addService = e ? () => requestFocus(`${SURFACE}:item:${e.addItem()}:description`, 0) : undefined;

  if (doc.items.length === 0) {
    return (
      <div className="qdoc-block qdoc-muted qdoc-empty">
        No services added.
        {L && addService ? <AddRow label="+ Add service" onClick={addService} /> : null}
      </div>
    );
  }

  const desc = (i: DocItem) => (
    <F live={L} id={`item:${i.key}:description`} value={i.raw ? i.raw.description : i.description}
      placeholder="Particulars" onChange={(v) => e?.item(i.key, { description: v })} />
  );
  const detail = (i: DocItem) => ((editing && L) || i.detail ? (
    <F live={L} id={`item:${i.key}:detail`} as="div" className="qdoc-muted qdoc-detail"
      value={i.raw ? i.raw.detail : (i.detail ?? '')} placeholder="Description (optional)"
      onChange={(v) => e?.item(i.key, { detail: v })} />
  ) : null);
  const gutter = (i: DocItem, n: number) => (L && e ? (
    <RowGutter k={i.key} e={e} isFirst={n === 0} isLast={n === doc.items.length - 1} />
  ) : null);

  if (compliance) {
    return (
      <div className="qdoc-block">
        <table className={styleClass}>
          <thead>
            <tr>
              <th className="qdoc-w-sl">Sl. No</th>
              <th>Particulars</th>
              <th className="qdoc-w-freq">Frequency of Filing / Payment</th>
              <th className="qdoc-right qdoc-w-fee">Professional Fees (₹)</th>
            </tr>
          </thead>
          <tbody>
            {doc.items.map((i, n) => (
              <tr key={i.key} className={L ? 'el-feerow relative' : undefined}>
                <td style={L ? { position: 'relative' } : undefined}>{gutter(i, n)}{n + 1}</td>
                <td>{desc(i)}{detail(i)}</td>
                <td>
                  {L ? (
                    <F live={L} id={`item:${i.key}:frequency`} value={i.raw?.frequency ?? ''} placeholder="Frequency"
                      onChange={(v) => e?.item(i.key, { frequency: v })} />
                  ) : (i.frequency ?? '—')}
                </td>
                <td className="qdoc-right">
                  {L ? (
                    <>₹<F live={L} id={`item:${i.key}:fee`} value={i.raw?.feeText ?? ''} placeholder="0"
                      onChange={(v) => e?.item(i.key, { feeText: v })} /></>
                  ) : rupees(i.amountPaise)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {L && addService ? <AddRow label="+ Add service" onClick={addService} /> : null}
        <div className="qdoc-total-line">
          <span>Total professional fees</span>
          <span>{inr(t.totalPaise)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="qdoc-block">
      <table className={styleClass}>
        <thead>
          <tr>
            <th className="qdoc-w-sl">#</th>
            <th>Description</th>
            <th className="qdoc-right">Qty</th>
            <th className="qdoc-right">Rate</th>
            <th className="qdoc-right">GST</th>
            <th className="qdoc-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.items.map((i, n) => (
            <tr key={i.key}>
              <td style={L ? { position: 'relative' } : undefined}>{gutter(i, n)}{n + 1}</td>
              <td>
                {desc(i)}
                {i.discountPercent ? <span className="qdoc-muted"> · {i.discountPercent}% off</span> : null}
              </td>
              <td className="qdoc-right">
                {L ? <F live={L} id={`item:${i.key}:qty`} value={i.raw?.qtyText ?? ''} placeholder="1"
                  onChange={(v) => e?.item(i.key, { qtyText: v })} /> : qty(i.quantityCenti ?? 100)}
              </td>
              <td className="qdoc-right">
                {L ? <>₹<F live={L} id={`item:${i.key}:rate`} value={i.raw?.feeText ?? ''} placeholder="0"
                  onChange={(v) => e?.item(i.key, { feeText: v })} /></> : inr(i.unitRatePaise ?? 0)}
              </td>
              <td className="qdoc-right">{i.gstRatePercent ?? 0}%</td>
              <td className="qdoc-right">{inr(i.amountPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {L && addService ? <AddRow label="+ Add service" onClick={addService} /> : null}

      <div className="qdoc-totals">
        <Line label="Subtotal" value={inr(t.subtotalPaise)} />
        {t.discountPaise > 0 ? <Line label="Discount" value={`− ${inr(t.discountPaise)}`} /> : null}
        <Line label="Taxable value" value={inr(t.taxablePaise)} />
        {t.isInterState
          ? <Line label="IGST" value={inr(t.igstPaise)} />
          : <><Line label="CGST" value={inr(t.cgstPaise)} /><Line label="SGST" value={inr(t.sgstPaise)} /></>}
        <Line label="Total" value={inr(t.totalPaise)} strong />
      </div>
    </div>
  );
}

function NatureOfWork({ doc, e, live }: BP) {
  const editing = Boolean(e);
  const L = live && editing;
  const sections = editing
    ? doc.workSections
    : doc.workSections.filter((s) => s.title.trim() || s.items.some((i) => i.trim()));
  if (sections.length === 0) {
    return L && e ? (
      <div className="qdoc-block">
        <AddRow label="+ Add Nature of Work section" onClick={() => requestFocus(`${SURFACE}:sec:${e.addSection()}:title`, 0)} />
      </div>
    ) : null;
  }

  /**
   * A bullet behaves like a word-processor list item: Enter splits it into a
   * new bullet, Backspace at the start joins it to the one above (or removes
   * it when empty). The bullets are plain strings in a list, so the change is
   * made to the list and the caret is placed on the next render.
   */
  const itemKey = (sKey: string, items: string[], i: number) =>
    (ev: KeyboardEvent<HTMLElement>, el: HTMLElement): boolean => {
      if (!e) return false;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return false;
      const text = el.textContent ?? '';
      const at = caretOffset(el) ?? text.length;
      if (ev.key === 'Enter') {
        ev.preventDefault();
        e.sectionItems(sKey, (xs) => [...xs.slice(0, i), text.slice(0, at), text.slice(at), ...xs.slice(i + 1)]);
        forceSync();
        requestFocus(`${SURFACE}:sec:${sKey}:item:${i + 1}`, 0);
        return true;
      }
      if (ev.key === 'Backspace' && at === 0 && i > 0) {
        ev.preventDefault();
        const prev = items[i - 1] ?? '';
        e.sectionItems(sKey, (xs) => [...xs.slice(0, i - 1), prev + text, ...xs.slice(i + 1)]);
        forceSync();
        requestFocus(`${SURFACE}:sec:${sKey}:item:${i - 1}`, prev.length);
        return true;
      }
      return false;
    };

  return (
    <>
      {sections.map((s, si) => {
        const items = editing ? (s.items.length ? s.items : ['']) : s.items.filter((i) => i.trim());
        return (
          <div key={s.key} className={`qdoc-block qdoc-section ${L ? 'el-feerow relative' : ''}`}>
            {L && e ? (
              <div className="el-gutter qdoc-screen-only" style={{ flexDirection: 'row', left: 'auto', right: '100%', marginRight: 6 }}
                onMouseDown={(ev) => ev.preventDefault()}>
                <button type="button" className={gbtn} disabled={si === 0} title="Move section up" onClick={() => e.sectionOp(s.key, 'up')}><ArrowUp size={12} /></button>
                <button type="button" className={gbtn} disabled={si === sections.length - 1} title="Move section down" onClick={() => e.sectionOp(s.key, 'down')}><ArrowDown size={12} /></button>
                <button type="button" className={gbtn} title="Delete section" onClick={() => e.sectionOp(s.key, 'del')}><Trash2 size={12} /></button>
              </div>
            ) : null}
            <F live={L} id={`sec:${s.key}:title`} as="div" className="qdoc-heading" value={s.title}
              placeholder="Section title" onChange={(v) => e?.section(s.key, { title: v })} />
            {(L || s.description.trim()) ? (
              <F live={L} id={`sec:${s.key}:desc`} as="div" multiline className="qdoc-p" value={s.description}
                placeholder="Description (optional)" onChange={(v) => e?.section(s.key, { description: v })} />
            ) : null}
            {items.length > 0 ? (
              <ul className="qdoc-list">
                {items.map((it, n) => (
                  <li key={n}>
                    <F live={L} id={`sec:${s.key}:item:${n}`} value={it} placeholder="Item"
                      onKey={itemKey(s.key, items, n)}
                      onChange={(v) => e?.sectionItems(s.key, (xs) => {
                        const next = xs.length ? [...xs] : [''];
                        next[n] = v;
                        return next;
                      })} />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
      {L && e ? (
        <div className="qdoc-block">
          <AddRow label="+ Add Nature of Work section" onClick={() => requestFocus(`${SURFACE}:sec:${e.addSection()}:title`, 0)} />
        </div>
      ) : null}
    </>
  );
}

function Closing({ doc, e, live }: BP) {
  const editing = Boolean(e);
  const L = live && editing;
  if (!editing && !doc.closingText.trim() && !doc.preparedByName.trim()) return null;
  return (
    <div className="qdoc-block qdoc-closing">
      {(editing || doc.closingText.trim()) ? (
        <F live={L} id="closingText" as="div" multiline className="qdoc-p" value={doc.closingText}
          placeholder="Closing line" onChange={(v) => e?.field('closingText', v)} />
      ) : null}
      {(editing || doc.preparedByName.trim()) ? (
        <F live={L} id="preparedByName" as="div" className="qdoc-signer" value={doc.preparedByName}
          placeholder="Prepared by" onChange={(v) => e?.field('preparedByName', v)} />
      ) : null}
      {(editing || doc.preparedByDesignation.trim()) ? (
        <F live={L} id="preparedByDesignation" as="div" className="qdoc-muted" value={doc.preparedByDesignation}
          placeholder="Designation" onChange={(v) => e?.field('preparedByDesignation', v)} />
      ) : null}
      <div className="qdoc-muted">{doc.company.name}</div>
    </div>
  );
}

function Titled({ doc: _doc, e, live, title, field, text }: BP & { title: string; field: QuoteField; text: string }) {
  void _doc;
  const editing = Boolean(e);
  if (!editing && !text.trim()) return null;
  return (
    <div className="qdoc-block">
      {title ? <div className="qdoc-heading">{title}</div> : null}
      <F live={live && editing} id={field} as="div" multiline className="qdoc-p" value={text}
        placeholder={`${title}…`} onChange={(v) => e?.field(field, v)} />
    </div>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`qdoc-total-row ${strong ? 'qdoc-total-strong' : ''}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** dd-mm-yyyy, the way the reference quotation writes a date. */
function fmt(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '—';
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

/** Whole rupees for a fee column — professional fees are not quoted in paise. */
function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
}
