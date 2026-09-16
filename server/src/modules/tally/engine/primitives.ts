import { ApiError } from '../../../lib/http.js'

/**
 * Shared primitives for the Tally accounting engine.
 *
 * MONEY is an integer number of PAISE everywhere. QUANTITY is an integer
 * number of MILLI-UNITS (qty x 1000). Neither is ever a float: a float
 * rupee is how a trial balance ends up off by a paisa.
 */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function assertDate(value: string, field = 'date'): string {
  if (!DATE_RE.test(value)) throw ApiError.badRequest(`${field} must be YYYY-MM-DD.`)
  return value
}

/** Rupees (string or number, possibly with ₹ and commas) → integer paise. */
export function rupeesToPaise(input: string | number): number {
  const n = typeof input === 'number' ? input : Number(String(input).replace(/[₹,\s]/g, ''))
  if (!Number.isFinite(n)) throw ApiError.badRequest('Amount is not a number.')
  return Math.round(n * 100)
}

export function paiseToRupees(paise: number): number {
  return Math.round(paise) / 100
}

/** Display helper used by exports and printed documents. */
export function formatPaise(paise: number): string {
  const neg = paise < 0
  const s = (Math.abs(paise) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })
  return (neg ? '-' : '') + s
}

/** Quantity in display units → integer milli-units. */
export function qtyToMilli(qty: string | number): number {
  const n = typeof qty === 'number' ? qty : Number(String(qty).replace(/[,\s]/g, ''))
  if (!Number.isFinite(n)) throw ApiError.badRequest('Quantity is not a number.')
  return Math.round(n * 1000)
}

export function milliToQty(milli: number): number {
  return Math.round(milli) / 1000
}

/**
 * Apply a basis-point rate to a paise amount, rounding half-up. 1800 bp
 * is 18%. Rounding happens once, here, so CGST and SGST on the same line
 * always agree to the paisa.
 */
export function applyBp(amountPaise: number, bp: number): number {
  return Math.round((amountPaise * bp) / 10000)
}

/** Percentage (e.g. 12.5) → basis points (1250). */
export function pctToBp(pct: number): number {
  return Math.round(pct * 100)
}

export function bpToPct(bp: number): number {
  return bp / 100
}

/** Difference to the nearest rupee — what a round-off ledger line carries. */
export function roundOffToRupee(paise: number): number {
  const rupees = Math.round(paise / 100) * 100
  return rupees - paise
}

/** Inclusive date-range predicate on ISO 'YYYY-MM-DD' strings. */
export function withinRange(date: string, from?: string | null, to?: string | null): boolean {
  if (from && date < from) return false
  if (to && date > to) return false
  return true
}

/** Whole months between two ISO dates, used for ageing buckets. */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + 'T00:00:00Z')
  const b = Date.parse(toIso + 'T00:00:00Z')
  return Math.round((b - a) / 86_400_000)
}

/** Add days to an ISO date, staying in UTC so IST dates never drift. */
export function addDays(iso: string, days: number): string {
  const d = new Date(Date.parse(iso + 'T00:00:00Z') + days * 86_400_000)
  return d.toISOString().slice(0, 10)
}

export const AGEING_BUCKETS = [
  { key: 'not_due', label: 'Not due', from: -Infinity, to: 0 },
  { key: '0_30', label: '0–30 days', from: 1, to: 30 },
  { key: '31_60', label: '31–60 days', from: 31, to: 60 },
  { key: '61_90', label: '61–90 days', from: 61, to: 90 },
  { key: '90_plus', label: '90+ days', from: 91, to: Infinity },
] as const

export type AgeingBucketKey = typeof AGEING_BUCKETS[number]['key']

export function ageingBucketFor(daysOverdue: number): AgeingBucketKey {
  for (const b of AGEING_BUCKETS) {
    if (daysOverdue >= b.from && daysOverdue <= b.to) return b.key
  }
  return '90_plus'
}
