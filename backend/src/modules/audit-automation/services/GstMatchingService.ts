import { normalizeInvoiceNumber, normalizeGstin, looseInvoiceKey, type NormalizedEntry } from '../parsers/types.js'

/**
 * GSTR-2B vs Purchase Register matcher.
 *
 * Before matching
 *   • Amendments: a B2BA/CDNRA entry replaces the original it names
 *     (GSTIN + original invoice number); the original is set aside.
 *   • Duplicates: the same GSTIN + invoice number twice on one side —
 *     the extra copies become `duplicate` rows and are not matched.
 *
 * Passes (each consumes what it pairs)
 *   1 exact          GSTIN + invoice no. + date + taxable value
 *   2 invoice        GSTIN + invoice no.
 *   3 invoice_loose  GSTIN + invoice no. ignoring separators / leading zeros
 *   4 amount_date    GSTIN + taxable within tolerance + date within 7 days,
 *                    only when exactly one candidate exists on each side
 *
 * Classification of a pair
 *   variance  taxable value or any tax head (IGST/CGST/SGST/cess) differs
 *             beyond max(₹1, 0.1%)
 *   partial   amounts agree, but the date differs or the invoice number
 *             only agreed loosely (passes 3–4)
 *   matched   everything agrees
 * Unpaired → only_2b (missing in books) / only_pr (missing in 2B).
 *
 * ITC (itcFor): 2B's own "not available" flag, reverse charge, credit
 * notes, the s.16(4) time limit, s.17(5) blocked credits (by the books'
 * ledger / GL text), and s.16(2)(aa) for invoices not in 2B. Each class
 * carries the reason, so a reviewer sees why.
 *
 * Amounts are paise throughout.
 */

export type Entry = NormalizedEntry & { id: string }
export interface MatcherInput {
  filing2B: Entry[]
  purchaseRegister: Entry[]
  /** The 2B's return period, YYYY-MM — drives the s.16(4) time-limit check. */
  period?: string
}

export type MatchStatus = 'matched' | 'partial' | 'variance' | 'only_2b' | 'only_pr' | 'duplicate'
export type ItcClassification = 'eligible' | 'ineligible' | 'blocked' | 'reversal' | 'rcm'
export type MatchMethod = 'exact' | 'invoice' | 'invoice_loose' | 'amount_date' | 'manual'

export interface MatchedRow {
  matchStatus: MatchStatus
  filing2BEntryId?: string
  purchaseRegisterEntryId?: string
  mismatchFields: string[]
  itcClassification: ItcClassification
  itcReason: string
  matchMethod?: MatchMethod
}

export interface MatcherTotals { taxable: number; igst: number; cgst: number; sgst: number; cess: number; count: number }
export type TotalsByBucket = Record<MatchStatus, MatcherTotals>
export interface MatcherResult { rows: MatchedRow[]; totals: TotalsByBucket; superseded: number }

const RUPEE_TOLERANCE_PAISE = 100 // ₹1
const PERCENT_TOLERANCE = 0.001    // 0.1%
const DATE_WINDOW_DAYS = 7

export function withinTolerance(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(RUPEE_TOLERANCE_PAISE, Math.round(Math.max(Math.abs(a), Math.abs(b)) * PERCENT_TOLERANCE))
}
const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000
const gst = (e: NormalizedEntry) => normalizeGstin(e.supplierGstin)
const doc = (e: NormalizedEntry) => (e.docType === 'CRN' ? 'CRN' : 'INV') // debit notes pair like invoices

/** Differences between a 2B entry and a books entry, by field. */
export function compare(two: NormalizedEntry, pr: NormalizedEntry): { amounts: string[]; other: string[] } {
  const amounts: string[] = []
  if (!withinTolerance(two.taxableValue, pr.taxableValue)) amounts.push('taxable_value')
  for (const k of ['igst', 'cgst', 'sgst', 'cess'] as const) if (!withinTolerance(two[k], pr[k])) amounts.push(k)
  const other: string[] = []
  if (two.invoiceDate && pr.invoiceDate && two.invoiceDate !== pr.invoiceDate) other.push('invoice_date')
  return { amounts, other }
}

// ── ITC ───────────────────────────────────────────────────────────────

/** s.17(5) blocked credits, recognised from the books' ledger / GL / supplier text. */
const BLOCKED: [RegExp, string][] = [
  [/motor\s*(car|vehicle)|\bcar\b|vehicle|conveyance/i, 'motor vehicles'],
  [/food|beverage|catering|canteen|restaurant|hotel stay|refreshment|pantry/i, 'food, beverages and catering'],
  [/club|membership|gym|fitness|health\s*club/i, 'club / fitness memberships'],
  [/life\s*insurance|health\s*insurance|mediclaim|medical/i, 'life / health insurance'],
  [/beauty|cosmetic|plastic surgery/i, 'beauty treatment'],
  [/gift|free\s*sample|donation|csr/i, 'gifts and free samples'],
  [/leave travel|\bltc\b|travel benefit|holiday/i, 'travel benefits to employees'],
  [/construction|civil work|building|immovable|works contract/i, 'construction of immovable property'],
  [/personal/i, 'personal consumption'],
]

/** Last day of the ITC time limit for an invoice (s.16(4): 30 November after its FY ends). */
function itcDeadline(invoiceDate: string): string | null {
  const m = invoiceDate.match(/^(\d{4})-(\d{2})/)
  if (!m) return null
  const fyStart = Number(m[2]) >= 4 ? Number(m[1]) : Number(m[1]) - 1
  return `${fyStart + 1}-11-30`
}

export function itcFor(status: MatchStatus, two: NormalizedEntry | undefined, pr: NormalizedEntry | undefined, period?: string): { cls: ItcClassification; reason: string } {
  if (status === 'duplicate') return { cls: 'ineligible', reason: 'Duplicate entry — only one copy can be claimed.' }
  if (!two) return { cls: 'ineligible', reason: 's.16(2)(aa): not in GSTR-2B — ITC is not available until the supplier reports it.' }
  if (two.itcAvailable === false) return { cls: 'ineligible', reason: `GSTR-2B shows ITC as not available${two.itcReason ? ` (reason: ${two.itcReason})` : ''}.` }
  if (two.docType === 'CRN' || two.taxableValue < 0) return { cls: 'reversal', reason: 'Credit note — reduces ITC already claimed.' }
  if (period && two.invoiceDate) {
    const deadline = itcDeadline(two.invoiceDate)
    const periodEnd = `${period}-31`
    if (deadline && periodEnd > deadline) return { cls: 'ineligible', reason: `s.16(4): the time limit for this invoice ended on ${deadline}.` }
  }
  const text = [pr?.glCode, pr?.supplierName, two.supplierName].filter(Boolean).join(' ')
  const blocked = BLOCKED.find(([re]) => re.test(text))
  if (blocked) return { cls: 'blocked', reason: `s.17(5) blocked credit — ${blocked[1]}. Confirm before claiming.` }
  if (two.reverseCharge || pr?.reverseCharge) return { cls: 'rcm', reason: 'Reverse charge — claim ITC only after paying the tax under RCM.' }
  if (status === 'only_2b') return { cls: 'eligible', reason: 'In GSTR-2B but not in the books — book the invoice or confirm it is not yours.' }
  if (status === 'variance') return { cls: 'eligible', reason: 'Amounts differ — claim as per GSTR-2B and correct the books (or ask the supplier to amend).' }
  return { cls: 'eligible', reason: 'In GSTR-2B and in the books.' }
}

// ── matching ──────────────────────────────────────────────────────────

function emptyTotals(): MatcherTotals { return { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, count: 0 } }
function add(t: MatcherTotals, e: NormalizedEntry): void {
  t.taxable += e.taxableValue; t.igst += e.igst; t.cgst += e.cgst; t.sgst += e.sgst; t.cess += e.cess; t.count += 1
}

/** Split one side into first copies and duplicates (same GSTIN + invoice + doc type). */
function dedupe(entries: Entry[]): { keep: Entry[]; dups: Entry[] } {
  const seen = new Set<string>()
  const keep: Entry[] = []
  const dups: Entry[] = []
  for (const e of entries) {
    const k = `${gst(e)}|${doc(e)}|${looseInvoiceKey(e.invoiceNumber)}`
    if (seen.has(k)) dups.push(e)
    else { seen.add(k); keep.push(e) }
  }
  return { keep, dups }
}

export function runMatcher(input: MatcherInput): MatcherResult {
  const rows: MatchedRow[] = []
  const totals: TotalsByBucket = {
    matched: emptyTotals(), partial: emptyTotals(), variance: emptyTotals(),
    only_2b: emptyTotals(), only_pr: emptyTotals(), duplicate: emptyTotals(),
  }

  // Amendments replace their originals.
  const amendedKeys = new Set(input.filing2B.filter((e) => e.originalInvoiceNumber).map((e) => `${gst(e)}|${looseInvoiceKey(e.originalInvoiceNumber!)}`))
  const live2B = input.filing2B.filter((e) => e.originalInvoiceNumber || !amendedKeys.has(`${gst(e)}|${looseInvoiceKey(e.invoiceNumber)}`))
  const superseded = input.filing2B.length - live2B.length

  const d2 = dedupe(live2B)
  const dp = dedupe(input.purchaseRegister)
  for (const e of d2.dups) { const itc = itcFor('duplicate', e, undefined, input.period); rows.push({ matchStatus: 'duplicate', filing2BEntryId: e.id, mismatchFields: ['duplicate_in_2b'], itcClassification: itc.cls, itcReason: itc.reason }); add(totals.duplicate, e) }
  for (const e of dp.dups) { const itc = itcFor('duplicate', undefined, e, input.period); rows.push({ matchStatus: 'duplicate', purchaseRegisterEntryId: e.id, mismatchFields: ['duplicate_in_books'], itcClassification: itc.cls, itcReason: itc.reason }); add(totals.duplicate, e) }

  const two = new Map(d2.keep.map((e) => [e.id, e]))
  const pr = new Map(dp.keep.map((e) => [e.id, e]))

  const pair = (a: Entry, b: Entry, method: MatchMethod) => {
    const c = compare(a, b)
    const other = [...c.other]
    if (method === 'invoice_loose') other.push('invoice_number_format')
    if (method === 'amount_date') other.push('invoice_number')
    const status: MatchStatus = c.amounts.length ? 'variance' : other.length ? 'partial' : 'matched'
    const itc = itcFor(status, a, b, input.period)
    rows.push({ matchStatus: status, filing2BEntryId: a.id, purchaseRegisterEntryId: b.id, mismatchFields: [...c.amounts, ...other], itcClassification: itc.cls, itcReason: itc.reason, matchMethod: method })
    add(totals[status], a)
    two.delete(a.id); pr.delete(b.id)
  }

  // Passes 1–3: keyed lookups, nearest taxable value when a key has several candidates.
  const keyed = (key: (e: Entry) => string, method: MatchMethod) => {
    const index = new Map<string, Entry[]>()
    for (const b of pr.values()) { const k = key(b); index.set(k, [...(index.get(k) ?? []), b]) }
    for (const a of [...two.values()]) {
      const cands = (index.get(key(a)) ?? []).filter((b) => pr.has(b.id))
      if (!cands.length) continue
      const best = cands.reduce((x, y) => (Math.abs(y.taxableValue - a.taxableValue) < Math.abs(x.taxableValue - a.taxableValue) ? y : x))
      pair(a, best, method)
    }
  }
  keyed((e) => `${gst(e)}|${doc(e)}|${normalizeInvoiceNumber(e.invoiceNumber)}|${e.invoiceDate}|${e.taxableValue}`, 'exact')
  keyed((e) => `${gst(e)}|${doc(e)}|${normalizeInvoiceNumber(e.invoiceNumber)}`, 'invoice')
  keyed((e) => `${gst(e)}|${doc(e)}|${looseInvoiceKey(e.invoiceNumber)}`, 'invoice_loose')

  // Pass 4: same supplier, same amount, near date — only when unambiguous both ways.
  const near = (a: Entry, b: Entry) => gst(a) === gst(b) && doc(a) === doc(b) && withinTolerance(a.taxableValue, b.taxableValue)
    && Boolean(a.invoiceDate && b.invoiceDate) && days(a.invoiceDate, b.invoiceDate) <= DATE_WINDOW_DAYS
  for (const a of [...two.values()]) {
    const cands = [...pr.values()].filter((b) => near(a, b))
    if (cands.length !== 1) continue
    const back = [...two.values()].filter((x) => near(x, cands[0]))
    if (back.length === 1) pair(a, cands[0], 'amount_date')
  }

  for (const a of two.values()) { const itc = itcFor('only_2b', a, undefined, input.period); rows.push({ matchStatus: 'only_2b', filing2BEntryId: a.id, mismatchFields: [], itcClassification: itc.cls, itcReason: itc.reason }); add(totals.only_2b, a) }
  for (const b of pr.values()) { const itc = itcFor('only_pr', undefined, b, input.period); rows.push({ matchStatus: 'only_pr', purchaseRegisterEntryId: b.id, mismatchFields: [], itcClassification: itc.cls, itcReason: itc.reason }); add(totals.only_pr, b) }

  return { rows, totals, superseded }
}
