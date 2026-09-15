/**
 * Validate a composed GSTR-1 draft against the rules that catch the
 * mistakes that would otherwise bounce back from the GSTN portal.
 *
 * Findings carry a `severity`:
 *   - `error`   the return will be rejected — block filing
 *   - `warning` the return will accept, but numbers look off — flag
 *   - `info`    routine notice, useful in the UI checklist
 *
 * The validator is pure and cheap; call it every time the draft is
 * viewed or persisted.
 */
import type {
  Gstr1Draft,
  NormalizedInvoice,
  SectionRow,
  ValidationFinding,
} from '../types.js'
import { B2CL_THRESHOLD_PAISE } from './sectionize.js'

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const STATE_CODE_REGEX = /^[0-9]{2}$/

/**
 * Rounding tolerance for the tax = rate × taxable check. GSTN accepts a
 * ₹1 delta per invoice — Books does line-level rounding, so a doc-level
 * check with a ₹1 tolerance (100 paise) rides through cleanly.
 */
const TAX_ROUNDING_TOLERANCE_PAISE = 100n

/**
 * Turnover threshold above which HSN is mandatory in GSTR-1. The
 * Council currently sets this at ₹5 crore aggregate turnover; below
 * it, four-digit HSN is optional. We don't know the client's turnover
 * from the draft alone, so this is caller-supplied — set to true when
 * the profile flags aggregate turnover > ₹5 cr.
 */
export interface ValidateOptions {
  hsnRequired?: boolean
  /** The supplier's own state code. Used to catch inter-state / intra-state
   * mismatches vs place-of-supply. */
  supplierStateCode?: string | null
}

/**
 * Run every applicable rule against a draft. Also accepts the raw
 * NormalizedInvoice list so rules can point back to specific
 * invoices when a section row is aggregated (b2cs, hsn).
 */
export function validateGstr1(
  draft: Gstr1Draft,
  invoices: NormalizedInvoice[],
  options: ValidateOptions = {},
): ValidationFinding[] {
  const findings: ValidationFinding[] = []

  draft.sections.forEach((row, index) => {
    if (row.section === 'b2b')   checkB2bRow(row, index, findings)
    if (row.section === 'cdnr')  checkB2bRow(row, index, findings) // same GSTIN rules
    if (row.section === 'b2cl')  checkB2clRow(row, index, findings, options.supplierStateCode)
    if (row.section === 'b2cs')  checkB2csRow(row, index, findings)
    if (row.section !== 'hsn')   checkTaxArithmetic(row, index, findings)
  })

  checkInvoiceLevel(invoices, findings, options)

  if (options.hsnRequired) checkHsnRequired(draft, findings)

  return findings
}

// ── Section-level rules ────────────────────────────────────────────────

function checkB2bRow(row: SectionRow, index: number, out: ValidationFinding[]): void {
  if (!row.counterpartyGstin) {
    out.push({
      code: 'B2B_MISSING_GSTIN',
      severity: 'error',
      message: `b2b row #${index} has no counterparty GSTIN — must be in b2cs / b2cl instead`,
      ref: { kind: 'section', index },
    })
    return
  }
  if (!GSTIN_REGEX.test(row.counterpartyGstin)) {
    out.push({
      code: 'B2B_INVALID_GSTIN',
      severity: 'error',
      message: `GSTIN '${row.counterpartyGstin}' on b2b row #${index} does not match the GSTIN pattern`,
      ref: { kind: 'section', index },
    })
  }
  // Cross-check: state code prefix of the GSTIN should equal placeOfSupply
  // on an intra-state supply.
  if (row.counterpartyGstin && GSTIN_REGEX.test(row.counterpartyGstin) && row.placeOfSupply && !row.isInterState) {
    const gstinStatePrefix = row.counterpartyGstin.slice(0, 2)
    if (gstinStatePrefix !== row.placeOfSupply) {
      out.push({
        code: 'B2B_STATE_MISMATCH',
        severity: 'warning',
        message: `Intra-state b2b row #${index}: GSTIN state '${gstinStatePrefix}' does not match place-of-supply '${row.placeOfSupply}'`,
        ref: { kind: 'section', index },
      })
    }
  }
}

function checkB2clRow(row: SectionRow, index: number, out: ValidationFinding[], supplierStateCode: string | null | undefined): void {
  if (!row.isInterState) {
    out.push({
      code: 'B2CL_MUST_BE_INTERSTATE',
      severity: 'error',
      message: `b2cl row #${index} is not marked inter-state — b2cl is inter-state only, use b2cs`,
      ref: { kind: 'section', index },
    })
  }
  if (row.taxableValue < B2CL_THRESHOLD_PAISE - row.cgst - row.sgst - row.igst) {
    // A row landed in b2cl but its total is under the threshold. Only
    // warn — the composer picks the bucket from `total`, and a fee-
    // heavy invoice can straddle the line.
    out.push({
      code: 'B2CL_UNDER_THRESHOLD',
      severity: 'warning',
      message: `b2cl row #${index} taxable+tax is under the ₹1L threshold — verify it belongs here, not in b2cs`,
      ref: { kind: 'section', index },
    })
  }
  if (row.placeOfSupply && supplierStateCode && row.placeOfSupply === supplierStateCode) {
    out.push({
      code: 'B2CL_SAME_STATE',
      severity: 'error',
      message: `b2cl row #${index} place-of-supply equals supplier state — this is intra-state, not b2cl`,
      ref: { kind: 'section', index },
    })
  }
}

function checkB2csRow(row: SectionRow, index: number, out: ValidationFinding[]): void {
  // b2cs rows are aggregates; they must carry a place-of-supply and a rate.
  if (!row.placeOfSupply || !STATE_CODE_REGEX.test(row.placeOfSupply)) {
    out.push({
      code: 'B2CS_MISSING_POS',
      severity: 'error',
      message: `b2cs row #${index} needs a two-digit place-of-supply state code`,
      ref: { kind: 'section', index },
    })
  }
  if (row.rateBp == null) {
    out.push({
      code: 'B2CS_MISSING_RATE',
      severity: 'error',
      message: `b2cs row #${index} has no rate — the aggregator dropped a bucket`,
      ref: { kind: 'section', index },
    })
  }
}

function checkTaxArithmetic(row: SectionRow, index: number, out: ValidationFinding[]): void {
  // Split rule: an inter-state row has IGST only; an intra-state row
  // has CGST + SGST but not IGST.
  if (row.isInterState) {
    if (row.cgst > 0n || row.sgst > 0n) {
      out.push({
        code: 'INTERSTATE_WITH_CGST',
        severity: 'error',
        message: `Row #${index} is inter-state but carries CGST/SGST — should be IGST only`,
        ref: { kind: 'section', index },
      })
    }
  } else {
    if (row.igst > 0n) {
      out.push({
        code: 'INTRASTATE_WITH_IGST',
        severity: 'error',
        message: `Row #${index} is intra-state but carries IGST — should be CGST + SGST`,
        ref: { kind: 'section', index },
      })
    }
    if (row.cgst !== row.sgst) {
      out.push({
        code: 'CGST_SGST_UNEQUAL',
        severity: 'error',
        message: `Row #${index} CGST (${row.cgst}) and SGST (${row.sgst}) must be equal on intra-state supplies`,
        ref: { kind: 'section', index },
      })
    }
  }

  // Rate check: tax should equal rate × taxable within tolerance.
  if (row.rateBp != null && row.rateBp > 0) {
    const expected = (row.taxableValue * BigInt(row.rateBp)) / 10000n
    const actual = row.cgst + row.sgst + row.igst
    const delta = actual > expected ? actual - expected : expected - actual
    if (delta > TAX_ROUNDING_TOLERANCE_PAISE) {
      out.push({
        code: 'TAX_RATE_MISMATCH',
        severity: 'warning',
        message: `Row #${index} tax (${actual}p) is off by ${delta}p from ${row.rateBp / 100}% of taxable (${row.taxableValue}p)`,
        ref: { kind: 'section', index },
      })
    }
  }
}

// ── Invoice-level rules ────────────────────────────────────────────────

function checkInvoiceLevel(invoices: NormalizedInvoice[], out: ValidationFinding[], options: ValidateOptions): void {
  for (const inv of invoices) {
    if (inv.taxableTotal < 0n) {
      out.push({
        code: 'NEGATIVE_TAXABLE',
        severity: 'error',
        message: `Invoice ${inv.number} has negative taxable value — credit notes should be kind='credit_note', not a negative invoice`,
        ref: { kind: 'invoice', id: inv.id },
      })
    }
    if (inv.buyerGstin && !GSTIN_REGEX.test(inv.buyerGstin)) {
      out.push({
        code: 'INVOICE_INVALID_GSTIN',
        severity: 'error',
        message: `Invoice ${inv.number} buyer GSTIN '${inv.buyerGstin}' is malformed`,
        ref: { kind: 'invoice', id: inv.id },
      })
    }
    if (inv.isInterState && options.supplierStateCode && inv.placeOfSupply === options.supplierStateCode) {
      out.push({
        code: 'INVOICE_INTERSTATE_SAME_STATE',
        severity: 'error',
        message: `Invoice ${inv.number} is marked inter-state but PoS equals supplier state`,
        ref: { kind: 'invoice', id: inv.id },
      })
    }
  }
}

function checkHsnRequired(draft: Gstr1Draft, out: ValidationFinding[]): void {
  const hasHsn = draft.sections.some(s => s.section === 'hsn' && s.taxableValue > 0n)
  if (!hasHsn) {
    out.push({
      code: 'HSN_REQUIRED_MISSING',
      severity: 'error',
      message: `Aggregate turnover requires an HSN summary block, but the draft has none — invoices likely lack line-level HSN codes`,
    })
  }
}
