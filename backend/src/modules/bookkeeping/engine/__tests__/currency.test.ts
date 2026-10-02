import { describe, expect, it } from 'vitest'
import {
  assertForeignMatchesBase,
  foreignMatchesBase,
  ForeignBaseMismatch,
} from '../currency.js'

/**
 * The real row from the client's Sales sheet (§1.1 of the spec).
 *   1050.63 × 84.2582 = 88,524.19267… paise-exact = 8,852,419 paise.
 *   The client's own INR column reads 88,524.20769 = 8,852,421 paise —
 *   2 paise apart, which is exactly the paise-level rounding the ₹1
 *   tolerance is designed to swallow.
 */
const KS_MATH_EXACT_PAISE = 8_852_419
const KS_SALES_ROW = {
  foreignAmountMinor: 105_063, // 1050.63 SGD in cents
  exchangeRate: '84.2582',
  amountPaise: 8_852_421, // what the client actually typed
}

describe('foreignMatchesBase', () => {
  it("accepts the real KS row even though the client's INR is 2 paise off the exact product", () => {
    expect(foreignMatchesBase(KS_SALES_ROW)).toBe(true)
  })

  it('accepts exactly ₹1 away from the math-exact product — the tolerance boundary', () => {
    expect(
      foreignMatchesBase({ ...KS_SALES_ROW, amountPaise: KS_MATH_EXACT_PAISE + 100 }),
    ).toBe(true)
  })

  it('rejects ₹1.01 away — that is a data bug, not rounding', () => {
    expect(
      foreignMatchesBase({ ...KS_SALES_ROW, amountPaise: KS_MATH_EXACT_PAISE + 101 }),
    ).toBe(false)
  })

  it('accepts a plain-number rate', () => {
    expect(foreignMatchesBase({ ...KS_SALES_ROW, exchangeRate: 84.2582 })).toBe(true)
  })

  it('rejects if a rate is off by even the last digit', () => {
    // 1050.63 × 84.2683 = 88,534.82 paise — well beyond ₹1.
    expect(foreignMatchesBase({ ...KS_SALES_ROW, exchangeRate: '84.2683' })).toBe(false)
  })
})

describe('assertForeignMatchesBase', () => {
  it('is a no-op when the row balances', () => {
    expect(() => assertForeignMatchesBase(KS_SALES_ROW)).not.toThrow()
  })

  it('throws ForeignBaseMismatch when the row does not balance', () => {
    expect(() =>
      assertForeignMatchesBase({ ...KS_SALES_ROW, amountPaise: 9_000_000 }),
    ).toThrowError(ForeignBaseMismatch)
  })

  it('the error message names the actual and expected numbers so the operator can chase the source', () => {
    try {
      assertForeignMatchesBase({ ...KS_SALES_ROW, amountPaise: 9_000_000 })
    } catch (e) {
      expect((e as Error).message).toContain('9000000')
      expect((e as Error).message).toContain(String(KS_MATH_EXACT_PAISE))
      return
    }
    throw new Error('expected assertForeignMatchesBase to throw')
  })
})
