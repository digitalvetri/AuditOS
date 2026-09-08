import { useCallback, useEffect, useState } from 'react';

/**
 * Light / dark theme. The palette lives in src/design/globals.css as CSS
 * variables; switching is one attribute on <html>. index.html applies the
 * saved choice before first paint, this hook keeps it in sync afterwards.
 */
export type Theme = 'light' | 'dark';
const KEY = 'audit-os:theme';

export function readTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
  try { localStorage.setItem(KEY, theme); } catch { /* private mode */ }
}

export function useTheme(): { theme: Theme; toggle: () => void; set: (t: Theme) => void } {
  const [theme, setTheme] = useState<Theme>(() => (typeof document === 'undefined' ? 'light' : readTheme()));
  useEffect(() => { applyTheme(theme); }, [theme]);
  const set = useCallback((t: Theme) => setTheme(t), []);
  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return { theme, toggle, set };
}
