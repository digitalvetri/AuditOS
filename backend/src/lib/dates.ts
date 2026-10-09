/**
 * IST-local date helpers.
 *
 * Attendance is keyed (employeeId, date) and `date` is an IST calendar day.
 * Deriving it from UTC splits or collides post-midnight IST check-ins, so
 * every calendar-date value in this server goes through these helpers.
 * Timestamps are stored UTC; calendar dates are stored as 'YYYY-MM-DD'.
 */
const IST_OFFSET_MIN = 330 // UTC+05:30

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function toIST(input: string | Date): Date {
  const d = typeof input === 'string' ? new Date(input) : input
  return new Date(d.getTime() + IST_OFFSET_MIN * 60_000)
}

export function istDateOf(input: string | Date): string {
  const d = toIST(input)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export function istTimeOf(input: string | Date): string {
  const d = toIST(input)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

export function compareHHMM(a: string, b: string): number {
  const [ah, am] = a.split(':').map(Number)
  const [bh, bm] = b.split(':').map(Number)
  return ah * 60 + am - (bh * 60 + bm)
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

/** Whole days: b − a. Both 'YYYY-MM-DD'. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

export function istToday(now: Date = new Date()): string {
  return istDateOf(now)
}

export function enumerateDates(startISO: string, endISO: string): string[] {
  const out: string[] = []
  const [sy, sm, sd] = startISO.split('-').map(Number)
  const [ey, em, ed] = endISO.split('-').map(Number)
  const cur = new Date(Date.UTC(sy, sm - 1, sd))
  const end = new Date(Date.UTC(ey, em - 1, ed))
  while (cur.getTime() <= end.getTime()) {
    out.push(
      `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}-${String(cur.getUTCDate()).padStart(2, '0')}`,
    )
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}

export function monthLabel(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number)
  return `${MONTH_NAMES[m - 1]} ${y}`
}

/**
 * Last calendar day of (year, month). Anchored on a canonical UTC-noon
 * date so a caller cannot slip a timezone shift into the "day 0 of next
 * month" trick that produced the 2026-12-30 → 2027-01-30 payroll row.
 */
export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0, 12)).getUTCDate()
}

/** { start: 'YYYY-MM-01', end: 'YYYY-MM-LL' } derived from (year, month). */
export function monthlyPayrollPeriod(year: number, month: number): { start: string; end: string } {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`invalid year: ${year}`)
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`invalid month: ${month}`)
  }
  const mm = String(month).padStart(2, '0')
  const dd = String(lastDayOfMonth(year, month)).padStart(2, '0')
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${dd}` }
}

/**
 * First day of the fiscal year containing `isoDate`, as 'YYYY-MM-01'.
 * Indian FY by default: 1 April. Leave balances are keyed on this value.
 */
export function fiscalYearStartOf(isoDate: string, startMonth = 4): string {
  const [y, m] = isoDate.split('-').map(Number)
  const year = m >= startMonth ? y : y - 1
  return `${year}-${String(startMonth).padStart(2, '0')}-01`
}

/** First day of the fiscal year after the one starting `fyStart`. */
export function nextFiscalYearStart(fyStart: string): string {
  const [y, m] = fyStart.split('-').map(Number)
  return `${y + 1}-${String(m).padStart(2, '0')}-01`
}

/** '06 Sep 2026' — display format for exports and PDFs. */
export function fmtDate(input: string | Date | null | undefined): string {
  if (!input) return '—'
  const iso = typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)
    ? input
    : istDateOf(input)
  const [y, m, d] = iso.split('-').map(Number)
  return `${String(d).padStart(2, '0')} ${MONTH_NAMES[m - 1].slice(0, 3)} ${y}`
}

export function fmtDateTime(input: string | Date | null | undefined): string {
  if (!input) return '—'
  return `${fmtDate(input)}, ${istTimeOf(input)} IST`
}

/** ISO date-only string for a Date, or pass through an existing 'YYYY-MM-DD'. */
export function asISODate(value: string | Date): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : istDateOf(value)
}
