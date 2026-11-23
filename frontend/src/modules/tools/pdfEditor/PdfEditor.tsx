/**
 * The PDF editor: toolbar, page strip, the pages, and a property bar for
 * whatever is selected. State is {pages, objects} with undo / redo; saving
 * hands the edit list to the server (toSpec → tools runner → PdfEditor.ts),
 * which applies it to the original file, so a second save re-applies every
 * edit to the untouched original rather than stacking on a copy.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  Bold, ChevronDown, ChevronUp, Eraser, FilePlus2, Hand, Highlighter, ImagePlus, Italic, Minus, MousePointer2,
  PenLine, Pencil, Plus, Redo2, RotateCcw, RotateCw, Save, Signature, Square, Trash2, Type, Undo2,
} from 'lucide-react';
import { A4, pageInfo, toSpec, viewRotation, type EditObj, type FontId, type PageEntry, type PageInfo, type Rot } from './model';
import { PageView, type PendingImage, type Style, type Tool } from './PageView';
import { loadEditorFonts } from './pdfjs';
import { SignaturePad } from './SignaturePad';

const MAX_SAVE_BYTES = 11.5 * 1024 * 1024;

interface Snapshot { pages: PageEntry[]; objects: EditObj[] }

const DEFAULT_STYLE: Style = {
  font: 'arial', size: 12, bold: false, italic: false,
  textColor: '#000000', inkColor: '#1d4ed8', inkWidth: 2, rectColor: '#dc2626', highlightColor: '#fde047',
};

const TOOLS: { id: Tool; label: string; icon: ReactNode; hint: string }[] = [
  { id: 'select', label: 'Select', icon: <MousePointer2 size={16} />, hint: 'Select, move and resize what you added' },
  { id: 'edittext', label: 'Edit text', icon: <Pencil size={16} />, hint: "Click any text in the PDF to change it" },
  { id: 'text', label: 'Add text', icon: <Type size={16} />, hint: 'Click where the text should go' },
  { id: 'whiteout', label: 'White-out', icon: <Eraser size={16} />, hint: 'Drag over what should be covered' },
  { id: 'highlight', label: 'Highlight', icon: <Highlighter size={16} />, hint: 'Drag over text to highlight it' },
  { id: 'rect', label: 'Box', icon: <Square size={16} />, hint: 'Drag to draw an outlined box' },
  { id: 'ink', label: 'Draw', icon: <PenLine size={16} />, hint: 'Draw freehand' },
];

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];

export function PdfEditor({ doc, originals, fileName, canSave, saving, onSave }: {
  doc: PDFDocumentProxy;
  originals: PageInfo[];
  fileName: string;
  canSave: boolean;
  saving: boolean;
  onSave: (spec: ReturnType<typeof toSpec>) => void;
}) {
  const [pages, setPages] = useState<PageEntry[]>(() => originals.map((_, i) => ({ key: `p${i}`, source: i, rotate: 0 })));
  const [objects, setObjects] = useState<EditObj[]>([]);
  const [past, setPast] = useState<Snapshot[]>([]);
  const [future, setFuture] = useState<Snapshot[]>([]);
  const [tool, setTool] = useState<Tool>('select');
  const [style, setStyle] = useState<Style>(DEFAULT_STYLE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [replaced, setReplaced] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<PendingImage | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(1);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string>('p0');
  const scrollRef = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const dragStart = useRef<Snapshot | null>(null);

  // Text is measured to place it, so the pages wait for the embedded fonts.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => { void loadEditorFonts().then(() => setFontsReady(true)); }, []);

  // Fit the widest page to the available width (zoom 100% = fit width, at most 1.6×).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const widest = Math.max(...pages.map((p) => {
        const info = pageInfo(p, originals);
        const r = viewRotation(p, originals);
        const w = (info.view[2] - info.view[0]) * info.userUnit;
        const h = (info.view[3] - info.view[1]) * info.userUnit;
        return r % 180 === 0 ? w : h;
      }));
      setFit(Math.max(0.3, Math.min(1.6, (el.clientWidth - 48) / widest)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pages, originals]);
  const scale = fit * zoom;

  // ── History ─────────────────────────────────────────────────────────────
  const snap = useCallback((): Snapshot => ({ pages, objects }), [pages, objects]);
  const commit = useCallback((next: Partial<Snapshot>) => {
    setPast((h) => [...h.slice(-199), snap()]);
    setFuture([]);
    if (next.pages) setPages(next.pages);
    if (next.objects) setObjects(next.objects);
    setSavedAt(null);
  }, [snap]);
  const undo = useCallback(() => {
    setPast((h) => {
      if (!h.length) return h;
      const prev = h[h.length - 1];
      setFuture((f) => [snap(), ...f]);
      setPages(prev.pages); setObjects(prev.objects);
      setEditingId(null);
      return h.slice(0, -1);
    });
  }, [snap]);
  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f;
      const next = f[0];
      setPast((h) => [...h, snap()]);
      setPages(next.pages); setObjects(next.objects);
      setEditingId(null);
      return f.slice(1);
    });
  }, [snap]);

  const selected = objects.find((o) => o.id === selectedId) ?? null;
  const patchSelected = (patch: Partial<EditObj>) => {
    if (!selected) return;
    commit({ objects: objects.map((o) => (o.id === selected.id ? ({ ...o, ...patch } as EditObj) : o)) });
  };
  const removeSelected = useCallback(() => {
    if (!selectedId) return;
    commit({ objects: objects.filter((o) => o.id !== selectedId) });
    setSelectedId(null); setEditingId(null);
  }, [selectedId, objects, commit]);

  // ── Keyboard ────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); removeSelected(); return; }
      if (e.key === 'Escape') { setSelectedId(null); setEditingId(null); setPending(null); setTool('select'); return; }
      if (selected && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = (e.shiftKey ? 10 : 1);
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key] as [number, number] | undefined;
        if (!d) return;
        // Nudge in user space (points): simple and exact.
        if (selected.type === 'ink') patchSelected({ points: selected.points.map(([x, y]) => [x + d[0], y + d[1]] as [number, number]) });
        else patchSelected({ x: selected.x + d[0], y: selected.y + d[1] });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Warn before leaving with unsaved edits.
  const dirty = past.length > 0 && !savedAt;
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // ── Page operations ─────────────────────────────────────────────────────
  const rotatePage = (key: string, by: 90 | 270) => commit({ pages: pages.map((p) => (p.key === key ? { ...p, rotate: (((p.rotate + by) % 360) as Rot) } : p)) });
  const movePage = (i: number, by: -1 | 1) => {
    const j = i + by;
    if (j < 0 || j >= pages.length) return;
    const next = [...pages];
    [next[i], next[j]] = [next[j], next[i]];
    commit({ pages: next });
  };
  const deletePage = (key: string) => {
    if (pages.length <= 1) { setError('A PDF needs at least one page.'); return; }
    commit({ pages: pages.filter((p) => p.key !== key), objects: objects.filter((o) => o.pageKey !== key) });
  };
  const insertBlank = (afterIndex: number) => {
    const ref = pages[afterIndex];
    const info = ref ? pageInfo(ref, originals) : null;
    const portrait = (info ? viewRotation(ref, originals) : 0) % 180 === 0;
    const w = info ? (info.view[2] - info.view[0]) * info.userUnit : A4[0];
    const h = info ? (info.view[3] - info.view[1]) * info.userUnit : A4[1];
    const entry: PageEntry = { key: `b${Date.now().toString(36)}`, source: null, rotate: 0, width: portrait ? w : h, height: portrait ? h : w };
    const next = [...pages];
    next.splice(afterIndex + 1, 0, entry);
    commit({ pages: next });
    setTimeout(() => scrollToPage(entry.key), 50);
  };
  const scrollToPage = (key: string) => {
    setActiveKey(key);
    scrollRef.current?.querySelector(`[data-page-key="${key}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // ── Images and signatures ──────────────────────────────────────────────
  async function pickImage(file: File) {
    try {
      setPending(await downscale(file));
      setTool('place-image');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const placeSignature = (data: string, aspect: number) => {
    setSigning(false);
    setPending({ data, aspect, widthPt: 150 });
    setTool('place-image');
  };

  // ── Save ────────────────────────────────────────────────────────────────
  function save() {
    setEditingId(null);
    const spec = toSpec(pages, objects);
    const size = new Blob([JSON.stringify(spec)]).size;
    if (size > MAX_SAVE_BYTES) { setError('The images added are too large to save together. Remove one or use smaller images.'); return; }
    setError(null);
    onSave(spec);
    setSavedAt(new Date().toISOString());
  }

  const toolHint = tool === 'place-image' ? 'Click on the page where the image should go' : TOOLS.find((t) => t.id === tool)?.hint;

  return (
    <div className="flex flex-col border border-neutral-200 rounded-xl overflow-hidden bg-neutral-100" style={{ height: 'calc(100dvh - 150px)', minHeight: 520 }}>
      {/* Toolbar */}
      <div className="flex items-center gap-1 flex-wrap px-2 py-2 bg-white border-b border-neutral-200">
        {TOOLS.map((t) => (
          <ToolButton key={t.id} active={tool === t.id} label={t.label} onClick={() => { setTool(t.id); setPending(null); setEditingId(null); }}>{t.icon}</ToolButton>
        ))}
        <ToolButton active={tool === 'place-image' && pending?.widthPt !== 150} label="Image" onClick={() => imageInput.current?.click()}><ImagePlus size={16} /></ToolButton>
        <ToolButton active={tool === 'place-image' && pending?.widthPt === 150} label="Signature" onClick={() => setSigning(true)}><Signature size={16} /></ToolButton>
        <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pickImage(f); }} />
        <Divider />
        <IconBtn label="Undo (Ctrl+Z)" disabled={!past.length} onClick={undo}><Undo2 size={16} /></IconBtn>
        <IconBtn label="Redo (Ctrl+Y)" disabled={!future.length} onClick={redo}><Redo2 size={16} /></IconBtn>
        <Divider />
        <IconBtn label="Zoom out" disabled={zoom <= ZOOMS[0]} onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)] ?? 1)}><Minus size={16} /></IconBtn>
        <button type="button" className="h-8 px-2 text-12 text-neutral-700 rounded hover:bg-neutral-100 tabular-nums" onClick={() => setZoom(1)} title="Fit width">{Math.round(zoom * 100)}%</button>
        <IconBtn label="Zoom in" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)] ?? 1)}><Plus size={16} /></IconBtn>
        <div className="flex-1" />
        <span className="hidden md:inline text-12 text-neutral-500 truncate max-w-[220px]" title={fileName}>{fileName}</span>
        <button type="button" onClick={save} disabled={!canSave || saving}
          className="h-9 px-4 inline-flex items-center gap-2 text-13 font-medium rounded-lg bg-primary text-white hover:bg-primaryHover disabled:opacity-50" data-testid="pdf-editor-save">
          <Save size={15} /> {saving ? 'Saving…' : 'Save PDF'}
        </button>
      </div>

      {/* Property bar */}
      <PropertyBar tool={tool} style={style} setStyle={setStyle} selected={selected} patch={patchSelected} remove={removeSelected}
        hint={toolHint} onEditText={() => { if (selected?.type === 'text') setEditingId(selected.id); }} />
      {error ? (
        <div className="px-3 py-2 text-13 bg-[#fef2f2] text-[#b91c1c] border-b border-[#fecaca] flex items-center gap-2">
          <span className="flex-1">{error}</span>
          <button type="button" className="text-12 underline" onClick={() => setError(null)}>Dismiss</button>
        </div>
      ) : null}

      <div className="flex flex-1 min-h-0">
        {/* Page strip */}
        <aside className="hidden md:flex flex-col w-[150px] shrink-0 bg-white border-r border-neutral-200 overflow-y-auto p-2 gap-2">
          {pages.map((p, i) => (
            <div key={p.key} className={`rounded-lg border p-1.5 ${activeKey === p.key ? 'border-primary bg-primary/5' : 'border-neutral-200'}`}>
              <button type="button" className="block w-full" onClick={() => scrollToPage(p.key)}>
                <Thumb entry={p} doc={doc} originals={originals} />
                <div className="text-11 text-neutral-600 mt-1">Page {i + 1}{p.source === null ? ' · blank' : ''}</div>
              </button>
              <div className="flex flex-wrap gap-0.5 mt-1">
                <Mini label="Rotate left" onClick={() => rotatePage(p.key, 270)}><RotateCcw size={13} /></Mini>
                <Mini label="Rotate right" onClick={() => rotatePage(p.key, 90)}><RotateCw size={13} /></Mini>
                <Mini label="Move up" disabled={i === 0} onClick={() => movePage(i, -1)}><ChevronUp size={13} /></Mini>
                <Mini label="Move down" disabled={i === pages.length - 1} onClick={() => movePage(i, 1)}><ChevronDown size={13} /></Mini>
                <Mini label="Insert a blank page after" onClick={() => insertBlank(i)}><FilePlus2 size={13} /></Mini>
                <Mini label="Delete page" danger onClick={() => deletePage(p.key)}><Trash2 size={13} /></Mini>
              </div>
            </div>
          ))}
        </aside>

        {/* Pages */}
        <div ref={scrollRef} className="flex-1 min-w-0 overflow-auto p-6 space-y-6" data-testid="pdf-editor-pages"
          onScroll={(e) => {
            const top = (e.currentTarget as HTMLDivElement).getBoundingClientRect().top;
            const els = [...(e.currentTarget as HTMLDivElement).querySelectorAll<HTMLElement>('[data-page-key]')];
            const cur = els.find((el) => el.getBoundingClientRect().bottom > top + 80);
            if (cur?.dataset.pageKey && cur.dataset.pageKey !== activeKey) setActiveKey(cur.dataset.pageKey);
          }}>
          {!fontsReady ? <p className="text-13 text-neutral-500">Loading fonts…</p> : null}
          {fontsReady && pages.map((p, i) => (
            <div key={p.key}>
              <div className="md:hidden flex items-center gap-1 mb-1 text-11 text-neutral-600">
                <span className="flex-1">Page {i + 1}</span>
                <Mini label="Rotate right" onClick={() => rotatePage(p.key, 90)}><RotateCw size={13} /></Mini>
                <Mini label="Move up" disabled={i === 0} onClick={() => movePage(i, -1)}><ChevronUp size={13} /></Mini>
                <Mini label="Move down" disabled={i === pages.length - 1} onClick={() => movePage(i, 1)}><ChevronDown size={13} /></Mini>
                <Mini label="Delete page" danger onClick={() => deletePage(p.key)}><Trash2 size={13} /></Mini>
              </div>
              <PageView
                entry={p} info={pageInfo(p, originals)} doc={doc} zoom={scale} rotation={viewRotation(p, originals)}
                objects={objects.filter((o) => o.pageKey === p.key)}
                selectedId={selectedId} editingId={editingId} tool={tool} style={style} pending={pending} replaced={replaced}
                onCreate={(o, opts) => {
                  commit({ objects: [...objects, o] });
                  setSelectedId(o.id);
                  if (opts?.edit) setEditingId(o.id);
                  if (!opts?.keepTool) { setTool('select'); setPending(null); }
                }}
                onSelect={(id) => { setSelectedId(id); if (id !== editingId) setEditingId(null); }}
                onBegin={() => { dragStart.current = snap(); }}
                onLive={(id, patch) => setObjects((os) => os.map((o) => (o.id === id ? ({ ...o, ...patch } as EditObj) : o)))}
                onEnd={() => {
                  if (dragStart.current) { const s = dragStart.current; setPast((h) => [...h.slice(-199), s]); setFuture([]); setSavedAt(null); }
                  dragStart.current = null;
                }}
                onEdit={(id) => {
                  if (id) { dragStart.current = snap(); setEditingId(id); return; }
                  // Leaving the editor: an empty text box is removed; a change is one undo step.
                  const cur = objects.find((o) => o.id === editingId);
                  if (cur && cur.type === 'text' && !cur.text.trim()) setObjects((os) => os.filter((o) => o.id !== cur.id));
                  if (dragStart.current) {
                    const before = dragStart.current.objects.find((o) => o.id === editingId);
                    if (!before || (before.type === 'text' && cur?.type === 'text' && before.text !== cur.text)) {
                      const s = dragStart.current; setPast((h) => [...h.slice(-199), s]); setFuture([]); setSavedAt(null);
                    }
                  }
                  dragStart.current = null;
                  setEditingId(null);
                }}
                onReplace={(key, wo, text) => {
                  commit({ objects: [...objects, wo, text] });
                  setReplaced((r) => new Set(r).add(key));
                  setSelectedId(text.id);
                  dragStart.current = null;
                  setEditingId(text.id);
                }}
              />
            </div>
          ))}
          <div className="flex justify-center">
            <button type="button" onClick={() => insertBlank(pages.length - 1)}
              className="h-9 px-3 inline-flex items-center gap-2 text-13 rounded-lg border border-dashed border-neutral-300 bg-white text-neutral-600 hover:border-primary hover:text-primary">
              <FilePlus2 size={15} /> Add a blank page at the end
            </button>
          </div>
        </div>
      </div>

      <div className="px-3 py-1.5 bg-white border-t border-neutral-200 text-11 text-neutral-500 flex flex-wrap gap-x-4 gap-y-1">
        <span>{pages.length} page{pages.length === 1 ? '' : 's'} · {objects.length} edit{objects.length === 1 ? '' : 's'}</span>
        <span>White-out covers text on the page but does not delete it from the file: it can still be copied or searched. Don't use it to hide PAN, bank or other private details — remove those pages instead.</span>
      </div>

      {signing ? <SignaturePad onCancel={() => setSigning(false)} onDone={placeSignature} /> : null}
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────

function PropertyBar({ tool, style, setStyle, selected, patch, remove, hint, onEditText }: {
  tool: Tool; style: Style; setStyle: (s: Style) => void; selected: EditObj | null;
  patch: (p: Partial<EditObj>) => void; remove: () => void; hint?: string; onEditText: () => void;
}) {
  const textTarget = selected?.type === 'text' ? selected : null;
  const showText = textTarget || tool === 'text';
  const cur = textTarget ?? { font: style.font, size: style.size, bold: style.bold, italic: style.italic, color: style.textColor };
  const setText = (p: Partial<{ font: FontId; size: number; bold: boolean; italic: boolean; color: string }>) => {
    if (textTarget) patch(p as Partial<EditObj>);
    else setStyle({ ...style, ...(p.font ? { font: p.font } : {}), ...(p.size ? { size: p.size } : {}), ...(p.bold !== undefined ? { bold: p.bold } : {}), ...(p.italic !== undefined ? { italic: p.italic } : {}), ...(p.color ? { textColor: p.color } : {}) });
  };
  const sel = 'h-8 px-2 text-13 rounded-lg border border-neutral-200 bg-white';

  return (
    <div className="flex items-center gap-2 flex-wrap px-3 py-1.5 bg-neutral-50 border-b border-neutral-200 min-h-[44px]">
      {showText ? (
        <>
          <select className={sel} value={cur.font} onChange={(e) => setText({ font: e.target.value as FontId })} aria-label="Font">
            <option value="arial">Arial / Helvetica</option>
            <option value="sans">Calibri</option>
            <option value="serif">Times New Roman</option>
          </select>
          <input className={`${sel} w-[70px]`} type="number" min={4} max={200} step={0.5} value={cur.size} aria-label="Font size"
            onChange={(e) => { const v = Number(e.target.value); if (v >= 2 && v <= 400) setText({ size: v }); }} />
          <IconBtn label="Bold" active={cur.bold} onClick={() => setText({ bold: !cur.bold })}><Bold size={15} /></IconBtn>
          <IconBtn label="Italic" active={cur.italic} onClick={() => setText({ italic: !cur.italic })}><Italic size={15} /></IconBtn>
          <Colour value={cur.color} onChange={(c) => setText({ color: c })} label="Text colour" />
          {textTarget ? <button type="button" className="h-8 px-2 text-13 rounded-lg hover:bg-neutral-200" onClick={onEditText}>Edit words</button> : null}
        </>
      ) : null}
      {selected && (selected.type === 'highlight' || selected.type === 'rect' || selected.type === 'whiteout') ? (
        <>
          <Colour value={selected.color} onChange={(c) => patch({ color: c })} label="Colour" />
          {selected.type === 'highlight' ? (
            <label className="flex items-center gap-1 text-12 text-neutral-600">Strength
              <input type="range" min={0.15} max={0.8} step={0.05} value={selected.opacity ?? 0.4} onChange={(e) => patch({ opacity: Number(e.target.value) })} />
            </label>
          ) : null}
          {selected.type === 'rect' ? (
            <label className="flex items-center gap-1 text-12 text-neutral-600">Line
              <input type="range" min={0.5} max={8} step={0.5} value={selected.borderWidth ?? 1.5} onChange={(e) => patch({ borderWidth: Number(e.target.value) })} />
            </label>
          ) : null}
        </>
      ) : null}
      {selected?.type === 'ink' || (!selected && tool === 'ink') ? (
        <>
          <Colour value={selected?.type === 'ink' ? selected.color : style.inkColor} label="Pen colour"
            onChange={(c) => (selected?.type === 'ink' ? patch({ color: c }) : setStyle({ ...style, inkColor: c }))} />
          <label className="flex items-center gap-1 text-12 text-neutral-600">Thickness
            <input type="range" min={0.5} max={12} step={0.5} value={selected?.type === 'ink' ? selected.width : style.inkWidth}
              onChange={(e) => (selected?.type === 'ink' ? patch({ width: Number(e.target.value) }) : setStyle({ ...style, inkWidth: Number(e.target.value) }))} />
          </label>
        </>
      ) : null}
      {!selected && (tool === 'highlight' || tool === 'rect') ? (
        <Colour value={tool === 'highlight' ? style.highlightColor : style.rectColor} label="Colour"
          onChange={(c) => setStyle(tool === 'highlight' ? { ...style, highlightColor: c } : { ...style, rectColor: c })} />
      ) : null}
      {selected?.type === 'image' ? (
        <label className="flex items-center gap-1 text-12 text-neutral-600">Opacity
          <input type="range" min={0.1} max={1} step={0.05} value={selected.opacity} onChange={(e) => patch({ opacity: Number(e.target.value) })} />
        </label>
      ) : null}
      {selected ? (
        <button type="button" onClick={remove} className="h-8 px-2 inline-flex items-center gap-1 text-13 rounded-lg text-[#b91c1c] hover:bg-[#fef2f2]">
          <Trash2 size={14} /> Delete
        </button>
      ) : null}
      <span className="flex-1" />
      {hint ? <span className="text-12 text-neutral-500 inline-flex items-center gap-1"><Hand size={13} />{hint}</span> : null}
    </div>
  );
}

const COLOURS = ['#000000', '#1f2937', '#dc2626', '#1d4ed8', '#047857', '#b45309', '#ffffff', '#fde047'];
function Colour({ value, onChange, label }: { value: string; onChange: (c: string) => void; label: string }) {
  return (
    <span className="inline-flex items-center gap-1" aria-label={label}>
      {COLOURS.map((c) => (
        <button key={c} type="button" title={c} onClick={() => onChange(c)}
          className={`h-5 w-5 rounded-full border ${value.toLowerCase() === c ? 'ring-2 ring-primary ring-offset-1' : ''}`}
          style={{ background: c, borderColor: c === '#ffffff' ? '#d1d5db' : c }} />
      ))}
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-6 w-6 p-0 border-0 bg-transparent" title="Other colour" />
    </span>
  );
}

function ToolButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} title={label}
      className={`h-9 px-2.5 inline-flex items-center gap-1.5 text-13 rounded-lg transition-colors ${active ? 'bg-primary text-white' : 'text-neutral-700 hover:bg-neutral-100'}`}>
      {children}<span className="hidden lg:inline">{label}</span>
    </button>
  );
}
function IconBtn({ label, onClick, disabled, active, children }: { label: string; onClick: () => void; disabled?: boolean; active?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={label} aria-label={label} aria-pressed={active}
      className={`h-8 w-8 inline-flex items-center justify-center rounded-lg disabled:opacity-40 ${active ? 'bg-neutral-200 text-neutral-900' : 'text-neutral-700 hover:bg-neutral-100'}`}>
      {children}
    </button>
  );
}
function Mini({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={label} aria-label={label}
      className={`h-6 w-6 inline-flex items-center justify-center rounded disabled:opacity-30 ${danger ? 'text-[#b91c1c] hover:bg-[#fef2f2]' : 'text-neutral-600 hover:bg-neutral-100'}`}>
      {children}
    </button>
  );
}
const Divider = () => <span className="w-px h-6 bg-neutral-200 mx-1" />;

/** A small picture of a page for the strip. */
function Thumb({ entry, doc, originals }: { entry: PageEntry; doc: PDFDocumentProxy; originals: PageInfo[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const info = pageInfo(entry, originals);
  const rot = viewRotation(entry, originals);
  const w = (info.view[2] - info.view[0]); const h = (info.view[3] - info.view[1]);
  const [vw, vh] = rot % 180 === 0 ? [w, h] : [h, w];
  const width = 122; const height = Math.round((width * vh) / vw);
  useEffect(() => {
    if (entry.source === null || !ref.current) return;
    let task: { cancel: () => void } | null = null;
    let live = true;
    void doc.getPage(entry.source + 1).then((pg) => {
      if (!live || !ref.current) return;
      const vp = pg.getViewport({ scale: (width * 2) / vw, rotation: rot });
      ref.current.width = vp.width; ref.current.height = vp.height;
      const t = pg.render({ canvasContext: ref.current.getContext('2d')!, viewport: vp });
      task = t;
      t.promise.catch(() => undefined);
    });
    return () => { live = false; task?.cancel(); };
  }, [doc, entry.source, rot, vw]);
  return entry.source === null
    ? <div className="bg-white border border-neutral-200 mx-auto" style={{ width, height }} />
    : <canvas ref={ref} className="bg-white border border-neutral-200 mx-auto block" style={{ width, height }} />;
}

/** Any picked image as a PNG / JPEG data URL, at most 1600px on its long side. */
async function downscale(file: File): Promise<PendingImage> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPEG or WEBP image.');
  if (file.size > 15 * 1024 * 1024) throw new Error('That image is larger than 15 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('That image could not be read.'));
      i.src = url;
    });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    // JPEG for photos; PNG keeps transparency (stamps, logos).
    const data = file.type === 'image/jpeg' ? c.toDataURL('image/jpeg', 0.88) : c.toDataURL('image/png');
    return { data, aspect: c.width / c.height, widthPt: Math.min(220, c.width * 0.75) };
  } finally {
    URL.revokeObjectURL(url);
  }
}
