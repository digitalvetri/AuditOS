/**
 * Inline rich text for engagement-letter lines — the DOM side.
 *
 * Stored form: inline HTML limited to b, i, u and br, with {{placeholders}}
 * as literal text. Everything that reaches the page goes through
 * `sanitizeInline`, which REBUILDS markup from a whitelist rather than
 * filtering it — so whatever was saved, nothing but those four tags and text
 * can ever be injected, and the letter cannot carry a script.
 *
 * Placeholders are shown as non-editable atoms holding the resolved value and
 * are turned back into {{tokens}} on the way out. That is what lets a user
 * type freely around "ABC Private Limited" without ever overwriting the
 * {{company_name}} it stands for.
 */

const TAG: Record<string, string> = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u' };
const BLOCKISH = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4']);

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function rebuild(node: Node, out: string[]): void {
  node.childNodes.forEach((n) => {
    // Browsers type a trailing space as U+00A0 so it stays visible; store an
    // ordinary space, or the saved text would never match what was meant.
    if (n.nodeType === Node.TEXT_NODE) { out.push(esc((n.textContent ?? '').replace(/\u00a0/g, ' '))); return; }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    if (el.dataset?.ph) { out.push(`{{${el.dataset.ph}}}`); return; }
    if (el.tagName === 'BR') { out.push('<br>'); return; }
    // A stray block element (from a paste or a browser's own Enter) becomes
    // a line break: a line is ONE paragraph, and its structure lives in data.
    if (BLOCKISH.has(el.tagName) && out.length && out[out.length - 1] !== '<br>') out.push('<br>');
    const tag = TAG[el.tagName];
    if (tag) out.push(`<${tag}>`);
    rebuild(el, out);
    if (tag) out.push(`</${tag}>`);
  });
}

/** Whitelist-rebuild inline HTML. Idempotent: sanitize(sanitize(x)) === sanitize(x). */
export function sanitizeInline(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const out: string[] = [];
  rebuild(doc.body.firstChild ?? doc.body, out);
  let s = out.join('').replace(/<(b|i|u)><\/\1>/g, '');
  // A trailing <br> is the browser's placeholder for an empty line, not content.
  s = s.replace(/(<br>)+$/, '');
  return s;
}

/** Stored → displayed: sanitized, with {{tokens}} as atoms holding their values. */
/** Where each placeholder's value is set — shown when hovering over it. */
const SOURCE: Record<string, string> = {
  company_name: 'the Company name in the recipient details',
  client_name: 'the Contact person in the recipient details',
  contact_person: 'the Contact person in the recipient details',
  designation: 'the Designation in the recipient details',
  financial_year: 'Financial year in Letter details (left)',
  effective_from: 'Effective from in Letter details (left)',
  effective_until: 'Effective until in Letter details (left)',
  firm_name: 'the firm name in the letterhead',
};

export function toDisplayHtml(html: string, vars: Record<string, string>): string {
  return sanitizeInline(html).replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => {
    const v = vars[k];
    const label = v ? esc(v) : `{{${k}}}`;
    const tip = esc(v
      ? `Filled in automatically from ${SOURCE[k] ?? k}. Click to edit it here instead — it will then stop updating automatically.`
      : `Not filled in yet — set ${SOURCE[k] ?? k}.`);
    return `<span data-ph="${k}" contenteditable="false" title="${tip}" class="el-ph${v ? '' : ' el-ph-missing'}">${label}</span>`;
  });
}

/** An editable element's content back to its stored form. */
export function serializeInline(root: Node): string {
  const out: string[] = [];
  rebuild(root, out);
  return sanitizeInline(out.join(''));
}

// ── Caret, measured in "units" ───────────────────────────────────────────
// A text character is one unit; a placeholder atom or a <br> is one unit.
// Counting atoms as single units keeps the caret from ever landing inside
// one, and makes an offset survive a re-render that changes the atom's text.

function unitLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').length;
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement;
    if (el.dataset?.ph || el.tagName === 'BR') return 1;
  } else if (node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
    return 0;
  }
  // Elements AND document fragments are containers. `caretOffset` measures a
  // cloned range, which is a DocumentFragment — skipping fragments made every
  // caret read as offset 0, so each Backspace looked like "at the start of
  // the paragraph" and was taken over instead of deleting a character.
  let n = 0;
  node.childNodes.forEach((c) => { n += unitLength(c); });
  return n;
}

export function caretOffset(el: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  return unitLength(pre.cloneContents());
}

export function setCaret(el: HTMLElement, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let left = Math.max(0, offset);
  let placed = false;

  const walk = (node: Node): void => {
    if (placed) return;
    for (const c of Array.from(node.childNodes)) {
      if (placed) return;
      if (c.nodeType === Node.TEXT_NODE) {
        const len = (c.textContent ?? '').length;
        if (left <= len) { range.setStart(c, left); placed = true; return; }
        left -= len;
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        const e = c as HTMLElement;
        if (e.dataset?.ph || e.tagName === 'BR') {
          if (left === 0) { range.setStartBefore(e); placed = true; return; }
          left -= 1;
          if (left === 0) { range.setStartAfter(e); placed = true; return; }
        } else {
          walk(e);
        }
      }
    }
  };
  walk(el);
  if (!placed) { range.selectNodeContents(el); range.collapse(false); }
  else range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

export const unitsIn = (el: HTMLElement) => unitLength(el);

/**
 * Split an element's content at the caret into [before, after], both in
 * stored form. A non-collapsed selection is deleted first, as Enter does in
 * any editor.
 */
export function splitAtCaret(el: HTMLElement): [string, string] {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !el.contains(sel.getRangeAt(0).startContainer)) {
    return [serializeInline(el), ''];
  }
  const r = sel.getRangeAt(0);
  if (!r.collapsed) r.deleteContents();
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset);
  const post = document.createRange();
  post.selectNodeContents(el);
  post.setStart(r.startContainer, r.startOffset);
  const wrap = (f: DocumentFragment) => { const d = document.createElement('div'); d.appendChild(f); return serializeInline(d); };
  return [wrap(pre.cloneContents()), wrap(post.cloneContents())];
}

/** Plain text → stored inline form (for paste). */
export const textToInline = (t: string) => esc(t);
