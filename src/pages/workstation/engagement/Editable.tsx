import {
  useLayoutEffect, useReducer, useRef, type CSSProperties, type KeyboardEvent,
} from 'react';
import {
  caretOffset, sanitizeInline, serializeInline, setCaret, textToInline, toDisplayHtml, unitsIn,
} from '@/modules/workstation/engagement/richtext';

/**
 * The editable primitives behind the letter.
 *
 * THE RULE THAT KEEPS THE CARET STILL: while an element has focus, its DOM is
 * the truth and React never writes into it. State is updated from the DOM on
 * every keystroke; the DOM is rewritten from state only when the element is
 * NOT focused, or when an operation explicitly changes the text under the
 * user (undo/redo, splitting or merging a paragraph) — see `forceSync`.
 * Every other re-render leaves the focused text, and so the caret, untouched.
 */

// ── Cross-render signals ──────────────────────────────────────────────────

let syncVersion = 0;
const dirty = new Set<string>();
/** Rewrite focused elements too: all of them (undo/redo) or the given keys. */
export function forceSync(keys?: string[]) {
  if (!keys) syncVersion++;
  else keys.forEach((k) => dirty.add(k));
}

let pendingFocus: { editId: string; offset: number } | null = null;
/** Focus an element that may not exist until the next render. */
export function requestFocus(editId: string, offset = 0) {
  pendingFocus = { editId, offset };
}

function applyPendingFocus(editId: string, el: HTMLElement) {
  if (pendingFocus?.editId !== editId) return;
  const { offset } = pendingFocus;
  pendingFocus = null;
  el.focus();
  setCaret(el, offset);
}

// ── Keyboard: moving between editables ────────────────────────────────────

/** The editables of one surface, in reading order. */
function neighbours(el: HTMLElement): HTMLElement[] {
  const root = el.closest('[data-edit-surface]') ?? document.body;
  return Array.from(root.querySelectorAll<HTMLElement>('[data-edit-id][contenteditable="true"]'));
}

export function focusSibling(el: HTMLElement, dir: -1 | 1): boolean {
  const all = neighbours(el);
  const next = all[all.indexOf(el) + dir];
  if (!next) return false;
  next.focus();
  setCaret(next, dir === -1 ? Number.MAX_SAFE_INTEGER : 0);
  return true;
}

function caretRect(): DOMRect | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  const r = sel.getRangeAt(0).cloneRange();
  const rects = r.getClientRects();
  return rects.length ? rects[0] : null;
}

/**
 * Arrow keys cross from one editable to the next at the edges, so the letter
 * reads as one document even though it is many small editors.
 */
export function navigateKey(e: KeyboardEvent<HTMLElement>, el: HTMLElement): boolean {
  const off = caretOffset(el);
  if (off === null) return false;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return false;
  const end = unitsIn(el);
  const box = el.getBoundingClientRect();
  const cr = caretRect();
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 18;
  const onFirst = !cr || cr.top - box.top < lh * 0.8;
  const onLast = !cr || box.bottom - cr.bottom < lh * 0.8;

  if ((e.key === 'ArrowLeft' && off === 0) || (e.key === 'ArrowUp' && onFirst)) {
    if (focusSibling(el, -1)) { e.preventDefault(); return true; }
  }
  if ((e.key === 'ArrowRight' && off >= end) || (e.key === 'ArrowDown' && onLast)) {
    if (focusSibling(el, 1)) { e.preventDefault(); return true; }
  }
  return false;
}

// ── Sync hook shared by both kinds of editable ────────────────────────────

function useDomSync(
  ref: React.RefObject<HTMLElement>,
  editId: string | undefined,
  syncKey: string,
  read: (el: HTMLElement) => string,
  write: (el: HTMLElement) => void,
  wanted: string,
) {
  const seen = useRef(syncVersion);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const focused = document.activeElement === el;
    const forced = seen.current !== syncVersion || dirty.has(syncKey);
    seen.current = syncVersion;
    if (!focused) {
      if (read(el) !== wanted) write(el);
    } else if (forced) {
      dirty.delete(syncKey);
      if (read(el) !== wanted) { write(el); setCaret(el, Number.MAX_SAFE_INTEGER); }
    }
    if (editId) applyPendingFocus(editId, el);
  });
}

// ── Rich line: one paragraph or list item ─────────────────────────────────

export function RichLine({
  live, editId, syncKey, html, vars, placeholder, style, className = '',
  onChange, onKeyDown, onPasteText, dataAttrs,
}: {
  /** False renders a static twin — used for the measuring pass. */
  live: boolean;
  editId?: string;
  syncKey: string;
  html: string;
  vars: Record<string, string>;
  placeholder?: string;
  style?: CSSProperties;
  className?: string;
  onChange?: (html: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>, el: HTMLElement) => void;
  onPasteText?: (text: string, el: HTMLElement) => void;
  dataAttrs?: Record<string, string>;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const display = toDisplayHtml(html, vars);
  const empty = !sanitizeInline(html);

  useDomSync(
    ref, editId, syncKey,
    (el) => (document.activeElement === el ? serializeInline(el) : el.innerHTML),
    (el) => { el.innerHTML = display; },
    document.activeElement === ref.current ? sanitizeInline(html) : display,
  );

  const cls = `el-line ${live ? 'el-edit' : ''} ${empty ? 'el-empty' : ''} ${className}`;
  if (!live) {
    return <p className={cls} style={style} data-placeholder={placeholder} dangerouslySetInnerHTML={{ __html: display }} />;
  }
  return (
    <p
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      data-edit-id={editId}
      data-rich="1"
      data-placeholder={placeholder}
      {...Object.fromEntries(Object.entries(dataAttrs ?? {}).map(([k, v]) => [`data-${k}`, v]))}
      className={cls}
      style={style}
      onInput={() => {
        const el = ref.current!;
        // Deleting everything leaves a lone <br>; clear it so the empty-line
        // hint can show.
        if (el.innerHTML === '<br>') el.innerHTML = '';
        onChange?.(serializeInline(el));
      }}
      onKeyDown={(e) => { if (!navigateKey(e, ref.current!)) onKeyDown?.(e, ref.current!); }}
      onPaste={(e) => {
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        if (onPasteText && /\r?\n/.test(text)) onPasteText(text, ref.current!);
        else document.execCommand('insertText', false, text);
      }}
      onBlur={() => bump()}
      onMouseDown={(e) => {
        // Clicking an auto-filled value makes it ordinary text right there, so
        // EVERYTHING on the page can be typed into. It stops following the
        // client's details from then on — the tooltip says so. A value that
        // is still missing has nothing to edit, so the caret goes beside it.
        const atom = (e.target as HTMLElement).closest?.('[data-ph]') as HTMLElement | null;
        const el = ref.current;
        if (!atom || !el?.contains(atom)) return;
        e.preventDefault();
        el.focus();
        const sel = window.getSelection();
        const r = document.createRange();
        if (atom.classList.contains('el-ph-missing')) {
          r.setStartAfter(atom);
          r.collapse(true);
          sel?.removeAllRanges();
          sel?.addRange(r);
          return;
        }
        // Where in the value was the click? Measured before the swap.
        const hit = document.caretRangeFromPoint?.(e.clientX, e.clientY);
        const text = atom.textContent ?? '';
        const at = hit && atom.contains(hit.startContainer) ? hit.startOffset : text.length;
        const node = document.createTextNode(text);
        atom.replaceWith(node);
        r.setStart(node, Math.min(at, text.length));
        r.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(r);
        onChange?.(serializeInline(el));
      }}
    />
  );
}

// ── Plain field: a name, a heading, an amount ─────────────────────────────

export function PlainField({
  live, editId, value, fallback, placeholder, multiline = false, as: Tag = 'span',
  style, className = '', onChange, onBlurValue, onKey,
}: {
  live: boolean;
  editId?: string;
  value: string;
  /** Shown when `value` is empty — e.g. the recipient's name on the signature. */
  fallback?: string;
  placeholder?: string;
  multiline?: boolean;
  as?: 'span' | 'div';
  style?: CSSProperties;
  className?: string;
  onChange?: (v: string) => void;
  /** Normalise on leaving the field (e.g. format an amount). */
  onBlurValue?: (v: string) => void;
  /** Handle a key first; return true to stop the default behaviour. */
  onKey?: (e: KeyboardEvent<HTMLElement>, el: HTMLElement) => boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const shown = value || fallback || '';
  // U+00A0 is how a browser keeps a typed trailing space visible — not data.
  const read = (el: HTMLElement) =>
    (multiline ? el.innerText.replace(/\n$/, '') : el.textContent ?? '').replace(/\u00a0/g, ' ');

  useDomSync(
    ref, editId, editId ?? '',
    read,
    (el) => { if (multiline) el.innerText = shown; else el.textContent = shown; },
    document.activeElement === ref.current ? value : shown,
  );

  const cls = `${live ? 'el-edit' : ''} ${shown ? '' : 'el-empty'} ${className}`;
  const ws: CSSProperties = multiline ? { whiteSpace: 'pre-line' } : {};
  if (!live) return <Tag className={cls} style={{ ...ws, ...style }} data-placeholder={placeholder}>{shown}</Tag>;
  return (
    <Tag
      ref={ref as never}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      data-edit-id={editId}
      data-placeholder={placeholder}
      className={cls}
      style={{ ...ws, ...style }}
      onInput={() => onChange?.(read(ref.current!))}
      onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
        if (onKey?.(e, ref.current!)) return;
        if (navigateKey(e, ref.current!)) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          if (multiline) document.execCommand('insertLineBreak');
          else focusSibling(ref.current!, 1);
        }
      }}
      onPaste={(e: React.ClipboardEvent<HTMLElement>) => {
        e.preventDefault();
        const t = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, multiline ? t : t.replace(/\s*\r?\n\s*/g, ' '));
      }}
      onBlur={() => { onBlurValue?.(read(ref.current!)); bump(); }}
    />
  );
}

// ── Date: shown as text, edited with the native picker ────────────────────

export function DateField({ live, value, display, onChange, style }: {
  live: boolean;
  value: string;
  display: string;
  onChange?: (iso: string) => void;
  style?: CSSProperties;
}) {
  const input = useRef<HTMLInputElement>(null);
  if (!live) return <span style={style}>{display}</span>;
  return (
    <span className="relative inline-block" style={style}>
      <button
        type="button"
        className="el-edit el-date"
        onClick={() => { const i = input.current; if (!i) return; try { i.showPicker(); } catch { i.focus(); } }}
        title="Change the date"
      >
        {display || 'Choose a date'}
      </button>
      {/* The real control: visually hidden, never laid over the text. */}
      <input
        ref={input}
        type="date"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        tabIndex={-1}
        aria-label="Letter date"
        className="absolute inset-0 opacity-0 pointer-events-none"
      />
    </span>
  );
}

export { textToInline };
