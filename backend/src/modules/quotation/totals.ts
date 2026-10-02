/**
 * QUOTATION MONEY — the only place a quotation total is computed.
 *
 * Pure functions over integers. No Prisma, no session, no Date: give it lines
 * and it gives you the same totals every time, which is what makes it
 * testable without a database and what stops a second, slightly different
 * copy of this arithmetic appearing in the UI.
 *
 * RULES
 *  - Every amount is PAISE (Int). Nothing here produces a float.
 *  - Quantity is CENTI-units (250 = 2.5), so "2.5 hours" is an exact integer.
 *  - Rounding happens ONCE per line, half-up, when the line amount is formed.
 *    Tax is then computed on the rounded line, so the printed lines always add
 *    up to the printed total — the failure everyone notices on an invoice.
 *  - A quotation-level discount is spread across lines PRO RATA by line
 *    amount, because tax is per-line: taking it off the grand total instead
 *    would tax a rupee the client is not being charged.
 */

/** Whole percents a line may carry. Anything else is rejected by the routes. */
export const GST_RATES = [0, 5, 12, 18, 28] as const
export type GstRate = (typeof GST_RATES)[number]

export interface LineInput {
  quantityCenti: number
  unitRatePaise: number
  discountPercent: number
  gstRatePercent: number
}

export interface LineTotals {
  amountPaise: number
  taxPaise: number
}

export interface QuotationTotals {
  lines: LineTotals[]
  subtotalPaise: number
  discountPaise: number
  taxablePaise: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  totalPaise: number
}

/** Half-up on the absolute value, so -0.5 and 0.5 round the same distance. */
function roundHalfUp(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n)
}

/** Gross line amount before any quotation-level discount. */
export function lineAmountPaise(line: LineInput): number {
  const gross = (line.quantityCenti * line.unitRatePaise) / 100
  const afterDiscount = gross * (1 - line.discountPercent / 100)
  return roundHalfUp(afterDiscount)
}

/**
 * Spread `discountPaise` across the lines in proportion to their amounts.
 *
 * The remainder from integer division goes to the LARGEST line, so the parts
 * always sum to exactly the discount asked for — never a paisa adrift.
 */
function allocate(discountPaise: number, amounts: number[]): number[] {
  const total = amounts.reduce((a, b) => a + b, 0)
  if (discountPaise <= 0 || total <= 0) return amounts.map(() => 0)
  const capped = Math.min(discountPaise, total)
  const parts = amounts.map((a) => Math.floor((a * capped) / total))
  let remainder = capped - parts.reduce((a, b) => a + b, 0)
  // Hand the remainder out a paisa at a time, biggest line first.
  const order = amounts.map((a, i) => i).sort((x, y) => amounts[y] - amounts[x])
  for (let k = 0; remainder > 0; k = (k + 1) % order.length) {
    parts[order[k]] += 1
    remainder -= 1
  }
  return parts
}

/**
 * Compute every figure on a quotation.
 *
 * `isInterState` decides the split and nothing else: the tax RATE is the
 * same either way, IGST is simply CGST + SGST in one column.
 */
export function computeTotals(
  lines: LineInput[],
  opts: { discountPaise?: number; isInterState?: boolean } = {},
): QuotationTotals {
  const amounts = lines.map(lineAmountPaise)
  const subtotalPaise = amounts.reduce((a, b) => a + b, 0)

  const requested = Math.max(0, Math.trunc(opts.discountPaise ?? 0))
  const shares = allocate(requested, amounts)
  const discountPaise = shares.reduce((a, b) => a + b, 0)

  const taxable = amounts.map((a, i) => a - shares[i])
  const taxablePaise = taxable.reduce((a, b) => a + b, 0)

  const taxes = taxable.map((t, i) => roundHalfUp((t * lines[i].gstRatePercent) / 100))
  const taxPaise = taxes.reduce((a, b) => a + b, 0)

  // The intra-state split halves the TOTAL tax, not each line, and CGST takes
  // the odd paisa. Splitting per line would scatter rounding across the bill.
  const cgstPaise = opts.isInterState ? 0 : Math.ceil(taxPaise / 2)
  const sgstPaise = opts.isInterState ? 0 : taxPaise - cgstPaise
  const igstPaise = opts.isInterState ? taxPaise : 0

  return {
    lines: amounts.map((amountPaise, i) => ({ amountPaise, taxPaise: taxes[i] })),
    subtotalPaise,
    discountPaise,
    taxablePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    totalPaise: taxablePaise + taxPaise,
  }
}
