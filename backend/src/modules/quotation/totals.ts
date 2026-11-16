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
 *  - The arithmetic IS the invoice engine (invoice/totals.ts): line rounding,
 *    the pro-rata spread of a quotation-level discount and the per-line
 *    CGST/SGST/IGST all come from there, so converting an accepted quotation
 *    to an invoice reproduces its figures paisa for paisa.
 */

import { computeTotals as computeInvoiceTotals, lineTaxable } from '../invoice/totals.js'

/** Whole percents a line may carry. Anything else is rejected by the routes. */
export const GST_RATES = [0, 5, 12, 18, 28, 40] as const
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

/**
 * Gross line amount before any quotation-level discount — the invoice
 * engine's line base, so a quoted line and the invoiced line agree.
 */
export function lineAmountPaise(line: LineInput): number {
  return lineTaxable(toInvoiceLine(line))
}

function toInvoiceLine(line: LineInput) {
  return {
    quantityCenti: line.quantityCenti,
    ratePaise: line.unitRatePaise,
    discountPercent: line.discountPercent,
    gstRatePercent: line.gstRatePercent,
  }
}

/**
 * Compute every figure on a quotation — BY THE INVOICE ENGINE.
 *
 * A quotation is a promise of an invoice, and an accepted one is converted
 * into exactly that invoice. Two engines rounded differently (per-line tax
 * split, discount remainder, line-discount order), so the invoice raised
 * from a quotation could differ from it by paise. One engine means every
 * line and every tax column is identical by construction.
 *
 * The one deliberate difference: a quotation is NOT rounded to the rupee
 * (it has no round-off row); the invoice raised from it rounds as every
 * invoice does and prints its round-off.
 *
 * `isInterState` decides the split and nothing else.
 */
export function computeTotals(
  lines: LineInput[],
  opts: { discountPaise?: number; isInterState?: boolean } = {},
): QuotationTotals {
  const t = computeInvoiceTotals(lines.map(toInvoiceLine), {
    invoiceDiscountPaise: opts.discountPaise,
    isInterState: opts.isInterState,
    roundOff: false,
  })
  return {
    lines: lines.map((l, i) => ({
      amountPaise: lineAmountPaise(l),
      taxPaise: t.lines[i].cgstAmountPaise + t.lines[i].sgstAmountPaise + t.lines[i].igstAmountPaise,
    })),
    subtotalPaise: t.subtotalPaise,
    discountPaise: t.discountPaise,
    taxablePaise: t.taxablePaise,
    cgstPaise: t.cgstPaise,
    sgstPaise: t.sgstPaise,
    igstPaise: t.igstPaise,
    totalPaise: t.totalPaise,
  }
}
