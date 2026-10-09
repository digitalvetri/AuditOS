/**
 * All money in this application is an integer number of paise.
 * Rounding rule (HRMS-Part-2.md §3): nearest rupee, half-up.
 */
export const RUPEE = 100

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * RUPEE)
}

/** Half-up to the nearest rupee, returned in paise. */
export function roundToRupeePaise(paise: number): number {
  const sign = paise < 0 ? -1 : 1
  const abs = Math.abs(paise)
  return sign * Math.floor((abs + RUPEE / 2) / RUPEE) * RUPEE
}

/** Percentage of a paise amount, rounded half-up to the rupee. */
export function pctOfPaise(paise: number, rate: number): number {
  return roundToRupeePaise(paise * rate)
}

/** "₹ 1,25,000.00" — Indian digit grouping (Part 1 §3). */
export function formatINR(paise: number): string {
  const negative = paise < 0
  const abs = Math.abs(paise)
  const rupees = Math.floor(abs / RUPEE)
  const fraction = String(abs % RUPEE).padStart(2, '0')
  const digits = String(rupees)
  let grouped: string
  if (digits.length <= 3) {
    grouped = digits
  } else {
    const last3 = digits.slice(-3)
    const rest = digits.slice(0, -3)
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3
  }
  return `${negative ? '-' : ''}₹ ${grouped}.${fraction}`
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function twoDigits(n: number): string {
  if (n < 20) return ONES[n]
  const t = Math.floor(n / 10)
  const o = n % 10
  return TENS[t] + (o ? ' ' + ONES[o] : '')
}

/** Net pay in words on the payslip (§8.4) — Indian numbering. */
export function amountInWords(paise: number): string {
  const rupees = Math.floor(Math.abs(paise) / RUPEE)
  const paiseRemainder = Math.abs(paise) % RUPEE
  if (rupees === 0 && paiseRemainder === 0) return 'Rupees Zero Only'

  const parts: string[] = []
  const crore = Math.floor(rupees / 10000000)
  const lakh = Math.floor((rupees % 10000000) / 100000)
  const thousand = Math.floor((rupees % 100000) / 1000)
  const hundred = Math.floor((rupees % 1000) / 100)
  const rest = rupees % 100

  if (crore) parts.push(`${twoDigits(crore)} Crore`)
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`)
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`)
  if (hundred) parts.push(`${ONES[hundred]} Hundred`)
  if (rest) parts.push(`${parts.length ? 'and ' : ''}${twoDigits(rest)}`)

  let words = `Rupees ${parts.join(' ')}`
  if (paiseRemainder) words += ` and ${twoDigits(paiseRemainder)} Paise`
  return `${words} Only`
}

/**
 * A paise value read from a BigInt (int8) column, or an aggregate over one,
 * as a plain number. Integer paise are exact in a double up to 2^53
 * (≈ ₹90 lakh crore), so the engines keep their arithmetic in `number` and
 * only the Prisma boundary converts. Anything beyond that is refused, never
 * silently rounded.
 */
export function toNum(v: bigint | number): number
export function toNum(v: bigint | number | null): number | null
export function toNum(v: bigint | number | null | undefined): number | null | undefined
export function toNum(v: bigint | number | null | undefined): number | null | undefined {
  if (v == null || typeof v === 'number') return v
  if (v > MAX_EXACT || v < -MAX_EXACT) throw new RangeError(`Amount ${v} paise is beyond exact range.`)
  return Number(v)
}
const MAX_EXACT = BigInt(Number.MAX_SAFE_INTEGER)

/** `T` with the named BigInt fields typed as number (null stays null). */
export type Numified<T, K extends keyof T> = Omit<T, K> & {
  [P in K]: Exclude<T[P], bigint> | (bigint extends T[P] ? number : never)
}

/** Copy of a loaded row with the named BigInt paise fields converted by toNum. */
export function numify<T extends object, K extends keyof T>(row: T, ...keys: K[]): Numified<T, K> {
  const out = { ...row } as Record<keyof T, unknown>
  for (const k of keys) out[k] = toNum(row[k] as bigint | number | null | undefined)
  return out as Numified<T, K>
}
