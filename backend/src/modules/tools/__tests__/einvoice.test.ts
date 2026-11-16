import { describe, expect, it } from 'vitest'
import { ComplianceService } from '../services/tools/ComplianceService.js'
import { ToolError } from '../services/errors.js'
import { fixture, workbook } from './compliance-helpers.js'

/**
 * Invoice to e-Invoice JSON, NIC/IRP schema v1.1. Mandatory per the schema:
 * Seller Gstin, LglNm, Addr1, Loc, Pin, Stcd; Buyer Gstin, LglNm, Pos,
 * Addr1, Loc, Stcd (Pin required here too); item HsnCd (4/6/8 digits),
 * UnitPrice, GstRt. B2C is not an IRP supply type.
 */
const HEAD = ['Invoice No', 'Invoice Date', 'Seller GSTIN', 'Seller Name', 'Seller Address', 'Seller City', 'Seller Pincode',
  'Buyer GSTIN', 'Buyer Name', 'Buyer Address', 'Buyer City', 'Buyer Pincode', 'Place of Supply', 'Item Description', 'HSN',
  'Quantity', 'Unit', 'Unit Price', 'Taxable Value', 'GST Rate', 'IGST', 'CGST', 'SGST']
const SELLER = ['33AABCK1234M1Z5', 'Kaveri Traders Pvt Ltd', '12 Anna Salai', 'Chennai', '600002']
const SHARMA = ['33AAACS1234A1Z5', 'Sharma Traders', '5 Mint St', 'Chennai', '600001', '33']
const MURUGAN = ['29AADFM9012C1Z9', 'Murugan & Co', '1 MG Road', 'Bengaluru', '560001', '29']
const GOOD = [
  ['KT/26-27/001', '01/04/2026', ...SELLER, ...SHARMA, 'Cotton fabric', '5208', 1000, 'MTR', 125, 125000, 18, '', 11250, 11250],
  ['KT/26-27/001', '01/04/2026', ...SELLER, ...SHARMA, 'Freight', '996511', 1, 'OTH', 2000, 2000, 18, '', 180, 180],
  ['KT/26-27/003', '07/04/2026', ...SELLER, ...MURUGAN, 'Cotton fabric', '5208', 80, 'MTR', 122.5, 9800, 18, 1764, '', ''],
]

async function refusal(p: Promise<unknown>): Promise<ToolError> {
  try { await p } catch (e) { return e as ToolError }
  throw new Error('expected the conversion to be refused')
}

describe('Invoice to e-Invoice JSON', () => {
  it('builds schema-1.1 invoices with every mandatory party and item field', async () => {
    const r = await ComplianceService.invoiceToEInvoiceJson(await workbook(HEAD, GOOD))
    const out = JSON.parse(r.bytes.toString('utf8'))
    expect(out).toHaveLength(2)
    expect(out[0].TranDtls).toMatchObject({ TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N' })
    expect(out[0].SellerDtls).toEqual({ Gstin: '33AABCK1234M1Z5', LglNm: 'Kaveri Traders Pvt Ltd', Addr1: '12 Anna Salai', Loc: 'Chennai', Pin: 600002, Stcd: '33' })
    expect(out[0].BuyerDtls).toEqual({ Gstin: '33AAACS1234A1Z5', LglNm: 'Sharma Traders', Addr1: '5 Mint St', Loc: 'Chennai', Pin: 600001, Pos: '33', Stcd: '33' })
    expect(out[0].ItemList[1]).toMatchObject({ SlNo: '2', IsServc: 'Y', HsnCd: '996511', UnitPrice: 2000, GstRt: 18, CgstAmt: 180, SgstAmt: 180 })
    expect(out[1].ItemList[0]).toMatchObject({ IsServc: 'N', Qty: 80, Unit: 'MTR', GstRt: 18, IgstAmt: 1764 })
    expect(out[0].ValDtls.TotInvVal).toBe(149860)
  })

  it('refuses the whole file, row by row, when an invoice would be rejected by the IRP', async () => {
    const err = await refusal(ComplianceService.invoiceToEInvoiceJson(await fixture('einvoice.xlsx')))
    expect(err).toBeInstanceOf(ToolError)
    const problems = (err.details?.problems ?? []) as string[]
    expect(problems.some((p) => /^row 5: .*unregistered buyer/i.test(p))).toBe(true)
    expect(problems.some((p) => /^row 6: .*Seller Name/.test(p))).toBe(true)
    expect(problems.some((p) => /^row 6: .*HSN/.test(p))).toBe(true)
    expect(err.message).toMatch(/row 5/)
  })

  it('checks the GST rate against the tax amounts', async () => {
    const bad = [['KT/26-27/009', '09/04/2026', ...SELLER, ...SHARMA, 'Cotton fabric', '5208', 10, 'MTR', 1000, 10000, 12, '', 900, 900]]
    const err = await refusal(ComplianceService.invoiceToEInvoiceJson(await workbook(HEAD, bad)))
    expect(String(err.details?.problems)).toMatch(/row 2: .*12%.*1,200\.00.*1,800\.00/)
  })

  it('reads the rate from the tax when the GST Rate cell is blank, only if it is a real slab', async () => {
    const rows = [['KT/26-27/010', '10/04/2026', ...SELLER, ...SHARMA, 'Cotton fabric', '5208', 10, 'MTR', 500, 5000, '', '', 450, 450]]
    const out = JSON.parse((await ComplianceService.invoiceToEInvoiceJson(await workbook(HEAD, rows))).bytes.toString('utf8'))
    expect(out[0].ItemList[0].GstRt).toBe(18)
    const odd = [['KT/26-27/011', '10/04/2026', ...SELLER, ...SHARMA, 'Cotton fabric', '5208', 10, 'MTR', 500, 5000, '', '', 400, 400]]
    await expect(ComplianceService.invoiceToEInvoiceJson(await workbook(HEAD, odd))).rejects.toThrow(/GST Rate/)
  })

  it('an export without payment carries URP and the supply type given', async () => {
    const head = [...HEAD, 'Supply Type', 'Buyer State Code']
    const rows = [['KT/EXP/01', '15/04/2026', ...SELLER, '', 'Gulf Textiles LLC', 'PO Box 1234', 'Dubai', '999999', '96', 'Cotton fabric', '5208', 4000, 'MTR', 125, 500000, 0, 0, '', '', 'EXPWOP', '96']]
    const out = JSON.parse((await ComplianceService.invoiceToEInvoiceJson(await workbook(head, rows))).bytes.toString('utf8'))
    expect(out[0].TranDtls.SupTyp).toBe('EXPWOP')
    expect(out[0].BuyerDtls).toMatchObject({ Gstin: 'URP', Pos: '96', Stcd: '96', Pin: 999999 })
  })
})
