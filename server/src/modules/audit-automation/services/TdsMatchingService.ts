import type { NormalizedTdsEntry } from '../parsers/tdsTypes.js'
import { normalizeTan, normalizeSection, normalizeDeductorName, ayOfDate, TAN_RE } from '../parsers/tdsTypes.js'

/**
 * Form 26AS (what deductors reported to TRACES) against the client's books
 * (the TDS receivable it recorded). Deterministic; amounts in paise.
 *
 * Deductor identity. 26AS always carries the TAN. A books entry with a
 * valid TAN uses it; one without is tied to a 26AS deductor by name
 * (company-form words and punctuation ignored) and flagged tan_from_name;
 * failing that it stays keyed by its own name and can only land in
 * "only in books".
 *
 * Passes, each within one deductor:
 *   1 exact    same section, same TDS, same quarter
 *   2 window   same section, TDS within ₹1 / 0.1 %, dates ≤ 45 days apart
 *              (the deductor may book in the next quarter)
 *   3 grouped  one entry on one side equals the sum of several on the
 *              other (a deductor reporting monthly receipts as one line,
 *              or the reverse), same section, ≤ 95 days apart
 *   4 variance same quarter, and the same section or TDS within 10 % —
 *              paired, with what differs
 *   then       the rest → only_26as / only_books
 *
 * A section left blank on one side (a books ledger without the section
 * in its name) matches any section.
 *
 * TRACES booking status travels with the 26AS entry as a row flag: U
 * (unmatched — the deductor's statement doesn't tie to a challan, the
 * credit isn't usable), P (provisional), O (overbooked), Z (mismatched).
 * A deposit below the TDS deducted is flagged short_deposit.
 */

export type TdsEntry = NormalizedTdsEntry & { id: string }
export interface MatcherInput {
  filing26AS: TdsEntry[]
  books: TdsEntry[]
  /** AY (first year) the reconciliation is for; entries dated outside its FY are flagged. */
  assessmentYear?: number
}

export type TdsMatchStatus = 'verified' | 'variance' | 'only_26as' | 'only_books'
export type TdsActionStatus = 'no_action' | 'chase_deductor' | 'revise_book' | 'credit_claimed' | 'written_off'
export const TDS_STATUSES: TdsMatchStatus[] = ['verified', 'variance', 'only_26as', 'only_books']
export const TDS_ACTIONS: TdsActionStatus[] = ['no_action', 'chase_deductor', 'revise_book', 'credit_claimed', 'written_off']

export interface TdsMatchedRow {
  matchStatus: TdsMatchStatus
  filing26ASEntryId?: string
  booksEntryId?: string
  mismatchFields: string[]
  matchMethod?: 'exact' | 'window' | 'grouped' | 'variance' | 'manual'
  groupKey?: string
  /** TAN, or NAME:<normalised> for a books entry that couldn't be tied to one. */
  deductorKey: string
  flags: string[]
  actionStatus: TdsActionStatus
}

export interface TdsTotals {
  count: number
  amountPaid: number
  /** TDS as the row's primary side shows it (26AS where present, else books). */
  tdsAmount: number
  tds26as: number
  tdsBooks: number
}
export type TdsTotalsByBucket = Record<TdsMatchStatus, TdsTotals>

export interface TdsMatcherResult {
  rows: TdsMatchedRow[]
  totals: TdsTotalsByBucket
  /** Books entries tied to a 26AS deductor by name. */
  tanFromName: number
  /** Entries dated outside the reconciliation's FY. */
  outOfYear: number
}

const RUPEE_TOLERANCE_PAISE = 100 // ₹1
const PERCENT_TOLERANCE = 0.001    // 0.1%
const WINDOW_DAYS = 45
const GROUP_WINDOW_DAYS = 95
const MAX_GROUP_CANDIDATES = 14

export function withinTolerance(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(RUPEE_TOLERANCE_PAISE, Math.round(Math.max(Math.abs(a), Math.abs(b)) * PERCENT_TOLERANCE))
}
function days(a: string, b: string): number {
  if (!a || !b) return 0
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000
}
const sameSection = (a: string, b: string) => !a || !b || a === b

/** Deductor key for every books entry, resolving missing TANs by name against the 26AS deductors. */
export function deductorKeys(filing26AS: TdsEntry[], books: TdsEntry[]): { key: Map<string, string>; byName: Set<string> } {
  const names = new Map<string, Set<string>>()
  for (const e of filing26AS) {
    const n = normalizeDeductorName(e.deductorName)
    if (!n) continue
    if (!names.has(n)) names.set(n, new Set())
    names.get(n)!.add(normalizeTan(e.deductorTan))
  }
  const unique = (s?: Set<string>) => (s && s.size === 1 ? [...s][0] : undefined)
  const key = new Map<string, string>()
  const byName = new Set<string>()
  for (const b of books) {
    const tan = normalizeTan(b.deductorTan)
    if (TAN_RE.test(tan)) { key.set(b.id, tan); continue }
    const n = normalizeDeductorName(b.deductorName)
    let hit = unique(names.get(n))
    if (!hit && n) {
      // "ACME STEEL" vs "ACME STEEL AND WIRES": one name's words all within the other's, and only one such deductor.
      const words = new Set(n.split(' '))
      const found = [...names.entries()].filter(([m]) => {
        const mw = new Set(m.split(' '))
        const [small, big] = words.size <= mw.size ? [words, mw] : [mw, words]
        return [...small].every((w) => big.has(w)) && [...small].join('').length >= 5
      })
      if (found.length === 1) hit = unique(found[0][1])
    }
    if (hit) { key.set(b.id, hit); byName.add(b.id) } else key.set(b.id, n ? `NAME:${n}` : `NONE:${b.id}`)
  }
  return { key, byName }
}

/** First subset of `items` whose tdsAmount sums to `target` within tolerance (2+ items). */
function subsetSum(items: TdsEntry[], target: number): TdsEntry[] | null {
  const pool = items.slice(0, MAX_GROUP_CANDIDATES)
  const n = pool.length
  if (n < 2) return null
  let best: TdsEntry[] | null = null
  for (let mask = 1; mask < 1 << n; mask++) {
    if ((mask & (mask - 1)) === 0) continue // single item — pass 1/2 territory
    let sum = 0
    const picked: TdsEntry[] = []
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { sum += pool[i].tdsAmount; picked.push(pool[i]) }
    if (withinTolerance(sum, target) && (!best || picked.length < best.length)) best = picked
  }
  return best
}

function emptyTotals(): TdsTotals { return { count: 0, amountPaid: 0, tdsAmount: 0, tds26as: 0, tdsBooks: 0 } }

export function rowFlags(two?: TdsEntry, book?: TdsEntry, ay?: number, byName?: boolean): string[] {
  const f: string[] = []
  const st = (two?.status ?? '').toUpperCase()
  if (st === 'U') f.push('status_u')
  if (st === 'P') f.push('status_p')
  if (st === 'O') f.push('status_o')
  if (st === 'Z') f.push('status_z')
  if (two && two.tdsDeposited !== undefined && two.tdsDeposited + RUPEE_TOLERANCE_PAISE < two.tdsAmount) f.push('short_deposit')
  if (byName) f.push('tan_from_name')
  if (ay && [two?.tdsDate, book?.tdsDate].some((d) => d && ayOfDate(d) !== null && ayOfDate(d) !== ay)) f.push('out_of_year')
  return f
}

/** The auditor's starting action for a row. */
export function defaultAction(status: TdsMatchStatus, flags: string[], two?: { tdsAmount: number }, booksTds?: number): TdsActionStatus {
  if (status === 'only_books') return 'chase_deductor'
  if (status === 'only_26as') return 'revise_book'
  if (flags.some((f) => f === 'status_u' || f === 'status_o' || f === 'status_z' || f === 'short_deposit')) return 'chase_deductor'
  if (status === 'variance') return two && booksTds !== undefined && two.tdsAmount < booksTds ? 'chase_deductor' : 'revise_book'
  return 'no_action'
}

export function runTdsMatcher(input: MatcherInput): TdsMatcherResult {
  const ay = input.assessmentYear
  const norm = (e: TdsEntry): TdsEntry => ({ ...e, section: normalizeSection(e.section), deductorTan: normalizeTan(e.deductorTan) })
  const two = input.filing26AS.map(norm)
  const books = input.books.map(norm)
  const { key: bookKey, byName } = deductorKeys(two, books)

  const rows: TdsMatchedRow[] = []
  const left26 = new Map(two.map((e) => [e.id, e]))
  const leftBk = new Map(books.map((e) => [e.id, e]))
  const booksFor = (tan: string) => [...leftBk.values()].filter((b) => bookKey.get(b.id) === tan)

  const pair = (a: TdsEntry, b: TdsEntry, method: TdsMatchedRow['matchMethod'], groupKey?: string, groupTds?: { two: number; books: number }) => {
    const mismatch: string[] = []
    const tdsA = groupTds?.two ?? a.tdsAmount
    const tdsB = groupTds?.books ?? b.tdsAmount
    if (!withinTolerance(tdsA, tdsB)) mismatch.push('tds_amount')
    if (a.section && b.section && a.section !== b.section) mismatch.push('section')
    if (!groupKey && a.amountPaid && b.amountPaid && !withinTolerance(a.amountPaid, b.amountPaid)) mismatch.push('amount_paid')
    if (a.quarter && b.quarter && a.quarter !== b.quarter) mismatch.push('quarter')
    else if (!groupKey && a.tdsDate && b.tdsDate && a.tdsDate !== b.tdsDate) mismatch.push('tds_date')
    if (groupKey) mismatch.push('grouped')
    // Only the credit itself (TDS, section) makes a pair a variance; amount paid and dates are for information.
    const status: TdsMatchStatus = mismatch.includes('tds_amount') || mismatch.includes('section') ? 'variance' : 'verified'
    const flags = rowFlags(a, b, ay, byName.has(b.id))
    rows.push({
      matchStatus: status, filing26ASEntryId: a.id, booksEntryId: b.id, mismatchFields: mismatch,
      matchMethod: method, groupKey, deductorKey: a.deductorTan, flags, actionStatus: defaultAction(status, flags, { tdsAmount: tdsA }, tdsB),
    })
  }

  // ── 1 exact ──
  for (const a of two) {
    const b = booksFor(a.deductorTan).find((x) => sameSection(a.section, x.section) && x.tdsAmount === a.tdsAmount && x.quarter === a.quarter)
    if (b) { pair(a, b, 'exact'); left26.delete(a.id); leftBk.delete(b.id) }
  }
  // ── 2 window ──
  for (const a of [...left26.values()]) {
    const c = booksFor(a.deductorTan)
      .filter((x) => sameSection(a.section, x.section) && withinTolerance(a.tdsAmount, x.tdsAmount) && days(a.tdsDate, x.tdsDate) <= WINDOW_DAYS)
      .sort((x, y) => days(a.tdsDate, x.tdsDate) - days(a.tdsDate, y.tdsDate))[0]
    if (c) { pair(a, c, 'window'); left26.delete(a.id); leftBk.delete(c.id) }
  }
  // ── 3 grouped: one 26AS ↔ several books, then one books ↔ several 26AS ──
  let g = 0
  for (const a of [...left26.values()]) {
    const cands = booksFor(a.deductorTan)
      .filter((x) => sameSection(a.section, x.section) && days(a.tdsDate, x.tdsDate) <= GROUP_WINDOW_DAYS && Math.sign(x.tdsAmount) === Math.sign(a.tdsAmount))
      .sort((x, y) => days(a.tdsDate, x.tdsDate) - days(a.tdsDate, y.tdsDate))
    const set = subsetSum(cands, a.tdsAmount)
    if (!set) continue
    const key = `G${++g}`
    const sum = set.reduce((t, x) => t + x.tdsAmount, 0)
    for (const b of set) { pair(a, b, 'grouped', key, { two: a.tdsAmount, books: sum }); leftBk.delete(b.id) }
    left26.delete(a.id)
  }
  for (const b of [...leftBk.values()]) {
    const k = bookKey.get(b.id)!
    const cands = [...left26.values()]
      .filter((x) => x.deductorTan === k && sameSection(x.section, b.section) && days(x.tdsDate, b.tdsDate) <= GROUP_WINDOW_DAYS && Math.sign(x.tdsAmount) === Math.sign(b.tdsAmount))
      .sort((x, y) => days(x.tdsDate, b.tdsDate) - days(y.tdsDate, b.tdsDate))
    const set = subsetSum(cands, b.tdsAmount)
    if (!set) continue
    const key = `G${++g}`
    const sum = set.reduce((t, x) => t + x.tdsAmount, 0)
    for (const a of set) { pair(a, b, 'grouped', key, { two: sum, books: b.tdsAmount }); left26.delete(a.id) }
    leftBk.delete(b.id)
  }
  // ── 4 variance: same deductor and quarter; same section or TDS close ──
  for (const a of [...left26.values()]) {
    const c = booksFor(a.deductorTan)
      .filter((x) => x.quarter === a.quarter && (sameSection(a.section, x.section) || Math.abs(a.tdsAmount - x.tdsAmount) <= Math.abs(a.tdsAmount) * 0.1))
      .sort((x, y) => Math.abs(a.tdsAmount - x.tdsAmount) - Math.abs(a.tdsAmount - y.tdsAmount))[0]
    if (c) { pair(a, c, 'variance'); left26.delete(a.id); leftBk.delete(c.id) }
  }
  // ── residuals ──
  for (const a of left26.values()) {
    const flags = rowFlags(a, undefined, ay)
    rows.push({ matchStatus: 'only_26as', filing26ASEntryId: a.id, deductorKey: a.deductorTan, mismatchFields: [], flags, actionStatus: defaultAction('only_26as', flags) })
  }
  for (const b of leftBk.values()) {
    const flags = rowFlags(undefined, b, ay, byName.has(b.id))
    rows.push({ matchStatus: 'only_books', booksEntryId: b.id, deductorKey: bookKey.get(b.id)!, mismatchFields: [], flags, actionStatus: defaultAction('only_books', flags) })
  }

  const byId26 = new Map(two.map((e) => [e.id, e]))
  const byIdBk = new Map(books.map((e) => [e.id, e]))
  return {
    rows,
    totals: totalsOf(rows, byId26, byIdBk),
    tanFromName: byName.size,
    outOfYear: rows.filter((r) => r.flags.includes('out_of_year')).length,
  }
}

/** Per-bucket totals, each entry counted once even when it sits in a group. */
export function totalsOf(
  rows: Pick<TdsMatchedRow, 'matchStatus' | 'filing26ASEntryId' | 'booksEntryId'>[],
  two: Map<string, { amountPaid: number; tdsAmount: number }>,
  books: Map<string, { amountPaid: number; tdsAmount: number }>,
): TdsTotalsByBucket {
  const t: TdsTotalsByBucket = { verified: emptyTotals(), variance: emptyTotals(), only_26as: emptyTotals(), only_books: emptyTotals() }
  const seen26 = new Set<string>(); const seenBk = new Set<string>()
  for (const r of rows) {
    const b = t[r.matchStatus]
    b.count += 1
    const a = r.filing26ASEntryId ? two.get(r.filing26ASEntryId) : undefined
    const k = r.booksEntryId ? books.get(r.booksEntryId) : undefined
    if (a && !seen26.has(r.filing26ASEntryId!)) { seen26.add(r.filing26ASEntryId!); b.tds26as += a.tdsAmount; b.amountPaid += a.amountPaid; b.tdsAmount += a.tdsAmount }
    if (k && !seenBk.has(r.booksEntryId!)) {
      seenBk.add(r.booksEntryId!); b.tdsBooks += k.tdsAmount
      if (!a) { b.amountPaid += k.amountPaid; b.tdsAmount += k.tdsAmount }
    }
  }
  return t
}
