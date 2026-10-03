import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { deepDiff, gstr2bExcelToJson, gstr2bJsonToExcel } from '../services/tools/gstr2b.js'

/**
 * GSTR-2B JSON ⇄ Excel — the acceptance tests of the converter spec, run
 * against the three sample files in fixtures/gstr2b.
 */
const fx = (name: string) => readFileSync(path.join(__dirname, 'fixtures', 'gstr2b', name))
const roundTrip = async (json: Buffer) => JSON.parse((await gstr2bExcelToJson((await gstr2bJsonToExcel(json)).bytes)).bytes.toString('utf8'))

describe('GSTR-2B JSON ⇄ Excel', () => {
  it('1. round-trips the sample (10 invoices, 2 credit notes, 1 import) to an identical JSON', async () => {
    const original = JSON.parse(fx('gstr2b-sample.json').toString('utf8'))
    const r = await gstr2bJsonToExcel(fx('gstr2b-sample.json'))
    expect(r.selfTest).toEqual({ pass: true, diffs: [] })
    expect(r.sections.map((s) => [s.section, s.documents])).toEqual([['B2B', 10], ['CDNR', 2], ['IMPG', 1]])
    const back = await roundTrip(fx('gstr2b-sample.json'))
    expect(deepDiff(original, back)).toEqual([])
    const d = back.data
    expect(d.rtnprd).toBe('092026')
    expect(d.docdata.b2b[0]).toMatchObject({ supprd: '092026', supfildt: '11-10-2026' })
    expect(d.docdata.b2b[0].inv[0]).toMatchObject({ typ: 'R', diffprcnt: 1 })
    expect(d.docdata.b2b.some((g: any) => g.inv.some((i: any) => i.rsn === 'C'))).toBe(true)
    expect(d.docdata.impg[0].isamd).toBe('N')
    expect(d.itcsumm).toBeDefined()
  })

  it('2. rebuilds Net ITC from the data: IGST 179976, CGST 20962.5, SGST 20962.5', async () => {
    const back = await roundTrip(fx('gstr2b-sample.json'))
    const a = back.data.itcsumm.itcavl.nonrevsup
    const net = (h: string) => Math.round((a.b2b[h] + a.cdnr[h] + a.impg[h]) * 100) / 100
    expect([net('igst'), net('cgst'), net('sgst')]).toEqual([179976, 20962.5, 20962.5])
    expect(a.impg.igst).toBe(81000)
    expect(a.cdnr.igst).toBeLessThan(0) // credit notes reverse ITC
  })

  it('3. keeps a two-rate invoice as one invoice with two items', async () => {
    const r = await gstr2bJsonToExcel(fx('gstr2b-multirate.json'))
    expect(r.selfTest.pass).toBe(true)
    expect(r.sections[0].rows).toBe(11) // 10 invoices, one of them on two rows
    const inv = (await roundTrip(fx('gstr2b-multirate.json'))).data.docdata.b2b[0].inv
    expect(inv).toHaveLength(1)
    expect(inv[0].items.map((i: any) => i.rt)).toEqual([12, 5])
    expect(inv[0].cgst).toBe(6625) // the sum of its items
  })

  it('4. blocks a GSTIN typo with a clear message', async () => {
    await expect(gstr2bJsonToExcel(fx('gstr2b-gstin-typo.json'))).rejects.toThrow(/Supplier GSTIN "33AAFCK5678M1Z" is not a valid GSTIN/)
  })

  it('5. writes GSTINs, periods, document numbers and dates as text cells', async () => {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await gstr2bJsonToExcel(fx('gstr2b-sample.json'))).bytes as unknown as ArrayBuffer)
    const ws = wb.getWorksheet('B2B')!
    const head = (ws.getRow(1).values as string[]).slice(1)
    for (const h of ['Supplier GSTIN', 'Supplier Period', 'Invoice No', 'Invoice Date', 'Place of Supply']) {
      const col = head.indexOf(h) + 1
      expect(ws.getColumn(col).numFmt, h).toBe('@')
      expect(typeof ws.getRow(2).getCell(col).value, h).toBe('string')
    }
    expect(ws.getRow(2).getCell(head.indexOf('Supplier Period') + 1).value).toBe('092026')
    expect(wb.getWorksheet('ITC Summary')).toBeDefined()
    expect(wb.getWorksheet('_raw')!.state).toBe('hidden')
  })

  it('maps labels typed in Excel back to portal codes, with warnings', async () => {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await gstr2bJsonToExcel(fx('gstr2b-sample.json'))).bytes as unknown as ArrayBuffer)
    const ws = wb.getWorksheet('B2B')!
    const head = (ws.getRow(1).values as string[]).slice(1)
    ws.getRow(2).getCell(head.indexOf('Invoice Type') + 1).value = 'Regular'
    ws.getRow(2).getCell(head.indexOf('Place of Supply') + 1).value = '33-Tamil Nadu'
    ws.getRow(2).getCell(head.indexOf('ITC Available') + 1).value = 'Yes'
    const r = await gstr2bExcelToJson(Buffer.from(await wb.xlsx.writeBuffer()))
    const inv = JSON.parse(r.bytes.toString()).data.docdata.b2b[0].inv[0]
    expect(inv).toMatchObject({ typ: 'R', pos: '33', itcavl: 'Y' })
    expect(r.issues.filter((i) => i.severity === 'warning').length).toBeGreaterThanOrEqual(3)
  })

  it('ignores a summary typed into Excel and rebuilds itcsumm from the rows', async () => {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await gstr2bJsonToExcel(fx('gstr2b-sample.json'))).bytes as unknown as ArrayBuffer)
    wb.getWorksheet('ITC Summary')!.getRow(2).getCell(3).value = 999999
    const back = JSON.parse((await gstr2bExcelToJson(Buffer.from(await wb.xlsx.writeBuffer()))).bytes.toString()).data
    expect(back.itcsumm.itcavl.nonrevsup.b2b.igst).toBe(100776)
  })

  it('blocks an intra-state invoice carrying IGST and a tax that does not match the rate', async () => {
    const j = JSON.parse(fx('gstr2b-sample.json').toString())
    const inv = j.data.docdata.b2b[0].inv[0]
    inv.items[0].igst = 15000; inv.items[0].cgst = 0; inv.items[0].sgst = 0; inv.igst = 15000; inv.cgst = 0; inv.sgst = 0
    await expect(gstr2bJsonToExcel(Buffer.from(JSON.stringify(j)))).rejects.toThrow(/Intra-state supply/)
  })
})
