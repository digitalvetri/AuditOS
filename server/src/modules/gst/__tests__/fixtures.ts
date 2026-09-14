/**
 * Fabricated NormalizedInvoice rows for composer + validator tests.
 * Amounts are in paise; the helper `rupees(n)` keeps call sites
 * readable.
 */
import type { NormalizedInvoice } from '../types.js'

export const rupees = (n: number): bigint => BigInt(Math.round(n * 100))

/** Supplier context — a Tamil Nadu firm. */
export const SUPPLIER_STATE = '33'
export const SUPPLIER_GSTIN = '33AAACS1234A1Z5'

/**
 * Deterministic invoice builder. Only the fields a given test cares
 * about need to be passed; the rest come from sensible defaults so
 * fixtures stay compact.
 */
export function inv(overrides: Partial<NormalizedInvoice> & { id: string }): NormalizedInvoice {
  return {
    kind:          'invoice',
    number:        `INV-${overrides.id}`,
    date:          '2026-08-15',
    buyerGstin:    null,
    buyerName:     'Test buyer',
    buyerStateCode: null,
    gstTreatment:  'consumer',
    placeOfSupply: '33',
    isInterState:  false,
    taxableTotal:  rupees(1000),
    cgstTotal:     rupees(90),
    sgstTotal:     rupees(90),
    igstTotal:     0n,
    cessTotal:     0n,
    total:         rupees(1180),
    ...overrides,
  }
}

/** b2b sample — a Tamil Nadu firm selling to a Tamil Nadu registered buyer. */
export const b2bIntraState = (): NormalizedInvoice =>
  inv({
    id: 'b2b-intra',
    number: 'INV/2026/001',
    buyerGstin: '33AAACB0000B1Z5',
    buyerName: 'Regd Buyer Chennai',
    buyerStateCode: '33',
    gstTreatment: 'business_gst',
    placeOfSupply: '33',
    isInterState: false,
    taxableTotal: rupees(10_000),
    cgstTotal: rupees(900),
    sgstTotal: rupees(900),
    igstTotal: 0n,
    total: rupees(11_800),
  })

/** b2b inter-state — TN supplier, Karnataka buyer, IGST only. */
export const b2bInterState = (): NormalizedInvoice =>
  inv({
    id: 'b2b-inter',
    number: 'INV/2026/002',
    buyerGstin: '29AAACB1111B1Z5',
    buyerName: 'Regd Buyer Bangalore',
    buyerStateCode: '29',
    gstTreatment: 'business_gst',
    placeOfSupply: '29',
    isInterState: true,
    taxableTotal: rupees(50_000),
    cgstTotal: 0n,
    sgstTotal: 0n,
    igstTotal: rupees(9_000),
    total: rupees(59_000),
  })

/** b2cl — inter-state B2C above the ₹1L threshold. */
export const b2clSample = (): NormalizedInvoice =>
  inv({
    id: 'b2cl-1',
    number: 'INV/2026/003',
    buyerGstin: null,
    buyerName: 'Individual Delhi',
    buyerStateCode: '07',
    gstTreatment: 'consumer',
    placeOfSupply: '07',
    isInterState: true,
    taxableTotal: rupees(1_50_000),
    cgstTotal: 0n,
    sgstTotal: 0n,
    igstTotal: rupees(27_000),
    total: rupees(1_77_000),
  })

/** b2cs — intra-state B2C, small ticket, aggregated per rate. */
export const b2csSample = (): NormalizedInvoice =>
  inv({
    id: 'b2cs-1',
    number: 'INV/2026/010',
    buyerGstin: null,
    buyerName: 'Walk-in Coimbatore',
    gstTreatment: 'consumer',
    placeOfSupply: '33',
    isInterState: false,
    taxableTotal: rupees(1_000),
    cgstTotal: rupees(90),
    sgstTotal: rupees(90),
    igstTotal: 0n,
    total: rupees(1_180),
  })

/** cdnr — credit note to a registered buyer. */
export const cdnrSample = (): NormalizedInvoice =>
  inv({
    id: 'cdnr-1',
    kind: 'credit_note',
    number: 'CN/2026/001',
    buyerGstin: '33AAACB0000B1Z5',
    buyerName: 'Regd Buyer Chennai',
    buyerStateCode: '33',
    gstTreatment: 'business_gst',
    placeOfSupply: '33',
    isInterState: false,
    taxableTotal: rupees(500),
    cgstTotal: rupees(45),
    sgstTotal: rupees(45),
    igstTotal: 0n,
    total: rupees(590),
  })

/** Invoice with lines so the HSN summary has something to aggregate. */
export const invoiceWithLines = (): NormalizedInvoice => ({
  ...b2bIntraState(),
  id: 'b2b-lines',
  number: 'INV/2026/100',
  lines: [
    { hsnSac: '998211', quantity: 1, taxable: rupees(6_000), cgst: rupees(540), sgst: rupees(540), igst: 0n, cess: 0n, taxPercentBp: 1800 },
    { hsnSac: '998211', quantity: 1, taxable: rupees(4_000), cgst: rupees(360), sgst: rupees(360), igst: 0n, cess: 0n, taxPercentBp: 1800 },
  ],
})
