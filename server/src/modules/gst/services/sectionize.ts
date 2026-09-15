/**
 * Pure sectionization: turn a list of NormalizedInvoice rows for a
 * period into the GSTR-1 section shape the return-JSON expects.
 *
 * No Prisma import here so unit tests can hit this file directly with
 * fabricated fixtures. All monetary arithmetic is in paise as bigint.
 */
import type {
  DraftTotals,
  Gstr1Draft,
  NormalizedInvoice,
  SectionRow,
} from '../types.js'

/**
 * B2CL threshold — inter-state B2C invoices at or above this go into
 * b2cl (one row each), the rest fall into b2cs (aggregated).
 *
 * The Council reduced this from ₹2.5L to ₹1L via Notification 12/2024,
 * effective 01-Nov-2024. ₹1,00,000 × 100 paise = 10,000,000 paise.
 */
export const B2CL_THRESHOLD_PAISE: bigint = 10_000_000n

/**
 * Compose the outward-supply sections for a period from a list of
 * normalized invoices. Pure — deterministic ordering, no I/O.
 */
export function sectionizeGstr1(
  invoices: NormalizedInvoice[],
  period: string,
): Gstr1Draft {
  const sections: SectionRow[] = []

  // Sort by (date, number) so ordinals within a section are stable.
  const sortedInvoices = [...invoices].sort(
    (a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number),
  )

  // --- Invoices (kind='invoice') ---
  const invoicesOnly = sortedInvoices.filter(i => i.kind === 'invoice')

  // b2b — one row per invoice with a buyer GSTIN.
  const b2b = invoicesOnly.filter(i => i.buyerGstin)
  b2b.forEach((inv, idx) => sections.push(invoiceRow(inv, 'b2b', idx)))

  // b2cl vs b2cs — split unregistered invoices by inter-state × ₹1L threshold.
  const b2c = invoicesOnly.filter(i => !i.buyerGstin)
  const b2cl = b2c.filter(i => i.isInterState && i.total >= B2CL_THRESHOLD_PAISE)
  b2cl.forEach((inv, idx) => sections.push(invoiceRow(inv, 'b2cl', idx)))

  // b2cs is aggregated per (place-of-supply, rate) — GSTN expects one
  // row per bucket, not one per invoice. We infer the effective rate
  // from the invoice tax split (see rateForInvoice below).
  const b2cs = b2c.filter(i => !(i.isInterState && i.total >= B2CL_THRESHOLD_PAISE))
  const b2csBuckets = new Map<string, SectionRow>()
  for (const inv of b2cs) {
    const rateBp = rateForInvoice(inv)
    const key = `${inv.placeOfSupply ?? ''}|${rateBp}|${inv.isInterState ? '1' : '0'}`
    const existing = b2csBuckets.get(key)
    if (existing) {
      existing.taxableValue += inv.taxableTotal
      existing.cgst += inv.cgstTotal
      existing.sgst += inv.sgstTotal
      existing.igst += inv.igstTotal
      existing.cess += inv.cessTotal
    } else {
      b2csBuckets.set(key, {
        section:           'b2cs',
        ordinal:           0,
        counterpartyGstin: null,
        counterpartyName:  null,
        rateBp,
        hsnCode:           null,
        invoiceNumber:     null,
        invoiceDate:       null,
        placeOfSupply:     inv.placeOfSupply,
        isInterState:      inv.isInterState,
        taxableValue:      inv.taxableTotal,
        cgst:              inv.cgstTotal,
        sgst:              inv.sgstTotal,
        igst:              inv.igstTotal,
        cess:              inv.cessTotal,
        sourceDocumentId:  null,
      })
    }
  }
  // Stable order for b2cs buckets: by PoS, then rateBp.
  const b2csRows = [...b2csBuckets.values()].sort(
    (a, b) =>
      (a.placeOfSupply ?? '').localeCompare(b.placeOfSupply ?? '') ||
      (a.rateBp ?? 0) - (b.rateBp ?? 0),
  )
  b2csRows.forEach((row, idx) => sections.push({ ...row, ordinal: idx }))

  // --- Credit notes (kind='credit_note') ---
  const notes = sortedInvoices.filter(i => i.kind === 'credit_note')
  const cdnr = notes.filter(n => n.buyerGstin)
  cdnr.forEach((n, idx) => sections.push(invoiceRow(n, 'cdnr', idx)))
  const cdnur = notes.filter(n => !n.buyerGstin)
  cdnur.forEach((n, idx) => sections.push(invoiceRow(n, 'cdnur', idx)))

  // --- HSN summary — one row per (hsnSac, taxPercentBp) across all
  //     documents in the period, regardless of buyer or B2B/B2C bucket.
  sections.push(...hsnSummary(sortedInvoices))

  return {
    returnType: 'GSTR-1',
    period,
    sections,
    totals: computeTotals(sortedInvoices),
  }
}

/** One-invoice-one-row emission for b2b / b2cl / cdnr / cdnur. */
function invoiceRow(inv: NormalizedInvoice, section: SectionRow['section'], ordinal: number): SectionRow {
  return {
    section,
    ordinal,
    counterpartyGstin: inv.buyerGstin,
    counterpartyName:  inv.buyerName,
    rateBp:            rateForInvoice(inv),
    hsnCode:           null,
    invoiceNumber:     inv.number,
    invoiceDate:       inv.date,
    placeOfSupply:     inv.placeOfSupply,
    isInterState:      inv.isInterState,
    taxableValue:      inv.taxableTotal,
    cgst:              inv.cgstTotal,
    sgst:              inv.sgstTotal,
    igst:              inv.igstTotal,
    cess:              inv.cessTotal,
    sourceDocumentId:  inv.id,
  }
}

/**
 * Effective GST rate for an invoice, derived from its tax split. This
 * is only accurate when every line on the invoice carries the same
 * rate (the common case). Mixed-rate invoices should compose from
 * lines — the composer emits per-line HSN rows for those, and the
 * document-level bucket picks up the dominant rate.
 *
 * Returns 0 when there is no taxable value (nil / exempt).
 */
export function rateForInvoice(inv: NormalizedInvoice): number {
  if (inv.taxableTotal <= 0n) return 0
  const tax = inv.cgstTotal + inv.sgstTotal + inv.igstTotal
  if (tax <= 0n) return 0
  // (tax / taxable) × 10000 for basis points, rounded to the nearest
  // statutory slab so a ₹1 rounding on the invoice doesn't emit 1799 bp.
  const raw = Number((tax * 10000n) / inv.taxableTotal)
  return snapToSlab(raw)
}

/** Snap a raw basis-point rate to the nearest statutory slab. */
function snapToSlab(bp: number): number {
  const slabs = [0, 500, 1200, 1800, 2800]
  let best = slabs[0]
  let bestDelta = Math.abs(bp - best)
  for (const s of slabs) {
    const d = Math.abs(bp - s)
    if (d < bestDelta) { best = s; bestDelta = d }
  }
  return best
}

/** Aggregate lines by (hsnSac, taxPercentBp) for the HSN summary block. */
function hsnSummary(invoices: NormalizedInvoice[]): SectionRow[] {
  const buckets = new Map<string, SectionRow & { quantity: number }>()
  for (const inv of invoices) {
    if (!inv.lines) continue
    for (const line of inv.lines) {
      const hsn = line.hsnSac ?? ''
      if (!hsn) continue
      const key = `${hsn}|${line.taxPercentBp}`
      const existing = buckets.get(key)
      if (existing) {
        existing.taxableValue += line.taxable
        existing.cgst += line.cgst
        existing.sgst += line.sgst
        existing.igst += line.igst
        existing.cess += line.cess
        existing.quantity += line.quantity
      } else {
        buckets.set(key, {
          section:           'hsn',
          ordinal:           0,
          counterpartyGstin: null,
          counterpartyName:  null,
          rateBp:            line.taxPercentBp,
          hsnCode:           hsn,
          invoiceNumber:     null,
          invoiceDate:       null,
          placeOfSupply:     null,
          isInterState:      false,
          taxableValue:      line.taxable,
          cgst:              line.cgst,
          sgst:              line.sgst,
          igst:              line.igst,
          cess:              line.cess,
          sourceDocumentId:  null,
          quantity:          line.quantity,
        })
      }
    }
  }
  // Stable order for HSN rows: by code, then rate.
  const rows = [...buckets.values()].sort(
    (a, b) => (a.hsnCode ?? '').localeCompare(b.hsnCode ?? '') || (a.rateBp ?? 0) - (b.rateBp ?? 0),
  )
  // Drop the transient quantity field before returning — it's not part
  // of SectionRow (goes into payloadJson later when we build the GSTN
  // envelope in PR 3).
  return rows.map((r, idx) => {
    const { quantity: _q, ...rest } = r
    return { ...rest, ordinal: idx }
  })
}

/** Sum totals across all invoices (invoice + credit note both positive;
 * netting happens in GSTR-3B, not here). */
function computeTotals(invoices: NormalizedInvoice[]): DraftTotals {
  let taxable = 0n, cgst = 0n, sgst = 0n, igst = 0n, cess = 0n
  for (const inv of invoices) {
    taxable += inv.taxableTotal
    cgst    += inv.cgstTotal
    sgst    += inv.sgstTotal
    igst    += inv.igstTotal
    cess    += inv.cessTotal
  }
  return {
    totalTaxableValue: taxable,
    totalCgst:         cgst,
    totalSgst:         sgst,
    totalIgst:         igst,
    totalCess:         cess,
    invoiceCount:      invoices.length,
  }
}
