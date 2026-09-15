/**
 * Validator tests. One case per rule, plus a happy-path check that a
 * clean draft returns no findings.
 */
import { describe, expect, it } from 'vitest'
import { sectionizeGstr1 } from '../services/sectionize.js'
import { validateGstr1, type ValidateOptions } from '../services/GstReturnValidator.js'
import {
  b2bIntraState, b2bInterState, b2clSample, b2csSample, cdnrSample,
  invoiceWithLines, inv, rupees, SUPPLIER_STATE,
} from './fixtures.js'
import type { NormalizedInvoice } from '../types.js'

function validate(invoices: NormalizedInvoice[], options: ValidateOptions = { supplierStateCode: SUPPLIER_STATE }) {
  const draft = sectionizeGstr1(invoices, '2026-08')
  return validateGstr1(draft, invoices, options)
}

const codes = (findings: ReturnType<typeof validate>) => findings.map(f => f.code)

describe('validator — happy path', () => {
  it('emits no findings for a well-formed draft', () => {
    const findings = validate([b2bIntraState(), b2bInterState(), b2csSample(), cdnrSample()])
    expect(findings).toEqual([])
  })
})

describe('validator — GSTIN rules', () => {
  it('flags a b2b row whose GSTIN is malformed', () => {
    const bad: NormalizedInvoice = { ...b2bIntraState(), buyerGstin: 'NOTA-VALID-GSTIN' }
    const findings = validate([bad])
    expect(codes(findings)).toContain('B2B_INVALID_GSTIN')
    expect(codes(findings)).toContain('INVOICE_INVALID_GSTIN')
  })

  it('warns when intra-state B2B GSTIN state prefix does not match PoS', () => {
    const mismatched: NormalizedInvoice = {
      ...b2bIntraState(),
      buyerGstin: '29AAACB0000B1Z5', // Karnataka GSTIN
      placeOfSupply: '33',           // but PoS says Tamil Nadu
      isInterState: false,
    }
    const findings = validate([mismatched])
    expect(codes(findings)).toContain('B2B_STATE_MISMATCH')
  })
})

describe('validator — b2cs', () => {
  it('flags a b2cs bucket that ended up without a place-of-supply', () => {
    const noPos: NormalizedInvoice = { ...b2csSample(), placeOfSupply: null }
    const findings = validate([noPos])
    expect(codes(findings)).toContain('B2CS_MISSING_POS')
  })
})

describe('validator — b2cl', () => {
  it('flags a b2cl row whose PoS equals the supplier state', () => {
    const bad: NormalizedInvoice = { ...b2clSample(), placeOfSupply: SUPPLIER_STATE, isInterState: true }
    const findings = validate([bad])
    expect(codes(findings)).toContain('B2CL_SAME_STATE')
  })
})

describe('validator — inter-state vs intra-state tax split', () => {
  it('flags inter-state row with CGST/SGST', () => {
    const bad: NormalizedInvoice = {
      ...b2bInterState(),
      cgstTotal: rupees(1_000),
      sgstTotal: rupees(1_000),
      igstTotal: 0n,
    }
    const findings = validate([bad])
    expect(codes(findings)).toContain('INTERSTATE_WITH_CGST')
  })

  it('flags intra-state row with IGST', () => {
    const bad: NormalizedInvoice = {
      ...b2bIntraState(),
      cgstTotal: 0n,
      sgstTotal: 0n,
      igstTotal: rupees(1_800),
    }
    const findings = validate([bad])
    expect(codes(findings)).toContain('INTRASTATE_WITH_IGST')
  })

  it('flags intra-state row where CGST ≠ SGST', () => {
    const bad: NormalizedInvoice = {
      ...b2bIntraState(),
      cgstTotal: rupees(900),
      sgstTotal: rupees(800),
    }
    const findings = validate([bad])
    expect(codes(findings)).toContain('CGST_SGST_UNEQUAL')
  })
})

describe('validator — tax = rate × taxable within ₹1', () => {
  it('warns when tax is off by more than ₹1', () => {
    // Taxable ₹10,000 at 18% should be ₹1,800 tax. Set ₹2,000 to force the delta.
    const bad: NormalizedInvoice = {
      ...b2bIntraState(),
      taxableTotal: rupees(10_000),
      cgstTotal: rupees(1_000),
      sgstTotal: rupees(1_000),
      igstTotal: 0n,
    }
    const findings = validate([bad])
    expect(codes(findings)).toContain('TAX_RATE_MISMATCH')
  })

  it('does not warn for a ₹1 rounding drift', () => {
    // Off by ₹1 (100 paise) — inside tolerance.
    const drift: NormalizedInvoice = {
      ...b2bIntraState(),
      cgstTotal: rupees(900),
      sgstTotal: rupees(900) + 50n, // add 50 paise so total delta is 50p < 100p
    }
    const findings = validate([drift])
    // The intra-state CGST/SGST equality rule will trip; that's a separate rule.
    expect(codes(findings)).not.toContain('TAX_RATE_MISMATCH')
  })
})

describe('validator — negative taxable', () => {
  it('flags an invoice with negative taxable (should be credit_note)', () => {
    const bad: NormalizedInvoice = { ...b2bIntraState(), taxableTotal: -rupees(1_000) }
    const findings = validate([bad])
    expect(codes(findings)).toContain('NEGATIVE_TAXABLE')
  })
})

describe('validator — hsn-required flag', () => {
  it('flags a large-turnover draft with no HSN block', () => {
    const findings = validate([b2bIntraState()], { supplierStateCode: SUPPLIER_STATE, hsnRequired: true })
    expect(codes(findings)).toContain('HSN_REQUIRED_MISSING')
  })

  it('accepts a large-turnover draft that has HSN rows', () => {
    const findings = validate([invoiceWithLines()], { supplierStateCode: SUPPLIER_STATE, hsnRequired: true })
    expect(codes(findings)).not.toContain('HSN_REQUIRED_MISSING')
  })
})
