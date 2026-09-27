/**
 * Measurements for the document page-breakers (quotation, invoice,
 * engagement letter, statutory docs).
 *
 * They used `getBoundingClientRect().height`, which is measured AFTER CSS
 * transforms. In the builders the document sits in a preview scaled to fit
 * its column (~0.6), so every block measured ~60% of its real height, far
 * more was packed onto a page than fits, and the page's last lines ran onto
 * the next sheet. Rects also left out the spacing between blocks.
 *
 * `offsetTop` / `offsetHeight` are layout values, untouched by transforms,
 * and the distance from one unit's top to the next unit's top includes the
 * margins between them.
 */
export function unitHeights(root: HTMLElement, attr: 'unit' | 'block'): Map<string, number> {
  const els = [...root.querySelectorAll<HTMLElement>(`[data-${attr}]`)];
  const out = new Map<string, number>();
  els.forEach((el, i) => {
    const next = els[i + 1];
    const h = next && next.offsetParent === el.offsetParent ? next.offsetTop - el.offsetTop : el.offsetHeight;
    out.set(el.dataset[attr]!, Math.max(h, el.offsetHeight));
  });
  return out;
}

/**
 * Room the page footer ("Page 1 of 2", or the firm name) takes inside the
 * page's content box, so body content is never broken as if it had the whole
 * height to itself. Read from a rendered footer; 0 when the layout has none.
 */
export function footerReservePx(pagesRoot: HTMLElement | null): number {
  const f = pagesRoot?.querySelector<HTMLElement>('.qdoc-footer');
  if (!f) return 0;
  return f.offsetHeight + (parseFloat(getComputedStyle(f).marginTop) || 0);
}
