import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Copy, Minus, MoveVertical, Plus, Trash2 } from 'lucide-react';
import {
  LINE_HEIGHT, SPACE_MAX_PX, SPACE_MIN_PX, SPACE_STEP_PX, clampSpace, pageGeometry,
  type CompanyInfo, type LayoutConfig,
} from '@/modules/workstation/quotations/document';
import {
  capsName, defaultBlocks, EMPTY_RECIPIENT, ENGAGEMENT_COMPANY, fmtDate, fmtLong, layoutOf, lineIsEmpty, normalizeBlocks, rupees,
  type EBlock, type FeeLine, type Line, type Recipient, type TableSpec,
} from '@/modules/workstation/engagement/document';
import {
  BASELINE_K, FONT_STACK, PAGE_PT, pitchOf, skinOf, type HeadLine, type WordSkin,
} from '@/modules/workstation/engagement/templates';
import { caretOffset, setCaret } from '@/modules/workstation/engagement/richtext';
import type { EngagementLetter } from '@/modules/workstation/engagement/api';
import { DateField, PlainField, RichLine } from './Editable';
import { footerReservePx, unitHeights } from '@/modules/workstation/paginate';

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
 *
 * A letter made from one of the firm's Word templates (templates.ts) is drawn
 * in that template's WORD SKIN instead: its own page geometry, fonts, line
 * pitch, letterhead and "1 | Page" footer, all in points as Word sets them, so
 * the page matches the original sheet for sheet. Page breaks there are the
 * template's own; a page only overflows onto the next when edits make it so.
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
  /** Which template the letter was made from — selects the Word skin. */
  templateId: string;
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
const REMOVABLE = new Set(['paragraph', 'section', 'spacer', 'table']);

interface Unit { id: string; blockId: string; first: boolean; node: (live: boolean) => ReactNode; pageBreak?: boolean }

/** Points → CSS pixels. */
const PT = 96 / 72;

export function EngagementDocument({ doc, scale, edit }: {
  doc: EngagementDoc;
  scale?: number;
  /** Present → the page is directly editable. */
  edit?: EditApi;
}) {
  const geo = pageGeometry(doc.layout);
  const skin = skinOf(doc.templateId);
  const vars = varsOf(doc);
  const editing = Boolean(edit);
  const blocks = doc.blocks.filter((b) => b.enabled);
  const units = blocks.flatMap((b) => unitsOf(b, doc, vars, edit, skin));
  const ids = units.map((u) => u.id);
  const breaks = new Set(units.filter((u) => u.pageBreak).map((u) => u.id));
  const letterhead = blocks.find((b) => b.key === 'letterhead');

  const signature = JSON.stringify({ ids, doc, editing });
  const { pages, measureRef, pagesRef } = usePages(ids, signature, {
    breaks,
    byBox: Boolean(skin),
    room: (page, root) => (skin
      ? (skin.bottom - skin.top[page === 0 ? 0 : 1]) * PT
      : geo.contentHeightPx - footerReservePx(root)),
  });
  const scaled = Boolean(scale) && scale !== 1;
  const { stackRef, naturalHeight } = useNaturalHeight();
  const blockIndex = new Map(doc.blocks.map((b, i) => [b.id, i]));

  const stack = (
    <div
      ref={stackRef}
      className={`qdoc-stack ${editing ? 'el-editing' : ''} ${skin ? 'el-word' : ''}`}
      data-edit-surface={editing ? SURFACE : undefined}
      style={{
        ...(skin ? {
          fontFamily: FONT_STACK.times,
          ['--qd-font-size' as string]: `${skin.size}pt`,
          ['--qd-line-height' as string]: `${skin.pitch}pt`,
          ...(skin.company ? {
            ['--el-company-size' as string]: `${skin.company.size}pt`,
            ['--el-company-color' as string]: skin.company.color,
          } : {}),
        } : {
          fontFamily: doc.layout.font === 'serif' ? 'Georgia, "Times New Roman", serif' : 'Arial, Helvetica, sans-serif',
          ['--qd-font-size' as string]: `${doc.layout.fontSize}pt`,
          ['--qd-line-height' as string]: String(LINE_HEIGHT[doc.layout.lineHeight] ?? 1.55),
          ['--el-h' as string]: HEADING_EM[doc.layout.headingSize] ?? '1.08em',
        }),
        transform: scaled ? `scale(${scale})` : undefined,
        transformOrigin: 'top center',
      }}
    >
      <div ref={measureRef} aria-hidden className="qdoc-measure"
        style={{ width: skin ? `${PAGE_PT.w - skin.margin * 2}pt` : `${geo.widthPx - geo.marginPx * 2}px` }}>
        {units.map((u) => <div key={u.id} data-unit={u.id}>{u.node(false)}</div>)}
      </div>

      <div ref={pagesRef} className="contents">
        {pages.map((pageIds, i) => (
          <section
            key={i}
            className={`qdoc-page ${skin ? 'el-word-page' : ''}`}
            style={skin
              ? { width: '210mm', height: '297mm', padding: `${skin.top[i === 0 ? 0 : 1]}pt ${skin.margin}pt 0` }
              : { width: `${geo.widthMm}mm`, minHeight: `${geo.heightMm}mm`, padding: `${geo.marginMm}mm` }}
          >
            {skin && letterhead && (i === 0 || skin.letterhead.repeat) ? (
              <WordLetterhead skin={skin} company={doc.company} edit={i === 0 ? edit : undefined} />
            ) : null}
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
            {skin ? <WordFooter skin={skin} page={i + 1} /> : doc.layout.footerStyle === 'none' ? null : (
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
    company_name_caps: capsName(doc.recipient.companyName),
    financial_year: doc.financialYear,
    effective_from: fmtLong(doc.effectiveFrom),
    effective_until: fmtLong(doc.effectiveUntil),
    firm_name: doc.company.name,
  };
}

// ── Block controls in the page margin ─────────────────────────────────────

const gbtn = 'h-6 w-6 inline-flex items-center justify-center rounded border border-neutral-300 bg-white text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50 disabled:opacity-30';

function Gutter({ b, edit, isFirst, isLast }: { b: EBlock; edit: EditApi; isFirst: boolean; isLast: boolean }) {
  if (b.key === 'spacer' || b.key === 'pagebreak') return null; // these carry their own controls
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

/** Width of an inline lead-in marker (the EPR notes' bullet and its gap), in points. */
const LEAD_IN_PT = 9.4;

/** One paragraph or list item, with its marker. `n` numbers a numbered item. */
export function LineView({ b, l, n, vars, edit, live, placeholder, surface = SURFACE, skin }: {
  b: EBlock; l: Line; n: number; vars: Record<string, string>; edit?: EditApi; live: boolean; placeholder?: string;
  /** Which editor this copy of the line belongs to — the page, or the left panel. */
  surface?: string;
  /** Present → set the line as its Word template does. */
  skin?: WordSkin | null;
}) {
  if (skin) return <WordLineView b={b} l={l} n={n} vars={vars} edit={edit} live={live} placeholder={placeholder} surface={surface} skin={skin} />;
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

/**
 * A line in a Word template: its own size, line pitch and space after, in
 * points. A list marker hangs `listIndent` in from the text column; a plain
 * paragraph's marker is a lead-in on its first line, the rest wrapping to the
 * margin — both as the originals set them.
 */
function WordLineView({ b, l, n, vars, edit, live, placeholder, surface, skin }: {
  b: EBlock; l: Line; n: number; vars: Record<string, string>; edit?: EditApi; live: boolean; placeholder?: string;
  surface: string; skin: WordSkin;
}) {
  const pitch = pitchOf(skin, l.size);
  const list = l.kind !== 'p';
  const lead = !list && l.marker ? l.marker : '';
  const body = (
    <RichLine
      live={live && Boolean(edit)}
      editId={`${surface}:${l.id}`}
      syncKey={l.id}
      html={l.html}
      vars={vars}
      placeholder={placeholder}
      style={{ textAlign: l.align, margin: 0, flex: list ? 1 : undefined, textIndent: lead ? `${LEAD_IN_PT}pt` : undefined }}
      dataAttrs={{ block: b.id, line: l.id }}
      onChange={(html) => edit?.line(b.id, l.id, { html })}
      onKeyDown={(e, el) => edit?.lineKey(e, el, b.id, l, surface)}
      onPasteText={(t, el) => edit?.pasteLines(t, el, b.id, l.id, surface)}
    />
  );
  const box = {
    fontSize: l.size ? `${l.size}pt` : undefined,
    lineHeight: `${pitch}pt`,
    margin: `0 0 ${l.after ?? skin.blank}pt`,
    paddingLeft: `${(l.pad ?? 0) + l.indent * skin.listIndent + (list ? skin.listIndent : 0)}pt`,
  };
  if (!list) {
    return (
      <div style={{ ...box, position: lead ? 'relative' : undefined }}>
        {lead ? <span aria-hidden className="el-lead" style={{ left: `${l.pad ?? 0}pt` }}>{lead}</span> : null}
        {body}
      </div>
    );
  }
  return (
    <div style={{ ...box, display: 'flex' }}>
      <span style={{ flex: 'none', width: `${skin.markerWidth}pt` }} aria-hidden>
        {l.marker ?? (l.kind === 'bullet' ? '•' : `${n}.`)}
      </span>
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

function unitsOf(b: EBlock, doc: EngagementDoc, vars: Record<string, string>, edit: EditApi | undefined, skin: WordSkin | null): Unit[] {
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
            placeholder={i === 0 ? placeholder : undefined} skin={skin} />
        </>
      ),
    }));
  };

  if (skin) {
    const w = wordUnits(b, doc, edit, skin, one, lineUnits);
    if (w) return w;
  }

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

    case 'pagebreak':
      return [{ id: `${b.id}:0`, blockId: b.id, first: true, pageBreak: true, node: (lv) => <PageBreakMark b={b} edit={lv ? edit : undefined} /> }];

    case 'table':
      return b.table ? one((lv) => <TableView b={b} t={b.table!} vars={vars} edit={edit} live={live(lv)} skin={skin} />) : [];

    default:
      return [];
  }
}

// ── Word templates: the structured blocks ─────────────────────────────────

/**
 * Rows set on a fixed grid, as Word sets consecutive short paragraphs: each
 * row is `pitch` tall with `gap` after it. Drawn as line boxes one full row
 * (pitch + gap) tall, the block is lifted by half a gap so every row's text
 * lands exactly where the pitch-and-gap row would put it; `after` is the space
 * after the last row, as for any line. `extra` adds space below one row.
 */
function WordRows({ skin, after, rows, style }: {
  skin: WordSkin;
  after?: number;
  rows: { key: string; node: ReactNode; extra?: number; style?: CSSProperties }[];
  style?: CSSProperties;
}) {
  const row = skin.pitch + skin.gap;
  return (
    <div style={{ lineHeight: `${row}pt`, marginTop: `${-skin.gap / 2}pt`, marginBottom: `${(after ?? skin.blank) - skin.gap / 2}pt`, ...style }}>
      {rows.map((r) => (
        <div key={r.key} style={{ marginBottom: r.extra ? `${r.extra}pt` : undefined, ...r.style }}>{r.node}</div>
      ))}
    </div>
  );
}

/** The client company in a Word template's own size and ink, where it has one. */
const COMPANY_STYLE: CSSProperties = { fontSize: 'var(--el-company-size, inherit)', color: 'var(--el-company-color, inherit)' };

function wordUnits(
  b: EBlock, doc: EngagementDoc, edit: EditApi | undefined, skin: WordSkin,
  one: (node: (live: boolean) => ReactNode) => Unit[],
  lineUnits: (lines: Line[], head?: (live: boolean) => ReactNode, placeholder?: string) => Unit[],
): Unit[] | null {
  const editing = Boolean(edit);
  const live = (l: boolean) => l && editing;
  const pitchRow = { lineHeight: `${skin.pitch}pt` };
  const head = (lv: boolean) => (editing || b.title?.trim()) ? (
    <div style={{ ...pitchRow, fontWeight: 700, textDecoration: 'underline', margin: `0 0 ${skin.gap}pt` }} className="el-word-h">
      <PlainField live={live(lv)} editId={`${SURFACE}:title:${b.id}`} value={b.title ?? ''} placeholder="Section heading"
        onChange={(v) => edit?.block(b.id, { title: v })} />
    </div>
  ) : null;

  switch (b.key) {
    // Drawn in the page header by WordLetterhead, not in the flow.
    case 'letterhead':
      return [];

    case 'date':
      return one((lv) => (
        <WordRows skin={skin} after={b.afterPt} style={{ textAlign: 'right', fontWeight: b.bold ? 700 : undefined }} rows={[
          { key: 'd', node: <DateField live={live(lv)} value={doc.letterDate} display={fmtDate(doc.letterDate, b.dateFormat)}
            onChange={(v) => edit?.field('letterDate', v)} /> },
          ...(b.place ? [{ key: 'p', node: (
            <PlainField live={live(lv)} editId={`${SURFACE}:place:${b.id}`} value={b.place ?? ''} placeholder="Place"
              onChange={(v) => edit?.block(b.id, { place: v })} />
          ) }] : []),
        ]} />
      ));

    case 'recipient': {
      const r = doc.recipient;
      const f = (k: keyof Recipient, lv: boolean, ph: string, multiline = false) => (
        <PlainField live={live(lv)} editId={`${SURFACE}:rc:${k}`} value={r[k]} placeholder={ph} multiline={multiline}
          onChange={(v) => edit?.recipient(k, v)} />
      );
      const tail = [r.city, r.state].filter(Boolean).join(', ') + (r.pincode ? ` – ${r.pincode}` : '');
      return one((lv) => (
        <WordRows skin={skin} after={b.afterPt} rows={[
          { key: 'to', node: <PlainField live={live(lv)} editId={`${SURFACE}:lbl:${b.id}`} value={b.body ?? ''} fallback="To"
            onChange={(v) => edit?.block(b.id, { body: v })} /> },
          // Only filled-in fields take a row — on the page being edited too, or
          // an empty field would push the letter onto another page. Empty ones
          // are filled from Details on the left.
          ...((['name', 'designation', 'companyName'] as const)
            .filter((k) => r[k])
            .map((k) => ({ key: k, node: f(k, lv, k === 'name' ? 'Contact person' : k === 'designation' ? 'Designation' : 'Company name'),
              style: k === 'companyName' ? COMPANY_STYLE : undefined }))),
          ...(r.address ? [{ key: 'address', node: f('address', lv, 'Address', true) }] : []),
          ...(tail ? [{ key: 'tail', node: editing ? (
            <>
              {r.city ? f('city', lv, 'City') : null}{r.city && r.state ? ', ' : null}{r.state ? f('state', lv, 'State') : null}
              {r.pincode ? <>{' – '}{f('pincode', lv, 'PIN')}</> : null}
            </>
          ) : tail }] : []),
        ]} />
      ));
    }

    case 'subject':
      return one((lv) => (
        <div style={{ ...pitchRow, textAlign: 'center', margin: `0 0 ${b.afterPt ?? skin.blank}pt` }}>
          <PlainField live={live(lv)} editId={`${SURFACE}:lbl:${b.id}`} value={b.body ?? ''} fallback="Sub:"
            onChange={(v) => edit?.block(b.id, { body: v })} />{' '}
          <PlainField live={live(lv)} editId={`${SURFACE}:subject`} value={doc.subject} placeholder="Subject"
            onChange={(v) => edit?.field('subject', v)} />
        </div>
      ));

    case 'salutation':
      return one((lv) => (
        <div style={{ ...pitchRow, margin: `0 0 ${b.afterPt ?? skin.blank}pt` }}>
          <PlainField live={live(lv)} editId={`${SURFACE}:sal:${b.id}`} value={b.body ?? ''} placeholder="Dear Sir,"
            onChange={(v) => edit?.block(b.id, { body: v })} />
        </div>
      ));

    case 'section':
      return lineUnits(b.lines ?? [], head, b.hint ?? 'Type here…');

    case 'fees': {
      // The note under the fees only exists once it has words: an empty
      // placeholder line would take room the original page does not have.
      const note = (b.lines ?? []).filter((l) => !lineIsEmpty(l));
      const rows: Unit[] = doc.fees.map((fee, i) => {
        const last = i === doc.fees.length - 1;
        const after = !last || note.length ? skin.gap : (b.afterPt ?? skin.blank);
        return {
          id: `${b.id}:fee:${fee.key}`, blockId: b.id, first: i === 0,
          node: (lv: boolean) => (
            <>
              {i === 0 && b.title?.trim() ? head(lv) : null}
              <WordFeeRow f={fee} edit={edit} live={live(lv)} isFirst={i === 0} isLast={last} style={{ ...pitchRow, margin: `0 0 ${after}pt` }} />
            </>
          ),
        };
      });
      if (!doc.fees.length && editing) {
        rows.push({
          id: `${b.id}:addfee`, blockId: b.id, first: true,
          node: (lv: boolean) => (
            <>
              {head(lv)}
              <div className="qdoc-screen-only relative h-0">
                <button type="button" className="el-addfee absolute left-0 top-0" onMouseDown={(e) => e.preventDefault()} onClick={() => edit?.addFee(SURFACE)}>
                  + Add fee
                </button>
              </div>
            </>
          ),
        });
      }
      return [...rows, ...lineUnits(note).map((u) => ({ ...u, first: false }))];
    }

    case 'signature':
      return one((lv) => (
        <div style={{ marginBottom: `${(b.afterPt ?? skin.blank) - (b.rule ? 0 : skin.gap / 2)}pt` }}>
          <WordRows skin={skin} style={{ marginBottom: 0 }} rows={[
            { key: 'l', extra: (b.gapPt ?? skin.pitch * 2 + skin.gap * 3) - skin.gap, node: (
              <PlainField live={live(lv)} editId={`${SURFACE}:lbl:${b.id}`} value={b.body ?? ''} fallback="Yours truly,"
                onChange={(v) => edit?.block(b.id, { body: v })} />
            ) },
            { key: 'n', node: <PlainField live={live(lv)} editId={`${SURFACE}:sig:name`} value={doc.signatoryName}
              placeholder="Signatory name" onChange={(v) => edit?.field('signatoryName', v)} /> },
            { key: 'd', node: <PlainField live={live(lv)} editId={`${SURFACE}:sig:des`} value={doc.signatoryDesignation}
              placeholder="Designation" onChange={(v) => edit?.field('signatoryDesignation', v)} /> },
            { key: 'f', node: <PlainField live={live(lv)} editId={`${SURFACE}:sig:firm`} value={doc.company.name}
              placeholder="Firm name" onChange={(v) => edit?.company('name', v)} /> },
          ]} />
          {b.rule ? (
            // Word's bottom border on the firm-name paragraph: a little wider than the text column.
            <div aria-hidden style={{ marginTop: `${(b.ruleGapPt ?? 1.2) - skin.gap / 2}pt`, marginLeft: '-1.4pt', marginRight: '-1.6pt', borderTop: '1.5pt solid #000' }} />
          ) : null}
        </div>
      ));

    case 'confirmation': {
      const who = doc.clientSignatoryName || doc.recipient.name;
      const role = doc.clientSignatoryDesignation || doc.recipient.designation;
      const company = b.showCompany === false ? '' : doc.recipient.companyName;
      return one((lv) => (
        <WordRows skin={skin} after={b.afterPt ?? 0} rows={[
          { key: 't', extra: 2 * (skin.pitch + skin.gap), node: (
            <PlainField live={live(lv)} editId={`${SURFACE}:conf:${b.id}`} value={b.body ?? ''}
              fallback="The above terms and conditions are agreed and confirmed by;" onChange={(v) => edit?.block(b.id, { body: v })} />
          ) },
          { key: 'u', node: <PlainField live={live(lv)} editId={`${SURFACE}:conf:line:${b.id}`} value={b.title ?? ''}
            fallback="______________________" onChange={(v) => edit?.block(b.id, { title: v })} /> },
          ...(who ? [{ key: 'n', node: (
            <PlainField live={live(lv)} editId={`${SURFACE}:conf:name`} value={doc.clientSignatoryName}
              fallback={doc.recipient.name} placeholder="Client name" onChange={(v) => edit?.field('clientSignatoryName', v)} />
          ) }] : []),
          ...(role ? [{ key: 'd', node: (
            <PlainField live={live(lv)} editId={`${SURFACE}:conf:des`} value={doc.clientSignatoryDesignation}
              fallback={doc.recipient.designation} placeholder="Client designation" onChange={(v) => edit?.field('clientSignatoryDesignation', v)} />
          ) }] : []),
          ...(company ? [{ key: 'c', node: company, style: COMPANY_STYLE }] : []),
        ]} />
      ));
    }

    default:
      return null;
  }
}

/** A fee as the Word letters write it: "Service – Rs. 2,000 per month [basis]". */
function WordFeeRow({ f, edit, live, isFirst, isLast, style }: {
  f: EngagementFee; edit?: EditApi; live: boolean; isFirst: boolean; isLast: boolean; style: CSSProperties;
}) {
  const pf = (k: 'service' | 'frequency' | 'billingBasis', ph: string, v: string) => (
    <PlainField live={live} editId={`${SURFACE}:fee:${f.key}:${k}`} value={v} placeholder={ph}
      onChange={(x) => edit?.fee(f.key, { [k]: x })} />
  );
  const amount = live ? (
    <PlainField
      live editId={`${SURFACE}:fee:${f.key}:amount`}
      value={f.amountText ?? (f.amountPaise / 100).toLocaleString('en-IN')}
      placeholder="0"
      onChange={(x) => edit?.fee(f.key, { amountText: x })}
      onBlurValue={(x) => {
        const n = Number(x.replace(/[^0-9.]/g, ''));
        if (Number.isFinite(n) && x.trim()) edit?.fee(f.key, { amountText: n.toLocaleString('en-IN') });
      }}
    />
  ) : (f.amountPaise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return (
    <div className={live ? 'el-feerow relative' : undefined} style={style}>
      {live && edit ? (
        <div className="el-gutter qdoc-screen-only" onMouseDown={(e) => e.preventDefault()}>
          <button type="button" className={gbtn} disabled={isFirst} title="Move up" onClick={() => edit.feeOp(f.key, 'up')}><ArrowUp size={12} /></button>
          <button type="button" className={gbtn} disabled={isLast} title="Move down" onClick={() => edit.feeOp(f.key, 'down')}><ArrowDown size={12} /></button>
          <button type="button" className={gbtn} title="Duplicate" onClick={() => edit.feeOp(f.key, 'dup')}><Copy size={12} /></button>
          <button type="button" className={gbtn} title="Delete fee" onClick={() => edit.feeOp(f.key, 'del')}><Trash2 size={12} /></button>
        </div>
      ) : null}
      {pf('service', 'Service', f.service)} – Rs. {amount}
      {/* Only what is filled in, while editing too — a hint here would widen the line. */}
      {f.frequency ? <> {pf('frequency', 'per month', f.frequency)}</> : null}
      {f.billingBasis ? <> [{pf('billingBasis', 'basis', f.billingBasis)}]</> : null}
    </div>
  );
}

/** The Word templates' letterhead, in the page header: each line on its measured baseline. */
function WordLetterhead({ skin, company: c, edit }: { skin: WordSkin; company: CompanyInfo; edit?: EditApi }) {
  const live = Boolean(edit);
  const part = (k: keyof CompanyInfo, ph: string) => (
    <PlainField live={live} editId={`${SURFACE}:co:${k}`} value={c[k]} placeholder={ph} onChange={(v) => edit?.company(k, v)} />
  );
  const { name, addr } = skin.letterhead;
  return (
    <div className="el-word-head">
      <HeadText h={name} upper>{part('name', 'Firm name')}</HeadText>
      <HeadText h={addr[0]} upper>{part('addressLine1', 'Address')},</HeadText>
      <HeadText h={addr[1]} upper>
        {part('addressLine2', 'Area')}, {part('city', 'City')}, {part('state', 'State')} – {part('pin', 'PIN')}
      </HeadText>
      <HeadText h={addr[2]}>{part('phone', 'Phone')}, {part('email', 'Email')}</HeadText>
    </div>
  );
}

function HeadText({ h, upper, children }: { h: HeadLine; upper?: boolean; children: ReactNode }) {
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, top: `${h.baseline - h.size * BASELINE_K[h.font]}pt`,
      textAlign: 'center', whiteSpace: 'nowrap',
      fontFamily: FONT_STACK[h.font], fontSize: `${h.size}pt`, lineHeight: `${h.size}pt`,
      fontWeight: h.bold ? 700 : 400, color: h.color,
      textTransform: upper ? 'uppercase' : undefined,
    }}>
      {children}
    </div>
  );
}

/** "1 | Page" over a hairline, in the bottom margin — the Word footer. */
function WordFooter({ skin, page }: { skin: WordSkin; page: number }) {
  return (
    <>
      <div aria-hidden style={{ position: 'absolute', top: '778.4pt', left: `${skin.margin - 1.4}pt`, right: `${skin.margin - 1.6}pt`, borderTop: '0.5pt solid #d9d9d9' }} />
      <div style={{
        position: 'absolute', left: `${skin.margin}pt`, top: `${skin.footer.baseline - 11 * BASELINE_K.calibri}pt`,
        fontFamily: FONT_STACK.calibri, fontSize: '11pt', lineHeight: '11pt', whiteSpace: 'pre', color: '#000',
      }}>
        <span style={{ fontWeight: skin.footer.spaced ? 700 : 400 }}>{page}</span>
        <span style={{ fontWeight: 700 }}> | </span>
        <span style={{ color: '#7f7f7f', letterSpacing: skin.footer.spaced ? '2.9pt' : undefined }}>Page</span>
      </div>
    </>
  );
}

// ── Page break and table ──────────────────────────────────────────────────

/** A page break: nothing on paper; in the editor, a marker that can be removed. */
function PageBreakMark({ b, edit }: { b: EBlock; edit?: EditApi }) {
  if (!edit) return null;
  return (
    <div className="qdoc-screen-only relative h-0">
      <div className="el-pagebreak" onMouseDown={(e) => e.preventDefault()}>
        <span>Page break</span>
        <button type="button" className={gbtn} title="Remove this page break" onClick={() => edit.removeBlock(b.id)}><Trash2 size={12} /></button>
      </div>
    </div>
  );
}

/** A table of editable cells, on the measured column widths and row heights. */
function TableView({ b, t, vars, edit, live, skin }: {
  b: EBlock; t: TableSpec; vars: Record<string, string>; edit?: EditApi; live: boolean; skin: WordSkin | null;
}) {
  const unit = skin ? 'pt' : 'px';
  const pad = (c: number) => `${t.pad?.[c] ?? 4.7}${unit}`;
  const setCell = (r: number, c: number, html: string) => {
    if (r < 0) {
      const head = t.head.map((h, i) => (i === c ? html : h));
      edit?.block(b.id, { table: { ...t, head } });
      return;
    }
    const rows = t.rows.map((row, ri) => (ri === r ? row.map((x, ci) => (ci === c ? { ...x, html } : x)) : row));
    edit?.block(b.id, { table: { ...t, rows } });
  };
  const cellText = (r: number, c: number, html: string, align?: CSSProperties['textAlign']) => (
    <RichLine
      live={live}
      editId={`${SURFACE}:cell:${b.id}:${r}:${c}`}
      syncKey={`${b.id}:${r}:${c}`}
      html={html}
      vars={vars}
      style={{ margin: 0, textAlign: align }}
      onChange={(h) => setCell(r, c, h)}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertLineBreak'); } }}
    />
  );
  return (
    <table className="el-table" style={{
      borderCollapse: 'collapse', tableLayout: 'fixed', width: `${t.cols.reduce((a, w) => a + w, 0)}${unit}`,
      marginBottom: `${b.afterPt ?? skin?.blank ?? 12}${unit}`,
      lineHeight: skin ? `${skin.pitch}pt` : undefined,
    }}>
      <colgroup>{t.cols.map((w, i) => <col key={i} style={{ width: `${w}${unit}` }} />)}</colgroup>
      <tbody>
        {t.head.length ? (
          <tr style={{ height: `${t.heights[0] ?? 0}${unit}` }}>
            {t.head.map((h, c) => (
              <td key={c} style={{ padding: `0 ${pad(c)}`, verticalAlign: 'middle' }}>{cellText(-1, c, h, 'center')}</td>
            ))}
          </tr>
        ) : null}
        {t.rows.map((row, r) => (
          <tr key={r} style={{ height: `${t.heights[r + (t.head.length ? 1 : 0)] ?? 0}${unit}` }}>
            {row.map((x, c) => (
              <td key={c} style={{
                padding: `${x.padTop ?? 0}${unit} 0 0 ${pad(c)}`,
                verticalAlign: x.valign ?? 'middle',
              }}>
                {cellText(r, c, x.html)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
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
 *
 * A page-break unit closes its page (two in a row leave a blank sheet, as in
 * Word). `room` may differ per page — a Word template's first page starts
 * lower, under the letterhead. With `byBox`, a unit fits when its own box
 * does: the space after the last line on a page is not paper it needs, which
 * is how Word decides it too.
 */
function usePages(ids: string[], signature: string, opts: {
  breaks: Set<string>;
  byBox: boolean;
  room: (page: number, pagesRoot: HTMLElement | null) => number;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<string[][]>([ids]);
  const restore = useRef<{ editId: string; offset: number } | null>(null);
  // Web fonts arrive after the first layout; every line re-wraps when they
  // do, so the page breaks must be measured again.
  const [fontsLoaded, setFontsLoaded] = useState(0);
  useLayoutEffect(() => {
    const f = document.fonts;
    if (!f) return;
    const bump = () => setFontsLoaded((n) => n + 1);
    f.addEventListener('loadingdone', bump);
    void f.ready.then(bump);
    return () => f.removeEventListener('loadingdone', bump);
  }, []);

  useLayoutEffect(() => {
    const root = measureRef.current;
    if (!root) return;
    const h = unitHeights(root, 'unit');
    const box = new Map<string, number>();
    root.querySelectorAll<HTMLElement>('[data-unit]').forEach((el) => box.set(el.dataset.unit!, el.offsetHeight));
    const next: string[][] = [];
    let cur: string[] = [];
    let used = 0;
    let room = opts.room(0, pagesRef.current);
    const close = () => { next.push(cur); cur = []; used = 0; room = opts.room(next.length, pagesRef.current); };
    for (const id of ids) {
      const step = h.get(id) ?? 0;
      const need = opts.byBox ? (box.get(id) ?? step) : step;
      // A page break never moves: it ends the page it follows, however full.
      if (!opts.breaks.has(id) && cur.length && used + need > room + (opts.byBox ? 0.5 : 0)) close();
      cur.push(id);
      used += step;
      if (opts.breaks.has(id)) close();
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
  }, [signature, fontsLoaded]);

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
    templateId: l.template_id ?? 'jns-accounting',
    letterDate: l.letter_date,
    subject: l.subject,
    financialYear: l.financial_year ?? '',
    effectiveFrom: l.effective_from ?? '',
    effectiveUntil: l.effective_until ?? '',
    company: { ...ENGAGEMENT_COMPANY, ...(cfg.company ?? {}) },
    recipient: { ...EMPTY_RECIPIENT, companyName: l.party_name ?? '', ...rs },
    // A letter saved without a composition shows the builder's template, as the PDF does.
    blocks: normalizeBlocks(l.block_config?.length ? (l.block_config as unknown as EBlock[]) : defaultBlocks()),
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
