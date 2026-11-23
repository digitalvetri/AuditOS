/**
 * One page of the PDF editor: the page itself (pdf.js on a canvas, or blank
 * paper) with the edits drawn over it in SVG, and every pointer interaction —
 * placing, moving, resizing, drawing, and clicking existing text to edit it.
 *
 * Objects live in PDF user space (model.ts); this component only converts to
 * and from the screen through the page's Geo.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import {
  FONT_FAMILY, Geo, type FontId, LINE_HEIGHT, newId,
  type BoxObj, type EditObj, type ImageObj, type InkObj, type PageEntry, type PageInfo, type TextObj,
} from './model';
import { pdfjs } from './pdfjs';

export type Tool = 'select' | 'edittext' | 'text' | 'whiteout' | 'highlight' | 'rect' | 'ink' | 'place-image';

export interface Style {
  font: FontId; size: number; bold: boolean; italic: boolean;
  textColor: string; inkColor: string; inkWidth: number; rectColor: string; highlightColor: string;
}

export interface PendingImage { data: string; aspect: number; widthPt: number }

export interface PageViewProps {
  entry: PageEntry;
  info: PageInfo;
  doc: PDFDocumentProxy | null;
  zoom: number;
  rotation: number;
  objects: EditObj[];
  selectedId: string | null;
  editingId: string | null;
  tool: Tool;
  style: Style;
  pending: PendingImage | null;
  replaced: Set<string>;
  onCreate: (o: EditObj, opts?: { edit?: boolean; keepTool?: boolean }) => void;
  onSelect: (id: string | null) => void;
  onBegin: () => void;
  onLive: (id: string, patch: Partial<EditObj>) => void;
  onEnd: () => void;
  onEdit: (id: string | null) => void;
  onReplace: (key: string, whiteout: BoxObj, text: TextObj) => void;
}

// ── Text metrics (screen) ─────────────────────────────────────────────────
const measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
export function textMetrics(o: Pick<TextObj, 'font' | 'bold' | 'italic' | 'text'>, px: number) {
  const lines = o.text.replace(/\r/g, '').split('\n');
  const lh = px * LINE_HEIGHT;
  let asc = px * 0.8; let desc = px * 0.22; let w = 0;
  if (measureCtx) {
    measureCtx.font = `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${px}px ${FONT_FAMILY[o.font]}`;
    const m = measureCtx.measureText('Hg');
    asc = m.fontBoundingBoxAscent || asc;
    desc = m.fontBoundingBoxDescent || desc;
    w = Math.max(...lines.map((l) => measureCtx.measureText(l || ' ').width));
  }
  // Where the first baseline sits inside a CSS line box of height `lh`.
  const base = (lh - (asc + desc)) / 2 + asc;
  return { lines, lh, base, w: Math.max(w, px * 0.6), h: lines.length * lh };
}

/** Screen-clockwise degrees an object is drawn at on this view. */
const cssAngle = (geoRot: number, objRot: number) => ((geoRot - objRot) % 360 + 360) % 360;

function rotateVec(x: number, y: number, deg: number): [number, number] {
  const r = (deg * Math.PI) / 180;
  return [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
}

/** Move an object by a screen delta. Uniform scale and quarter-turn rotation make this exact. */
export function shifted(o: EditObj, geo: Geo, dx: number, dy: number): Partial<EditObj> {
  const move = (x: number, y: number): [number, number] => {
    const [sx, sy] = geo.toScreen(x, y);
    return geo.toPdf(sx + dx, sy + dy);
  };
  if (o.type === 'ink') return { points: o.points.map(([x, y]) => move(x, y)) } as Partial<InkObj>;
  const [x, y] = move(o.x, o.y);
  return { x, y };
}

interface TextItem { key: string; left: number; base: number; width: number; height: number; str: string; font: FontId; bold: boolean; italic: boolean }

type Drag =
  | { kind: 'move'; id: string; sx: number; sy: number; orig: EditObj; moved: boolean }
  | { kind: 'resize-box'; id: string; left: number; top: number }
  | { kind: 'resize-image'; id: string; orig: ImageObj }
  | { kind: 'draw-box'; type: BoxObj['type']; sx: number; sy: number }
  | { kind: 'ink'; points: [number, number][] };

export function PageView(p: PageViewProps) {
  const geo = useMemo(() => new Geo(p.info.view, p.zoom, p.rotation, p.info.userUnit), [p.info, p.zoom, p.rotation]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [pdfPage, setPdfPage] = useState<PDFPageProxy | null>(null);
  const [rendered, setRendered] = useState(false);
  const [items, setItems] = useState<TextItem[] | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [temp, setTemp] = useState<{ box?: { left: number; top: number; width: number; height: number }; ink?: [number, number][] } | null>(null);

  // Only pages near the viewport are rendered.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    let live = true;
    if (p.doc && p.entry.source !== null && visible && !pdfPage) {
      void p.doc.getPage(p.entry.source + 1).then((pg) => { if (live) setPdfPage(pg); });
    }
    return () => { live = false; };
  }, [p.doc, p.entry.source, visible, pdfPage]);

  // Render the page at the device's pixel density; re-render on zoom / rotation.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfPage || !visible) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const vp = pdfPage.getViewport({ scale: p.zoom * dpr, rotation: p.rotation });
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const task = pdfPage.render({ canvasContext: canvas.getContext('2d')!, viewport: vp });
    task.promise.then(() => setRendered(true)).catch(() => undefined);
    return () => task.cancel();
  }, [pdfPage, p.zoom, p.rotation, visible]);

  // Existing text, for "Edit text": positions straight from pdf.js.
  useEffect(() => {
    let live = true;
    if (p.tool !== 'edittext' || !pdfPage || !visible) return;
    void (async () => {
      const m = await pdfjs();
      const tc = await pdfPage.getTextContent();
      const out: TextItem[] = [];
      tc.items.forEach((raw, i) => {
        const it = raw as { str: string; transform: number[]; width: number; fontName: string };
        if (!it.str || !it.str.trim()) return;
        const tx = m.Util.transform(geo.transform, it.transform);
        const height = Math.hypot(tx[2], tx[3]);
        // Only text that reads left-to-right on screen.
        if (Math.abs(tx[1]) > 0.01 * height || tx[0] <= 0 || height < 2) return;
        const family = tc.styles[it.fontName]?.fontFamily ?? '';
        let fontName = '';
        let bold = false; let italic = false;
        try {
          if (rendered && pdfPage.commonObjs.has(it.fontName)) {
            const f = pdfPage.commonObjs.get(it.fontName) as { name?: string; bold?: boolean; italic?: boolean };
            fontName = f?.name ?? '';
            bold = Boolean(f?.bold) || /bold|black|heavy|semibold/i.test(fontName);
            italic = Boolean(f?.italic) || /italic|oblique/i.test(fontName);
          }
        } catch { /* font not loaded: plain */ }
        // Closest of the three embedded families: Times-like, Calibri-like, else Arial / Helvetica.
        const names = `${fontName} ${family}`;
        const font: FontId = /times|roman|georgia|garamond|cambria|book|minion|tinos/i.test(names) || (/serif/i.test(names) && !/sans/i.test(names)) ? 'serif'
          : /calibri|carlito|candara|segoe|verdana|tahoma/i.test(names) ? 'sans' : 'arial';
        out.push({ key: `${p.entry.key}:${i}`, left: tx[4], base: tx[5], width: it.width * geo.scale, height, str: it.str, font, bold, italic })
      });
      if (live) setItems(out);
    })();
    return () => { live = false; };
  }, [p.tool, pdfPage, visible, geo, rendered, p.entry.key]);

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = wrapRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  // ── Pointer on the page surface ─────────────────────────────────────────
  function surfaceDown(e: RPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    const [sx, sy] = local(e);
    const s = p.style;
    if (p.tool === 'select' || p.tool === 'edittext') { p.onSelect(null); p.onEdit(null); return; }
    if (p.tool === 'text') {
      const px = s.size * p.zoom;
      const t: TextObj = { id: newId(), pageKey: p.entry.key, type: 'text', x: 0, y: 0, text: '', size: s.size, font: s.font, bold: s.bold, italic: s.italic, color: s.textColor, rotation: geo.rotation };
      const m = textMetrics(t, px);
      const [x, y] = geo.toPdf(sx, sy - px * 0.1 + m.base);
      p.onCreate({ ...t, x, y }, { edit: true });
      e.preventDefault();
      return;
    }
    if (p.tool === 'place-image' && p.pending) {
      const wPx = p.pending.widthPt * p.zoom;
      const hPx = wPx / p.pending.aspect;
      const [x, y] = geo.toPdf(sx, sy + hPx);
      p.onCreate({ id: newId(), pageKey: p.entry.key, type: 'image', x, y, w: wPx / geo.scale, h: hPx / geo.scale, rotation: geo.rotation, data: p.pending.data, opacity: 1 });
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (p.tool === 'ink') { setDrag({ kind: 'ink', points: [[sx, sy]] }); setTemp({ ink: [[sx, sy]] }); return; }
    if (p.tool === 'whiteout' || p.tool === 'highlight' || p.tool === 'rect') {
      setDrag({ kind: 'draw-box', type: p.tool, sx, sy });
      setTemp({ box: { left: sx, top: sy, width: 0, height: 0 } });
    }
  }

  function objectDown(e: RPointerEvent, o: EditObj) {
    if (p.tool !== 'select' && p.tool !== 'edittext') return;
    e.stopPropagation();
    if (e.button !== 0) return;
    if (p.editingId === o.id) return;
    p.onSelect(o.id);
    const [sx, sy] = local(e);
    wrapRef.current!.setPointerCapture(e.pointerId);
    setDrag({ kind: 'move', id: o.id, sx, sy, orig: o, moved: false });
  }

  function handleDown(e: RPointerEvent, o: EditObj) {
    e.stopPropagation();
    wrapRef.current!.setPointerCapture(e.pointerId);
    p.onBegin();
    if (o.type === 'image') setDrag({ kind: 'resize-image', id: o.id, orig: o });
    else if (o.type !== 'text' && o.type !== 'ink') {
      const b = geo.screenBox(o);
      setDrag({ kind: 'resize-box', id: o.id, left: b.left, top: b.top });
    }
  }

  function move(e: RPointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const [sx, sy] = local(e);
    switch (drag.kind) {
      case 'move': {
        const dx = sx - drag.sx; const dy = sy - drag.sy;
        if (!drag.moved) {
          if (Math.hypot(dx, dy) < 3) return;
          p.onBegin();
          setDrag({ ...drag, moved: true });
        }
        p.onLive(drag.id, shifted(drag.orig, geo, dx, dy));
        break;
      }
      case 'resize-box': {
        const b = geo.boxFromScreen(drag.left, drag.top, Math.max(drag.left + 4, sx), Math.max(drag.top + 4, sy));
        p.onLive(drag.id, b);
        break;
      }
      case 'resize-image': {
        const o = drag.orig;
        const [ox, oy] = geo.toScreen(o.x, o.y);
        const [lx] = rotateVec(sx - ox, sy - oy, -cssAngle(geo.rotation, o.rotation));
        const wPx = Math.max(12, lx);
        const w = wPx / geo.scale;
        p.onLive(drag.id, { w, h: w * (o.h / o.w) });
        break;
      }
      case 'draw-box':
        setTemp({ box: { left: Math.min(drag.sx, sx), top: Math.min(drag.sy, sy), width: Math.abs(sx - drag.sx), height: Math.abs(sy - drag.sy) } });
        break;
      case 'ink': {
        const last = drag.points[drag.points.length - 1];
        if (Math.hypot(sx - last[0], sy - last[1]) < 1.5) return;
        const points = [...drag.points, [sx, sy] as [number, number]];
        setDrag({ kind: 'ink', points });
        setTemp({ ink: points });
        break;
      }
    }
  }

  function up(e: RPointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const [sx, sy] = local(e);
    const s = p.style;
    if (drag.kind === 'move') { if (drag.moved) p.onEnd(); }
    else if (drag.kind === 'resize-box' || drag.kind === 'resize-image') p.onEnd();
    else if (drag.kind === 'draw-box') {
      let { sx: x1, sy: y1 } = drag; let x2 = sx; let y2 = sy;
      // A click rather than a drag gets a sensible default size.
      if (Math.abs(x2 - x1) < 4 && Math.abs(y2 - y1) < 4) {
        x2 = x1 + (drag.type === 'rect' ? 140 : 120) * p.zoom; y2 = y1 + (drag.type === 'rect' ? 60 : 18) * p.zoom;
      }
      [x1, x2] = [Math.min(x1, x2), Math.max(x1, x2)]; [y1, y2] = [Math.min(y1, y2), Math.max(y1, y2)];
      const b = geo.boxFromScreen(x1, y1, x2, y2);
      const color = drag.type === 'whiteout' ? '#ffffff' : drag.type === 'highlight' ? s.highlightColor : s.rectColor;
      p.onCreate({ id: newId(), pageKey: p.entry.key, type: drag.type, ...b, color, ...(drag.type === 'highlight' ? { opacity: 0.4 } : {}), ...(drag.type === 'rect' ? { borderWidth: 1.5 } : {}) }, { keepTool: drag.type !== 'rect' });
    } else if (drag.kind === 'ink') {
      const pts = drag.points.length === 1 ? [drag.points[0], [drag.points[0][0] + 0.5, drag.points[0][1] + 0.5] as [number, number]] : drag.points;
      p.onCreate({ id: newId(), pageKey: p.entry.key, type: 'ink', points: pts.map(([x, y]) => geo.toPdf(x, y)), color: s.inkColor, width: s.inkWidth }, { keepTool: true });
    }
    setDrag(null);
    setTemp(null);
  }

  // "Edit text": cover the original run and put an editable copy on top.
  function replaceItem(it: TextItem) {
    const pad = it.height * 0.12;
    const wo = geo.boxFromScreen(it.left - pad, it.base - it.height * 0.95, it.left + it.width + pad, it.base + it.height * 0.3);
    const [x, y] = geo.toPdf(it.left, it.base);
    p.onReplace(it.key,
      { id: newId(), pageKey: p.entry.key, type: 'whiteout', ...wo, color: '#ffffff' },
      { id: newId(), pageKey: p.entry.key, type: 'text', x, y, text: it.str, size: Math.round((it.height / geo.scale) * 10) / 10, font: it.font, bold: it.bold, italic: it.italic, color: '#000000', rotation: geo.rotation });
  }

  const cursor = p.tool === 'text' ? 'text' : p.tool === 'select' || p.tool === 'edittext' ? 'default' : 'crosshair';
  const scanned = p.tool === 'edittext' && items !== null && items.length === 0 && p.entry.source !== null;

  return (
    <div
      ref={wrapRef}
      className="relative bg-white shadow-card select-none mx-auto touch-none"
      style={{ width: geo.width, height: geo.height, cursor }}
      onPointerDown={surfaceDown}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => { setDrag(null); setTemp(null); }}
      data-page-key={p.entry.key}
    >
      {p.entry.source !== null ? (
        <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" style={{ width: geo.width, height: geo.height }} />
      ) : null}
      {p.entry.source !== null && !rendered ? (
        <div className="absolute inset-0 flex items-center justify-center text-12 text-neutral-400 pointer-events-none">Loading page…</div>
      ) : null}

      <svg className="absolute inset-0" width={geo.width} height={geo.height} style={{ overflow: 'visible' }}>
        {p.objects.map((o) => (
          <ObjectShape key={o.id} o={o} geo={geo} zoom={p.zoom} selected={p.selectedId === o.id} editing={p.editingId === o.id}
            interactive={p.tool === 'select' || p.tool === 'edittext'}
            onDown={(e) => objectDown(e, o)} onHandle={(e) => handleDown(e, o)}
            onDoubleClick={() => { if (o.type === 'text') { p.onSelect(o.id); p.onEdit(o.id); } }} />
        ))}
        {temp?.box ? (
          <rect x={temp.box.left} y={temp.box.top} width={temp.box.width} height={temp.box.height}
            fill={p.tool === 'whiteout' ? '#ffffff' : p.tool === 'highlight' ? p.style.highlightColor : 'none'}
            fillOpacity={p.tool === 'highlight' ? 0.4 : 1}
            stroke={p.tool === 'rect' ? p.style.rectColor : '#6366f1'} strokeDasharray={p.tool === 'rect' ? undefined : '4 3'}
            strokeWidth={p.tool === 'rect' ? 1.5 * p.zoom : 1} />
        ) : null}
        {temp?.ink ? (
          <polyline points={temp.ink.map((q) => q.join(',')).join(' ')} fill="none" stroke={p.style.inkColor}
            strokeWidth={p.style.inkWidth * p.zoom} strokeLinecap="round" strokeLinejoin="round" />
        ) : null}
      </svg>

      {p.tool === 'edittext' && items ? (
        <div className="absolute inset-0 pointer-events-none">
          {items.filter((it) => !p.replaced.has(it.key)).map((it) => (
            <button key={it.key} type="button" title="Click to edit this text"
              className="absolute pointer-events-auto rounded-sm border border-transparent hover:border-primary hover:bg-primary/10"
              style={{ left: it.left - 1, top: it.base - it.height * 0.85, width: it.width + 2, height: it.height * 1.1 }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); replaceItem(it); }} />
          ))}
        </div>
      ) : null}
      {scanned ? (
        <div className="absolute left-3 top-3 right-3 rounded-lg bg-amber/15 border border-amber/40 px-3 py-2 text-12 text-neutral-800 pointer-events-none">
          This page has no text to edit — it may be a scan. Run OCR Scan first, or use White-out and Add text.
        </div>
      ) : null}

      {p.editingId ? (() => {
        const o = p.objects.find((x) => x.id === p.editingId);
        return o && o.type === 'text' ? <TextEditor o={o} geo={geo} zoom={p.zoom} onLive={p.onLive} onDone={() => p.onEdit(null)} /> : null;
      })() : null}
    </div>
  );
}

// ── Objects ───────────────────────────────────────────────────────────────

function ObjectShape({ o, geo, zoom, selected, editing, interactive, onDown, onHandle, onDoubleClick }: {
  o: EditObj; geo: Geo; zoom: number; selected: boolean; editing: boolean; interactive: boolean;
  onDown: (e: RPointerEvent) => void; onHandle: (e: RPointerEvent) => void; onDoubleClick: () => void;
}) {
  const pe = interactive ? 'auto' : 'none';
  const sel = '#6941d9';
  const handle = (x: number, y: number) => (
    <rect x={x - 5} y={y - 5} width={10} height={10} fill="#fff" stroke={sel} strokeWidth={1.5}
      style={{ cursor: 'nwse-resize', pointerEvents: 'auto' }} onPointerDown={onHandle} />
  );

  if (o.type === 'text') {
    const px = o.size * zoom;
    const m = textMetrics(o, px);
    const [sx, sy] = geo.toScreen(o.x, o.y);
    const deg = cssAngle(geo.rotation, o.rotation);
    return (
      <g transform={`translate(${sx},${sy}) rotate(${deg})`} style={{ pointerEvents: pe, cursor: interactive ? 'move' : undefined }}
        onPointerDown={onDown} onDoubleClick={onDoubleClick}>
        <rect x={-2} y={-m.base} width={m.w + 4} height={m.h} fill="transparent"
          stroke={selected && !editing ? sel : 'none'} strokeDasharray="4 3" />
        {editing ? null : (
          <text fill={o.color} fontFamily={FONT_FAMILY[o.font]} fontSize={px} fontWeight={o.bold ? 700 : 400}
            fontStyle={o.italic ? 'italic' : 'normal'} style={{ whiteSpace: 'pre' }}>
            {m.lines.map((l, i) => <tspan key={i} x={0} y={i * m.lh}>{l || ' '}</tspan>)}
          </text>
        )}
      </g>
    );
  }
  if (o.type === 'ink') {
    const pts = o.points.map(([x, y]) => geo.toScreen(x, y));
    const xs = pts.map((q) => q[0]); const ys = pts.map((q) => q[1]);
    return (
      <g style={{ pointerEvents: pe, cursor: interactive ? 'move' : undefined }} onPointerDown={onDown}>
        <polyline points={pts.map((q) => q.join(',')).join(' ')} fill="none" stroke="transparent" strokeWidth={Math.max(10, o.width * zoom + 8)} />
        <polyline points={pts.map((q) => q.join(',')).join(' ')} fill="none" stroke={o.color} strokeWidth={o.width * zoom} strokeLinecap="round" strokeLinejoin="round" />
        {selected ? <rect x={Math.min(...xs) - 4} y={Math.min(...ys) - 4} width={Math.max(...xs) - Math.min(...xs) + 8} height={Math.max(...ys) - Math.min(...ys) + 8} fill="none" stroke={sel} strokeDasharray="4 3" /> : null}
      </g>
    );
  }
  if (o.type === 'image') {
    const [sx, sy] = geo.toScreen(o.x, o.y);
    const wPx = o.w * geo.scale; const hPx = o.h * geo.scale;
    return (
      <g transform={`translate(${sx},${sy}) rotate(${cssAngle(geo.rotation, o.rotation)})`} style={{ pointerEvents: pe, cursor: interactive ? 'move' : undefined }} onPointerDown={onDown}>
        <image href={o.data} x={0} y={-hPx} width={wPx} height={hPx} preserveAspectRatio="none" opacity={o.opacity} />
        <rect x={0} y={-hPx} width={wPx} height={hPx} fill="transparent" stroke={selected ? sel : 'none'} strokeDasharray="4 3" />
        {selected ? handle(wPx, 0) : null}
      </g>
    );
  }
  const b = geo.screenBox(o);
  return (
    <g style={{ pointerEvents: pe, cursor: interactive ? 'move' : undefined }} onPointerDown={onDown}>
      {o.type === 'rect' ? (
        <>
          <rect x={b.left} y={b.top} width={b.width} height={b.height} fill="transparent" />
          <rect x={b.left} y={b.top} width={b.width} height={b.height} fill="none" stroke={o.color} strokeWidth={(o.borderWidth ?? 1.5) * zoom} />
        </>
      ) : (
        <rect x={b.left} y={b.top} width={b.width} height={b.height} fill={o.color}
          fillOpacity={o.type === 'highlight' ? (o.opacity ?? 0.4) : 1}
          style={o.type === 'highlight' ? { mixBlendMode: 'multiply' } : undefined}
          stroke={o.type === 'whiteout' && !selected ? '#e5e7eb' : 'none'} strokeDasharray="2 3" />
      )}
      {selected ? (
        <>
          <rect x={b.left - 2} y={b.top - 2} width={b.width + 4} height={b.height + 4} fill="none" stroke={sel} strokeDasharray="4 3" />
          {handle(b.left + b.width, b.top + b.height)}
        </>
      ) : null}
    </g>
  );
}

/** The in-place text editor: a textarea laid over the text, same font, size and rotation. */
function TextEditor({ o, geo, zoom, onLive, onDone }: {
  o: TextObj; geo: Geo; zoom: number; onLive: (id: string, patch: Partial<EditObj>) => void; onDone: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const px = o.size * zoom;
  const m = textMetrics(o, px);
  const [sx, sy] = geo.toScreen(o.x, o.y);
  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.focus();
    t.setSelectionRange(0, t.value.length);
  }, []);
  return (
    <div className="absolute" style={{ left: sx, top: sy, transform: `rotate(${cssAngle(geo.rotation, o.rotation)}deg)`, transformOrigin: '0 0' }}
      onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={o.text}
        onChange={(e) => onLive(o.id, { text: e.target.value })}
        onBlur={onDone}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onDone(); } e.stopPropagation(); }}
        spellCheck={false}
        wrap="off"
        className="absolute block resize-none overflow-hidden bg-white/70 outline outline-1 outline-primary rounded-sm p-0 m-0 border-0"
        style={{
          left: -2, top: -m.base, width: m.w + px * 1.5 + 4, height: m.h + 2,
          fontFamily: FONT_FAMILY[o.font], fontSize: px, lineHeight: `${m.lh}px`, fontWeight: o.bold ? 700 : 400,
          fontStyle: o.italic ? 'italic' : 'normal', color: o.color, paddingLeft: 2, whiteSpace: 'pre',
        }}
      />
    </div>
  );
}
