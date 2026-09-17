import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Download, Printer } from 'lucide-react';
import type { TallyFinancialYear } from '@/modules/tools/audit-automation/tally';

/**
 * Shared presentation kit for the Tally module.
 *
 * Accounting screens are dense and read all day, so the primitives here
 * are deliberately plain: tabular numbers, thin rules, no animation.
 * Everything uses the existing Audit OS tokens (text-13, neutral-*, gold).
 */

// ── Formatting ───────────────────────────────────────────────────────

/** Paise → Indian-format rupee string, no symbol. */
export function rupees(paise: number, opts: { decimals?: boolean } = {}): string {
  const d = opts.decimals === false ? 0 : 2;
  return (Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function qty(milli: number): string {
  const v = milli / 1000;
  return v.toLocaleString('en-IN', { maximumFractionDigits: 3 });
}

/** A signed balance as accountants read it: 12,000.00 Dr / 12,000.00 Cr. */
export function drCr(signedPaise: number): string {
  if (signedPaise === 0) return '—';
  return `${rupees(signedPaise)} ${signedPaise > 0 ? 'Dr' : 'Cr'}`;
}

export function Money({ paise, signed, bold, className = '' }: { paise: number; signed?: boolean; bold?: boolean; className?: string }) {
  if (paise === 0) return <span className={`text-neutral-400 tabular-nums ${className}`}>—</span>;
  const negative = paise < 0;
  return (
    <span className={`tabular-nums ${bold ? 'font-semibold' : ''} ${signed && negative ? 'text-danger' : ''} ${className}`}>
      {signed && negative ? '(' : ''}₹{rupees(paise)}{signed && negative ? ')' : ''}
    </span>
  );
}

export function DrCr({ paise }: { paise: number }) {
  if (paise === 0) return <span className="text-neutral-400 tabular-nums">—</span>;
  return (
    <span className="tabular-nums">
      ₹{rupees(paise)} <span className="text-11 text-neutral-500 uppercase">{paise > 0 ? 'Dr' : 'Cr'}</span>
    </span>
  );
}

// ── Period (company-wide date range) ─────────────────────────────────

export interface TallyPeriodValue {
  from: string;
  to: string;
  fyId: string | null;
  setPeriod: (next: { from?: string; to?: string; fyId?: string | null }) => void;
  financialYears: TallyFinancialYear[];
}

const PeriodContext = createContext<TallyPeriodValue | null>(null);

export function PeriodProvider({ financialYears, children }: { financialYears: TallyFinancialYear[]; children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const active = useMemo(() => {
    const fyId = params.get('fy');
    return financialYears.find((f) => f.id === fyId) ?? financialYears[0] ?? null;
  }, [params, financialYears]);

  const value: TallyPeriodValue = {
    from: params.get('from') || active?.start_date || '',
    to: params.get('to') || active?.end_date || '',
    fyId: active?.id ?? null,
    financialYears,
    setPeriod: (next) => {
      const p = new URLSearchParams(params);
      if (next.fyId !== undefined) {
        const fy = financialYears.find((f) => f.id === next.fyId);
        if (fy) { p.set('fy', fy.id); p.set('from', fy.start_date); p.set('to', fy.end_date); }
      }
      if (next.from !== undefined) p.set('from', next.from);
      if (next.to !== undefined) p.set('to', next.to);
      setParams(p, { replace: true });
    },
  };
  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>;
}

export function usePeriod(): TallyPeriodValue {
  const ctx = useContext(PeriodContext);
  if (!ctx) throw new Error('usePeriod must be used inside the Tally company workspace.');
  return ctx;
}

export function PeriodBar({ compact }: { compact?: boolean }) {
  const { from, to, fyId, financialYears, setPeriod } = usePeriod();
  return (
    <div className="flex items-center gap-2 flex-wrap" data-testid="tally-period-bar">
      {financialYears.length > 0 ? (
        <select
          value={fyId ?? ''}
          onChange={(e) => setPeriod({ fyId: e.target.value })}
          className="h-8 px-2 text-12 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
          aria-label="Financial year"
        >
          {financialYears.map((f) => (
            <option key={f.id} value={f.id}>FY {f.label}{f.closed ? ' (closed)' : ''}</option>
          ))}
        </select>
      ) : null}
      {compact ? null : (
        <>
          <input
            type="date" value={from} onChange={(e) => setPeriod({ from: e.target.value })}
            className="h-8 px-2 text-12 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
            aria-label="From date"
          />
          <span className="text-12 text-neutral-400">to</span>
          <input
            type="date" value={to} onChange={(e) => setPeriod({ to: e.target.value })}
            className="h-8 px-2 text-12 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
            aria-label="To date"
          />
        </>
      )}
    </div>
  );
}

// ── Layout primitives ────────────────────────────────────────────────

export function ReportHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <header className="flex items-start justify-between gap-4 mb-4 flex-wrap">
      <div>
        <h2 className="text-16 font-semibold text-neutral-900">{title}</h2>
        {subtitle ? <p className="text-12 text-neutral-500 mt-0.5">{subtitle}</p> : null}
      </div>
      <div className="flex items-center gap-2 flex-wrap">{actions}</div>
    </header>
  );
}

export function Panel({ title, actions, children, className = '' }: { title?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`bg-white border border-neutral-200 rounded ${className}`}>
      {title || actions ? (
        <div className="px-3 py-2 border-b border-neutral-100 flex items-center justify-between gap-3">
          {title ? <h3 className="text-13 font-semibold text-neutral-900">{title}</h3> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">{label}</div>;
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="bg-white border border-neutral-200 rounded p-8 text-center">
      <div className="text-14 font-medium text-neutral-900">{title}</div>
      {hint ? <p className="text-13 text-neutral-500 mt-1 max-w-[460px] mx-auto">{hint}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return <div className="bg-white border border-danger/30 rounded p-3 text-13 text-danger">{message}</div>;
}

/** The honest badge for anything the module prepares but cannot file. */
export function StatusPill({ status }: { status: string }) {
  const tone = status === 'validated' ? 'bg-emerald-50 text-emerald-700'
    : status === 'exported' ? 'bg-blue-50 text-blue-700'
    : status === 'cancelled' ? 'bg-neutral-100 text-neutral-500'
    : 'bg-amber-50 text-amber-700';
  return <span className={`text-10 px-1.5 py-0.5 rounded font-medium uppercase tracking-wide ${tone}`}>{status}</span>;
}

// ── Tables ───────────────────────────────────────────────────────────

export interface Column<T> {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  width?: string;
  render?: (row: T) => ReactNode;
  /** Value used for CSV export and sorting when there is no render. */
  value?: (row: T) => string | number | null;
}

export function DataTable<T>({ columns, rows, rowKey, onRowClick, footer, minWidth = '760px', empty = 'Nothing to show for this period.' }: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, i: number) => string;
  onRowClick?: (row: T) => void;
  footer?: ReactNode;
  minWidth?: string;
  empty?: string;
}) {
  if (!rows.length) {
    return <div className="px-3 py-6 text-13 text-neutral-500">{empty}</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-13" style={{ minWidth }}>
        <thead>
          <tr className="text-left text-11 text-neutral-500 tracking-[0.06em] border-b border-neutral-100">
            {columns.map((c) => (
              <th key={c.key} className={`px-3 py-2 font-normal ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''}`} style={c.width ? { width: c.width } : undefined}>
                {c.label.toUpperCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={rowKey(r, i)}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={`border-t border-neutral-100 ${onRowClick ? 'cursor-pointer hover:bg-neutral-50' : ''}`}
            >
              {columns.map((c) => (
                <td key={c.key} className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''}`}>
                  {c.render ? c.render(r) : String(c.value?.(r) ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer ? <tfoot className="border-t-2 border-neutral-200 font-medium">{footer}</tfoot> : null}
      </table>
    </div>
  );
}

/** A drill-down link. Every summary number in this module uses one. */
export function Drill({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className="text-gold hover:underline">{children}</Link>;
}

// ── Export / print ───────────────────────────────────────────────────

export function toCsv<T>(rows: T[], columns: Column<T>[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(c.value ? c.value(r) : '')).join(','));
  return [head, ...body].join('\n');
}

export function downloadCsv<T>(filename: string, rows: T[], columns: Column<T>[]): void {
  downloadText(filename, toCsv(rows, columns), 'text/csv;charset=utf-8');
}

export function downloadText(filename: string, content: string, mime = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ExportButtons<T>({ filename, rows, columns, onPrint }: { filename: string; rows: T[]; columns: Column<T>[]; onPrint?: () => void }) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => downloadCsv(filename, rows, columns)}
        disabled={!rows.length}
        className="h-8 px-2 inline-flex items-center gap-1 text-12 border border-neutral-300 rounded bg-white hover:bg-neutral-50 disabled:opacity-40"
      >
        <Download size={13} strokeWidth={1.75} /> CSV
      </button>
      <button
        type="button"
        onClick={onPrint ?? (() => window.print())}
        className="h-8 px-2 inline-flex items-center gap-1 text-12 border border-neutral-300 rounded bg-white hover:bg-neutral-50"
      >
        <Printer size={13} strokeWidth={1.75} /> Print
      </button>
    </div>
  );
}

/** Parse pasted CSV (used by the bank-statement and master importers). */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim().length);
  if (!lines.length) return { headers: [], rows: [] };
  const split = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
        } else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const headers = split(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const rows = lines.slice(1).map((l) => {
    const cells = split(l);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
  return { headers, rows };
}
