/**
 * Money is BigInt minor units (paise). Rates and percentages are integers
 * too: basis points (1800 = 18.00 %). Rounding is half-up, which is what
 * Indian invoices expect. Never a float in an amount.
 */
export type Minor = bigint

export function toMinor(v: number | string | bigint | null | undefined): Minor {
  if (v === null || v === undefined || v === '') return 0n
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('money: not a number')
    return BigInt(Math.round(v))
  }
  const s = v.trim()
  if (!/^-?\d+$/.test(s)) throw new Error(`money: not an integer minor amount: ${v}`)
  return BigInt(s)
}

export function num(v: Minor): number {
  const n = Number(v)
  if (!Number.isSafeInteger(n)) throw new Error('money: amount exceeds safe integer range')
  return n
}

export function abs(v: Minor): Minor { return v < 0n ? -v : v }

/** amount × bp / 10000, half-up. */
export function applyBp(amount: Minor, bp: number): Minor {
  return divRound(amount * BigInt(Math.round(bp)), 10_000n)
}

/** amount × rate (a float such as an exchange rate), half-up. */
export function applyRate(amount: Minor, rate: number): Minor {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('money: rate must be positive')
  // Work in micro-rate integers to keep BigInt arithmetic exact.
  const micro = BigInt(Math.round(rate * 1_000_000))
  return divRound(amount * micro, 1_000_000n)
}

/** Integer division rounding half away from zero. */
export function divRound(n: Minor, d: Minor): Minor {
  if (d === 0n) throw new Error('money: divide by zero')
  const neg = (n < 0n) !== (d < 0n)
  const an = abs(n), ad = abs(d)
  const q = an / ad
  const r = an % ad
  const rounded = r * 2n >= ad ? q + 1n : q
  return neg ? -rounded : rounded
}

/** Tax-inclusive price → taxable base: gross × 10000 / (10000 + bp). */
export function exclusiveOf(gross: Minor, bp: number): Minor {
  return divRound(gross * 10_000n, 10_000n + BigInt(Math.round(bp)))
}

/** Round to the nearest whole rupee; returns [rounded, roundOffDelta]. */
export function roundToRupee(amount: Minor): [Minor, Minor] {
  const rounded = divRound(amount, 100n) * 100n
  return [rounded, rounded - amount]
}

export function sum(values: Iterable<Minor>): Minor {
  let t = 0n
  for (const v of values) t += v
  return t
}

/** Quantity is a float (2.5 hrs); rate × qty, half-up. */
export function timesQty(rate: Minor, qty: number): Minor {
  const micro = BigInt(Math.round(qty * 1_000_000))
  return divRound(rate * micro, 1_000_000n)
}

/** '1,25,000.00' style display, from minor units. */
export function fmtMinor(v: Minor, currency = 'INR'): string {
  const n = num(v) / 100
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n)
}
