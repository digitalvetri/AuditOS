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

  it('2. splits ITC as GSTR-3B Table 4: net IGST 179976 = imports 81000 + reverse charge 2844 + all other 96132', async () => {
    const r = await gstr2bJsonToExcel(fx('gstr2b-sample.json'))
    expect(r.issues.filter((i) => i.where.startsWith('itcsumm'))).toEqual([]) // documents agree with the portal summary
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(r.bytes as unknown as ArrayBuffer)
    const lines: Record<string, number[]> = {}
    wb.getWorksheet('ITC Summary')!.eachRow((row, n) => {
      if (n === 1) return
      const v = row.values as unknown[]
      // A formula's cached 0 is not stored, so a formula without a result is 0.
      lines[`${v[1]}|${v[2] ?? ''}`] = [3, 4, 5].map((i) => { const c = v[i]; return c && typeof c === 'object' ? Number((c as { result?: number }).result ?? 0) : Number(c ?? 0) })
    })
    expect(lines['4A(1) Import of goods|IMPG']).toEqual([81000, 0, 0])
    expect(lines['4A(3) Inward supplies liable to reverse charge|B2B']).toEqual([2844, 0, 0])
    expect(lines['4A(5) All other ITC|CDNR'][0]).toBeLessThan(0) // credit notes reduce ITC
    expect(lines['Total ITC available — 4A|']).toEqual([179976, 20962.5, 20962.5])
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

  it('4. converts a portal file with a GSTIN typo and flags it (the auditor sees it on the Flags sheet)', async () => {
    const r = await gstr2bJsonToExcel(fx('gstr2b-gstin-typo.json'))
    expect(r.selfTest.pass).toBe(true)
    expect(r.issues.some((i) => /Supplier GSTIN "33AAFCK5678M1Z" is not a valid GSTIN/.test(i.message))).toBe(true)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(r.bytes as unknown as ArrayBuffer)
    const flags: string[] = []
    wb.getWorksheet('Flags')!.eachRow((row) => flags.push(String(row.getCell(2).value)))
    expect(flags.some((f) => f.includes('33AAFCK5678M1Z'))).toBe(true)
  })

  it('4b. a workbook going back to JSON still refuses a malformed GSTIN', async () => {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await gstr2bJsonToExcel(fx('gstr2b-sample.json'))).bytes as unknown as ArrayBuffer)
    const ws = wb.getWorksheet('B2B')!
    const head = (ws.getRow(1).values as string[]).slice(1)
    ws.getRow(2).getCell(head.indexOf('Supplier GSTIN') + 1).value = '33ABC'
    await expect(gstr2bExcelToJson(Buffer.from(await wb.xlsx.writeBuffer()))).rejects.toThrow(/Supplier GSTIN "33ABC" is not a valid GSTIN/)
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

  it('ignores a figure typed into the ITC Summary sheet; the portal itcsumm converts back unchanged', async () => {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await gstr2bJsonToExcel(fx('gstr2b-sample.json'))).bytes as unknown as ArrayBuffer)
    wb.getWorksheet('ITC Summary')!.getRow(2).getCell(3).value = 999999
    const back = JSON.parse((await gstr2bExcelToJson(Buffer.from(await wb.xlsx.writeBuffer()))).bytes.toString()).data
    expect(back.itcsumm.itcavl.nonrevsup.b2b.igst).toBe(97932)
  })

  it('never overwrites the portal itcsumm: a gap is reported and shown on Portal vs Computed', async () => {
    const j = JSON.parse(fx('gstr2b-sample.json').toString())
    j.data.itcsumm.itcavl.nonrevsup.b2b.igst = 90000
    const r = await gstr2bJsonToExcel(Buffer.from(JSON.stringify(j)))
    expect(r.selfTest.pass).toBe(true)
    expect(r.issues.some((i) => i.where === 'itcsumm.itcavl.nonrevsup.b2b.igst' && /portal says 90000; the documents add up to 97932/.test(i.message))).toBe(true)
    const back = JSON.parse((await gstr2bExcelToJson(r.bytes)).bytes.toString()).data
    expect(back.itcsumm.itcavl.nonrevsup.b2b.igst).toBe(90000)
  })

  it('understands the 65% rate and reverse-charge invoice values (no flags for correct documents)', async () => {
    const j = JSON.parse(fx('gstr2b-sample.json').toString())
    const g = j.data.docdata.b2b[0]
    g.inv.push(
      { inum: 'C65', typ: 'R', dt: '15-09-2026', val: 11170, pos: g.ctin.slice(0, 2), rev: 'N', itcavl: 'Y', rsn: '', diffprcnt: 0.65,
        items: [{ num: 1, rt: 18, txval: 10000, igst: 0, cgst: 585, sgst: 585, cess: 0 }] },
      { inum: 'RCM1', typ: 'R', dt: '16-09-2026', val: 5000, pos: g.ctin.slice(0, 2), rev: 'Y', itcavl: 'Y', rsn: '', diffprcnt: 1,
        items: [{ num: 1, rt: 18, txval: 5000, igst: 0, cgst: 450, sgst: 450, cess: 0 }] },
    )
    delete j.data.itcsumm
    const r = await gstr2bJsonToExcel(Buffer.from(JSON.stringify(j)))
    expect(r.issues.filter((i) => /C65|RCM1/.test(i.where) || i.where.startsWith(`docdata.b2b[0].inv[${g.inv.length - 2}]`) || i.where.startsWith(`docdata.b2b[0].inv[${g.inv.length - 1}]`))).toEqual([])
    expect(r.selfTest.pass).toBe(true)
  })

  it('merges the parts of a split download into one workbook, and refuses parts of different periods', async () => {
    const j = JSON.parse(fx('gstr2b-sample.json').toString())
    const a = structuredClone(j); const b = structuredClone(j)
    a.data.docdata = { b2b: j.data.docdata.b2b.slice(0, 3) }
    b.data.docdata = { ...j.data.docdata, b2b: j.data.docdata.b2b.slice(3) }
    const whole = await gstr2bJsonToExcel(fx('gstr2b-sample.json'))
    const merged = await gstr2bJsonToExcel([Buffer.from(JSON.stringify(a)), Buffer.from(JSON.stringify(b))], ['a.json', 'b.json'])
    expect(merged.selfTest.pass).toBe(true)
    expect(merged.sections).toEqual(whole.sections)
    b.data.rtnprd = '082026'
    await expect(gstr2bJsonToExcel([Buffer.from(JSON.stringify(a)), Buffer.from(JSON.stringify(b))], ['a.json', 'b.json'])).rejects.toThrow(/Upload the parts of one GSTR-2B together/)
  })

  it('flags an intra-state invoice carrying IGST and a tax that does not match the rate', async () => {
    const j = JSON.parse(fx('gstr2b-sample.json').toString())
    const inv = j.data.docdata.b2b[0].inv[0]
    inv.items[0].igst = 16000; inv.items[0].cgst = 0; inv.items[0].sgst = 0; inv.igst = 16000; inv.cgst = 0; inv.sgst = 0
    const r = await gstr2bJsonToExcel(Buffer.from(JSON.stringify(j)))
    expect(r.issues.some((i) => /Intra-state supply/.test(i.message))).toBe(true)
    expect(r.issues.some((i) => /Tax 16000 ≠ taxable 125000 × 12%/.test(i.message))).toBe(true)
  })
})
