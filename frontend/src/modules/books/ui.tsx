import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, type ReactElement, type ReactNode } from 'react';
import { X, type LucideIcon } from 'lucide-react';

/**
 * Books UI kit — the platform tokens (surface / ink / border / primary) and
 * the Workstation table conventions, plus the few things accounting screens
 * need: money cells, a status badge, a drawer and a modal.
 */

// ── formatting ────────────────────────────────────────────────────────────
const fmtCache = new Map<string, Intl.NumberFormat>();
export function money(value: unknown, currency?: string | null): string {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(n)) return '—';
  const key = currency || 'none';
  let f = fmtCache.get(key);
  if (!f) {
    try {
      f = currency ? new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }) : new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
    } catch {
      f = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
    }
    fmtCache.set(key, f);
  }
  return f.format(n);
}
export function date(v: unknown): string {
  if (typeof v !== 'string' || !v) return '—';
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function dateTime(v: unknown): string {
  if (typeof v !== 'string' || !v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
/** Today as yyyy-mm-dd in the user's own time zone (toISOString is UTC — yesterday until 05:30 IST). */
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ── layout ────────────────────────────────────────────────────────────────
export function Section({ title, right, children, className = '' }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`dash-card min-w-0 overflow-hidden ${className}`}>
      {title ? (
        <div className="min-h-12 px-5 py-3 flex flex-wrap items-center gap-2 border-b border-neutral-100">
          <span className="text-14 font-semibold text-ink">{title}</span>
          <div className="flex-1" />
          {right}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Icon-square tints, as on the CRM dashboards. */
export const TINTS = {
  blue: { bg: '#e4f5f3', fg: '#0c7a7a', ring: '#cdebe8' },
  indigo: { bg: '#fff1ec', fg: '#c2492b', ring: '#fbd9ce' },
  green: { bg: '#e9f9f1', fg: '#047857', ring: '#cdeede' },
  teal: { bg: '#e6f8f6', fg: '#0f766e', ring: '#c9eeea' },
  amber: { bg: '#fff7e6', fg: '#b45309', ring: '#fde7bf' },
  rose: { bg: '#fff1f2', fg: '#be123c', ring: '#fde2e6' },
} as const;
export type Tint = keyof typeof TINTS;

export function Tile({ label, value, hint, tone = 'default', icon: Icon, tint = 'blue' }: {
  label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'warn'; icon?: LucideIcon; tint?: Tint;
}) {
  const t = TINTS[tone === 'warn' ? 'rose' : tint];
  return (
    <div className="dash-card card-zoom p-4 min-w-0">
      <div className="flex items-center gap-3">
        {Icon ? (
          <span className="h-9 w-9 rounded-lg inline-flex items-center justify-center shrink-0" style={{ background: t.bg, color: t.fg, boxShadow: `inset 0 0 0 1px ${t.ring}` }}>
            <Icon size={17} strokeWidth={1.9} />
          </span>
        ) : null}
        <div className="text-13 leading-4 font-medium text-inkMuted min-w-0">{label}</div>
      </div>
      <div className={`num-display text-[24px] leading-tight mt-3 truncate ${tone === 'warn' ? 'text-danger' : 'text-ink'}`}>{value}</div>
      {hint ? <div className="text-12 text-inkMuted mt-1">{hint}</div> : null}
    </div>
  );
}

export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-3 mb-4">
      <div className="min-w-0">
        <h2 className="text-[22px] leading-tight font-semibold tracking-[-0.01em] text-ink">{title}</h2>
        {subtitle ? <p className="text-13 text-inkMuted mt-0.5">{subtitle}</p> : null}
      </div>
      <div className="flex-1" />
      <div className="flex flex-wrap gap-2">{right}</div>
    </div>
  );
}

// ── forms ─────────────────────────────────────────────────────────────────
export const inputCls = 'h-9 w-full px-3 text-13 bg-surface text-ink border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/10 disabled:opacity-60';

export function Field({ label, hint, error, children, className = '' }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="block text-12 font-medium text-neutral-500 mb-1">{label}</span>
      {children}
      {error ? <span className="block text-12 text-danger mt-1">{error}</span> : hint ? <span className="block text-12 text-inkMuted mt-1">{hint}</span> : null}
    </label>
  );
}

export function TextInput({ value, onChange, className = '', ...rest }: { value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return <input {...rest} value={value} onChange={(e) => onChange(e.target.value)} className={`${inputCls} ${className}`} />;
}

export function NumberInput({ value, onChange, className = '', ...rest }: { value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return <input {...rest} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.%-]/g, ''))} className={`${inputCls} text-right tabular-nums ${className}`} />;
}

export function Select({ value, onChange, options, placeholder, className = '', disabled }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; placeholder?: string; className?: string; disabled?: boolean }) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={`${inputCls} ${className}`}>
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function TextArea({ value, onChange, rows = 3 }: { value: string; onChange: (v: string) => void; rows?: number }) {
  return <textarea value={value} rows={rows} onChange={(e) => onChange(e.target.value)} className={`${inputCls} h-auto py-2`} />;
}

export function Btn({ children, onClick, variant = 'secondary', disabled, loading, type = 'button', title }: { children: ReactNode; onClick?: () => void; variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; disabled?: boolean; loading?: boolean; type?: 'button' | 'submit'; title?: string }) {
  const styles = {
    primary: 'bg-primary text-white hover:bg-primaryHover shadow-card',
    secondary: 'bg-surface text-primary border border-neutral-200 hover:border-primary/40 hover:bg-[#f2f8f8] shadow-card',
    danger: 'bg-surface text-danger border border-neutral-200 hover:border-danger/40 hover:bg-[#fff5f5]',
    ghost: 'text-inkMuted hover:text-primary hover:bg-[#f1f4f9]',
  }[variant];
  return (
    <button type={type} title={title} onClick={onClick} disabled={disabled || loading}
      className={`h-9 px-4 text-13 font-medium rounded-lg inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${styles}`}>
      {loading ? <span className="h-3 w-3 rounded-full border-2 border-current border-r-transparent animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

// ── feedback ──────────────────────────────────────────────────────────────
export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  const look = tone === 'error'
    ? { background: '#fff5f5', boxShadow: 'inset 3px 0 0 #dc2626, inset 0 0 0 1px #fde2e2', color: '#991b1b' }
    : tone === 'warn'
      ? { background: '#fffbeb', boxShadow: 'inset 3px 0 0 #f59e0b, inset 0 0 0 1px #fdecc8', color: '#92400e' }
      : { background: '#f2f8f8', boxShadow: 'inset 3px 0 0 #0f6f6f, inset 0 0 0 1px #d9ecea', color: '#334155' };
  return <div className="rounded-lg px-4 py-2 text-12" style={look}>{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center">
      <div className="text-14 font-medium text-ink">{title}</div>
      {children ? <div className="text-13 text-inkMuted mt-1">{children}</div> : null}
    </div>
  );
}

export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="p-4 space-y-2" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="h-8 bg-canvas rounded animate-pulse" />)}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="px-4 py-8 text-center">
      <div className="text-13 text-danger">{error}</div>
      {onRetry ? <div className="mt-3"><Btn onClick={onRetry}>Try again</Btn></div> : null}
    </div>
  );
}

type Tone = 'green' | 'red' | 'amber' | 'grey' | 'blue';
const TONES: Record<string, Tone> = {
  paid: 'green', closed: 'green', accepted: 'green', invoiced: 'green', billed: 'green', active: 'green', synced: 'green', connected: 'green', categorized: 'green', matched: 'green', reconciled: 'green',
  overdue: 'red', void: 'grey', declined: 'red', failed: 'red', revoked: 'red', expired: 'red', error: 'red', cancelled: 'grey', inactive: 'grey', excluded: 'grey',
  partially_paid: 'amber', syncing: 'amber', uncategorized: 'amber', consent_pending: 'amber', draft: 'grey',
};
/** A tinted status chip with a dot, as in the CRM lists. */
const CHIP: Record<Tone, { bg: string; fg: string; dot: string }> = {
  green: { bg: '#ecfdf5', fg: '#047857', dot: '#10b981' },
  red: { bg: '#fef2f2', fg: '#b91c1c', dot: '#ef4444' },
  amber: { bg: '#fffbeb', fg: '#b45309', dot: '#f59e0b' },
  grey: { bg: '#f1f5f9', fg: '#475569', dot: '#94a3b8' },
  blue: { bg: '#fff1ec', fg: '#c2492b', dot: '#f07a5a' },
};
export function Badge({ status }: { status: unknown }) {
  const s = String(status ?? '').toLowerCase();
  if (!s) return <span className="text-inkFaint">—</span>;
  const c = CHIP[TONES[s] ?? 'blue'];
  return (
    <span className="inline-flex items-center gap-2 h-6 px-3 rounded-full text-12 font-medium capitalize whitespace-nowrap" style={{ background: c.bg, color: c.fg }}>
      <span className="rounded-full" style={{ background: c.dot, width: 6, height: 6 }} aria-hidden />
      {s.replace(/_/g, ' ')}
    </span>
  );
}

// ── table ─────────────────────────────────────────────────────────────────
export interface Col { label: string; right?: boolean; sortKey?: string }
export function Table({ cols, children, minWidth = 720, sort, onSort }: { cols: Col[]; children: ReactNode; minWidth?: number; sort?: { key: string; dir: 'A' | 'D' }; onSort?: (key: string) => void }) {
  return (
    // Phones: `m-cards` stacks each row as a card with column labels.
    <div className="m-cards md:overflow-x-auto">
      <table className="hr-float w-full border-collapse books-table" style={{ ['--books-min' as string]: `${minWidth}px` }}>
        <thead>
          <tr className="border-b border-border">
            {cols.map((c, i) => (
              <th key={`${c.label}-${i}`} className={`h-9 px-3 text-11 uppercase tracking-[0.06em] font-medium text-inkMuted whitespace-nowrap ${c.right ? 'text-right' : 'text-left'}`}>
                {c.sortKey && onSort ? (
                  <button type="button" onClick={() => onSort(c.sortKey!)} className="uppercase tracking-[0.06em] hover:text-ink">
                    {c.label}{sort?.key === c.sortKey ? (sort.dir === 'A' ? ' ↑' : ' ↓') : ''}
                  </button>
                ) : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody><BooksCols.Provider value={cols.map((c) => c.label)}>{children}</BooksCols.Provider></tbody>
      </table>
    </div>
  );
}
const BooksCols = createContext<string[]>([]);
export function Row({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
  const cols = useContext(BooksCols);
  // Each cell learns its column name (the first is the card title on phones).
  const cells = Children.toArray(children).map((c, i) =>
    isValidElement(c) ? cloneElement(c as ReactElement<{ 'data-label'?: string }>, { 'data-label': i === 0 ? '' : (cols[i] ?? '') }) : c);
  return <tr onClick={onClick} className={`h-10 border-b border-border last:border-b-0 ${onClick ? 'cursor-pointer hover:bg-canvas' : ''}`}>{cells}</tr>;
}
export function Cell({ children = null, right = false, muted = false, className = '', colSpan, 'data-label': dataLabel }: { children?: ReactNode; right?: boolean; muted?: boolean; className?: string; colSpan?: number; 'data-label'?: string }) {
  return <td colSpan={colSpan} data-label={dataLabel} className={`px-3 py-2 text-13 ${muted ? 'text-inkMuted' : 'text-ink'} ${right ? 'text-right tabular-nums whitespace-nowrap' : ''} ${className}`}><span className="td-v">{children}</span></td>;
}

export function Pager({ page, hasMore, onPage, loading }: { page: number; hasMore: boolean; onPage: (p: number) => void; loading?: boolean }) {
  if (page === 1 && !hasMore) return null;
  return (
    <div className="flex items-center justify-end gap-2 px-4 py-2 border-t border-neutral-100">
      <span className="text-12 text-inkMuted">Page {page}</span>
      <Btn variant="ghost" disabled={page <= 1 || loading} onClick={() => onPage(page - 1)}>Previous</Btn>
      <Btn variant="ghost" disabled={!hasMore || loading} onClick={() => onPage(page + 1)}>Next</Btn>
    </div>
  );
}

// ── overlays ──────────────────────────────────────────────────────────────
function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

export function Modal({ title, onClose, children, footer, wide = false }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/40 p-2 sm:p-4 overflow-y-auto" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`bg-surface border border-neutral-200 rounded-lg shadow-raised w-full ${wide ? 'max-w-[1100px]' : 'max-w-[560px]'} max-h-[calc(100vh-16px)] sm:max-h-[calc(100vh-32px)] flex flex-col overflow-hidden`}>
        <div className="h-14 px-5 flex items-center border-b border-neutral-100 shrink-0">
          <h3 className="text-15 font-semibold text-ink truncate">{title}</h3>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="p-1 text-inkMuted hover:text-ink" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
        {footer ? <div className="px-5 py-3 border-t border-neutral-100 bg-[#fafbfd] flex flex-wrap justify-end gap-2 shrink-0">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="h-full w-full max-w-[760px] bg-surface border-l border-neutral-200 shadow-drawer flex flex-col" role="dialog" aria-modal="true">
        <div className="min-h-14 px-5 py-2 flex items-center gap-2 border-b border-neutral-100 shrink-0">
          <div className="text-15 font-semibold text-ink truncate min-w-0">{title}</div>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="p-1 text-inkMuted hover:text-ink" aria-label="Close"><X size={18} /></button>
        </div>
        {actions ? <div className="px-5 py-2 border-b border-neutral-100 bg-[#fafbfd] flex flex-wrap gap-2 shrink-0">{actions}</div> : null}
        <div className="p-5 overflow-y-auto flex-1">{children}</div>
      </aside>
    </div>
  );
}

export function KV({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
      {items.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-12 font-medium text-neutral-500">{k}</dt>
          <dd className="text-13 text-ink mt-0.5 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
