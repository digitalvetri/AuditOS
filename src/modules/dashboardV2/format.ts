/**
 * The one formatINR (UI-BUILD-PROMPT §7).
 *   formatINR(12340)    === '₹12,340'
 *   formatINR(1645520)  === '₹16,45,520'
 *
 * Rupees in, Indian-grouped rupees out. Uses Intl.NumberFormat('en-IN') —
 * hand-rolling the grouping is what produces the ₹1,2340 bug the prompt
 * calls out.
 *
 * The wider codebase's `inr(paise)` in @/lib/format is a paise-in variant of
 * the same helper (still using Intl). Both are correct; they differ in the
 * unit they accept. Kept separate so the dashboard's mock data (rupees, per
 * §8 of the prompt) doesn't have to pretend to be paise.
 */
const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

export function formatINR(rupees: number): string {
  // Intl includes a NBSP after ₹; strip it so the assertion "₹12,340" holds.
  return INR.format(rupees).replace(/ /g, '');
}

/** '07 Sept 2026' */
const DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
export function formatDate(d: string | Date): string {
  const dt = typeof d === 'string' ? new Date(d) : d;
  // en-GB gives "07 Sep 2026" — expand to "Sept" for the four-letter form the
  // prompt uses ("07 SEPT 2026 · 02:28 PM").
  return DATE.format(dt).replace(/\bSep\b/, 'Sept');
}

/** '02:28 PM' */
const TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});
export function formatTime(d: string | Date): string {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return TIME.format(dt);
}

/** '08h 49m' */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
}
