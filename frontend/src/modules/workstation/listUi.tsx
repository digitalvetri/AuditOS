import { Children, cloneElement, createContext, isValidElement, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { Avatar } from '@/components/viz';

/**
 * The Workstation register look — Quotations, Invoices, Engagement letters,
 * Leads, Clients and Documents share it: a large title with a one-line count,
 * a toolbar (search · narrowing selects · status pills), and a rounded white
 * card holding a light table with tinted status chips.
 *
 * Presentation only. Every page keeps its own state, queries and actions;
 * these pieces just draw them.
 */

// ── Header ────────────────────────────────────────────────────────────────

export function ListHeader({ title, meta, action }: { title: string; meta?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-4 flex-wrap mb-5">
      <div className="min-w-0">
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900">{title}</h1>
        {meta ? <p className="text-13 text-neutral-500 mt-1">{meta}</p> : null}
      </div>
      <div className="flex-1" />
      {/* On phones a single primary action floats as a round + button above
          the bottom bar (globals.css `.lh-action`); in place from 768px up. */}
      {action ? <div className="lh-action">{action}</div> : null}
    </div>
  );
}

const ACTION = 'h-9 px-4 inline-flex items-center gap-2 text-13 font-medium rounded-lg bg-primary text-white hover:bg-primaryHover shadow-card transition-colors disabled:opacity-50';

/** The page's primary action — a link or a button, same look. */
export function ListAction({ to, onClick, icon, children }: {
  to?: string; onClick?: () => void; icon?: ReactNode; children: ReactNode;
}) {
  if (to) return <Link to={to} className={ACTION}>{icon}{children}</Link>;
  return <button type="button" onClick={onClick} className={ACTION}>{icon}{children}</button>;
}

// ── Toolbar ───────────────────────────────────────────────────────────────

/**
 * Search + narrowing filters. From 768px up: one wrapping row, as before.
 * On phones: the row sticks to the top while the list scrolls and shows only
 * the search box plus a "Filters" button; the selects open in a bottom sheet
 * (the same controls, rendered there too, bound to the same state).
 */
export function ListToolbar({ children }: { children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState({ has: false, active: 0 });
  // How many filters exist / are set — read from the controls themselves.
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const controls = [...el.querySelectorAll<HTMLInputElement | HTMLSelectElement>(':scope > select, :scope select, :scope input[type=date]')];
    const switches = [...el.querySelectorAll<HTMLButtonElement>('button[role=switch]')];
    const active = controls.filter((c) => c.value !== '').length + switches.filter((b) => b.getAttribute('aria-checked') === 'true').length;
    if (info.has !== (controls.length + switches.length > 0) || info.active !== active) setInfo({ has: controls.length + switches.length > 0, active });
  });
  return (
    <>
      <div ref={bar} className="lt-bar flex items-center gap-2 flex-wrap mb-4">
        {children}
        {info.has ? (
          <button type="button" onClick={() => setOpen(true)} className="lt-filter-btn md:hidden" aria-label="Filters">
            <SlidersHorizontal size={16} strokeWidth={2} />
            Filters
            {info.active ? <span className="lt-filter-count">{info.active}</span> : null}
          </button>
        ) : null}
      </div>
      {open ? createPortal(
        <div className="lt-sheet-wrap md:hidden" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="lt-sheet" role="dialog" aria-modal="true" aria-label="Filters">
            <div className="lt-sheet-grip" aria-hidden />
            <div className="flex items-center mb-3">
              <h2 className="text-16 font-semibold text-neutral-900 flex-1">Filters</h2>
              <button type="button" onClick={() => setOpen(false)} className="h-9 w-9 inline-flex items-center justify-center rounded-full bg-[#f1f4f9] text-neutral-600" aria-label="Close filters"><X size={16} /></button>
            </div>
            <div className="lt-sheet-body">{children}</div>
            <button type="button" onClick={() => setOpen(false)} className="lt-sheet-done">Show results</button>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

export const Spacer = () => <div className="flex-1" />;

export function SearchBox({ value, onChange, placeholder, label = 'Search' }: {
  value: string; onChange: (v: string) => void; placeholder: string; label?: string;
}) {
  return (
    <label className="lt-search relative block w-full sm:w-[260px]">
      <span className="sr-only">{label}</span>
      <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-9 w-full pl-9 pr-3 text-13 bg-white text-neutral-900 border border-neutral-200 rounded-lg placeholder:text-neutral-400 focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/10"
      />
    </label>
  );
}

const FIELD = 'h-9 text-13 bg-white text-neutral-700 border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60';

/** A narrowing filter as a compact select; its label is the "any" option. */
export function FilterSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
}) {
  return (
    <select aria-label={label} title={label} value={value} onChange={(e) => onChange(e.target.value)}
      className={`${FIELD} px-2 max-w-[200px] ${value ? 'border-primary/40 text-primary' : ''}`}>
      <option value="">{label}: All</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function DateRange({ from, to, onFrom, onTo }: {
  from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input type="date" aria-label="From date" title="From date" value={from} onChange={(e) => onFrom(e.target.value)} className={`${FIELD} w-[132px] px-2 text-12`} />
      <span className="text-12 text-neutral-400">to</span>
      <input type="date" aria-label="To date" title="To date" value={to} onChange={(e) => onTo(e.target.value)} className={`${FIELD} w-[132px] px-2 text-12`} />
    </div>
  );
}

/** A pill that toggles a yes/no filter. */
export function TogglePill({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className={pill(on)}>{children}</button>
  );
}

const pill = (on: boolean) => `h-8 px-3 inline-flex items-center gap-1 text-13 rounded-full border transition-colors whitespace-nowrap ${
  on ? 'bg-[#e3f4f3] border-[#abd8d4] text-primary font-medium' : 'bg-white border-neutral-200 text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50'
}`;

/**
 * Status filter as saved-view tabs — an underlined tab row like the Clients
 * page. `counts` shows a count pill beside a label when known.
 */
export function StatusPills({ options, value, onChange, counts }: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  counts?: Record<string, number | undefined>;
}) {
  return (
    <div className="sp-row cl-views flex items-center gap-1 border-b border-border overflow-x-auto" role="radiogroup" aria-label="Status">
      {options.map((p) => {
        const on = value === p.value;
        const n = counts?.[p.value];
        return (
          <button key={p.value || 'all'} type="button" role="radio" aria-checked={on} onClick={() => onChange(p.value)}
            className={'cl-view relative flex items-center gap-2 px-3 pt-2 pb-[10px] text-13 font-medium whitespace-nowrap transition-colors ' + (on ? 'is-on text-ink' : 'text-inkMuted hover:text-ink')}>
            {p.label}
            {n !== undefined && n > 0 ? <span className="cl-count">{n}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

// ── Register ──────────────────────────────────────────────────────────────

export function ListCard({ title, right, children }: { title?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="ws-card bg-white border border-neutral-200 rounded-lg overflow-hidden">
      {title ? (
        <div className="ws-card-title flex items-center gap-3 px-5 py-3 border-b border-neutral-200">
          <div className="text-13 font-semibold text-neutral-900 min-w-0 flex-1">{title}</div>
          {right}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export const ListEmpty = ({ children }: { children: ReactNode }) => (
  <div className="px-5 py-10 text-center text-13 text-neutral-500">{children}</div>
);

export interface Col { label: string; align?: 'left' | 'right'; key?: string }

/**
 * The register table. By default every row FLOATS as its own card under a
 * tinted header strip (styles: `.ws-float` in globals.css); a card holding a
 * floating table drops its own frame. `float={false}` keeps plain rows inside
 * the card — for small tables that share a card with other content.
 */
export function ListTable({ cols, children, float = true, plainHead = false }: {
  cols: (string | Col)[]; children: ReactNode; float?: boolean;
  /** A softer header (pale blue bar, navy labels) — for pages that stack many small tables. */
  plainHead?: boolean;
}) {
  return (
    // `m-cards` (mobile.css) turns each row into a stacked card below 768px,
    // printing every cell's column name beside its value; inert above that.
    <div className={`m-cards md:overflow-x-auto ${float ? 'ws-float' : ''} ${plainHead ? 'ws-plain-head' : ''}`}>
      <table className="w-full text-13">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-12 text-neutral-500">
            {cols.map((c, i) => {
              const col = typeof c === 'string' ? { label: c } : c;
              const edge = i === 0 ? 'pl-5 pr-4' : i === cols.length - 1 ? 'pl-4 pr-5' : 'px-4';
              return (
                <th key={col.key ?? `${i}:${col.label}`} className={`font-normal py-3 whitespace-nowrap ${edge} ${col.align === 'right' ? 'text-right' : ''}`}>
                  {col.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody><ColsContext.Provider value={cols.map((c) => (typeof c === 'string' ? c : c.label))}>{children}</ColsContext.Provider></tbody>
      </table>
    </div>
  );
}

/** The column names, handed to each row's cells as `data-label` for the phone card layout. */
const ColsContext = createContext<string[]>([]);

export function ListRow({ onOpen, children }: { onOpen?: () => void; children: ReactNode }) {
  return (
    <tr
      onClick={onOpen}
      onKeyDown={onOpen ? (e: KeyboardEvent) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(); } : undefined}
      tabIndex={onOpen ? 0 : undefined}
      className={`border-b border-neutral-100 last:border-b-0 transition-colors ${onOpen ? 'cursor-pointer hover:bg-neutral-50 focus:outline-none focus-visible:bg-neutral-50' : ''}`}
    >
      {labelCells(children, useContext(ColsContext))}
    </tr>
  );
}

/**
 * Give each cell its column name by position. The first cell is the card's
 * title on a phone, so it gets no label and spans the card.
 */
function labelCells(children: ReactNode, cols: string[]) {
  return Children.toArray(children).map((child, i) =>
    isValidElement(child)
      ? cloneElement(child as ReactElement<{ 'data-label'?: string }>, { 'data-label': i === 0 ? '' : (cols[i] ?? '') })
      : child,
  );
}

/** A cell. `first` / `last` take the card's wider edge padding. */
export function TD({ children, first, last, right, strong, muted, nowrap, className = '', title, 'data-label': dataLabel }: {
  children: ReactNode; first?: boolean; last?: boolean; right?: boolean; strong?: boolean; muted?: boolean;
  nowrap?: boolean; className?: string; title?: string;
  /** Set by ListRow — the column name shown beside the value on phones. */
  'data-label'?: string;
}) {
  const edge = first ? 'pl-5 pr-4' : last ? 'pl-4 pr-5' : 'px-4';
  return (
    <td title={title} data-label={dataLabel} className={[
      edge, 'py-3',
      right ? 'text-right' : '',
      strong ? 'font-semibold text-neutral-900' : muted ? 'text-neutral-600' : 'text-neutral-800',
      nowrap ? 'whitespace-nowrap' : '',
      className,
    ].join(' ')}>
      {/* One wrapper, so on phones (cells are flex rows: label · value) a
          value made of several pieces — ₹1,000 + .00 — stays together. */}
      <span className="td-v">{children}</span>
    </td>
  );
}

/**
 * A name with a small second line (kind, company, ID). Pass `avatar` (the
 * person or company name) to lead with an initials avatar.
 */
export const TwoLine = ({ top, sub, avatar, square }: { top: ReactNode; sub?: ReactNode; avatar?: string | null; square?: boolean }) => {
  const text = (
    <>
      <div className="font-semibold text-neutral-900">{top}</div>
      {sub ? <div className="text-11 text-neutral-500 mt-px">{sub}</div> : null}
    </>
  );
  if (avatar === undefined) return text;
  return (
    <div className="flex items-center gap-3 min-w-0">
      <Avatar name={avatar} size={30} square={square} />
      <div className="min-w-0">{text}</div>
    </div>
  );
};

// ── Values ────────────────────────────────────────────────────────────────

type Tone = { bg: string; fg: string; dot: string };
const TONES: Record<'grey' | 'blue' | 'green' | 'amber' | 'red', Tone> = {
  grey: { bg: '#f1f5f9', fg: '#475569', dot: '#94a3b8' },
  blue: { bg: '#fff1ec', fg: '#c2492b', dot: '#f07a5a' },
  green: { bg: '#ecfdf5', fg: '#047857', dot: '#10b981' },
  amber: { bg: '#fffbeb', fg: '#b45309', dot: '#f59e0b' },
  red: { bg: '#fef2f2', fg: '#b91c1c', dot: '#ef4444' },
};
const STATUS_TONE: Record<string, keyof typeof TONES> = {
  draft: 'grey', new: 'grey', archived: 'grey', inactive: 'grey', pending: 'grey',
  sent: 'blue', contacted: 'blue', quote_sent: 'blue', onboarding: 'blue', uploaded: 'blue',
  requirement_identified: 'blue', under_review: 'blue',
  accepted: 'green', paid: 'green', won: 'green', active: 'green', verified: 'green',
  expired: 'amber', partially_paid: 'amber', negotiation: 'amber', pending_documents: 'amber',
  service_due: 'amber', requested: 'amber',
  rejected: 'red', lost: 'red', cancelled: 'red', overdue: 'red', missed: 'red',
  completed: 'green', rescheduled: 'blue',
};

export const statusLabel = (s: string) => {
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** A status as a soft tinted chip with a dot. */
export function StatusChip({ value }: { value: string }) {
  const tone = TONES[STATUS_TONE[value] ?? 'grey'];
  return (
    <span className="inline-flex items-center gap-2 h-6 px-3 rounded-full text-12 font-medium whitespace-nowrap" style={{ background: tone.bg, color: tone.fg }}>
      <span className="rounded-full" style={{ background: tone.dot, width: 6, height: 6 }} />
      {statusLabel(value)}
    </span>
  );
}

/**
 * A status you can change, drawn as the same tinted chip as StatusChip — a
 * real <select> underneath, so it keeps the keyboard and the native menu.
 * A small caret shows on hover so the chip still reads as editable. Clicks
 * do not reach the row (rows open on click).
 */
export function StatusChipSelect({ value, options, onChange, label = 'Status' }: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  label?: string;
}) {
  const tone = TONES[STATUS_TONE[value] ?? 'grey'];
  return (
    <span className="group/chip relative inline-flex items-center" onClick={(e) => e.stopPropagation()}>
      <span className="pointer-events-none absolute left-3 rounded-full" style={{ background: tone.dot, width: 6, height: 6 }} aria-hidden />
      <select
        value={value}
        aria-label={label}
        onChange={(e) => { if (e.target.value !== value) onChange(e.target.value); }}
        className="chip-select appearance-none h-6 pl-6 pr-6 rounded-full text-12 font-medium cursor-pointer border border-transparent hover:border-current focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 transition-colors"
        // Size to the chosen label, not the longest option, so it hugs its word like a chip.
        style={{ background: tone.bg, color: tone.fg, fieldSizing: 'content' } as CSSProperties}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <svg aria-hidden viewBox="0 0 10 6" className="pointer-events-none absolute right-2 w-2 h-2 opacity-0 group-hover/chip:opacity-70 transition-opacity"
        style={{ color: tone.fg }}><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
    </span>
  );
}

/** "₹1,935.20" with the paise set lighter. */
export function Money({ value }: { value: string }) {
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return <>{value}</>;
  return <>{value.slice(0, dot)}<span className="font-normal text-neutral-500">{value.slice(dot)}</span></>;
}

/** "29 Sept 2026". */
export const fmtDay = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
