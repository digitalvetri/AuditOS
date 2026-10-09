/**
 * Shared bits for the compliance calendar, notices register, DSC register
 * and 26AS reconciliation: deadline chips, the due-date cell, assignee and
 * client pickers, CSV download. Tones are the listUi chip tones, so these
 * read as the same family as every other Workstation register.
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { workstationApi } from '@/modules/workstation/api';
import { fmtDate } from '@/lib/format';
import { istToday } from '@/modules/dashboardV2/brief';

// ── Tones (same values as listUi's StatusChip) ───────────────────────────

export type ChipTone = 'grey' | 'blue' | 'green' | 'amber' | 'red';
const TONES: Record<ChipTone, { bg: string; fg: string; dot: string }> = {
  grey: { bg: '#f1f5f9', fg: '#475569', dot: '#94a3b8' },
  blue: { bg: '#f5f1ff', fg: '#5b33c4', dot: '#7a5af8' },
  green: { bg: '#ecfdf5', fg: '#047857', dot: '#10b981' },
  amber: { bg: '#fffbeb', fg: '#b45309', dot: '#f59e0b' },
  red: { bg: '#fef2f2', fg: '#b91c1c', dot: '#ef4444' },
};

export function Chip({ tone = 'grey', title, children, dot = true }: {
  tone?: ChipTone; title?: string; children: ReactNode; dot?: boolean;
}) {
  const t = TONES[tone];
  return (
    <span title={title} className="inline-flex items-center gap-1 h-6 px-2 rounded-full text-12 font-medium whitespace-nowrap"
      style={{ background: t.bg, color: t.fg }}>
      {dot ? <span className="rounded-full" style={{ background: t.dot, width: 6, height: 6 }} aria-hidden /> : null}
      {children}
    </span>
  );
}

// ── Dates (all calendar dates are 'YYYY-MM-DD', compared as strings, IST) ──

/** Whole days from IST today to `iso` (negative = past). */
export function daysUntil(iso: string | null | undefined, today = istToday()): number | null {
  if (!iso) return null;
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** '06 Sep 2026' for a 'YYYY-MM-DD' (or ISO) string; '—' when empty. */
export function day(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00+05:30` : iso);
  return Number.isNaN(d.getTime()) ? iso : fmtDate(d);
}

/**
 * Days left / overdue. `urgentAt` turns the chip red at or below that many
 * days (notices: 3); `soonAt` turns it amber.
 */
export function DaysChip({ days, done, urgentAt = 0, soonAt = 7 }: {
  days: number | null | undefined; done?: boolean; urgentAt?: number; soonAt?: number;
}) {
  if (done) return <Chip tone="green">Done</Chip>;
  if (days === null || days === undefined) return <span className="text-neutral-400">—</span>;
  if (days < 0) return <Chip tone="red">{-days}d overdue</Chip>;
  if (days === 0) return <Chip tone="red">Due today</Chip>;
  const tone: ChipTone = days <= urgentAt ? 'red' : days <= soonAt ? 'amber' : 'grey';
  return <Chip tone={tone}>{days}d left</Chip>;
}

/** Due date with the extension shown: statutory struck through, badge with the reference. */
export function DueDate({ due, statutory, extension }: {
  due: string; statutory?: string | null;
  extension?: { reference?: string | null; source_url?: string | null } | null;
}) {
  const extended = Boolean(extension) && statutory && statutory !== due;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="font-medium text-neutral-900 whitespace-nowrap">{day(due)}</span>
      {extended ? (
        <>
          <s className="text-11 text-neutral-400 whitespace-nowrap" title="Statutory due date">{day(statutory)}</s>
          {extension?.source_url ? (
            <a href={extension.source_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
              title={extension.reference ?? 'Extended'}>
              <Chip tone="blue" dot={false}>Extended</Chip>
            </a>
          ) : (
            <Chip tone="blue" dot={false} title={extension?.reference ?? 'Extended'}>Extended</Chip>
          )}
        </>
      ) : null}
    </span>
  );
}

// ── Pickers ──────────────────────────────────────────────────────────────

export function useAssignees(enabled = true) {
  const q = useQuery({
    queryKey: ['workstation', 'assignable-employees'],
    queryFn: () => workstationApi.assignableEmployees(),
    enabled,
    staleTime: 300_000,
  });
  const options = (q.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name }));
  const nameOf = (id: string | null | undefined) => (id ? options.find((o) => o.value === id)?.label ?? null : null);
  return { options, nameOf, loading: q.isLoading };
}

export interface ClientOption { value: string; label: string; code: string; entity: string | null }

export function useClientOptions(enabled = true) {
  const q = useQuery({
    queryKey: ['workstation', 'clients', 'all-for-pickers'],
    queryFn: () => workstationApi.listClients({}),
    enabled,
    staleTime: 300_000,
  });
  const options: ClientOption[] = (q.data?.items ?? [])
    .map((c) => ({ value: c.id, label: c.company_name, code: c.client_id, entity: c.business_type ?? null }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { options, loading: q.isLoading };
}

// ── Form controls (same look as listUi / workstation inputs) ─────────────

export const fieldClass =
  'block w-full h-9 px-3 text-13 bg-white text-neutral-900 border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/10';

export function Labelled({ label, children, hint, className = '' }: {
  label: string; children: ReactNode; hint?: ReactNode; className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-12 font-medium text-neutral-500 mb-1">{label}</span>
      {children}
      {hint ? <span className="block text-11 text-neutral-500 mt-1">{hint}</span> : null}
    </label>
  );
}

/** Small secondary button used in rows and dialogs. */
export const smallBtn =
  'h-8 px-3 inline-flex items-center gap-1 text-13 rounded-lg border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';

// ── CSV ──────────────────────────────────────────────────────────────────

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export function downloadText(filename: string, text: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Minimal RFC-4180 parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

export function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Something went wrong.';
}
