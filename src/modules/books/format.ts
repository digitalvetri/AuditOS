import type { DocKind, DocStatus, Minor } from './types';
import type { StatusVariant } from '@/components/StatusRow';

/** Paise → '₹1,25,000.00'. Amounts are always integers; never a float. */
const FMT = new Map<string, Intl.NumberFormat>();
export function money(v: Minor | undefined | null, currency = 'INR', decimals = 2): string {
  const n = (v ?? 0) / 100;
  const key = `${currency}:${decimals}`;
  let f = FMT.get(key);
  if (!f) {
    f = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    FMT.set(key, f);
  }
  return f.format(n);
}

/** Compact for dashboard tiles: ₹12.5L, ₹1.2Cr. */
export function moneyShort(v: Minor, currency = 'INR'): string {
  const n = Math.abs(v) / 100;
  const sign = v < 0 ? '-' : '';
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  if (currency !== 'INR') return money(v, currency, 0);
  if (n >= 1e7) return `${sign}${symbol}${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `${sign}${symbol}${(n / 1e5).toFixed(2)} L`;
  return money(v, currency, 0);
}

export const bp = (v: number) => `${(v / 100).toFixed(v % 100 === 0 ? 0 : 2)}%`;

/** Rupees typed by a user → paise, without float drift. */
export function toPaise(input: string | number): number {
  const s = String(input).trim().replace(/[₹,\s]/g, '');
  if (!s) return 0;
  const m = /^(-?)(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return NaN;
  const [, sign, whole, frac = ''] = m;
  return Number(`${sign}${whole || '0'}${frac.padEnd(2, '0')}`);
}
export const fromPaise = (v: Minor) => (v / 100).toFixed(2);

export const DOC_LABEL: Record<DocKind, string> = {
  estimate: 'Estimate', sales_order: 'Sales order', invoice: 'Invoice', retainer_invoice: 'Retainer invoice',
  credit_note: 'Credit note', purchase_order: 'Purchase order', bill: 'Bill', vendor_credit: 'Vendor credit',
};
export const DOC_PLURAL: Record<DocKind, string> = {
  estimate: 'Estimates', sales_order: 'Sales orders', invoice: 'Invoices', retainer_invoice: 'Retainer invoices',
  credit_note: 'Credit notes', purchase_order: 'Purchase orders', bill: 'Bills', vendor_credit: 'Vendor credits',
};
export const SALES_KINDS: DocKind[] = ['estimate', 'sales_order', 'invoice', 'retainer_invoice', 'credit_note'];
export const isSalesKind = (k: DocKind) => SALES_KINDS.includes(k);

export function docStatus(s: DocStatus): { variant: StatusVariant; label: string } {
  switch (s) {
    case 'draft': return { variant: 'awaiting', label: 'Draft' };
    case 'sent': return { variant: 'awaiting', label: 'Sent' };
    case 'accepted': return { variant: 'ok', label: 'Accepted' };
    case 'declined': return { variant: 'problem', label: 'Declined' };
    case 'expired': return { variant: 'problem', label: 'Expired' };
    case 'posted': return { variant: 'pending', label: 'Open' };
    case 'partially_paid': return { variant: 'pending', label: 'Partly paid' };
    case 'paid': return { variant: 'ok', label: 'Paid' };
    case 'closed': return { variant: 'ok', label: 'Closed' };
    case 'void': return { variant: 'problem', label: 'Void' };
    default: return { variant: 'awaiting', label: String(s) };
  }
}

export function journalStatus(s: string): { variant: StatusVariant; label: string } {
  return s === 'posted' ? { variant: 'ok', label: 'Posted' } : s === 'void' ? { variant: 'problem', label: 'Void' } : { variant: 'awaiting', label: 'Draft' };
}

export const VOUCHER_LABEL: Record<string, string> = {
  journal: 'Manual journal', opening: 'Opening balance', invoice: 'Invoice', retainer_invoice: 'Retainer invoice',
  credit_note: 'Credit note', bill: 'Bill', vendor_credit: 'Vendor credit', payment_in: 'Payment received',
  payment_out: 'Payment made', transfer: 'Bank transfer', revaluation: 'FX revaluation', retainer_apply: 'Retainer applied',
  credit_apply: 'Credit applied', vendor_credit_apply: 'Vendor credit applied',
};

export const ROOT_LABEL: Record<string, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses' };

export function today(): string { return new Date().toISOString().slice(0, 10); }
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
/** Financial year containing `date`, starting in `startMonth`. */
export function fyRange(date: string, startMonth = 4): { from: string; to: string } {
  const [y, m] = date.split('-').map(Number);
  const startYear = m >= startMonth ? y : y - 1;
  const from = `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
  const endDate = new Date(Date.UTC(startYear + 1, startMonth - 1, 0));
  return { from, to: endDate.toISOString().slice(0, 10) };
}

/** Rows → CSV download, used by every report. */
export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void {
  const esc = (v: string | number) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
