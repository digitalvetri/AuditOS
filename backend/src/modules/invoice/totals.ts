/**
 * INVOICE MONEY — the only place an invoice total is computed.
 *
 * Pure functions over integers. No Prisma, no session, no Date: give it lines
 * and it gives you the same totals every time. §43 asks for one reliable
 * calculation layer rather than the same formula copied into UI components,
 * and this is it — the builder's live preview and the stored row both read
 * their figures from here, which is why the preview cannot disagree with the
 * saved invoice.
 *
 * RULES
 *  - Every amount is PAISE (Int). Nothing here produces a float.
 *  - Quantity is CENTI-units (250 = 2.5), so "2.5 hours" is exact.
 *  - THE LINE AMOUNT IS THE TAXABLE BASE, never tax-inclusive. The reference
 *    document prints Sub Total 4,200 against lines of 1,200 and 3,000 and
 *    then adds tax to reach 4,956 — so `taxableAmountPaise` is what the
 *    Amount column shows, and tax sits on top of it. Treating the line as
 *    tax-inclusive would double-count (§17, §43).
 *  - Rounding happens ONCE per line, half-up, when the taxable amount is
 *    formed. Tax is then computed on the rounded line, so the printed lines
 *    always add up to the printed total — the failure everyone notices on an
 *    invoice.
 *  - An invoice-level discount is spread across lines PRO RATA by line
 *    amount, because tax is per-line: taking it off the grand total instead
 *    would tax a rupee the client is not being charged.
 *  - CGST+SGST and IGST are mutually exclusive per invoice (§18). The caller
 *    passes `isInterState` and this module zeroes the other pair, so a stored
 *    row can never carry both.
 */

/** Whole percents a line may carry. Anything else is rejected by the routes. */
export const GST_RATES = [0, 5, 12, 18, 28] as const
export type GstRate = (typeof GST_RATES)[number]

/**
 * Half of each GST slab, for the CGST/SGST split. 5% intra-state is 2.5%
 * each, which is not a whole percent — so the split is carried in BASIS
 * POINTS (250 = 2.5%) rather than percent, and only ever divided once.
 */
export const HALF_RATE_BPS: Record<number, number> = {
  0: 0,
  5: 250,
  12: 600,
  18: 900,
  28: 1400,
}

export interface LineInput {
  quantityCenti: number
  ratePaise: number
  discountPercent: number
  /** The line's full GST slab, e.g. 18. The split is derived, never passed. */
  gstRatePercent: number
}

export interface LineTotals {
  taxableAmountPaise: number
  cgstAmountPaise: number
  sgstAmountPaise: number
  igstAmountPaise: number
  totalAmountPaise: number
  /** Echoed back so the row stores what was actually applied. */
  cgstRatePercent: number
  sgstRatePercent: number
  igstRatePercent: number
}

export interface InvoiceTotals {
  lines: LineTotals[]
  subtotalPaise: number
  discountPaise: number
  taxablePaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  roundOffPaise: number
  totalPaise: number
  balanceDuePaise: number
}

/** Half-up on a non-negative integer division. */
function divRound(numerator: number, denominator: number): number {
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator)
}

/** basis points of a paise figure, half-up. 900 bps = 9%. */
function bpsOf(paise: number, bps: number): number {
  return divRound(paise * bps, 10_000)
}

/**
 * The taxable base for one line, BEFORE any invoice-level discount:
 * quantity × rate, less the line's own discount percent. Rounded to paise
 * once, here, so every later figure is computed from an integer.
 */
export function lineTaxable(line: LineInput): number {
  const gross = divRound(line.quantityCenti * line.ratePaise, 100)
  const discount = bpsOf(gross, clampPercent(line.discountPercent) * 100)
  return Math.max(0, gross - discount)
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, Math.trunc(n)))
}

/**
 * The whole invoice, from its lines.
 *
 * `amountPaidPaise` only ever reduces the balance — it never changes the
 * total, and the balance is floored at zero because the schema does not model
 * credit (§22: no negative balance unless overpayment is supported).
 */
export function computeTotals(
  lines: LineInput[],
  opts: {
    invoiceDiscountPaise?: number
    isInterState?: boolean
    amountPaidPaise?: number
    /** Round the grand total to a whole rupee. On by default (§20). */
    roundOff?: boolean
  } = {},
): InvoiceTotals {
  const isInterState = opts.isInterState ?? false
  const roundOff = opts.roundOff ?? true

  const bases = lines.map(lineTaxable)
  const subtotalPaise = bases.reduce((a, b) => a + b, 0)

  // Pro-rata spread of the invoice-level discount, capped at the subtotal so
  // a discount larger than the invoice cannot drive a line negative. The last
  // line absorbs the rounding remainder, so the parts sum to the whole.
  const requested = Math.max(0, Math.trunc(opts.invoiceDiscountPaise ?? 0))
  const discountPaise = Math.min(requested, subtotalPaise)
  const shares: number[] = []
  let spread = 0
  bases.forEach((base, i) => {
    const last = i === bases.length - 1
    const share = last
      ? discountPaise - spread
      : subtotalPaise === 0
        ? 0
        : divRound(discountPaise * base, subtotalPaise)
    shares.push(share)
    spread += share
  })

  const out: LineTotals[] = lines.map((line, i) => {
    const taxable = Math.max(0, bases[i] - (shares[i] ?? 0))
    const slab = clampPercent(line.gstRatePercent)
    const halfBps = HALF_RATE_BPS[slab] ?? Math.trunc((slab * 100) / 2)

    // Exactly one of the two shapes is ever populated (§18).
    const cgst = isInterState ? 0 : bpsOf(taxable, halfBps)
    const sgst = isInterState ? 0 : bpsOf(taxable, halfBps)
    const igst = isInterState ? bpsOf(taxable, slab * 100) : 0

    return {
      taxableAmountPaise: taxable,
      cgstAmountPaise: cgst,
      sgstAmountPaise: sgst,
      igstAmountPaise: igst,
      totalAmountPaise: taxable + cgst + sgst + igst,
      cgstRatePercent: isInterState ? 0 : slab / 2,
      sgstRatePercent: isInterState ? 0 : slab / 2,
      igstRatePercent: isInterState ? slab : 0,
    }
  })

  const taxablePaise = out.reduce((a, l) => a + l.taxableAmountPaise, 0)
  const cgstPaise = out.reduce((a, l) => a + l.cgstAmountPaise, 0)
  const sgstPaise = out.reduce((a, l) => a + l.sgstAmountPaise, 0)
  const igstPaise = out.reduce((a, l) => a + l.igstAmountPaise, 0)

  const exact = taxablePaise + cgstPaise + sgstPaise + igstPaise
  // Round half-up to the nearest whole rupee. roundOffPaise is the signed
  // adjustment, so `exact + roundOff === total` always holds and the document
  // can print the line honestly instead of hiding a discrepancy.
  const rounded = roundOff ? divRound(exact, 100) * 100 : exact
  const roundOffPaise = rounded - exact
  const totalPaise = rounded

  const paid = Math.max(0, Math.trunc(opts.amountPaidPaise ?? 0))
  const balanceDuePaise = Math.max(0, totalPaise - paid)

  return {
    lines: out,
    subtotalPaise,
    discountPaise,
    taxablePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    roundOffPaise,
    totalPaise,
    balanceDuePaise,
  }
}

/**
 * Payment state derived from the money, never set by hand (§23).
 * `overdue` is a function of the clock and belongs to the caller, which is
 * why it is not decided here.
 */
export function paymentState(totalPaise: number, paidPaise: number): 'unpaid' | 'partially_paid' | 'paid' {
  if (paidPaise <= 0) return 'unpaid'
  if (paidPaise >= totalPaise) return 'paid'
  return 'partially_paid'
}

// ── Words ─────────────────────────────────────────────────────────────────

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen',
]
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function under100(n: number): string {
  if (n < 20) return ONES[n]
  const t = TENS[Math.floor(n / 10)]
  const o = n % 10
  return o ? `${t}-${ONES[o]}` : t
}

function under1000(n: number): string {
  const h = Math.floor(n / 100)
  const r = n % 100
  const parts: string[] = []
  if (h) parts.push(`${ONES[h]} Hundred`)
  if (r) parts.push(under100(r))
  return parts.join(' ')
}

/**
 * The invoice's own words, in the form the reference document prints:
 * 'Indian Rupee Four Thousand Nine Hundred Fifty-Six Only' (§21).
 *
 * Deliberately NOT lib/money.ts#amountInWords, which renders the same figure
 * as 'Rupees Four Thousand Nine Hundred and Fifty Six Only'. That helper is
 * shared with payroll and its wording is printed on payslips, so bending it
 * to the invoice's house style would silently restyle every payslip. Two
 * documents, two conventions, one function each.
 *
 * Indian system throughout — lakh and crore, never million (§44).
 */
export function invoiceAmountInWords(paise: number): string {
  const rupees = Math.floor(Math.abs(paise) / 100)
  const paiseRem = Math.abs(paise) % 100
  if (rupees === 0 && paiseRem === 0) return 'Indian Rupee Zero Only'

  const crore = Math.floor(rupees / 10_000_000)
  const lakh = Math.floor((rupees % 10_000_000) / 100_000)
  const thousand = Math.floor((rupees % 100_000) / 1000)
  const rest = rupees % 1000

  const parts: string[] = []
  if (crore) parts.push(`${under1000(crore)} Crore`)
  if (lakh) parts.push(`${under1000(lakh)} Lakh`)
  if (thousand) parts.push(`${under1000(thousand)} Thousand`)
  if (rest) parts.push(under1000(rest))

  let s = `Indian Rupee ${parts.join(' ')}`.replace(/\s+/g, ' ').trim()
  if (paiseRem) s += ` and ${under100(paiseRem)} Paise`
  return `${s} Only`
}
