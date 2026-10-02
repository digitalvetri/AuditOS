import { useEffect, useState } from 'react';

/**
 * True below Tailwind's `md` breakpoint — the same 767px boundary the mobile
 * CSS layer uses, kept in one place so a structural switch in a component and
 * a style rule can never disagree about what "mobile" means.
 *
 * Structure-only. Anything that can be expressed as a responsive class should
 * be a class; this is for the cases where the phone needs a genuinely
 * different tree (a list *or* a thread, never both) rather than the same tree
 * restyled.
 */
const QUERY = '(max-width: 767px)';

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // Sync once on mount: the first render may have run before hydration
    // settled, and rotating the device fires change rather than a remount.
    setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
