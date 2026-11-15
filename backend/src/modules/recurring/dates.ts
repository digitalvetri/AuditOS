/**
 * Retainer date arithmetic. Pure, date-only, UTC — no timezone can move an
 * invoice a day either way.
 *
 * Every occurrence is computed from (year, month, dayOfMonth) — never by
 * stepping from the previous date — so a 31st-of-the-month retainer goes
 * Jan 31 → Feb 28 → Mar 31, not Jan 31 → Feb 28 → Mar 28.
 * dayOfMonth 31 means "month end"; 29/30 are clamped to short months.
 */
export const FREQUENCIES = ['monthly', 'quarterly', 'half_yearly', 'annual'] as const
export type Frequency = (typeof FREQUENCIES)[number]

export const STEP_MONTHS: Record<Frequency, number> = { monthly: 1, quarterly: 3, half_yearly: 6, annual: 12 }

function lastDay(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()
}

/** The occurrence in (year, month0) — month0 may overflow; it is normalised. */
export function occurrence(year: number, month0: number, dayOfMonth: number): string {
  const y = year + Math.floor(month0 / 12)
  const m = ((month0 % 12) + 12) % 12
  const d = Math.min(dayOfMonth >= 31 ? 31 : dayOfMonth, lastDay(y, m))
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function ym(iso: string): [number, number] {
  const [y, m] = iso.split('-').map(Number)
  return [y, m - 1]
}

/** The first issue date on or after `startDate`, stepping by the frequency from the start month. */
export function firstIssueDate(startDate: string, frequency: Frequency, dayOfMonth: number): string {
  const [y, m] = ym(startDate)
  let k = 0
  let d = occurrence(y, m, dayOfMonth)
  while (d < startDate) { k++; d = occurrence(y, m + k * STEP_MONTHS[frequency], dayOfMonth) }
  return d
}

/** The issue date after `current`. */
export function nextIssueDate(current: string, frequency: Frequency, dayOfMonth: number): string {
  const [y, m] = ym(current)
  return occurrence(y, m + STEP_MONTHS[frequency], dayOfMonth)
}

/** Canonical days-in-period for non-monthly cadences. Keeps proration
 *  arithmetic stable across quarters that happen to have 90 vs 92 days. */
const DAYS_PER_PERIOD: Record<Frequency, number> = {
  monthly: 30, quarterly: 91, half_yearly: 182, annual: 365,
}

/** Days from `from` (inclusive) to `to` (exclusive). Date-only, UTC. */
function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const a = Date.UTC(fy, fm - 1, fd) / 86_400_000
  const b = Date.UTC(ty, tm - 1, td) / 86_400_000
  return Math.max(0, Math.round(b - a))
}

/**
 * Proration factor for a mid-period start (POST-DELIVERY-CHANGES §E2).
 * `start` is the retainer startDate; `fullIssue` is the first on-schedule
 * issue date on or after start. Monthly retainers use the actual days in
 * start's month so a July start pays per actual 31 days; longer cadences
 * use a canonical length (above) so a quarter that happens to have 90 vs
 * 92 days doesn't nudge the fee around.
 *
 * Returns 1 when no stub exists (start already matches fullIssue).
 */
export function prorateFactor(start: string, fullIssue: string, frequency: Frequency): number {
  if (start >= fullIssue) return 1
  const stubDays = daysBetween(start, fullIssue)
  const [y, m] = ym(start)
  const periodDays = frequency === 'monthly' ? lastDay(y, m) : DAYS_PER_PERIOD[frequency]
  if (periodDays <= 0) return 1
  // Defensive cap: a bad configuration should never make the stub charge
  // MORE than a full period.
  return Math.min(1, Math.max(0, stubDays / periodDays))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 'Oct 2026' / 'Oct–Dec 2026' / 'Apr 2026 – Mar 2027' — the period an issue date bills. */
export function periodLabel(issueDate: string, frequency: Frequency): string {
  const [y, m] = ym(issueDate)
  const span = STEP_MONTHS[frequency]
  if (span === 1) return `${MONTHS[m]} ${y}`
  const endM = m + span - 1
  const endY = y + Math.floor(endM / 12)
  const e = endM % 12
  return endY === y ? `${MONTHS[m]}–${MONTHS[e]} ${y}` : `${MONTHS[m]} ${y} – ${MONTHS[e]} ${endY}`
}
