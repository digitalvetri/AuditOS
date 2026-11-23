/**
 * A picked service → the words of an engagement letter. Uses only the
 * letter's ordinary blocks (a titled section of plain and bulleted lines) so
 * every template, the editor and the PDF render it as they render any other
 * section, and the text is the letter's own from then on.
 */
import { escapeHtml, newLine, type EBlock, type Line } from '@/modules/workstation/engagement/document';
import { KINDS, KIND_LABEL, type ItemKind, type ServiceScope } from './api';

export interface ScopeExtras {
  /** Client-specific timeline, e.g. "GSTR-1 by the 11th, GSTR-3B by the 20th". */
  timeline: string;
  /** Information the client must provide — one per line. */
  information: string;
  /** Extra deliverables / exclusions for this client — one per line. */
  deliverables: string;
  exclusions: string;
}
export const EMPTY_EXTRAS: ScopeExtras = { timeline: '', information: '', deliverables: '', exclusions: '' };

const lines = (t: string) => t.split('\n').map((x) => x.trim()).filter(Boolean);
const heading = (t: string): Line => newLine({ kind: 'p', align: 'left', html: `<b>${escapeHtml(t)}</b>` });
const bullet = (t: string): Line => newLine({ kind: 'bullet', align: 'left', html: escapeHtml(t) });

/** The lines under one service's heading, in the document's order. */
export function scopeLines(scope: ServiceScope, extras: ScopeExtras = EMPTY_EXTRAS): Line[] {
  const by = (k: ItemKind) => scope.items.filter((i) => i.kind === k).map((i) => i.content);
  const extra: Partial<Record<ItemKind, string[]>> = { deliverable: lines(extras.deliverables), exclusion: lines(extras.exclusions) };
  const out: Line[] = [];
  for (const k of KINDS) {
    if (k === 'note') continue;
    const items = [...by(k), ...(extra[k] ?? [])];
    if (k === 'responsibility' && lines(extras.information).length) {
      items.push(...lines(extras.information).map((x) => `Provide: ${x}`));
    }
    if (!items.length) continue;
    out.push(heading(KIND_LABEL[k]));
    out.push(...items.map(bullet));
  }
  if (extras.timeline.trim()) {
    out.push(heading('Timeline'));
    out.push(newLine({ kind: 'p', align: 'left', html: escapeHtml(extras.timeline.trim()) }));
  }
  for (const n of by('note')) out.push(newLine({ kind: 'p', align: 'justify', html: `<i>Important note: ${escapeHtml(n)}</i>` }));
  return out;
}

export function scopeBlock(id: string, scope: ServiceScope, extras: ScopeExtras): EBlock {
  return { id, key: 'section', enabled: true, title: scope.name, lines: scopeLines(scope, extras) };
}

/** "Monthly" → "per month", as the fee table words it. */
export function feeFrequency(billing: string | null): string {
  const map: Record<string, string> = {
    Monthly: 'per month', Quarterly: 'per quarter', 'Half-yearly': 'per half-year', Yearly: 'per year',
    'One-time': 'one-time', 'Per return': 'per return', 'Per application': 'per application',
  };
  return billing ? (map[billing] ?? billing) : '';
}
