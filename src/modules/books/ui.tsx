import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

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
export const today = () => new Date().toISOString().slice(0, 10);

// ── layout ────────────────────────────────────────────────────────────────
export function Section({ title, right, children, className = '' }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`bg-surface border border-border rounded min-w-0 ${className}`}>
      {title ? (
        <div className="min-h-10 px-4 py-2 flex flex-wrap items-center gap-2 border-b border-border">
          <span className="text-11 uppercase tracking-[0.06em] text-inkMuted">{title}</span>
          <div className="flex-1" />
          {right}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Tile({ label, value, hint, tone = 'default' }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'warn' }) {
  return (
    <div className="bg-surface border border-border rounded p-4 min-w-0">
      <div className="text-11 uppercase tracking-[0.06em] text-inkMuted">{label}</div>
      <div className={`text-20 font-semibold tabular-nums mt-1 truncate ${tone === 'warn' ? 'text-danger' : 'text-ink'}`}>{value}</div>
      {hint ? <div className="text-12 text-inkMuted mt-1">{hint}</div> : null}
    </div>
  );
}

export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-3 mb-4">
      <div className="min-w-0">
        <h2 className="text-18 font-semibold text-ink">{title}</h2>
        {subtitle ? <p className="text-13 text-inkMuted mt-0.5">{subtitle}</p> : null}
      </div>
      <div className="flex-1" />
      <div className="flex flex-wrap gap-2">{right}</div>
    </div>
  );
}

// ── forms ─────────────────────────────────────────────────────────────────
export const inputCls = 'h-9 w-full px-2 text-13 bg-surface text-ink border border-border rounded focus:outline-none focus:border-primary disabled:opacity-60';

export function Field({ label, hint, error, children, className = '' }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="block text-11 uppercase tracking-[0.06em] text-inkMuted mb-1">{label}</span>
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
    primary: 'bg-primary text-white hover:bg-primaryHover',
    secondary: 'bg-surface text-ink border border-border hover:bg-canvas',
    danger: 'bg-surface text-danger border border-border hover:bg-canvas',
    ghost: 'text-inkMuted hover:text-ink hover:bg-canvas',
  }[variant];
  return (
    <button type={type} title={title} onClick={onClick} disabled={disabled || loading}
      className={`h-9 px-3 text-13 font-medium rounded inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${styles}`}>
      {loading ? <span className="h-3 w-3 rounded-full border-2 border-current border-r-transparent animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

// ── feedback ──────────────────────────────────────────────────────────────
export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  const border = tone === 'error' ? 'border-danger' : tone === 'warn' ? 'border-warning' : 'border-neutral-400';
  return <div className={`border-l-2 ${border} bg-surface px-3 py-2 text-12 text-inkMuted`}>{children}</div>;
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

const TONES: Record<string, string> = {
  paid: 'text-success', closed: 'text-success', accepted: 'text-success', invoiced: 'text-success', billed: 'text-success', active: 'text-success', synced: 'text-success', connected: 'text-success', categorized: 'text-success', matched: 'text-success', reconciled: 'text-success',
  overdue: 'text-danger', void: 'text-inkFaint', declined: 'text-danger', failed: 'text-danger', revoked: 'text-danger', expired: 'text-danger', error: 'text-danger', cancelled: 'text-inkFaint', inactive: 'text-inkFaint', excluded: 'text-inkFaint',
  partially_paid: 'text-warning', syncing: 'text-warning', uncategorized: 'text-warning', consent_pending: 'text-warning', draft: 'text-inkMuted',
};
export function Badge({ status }: { status: unknown }) {
  const s = String(status ?? '').toLowerCase();
  if (!s) return <span className="text-inkFaint">—</span>;
  return <span className={`text-12 font-medium capitalize ${TONES[s] ?? 'text-ink'}`}>{s.replace(/_/g, ' ')}</span>;
}

// ── table ─────────────────────────────────────────────────────────────────
export interface Col { label: string; right?: boolean; sortKey?: string }
export function Table({ cols, children, minWidth = 720, sort, onSort }: { cols: Col[]; children: ReactNode; minWidth?: number; sort?: { key: string; dir: 'A' | 'D' }; onSort?: (key: string) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse" style={{ minWidth }}>
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
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
export function Row({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
  return <tr onClick={onClick} className={`h-10 border-b border-border last:border-b-0 ${onClick ? 'cursor-pointer hover:bg-canvas' : ''}`}>{children}</tr>;
}
export function Cell({ children = null, right = false, muted = false, className = '', colSpan }: { children?: ReactNode; right?: boolean; muted?: boolean; className?: string; colSpan?: number }) {
  return <td colSpan={colSpan} className={`px-3 py-1.5 text-13 ${muted ? 'text-inkMuted' : 'text-ink'} ${right ? 'text-right tabular-nums whitespace-nowrap' : ''} ${className}`}>{children}</td>;
}

export function Pager({ page, hasMore, onPage, loading }: { page: number; hasMore: boolean; onPage: (p: number) => void; loading?: boolean }) {
  if (page === 1 && !hasMore) return null;
  return (
    <div className="flex items-center justify-end gap-2 px-4 py-2 border-t border-border">
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
      <div className={`bg-surface border border-border rounded shadow-card w-full ${wide ? 'max-w-[1100px]' : 'max-w-[560px]'} max-h-[calc(100vh-16px)] sm:max-h-[calc(100vh-32px)] flex flex-col`}>
        <div className="h-12 px-4 flex items-center border-b border-border shrink-0">
          <h3 className="text-15 font-semibold text-ink truncate">{title}</h3>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="p-1 text-inkMuted hover:text-ink" aria-label="Close"><X size={18} /></button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
        {footer ? <div className="px-4 py-3 border-t border-border flex flex-wrap justify-end gap-2 shrink-0">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="h-full w-full max-w-[760px] bg-surface border-l border-border flex flex-col" role="dialog" aria-modal="true">
        <div className="min-h-12 px-4 py-2 flex items-center gap-2 border-b border-border shrink-0">
          <div className="text-15 font-semibold text-ink truncate min-w-0">{title}</div>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="p-1 text-inkMuted hover:text-ink" aria-label="Close"><X size={18} /></button>
        </div>
        {actions ? <div className="px-4 py-2 border-b border-border flex flex-wrap gap-2 shrink-0">{actions}</div> : null}
        <div className="p-4 overflow-y-auto flex-1">{children}</div>
      </aside>
    </div>
  );
}

export function KV({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
      {items.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-11 uppercase tracking-[0.06em] text-inkMuted">{k}</dt>
          <dd className="text-13 text-ink mt-0.5 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
