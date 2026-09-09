import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { booksApi } from './api';
import type { BooksOrg, Minor } from './types';
import { money } from './format';

/**
 * Books UI kit. Reuses the platform's tokens and the Workstation table
 * conventions; adds only what bookkeeping needs — right-aligned money
 * cells, a debit/credit pair, a period picker.
 */

// ── The current set of books ──────────────────────────────────────────────
interface BooksCtx { org: BooksOrg; orgId: string; canSettings: boolean; canReports: boolean; canAccountant: boolean; canWrite: boolean }
const Ctx = createContext<BooksCtx | null>(null);

export function useBooks(): BooksCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBooks must be used inside <BooksOrgProvider>');
  return v;
}

/** Resolves :orgId from the route and loads the set of books once. */
export function BooksOrgProvider({ children }: { children: (ctx: BooksCtx) => ReactNode }) {
  const { orgId = '' } = useParams();
  const q = useQuery({ queryKey: ['books', orgId, 'org'], queryFn: () => booksApi.org(orgId).get(), enabled: Boolean(orgId) });
  const value = useMemo<BooksCtx | null>(() => {
    if (!q.data) return null;
    const role = q.data.my_role ?? 'viewer';
    return { org: q.data, orgId, canSettings: Boolean(q.data.areas?.settings), canReports: Boolean(q.data.areas?.reports), canAccountant: Boolean(q.data.areas?.accountant), canWrite: role !== 'viewer' };
  }, [q.data, orgId]);
  if (q.isLoading) return <div className="h-40 bg-neutral-100 rounded" aria-label="Loading" />;
  if (q.isError) {
    const status = (q.error as { status?: number }).status;
    return (
      <div className="max-w-[640px] bg-white border border-neutral-200 rounded p-6">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{status === 403 ? 'Access denied' : 'Not found'}</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">{status === 403 ? 'You are not assigned to this set of books.' : 'This set of books does not exist.'}</h1>
        <p className="text-13 text-neutral-500 mt-2">Ask an administrator to add you, or pick another set of books.</p>
      </div>
    );
  }
  return <Ctx.Provider value={value}>{value ? children(value) : null}</Ctx.Provider>;
}

// ── Money ─────────────────────────────────────────────────────────────────
export function Money({ value, currency = 'INR', muted = false, bold = false, zero = '—', className = '' }: { value: Minor | null | undefined; currency?: string; muted?: boolean; bold?: boolean; zero?: string; className?: string }) {
  if (value === null || value === undefined || (value === 0 && zero !== '0')) {
    return <span className={`tabular-nums text-neutral-400 ${className}`}>{zero}</span>;
  }
  return <span className={`tabular-nums ${muted ? 'text-neutral-500' : value < 0 ? 'text-red' : 'text-neutral-900'} ${bold ? 'font-medium' : ''} ${className}`}>{money(value, currency)}</span>;
}

export function MoneyCell({ value, currency, bold, zero, className = '' }: { value: Minor | null | undefined; currency?: string; bold?: boolean; zero?: string; className?: string }) {
  return <td className={`px-3 text-13 text-right whitespace-nowrap ${className}`}><Money value={value} currency={currency} bold={bold} zero={zero} /></td>;
}

// ── Layout ────────────────────────────────────────────────────────────────
export function Section({ title, right, children, className = '' }: { title?: string; right?: ReactNode; children: ReactNode; className?: string }) {
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

export function Tile({ label, value, hint, tone = 'default' }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'warn' | 'good' }) {
  return (
    <div className="bg-white border border-neutral-200 rounded p-4">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className={`text-20 font-semibold tabular-nums mt-1 ${tone === 'warn' ? 'text-red' : tone === 'good' ? 'text-neutral-900' : 'text-neutral-900'}`}>{value}</div>
      {hint ? <div className="text-12 text-neutral-500 mt-1">{hint}</div> : null}
    </div>
  );
}

export function Field({ label, hint, error, children, className = '' }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">{label}</span>
      {children}
      {error ? <span className="block text-12 text-red mt-1">{error}</span> : hint ? <span className="block text-12 text-neutral-500 mt-1">{hint}</span> : null}
    </label>
  );
}

export const inputCls = 'h-8 w-full px-2 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold';
export const selectCls = inputCls;

export function TextInput({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return <input {...rest} value={value} onChange={(e) => onChange(e.target.value)} className={`${inputCls} ${rest.className ?? ''}`} />;
}

export function MoneyInput({ value, onChange, className = '', ...rest }: { value: string; onChange: (v: string) => void; className?: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return <input {...rest} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.-]/g, ''))} className={`${inputCls} text-right tabular-nums ${className}`} />;
}

export function Select<T extends string>({ value, onChange, options, placeholder, className = '', disabled }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; placeholder?: string; className?: string; disabled?: boolean }) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)} className={`${selectCls} ${className}`}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  const border = tone === 'error' ? 'border-red' : tone === 'warn' ? 'border-amber' : 'border-neutral-400';
  return <div className={`border-l-2 ${border} bg-white px-3 py-2 text-12 text-neutral-600`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-6 text-13 text-neutral-500">{children}</div>;
}

// ── Table ─────────────────────────────────────────────────────────────────
export function Table({ head, children, minWidth = 720 }: { head: (string | { label: string; align?: 'right' | 'left' })[]; children: ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-neutral-200">
            {head.map((h, i) => {
              const label = typeof h === 'string' ? h : h.label;
              const align = typeof h === 'string' ? 'left' : h.align ?? 'left';
              return <th key={`${label}-${i}`} className={`h-8 px-3 text-11 uppercase tracking-[0.06em] font-medium text-neutral-500 whitespace-nowrap text-${align}`}>{label}</th>;
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Row({ onClick, border, children, muted = false }: { onClick?: () => void; border?: 'red' | 'amber' | 'neutral' | null; children: ReactNode; muted?: boolean }) {
  const b = border === 'red' ? 'border-l-2 border-red' : border === 'amber' ? 'border-l-2 border-amber' : border === 'neutral' ? 'border-l-2 border-neutral-400' : 'border-l-2 border-transparent';
  return <tr onClick={onClick} className={`h-10 border-b border-neutral-200 ${b} ${muted ? 'opacity-60' : ''} ${onClick ? 'cursor-pointer hover:bg-neutral-50' : ''}`}>{children}</tr>;
}

export function Cell({ children = null, className = '', muted = false, right = false, colSpan }: { children?: ReactNode; className?: string; muted?: boolean; right?: boolean; colSpan?: number }) {
  return <td colSpan={colSpan} className={`px-3 text-13 ${muted ? 'text-neutral-500' : 'text-neutral-900'} ${right ? 'text-right' : ''} ${className}`}>{children}</td>;
}

// ── Period picker ─────────────────────────────────────────────────────────
export function PeriodPicker({ from, to, onChange, asOfOnly = false }: { from: string; to: string; onChange: (from: string, to: string) => void; asOfOnly?: boolean }) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      {asOfOnly ? null : (
        <Field label="From"><input type="date" value={from} onChange={(e) => onChange(e.target.value, to)} className={inputCls} /></Field>
      )}
      <Field label={asOfOnly ? 'As of' : 'To'}><input type="date" value={to} onChange={(e) => onChange(from, e.target.value)} className={inputCls} /></Field>
    </div>
  );
}
