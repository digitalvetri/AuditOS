import { describe, expect, it } from 'vitest'
import type { RpParsedRow } from '@prisma/client'
import { buildFromRows } from '../gstr1-builder.js'

/**
 * B2CL (Table 5A) is decided on the INVOICE value, not the line: an
 * inter-state invoice to an unregistered buyer whose value is more than
 * ₹1,00,000 goes to B2CL with all its lines, whatever each line is worth.
 */
function row(over: Partial<RpParsedRow>): RpParsedRow {
  return {
    id: `row-${Math.random().toString(36).slice(2, 8)}`,
    organisationId: 'org-1', uploadId: 'up-1', sourceRowIndex: 2, txType: 'shipment',
    invoiceNumber: 'INV-1', invoiceDate: '2025-12-01', invoiceAmount: 0, taxableValue: 0,
    cgstTax: 0, sgstTax: 0, igstTax: 0, cessTax: 0, rate: 1800, hsn: '85437099', quantity: 1,
    shipToState: 'KARNATAKA', sellerGstin: '33COAST7890K1Z4', stateCodeIntra: false,
    creditNoteNumber: null, creditNoteDate: null, ecoGstin: null, rawJson: '{}', createdAt: new Date(),
    ...over,
  }
}

// ₹60,000 line: taxable ₹50,847.46 + IGST ₹9,152.54.
const line = (i: number, over: Partial<RpParsedRow> = {}) =>
  row({ sourceRowIndex: i, invoiceAmount: 60_000_00, taxableValue: 50_847_46, igstTax: 9_152_54, ...over })

describe('GSTR-1 B2CL', () => {
  it('an invoice of two ₹60,000 inter-state lines is one B2CL invoice of ₹1,20,000', () => {
    const { preview, counts } = buildFromRows([line(2), line(3)], '33COAST7890K1Z4', '2025-12')
    expect(preview.b2cs).toHaveLength(0)
    expect(preview.b2cl).toHaveLength(1)
    expect(preview.b2cl[0].pos).toBe('29')
    expect(preview.b2cl[0].inv).toHaveLength(1)
    const inv = preview.b2cl[0].inv[0]
    expect(inv).toMatchObject({ inum: 'INV-1', val: 120000 })
    expect(inv.itms.map((i) => [i.num, i.itm_det.txval, i.itm_det.iamt])).toEqual([[1, 50847.46, 9152.54], [2, 50847.46, 9152.54]])
    expect(counts.b2cl).toBe(2)
  })

  it('the threshold is "more than" ₹1,00,000: an invoice of exactly ₹1,00,000 stays in B2CS', () => {
    const { preview } = buildFromRows([
      line(2, { invoiceAmount: 50_000_00 }), line(3, { invoiceAmount: 50_000_00 }),
    ], '33COAST7890K1Z4', '2025-12')
    expect(preview.b2cl).toHaveLength(0)
    expect(preview.b2cs).toHaveLength(1)
  })

  it('lines of different invoices are not added together, and intra-state never goes to B2CL', () => {
    const { preview } = buildFromRows([
      line(2, { invoiceNumber: 'A' }), line(3, { invoiceNumber: 'B' }),
      line(4, { invoiceNumber: 'C', stateCodeIntra: true, shipToState: 'TAMIL NADU' }),
      line(5, { invoiceNumber: 'C', stateCodeIntra: true, shipToState: 'TAMIL NADU' }),
    ], '33COAST7890K1Z4', '2025-12')
    expect(preview.b2cl).toHaveLength(0)
    expect(preview.b2cs.map((b) => b.sply_ty).sort()).toEqual(['INTER', 'INTRA'])
  })
})
