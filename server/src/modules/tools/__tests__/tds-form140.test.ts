import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { ComplianceService, type TdsStatementOptions } from '../services/tools/ComplianceService.js'
import { resolveSection } from '../services/tools/tds-form140.js'

/**
 * Form 140 (formerly 26Q), spec v1.1 for Tax Year 2026-27 onwards — the
 * layout the FVU 1.2 reads. Field numbers below are the spec's "Sr. No.";
 * a record's field N is `split('^')[N - 1]`.
 */

const HEAD = ['Deductee PAN', 'Deductee Name', 'Section', 'Payment Date', 'Amount Paid', 'TDS Rate', 'TDS Amount', 'BSR Code', 'Challan No', 'Challan Date']

async function sheet(rows: unknown[][], head = HEAD): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Deductees')
  ws.addRow(head)
  rows.forEach((r) => ws.addRow(r))
  return Buffer.from(await wb.xlsx.writeBuffer())
}

const DEDUCTOR: TdsStatementOptions = {
  quarter: 'Q1', fy: '2026-27', tan: 'CHEA12345B', pan: 'AABCK1234M', name: 'Kaveri Traders Pvt Ltd', type: 'K',
  address: ['No 12, 2nd Floor', '', 'Anna Salai', 'Teynampet', 'Chennai'], state: 'Tamil Nadu', pincode: '600018',
  email: 'accounts@kaveri.example', phone: '98765 43210',
  rpName: 'Ravi Kumar', rpDesignation: 'Director', rpPan: 'ABCPK1234L',
  rpAddress: ['No 12, 2nd Floor'], rpState: '29', rpPincode: '600018', rpEmail: 'ravi@kaveri.example', rpPhone: '+919876543210',
}

const ROWS = [
  ['AAAPA1111A', 'Sample Consultant', '194J', '10/04/2026', 50000, 10, 5000, '0510308', '12345', '07/05/2026'],
  ['BBBPB2222B', 'Demo Contractor', '194C', '22/05/2026', 80000, 1, 800, '0510308', '23456', '07/06/2026'],
  ['CCCPC3333C', 'Example Agent', '194H', '15/07/2026', 30000, 2, 600, '0510308', '34567', '07/08/2026'],
  ['DDDCD4444D', 'Test Consultant', '1027', '19/06/2026', 60000, 10, 6000, '0510308', '23456', '07/06/2026'],
]

const records = (b: Buffer) => b.toString('ascii').split('\r\n').filter(Boolean).map((l) => l.split('^'))

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-27T06:00:00Z')) })
afterAll(() => { vi.useRealTimers() })

describe('Form 140 text file', () => {
  it('writes FH, BH, CD, DD with the spec field counts and CRLF endings', async () => {
    const r = await ComplianceService.tdsTextFile(await sheet(ROWS), DEDUCTOR)
    const text = r.bytes.toString('ascii')
    expect(text.endsWith('\r\n')).toBe(true)
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)

    const recs = records(r.bytes)
    expect(recs.map((f) => f[1])).toEqual(['FH', 'BH', 'CD', 'DD', 'CD', 'DD', 'DD'])
    const count = { FH: 18, BH: 72, CD: 30, DD: 45 } as Record<string, number>
    recs.forEach((f, i) => {
      expect(f.length).toBe(count[f[1]])
      expect(f[0]).toBe(String(i + 1)) // running line number
    })
  })

  it('fills the file and batch headers per the spec', async () => {
    const [fh, bh] = records((await ComplianceService.tdsTextFile(await sheet(ROWS), DEDUCTOR)).bytes)
    expect(fh.slice(1, 9)).toEqual(['FH', 'NS1', 'R', '27092026', '1', 'D', 'CHEA12345B', '1'])
    expect(fh.slice(10).every((v) => v === '')).toBe(true)

    expect(bh[4]).toBe('140')            // 5 form number
    expect(bh[3]).toBe('2')              // 4 challan count
    expect(bh[12]).toBe('CHEA12345B')    // 13 TAN
    expect(bh[14]).toBe('AABCK1234M')    // 15 deductor PAN
    expect(bh[15]).toBe('202728')        // 16 assessment year
    expect(bh[16]).toBe('202627')        // 17 tax year
    expect(bh[17]).toBe('Q1')            // 18 period
    expect(bh[25]).toBe('29')            // 26 state code, from the name
    expect(bh[29]).toBe('9876543210')    // 30 contact number
    expect(bh[31]).toBe('K')             // 32 deductor type
    expect(bh[44]).toBe('9876543210')    // 45 RP contact, country code stripped
    expect(bh[46]).toBe('11800.00')      // 47 batch total = sum of CD field 12
    expect(bh[51]).toBe('N')             // 52 filed earlier
    expect(bh[58]).toBe('ABCPK1234L')    // 59 RP PAN
  })

  it('groups deductees under their challan and formats amounts, dates and rates', async () => {
    const recs = records((await ComplianceService.tdsTextFile(await sheet(ROWS), DEDUCTOR)).bytes)
    const cd2 = recs[4]
    expect(cd2.slice(2, 6)).toEqual(['1', '2', '2', 'N'])            // batch, challan no, deductee count, not nil
    expect(cd2.slice(7, 12)).toEqual(['6800.00', '0.00', '0.00', '0.00', '6800.00'])
    expect([cd2[12], cd2[14], cd2[16], cd2[18]]).toEqual(['C', '0510308', '23456', '07062026'])
    expect([cd2[20], cd2[21], cd2[22]]).toEqual(['6800.00', '6800.00', '200'])

    const dd = recs[3]
    expect(dd.slice(2, 6)).toEqual(['1', '1', '1', 'O'])             // batch, deductee no, challan ref, mode
    expect([dd[7], dd[8], dd[14]]).toEqual(['AAAPA1111A', 'Sample Consultant', '1027'])
    expect([dd[17], dd[18], dd[19]]).toEqual(['Y', '10042026', '50000.00'])
    expect([dd[23], dd[24], dd[26], dd[27]]).toEqual(['5000.00', '5000.00', '10042026', '10.0000'])
  })

  it('skips a row paid outside the quarter, and says so', async () => {
    const r = await ComplianceService.tdsTextFile(await sheet(ROWS), DEDUCTOR)
    expect(r.deductees).toBe(3)
    expect(r.skipped).toBe(1)
    expect(r.warning).toMatch(/row 4 \(date of payment 15\/07\/2026 is outside Q1/)
  })

  it('rounds a challan up to whole rupees when deductee TDS has paise', async () => {
    const r = await ComplianceService.tdsTextFile(await sheet([
      ['AAAPA1111A', 'A', '1027', '10/04/2026', 1005, 10, 100.5, '0510308', '1', '07/05/2026'],
    ]), DEDUCTOR)
    const cd = records(r.bytes)[2]
    expect([cd[7], cd[11], cd[20]]).toEqual(['101.00', '101.00', '100.50'])
  })

  it('requires the challan columns up front', async () => {
    await expect(ComplianceService.tdsTextFile(
      await sheet([ROWS[0].slice(0, 7)], HEAD.slice(0, 7)), DEDUCTOR,
    )).rejects.toThrow(/missing required columns: BSR Code, Challan No, Challan Date/)
  })

  it('refuses tax years before 2026-27 and lists every missing deductor field', async () => {
    await expect(ComplianceService.tdsTextFile(await sheet(ROWS), { ...DEDUCTOR, fy: '2025-26' }))
      .rejects.toThrow(/Form 140 starts with tax year 2026-27/)
    await expect(ComplianceService.tdsTextFile(await sheet(ROWS), { ...DEDUCTOR, email: 'nope', rpPan: '' }))
      .rejects.toThrow(/Deductor email.*PAN of the person responsible/)
  })

  it('skips rows the FVU would reject', async () => {
    const r = await ComplianceService.tdsTextFile(await sheet([
      ROWS[0],
      ['AAAPA1111A', 'No reason', '1027', '10/04/2026', 5000, 0, 0, '0510308', '1', '07/05/2026'],
      ['AAAPA1111A', 'Bad BSR', '1027', '10/04/2026', 5000, 10, 500, '51030', '1', '07/05/2026'],
      ['AAAPA1111A', 'Ambiguous', '194J', '10/04/2026', 5000, 5, 250, '0510308', '1', '07/05/2026'],
      ['PANNOTAVBL', 'In kind', '1034', '10/04/2026', 5000, 0, 0, '0510308', '1', '07/05/2026'],
    ]), DEDUCTOR)
    expect(r.deductees).toBe(1)
    expect(r.skipped).toBe(4)
    expect(r.warning).toMatch(/no reason code/)
    expect(r.warning).toMatch(/BSR code "51030" must be 7 digits/)
    expect(r.warning).toMatch(/194J is 1026/)
  })
})

describe('resolveSection', () => {
  it('takes Form 140 codes and maps old sections where the sheet decides it', () => {
    expect(resolveSection('1027', 'AAAPA1111A', null)).toEqual({ code: '1027' })
    expect(resolveSection('194H', 'AAAPA1111A', 5)).toEqual({ code: '1006' })
    expect(resolveSection('194C', 'AAAPA1111A', 1)).toEqual({ code: '1023' })  // individual
    expect(resolveSection('194C', 'AAACA1111A', 2)).toEqual({ code: '1024' })  // company
    expect(resolveSection('194J', 'AAAPA1111A', 2)).toEqual({ code: '1026' })
    expect(resolveSection('194-I', 'AAAPA1111A', 10)).toEqual({ code: '1009' })
    expect(resolveSection('1099', 'AAAPA1111A', null)).toHaveProperty('problem')
    expect(resolveSection('194IA', 'AAAPA1111A', 1)).toHaveProperty('problem')
  })
})
