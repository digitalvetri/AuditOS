import { useLayoutEffect, type RefObject } from 'react';

/**
 * Builders (quotation / invoice / engagement letter): the document column
 * stays pinned below the sticky `.qb-head` while the form on the left
 * scrolls, and scrolls on its own inside the space that is left.
 *
 * The header's height changes with the window width (its buttons wrap), so it
 * is measured rather than guessed. Writes two CSS variables on the root that
 * `.qb-side` (globals.css) reads:
 *   --qb-side-top  where the column sticks, just under the header
 *   --qb-side-h    the height from there to the bottom of the window
 * Screen only: print resets `.qb-side` to normal flow.
 */
export function useStickyPreview(rootRef: RefObject<HTMLElement>, ready = true) {
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !ready) return;
    const head = root.querySelector<HTMLElement>('.qb-head');

    // The nearest scrolling ancestor (the shell's <main>); null = the window.
    let scroller: HTMLElement | null = root.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;

    const measure = () => {
      const headTop = head ? parseFloat(getComputedStyle(head).top) || 0 : 0;
      const top = Math.max(0, (head?.offsetHeight ?? 0) + headTop + 8);
      const scrollerTop = scroller ? Math.max(0, scroller.getBoundingClientRect().top) : 0;
      root.style.setProperty('--qb-side-top', `${top}px`);
      root.style.setProperty('--qb-side-h', `${Math.max(320, window.innerHeight - scrollerTop - top - 40)}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (head) ro.observe(head);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [rootRef, ready]);
}
