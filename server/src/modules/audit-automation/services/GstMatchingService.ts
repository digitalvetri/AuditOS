import { normalizeInvoiceNumber, normalizeGstin, type NormalizedEntry } from '../parsers/types.js'

/**
 * Deterministic 3-pass matcher for GSTR-2B vs Purchase Register.
 *
 * Pass 1 — EXACT   same (gstin, invoiceNumber, invoiceDate, taxableValue)
 * Pass 2 — TOLERANCE same (gstin, invoiceNumber); taxable delta ≤ max(₹1, 0.1%);
 *                    partial if tax split or invoice date differ
 * Pass 3 — RESIDUALS remaining 2B → only_2b; remaining PR → only_pr
 *
 * Amounts throughout are paise (Int). Tolerance is compared in paise.
 */

export interface MatcherInput {
  filing2B: (NormalizedEntry & { id: string })[]
  purchaseRegister: (NormalizedEntry & { id: string })[]
}

export type MatchStatus = 'matched' | 'partial' | 'only_2b' | 'only_pr'
export type ItcClassification = 'eligible' | 'ineligible' | 'reversal' | 'blocked'

export interface MatchedRow {
  matchStatus: MatchStatus
  filing2BEntryId?: string
  purchaseRegisterEntryId?: string
  mismatchFields: string[]
  itcClassification: ItcClassification
}

export interface MatcherTotals {
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  count: number
}
export type TotalsByBucket = Record<MatchStatus, MatcherTotals>

export interface MatcherResult {
  rows: MatchedRow[]
  totals: TotalsByBucket
}

const RUPEE_TOLERANCE_PAISE = 100 // ₹1
const PERCENT_TOLERANCE = 0.001    // 0.1%

function keyExact(e: NormalizedEntry): string {
  return [
    normalizeGstin(e.supplierGstin),
    normalizeInvoiceNumber(e.invoiceNumber),
    e.invoiceDate,
    String(e.taxableValue),
  ].join('|')
}
function keyFuzzy(e: NormalizedEntry): string {
  return [normalizeGstin(e.supplierGstin), normalizeInvoiceNumber(e.invoiceNumber)].join('|')
}
function withinTolerance(a: number, b: number): boolean {
  const delta = Math.abs(a - b)
  return delta <= Math.max(RUPEE_TOLERANCE_PAISE, Math.round(Math.max(a, b) * PERCENT_TOLERANCE))
}
function emptyTotals(): MatcherTotals {
  return { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, count: 0 }
}
function addToTotals(t: MatcherTotals, e: NormalizedEntry): void {
  t.taxable += e.taxableValue
  t.igst += e.igst
  t.cgst += e.cgst
  t.sgst += e.sgst
  t.cess += e.cess
  t.count += 1
}
function itcDefault(e: NormalizedEntry): ItcClassification {
  return e.itcAvailable === false ? 'ineligible' : 'eligible'
}

export function runMatcher(input: MatcherInput): MatcherResult {
  const rows: MatchedRow[] = []
  const totals: TotalsByBucket = {
    matched: emptyTotals(), partial: emptyTotals(),
    only_2b: emptyTotals(), only_pr: emptyTotals(),
  }

  const remainingPr = new Map(input.purchaseRegister.map((e) => [e.id, e]))

  // Bucket PR by exact + fuzzy key for O(N) lookup.
  const prByExact = new Map<string, string>()
  const prByFuzzy = new Map<string, string[]>()
  for (const pr of input.purchaseRegister) {
    prByExact.set(keyExact(pr), pr.id)
    const fk = keyFuzzy(pr)
    const list = prByFuzzy.get(fk) ?? []
    list.push(pr.id)
    prByFuzzy.set(fk, list)
  }

  // ── Pass 1: exact ─────────────────────────────────────────────────────
  for (const two of input.filing2B) {
    const ek = keyExact(two)
    const prId = prByExact.get(ek)
    if (prId && remainingPr.has(prId)) {
      const pr = remainingPr.get(prId)!
      rows.push({
        matchStatus: 'matched',
        filing2BEntryId: two.id,
        purchaseRegisterEntryId: pr.id,
        mismatchFields: [],
        itcClassification: itcDefault(two),
      })
      addToTotals(totals.matched, two)
      remainingPr.delete(prId)
      prByExact.delete(ek)
      // Remove from fuzzy index too
      const fk = keyFuzzy(pr)
      const list = prByFuzzy.get(fk) ?? []
      const idx = list.indexOf(prId)
      if (idx >= 0) list.splice(idx, 1)
    }
  }

  // ── Pass 2: tolerance (same gstin + invoiceNo) ────────────────────────
  const consumed2B = new Set<string>(rows.filter((r) => r.filing2BEntryId).map((r) => r.filing2BEntryId!))
  for (const two of input.filing2B) {
    if (consumed2B.has(two.id)) continue
    const fk = keyFuzzy(two)
    const candidates = prByFuzzy.get(fk) ?? []
    // Prefer the candidate with the smallest taxable delta.
    let bestId: string | undefined
    let bestDelta = Number.POSITIVE_INFINITY
    for (const prId of candidates) {
      const pr = remainingPr.get(prId)
      if (!pr) continue
      const d = Math.abs(two.taxableValue - pr.taxableValue)
      if (d < bestDelta) { bestDelta = d; bestId = prId }
    }
    if (bestId === undefined) continue
    const pr = remainingPr.get(bestId)!
    // Partial vs matched (matched only if within tolerance AND every tax split within tolerance AND dates equal)
    const mismatches: string[] = []
    if (!withinTolerance(two.taxableValue, pr.taxableValue)) mismatches.push('taxable_value')
    if (!withinTolerance(two.igst, pr.igst) || !withinTolerance(two.cgst, pr.cgst) ||
        !withinTolerance(two.sgst, pr.sgst) || !withinTolerance(two.cess, pr.cess)) mismatches.push('tax_split')
    if (two.invoiceDate && pr.invoiceDate && two.invoiceDate !== pr.invoiceDate) mismatches.push('invoice_date')
    const status: MatchStatus = mismatches.length === 0 ? 'matched' : 'partial'
    rows.push({
      matchStatus: status,
      filing2BEntryId: two.id,
      purchaseRegisterEntryId: pr.id,
      mismatchFields: mismatches,
      itcClassification: itcDefault(two),
    })
    addToTotals(status === 'matched' ? totals.matched : totals.partial, two)
    consumed2B.add(two.id)
    remainingPr.delete(bestId)
    const list = prByFuzzy.get(fk)
    if (list) {
      const idx = list.indexOf(bestId)
      if (idx >= 0) list.splice(idx, 1)
    }
  }

  // ── Pass 3: residuals ─────────────────────────────────────────────────
  for (const two of input.filing2B) {
    if (consumed2B.has(two.id)) continue
    rows.push({
      matchStatus: 'only_2b',
      filing2BEntryId: two.id,
      mismatchFields: [],
      itcClassification: itcDefault(two),
    })
    addToTotals(totals.only_2b, two)
  }
  for (const pr of remainingPr.values()) {
    rows.push({
      matchStatus: 'only_pr',
      purchaseRegisterEntryId: pr.id,
      mismatchFields: [],
      itcClassification: 'eligible', // best-guess; auditor overrides
    })
    addToTotals(totals.only_pr, pr)
  }

  return { rows, totals }
}
