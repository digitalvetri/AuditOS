/**
 * Print the rendered document — and only the document — from any screen,
 * whether through a Print / Download button or the browser's own Ctrl+P.
 *
 * On `beforeprint` the `.qdoc-stack` is copied to a top-level
 * `.qdoc-print-root` and the rest of the app is taken out of the print
 * layout (globals.css). Printed in place it depended on the CRM shell's
 * layout: the builders printed a blank sheet, and on /preview the page sat
 * below the toolbar padding so its footer spilled onto a second sheet, which
 * `break-after` then followed with a blank third.
 *
 * The copy also pins the paper: `@page` gets the document's own page size
 * (A4, or Letter where a letter is laid out on Letter), so a browser whose
 * default paper is different does not shrink the sheet under an A4 page;
 * and each copied page is fixed to exactly one sheet, so sub-pixel growth
 * can never push a footer onto an extra, otherwise blank, sheet.
 *
 * The copy is plain DOM outside React's tree and is removed on `afterprint`.
 */
const ROOT = 'qdoc-print-root';
const PAGE_STYLE = 'qdoc-print-page-size';

function prepare(): void {
  if (document.querySelector(`.${ROOT}`)) return;
  const stack = document.querySelector<HTMLElement>('.qdoc-stack');
  if (!stack) return;

  const copy = stack.cloneNode(true) as HTMLElement;
  // The live preview may be scaled down to fit its column; paper is 1:1.
  copy.style.transform = 'none';
  copy.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'));
  // A page that overshoots its sheet by a hair (rounding) is held to exactly
  // one sheet. A page whose content really is longer is left to run on:
  // clipping it would silently drop text, which is worse than a second sheet.
  const live = stack.querySelectorAll<HTMLElement>('.qdoc-page');
  copy.querySelectorAll<HTMLElement>('.qdoc-page').forEach((p, i) => {
    const h = p.style.minHeight;
    const sheetPx = h.endsWith('mm') ? (parseFloat(h) * 96) / 25.4 : h.endsWith('px') ? parseFloat(h) : 0;
    const actualPx = live[i]?.offsetHeight ?? 0;
    if (!sheetPx || actualPx - sheetPx > 8) return;
    p.style.height = p.style.minHeight;
    p.style.overflow = 'hidden';
    const body = p.querySelector<HTMLElement>('.qdoc-body');
    if (body) { body.style.minHeight = '0'; body.style.overflow = 'hidden'; }
  });

  const root = document.createElement('div');
  root.className = ROOT;
  root.appendChild(copy);
  document.body.appendChild(root);

  const first = stack.querySelector<HTMLElement>('.qdoc-page');
  if (first?.style.width && first.style.minHeight) {
    const style = document.createElement('style');
    style.id = PAGE_STYLE;
    style.textContent = `@page { size: ${first.style.width} ${first.style.minHeight}; margin: 0; }`;
    document.head.appendChild(style);
  }
  document.documentElement.classList.add('qdoc-printing');
}

function cleanup(): void {
  document.documentElement.classList.remove('qdoc-printing');
  document.querySelectorAll(`.${ROOT}`).forEach((el) => el.remove());
  document.getElementById(PAGE_STYLE)?.remove();
}

let installed = false;
/** Hook every print of the app, once, at startup (main.tsx). */
export function installDocumentPrint(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('beforeprint', prepare);
  window.addEventListener('afterprint', cleanup);
}

/** The Print / Download PDF buttons. */
export function printDocumentOnly(): void {
  // Prepared here too: not every browser fires beforeprint for window.print().
  prepare();
  window.print();
}
