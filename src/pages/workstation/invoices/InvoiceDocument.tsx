import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { HEADING_SCALE, LINE_HEIGHT, pageGeometry } from '@/modules/workstation/quotations/document';
import {
  amountInWords, fmtDocDate, inrAmount, stateLabel,
  type BlockSpec, type CompanyInfo, type LayoutConfig, type Line, type Totals,
} from '@/modules/workstation/invoices/document';
import type { BankSnapshot, QrMode } from '@/modules/workstation/invoices/api';

/**
 * THE INVOICE DOCUMENT — the single rendering model behind the live preview,
 * the print output and the PDF (§33).
 *
 * There is deliberately no second renderer. The preview on the right of the
 * builder is not a picture OF the invoice, it IS the invoice: the same
 * component, at true paper size, scaled down by the pane around it. That is
 * what makes "the PDF matches the preview" a property of the code rather
 * than a thing to keep checking.
 *
 * PAGINATION IS REAL (§36, §37). Blocks are measured at paper size and packed
 * into pages of the exact content height. The items table is special: it
 * flows as ONE ROW PER NODE rather than as a single block, so
 *   - a page break never lands inside a row, and
 *   - any page that begins with item rows re-emits the table header,
 * which is exactly what §37 asks for and what a single-block table cannot do.
 */

export interface InvoiceDoc {
  layout: LayoutConfig;
  blocks: BlockSpec[];
  company: CompanyInfo;
  invoiceNumber: string;
  invoiceDate: string;
  termsLabel: string;
  dueDate: string;
  placeOfSupply: string;
  isInterState: boolean;
  billingName: string;
  billingAddress: string;
  shippingName: string;
  shippingAddress: string;
  customerGstin: string;
  lines: Line[];
  totals: Totals;
  notes: string;
  bank: BankSnapshot | null;
  signatoryName: string;
  signatoryDesignation: string;
  footerNote: string;
  qrMode: QrMode;
  qrValue: string;
  qrImage: string | null;
  amountPaidPaise: number;
  /** Server-supplied when saved; the mirror is used while still a draft. */
  totalInWords?: string;
}

/** A unit of flow. Item rows are their own nodes so breaks land between them. */
type Node =
  | { id: string; kind: 'block'; render: () => ReactNode }
  | { id: string; kind: 'item-row'; index: number };

export function InvoiceDocument({ doc, scale = 1 }: { doc: InvoiceDoc; scale?: number }) {
  const geo = pageGeometry(doc.layout);
  const nodes = buildNodes(doc);
  const pages = usePagination(nodes.map((n) => n.id), geo.contentHeightPx, doc);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const fontFamily = doc.layout.font === 'serif'
    ? 'Georgia, "Times New Roman", serif'
    : 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';

  const pageStyle: React.CSSProperties = {
    width: `${geo.widthPx}px`,
    minHeight: `${geo.heightPx}px`,
    padding: `${geo.marginPx}px`,
    fontFamily,
    fontSize: `${doc.layout.fontSize}px`,
    lineHeight: LINE_HEIGHT[doc.layout.lineHeight],
    background: '#fff',
    color: '#111827',
    boxSizing: 'border-box',
  };

  return (
    <div
      className="qdoc-stack"
      style={{
        // Pages are laid out at TRUE paper size and the pane scales the whole
        // stack down. Scaling the content instead would change how text wraps,
        // and the preview would stop predicting the PDF.
        transform: scale === 1 ? undefined : `scale(${scale})`,
        transformOrigin: 'top left',
        width: `${geo.widthPx}px`,
      }}
    >
      {/* The measuring twin: same nodes, off-screen, never printed. */}
      <div
        ref={pages.measureRef}
        aria-hidden
        className="qdoc-measure"
        style={{ ...pageStyle, position: 'absolute', visibility: 'hidden', pointerEvents: 'none', minHeight: 0, padding: 0, width: `${geo.widthPx - geo.marginPx * 2}px` }}
      >
        {nodes.map((n) => (
          <div key={n.id} data-block={n.id}>
            {n.kind === 'block'
              ? n.render()
              : <ItemTable doc={doc} rows={[n.index]} showHead={false} />}
          </div>
        ))}
      </div>

      <div ref={pages.pagesRef} className="contents">
        {pages.pages.map((ids, pageIndex) => (
          <div
            key={pageIndex}
            className="qdoc-page"
            style={{
              ...pageStyle,
              marginBottom: pageIndex === pages.pages.length - 1 ? 0 : 16,
              breakAfter: pageIndex === pages.pages.length - 1 ? 'auto' : 'page',
            }}
          >
            {renderPage(doc, ids, byId)}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Render one page's nodes, collapsing consecutive item-row nodes back into a
 * single table. The header is emitted for EVERY such run, which is why a
 * table continued onto page 2 arrives with its columns labelled.
 */
function renderPage(doc: InvoiceDoc, ids: string[], byId: Map<string, Node>): ReactNode {
  const out: ReactNode[] = [];
  let run: number[] = [];
  const flush = (key: string) => {
    if (run.length === 0) return;
    out.push(<ItemTable key={`t${key}`} doc={doc} rows={run} showHead />);
    run = [];
  };
  ids.forEach((id, i) => {
    const n = byId.get(id);
    if (!n) return;
    if (n.kind === 'item-row') { run.push(n.index); return; }
    flush(String(i));
    out.push(<div key={id}>{n.render()}</div>);
  });
  flush('end');
  return out;
}

function buildNodes(doc: InvoiceDoc): Node[] {
  const on = (k: string) => doc.blocks.some((b) => b.key === k && b.enabled);
  const nodes: Node[] = [];
  const push = (id: string, render: () => ReactNode) => nodes.push({ id, kind: 'block', render });

  if (on('company_header') || on('invoice_title')) {
    push('header', () => <Header doc={doc} showTitle={on('invoice_title')} showCompany={on('company_header')} />);
  }
  if (on('invoice_meta')) push('meta', () => <Meta doc={doc} />);
  if (on('bill_to') || on('ship_to')) {
    push('parties', () => <Parties doc={doc} bill={on('bill_to')} ship={on('ship_to')} />);
  }
  if (on('items_table')) {
    doc.lines.forEach((l, i) => nodes.push({ id: `row:${l.key}`, kind: 'item-row', index: i }));
  }
  if (on('total_in_words') || on('notes') || on('tax_summary')) {
    push('summary', () => (
      <SummaryRow doc={doc} words={on('total_in_words')} notes={on('notes')} tax={on('tax_summary')} />
    ));
  }
  if (on('bank_details') && doc.bank) push('bank', () => <BankBlock doc={doc} />);
  if (on('signature')) push('sign', () => <Signature doc={doc} />);
  if (on('footer')) push('footer', () => <Footer doc={doc} />);
  return nodes;
}

// ── Blocks ────────────────────────────────────────────────────────────────

const RULE = '1px solid #d1d5db';
const INK = '#1f3864';

function Header({ doc, showTitle, showCompany }: { doc: InvoiceDoc; showTitle: boolean; showCompany: boolean }) {
  const c = doc.company;
  const h = doc.layout.fontSize * HEADING_SCALE[doc.layout.headingSize];
  const align = doc.layout.logoPosition;
  return (
    <div style={{ borderBottom: RULE, paddingBottom: 10, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        {showCompany ? (
          <div style={{ textAlign: align === 'center' ? 'center' : align === 'right' ? 'right' : 'left' }}>
            {c.logo ? (
              <img src={c.logo} alt="" style={{ maxHeight: 44, marginBottom: 6, objectFit: 'contain' }} />
            ) : null}
            <div style={{ fontSize: h, fontWeight: 700, color: INK, lineHeight: 1.2 }}>{c.name}</div>
            <div style={{ marginTop: 4, color: '#374151' }}>
              {[c.addressLine1, c.addressLine2].filter(Boolean).map((l) => <div key={l}>{l}</div>)}
              <div>{[c.city, c.state, c.pin].filter(Boolean).join(' ')}</div>
              {c.phone ? <div>{c.phone}</div> : null}
              {c.email ? <div>{c.email}</div> : null}
              {c.website ? <div>{c.website}</div> : null}
              {c.gstin ? <div style={{ fontWeight: 700, marginTop: 2 }}>GSTIN: {c.gstin}</div> : null}
            </div>
          </div>
        ) : <div />}
        {showTitle ? (
          <div style={{ fontSize: h * 1.15, fontWeight: 700, color: INK, whiteSpace: 'nowrap' }}>TAX INVOICE</div>
        ) : null}
      </div>
    </div>
  );
}

/** Two columns of label/value, as the reference prints them. */
function Meta({ doc }: { doc: InvoiceDoc }) {
  const left: [string, string][] = [
    ['Invoice #', doc.invoiceNumber],
    ['Invoice Date', fmtDocDate(doc.invoiceDate)],
    ['Terms', doc.termsLabel],
    ['Due Date', fmtDocDate(doc.dueDate)],
  ];
  const right: [string, string][] = [['Place Of Supply', doc.placeOfSupply ? stateLabel(doc.placeOfSupply) : '—']];
  const cell = (rows: [string, string][]) => (
    <div style={{ flex: 1 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
          <div style={{ width: 110, color: '#4b5563' }}>{k}</div>
          <div style={{ fontWeight: 700 }}>: {v}</div>
        </div>
      ))}
    </div>
  );
  return (
    <div style={{ display: 'flex', gap: 24, marginBottom: 12, borderBottom: RULE, paddingBottom: 10 }}>
      {cell(left)}{cell(right)}
    </div>
  );
}

function Parties({ doc, bill, ship }: { doc: InvoiceDoc; bill: boolean; ship: boolean }) {
  const box = (title: string, name: string, address: string, gstin: string) => (
    <div style={{ flex: 1, padding: '8px 10px' }}>
      <div style={{ fontWeight: 700, color: INK, marginBottom: 3 }}>{title}</div>
      {name ? <div style={{ fontWeight: 700 }}>{name}</div> : null}
      {address
        ? address.split('\n').filter(Boolean).map((l, i) => <div key={i} style={{ color: '#374151' }}>{l}</div>)
        : null}
      {gstin ? <div style={{ marginTop: 2 }}>GSTIN {gstin}</div> : null}
    </div>
  );
  return (
    <div style={{ display: 'flex', border: RULE, background: '#f8fafc', marginBottom: 12 }}>
      {bill ? box('Bill To', doc.billingName, doc.billingAddress, doc.customerGstin) : null}
      {bill && ship ? <div style={{ borderLeft: RULE }} /> : null}
      {ship ? box('Ship To', doc.shippingName, doc.shippingAddress, doc.customerGstin) : null}
    </div>
  );
}

/**
 * The item table. `rows` are indices into doc.lines, so the same component
 * draws the whole table, one page's slice, or a single row for measuring —
 * and `showHead` is what gives a continuation page its column labels.
 */
function ItemTable({ doc, rows, showHead }: { doc: InvoiceDoc; rows: number[]; showHead: boolean }) {
  const inter = doc.isInterState;
  const th: React.CSSProperties = {
    background: '#1f3864', color: '#fff', fontWeight: 600, padding: '5px 6px',
    border: '1px solid #1f3864', textAlign: 'center', whiteSpace: 'nowrap',
  };
  const td: React.CSSProperties = { border: RULE, padding: '5px 6px', verticalAlign: 'top' };
  const num: React.CSSProperties = { ...td, textAlign: 'right', whiteSpace: 'nowrap' };

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10, tableLayout: 'fixed' }}>
      {showHead ? (
        <thead>
          <tr>
            <th style={{ ...th, width: '5%' }}>#</th>
            <th style={{ ...th, width: inter ? '34%' : '26%', textAlign: 'left' }}>Item &amp; Description</th>
            <th style={{ ...th, width: '11%' }}>HSN/SAC</th>
            <th style={{ ...th, width: '8%' }}>Qty</th>
            <th style={{ ...th, width: '12%' }}>Rate</th>
            {inter ? (
              <>
                <th style={{ ...th, width: '9%' }}>IGST %</th>
                <th style={{ ...th, width: '12%' }}>Amt</th>
              </>
            ) : (
              <>
                <th style={{ ...th, width: '8%' }}>CGST %</th>
                <th style={{ ...th, width: '10%' }}>Amt</th>
                <th style={{ ...th, width: '8%' }}>SGST %</th>
                <th style={{ ...th, width: '10%' }}>Amt</th>
              </>
            )}
            <th style={{ ...th, width: '13%' }}>Amount</th>
          </tr>
        </thead>
      ) : null}
      <tbody>
        {rows.map((i) => {
          const l = doc.lines[i];
          const t = doc.totals.lines[i];
          if (!l || !t) return null;
          return (
            <tr key={l.key} style={{ breakInside: 'avoid' }}>
              <td style={{ ...td, textAlign: 'center' }}>{i + 1}</td>
              <td style={td}>
                <div>{l.itemName || '—'}</div>
                {l.description
                  ? <div style={{ color: '#6b7280', fontSize: '0.92em' }}>{l.description}</div>
                  : null}
              </td>
              <td style={{ ...td, textAlign: 'center' }}>{l.hsnSac || '—'}</td>
              <td style={{ ...num }}>{(l.quantityCenti / 100).toFixed(2)}</td>
              <td style={num}>{inrAmount(l.ratePaise)}</td>
              {inter ? (
                <>
                  <td style={{ ...td, textAlign: 'center' }}>{t.igstRatePercent}%</td>
                  <td style={num}>{inrAmount(t.igstAmountPaise)}</td>
                </>
              ) : (
                <>
                  <td style={{ ...td, textAlign: 'center' }}>{t.cgstRatePercent}%</td>
                  <td style={num}>{inrAmount(t.cgstAmountPaise)}</td>
                  <td style={{ ...td, textAlign: 'center' }}>{t.sgstRatePercent}%</td>
                  <td style={num}>{inrAmount(t.sgstAmountPaise)}</td>
                </>
              )}
              <td style={num}>{inrAmount(t.taxableAmountPaise)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SummaryRow({ doc, words, notes, tax }: { doc: InvoiceDoc; words: boolean; notes: boolean; tax: boolean }) {
  const t = doc.totals;
  const row = (k: string, v: string, strong = false) => (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 16, padding: '3px 8px',
      fontWeight: strong ? 700 : 400, background: strong ? '#f1f5f9' : undefined,
    }}>
      <span>{k}</span><span>{v}</span>
    </div>
  );
  const half = doc.isInterState ? t.igstPaise : t.cgstPaise;
  return (
    <div style={{ display: 'flex', gap: 24, marginBottom: 12 }}>
      <div style={{ flex: 1 }}>
        {words ? (
          <>
            <div style={{ fontWeight: 700, color: INK }}>Total In Words</div>
            <div style={{ marginBottom: 8 }}>{doc.totalInWords ?? amountInWords(t.totalPaise)}</div>
          </>
        ) : null}
        {notes ? (
          <>
            <div style={{ fontWeight: 700, color: INK }}>Notes</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{doc.notes}</div>
          </>
        ) : null}
      </div>
      {tax ? (
        <div style={{ width: '42%' }}>
          {row('Sub Total', inrAmount(t.subtotalPaise))}
          {t.discountPaise > 0 ? row('Discount', `- ${inrAmount(t.discountPaise)}`) : null}
          {doc.isInterState
            ? (half > 0 ? row('IGST', inrAmount(t.igstPaise)) : null)
            : (
              <>
                {t.cgstPaise > 0 ? row('CGST', inrAmount(t.cgstPaise)) : null}
                {t.sgstPaise > 0 ? row('SGST', inrAmount(t.sgstPaise)) : null}
              </>
            )}
          {t.roundOffPaise !== 0 ? row('Round Off', inrAmount(t.roundOffPaise)) : null}
          {row('Total', `Rs. ${inrAmount(t.totalPaise)}`, true)}
          {doc.amountPaidPaise > 0 ? row('Paid', `- ${inrAmount(doc.amountPaidPaise)}`) : null}
          {row('Balance Due', `Rs. ${inrAmount(t.balanceDuePaise)}`, true)}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Whether a QR will be printed. Mirrors buildQrPayload on the server, so the
 * preview reserves space exactly when the PDF will use it — otherwise
 * pagination would be right on screen and wrong on paper.
 */
function qrShown(doc: InvoiceDoc): boolean {
  if (doc.qrMode === 'none') return false;
  if (doc.qrMode === 'custom') return Boolean(doc.qrValue.trim());
  if (doc.qrMode === 'image') return Boolean(doc.qrImage);
  return Boolean(doc.bank?.upi_id);
}

function BankBlock({ doc }: { doc: InvoiceDoc }) {
  const b = doc.bank!;
  const f = (k: string, v: string | null) =>
    v ? <div><span style={{ fontWeight: 700 }}>{k}:</span> {v}</div> : null;
  return (
    <div style={{
      border: RULE, background: '#f8fafc', padding: '8px 10px', marginBottom: 12,
      display: 'flex', justifyContent: 'space-between', gap: 16,
    }}>
      <div>
        <div style={{ fontWeight: 700, color: INK, marginBottom: 4 }}>Bank Details</div>
        {f('Account Number', b.account_number)}
        {f('Account Type', b.account_type)}
        {f('Account Holder', b.account_holder)}
        {f('Bank', b.bank_name)}
        {f('Branch Name', b.branch_name)}
        {f('IFSC Code', b.ifsc_code)}
        {f('UPI ID', b.upi_id)}
      </div>
      {/* The UPI panel the reference carries. On screen it is a PLACEHOLDER:
          the scannable code is generated server-side for the PDF, because the
          bytes a client scans should come from the same place the bytes they
          receive do. Reserving the space here keeps the preview's pagination
          honest about what the PDF will occupy. */}
      {qrShown(doc) ? (
        <div style={{ textAlign: 'center', minWidth: 120 }}>
          <div style={{ color: '#6b7280', fontSize: '0.8em' }}>Pay to</div>
          <div style={{ fontWeight: 700, color: INK, fontSize: '0.9em' }}>{b.account_holder}</div>
          {/* An uploaded code is shown for real, because it already exists
              as bytes. A generated one is still a placeholder: it is encoded
              server-side so the preview and the PDF cannot drift. */}
          {doc.qrMode === 'image' && doc.qrImage ? (
            <img
              src={doc.qrImage}
              alt="Payment QR"
              style={{ width: 86, height: 86, margin: '6px auto 4px', display: 'block', objectFit: 'contain' }}
            />
          ) : (
            <div style={{
              width: 86, height: 86, margin: '6px auto 4px', border: RULE, borderRadius: 2,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#9ca3af', fontSize: '0.7em', background: '#fff', textAlign: 'center', lineHeight: 1.25,
            }}>
              UPI QR<br />in the PDF
            </div>
          )}
          <div style={{ color: '#6b7280', fontSize: '0.7em' }}>
            {doc.qrMode === 'custom' || doc.qrMode === 'image' ? 'Scan to pay' : `UPI ID ${b.upi_id ?? ''}`}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Signature({ doc }: { doc: InvoiceDoc }) {
  return (
    <div style={{ marginTop: 18, marginBottom: 10, textAlign: 'right' }}>
      <div style={{ color: '#374151' }}>Authorized Signature</div>
      <div style={{ borderBottom: '1px solid #6b7280', width: 200, marginLeft: 'auto', marginTop: 34 }} />
      {doc.signatoryName ? <div style={{ fontWeight: 700, marginTop: 3 }}>{doc.signatoryName}</div> : null}
      {doc.signatoryDesignation ? <div style={{ color: '#6b7280' }}>{doc.signatoryDesignation}</div> : null}
    </div>
  );
}

function Footer({ doc }: { doc: InvoiceDoc }) {
  if (!doc.footerNote) return null;
  return (
    <div style={{ borderTop: RULE, paddingTop: 6, textAlign: 'center', color: '#6b7280', fontSize: '0.9em' }}>
      {doc.footerNote}
    </div>
  );
}

// ── Pagination ────────────────────────────────────────────────────────────

/**
 * Measure each node once it is on screen and pack the nodes into pages.
 *
 * Greedy: a node that does not fit starts the next page. Because item rows
 * are individual nodes, a break between them is the normal case and a row is
 * never cut in half; renderPage then re-emits the table header for whatever
 * run of rows opens the page.
 *
 * A continuation page's repeated header costs vertical space that the measure
 * pass cannot see — it measures rows without a header. HEAD_RESERVE_PX holds
 * that space back on every page after the first, so a table that continues
 * does not overflow by exactly one header.
 */
const HEAD_RESERVE_PX = 30;

function usePagination(ids: string[], contentHeightPx: number, doc: InvoiceDoc) {
  const measureRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<string[][]>([ids]);
  const signature = JSON.stringify({ ids, contentHeightPx, doc });

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
    const limit = () => (next.length === 0 ? contentHeightPx : contentHeightPx - HEAD_RESERVE_PX);
    for (const id of ids) {
      const h = heights.get(id) ?? 0;
      if (current.length > 0 && used + h > limit()) {
        next.push(current);
        current = [];
        used = 0;
      }
      current.push(id);
      used += h;
    }
    if (current.length > 0 || next.length === 0) next.push(current);

    setPages((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return { pages, measureRef, pagesRef };
}
