/**
 * Format helpers locked to §3.
 *   currency:    INR (₹), Indian digit grouping (₹1,25,000)
 *   date_format: DD MMM YYYY   (06 Sep 2026)
 *   time_format: hh:mm A       (09:32 AM)
 *   timezone:    Asia/Kolkata (IST) — store UTC, display IST
 */

const IST = 'Asia/Kolkata';

// ── Money ──────────────────────────────────────────────────────────────────
// The ONE implementation of INR formatting. Every other money helper in the
// app (dashboardV2/format, gst/api, bookkeeping/ui, invoices/document,
// quotations/api, engagement/document) wraps one of these.
//
// Naming: `…Rupees` takes rupees (a JS number); `…Paise` takes integer paise,
// which is how the server sends every amount.

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** '12,34,567' / '12,34,567.5' — rupees in, Indian grouping, no symbol. */
export function formatRupeeAmount(rupees: number, decimals: { min?: number; max?: number } = {}): string {
  const min = decimals.min ?? 0;
  const max = Math.max(decimals.max ?? min, min);
  return rupees.toLocaleString('en-IN', { minimumFractionDigits: min, maximumFractionDigits: max });
}

/** '₹12,34,567' — rupees in, whole rupees, no space after the symbol. */
export function formatRupees(rupees: number): string {
  // Some engines put a NBSP after ₹; strip it so '₹12,340' holds everywhere.
  return INR.format(rupees).replace(/ /g, '');
}

/** '₹12,34,567' — paise in, whole rupees. */
export function formatPaise(amountPaise: number): string {
  return INR.format(amountPaise / 100);
}

/** Amount in paise — the original name of `formatPaise`. */
export const inr = formatPaise;

/**
 * '12,34,567.00' — paise in, always two decimals, no symbol, computed in
 * integer arithmetic (no float rounding). Printed documents use this.
 */
export function formatPaiseExact(paise: number): string {
  const neg = paise < 0;
  const n = Math.abs(paise);
  const whole = Math.floor(n / 100);
  const frac = String(n % 100).padStart(2, '0');
  const s = String(whole);
  // Last three digits, then pairs — the Indian lakh/crore grouping.
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${neg ? '-' : ''}${grouped}.${frac}`;
}

const DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

/** '06 Sep 2026' */
export function fmtDate(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  // Newer CLDR data (Chrome, Node 20+) abbreviates September as "Sept" in en-GB.
  return DATE.format(d).replace('Sept', 'Sep');
}

const TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: IST,
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

/** '09:32 AM' */
export function fmtTime(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  return TIME.format(d).replace(/\s?([ap])m/i, ' $1M').replace('am', 'AM').replace('pm', 'PM');
}

/** '06 Sep 2026 · 09:32 AM' */
export function fmtDateTime(input: string | Date): string {
  return `${fmtDate(input)} · ${fmtTime(input)}`;
}

/** '08h 49m' — minutes to display duration */
export function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${hh}h ${mm}m`;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** 'August 2026' — the payroll period label used in tables and payslips. */
export function monthLabel(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
