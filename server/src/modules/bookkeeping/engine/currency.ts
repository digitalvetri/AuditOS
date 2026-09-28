/**
 * Multi-currency invariants.
 *
 * All ledger amounts in this engine are INR paise (integer). Foreign
 * amounts are carried alongside the voucher line for display and audit
 * only — they never post to a report. This file holds the one rule that
 * keeps the two sides honest.
 *
 * The rule (BOOKKEEPING-REBUILD.md §4):
 *   round(foreignAmountMinor × exchangeRate) == amountPaise, within ₹1.
 *
 * ₹1 = 100 paise. The tolerance covers ordinary paise-level rounding
 * done at the import boundary and nothing else — a two-rupee gap is a
 * bug in the source data, not a rounding artefact, and must surface.
 */
import { Prisma } from '@prisma/client'

/** ₹1, expressed in paise, is the tolerance we allow. */
const TOLERANCE_PAISE = 100

export interface ForeignBaseInput {
  /** Signed magnitude in minor units of the foreign currency. */
  foreignAmountMinor: number
  /**
   * Exchange rate. Accepts Prisma's Decimal, a JS number, or a decimal
   * string ("84.2582") — whichever shape the caller happens to hold.
   */
  exchangeRate: Prisma.Decimal | number | string
  /** Signed amount in INR paise as it is about to be posted. */
  amountPaise: number
}

/**
 * True if foreign × rate rounds to base within ₹1. Cheap check for
 * previews and the "flag mismatched rows" list on the import screen.
 * Callers that must not proceed on a mismatch should use assert…
 * instead.
 */
export function foreignMatchesBase(input: ForeignBaseInput): boolean {
  const rate = new Prisma.Decimal(input.exchangeRate)
  const expected = new Prisma.Decimal(input.foreignAmountMinor).times(rate)
  const rounded = expected.round().toNumber()
  return Math.abs(rounded - input.amountPaise) <= TOLERANCE_PAISE
}

/**
 * Throws a ForeignBaseMismatch when the row does not satisfy the
 * invariant. Use on the import commit path — a mismatch there means the
 * operator dismissed the preview flag, which is a bug worth stopping.
 */
export function assertForeignMatchesBase(input: ForeignBaseInput): void {
  if (foreignMatchesBase(input)) return
  const rate = new Prisma.Decimal(input.exchangeRate)
  const expected = new Prisma.Decimal(input.foreignAmountMinor).times(rate).round().toNumber()
  throw new ForeignBaseMismatch(
    `Foreign × rate does not match base within ₹1 — ` +
      `foreign=${input.foreignAmountMinor}, rate=${rate.toString()}, ` +
      `expected≈${expected} paise, actual=${input.amountPaise} paise.`,
  )
}

export class ForeignBaseMismatch extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForeignBaseMismatch'
  }
}
