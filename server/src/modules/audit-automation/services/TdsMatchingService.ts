import type { NormalizedTdsEntry } from '../parsers/tdsTypes.js'
import { normalizeTan, normalizeSection } from '../parsers/tdsTypes.js'

/**
 * Deterministic 3-pass matcher for Form 26AS vs Books TDS register.
 *
 *   Pass 1 EXACT      (tan, section, quarter, tdsAmount) match on both sides
 *   Pass 2 TOLERANCE  (tan, section, quarter); tdsAmount ±₹1 or 0.1%.
 *                     Amount / date discrepancies become mismatchFields.
 *   Pass 3 RESIDUALS  remaining 26AS → only_26as (extra credit — good news);
 *                     remaining Books → only_books (chase the deductor).
 *
 * Amounts are paise. Auditor action defaults per bucket, overridable.
 */

export interface MatcherInput {
  filing26AS: (NormalizedTdsEntry & { id: string })[]
  books: (NormalizedTdsEntry & { id: string })[]
}

export type TdsMatchStatus = 'verified' | 'variance' | 'only_26as' | 'only_books'
export type TdsActionStatus = 'no_action' | 'chase_deductor' | 'revise_book' | 'credit_claimed' | 'written_off'

export interface TdsMatchedRow {
  matchStatus: TdsMatchStatus
  filing26ASEntryId?: string
  booksEntryId?: string
  mismatchFields: string[]
  actionStatus: TdsActionStatus
}

export interface TdsTotals {
  amountPaid: number
  tdsAmount: number
  count: number
}
export type TdsTotalsByBucket = Record<TdsMatchStatus, TdsTotals>

export interface TdsMatcherResult {
  rows: TdsMatchedRow[]
  totals: TdsTotalsByBucket
}

const RUPEE_TOLERANCE_PAISE = 100 // ₹1
const PERCENT_TOLERANCE = 0.001    // 0.1%

function keyExact(e: NormalizedTdsEntry): string {
  return [normalizeTan(e.deductorTan), normalizeSection(e.section), e.quarter, String(e.tdsAmount)].join('|')
}
function keyFuzzy(e: NormalizedTdsEntry): string {
  return [normalizeTan(e.deductorTan), normalizeSection(e.section), e.quarter].join('|')
}
function withinTolerance(a: number, b: number): boolean {
  const delta = Math.abs(a - b)
  return delta <= Math.max(RUPEE_TOLERANCE_PAISE, Math.round(Math.max(a, b) * PERCENT_TOLERANCE))
}
function emptyTotals(): TdsTotals { return { amountPaid: 0, tdsAmount: 0, count: 0 } }
function addToTotals(t: TdsTotals, e: NormalizedTdsEntry): void {
  t.amountPaid += e.amountPaid
  t.tdsAmount += e.tdsAmount
  t.count += 1
}

export function runTdsMatcher(input: MatcherInput): TdsMatcherResult {
  const rows: TdsMatchedRow[] = []
  const totals: TdsTotalsByBucket = {
    verified: emptyTotals(), variance: emptyTotals(),
    only_26as: emptyTotals(), only_books: emptyTotals(),
  }

  const remainingBooks = new Map(input.books.map((e) => [e.id, e]))
  const booksByExact = new Map<string, string>()
  const booksByFuzzy = new Map<string, string[]>()
  for (const b of input.books) {
    booksByExact.set(keyExact(b), b.id)
    const fk = keyFuzzy(b)
    const list = booksByFuzzy.get(fk) ?? []
    list.push(b.id)
    booksByFuzzy.set(fk, list)
  }

  // ── Pass 1: exact ─────────────────────────────────────────────────────
  for (const two of input.filing26AS) {
    const ek = keyExact(two)
    const bId = booksByExact.get(ek)
    if (bId && remainingBooks.has(bId)) {
      const b = remainingBooks.get(bId)!
      rows.push({
        matchStatus: 'verified',
        filing26ASEntryId: two.id, booksEntryId: b.id,
        mismatchFields: [], actionStatus: 'no_action',
      })
      addToTotals(totals.verified, two)
      remainingBooks.delete(bId)
      booksByExact.delete(ek)
      const fk = keyFuzzy(b)
      const list = booksByFuzzy.get(fk) ?? []
      const idx = list.indexOf(bId)
      if (idx >= 0) list.splice(idx, 1)
    }
  }

  // ── Pass 2: tolerance (same tan+section+quarter) ─────────────────────
  const consumed26 = new Set<string>(rows.filter((r) => r.filing26ASEntryId).map((r) => r.filing26ASEntryId!))
  for (const two of input.filing26AS) {
    if (consumed26.has(two.id)) continue
    const fk = keyFuzzy(two)
    const candidates = booksByFuzzy.get(fk) ?? []
    let bestId: string | undefined
    let bestDelta = Number.POSITIVE_INFINITY
    for (const bId of candidates) {
      const b = remainingBooks.get(bId)
      if (!b) continue
      const d = Math.abs(two.tdsAmount - b.tdsAmount)
      if (d < bestDelta) { bestDelta = d; bestId = bId }
    }
    if (bestId === undefined) continue
    const b = remainingBooks.get(bestId)!
    const mismatches: string[] = []
    if (!withinTolerance(two.tdsAmount, b.tdsAmount)) mismatches.push('tds_amount')
    if (!withinTolerance(two.amountPaid, b.amountPaid)) mismatches.push('amount_paid')
    if (two.tdsDate && b.tdsDate && two.tdsDate !== b.tdsDate) mismatches.push('tds_date')
    const status: TdsMatchStatus = mismatches.length === 0 ? 'verified' : 'variance'
    rows.push({
      matchStatus: status,
      filing26ASEntryId: two.id, booksEntryId: b.id,
      mismatchFields: mismatches, actionStatus: status === 'verified' ? 'no_action' : 'revise_book',
    })
    addToTotals(status === 'verified' ? totals.verified : totals.variance, two)
    consumed26.add(two.id)
    remainingBooks.delete(bestId)
    const list = booksByFuzzy.get(fk)
    if (list) {
      const idx = list.indexOf(bestId)
      if (idx >= 0) list.splice(idx, 1)
    }
  }

  // ── Pass 3: residuals ────────────────────────────────────────────────
  for (const two of input.filing26AS) {
    if (consumed26.has(two.id)) continue
    rows.push({
      matchStatus: 'only_26as',
      filing26ASEntryId: two.id,
      mismatchFields: [], actionStatus: 'credit_claimed',
    })
    addToTotals(totals.only_26as, two)
  }
  for (const b of remainingBooks.values()) {
    rows.push({
      matchStatus: 'only_books',
      booksEntryId: b.id,
      mismatchFields: [], actionStatus: 'chase_deductor',
    })
    addToTotals(totals.only_books, b)
  }

  return { rows, totals }
}
