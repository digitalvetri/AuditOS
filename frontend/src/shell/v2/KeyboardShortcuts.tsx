/**
 * App-wide keyboard shortcuts (mounted once in the AppShell):
 *
 *   /      focus the global search
 *   g d    Dashboard        g c  Clients       g i  Invoices
 *   g a    Audits           g p  Compliance
 *   ?      this list
 *
 * Ignored while typing in a field, and when a modifier key is held (so
 * ⌘K, Ctrl+F and the browser's own shortcuts are untouched).
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '@/modules/workstation/components';

const GO: Record<string, { to: string; label: string }> = {
  d: { to: '/', label: 'Dashboard' },
  c: { to: '/workstation/clients', label: 'Clients' },
  i: { to: '/workstation/invoices', label: 'Invoices' },
  a: { to: '/workstation/audits', label: 'Audits' },
  p: { to: '/workstation/compliance', label: 'Compliance calendar' },
};

function typing(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
  }
  return false;
}

export function KeyboardShortcuts() {
  const navigate = useNavigate();
  const [help, setHelp] = useState(false);
  const pendingG = useRef<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      // Any open dialog owns the keyboard.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const key = e.key;

      if (pendingG.current !== null) {
        window.clearTimeout(pendingG.current);
        pendingG.current = null;
        const dest = GO[key.toLowerCase()];
        if (dest) { e.preventDefault(); navigate(dest.to); }
        return;
      }
      if (key === 'g') {
        pendingG.current = window.setTimeout(() => { pendingG.current = null; }, 1200);
        return;
      }
      if (key === '/') {
        const box = document.querySelector<HTMLInputElement>('[data-testid="global-search"]');
        if (box && box.offsetParent !== null) { e.preventDefault(); box.focus(); box.select(); }
        return;
      }
      if (key === '?') { e.preventDefault(); setHelp((h) => !h); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (pendingG.current !== null) window.clearTimeout(pendingG.current);
    };
  }, [navigate]);

  const rows: [string[], string][] = [
    [['/'], 'Search'],
    [['⌘', 'K'], 'Search (anywhere, even while typing)'],
    ...Object.entries(GO).map(([k, v]) => [['g', k], `Go to ${v.label}`] as [string[], string]),
    [['?'], 'Show these shortcuts'],
    [['Esc'], 'Close a dialog or the search'],
  ];

  return (
    <Modal open={help} title="Keyboard shortcuts" onClose={() => setHelp(false)} width="w-[440px]">
      <dl className="divide-y divide-neutral-200">
        {rows.map(([keys, label]) => (
          <div key={label} className="flex items-center gap-3 py-2">
            <dt className="flex gap-1 w-[96px] shrink-0">
              {keys.map((k) => <kbd key={k} className="gs-kbd">{k}</kbd>)}
            </dt>
            <dd className="text-13 text-neutral-700">{label}</dd>
          </div>
        ))}
      </dl>
      <p className="text-12 text-neutral-500 mt-3">Shortcuts are off while you are typing in a field. Press the two keys of a “g” shortcut one after the other.</p>
    </Modal>
  );
}
