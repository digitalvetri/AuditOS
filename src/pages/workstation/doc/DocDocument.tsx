import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Minus, MoveVertical, Plus, Trash2 } from 'lucide-react';
import {
  LINE_HEIGHT, SPACE_MAX_PX, SPACE_MIN_PX, SPACE_STEP_PX, clampSpace, pageGeometry,
  type LayoutConfig,
} from '@/modules/workstation/quotations/document';
import { caretOffset, setCaret } from '@/modules/workstation/engagement/richtext';
import {
  companyHeaderOf, fill, fmtLong, lineIsEmpty, type DBlock, type KVRow, type Line, type Person,
} from '@/modules/workstation/docs/model';
import { CompanyHeaderBlock } from './CompanyHeader';
import { DateField, PlainField, RichLine } from '@/pages/workstation/engagement/Editable';

/**
 * THE A4 DOCUMENT — rendered, and (given `edit`) edited in place.
 *
 * One renderer for all thirteen document types: they share a block
 * vocabulary, and a type is a list of blocks, so there is nothing here that
 * knows what a consent letter is. The same component is the builder's page,
 * the preview route and what the browser prints; without `edit` it is
 * read-only.
 *
 * Paginates by UNIT — a heading travels with its first line, every further
 * paragraph, clause and signature row is its own unit — packing them into A4
 * pages against a static twin measured off-screen. Units never split, so a
 * paragraph too long for the room left moves whole to the next page, exactly
 * as it does in the PDF.
 */

export interface DocModel {
  docDate: string;
  /** Field values, already resolved — what {{placeholders}} substitute. */
  vars: Record<string, string>;
  blocks: DBlock[];
  layout: LayoutConfig;
}

export interface DocEditApi {
  block: (id: string, patch: Partial<DBlock>) => void;
  line: (blockId: string, lineId: string, patch: Partial<Line>) => void;
  lineKey: (e: KeyboardEvent<HTMLElement>, el: HTMLElement, blockId: string, line: Line, surface: string) => void;
  pasteLines: (text: string, el: HTMLElement, blockId: string, lineId: string, surface: string) => void;
  row: (blockId: string, rowId: string, patch: Partial<KVRow>) => void;
  person: (blockId: string, personId: string, patch: Partial<Person>) => void;
  docDate: (iso: string) => void;
  moveBlock: (id: string, by: -1 | 1) => void;
  removeBlock: (id: string) => void;
  addBlockAfter: (id: string, kind: 'paragraph' | 'spacer', surface: string) => void;
}

const SURFACE = 'doc';
/** What a user may delete from the page. The template's own spine stays. */
const REMOVABLE = new Set(['paragraph', 'section', 'keyvalue', 'signature', 'witness', 'spacer', 'pagebreak']);
const HEADING_EM: Record<LayoutConfig['headingSize'], string> = { compact: '1em', normal: '1.08em', large: '1.25em' };

interface Unit { id: string; blockId: string; first: boolean; node: (live: boolean) => ReactNode }

export function DocDocument({ doc, scale, edit }: { doc: DocModel; scale?: number; edit?: DocEditApi }) {
  const geo = pageGeometry(doc.layout);
  const editing = Boolean(edit);
  const blocks = doc.blocks.filter((b) => b.enabled !== false);
  // Optional company header: the first unit, so it is measured and paginated
  // like any block and the letter always starts below it.
  const header = companyHeaderOf(doc.layout);
  const units: Unit[] = [
    ...(header ? [{ id: 'company-header', blockId: '', first: false, node: () => <CompanyHeaderBlock header={header} /> }] : []),
    ...blocks.flatMap((b) => unitsOf(b, doc, edit)),
  ];
  const ids = units.map((u) => u.id);

  const signature = JSON.stringify({ ids, doc, editing });
  const { pages, measureRef, pagesRef } = usePages(ids, geo.contentHeightPx, signature, blocks);
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
                <span>
                  {doc.layout.footerStyle === 'company'
                    ? (doc.vars.company_name ?? doc.vars.firm_name ?? '')
                    : `Page ${i + 1} of ${pages.length}`}
                </span>
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

// ── Block controls in the page margin ─────────────────────────────────────

const gbtn = 'h-6 w-6 inline-flex items-center justify-center rounded border border-neutral-300 bg-white text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50 disabled:opacity-30';

function Gutter({ b, edit, isFirst, isLast }: { b: DBlock; edit: DocEditApi; isFirst: boolean; isLast: boolean }) {
  if (b.key === 'spacer') return null; // a space carries its own controls
  return (
    <div className="el-gutter qdoc-screen-only" onMouseDown={(e) => e.preventDefault()}>
      <button type="button" className={gbtn} disabled={isFirst} title="Move up" onClick={() => edit.moveBlock(b.id, -1)}><ArrowUp size={12} /></button>
      <button type="button" className={gbtn} disabled={isLast} title="Move down" onClick={() => edit.moveBlock(b.id, 1)}><ArrowDown size={12} /></button>
      <button type="button" className={gbtn} title="Add a paragraph below" onClick={() => edit.addBlockAfter(b.id, 'paragraph', SURFACE)}><Plus size={12} /></button>
      <button type="button" className={gbtn} title="Add space below" onClick={() => edit.addBlockAfter(b.id, 'spacer', SURFACE)}><MoveVertical size={12} /></button>
      {REMOVABLE.has(b.key) ? (
        <button type="button" className={gbtn} title="Delete" onClick={() => edit.removeBlock(b.id)}><Trash2 size={12} /></button>
      ) : null}
    </div>
  );
}

// ── Lines ─────────────────────────────────────────────────────────────────

/** One paragraph or list item, with its marker. */
export function DocLine({ b, l, n, vars, edit, live, placeholder, tight, surface = SURFACE }: {
  b: DBlock; l: Line; n: number; vars: Record<string, string>; edit?: DocEditApi; live: boolean;
  placeholder?: string; tight?: boolean; surface?: string;
}) {
  const body = (
    <RichLine
      live={live && Boolean(edit)}
      editId={`${surface}:${l.id}`}
      syncKey={l.id}
      html={l.html}
      vars={vars}
      placeholder={placeholder}
      style={{ textAlign: l.align, margin: 0, flex: l.kind === 'p' ? undefined : 1 }}
      dataAttrs={{ block: b.id, line: l.id }}
      onChange={(html) => edit?.line(b.id, l.id, { html })}
      onKeyDown={(e, el) => edit?.lineKey(e, el, b.id, l, surface)}
      onPasteText={(t, el) => edit?.pasteLines(t, el, b.id, l.id, surface)}
    />
  );
  const indent = l.indent * 24;
  if (l.kind === 'p') {
    return <div style={{ paddingLeft: indent, margin: tight ? '0' : '0 0 0.7em' }}>{body}</div>;
  }
  return (
    <div style={{ display: 'flex', gap: 8, paddingLeft: indent, margin: '0 0 0.3em' }}>
      <span style={{ flex: 'none', width: 18 }} aria-hidden>{l.kind === 'bullet' ? '•' : `${n}.`}</span>
      {body}
    </div>
  );
}

export function numbering(lines: Line[]): Map<string, number> {
  const m = new Map<string, number>();
  let n = 0;
  for (const l of lines) { n = l.kind === 'number' ? n + 1 : 0; m.set(l.id, n); }
  return m;
}

// ── Units ─────────────────────────────────────────────────────────────────

function unitsOf(b: DBlock, doc: DocModel, edit?: DocEditApi): Unit[] {
  const editing = Boolean(edit);
  const vars = doc.vars;
  const live = (l: boolean) => l && editing;
  const one = (node: (live: boolean) => ReactNode, suffix = '0'): Unit[] =>
    [{ id: `${b.id}:${suffix}`, blockId: b.id, first: true, node }];

  /** Editable plain text on the page — a heading, a label, a name. */
  const plain = (
    value: string, onChange: (v: string) => void, key: string,
    opts: { placeholder?: string; style?: React.CSSProperties; live: boolean; multiline?: boolean } ,
  ) => (
    <PlainField
      live={live(opts.live)}
      editId={`${SURFACE}:${b.id}:${key}`}
      value={fill(value ?? '', vars)}
      placeholder={opts.placeholder}
      multiline={opts.multiline}
      style={opts.style}
      onChange={onChange}
    />
  );

  const lineUnits = (lines: Line[], head?: (live: boolean) => ReactNode, tight?: boolean): Unit[] => {
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
          <DocLine b={b} l={l} n={nums.get(l.id) ?? 0} vars={vars} edit={edit} live={lv} tight={tight} />
        </>
      ),
    }));
  };

  switch (b.key) {
    case 'heading': {
      const size = b.variant === 'title' ? '1.3em' : 'var(--el-h, 1.08em)';
      return one((lv) => (
        <div style={{ margin: b.variant === 'title' ? '0 0 1.1em' : '0.9em 0 0.5em' }}>
          <div style={{ fontWeight: 700, fontSize: size, textAlign: b.align ?? 'center', lineHeight: 1.4 }}>
            {plain(b.title ?? '', (v) => edit?.block(b.id, { title: v }), 'title', { live: lv, placeholder: 'Heading', multiline: true })}
          </div>
          {b.variant === 'rule' ? <div style={{ borderBottom: '1px solid #9ca3af', marginTop: 8 }} /> : null}
        </div>
      ));
    }

    case 'date':
      return one((lv) => (
        <div style={{ textAlign: b.align ?? 'left', margin: '0 0 1em', fontWeight: 700 }}>
          {b.title ? `${b.title} ` : ''}
          <DateField
            live={live(lv)}
            value={doc.docDate}
            display={fmtLong(doc.docDate)}
            onChange={(iso) => edit?.docDate(iso)}
          />
        </div>
      ));

    case 'address':
      return lineUnits(b.lines ?? [], b.title ? (lv) => (
        <div style={{ margin: '0 0 0.2em' }}>
          {plain(b.title ?? '', (v) => edit?.block(b.id, { title: v }), 'title', { live: lv })}
        </div>
      ) : undefined, true);

    case 'subject':
      return one((lv) => (
        <div style={{ fontWeight: 700, textAlign: b.align ?? 'left', margin: '0.6em 0 1em' }}>
          {plain(b.title ?? '', (v) => edit?.block(b.id, { title: v }), 'title', { live: lv, placeholder: 'Subject', multiline: true })}
        </div>
      ));

    case 'paragraph':
      return lineUnits(b.lines ?? []);

    case 'section':
      return lineUnits(b.lines ?? [], (lv) => (
        <div style={{ fontWeight: 700, fontSize: 'var(--el-h, 1.08em)', margin: '0.9em 0 0.35em', textAlign: b.align ?? 'left' }}>
          {plain(b.title ?? '', (v) => edit?.block(b.id, { title: v }), 'title', { live: lv, placeholder: 'Section title' })}
        </div>
      ));

    case 'keyvalue': {
      const rows = b.rows ?? [];
      const head = (lv: boolean) => (b.title?.trim() ? (
        <div style={{ fontWeight: 700, margin: '1.2em 0 0.9em', textAlign: b.align ?? 'left' }}>
          {plain(b.title ?? '', (v) => edit?.block(b.id, { title: v }), 'title', { live: lv, placeholder: 'Details' })}
        </div>
      ) : null);
      if (!rows.length) return one(head, 'head');
      return rows.map((r, i) => ({
        id: `${b.id}:${r.id}`,
        blockId: b.id,
        first: i === 0,
        node: (lv: boolean) => (
          <>
            {i === 0 ? head(lv) : null}
            <div style={{ margin: '0 0 0.25em' }}>
              {plain(r.label, (v) => edit?.row(b.id, r.id, { label: v }), `${r.id}:l`, { live: lv, placeholder: 'Label' })}
              <span> – </span>
              <span style={{ fontWeight: 600 }}>
                {plain(r.value, (v) => edit?.row(b.id, r.id, { value: v }), `${r.id}:v`, { live: lv, placeholder: 'Value' })}
              </span>
            </div>
          </>
        ),
      }));
    }

    case 'signature': {
      const people = b.people ?? [];
      const cols = Math.max(1, Math.min(2, b.columns ?? 1));
      /** Labelled: 'Name: …' over 'DIN: …', laid out in a grid. */
      if (b.variant === 'named') {
        return one((lv) => (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: '1.8em 2em', margin: '1.6em 0 0.8em' }}>
            {people.map((p2) => (
              <div key={p2.id}>
                <div>Name: {plain(p2.name, (v) => edit?.person(b.id, p2.id, { name: v }), `${p2.id}:n`, { live: lv, placeholder: 'Name' })}</div>
                <div>DIN: {plain(p2.din, (v) => edit?.person(b.id, p2.id, { din: v }), `${p2.id}:d`, { live: lv, placeholder: '—' })}</div>
              </div>
            ))}
          </div>
        ));
      }
      /** Nothing but the spaces to sign — no printed name under them. */
      if (b.variant === 'upload') {
        return one((lv) => (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: '1em 2em', margin: '1.2em 0' }}>
            {people.map((p2) => (
              <SignatureSlot key={p2.id} p={p2} live={live(lv)} onPick={(d) => edit?.person(b.id, p2.id, { sign: d })} />
            ))}
          </div>
        ));
      }
      /** Signature / Name / Date / Place, one signatory under the next. */
      if (b.variant === 'stacked') {
        return one((lv) => (
          <div style={{ margin: '1.4em 0 0.8em' }}>
            {people.map((p2) => (
              <div key={p2.id} style={{ marginBottom: '1.8em', breakInside: 'avoid' }}>
                <div>Signature</div>
                <div style={{ marginTop: '2em' }}>
                  <span>Name: </span>
                  <span style={{ fontWeight: 700 }}>
                    {plain(p2.name, (v) => edit?.person(b.id, p2.id, { name: v }), `${p2.id}:n`, { live: lv, placeholder: 'Name' })}
                  </span>
                </div>
                <div>
                  <span>Date: </span>
                  <DateField live={live(lv)} value={doc.docDate} display={fmtLong(doc.docDate)} onChange={(iso) => edit?.docDate(iso)} />
                </div>
                <div>
                  <span>Place: </span>
                  {plain(p2.role, (v) => edit?.person(b.id, p2.id, { role: v }), `${p2.id}:p`, { live: lv, placeholder: 'Place' })}
                </div>
              </div>
            ))}
          </div>
        ));
      }
      return one((lv) => (
        <div style={{ margin: '1.4em 0 0.8em', breakInside: 'avoid' }}>
          {/* Only a title that EXISTS is shown: an empty one used to sit there
              as ghost placeholder text under the line above it. */}
          {b.title?.trim() ? (
            <div style={{ textAlign: b.align ?? 'left', marginBottom: '2.4em' }}>
              {plain(b.title, (v) => edit?.block(b.id, { title: v }), 'title', { live: lv })}
            </div>
          ) : <div style={{ height: '2.4em' }} />}
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: '1.6em 2em', textAlign: b.align ?? 'left' }}>
            {people.map((p) => (
              <div key={p.id}>
                {/* The company line shows only where a template sets one —
                    an empty one used to sit there as ghost placeholder text. */}
                {p.note?.trim() ? (
                  <div style={{ fontWeight: 700 }}>
                    {plain(p.note, (v) => edit?.person(b.id, p.id, { note: v }), `${p.id}:c`, { live: lv })}
                  </div>
                ) : null}
                {p.rule ? <div style={{ borderTop: '1px solid #111827', width: '62%', margin: '2.2em 0 0.4em' }} /> : null}
                <div style={{ fontWeight: 700 }}>
                  {plain(p.name, (v) => edit?.person(b.id, p.id, { name: v }), `${p.id}:n`, { live: lv, placeholder: 'Name' })}
                </div>
                {/* Only what the template actually sets is shown; an empty
                    designation or DIN is absent, not a ghost row. */}
                {p.role?.trim() ? (
                  <div>{plain(p.role, (v) => edit?.person(b.id, p.id, { role: v }), `${p.id}:r`, { live: lv })}</div>
                ) : null}
                {p.din?.trim() ? (
                  <div>
                    <span>DIN: </span>
                    {plain(p.din, (v) => edit?.person(b.id, p.id, { din: v }), `${p.id}:d`, { live: lv })}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ));
    }

    case 'witness': {
      const people = b.people ?? [];
      return one((lv) => (
        <div style={{ margin: '1.6em 0 0.6em', display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '2em', breakInside: 'avoid' }}>
          {people.slice(0, 2).map((p, i) => (
            <div key={p.id}>
              <div style={{ fontWeight: 700 }}>
                {plain(p.note || `Witness ${i + 1}:`, (v) => edit?.person(b.id, p.id, { note: v }), `${p.id}:w`, { live: lv })}
              </div>
              <div>{p.din ? `${p.din} ` : ''}Name: {plain(p.name, (v) => edit?.person(b.id, p.id, { name: v }), `${p.id}:n`, { live: lv, placeholder: '—' })}</div>
              <div>Address: {plain(p.role, (v) => edit?.person(b.id, p.id, { role: v }), `${p.id}:a`, { live: lv, placeholder: '—' })}</div>
              <div style={{ marginTop: '1.2em' }}>Signature:</div>
            </div>
          ))}
        </div>
      ));
    }

    case 'placedate':
      return one((lv) => (
        <div style={{ margin: '1em 0 0.6em', textAlign: b.align ?? 'left' }}>
          <div>Date: <DateField live={live(lv)} value={doc.docDate} display={fmtLong(doc.docDate)} onChange={(iso) => edit?.docDate(iso)} /></div>
          <div>Place: {plain(b.title ?? '', (v) => edit?.block(b.id, { title: v }), 'place', { live: lv, placeholder: 'Place' })}</div>
        </div>
      ));

    case 'pagebreak':
      return one(() => (
        <div className="qdoc-screen-only" style={{ borderTop: '1px dashed #9ca3af', margin: '1em 0', fontSize: '0.75em', color: '#6b7280' }}>
          Page break
        </div>
      ));

    case 'spacer':
      return one((lv) => (edit && lv ? <SpaceBlock b={b} edit={edit} /> : <div style={{ height: `${b.heightPx ?? 24}px` }} />));

    default:
      return [];
  }
}

/**
 * The space where a signature goes: the uploaded mark if there is one, an
 * empty rule if not. Clicking it while editing picks an image file; it is
 * kept in the document as a data URL, so print and PDF carry it too.
 */
function SignatureSlot({ p, live, onPick }: { p: Person; live: boolean; onPick: (d: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const img = p.sign ? <img src={p.sign} alt="" style={{ maxHeight: 52, maxWidth: '85%', objectFit: 'contain' }} /> : null;
  if (!live) {
    return <div style={{ minHeight: 54, display: 'flex', alignItems: 'flex-end' }}>{img}</div>;
  }
  return (
    <div style={{ minHeight: 54, display: 'flex', alignItems: 'flex-end' }}>
      {img}
      <button
        type="button"
        className="qdoc-screen-only text-11 text-neutral-500 underline ml-1"
        onClick={() => input.current?.click()}
      >
        {p.sign ? 'Replace signature' : 'Upload signature'}
      </button>
      <input
        ref={input} type="file" accept="image/*" className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          // Kept small on purpose: the image travels inside the document.
          if (f.size > 400_000) { window.alert('Use a signature image under 400 KB.'); return; }
          const r = new FileReader();
          r.onload = () => onPick(String(r.result));
          r.readAsDataURL(f);
        }}
      />
    </div>
  );
}

function SpaceBlock({ b, edit }: { b: DBlock; edit: DocEditApi }) {
  const h = clampSpace(b.heightPx ?? 24);
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
 * Measure the static twins, pack units into pages. A `pagebreak` block ends
 * its page wherever it falls. When a unit being typed in crosses a boundary
 * it is remounted on its new page, so the focused element and caret offset
 * are captured first and put back after.
 */
function usePages(ids: string[], contentHeightPx: number, signature: string, blocks: DBlock[]) {
  const measureRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<string[][]>([ids]);
  const restore = useRef<{ editId: string; offset: number } | null>(null);
  const breaks = new Set(blocks.filter((b) => b.key === 'pagebreak').map((b) => b.id));

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
      if (breaks.has(id.split(':')[0]) && cur.length) { next.push(cur); cur = []; used = 0; }
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
    // Only when the move actually DROPPED focus; focus put somewhere else on
    // purpose (a new paragraph after Enter) must not be pulled back.
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
