import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { ComplianceService } from '../services/tools/ComplianceService.js'
import { fixture, sheetValues } from './compliance-helpers.js'

/**
 * GST JSON ⇄ Excel (GSTR-1). gstr1.json carries b2b (a regular and an SEZ
 * invoice), b2cs, cdnr, exp with shipping-bill details, Table 12 HSN split
 * into B2B/B2C, Table 13 documents issued and Table 8 nil-rated supplies.
 * Nothing in it may be lost or change type on the way to Excel and back.
 */
describe('GST JSON ⇄ Excel', () => {
  it('round-trips every GSTR-1 section exactly', async () => {
    const src = JSON.parse((await fixture('gstr1.json')).toString('utf8'))
    const xlsx = await ComplianceService.gstJsonToExcel(await fixture('gstr1.json'))
    expect(xlsx.warning).toBeUndefined()
    const back = await ComplianceService.gstExcelToJson(xlsx.bytes)
    expect(JSON.parse(back.bytes.toString('utf8'))).toEqual(src)
  })

  it('writes amounts as numbers and codes as text, with CDN and invoice types kept', async () => {
    const { bytes, sections } = await ComplianceService.gstJsonToExcel(await fixture('gstr1.json'))
    expect(sections).toEqual(expect.arrayContaining(['B2B', 'B2CS', 'CDNR', 'EXP', 'HSN', 'DOCS', 'NIL']))

    const b2b = await sheetValues(bytes, 'B2B')
    const h = b2b[0] as string[]
    const sez = b2b.find((r) => r[h.indexOf('Invoice No')] === 'KT/26-27/003')!
    expect(sez[h.indexOf('Invoice Type')]).toBe('SEWP')
    expect(sez[h.indexOf('Place of Supply')]).toBe('29')
    expect(sez[h.indexOf('Invoice Value')]).toBe(11564)
    expect(sez[h.indexOf('IGST')]).toBe(1764)

    const cdnr = await sheetValues(bytes, 'CDNR')
    expect(cdnr[1][(cdnr[0] as string[]).indexOf('Note Type')]).toBe('C')

    const exp = await sheetValues(bytes, 'EXP')
    const eh = exp[0] as string[]
    expect(exp[1][eh.indexOf('Shipping Bill Port Code')]).toBe('INMAA1')
    expect(exp[1][eh.indexOf('Shipping Bill No')]).toBe('1234567')
    expect(exp[1][eh.indexOf('Shipping Bill Date')]).toBe('16-04-2026')

    const hsn = await sheetValues(bytes, 'HSN')
    const hh = hsn[0] as string[]
    expect(hsn[1][hh.indexOf('HSN')]).toBe('5208')
    expect(hsn[1][hh.indexOf('Table')]).toBe('hsn_b2b')
    expect(hsn[1][hh.indexOf('Taxable Value')]).toBe(134800)
  })

  it('rebuilds a sheet a person retyped: real dates, a numeric place of supply and HSN', async () => {
    const { bytes } = await ComplianceService.gstJsonToExcel(await fixture('gstr1.json'))
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(bytes as unknown as ArrayBuffer)
    const b2b = wb.getWorksheet('B2B')!
    const head = (b2b.getRow(1).values as string[])
    b2b.getRow(2).getCell(head.indexOf('Invoice Date')).value = new Date(Date.UTC(2026, 3, 1))
    b2b.getRow(2).getCell(head.indexOf('Place of Supply')).value = 7
    const hsn = wb.getWorksheet('HSN')!
    hsn.getRow(2).getCell((hsn.getRow(1).values as string[]).indexOf('HSN')).value = 402
    const out = JSON.parse((await ComplianceService.gstExcelToJson(Buffer.from(await wb.xlsx.writeBuffer()))).bytes.toString('utf8'))
    expect(out.b2b[0].inv[0].idt).toBe('01-04-2026')
    expect(out.b2b[0].inv[0].pos).toBe('07')
    expect(out.hsn.hsn_b2b[0].hsn_sc).toBe('0402')
  })

  it('names sections it does not convert instead of dropping them silently', async () => {
    const src = JSON.parse((await fixture('gstr1.json')).toString('utf8'))
    src.b2ba = [{ ctin: '33AAACS1234A1Z5', inv: [] }]
    src.supeco = { clttx: [] }
    const r = await ComplianceService.gstJsonToExcel(Buffer.from(JSON.stringify(src)))
    expect(r.warning).toMatch(/b2ba/)
    expect(r.warning).toMatch(/supeco/)
    const summary = await sheetValues(r.bytes, 'Summary')
    expect(summary.find((x) => x[0] === 'Not converted')?.[1]).toMatch(/b2ba, supeco/)
  })

  it('says plainly that a GSTR-3B JSON is not supported', async () => {
    await expect(ComplianceService.gstJsonToExcel(await fixture('gstr3b.json'))).rejects.toThrow(/GSTR-3B/)
  })
})
