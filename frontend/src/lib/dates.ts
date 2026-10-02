/**
 * IST-local date helpers. Critical for Attendance:
 * `(employee_id, date)` is unique — if we derive the date from UTC, a
 * post-midnight IST check-in gets the wrong `date` and collides or splits.
 *
 * Always store timestamps as UTC ISO strings. Derive display dates via these.
 */

const IST_OFFSET_MIN = 330; // UTC+05:30

function toISTDate(input: string | Date): Date {
  const d = typeof input === 'string' ? new Date(input) : input;
  return new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
}

/** IST-local calendar date as 'YYYY-MM-DD'. Never uses toISOString on UTC. */
export function istDateOf(input: string | Date): string {
  const d = toISTDate(input);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** IST-local 'HH:mm' (24h). */
export function istTimeOf(input: string | Date): string {
  const d = toISTDate(input);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** Compare two 'HH:mm' strings. Returns negative/zero/positive. */
export function compareHHMM(a: string, b: string): number {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return ah * 60 + am - (bh * 60 + bm);
}

/** ISO date arithmetic — add days to a 'YYYY-MM-DD' string. */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** Difference in whole days: b - a. Both 'YYYY-MM-DD'. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const at = Date.UTC(ay, am - 1, ad);
  const bt = Date.UTC(by, bm - 1, bd);
  return Math.round((bt - at) / 86_400_000);
}

/** Today's IST date, for handlers and tests that want "now". */
export function istToday(now: Date = new Date()): string {
  return istDateOf(now);
}
