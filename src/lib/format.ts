/**
 * Format helpers locked to §3.
 *   currency:    INR (₹), Indian digit grouping (₹1,25,000)
 *   date_format: DD MMM YYYY   (06 Sep 2026)
 *   time_format: hh:mm A       (09:32 AM)
 *   timezone:    Asia/Kolkata (IST) — store UTC, display IST
 */

const IST = 'Asia/Kolkata';

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** Amount in paise. */
export function inr(amountPaise: number): string {
  return INR.format(amountPaise / 100);
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
  return DATE.format(d);
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
