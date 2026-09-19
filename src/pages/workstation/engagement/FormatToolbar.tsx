import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, IndentDecrease, IndentIncrease, Italic,
  List, ListOrdered, Underline,
} from 'lucide-react';
import type { Align, Line } from '@/modules/workstation/engagement/document';

/**
 * The contextual format bar — shown only while a paragraph is being edited,
 * floating just above it. Never a permanent toolbar over the page.
 *
 * Bold / italic / underline act on the selection (native editing, so native
 * undo inside the line keeps working). List, alignment and indent act on the
 * whole paragraph, as in any word processor — they are paragraph DATA, which
 * is what lets the PDF reproduce them exactly.
 */
export function FormatToolbar({ getLine, setLine }: {
  getLine: (blockId: string, lineId: string) => Line | undefined;
  setLine: (blockId: string, lineId: string, patch: Partial<Line>) => void;
}) {
  const [target, setTarget] = useState<{ el: HTMLElement; block: string; line: string } | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    const pick = () => {
      const a = document.activeElement as HTMLElement | null;
      if (a?.dataset.rich === '1' && a.dataset.block && a.dataset.line) {
        setTarget({ el: a, block: a.dataset.block, line: a.dataset.line });
        const r = a.getBoundingClientRect();
        setPos({ top: Math.max(8, r.top - 42), left: Math.min(Math.max(8, r.left), window.innerWidth - 400) });
      } else {
        setTarget(null);
      }
      tick((n) => n + 1); // refresh B/I/U active states
    };
    const events: [string, boolean][] = [['focusin', false], ['focusout', false], ['selectionchange', false], ['scroll', true], ['resize', false], ['input', false]];
    events.forEach(([ev, cap]) => document.addEventListener(ev, pick, cap));
    window.addEventListener('resize', pick);
    return () => {
      events.forEach(([ev, cap]) => document.removeEventListener(ev, pick, cap));
      window.removeEventListener('resize', pick);
    };
  }, []);

  if (!target || !pos) return null;
  const line = getLine(target.block, target.line);
  if (!line) return null;

  const exec = (cmd: string) => {
    document.execCommand('styleWithCSS', false, 'false');
    document.execCommand(cmd);
  };
  const state = (cmd: string) => { try { return document.queryCommandState(cmd); } catch { return false; } };
  const set = (patch: Partial<Line>) => setLine(target.block, target.line, patch);
  const toggleKind = (k: 'bullet' | 'number') =>
    set(line.kind === k ? { kind: 'p', align: 'justify' } : { kind: k, align: line.align === 'justify' ? 'left' : line.align });

  const btn = (active: boolean) =>
    `h-7 w-7 inline-flex items-center justify-center rounded ${active ? 'bg-neutral-900 text-white' : 'text-neutral-700 hover:bg-neutral-100'}`;
  const sep = <span className="w-px h-5 bg-neutral-200 mx-0.5" />;
  const aligns: [Align, typeof AlignLeft, string][] = [
    ['left', AlignLeft, 'Align left'], ['center', AlignCenter, 'Centre'],
    ['right', AlignRight, 'Align right'], ['justify', AlignJustify, 'Justify'],
  ];

  return createPortal(
    <div
      role="toolbar"
      aria-label="Text formatting"
      className="fixed z-50 flex items-center gap-0.5 px-1 py-1 bg-white border border-neutral-200 rounded-md shadow-lg"
      style={{ top: pos.top, left: pos.left }}
      // Keep the caret in the paragraph: toolbar clicks must not take focus.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" className={btn(state('bold'))} title="Bold (Ctrl+B)" onClick={() => exec('bold')}><Bold size={14} /></button>
      <button type="button" className={btn(state('italic'))} title="Italic (Ctrl+I)" onClick={() => exec('italic')}><Italic size={14} /></button>
      <button type="button" className={btn(state('underline'))} title="Underline (Ctrl+U)" onClick={() => exec('underline')}><Underline size={14} /></button>
      {sep}
      <button type="button" className={btn(line.kind === 'bullet')} title="Bullet list" onClick={() => toggleKind('bullet')}><List size={14} /></button>
      <button type="button" className={btn(line.kind === 'number')} title="Numbered list" onClick={() => toggleKind('number')}><ListOrdered size={14} /></button>
      {sep}
      {aligns.map(([a, Icon, t]) => (
        <button key={a} type="button" className={btn(line.align === a)} title={t} onClick={() => set({ align: a })}><Icon size={14} /></button>
      ))}
      {sep}
      <button type="button" className={btn(false)} title="Decrease indent (Shift+Tab)" disabled={line.indent === 0}
        onClick={() => set({ indent: Math.max(0, line.indent - 1) })}><IndentDecrease size={14} /></button>
      <button type="button" className={btn(false)} title="Increase indent (Tab)" disabled={line.indent >= 4}
        onClick={() => set({ indent: Math.min(4, line.indent + 1) })}><IndentIncrease size={14} /></button>
    </div>,
    document.body,
  );
}
