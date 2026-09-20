/**
 * BOOKKEEPING date generators.
 *
 * Every calendar date this module produces is an internal commitment:
 * bookkeeping has no statutory deadline, so the number of days after
 * period-end at which a period is due lives on `BookkeepingEngagement`
 * per client (`dueOffsetDays`, default 5). None of the formulas below
 * contain a hard-coded date; they read config or read the period window.
 *
 * All values are 'YYYY-MM-DD' strings, matching the rest of the schema —
 * `Date` objects are avoided so a computation never drifts across the
 * IST/UTC edge.
 */
import { addDays } from '../../lib/dates.js'

export type BookkeepingFrequency = 'monthly' | 'quarterly' | 'annual'

/** First day of the period identified by (year, month, frequency). */
export function periodStartOf(year: number, month: number, _frequency: BookkeepingFrequency = 'monthly'): string {
  // The `month` column identifies the period even for quarterly/annual
  // frequencies (it stores the START month of the quarter or the fiscal
  // year), so the start day is always the 1st of that month regardless of
  // frequency. The frequency shows up in `periodEndOf`.
  return `${year}-${String(month).padStart(2, '0')}-01`
}

/** Last day of the period identified by (year, month, frequency). */
export function periodEndOf(year: number, month: number, frequency: BookkeepingFrequency = 'monthly'): string {
  const spanMonths = frequency === 'quarterly' ? 3 : frequency === 'annual' ? 12 : 1
  // Day 0 of month (n+1) is the last day of month n. Overflow into next year
  // is handled by Date semantics — Date.UTC(2026, 12, 0) = 2026-12-31 already.
  const startMonthIndex = month - 1 + (spanMonths - 1) // 0-based index of the LAST month in the window
  const y = year + Math.floor(startMonthIndex / 12)
  const mIndex = startMonthIndex % 12
  const dt = new Date(Date.UTC(y, mIndex + 1, 0))
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

/**
 * Day of the week for 'YYYY-MM-DD'. 0 = Sunday, 6 = Saturday. Uses UTC so
 * the answer never changes with the caller's timezone; the input is a
 * calendar date and has no notion of hour anyway.
 */
export function dowOf(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/**
 * Slide a date forward to the next Mon–Fri if it lands on a weekend. India's
 * gazetted holidays are NOT accounted for here yet — that needs a holiday
 * table and belongs to a follow-up PR. When one exists this helper will read
 * from it; the shape of `computeDueDate` is designed so the caller does not
 * change either way.
 */
export function rollForwardBusinessDay(isoDate: string): string {
  const day = dowOf(isoDate)
  if (day === 0) return addDays(isoDate, 1) // Sun → Mon
  if (day === 6) return addDays(isoDate, 2) // Sat → Mon
  return isoDate
}

/**
 * A period's due date is the last day of the period plus the engagement's
 * agreed turnaround, rolled off any weekend. Never negative.
 */
export function computeDueDate(periodEnd: string, offsetDays: number): string {
  return rollForwardBusinessDay(addDays(periodEnd, Math.max(0, offsetDays)))
}
