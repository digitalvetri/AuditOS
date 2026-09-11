import {
  Children, cloneElement, createContext, isValidElement, useContext, useEffect,
  type ReactElement, type ReactNode,
} from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ApiError } from '@/services/api';
import { StatusLabel, type StatusVariant } from '@/components/StatusRow';

/**
 * Workstation UI kit.
 *
 * Reuses the platform's design tokens exactly — this file adds no colour, no
 * radius and no shadow of its own. Status is encoded the platform way: a 2px
 * LEFT border on the row plus text weight, never a filled pill.
 */

// ── Status vocabulary ─────────────────────────────────────────────────────
/**
 * Every Workstation status maps to one of the five platform variants and one
 * human label. Centralised so "documents_pending" reads the same on the
 * dashboard, the service list and the client workspace.
 */
const STATUS_META: Record<string, { variant: StatusVariant; label: string }> = {
  // Lead
  new: { variant: 'awaiting', label: 'New' },
  contacted: { variant: 'awaiting', label: 'Contacted' },
  requirement_identified: { variant: 'awaiting', label: 'Requirement Identified' },
  quote_sent: { variant: 'pending', label: 'Quote Sent' },
  negotiation: { variant: 'pending', label: 'Negotiation' },
  won: { variant: 'ok', label: 'Won' },
  lost: { variant: 'problem', label: 'Lost' },
  // Client
  active: { variant: 'ok', label: 'Active' },
  onboarding: { variant: 'awaiting', label: 'Onboarding' },
  pending_documents: { variant: 'pending', label: 'Pending Documents' },
  service_due: { variant: 'pending', label: 'Service Due' },
  inactive: { variant: 'ok', label: 'Inactive' },
  // Service
  not_started: { variant: 'awaiting', label: 'Not Started' },
  documents_pending: { variant: 'pending', label: 'Documents Pending' },
  in_progress: { variant: 'awaiting', label: 'In Progress' },
  under_review: { variant: 'pending', label: 'Under Review' },
  ready: { variant: 'ok', label: 'Ready' },
  submitted: { variant: 'ok', label: 'Submitted' },
  completed: { variant: 'ok', label: 'Completed' },
  failed: { variant: 'problem', label: 'Failed' },
  on_hold: { variant: 'pending', label: 'On Hold' },
  // Follow-up
  pending: { variant: 'pending', label: 'Pending' },
  rescheduled: { variant: 'pending', label: 'Rescheduled' },
  cancelled: { variant: 'ok', label: 'Cancelled' },
  missed: { variant: 'problem', label: 'Missed' },
  // Document
  requested: { variant: 'awaiting', label: 'Requested' },
  uploaded: { variant: 'awaiting', label: 'Uploaded' },
  verified: { variant: 'ok', label: 'Verified' },
  rejected: { variant: 'problem', label: 'Rejected' },
  expired: { variant: 'problem', label: 'Expired' },
  // GST filing
  data_preparation: { variant: 'awaiting', label: 'Data Preparation' },
  ready_to_file: { variant: 'ok', label: 'Ready to File' },
  filed: { variant: 'ok', label: 'Filed' },
  // E-way
  generated: { variant: 'awaiting', label: 'Generated' },
};

export function statusMeta(status: string) {
  return STATUS_META[status] ?? {
    variant: 'awaiting' as StatusVariant,
    label: status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  };
}

/** Inline status for a table cell. */
export function Status({ value }: { value: string }) {
  const { variant, label } = statusMeta(value);
  return <StatusLabel variant={variant} label={label} />;
}

/** The 2px left border a status row carries. Applied to the <tr>. */
export function statusBorder(value: string): string {
  const { variant } = statusMeta(value);
  if (variant === 'problem') return 'border-l-2 border-red';
  if (variant === 'pending' || variant === 'attention') return 'border-l-2 border-amber';
  if (variant === 'awaiting') return 'border-l-2 border-neutral-400';
  return 'border-l-2 border-transparent';
}

// ── Page scaffolding ──────────────────────────────────────────────────────
export function PageHeader({
  title, subtitle, action,
}: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <header className="flex items-start gap-4 mb-4">
      <div className="min-w-0">
        <h1 className="text-20 font-semibold text-neutral-900">{title}</h1>
        {subtitle ? <p className="text-13 text-neutral-500 mt-1">{subtitle}</p> : null}
      </div>
      <div className="flex-1" />
      {action}
    </header>
  );
}

export function Card({ title, right, children, className = '' }: {
  title?: string; right?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`bg-white border border-neutral-200 rounded ${className}`}>
      {title ? (
        <div className="h-10 px-4 flex items-center border-b border-neutral-200">
          <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">{title}</span>
          <div className="flex-1" />
          {right}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * A notice that names something the prototype SIMULATES rather than performs
 * (§9). Deliberately plain text on a bordered surface, not a coloured banner —
 * it is information, not an alarm.
 */
export function SimulatedNotice({ children }: { children: ReactNode }) {
  return (
    <div className="border-l-2 border-amber bg-white px-3 py-2 text-12 text-neutral-600">
      {children}
    </div>
  );
}

// ── Query states (§20: loading · empty · error · permission-denied) ───────
export function QueryState<T>({
  query, empty, children,
}: {
  query: UseQueryResult<T, unknown>;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.isLoading) {
    return <div className="px-4 py-6 text-13 text-neutral-500">Loading…</div>;
  }
  if (query.isError) {
    const err = query.error as ApiError | undefined;
    // 403 is a distinct state, not a generic failure — the caller is signed in
    // and the request was understood; they simply may not see this.
    if (err?.status === 403) {
      return (
        <div className="px-4 py-6">
          <div className="border-l-2 border-amber pl-3">
            <div className="text-13 font-medium text-neutral-900">You do not have access to this</div>
            <p className="text-13 text-neutral-500 mt-1 max-w-[520px]">
              Workstation records are visible to the people assigned to them. Ask an
              Operations Manager to assign you, or to widen your access.
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="px-4 py-6">
        <div className="border-l-2 border-red pl-3">
          <div className="text-13 font-medium text-neutral-900">Could not load this</div>
          <p className="text-13 text-neutral-500 mt-1">{err?.message ?? 'Something went wrong.'}</p>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="mt-2 text-13 text-neutral-700 underline hover:text-neutral-900"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
  const data = query.data as T;
  const isEmptyList =
    Array.isArray((data as { items?: unknown[] })?.items) &&
    (data as { items: unknown[] }).items.length === 0;
  if (isEmptyList && empty) {
    return <div className="px-4 py-6 text-13 text-neutral-500">{empty}</div>;
  }
  return <>{children(data)}</>;
}

// ── Table ─────────────────────────────────────────────────────────────────
/**
 * 40px rows, hairline separators, no zebra. Wide tables scroll inside their
 * own container so the page body never scrolls sideways.
 */
/**
 * The column headings, published to the Cells beneath them. Below 768px the
 * `m-cards` rule turns each row into a stack and prints `data-label` as the
 * name of the value — so a Cell has to know which column it is in. Reading it
 * from context keeps every existing `<Cell>` call site unchanged.
 */
const HeadContext = createContext<string[]>([]);

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    // `m-cards` is inert above 767px, so the desktop table — including its
    // 720px minimum and its own horizontal scroller — is untouched.
    <div className="m-cards md:overflow-x-auto">
      <table className="w-full md:min-w-[720px] border-collapse">
        <thead>
          <tr className="border-b border-neutral-200">
            {head.map((h) => (
              <th
                key={h}
                className="h-8 px-3 text-left text-11 uppercase tracking-[0.06em] font-medium text-neutral-500 whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <HeadContext.Provider value={head}>{children}</HeadContext.Provider>
        </tbody>
      </table>
    </div>
  );
}

export function Row({
  onClick, status, children,
}: { onClick?: () => void; status?: string; children: ReactNode }) {
  const head = useContext(HeadContext);
  // Hand each Cell its column name by position. Children are the Cells of one
  // row, so the index is the column index.
  const labelled = Children.map(children, (child, i) =>
    isValidElement(child)
      ? cloneElement(child as ReactElement<{ label?: string }>, { label: head[i] ?? '' })
      : child,
  );
  return (
    <tr
      onClick={onClick}
      className={
        `h-10 md:h-10 border-b border-neutral-200 ${status ? statusBorder(status) : ''} ` +
        (onClick ? 'cursor-pointer hover:bg-neutral-50' : '')
      }
    >
      {labelled}
    </tr>
  );
}

export function Cell({ children, className = '', muted = false, label = '' }: {
  children: ReactNode; className?: string; muted?: boolean;
  /** Injected by Row from the Table head — not set at call sites. */
  label?: string;
}) {
  return (
    <td
      data-label={label}
      className={`px-3 text-13 ${muted ? 'text-neutral-500' : 'text-neutral-900'} ${className}`}
    >
      {children}
    </td>
  );
}

// ── Filters ───────────────────────────────────────────────────────────────
export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-end gap-2 mb-3">{children}</div>;
}

export function Select({
  label, value, onChange, options, allLabel = 'All',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  allLabel?: string;
}) {
  return (
    <label className="block">
      <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 px-2 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

export function SearchInput({
  value, onChange, placeholder,
}: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="block">
      <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Search</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 px-3 w-[240px] max-w-full text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
      />
    </label>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────
export function Modal({
  open, title, onClose, children, footer, width = 'w-[560px]',
}: {
  open: boolean; title: string; onClose: () => void;
  children: ReactNode; footer?: ReactNode; width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="fixed inset-0 bg-black/[0.32]" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative bg-white border border-neutral-200 rounded shadow-drawer ${width} max-w-full mt-8`}
      >
        <div className="h-10 px-4 flex items-center border-b border-neutral-200">
          <span className="text-13 font-medium text-neutral-900">{title}</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-6 w-6 text-13 text-neutral-500 hover:text-neutral-900"
          >
            ✕
          </button>
        </div>
        <div className="p-4">{children}</div>
        {footer ? (
          <div className="px-4 py-3 border-t border-neutral-200 flex items-center justify-end gap-2">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Form field ────────────────────────────────────────────────────────────
/**
 * A labelled field with room for a server-supplied, per-field error message —
 * the `details` map an ApiError carries lands here (§20 field-level messages).
 */
export function Field({
  label, error, children, hint,
}: { label: string; error?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block mb-3">
      <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">{label}</span>
      {children}
      {hint && !error ? <span className="block text-12 text-neutral-500 mt-1">{hint}</span> : null}
      {error ? <span className="block text-12 text-red mt-1">{error}</span> : null}
    </label>
  );
}

export const inputClass =
  'block w-full h-8 px-3 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold';

export const textareaClass =
  'block w-full px-3 py-2 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold';

/** Pull the per-field `details` map off an ApiError, if the server sent one. */
export function fieldErrors(err: unknown): Record<string, string> {
  const e = err as ApiError | undefined;
  const d = e?.details;
  if (d && typeof d === 'object' && !Array.isArray(d)) return d as Record<string, string>;
  return {};
}

/** A definition row — used by the Client Workspace detail panels. */
export function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-2 border-b border-neutral-200 last:border-b-0">
      <span className="text-11 uppercase tracking-[0.06em] text-neutral-500 w-[160px] shrink-0">{label}</span>
      <span className="text-13 text-neutral-900 min-w-0 break-words">{value ?? '—'}</span>
    </div>
  );
}
