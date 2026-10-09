import { useContext, useEffect, useRef } from 'react';
import { UNSAFE_NavigationContext, useLocation } from 'react-router-dom';

/**
 * Warn before leaving a builder with unsaved edits.
 *
 * The app runs on <BrowserRouter>, where react-router's `useBlocker` is not
 * available (it needs a data router). So this guards the two ways out that
 * it can see:
 *   - in-app navigation (links, navigate()) — by wrapping the router's
 *     navigator push/replace while the builder is mounted;
 *   - closing / reloading the tab — `beforeunload`.
 * The browser's own Back button (popstate) is not intercepted.
 *
 * Dirty = the form's `snapshot` differs from its baseline. Until the person
 * first types, picks or ticks something inside the page (<main>), whatever
 * the form holds IS the baseline — that absorbs defaults filled in by effects
 * after load, so a just-opened builder never warns. Call `markSaved()` once a
 * save succeeds (before navigating away), or `allowNavigation()` for a flow
 * that deliberately discards the edits.
 */
export function useUnsavedChangesGuard(
  snapshot: unknown,
  opts: { ready?: boolean; message?: string } = {},
) {
  const ready = opts.ready ?? true;
  const message = opts.message ?? 'You have unsaved changes. Leave this page and lose them?';
  const current = ready ? JSON.stringify(snapshot ?? null) : null;
  const currentRef = useRef(current);
  currentRef.current = current;
  const baseline = useRef<string | null>(null);
  const touched = useRef(false);
  const bypass = useRef(false);
  if (ready && !touched.current) baseline.current = current;

  // The same builder can stay mounted across routes (/new → /:id/edit): a
  // new page means a fresh guard.
  const { pathname } = useLocation();
  useEffect(() => { bypass.current = false; }, [pathname]);

  const isDirty = () =>
    !bypass.current && touched.current && currentRef.current !== null && currentRef.current !== baseline.current;

  // First real edit inside the page content ends the auto-baseline.
  useEffect(() => {
    const mark = (e: Event) => {
      const main = document.getElementById('main');
      if (!main || (e.target instanceof Node && main.contains(e.target))) touched.current = true;
    };
    document.addEventListener('input', mark, true);
    document.addEventListener('change', mark, true);
    return () => {
      document.removeEventListener('input', mark, true);
      document.removeEventListener('change', mark, true);
    };
  }, []);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { navigator } = useContext(UNSAFE_NavigationContext);
  const messageRef = useRef(message);
  messageRef.current = message;
  useEffect(() => {
    const nav = navigator as unknown as { push: (...a: unknown[]) => void; replace: (...a: unknown[]) => void };
    const { push, replace } = nav;
    const guard = (fn: (...a: unknown[]) => void) => (...args: unknown[]) => {
      const to = args[0] as string | { pathname?: string } | undefined;
      const path = typeof to === 'string' ? to.split(/[?#]/)[0] : to?.pathname;
      // Staying on this page (its own search params) is never "leaving".
      const staying = !path || path === window.location.pathname;
      if (staying || !isDirty() || window.confirm(messageRef.current)) {
        if (!staying) bypass.current = true;
        fn.apply(nav, args);
      }
    };
    nav.push = guard(push);
    nav.replace = guard(replace);
    return () => {
      nav.push = push;
      nav.replace = replace;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigator]);

  return {
    isDirty,
    /** The current form is what the server now holds. */
    markSaved: () => { baseline.current = currentRef.current; touched.current = false; },
    /** Let the next navigation through without asking. */
    allowNavigation: () => { bypass.current = true; },
  };
}
