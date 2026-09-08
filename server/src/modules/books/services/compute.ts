import { applyBp, applyRate, divRound, exclusiveOf, roundToRupee, sum, timesQty, type Minor } from '../engine/money.js'

/**
 * DOCUMENT ARITHMETIC — pure functions, no database.
 *
 *   line gross     = rate × qty
 *   line discount  = amount, or bp of gross
 *   doc discount   = amount, or bp of Σ(net); distributed across lines by
 *                    largest remainder so the parts add to the whole
 *   taxable        = net, or net ÷ (1 + rate) when prices are tax-inclusive
 *   GST            = taxable × rate, split CGST+SGST (intra-state) or IGST
 *   TDS            = taxable total × section rate (higher rate without PAN)
 *   round off      = to the nearest rupee, base currency only, posted to the
 *                    Round Off ledger — never absorbed into a real line
 */
export interface LineIn {
  quantity: number
  rate: Minor
  discountPercentBp?: number
  discountAmount?: Minor
  taxPercentBp?: number
}

export interface LineOut {
  gross: Minor
  discount: Minor
  taxable: Minor
  taxPercentBp: number
  tax: Minor
  cgst: Minor
  sgst: Minor
  igst: Minor
  lineTotal: Minor
}

export interface DocIn {
  lines: LineIn[]
  taxInclusive: boolean
  interState: boolean
  /** No GST at all (overseas contact, unregistered org). */
  gstExempt?: boolean
  discountPercentBp?: number
  discountAmount?: Minor
  tdsPercentBp?: number
  /** Round to the nearest rupee (base-currency INR documents). */
  roundOff: boolean
  exchangeRate?: number
}

export interface DocOut {
  lines: LineOut[]
  subtotal: Minor
  discountTotal: Minor
  taxableTotal: Minor
  cgstTotal: Minor
  sgstTotal: Minor
  igstTotal: Minor
  taxTotal: Minor
  tdsTotal: Minor
  roundOff: Minor
  total: Minor
  baseTotal: Minor
}

export function computeDocument(d: DocIn): DocOut {
  // 1. Gross and line discounts.
  const gross = d.lines.map((l) => timesQty(l.rate, l.quantity))
  const lineDisc = d.lines.map((l, i) => l.discountAmount !== undefined && l.discountAmount > 0n ? l.discountAmount : applyBp(gross[i], l.discountPercentBp ?? 0))
  const net = gross.map((g, i) => g - lineDisc[i])

  // 2. Document discount, distributed by largest remainder.
  const netSum = sum(net)
  const docDisc = d.discountAmount !== undefined && d.discountAmount > 0n ? d.discountAmount : applyBp(netSum, d.discountPercentBp ?? 0)
  const docShare = distribute(docDisc, net)

  // 3. Taxable, tax and split.
  const lines: LineOut[] = d.lines.map((l, i) => {
    const afterDisc = net[i] - docShare[i]
    const bp = d.gstExempt ? 0 : (l.taxPercentBp ?? 0)
    const taxable = d.taxInclusive && bp > 0 ? exclusiveOf(afterDisc, bp) : afterDisc
    const tax = applyBp(taxable, bp)
    let cgst = 0n, sgst = 0n, igst = 0n
    if (d.interState) igst = tax
    else { cgst = divRound(tax, 2n); sgst = tax - cgst }
    return { gross: gross[i], discount: lineDisc[i] + docShare[i], taxable, taxPercentBp: bp, tax, cgst, sgst, igst, lineTotal: taxable + tax }
  })

  const subtotal = sum(gross)
  const discountTotal = sum(lines.map((l) => l.discount))
  const taxableTotal = sum(lines.map((l) => l.taxable))
  const cgstTotal = sum(lines.map((l) => l.cgst))
  const sgstTotal = sum(lines.map((l) => l.sgst))
  const igstTotal = sum(lines.map((l) => l.igst))
  const taxTotal = cgstTotal + sgstTotal + igstTotal
  const tdsTotal = d.tdsPercentBp ? applyBp(taxableTotal, d.tdsPercentBp) : 0n
  const beforeRound = taxableTotal + taxTotal
  const [total, roundOff] = d.roundOff ? roundToRupee(beforeRound) : [beforeRound, 0n]
  const baseTotal = d.exchangeRate && d.exchangeRate !== 1 ? applyRate(total, d.exchangeRate) : total
  return { lines, subtotal, discountTotal, taxableTotal, cgstTotal, sgstTotal, igstTotal, taxTotal, tdsTotal, roundOff, total, baseTotal }
}

/** Split `amount` across `weights` proportionally; parts sum exactly to amount. */
export function distribute(amount: Minor, weights: Minor[]): Minor[] {
  const totalW = sum(weights)
  if (amount === 0n || totalW === 0n) return weights.map(() => 0n)
  const raw = weights.map((w) => ({ q: (amount * w) / totalW, r: (amount * w) % totalW }))
  let remaining = amount - sum(raw.map((x) => x.q))
  const order = raw.map((x, i) => ({ i, r: x.r })).sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : 0))
  const out = raw.map((x) => x.q)
  for (const { i } of order) { if (remaining <= 0n) break; out[i] += 1n; remaining -= 1n }
  return out
}

/** Intra-state when the place of supply equals the organisation's state. */
export function isInterState(orgStateCode: string | null | undefined, placeOfSupply: string | null | undefined): boolean {
  if (!orgStateCode || !placeOfSupply) return false
  return orgStateCode !== placeOfSupply
}
