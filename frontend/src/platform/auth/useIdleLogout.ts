import { useEffect, useRef } from 'react';

/**
 * Sign the user out after a period with no activity (mouse, keyboard, touch,
 * or coming back to the tab). The server keeps its own 8-hour absolute limit;
 * this is the shorter, idle limit for an unattended office PC.
 *
 * The last-activity time lives in localStorage, so working in any tab keeps
 * every tab alive, and timers throttled in a background tab are corrected by
 * comparing timestamps rather than counting ticks.
 */
export const IDLE_LIMIT_MS = 30 * 60_000;
export const IDLE_WARNING_MS = 60_000;

const KEY = 'ao_last_activity';
const WRITE_EVERY_MS = 15_000;
const CHECK_EVERY_MS = 15_000;

function readLast(): number {
  try {
    const v = Number(window.localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

function writeLast(at: number): void {
  try { window.localStorage.setItem(KEY, String(at)); } catch { /* private mode: memory only */ }
}

export function useIdleLogout(opts: {
  enabled: boolean;
  onWarn: () => void;
  onTimeout: () => void;
}) {
  const { enabled } = opts;
  // Latest callbacks without re-binding listeners on every render.
  const cb = useRef(opts);
  cb.current = opts;

  useEffect(() => {
    if (!enabled) return;
    let last = Date.now();
    let warned = false;
    let fired = false;
    writeLast(last);

    const lastActivity = () => Math.max(last, readLast());

    const check = (): boolean => {
      if (fired) return true;
      const idle = Date.now() - lastActivity();
      if (idle >= IDLE_LIMIT_MS) {
        fired = true;
        cb.current.onTimeout();
        return true;
      }
      if (idle >= IDLE_LIMIT_MS - IDLE_WARNING_MS) {
        if (!warned) { warned = true; cb.current.onWarn(); }
      } else {
        warned = false;
      }
      return false;
    };

    const markActive = () => {
      const now = Date.now();
      warned = false;
      if (now - last >= WRITE_EVERY_MS || readLast() < last) writeLast(now);
      last = now;
    };

    const onActivity = () => {
      // Returning after the limit must not count as activity first.
      if (check()) return;
      markActive();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onActivity();
    };

    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'];
    for (const e of events) window.addEventListener(e, onActivity, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(check, CHECK_EVERY_MS);

    return () => {
      for (const e of events) window.removeEventListener(e, onActivity);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
    };
  }, [enabled]);
}
