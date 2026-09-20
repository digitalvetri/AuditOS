import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Copy, Minus, MoveVertical, Plus, Trash2 } from 'lucide-react';
import {
  LINE_HEIGHT, SPACE_MAX_PX, SPACE_MIN_PX, SPACE_STEP_PX, clampSpace, pageGeometry,
  type CompanyInfo, type LayoutConfig,
} from '@/modules/workstation/quotations/document';
import {
  EMPTY_RECIPIENT, ENGAGEMENT_COMPANY, fmtLong, layoutOf, lineIsEmpty, normalizeBlocks, rupees,
  type EBlock, type FeeLine, type Line, type Recipient,
} from '@/modules/workstation/engagement/document';
import { caretOffset, setCaret } from '@/modules/workstation/engagement/richtext';
import type { EngagementLetter } from '@/modules/workstation/engagement/api';
import { DateField, PlainField, RichLine } from './Editable';

/**
 * THE ENGAGEMENT LETTER — rendered, and (given `edit`) edited in place.
 *
 * The same component is the builder's editable page, the preview route and
 * the print output. With no `edit` prop it is read-only.
 *
 * Paginates by UNIT: a heading travels with its first line, and every further
 * paragraph, list item and fee line is its own unit, packed into A4 pages. A
 * static twin of every unit is measured off-screen; units never split, so a
 * paragraph longer than the room left moves to the next page, as it does in
 * the PDF.
 */

export interface EngagementFee {
  key: string;
  service: string;
  description: string;
  frequency: string;
  amountPaise: number;
  /** As typed in the builder; absent on a saved letter. */
  amountText?: string;
  billingBasis: string;
  notes: string;
}

export interface EngagementDoc {
  letterDate: string;
  subject: string;
  financialYear: string;
  effectiveFrom: string;
  effectiveUntil: string;
  company: CompanyInfo;
  recipient: Recipient;
  blocks: EBlock[];
  fees: EngagementFee[];
  signatoryName: string;
  signatoryDesignation: string;
  clientSignatoryName: string;
  clientSignatoryDesignation: string;
  /** Page, type, header and footer — the Layout tab. */
  layout: LayoutConfig;
}

/** Heading size relative to the body text, per the Layout tab. */
const HEADING_EM: Record<LayoutConfig['headingSize'], string> = { compact: '1em', normal: '1.08em', large: '1.25em' };

export type FieldKey =
  | 'subject' | 'letterDate' | 'signatoryName' | 'signatoryDesignation'
  | 'clientSignatoryName' | 'clientSignatoryDesignation';

/** Everything the page can change. Implemented by the builder, over its one state. */
export interface EditApi {
  field: (k: FieldKey, v: string) => void;
  recipient: (k: keyof Recipient, v: string) => void;
  company: (k: keyof CompanyInfo, v: string) => void;
  block: (id: string, patch: Partial<EBlock>) => void;
  line: (blockId: string, lineId: string, patch: Partial<Line>) => void;
  lineKey: (e: KeyboardEvent<HTMLElement>, el: HTMLElement, blockId: string, line: Line, surface: string) => void;
  pasteLines: (text: string, el: HTMLElement, blockId: string, lineId: string, surface: string) => void;
  moveBlock: (id: string, by: -1 | 1) => void;
  removeBlock: (id: string) => void;
  addBlockAfter: (id: string, kind: 'section' | 'spacer', surface: string) => void;
  fee: (key: string, patch: Partial<FeeLine>) => void;
  feeOp: (key: string, op: 'up' | 'down' | 'dup' | 'del') => void;
  addFee: (surface: string) => void;
}

const SURFACE = 'doc';
const REMOVABLE = new Set(['paragraph', 'section', 'spacer']);

interface Unit { id: string; blockId: string; first: boolean; node: (live: boolean) => ReactNode }

export function EngagementDocument({ doc, scale, edit }: {
  doc: EngagementDoc;
  scale?: number;
  /** Present → the page is directly editable. */
  edit?: EditApi;
}) {
  const geo = pageGeometry(doc.layout);
  const vars = varsOf(doc);
  const editing = Boolean(edit);
  const blocks = doc.blocks.filter((b) => b.enabled);
  const units = blocks.flatMap((b) => unitsOf(b, doc, vars, edit));
  const ids = units.map((u) => u.id);

  const signature = JSON.stringify({ ids, doc, editing });
  const { pages, measureRef, pagesRef } = usePages(ids, geo.contentHeightPx, signature);
  const scaled = Boolean(scale) && scale !== 1;
  const { stackRef, naturalHeight } = useNaturalHeight();
  const blockIndex = new Map(doc.blocks.map((b, i) => [b.id, i]));

  const stack = (
    <div
      ref={stackRef}
      className={`qdoc-stack ${editing ? 'el-editing' : ''}`}
      data-edit-surface={editing ? SURFACE : undefined}
      style={{
        fontFamily: doc.layout.font === 'serif' ? 'Georgia, "Times New Roman", serif' : 'Arial, Helvetica, sans-serif',
        ['--qd-font-size' as string]: `${doc.layout.fontSize}pt`,
        ['--qd-line-height' as string]: String(LINE_HEIGHT[doc.layout.lineHeight] ?? 1.55),
        ['--el-h' as string]: HEADING_EM[doc.layout.headingSize] ?? '1.08em',
        transform: scaled ? `scale(${scale})` : undefined,
        transformOrigin: 'top center',
      }}
    >
      <div ref={measureRef} aria-hidden className="qdoc-measure" style={{ width: `${geo.widthPx - geo.marginPx * 2}px` }}>
        {units.map((u) => <div key={u.id} data-unit={u.id}>{u.node(false)}</div>)}
      </div>

      <div ref={pagesRef} className="contents">
        {pages.map((pageIds, i) => (
          <section
            key={i}
            className="qdoc-page"
            style={{ width: `${geo.widthMm}mm`, minHeight: `${geo.heightMm}mm`, padding: `${geo.marginMm}mm` }}
          >
            <div className="qdoc-body">
              {pageIds.map((id) => {
                const u = units.find((x) => x.id === id);
                if (!u) return null;
                const b = doc.blocks.find((x) => x.id === u.blockId);
                return (
                  <div key={id} className={editing ? 'el-unit relative' : undefined}>
                    {edit && u.first && b ? (
                      <Gutter
                        b={b} edit={edit}
                        isFirst={blockIndex.get(b.id) === 0}
                        isLast={blockIndex.get(b.id) === doc.blocks.length - 1}
                      />
                    ) : null}
                    {u.node(true)}
                  </div>
                );
              })}
            </div>
            {doc.layout.footerStyle === 'none' ? null : (
              <footer className="qdoc-footer">
                <span>{doc.layout.footerStyle === 'company' ? doc.company.name : `Page ${i + 1} of ${pages.length}`}</span>
              </footer>
            )}
          </section>
        ))}
      </div>
    </div>
  );

  if (!scaled) return stack;
  return (
    <div className="qdoc-scaler" style={{ height: naturalHeight === null ? undefined : naturalHeight * (scale ?? 1) }}>
      {stack}
    </div>
  );
}

export function varsOf(doc: EngagementDoc): Record<string, string> {
  return {
    client_name: doc.recipient.name,
    contact_person: doc.recipient.name,
    designation: doc.recipient.designation,
    company_name: doc.recipient.companyName,
    financial_year: doc.financialYear,
    effective_from: fmtLong(doc.effectiveFrom),
    effective_until: fmtLong(doc.effectiveUntil),
    firm_name: doc.company.name,
  };
}

// ── Block controls in the page margin ─────────────────────────────────────

const gbtn = 'h-6 w-6 inline-flex items-center justify-center rounded border border-neutral-300 bg-white text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50 disabled:opacity-30';

function Gutter({ b, edit, isFirst, isLast }: { b: EBlock; edit: EditApi; isFirst: boolean; isLast: boolean }) {
  if (b.key === 'spacer') return null; // a space carries its own controls
  return (
    <div className="el-gutter qdoc-screen-only" onMouseDown={(e) => e.preventDefault()}>
      <button type="button" className={gbtn} disabled={isFirst} title="Move up" onClick={() => edit.moveBlock(b.id, -1)}><ArrowUp size={12} /></button>
      <button type="button" className={gbtn} disabled={isLast} title="Move down" onClick={() => edit.moveBlock(b.id, 1)}><ArrowDown size={12} /></button>
      <button type="button" className={gbtn} title="Add a section below" onClick={() => edit.addBlockAfter(b.id, 'section', SURFACE)}><Plus size={12} /></button>
      <button type="button" className={gbtn} title="Add space below" onClick={() => edit.addBlockAfter(b.id, 'spacer', SURFACE)}><MoveVertical size={12} /></button>
      {REMOVABLE.has(b.key) ? (
        <button type="button" className={gbtn} title="Delete" onClick={() => edit.removeBlock(b.id)}><Trash2 size={12} /></button>
      ) : null}
    </div>
  );
}

// ── Lines ─────────────────────────────────────────────────────────────────

function lineStyle(l: Line) {
  return { textAlign: l.align, margin: 0 } as const;
}

/** One paragraph or list item, with its marker. `n` numbers a numbered item. */
export function LineView({ b, l, n, vars, edit, live, placeholder, surface = SURFACE }: {
  b: EBlock; l: Line; n: number; vars: Record<string, string>; edit?: EditApi; live: boolean; placeholder?: string;
  /** Which editor this copy of the line belongs to — the page, or the left panel. */
  surface?: string;
}) {
  const body = (
    <RichLine
      live={live && Boolean(edit)}
      editId={`${surface}:${l.id}`}
      syncKey={l.id}
      html={l.html}
      vars={vars}
      placeholder={placeholder}
      style={{ ...lineStyle(l), flex: l.kind === 'p' ? undefined : 1 }}
      dataAttrs={{ block: b.id, line: l.id }}
      onChange={(html) => edit?.line(b.id, l.id, { html })}
      onKeyDown={(e, el) => edit?.lineKey(e, el, b.id, l, surface)}
      onPasteText={(t, el) => edit?.pasteLines(t, el, b.id, l.id, surface)}
    />
  );
  const indent = l.indent * 24;
  if (l.kind === 'p') {
    return <div style={{ paddingLeft: indent, margin: '0 0 0.7em' }}>{body}</div>;
  }
  return (
    <div style={{ display: 'flex', gap: 8, paddingLeft: indent, margin: '0 0 0.3em' }}>
      <span style={{ flex: 'none', width: 18 }} aria-hidden>{l.kind === 'bullet' ? '•' : `${n}.`}</span>
      {body}
    </div>
  );
}

/** Numbers for consecutive numbered lines; any other line restarts the count. */
export function numbering(lines: Line[]): Map<string, number> {
  const m = new Map<string, number>();
  let n = 0;
  for (const l of lines) { n = l.kind === 'number' ? n + 1 : 0; m.set(l.id, n); }
  return m;
}

const H = ({ children }: { children: ReactNode }) => (
  <div style={{ fontWeight: 700, fontSize: 'var(--el-h, 1.08em)', margin: '0.9em 0 0.35em' }}>{children}</div>
);

// ── Units ─────────────────────────────────────────────────────────────────

function unitsOf(b: EBlock, doc: EngagementDoc, vars: Record<string, string>, edit?: EditApi): Unit[] {
  const editing = Boolean(edit);
  const one = (node: (live: boolean) => ReactNode): Unit[] => [{ id: `${b.id}:0`, blockId: b.id, first: true, node }];
  const live = (l: boolean) => l && editing;

  const lineUnits = (lines: Line[], head?: (live: boolean) => ReactNode, placeholder?: string): Unit[] => {
    // On paper an empty line is nothing; while editing it is a place to type.
    const shown = editing ? lines : lines.filter((l) => !lineIsEmpty(l));
    const nums = numbering(shown);
    if (!shown.length) {
      return head ? [{ id: `${b.id}:head`, blockId: b.id, first: true, node: head }] : [];
    }
    return shown.map((l, i) => ({
      id: `${b.id}:${l.id}`,
      blockId: b.id,
      first: i === 0,
      node: (lv: boolean) => (
        <>
          {i === 0 && head ? head(lv) : null}
          <LineView b={b} l={l} n={nums.get(l.id) ?? 0} vars={vars} edit={edit} live={lv}
            placeholder={i === 0 ? placeholder : undefined} />
        </>
      ),
    }));
  };

  switch (b.key) {
    case 'letterhead': {
      const c = doc.company;
      const part = (k: keyof CompanyInfo, lv: boolean, ph: string) => (
        <PlainField live={live(lv)} editId={`${SURFACE}:co:${k}`} value={c[k]} placeholder={ph}
          onChange={(v) => edit?.company(k, v)} />
      );
      const addrKeys: [keyof CompanyInfo, string][] = [
        ['addressLine1', 'Address'], ['addressLine2', 'Area'], ['city', 'City'], ['state', 'State'],
      ];
      return one((lv) => (
        <div style={{
          textAlign: doc.layout.logoPosition,
          borderBottom: doc.layout.headerStyle === 'plain' ? 'none'
            : doc.layout.headerStyle === 'bar' ? '3px solid #111827' : '1px solid #9ca3af',
          paddingBottom: 10, marginBottom: 18,
        }}>
          <div style={{ fontSize: '1.45em', fontWeight: 700, letterSpacing: '0.02em', textTransform: 'uppercase' }}>
            {part('name', lv, 'Firm name')}
          </div>
          <div style={{ color: '#4b5563', fontSize: '0.9em' }}>
            {addrKeys.filter(([k]) => editing || c[k]).map(([k, ph], i) => (
              <span key={k}>{i > 0 ? ', ' : ''}{part(k, lv, ph)}</span>
            ))}
            {editing || c.pin ? <> – {part('pin', lv, 'PIN')}</> : null}
          </div>
          <div style={{ color: '#4b5563', fontSize: '0.9em' }}>
            {part('phone', lv, 'Phone')}{'   |   '}{part('email', lv, 'Email')}
          </div>
        </div>
      ));
    }

    case 'date':
      return one((lv) => (
        <div style={{ textAlign: 'right', marginBottom: 14 }}>
          <DateField live={live(lv)} value={doc.letterDate} display={fmtLong(doc.letterDate)}
            onChange={(v) => edit?.field('letterDate', v)} />
        </div>
      ));

    case 'recipient': {
      const r = doc.recipient;
      const f = (k: keyof Recipient, lv: boolean, ph: string, extra: { bold?: boolean; multiline?: boolean } = {}) =>
        (editing || r[k]) ? (
          <PlainField as="div" live={live(lv)} editId={`${SURFACE}:rc:${k}`} value={r[k]} placeholder={ph}
            multiline={extra.multiline} style={{ fontWeight: extra.bold ? 700 : 400 }}
            onChange={(v) => edit?.recipient(k, v)} />
        ) : null;
      const inline = (k: keyof Recipient, lv: boolean, ph: string) => (
        <PlainField live={live(lv)} editId={`${SURFACE}:rc:${k}`} value={r[k]} placeholder={ph}
          onChange={(v) => edit?.recipient(k, v)} />
      );
      return one((lv) => (
        <div style={{ marginBottom: 14 }}>
          <PlainField as="div" live={live(lv)} editId={`${SURFACE}:lbl:${b.id}`} value={b.body ?? ''} fallback="To"
            onChange={(v) => edit?.block(b.id, { body: v })} />
          {f('name', lv, 'Contact person')}
          {f('designation', lv, 'Designation')}
          {f('companyName', lv, 'Company name', { bold: true })}
          {f('address', lv, 'Address', { multiline: true })}
          {(editing || r.city || r.state || r.pincode) ? (
            <div>
              {(editing || r.city) ? inline('city', lv, 'City') : null}
              {(editing || (r.city && r.state)) ? ', ' : null}
              {(editing || r.state) ? inline('state', lv, 'State') : null}
              {(editing || r.pincode) ? <> – {inline('pincode', lv, 'PIN')}</> : null}
            </div>
          ) : null}
        </div>
      ));
    }

    case 'subject':
      return one((lv) => (
        <div style={{ marginBottom: 14 }}>
          <strong>
            <PlainField live={live(lv)} editId={`${SURFACE}:lbl:${b.id}`} value={b.body ?? ''} fallback="Sub:"
              onChange={(v) => edit?.block(b.id, { body: v })} />
          </strong>{' '}
          <PlainField live={live(lv)} editId={`${SURFACE}:subject`} value={doc.subject} placeholder="Subject"
            onChange={(v) => edit?.field('subject', v)} />
        </div>
      ));

    case 'salutation':
      return one((lv) => (
        <div style={{ marginBottom: 10 }}>
          <PlainField live={live(lv)} editId={`${SURFACE}:sal:${b.id}`} value={b.body ?? ''} placeholder="Dear Sir,"
            onChange={(v) => edit?.block(b.id, { body: v })} />
        </div>
      ));

    case 'paragraph':
    case 'closing':
      return lineUnits(b.lines ?? [], undefined, b.hint ?? 'Type here…');

    case 'section': {
      const head = (lv: boolean) => (editing || b.title?.trim()) ? (
        <H>
          <PlainField live={live(lv)} editId={`${SURFACE}:title:${b.id}`} value={b.title ?? ''} placeholder="Section heading"
            onChange={(v) => edit?.block(b.id, { title: v })} />
        </H>
      ) : null;
      return lineUnits(b.lines ?? [], head, b.hint ?? 'Type here…');
    }

    case 'fees': {
      if (!doc.fees.length && !editing) return [];
      const head = (lv: boolean) => (
        <H>
          <PlainField live={live(lv)} editId={`${SURFACE}:title:${b.id}`} value={b.title ?? ''} fallback="Fees:"
            onChange={(v) => edit?.block(b.id, { title: v })} />
        </H>
      );
      const feeUnits: Unit[] = doc.fees.map((f, i) => ({
        id: `${b.id}:fee:${f.key}`,
        blockId: b.id,
        first: i === 0,
        node: (lv: boolean) => (
          <>
            {i === 0 ? head(lv) : null}
            <FeeRow f={f} edit={edit} live={live(lv)} isFirst={i === 0} isLast={i === doc.fees.length - 1} />
          </>
        ),
      }));
      const extra: Unit[] = editing ? [{
        id: `${b.id}:addfee`, blockId: b.id, first: !doc.fees.length,
        node: (lv: boolean) => (
          <>
            {!doc.fees.length ? head(lv) : null}
            <div className="qdoc-screen-only" style={{ margin: '0 0 0.6em 26px' }}>
              <button type="button" className="el-addfee" onMouseDown={(e) => e.preventDefault()} onClick={() => edit?.addFee(SURFACE)}>
                + Add fee
              </button>
            </div>
          </>
        ),
      }] : [];
      const note = lineUnits(b.lines ?? [], undefined, 'Optional note under the fees…').map((u) => ({ ...u, first: false }));
      return [...feeUnits, ...extra, ...note];
    }

    case 'signature':
      return one((lv) => (
        <div style={{ marginTop: 18 }}>
          <PlainField as="div" live={live(lv)} editId={`${SURFACE}:lbl:${b.id}`} value={b.body ?? ''} fallback="Yours truly,"
            onChange={(v) => edit?.block(b.id, { body: v })} />
          <div style={{ height: 52 }} />
          <PlainField as="div" live={live(lv)} editId={`${SURFACE}:sig:name`} value={doc.signatoryName}
            placeholder="Signatory name" style={{ fontWeight: 700 }} onChange={(v) => edit?.field('signatoryName', v)} />
          <PlainField as="div" live={live(lv)} editId={`${SURFACE}:sig:des`} value={doc.signatoryDesignation}
            placeholder="Designation" onChange={(v) => edit?.field('signatoryDesignation', v)} />
          <PlainField as="div" live={live(lv)} editId={`${SURFACE}:sig:firm`} value={doc.company.name}
            placeholder="Firm name" onChange={(v) => edit?.company('name', v)} />
        </div>
      ));

    case 'confirmation':
      return one((lv) => (
        <div style={{ marginTop: 22 }}>
          <PlainField as="div" live={live(lv)} editId={`${SURFACE}:conf:${b.id}`} value={b.body ?? ''}
            fallback="The above terms and conditions are agreed and confirmed by;"
            onChange={(v) => edit?.block(b.id, { body: v })} />
          <div style={{ height: 52 }} />
          <div style={{ width: 200, borderTop: '1px solid #111827', marginBottom: 4 }} />
          <PlainField as="div" live={live(lv)} editId={`${SURFACE}:conf:name`} value={doc.clientSignatoryName}
            fallback={doc.recipient.name} placeholder="Client name" style={{ fontWeight: 700 }}
            onChange={(v) => edit?.field('clientSignatoryName', v)} />
          <PlainField as="div" live={live(lv)} editId={`${SURFACE}:conf:des`} value={doc.clientSignatoryDesignation}
            fallback={doc.recipient.designation} placeholder="Client designation"
            onChange={(v) => edit?.field('clientSignatoryDesignation', v)} />
          {doc.recipient.companyName ? <div>{doc.recipient.companyName}</div> : null}
        </div>
      ));

    case 'spacer':
      return one((lv) => <SpaceBlock b={b} edit={lv ? edit : undefined} />);

    default:
      return [];
  }
}

// ── Fees ──────────────────────────────────────────────────────────────────

function FeeRow({ f, edit, live, isFirst, isLast }: {
  f: EngagementFee; edit?: EditApi; live: boolean; isFirst: boolean; isLast: boolean;
}) {
  const pf = (k: 'service' | 'description' | 'frequency' | 'billingBasis', ph: string, v: string) => (
    <PlainField live={live} editId={`${SURFACE}:fee:${f.key}:${k}`} value={v} placeholder={ph}
      onChange={(x) => edit?.fee(f.key, { [k]: x })} />
  );
  // While typing, the amount is the raw figure; on leaving it, it is formatted.
  const amount = (
    <PlainField
      live={live} editId={`${SURFACE}:fee:${f.key}:amount`}
      value={f.amountText ?? (f.amountPaise / 100).toLocaleString('en-IN')}
      placeholder="0"
      onChange={(x) => edit?.fee(f.key, { amountText: x })}
      onBlurValue={(x) => {
        const n = Number(x.replace(/[^0-9.]/g, ''));
        if (Number.isFinite(n) && x.trim()) edit?.fee(f.key, { amountText: n.toLocaleString('en-IN') });
      }}
    />
  );
  return (
    <div className={live ? 'el-feerow relative' : undefined}>
      {live && edit ? (
        <div className="el-gutter qdoc-screen-only" onMouseDown={(e) => e.preventDefault()}>
          <button type="button" className={gbtn} disabled={isFirst} title="Move up" onClick={() => edit.feeOp(f.key, 'up')}><ArrowUp size={12} /></button>
          <button type="button" className={gbtn} disabled={isLast} title="Move down" onClick={() => edit.feeOp(f.key, 'down')}><ArrowDown size={12} /></button>
          <button type="button" className={gbtn} title="Duplicate" onClick={() => edit.feeOp(f.key, 'dup')}><Copy size={12} /></button>
          <button type="button" className={gbtn} title="Delete fee" onClick={() => edit.feeOp(f.key, 'del')}><Trash2 size={12} /></button>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, margin: '0 0 0.3em' }}>
        <span style={{ flex: 'none', width: 18 }}>•</span>
        <span style={{ flex: 1 }}>
          {pf('service', 'Service', f.service)}
          {(live || f.description) ? <> — {pf('description', 'description', f.description)}</> : null}
        </span>
        <span style={{ flex: 'none', fontWeight: 700, textAlign: 'right' }}>
          {live ? <>Rs. {amount}</> : rupees(f.amountPaise)}
          {(live || f.frequency) ? <> {pf('frequency', 'per month', f.frequency)}</> : null}
          {(live || f.billingBasis) ? <> [{pf('billingBasis', 'basis', f.billingBasis)}]</> : null}
        </span>
      </div>
      {f.notes ? <div style={{ color: '#4b5563', fontSize: '0.92em', margin: '0 0 0.3em 26px' }}>{f.notes}</div> : null}
    </div>
  );
}

// ── Space ─────────────────────────────────────────────────────────────────

function SpaceBlock({ b, edit }: { b: EBlock; edit?: EditApi }) {
  const h = b.heightPx ?? 24;
  if (!edit) return <div aria-hidden style={{ height: `${h}px` }} />;
  const set = (px: number) => edit.block(b.id, { heightPx: clampSpace(px) });
  return (
    <div className="el-space relative" style={{ height: `${h}px` }}>
      <div className="el-space-bar qdoc-screen-only" onMouseDown={(e) => e.preventDefault()}>
        <span>Space · {h}px</span>
        <button type="button" className={gbtn} title="Move up" onClick={() => edit.moveBlock(b.id, -1)}><ArrowUp size={12} /></button>
        <button type="button" className={gbtn} title="Move down" onClick={() => edit.moveBlock(b.id, 1)}><ArrowDown size={12} /></button>
        <button type="button" className={gbtn} title="Decrease height" disabled={h <= SPACE_MIN_PX} onClick={() => set(h - SPACE_STEP_PX)}><Minus size={12} /></button>
        <button type="button" className={gbtn} title="Increase height" disabled={h >= SPACE_MAX_PX} onClick={() => set(h + SPACE_STEP_PX)}><Plus size={12} /></button>
        <button type="button" className={gbtn} title="Delete space" onClick={() => edit.removeBlock(b.id)}><Trash2 size={12} /></button>
      </div>
    </div>
  );
}

// ── Pagination ────────────────────────────────────────────────────────────

/**
 * Measure the static twins, pack units into pages. When a unit being typed
 * in crosses a page boundary it is remounted on its new page — so the focused
 * element and caret offset are captured first and put back after.
 */
function usePages(ids: string[], contentHeightPx: number, signature: string) {
  const measureRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<string[][]>([ids]);
  const restore = useRef<{ editId: string; offset: number } | null>(null);

  useLayoutEffect(() => {
    const root = measureRef.current;
    if (!root) return;
    const h = new Map<string, number>();
    root.querySelectorAll<HTMLElement>('[data-unit]').forEach((el) => {
      h.set(el.dataset.unit!, el.getBoundingClientRect().height);
    });
    const next: string[][] = [];
    let cur: string[] = [];
    let used = 0;
    for (const id of ids) {
      const uh = h.get(id) ?? 0;
      if (cur.length && used + uh > contentHeightPx) { next.push(cur); cur = []; used = 0; }
      cur.push(id);
      used += uh;
    }
    if (cur.length || !next.length) next.push(cur);

    setPages((prev) => {
      if (JSON.stringify(prev) === JSON.stringify(next)) return prev;
      const a = document.activeElement as HTMLElement | null;
      if (a?.dataset.editId && pagesRef.current?.contains(a)) {
        restore.current = { editId: a.dataset.editId, offset: caretOffset(a) ?? 0 };
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, contentHeightPx]);

  useLayoutEffect(() => {
    const r = restore.current;
    if (!r) return;
    restore.current = null;
    // Only when the move actually DROPPED focus (the element was remounted
    // and the browser fell back to <body>). If focus is already somewhere
    // else, it was put there on purpose — a new paragraph after Enter — and
    // must not be pulled back.
    const lost = !document.activeElement || document.activeElement === document.body;
    if (!lost) return;
    const el = pagesRef.current?.querySelector<HTMLElement>(`[data-edit-id="${CSS.escape(r.editId)}"]`);
    if (el) { el.focus(); setCaret(el, r.offset); }
  }, [pages]);

  return { pages, measureRef, pagesRef };
}

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

/** A saved letter, as the renderer wants it — for the preview route. */
export function docFromApi(l: EngagementLetter): EngagementDoc {
  const rs = (l.recipient_snapshot ?? {}) as Partial<Recipient>;
  const cfg = (l.layout_config ?? {}) as { company?: Partial<CompanyInfo> };
  return {
    letterDate: l.letter_date,
    subject: l.subject,
    financialYear: l.financial_year ?? '',
    effectiveFrom: l.effective_from ?? '',
    effectiveUntil: l.effective_until ?? '',
    company: { ...ENGAGEMENT_COMPANY, ...(cfg.company ?? {}) },
    recipient: { ...EMPTY_RECIPIENT, companyName: l.party_name ?? '', ...rs },
    blocks: normalizeBlocks((l.block_config as unknown as EBlock[] | null) ?? []),
    fees: l.fee_items.map((f, i) => ({
      key: f.id ?? String(i),
      service: f.service,
      description: f.description ?? '',
      frequency: f.frequency ?? '',
      amountPaise: f.amount_paise,
      billingBasis: f.billing_basis ?? '',
      notes: f.notes ?? '',
    })),
    signatoryName: l.signatory_name ?? '',
    signatoryDesignation: l.signatory_designation ?? '',
    clientSignatoryName: l.client_signatory_name ?? '',
    clientSignatoryDesignation: l.client_signatory_designation ?? '',
    layout: layoutOf(l.layout_config),
  };
}
