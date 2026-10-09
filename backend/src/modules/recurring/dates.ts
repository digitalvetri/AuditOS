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
