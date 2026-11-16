import { describe, expect, it } from 'vitest'
import { ComplianceService } from '../services/tools/ComplianceService.js'
import { fixture, sheetValues } from './compliance-helpers.js'

/**
 * Form 26AS to Excel. The fixtures follow the TRACES layout: Part I rows
 * carry Amount Paid / Credited, Tax Deducted and TDS Deposited; Part VI is
 * tax COLLECTED at source and must not be counted as TDS.
 */
describe('Form 26AS to Excel', () => {
  it('text export: Part I amounts land in their own columns; Part VI TCS gets its own sheet', async () => {
    const r = await ComplianceService.form26asToExcel(await fixture('form26as.txt'), true)
    expect(r.rows).toBe(3)
    expect(r.totalCredited).toBe(170000)
    expect(r.totalTds).toBe(17000)
    expect(r.tcsRows).toBe(1)
    expect(r.totalTcs).toBe(12000)

    const tds = await sheetValues(r.bytes, 'Part I - TDS')
    const head = tds[0] as string[]
    const row = (i: number) => Object.fromEntries(head.map((h, k) => [h, tds[i][k]]))
    expect(row(1)).toMatchObject({ Deductor: 'KAVERI TRADERS PRIVATE LIMITED', TAN: 'CHEK12345B', Section: '194J', 'Amount Paid / Credited': 100000, 'Tax Deducted': 10000, 'TDS Deposited': 10000 })
    expect(tds.some((r) => r.includes('206CL'))).toBe(false)

    const by = await sheetValues(r.bytes, 'By Deductor')
    const kaveri = by.find((x) => x[1] === 'CHEK12345B')!
    expect(kaveri.slice(3)).toEqual([150000, 15000, 15000])

    const tcs = await sheetValues(r.bytes, 'Part VI - TCS')
    expect(tcs[1]).toEqual(expect.arrayContaining(['MARUTI SUZUKI DEALER PVT LTD', 'DELM12345C', '206CL', 1200000, 12000, 12000]))
  })

  it('text export: tax deducted and TDS deposited are kept apart when they differ', async () => {
    const txt = [
      'PART-I - Details of Tax Deducted at Source^',
      'Sr. No.^Name of Deductor^TAN of Deductor^^^^Total Amount Paid / Credited(Rs.)^Total Tax Deducted(Rs.)^Total TDS Deposited(Rs.)^',
      '1^SRI VARI TRADERS^CHES54321K^^^^80000.00^8000.00^6000.00^',
      '^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks^Amount Paid / Credited(Rs.)^Tax Deducted(Rs.)^TDS Deposited(Rs.)^',
      '^1^194C^10-Jan-2026^U^-^-^80000.00^8000.00^6000.00^',
    ].join('\r\n')
    const r = await ComplianceService.form26asToExcel(Buffer.from(txt), true)
    const tds = await sheetValues(r.bytes, 'Part I - TDS')
    expect(tds[1].slice(-3)).toEqual([80000, 8000, 6000])
    expect(r.totalCredited).toBe(80000)
    expect(r.totalTds).toBe(8000)
  })

  it('PDF: the three amount columns are read as paid, deducted, deposited', async () => {
    const r = await ComplianceService.form26asToExcel(await fixture('form26as.pdf'), false)
    expect(r.rows).toBe(2)
    expect(r.totalCredited).toBe(150000)
    expect(r.totalTds).toBe(15000)
    const by = await sheetValues(r.bytes, 'By Deductor')
    expect(by[1].slice(0, 2)).toEqual(['KAVERI TRADERS PRIVATE LIMITED', 'CHEK12345B'])
  })
})
