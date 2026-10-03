import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { form26asToExcel, parseAmount26, parseDate26, REASONS } from '../services/tools/form26as.js'

/** Form 26AS → Excel: the cases from the fix brief. */
const fx = (name: string) => ({ name, bytes: readFileSync(path.join(__dirname, 'fixtures', name)) })

describe('Form 26AS to Excel', () => {
  it('reads the TRACES text sample: 8 transactions, 5 deductors, all three amounts, empty Skipped', async () => {
    const r = await form26asToExcel([fx('form26as-traces-sample.txt')])
    expect(r.transactions).toBe(8)
    expect(r.deductors).toBe(5)
    expect(r.totals).toEqual({ paid: 2200000, tax: 54200, dep: 54200 })
    expect(r.skipped).toEqual([]) // the taxpayer header line is not a skipped row
    expect(r.checks.every((c) => c.ok)).toBe(true)

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(r.bytes as unknown as ArrayBuffer)
    const tx = wb.getWorksheet('Transactions')!
    expect((tx.getRow(1).values as string[]).slice(1)).toEqual([
      'Deductor', 'TAN', 'Section', 'Transaction Date', 'Status of Booking', 'Date of Booking', 'Remarks', 'Amount Paid', 'Tax Deducted', 'TDS Deposited',
    ])
    const first = tx.getRow(2)
    expect(first.getCell(2).value).toBe('CHEA12345B')
    expect(tx.getColumn(2).numFmt).toBe('@')
    expect(first.getCell(4).value).toBeInstanceOf(Date) // a real Excel date
    expect(first.getCell(7).value).toBe('') // "-" remark is empty
    expect([first.getCell(8).value, first.getCell(9).value, first.getCell(10).value]).toEqual([220000, 4400, 4400])
    const totals = wb.getWorksheet('Deductor Totals')!
    expect(String((totals.getRow(2).getCell(4).value as { formula: string }).formula)).toMatch(/^SUMIFS\(Transactions!/)
    expect(wb.getWorksheet('Skipped')!.rowCount).toBe(1)
  })

  it('rejects an .xlsx as "Not a TRACES text export or PDF"', async () => {
    await expect(form26asToExcel([fx('invoice.xlsx')])).rejects.toThrow(REASONS.notTraces)
  })

  it('rejects a password PDF as "PDF is password protected"', async () => {
    await expect(form26asToExcel([fx('locked-aes128.pdf')])).rejects.toThrow(REASONS.password)
  })

  it('converts the readable files and reports the one that is not', async () => {
    const r = await form26asToExcel([fx('form26as-traces-sample.txt'), fx('invoice.xlsx')])
    expect(r.transactions).toBe(8)
    expect(r.files).toEqual([
      { file: 'form26as-traces-sample.txt', ok: true, reason: null, transactions: 8 },
      { file: 'invoice.xlsx', ok: false, reason: REASONS.notTraces, transactions: 0 },
    ])
  })

  it('gives row-level reasons for broken Part A lines, and flags totals that no longer add up', async () => {
    const text = readFileSync(path.join(__dirname, 'fixtures', 'form26as-traces-sample.txt'), 'utf8')
      .replace('^1^194C^08-Apr-2026^', '^1^194C^2026/04/08^')
      .replace('^310000.00^6200.00^', '^31O000.00^6200.00^')
    const r = await form26asToExcel([{ name: 'broken.txt', bytes: Buffer.from(text) }])
    expect(r.skipped.map((s) => s.reason)).toEqual([
      'Row 8: unknown date format "2026/04/08"',
      'Row 9: amount is not a number "31O000.00"',
    ])
    expect(r.checks.some((c) => !c.ok)).toBe(true)
  })

  it('needs Part A, and parses both date formats and comma amounts', async () => {
    await expect(form26asToExcel([{ name: 'x.txt', bytes: Buffer.from('a^b^c\n1^2^3\n') }])).rejects.toThrow(REASONS.noPartA)
    expect(parseDate26('08-Apr-2026')?.toISOString().slice(0, 10)).toBe('2026-04-08')
    expect(parseDate26('08-04-2026')?.toISOString().slice(0, 10)).toBe('2026-04-08')
    expect(parseDate26('31-02-2026')).toBeNull()
    expect(parseAmount26('2,20,000.00')).toBe(220000)
  })
})
