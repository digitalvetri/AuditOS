import { describe, expect, it } from 'vitest'
import { ComplianceService } from '../services/tools/ComplianceService.js'
import { fixture, positionedPdf, sheetValues } from './compliance-helpers.js'

/**
 * Bank Statement to Excel. The HDFC, ICICI and SBI PDFs follow each bank's
 * printed column order; Axis and the overdraft account are drawn here.
 * Every expectation is the statement's own arithmetic: opening + credits −
 * debits = closing, row by row.
 */
const run = async (b: Buffer) => ComplianceService.bankStatementToExcel(b)

async function txns(bytes: Buffer) {
  const rows = await sheetValues(bytes, 'Transactions')
  return rows.slice(1).map((r) => ({ date: r[0], narration: String(r[1]), debit: r[3] ?? null, credit: r[4] ?? null, balance: r[5] ?? null }))
}

describe('Bank Statement to Excel', () => {
  it('HDFC with the opening balance only in the closing summary — direction from the balance column', async () => {
    const r = await run(await fixture('hdfc-statement.pdf'))
    expect(r.transactions).toBe(6)
    expect(r.opening).toBe(250000)
    expect(r.closing).toBe(308160.5)
    expect(r.totalDebit).toBe(69150.5)
    expect(r.totalCredit).toBe(127311)
    expect(r.balanced).toBe(true)
    const t = await txns(r.bytes)
    expect(t[0]).toMatchObject({ credit: 125000, debit: null, balance: 375000 })
    expect(t[1]).toMatchObject({ debit: 2500, credit: null, balance: 372500 })
    expect(t[3]).toMatchObject({ credit: 1999 })
  })

  it('HDFC with an Opening Balance line gives the same result', async () => {
    const r = await run(await fixture('hdfc-with-opening.pdf'))
    expect([r.transactions, r.opening, r.totalDebit, r.totalCredit, r.closing]).toEqual([6, 250000, 69150.5, 127311, 308160.5])
  })

  it('ICICI: serial number first, value and transaction dates, 0.00 in the empty column', async () => {
    const r = await run(await fixture('icici-statement.pdf'))
    expect(r.transactions).toBe(3)
    expect(r.opening).toBe(100000)
    expect(r.totalCredit).toBe(50000)
    expect(r.totalDebit).toBe(44800)
    const t = await txns(r.bytes)
    expect(t[0]).toMatchObject({ credit: 50000, balance: 150000 })
    expect(t[0].narration).toContain('SHARMA TRADERS')
    expect(t[0].narration).not.toMatch(/\d{2}\/\d{2}\/\d{4}/)
  })

  it('SBI: "Balance as on" opening line, and amount + balance printed tight together', async () => {
    const r = await run(await fixture('sbi-statement.pdf'))
    expect(r.transactions).toBe(3)
    expect(r.opening).toBe(80000)
    expect(r.totalCredit).toBe(20000)
    expect(r.totalDebit).toBe(11250)
    expect(r.closing).toBe(88750)
  })

  it('Axis: dd-mm-yyyy dates and a trailing branch-code column after the balance', async () => {
    const pdf = await positionedPdf([
      [[30, 'AXIS BANK LTD - Statement of Account No :917010012345678']],
      [[30, 'OPENING BALANCE : 45,000.00']],
      [[30, 'Tran Date'], [90, 'Chq No'], [150, 'Particulars'], [370, 'Debit', 50], [430, 'Credit', 50], [490, 'Balance', 50], [550, 'Init.Br']],
      [[30, '01-04-2026'], [150, 'NEFT/AXOIC12345/PONNI AGENCIES'], [430, '15,000.00', 50], [490, '60,000.00', 50], [550, '1234']],
      [[30, '03-04-2026'], [90, '000231'], [150, 'CLG/SRI VARI TRADERS & CO'], [370, '7,450.00', 50], [490, '52,550.00', 50], [550, '1234']],
      [[30, '06-04-2026'], [150, 'GST PMT/CPIN 26043300012345'], [370, '12,600.00', 50], [490, '39,950.00', 50], [550, '1234']],
    ])
    const r = await run(pdf)
    expect(r.transactions).toBe(3)
    expect(r.opening).toBe(45000)
    expect(r.totalCredit).toBe(15000)
    expect(r.totalDebit).toBe(20050)
    expect(r.closing).toBe(39950)
  })

  it('overdraft: a "Dr" balance is negative, and the first row direction comes from the amount column', async () => {
    const pdf = await positionedPdf([
      [[30, 'Date'], [90, 'Narration'], [330, 'Withdrawal', 60], [400, 'Deposit', 60], [470, 'Balance', 70]],
      [[30, '01/04/2026'], [90, 'CHQ 0042 VIJAY STEELS'], [330, '30,000.00', 60], [470, '10,000.00 Dr', 70]],
      [[30, '02/04/2026'], [90, 'CASH DEPOSIT'], [400, '25,000.00', 60], [470, '15,000.00 Cr', 70]],
      [[30, '04/04/2026'], [90, 'BANK CHARGES'], [330, '590.00', 60], [470, '14,410.00 Cr', 70]],
    ])
    const r = await run(pdf)
    expect(r.opening).toBe(20000)
    expect(r.totalDebit).toBe(30590)
    expect(r.totalCredit).toBe(25000)
    const t = await txns(r.bytes)
    expect(t[0]).toMatchObject({ debit: 30000, balance: -10000 })
    expect(r.closing).toBe(14410)
  })

  it('refuses, naming the row, when the running balance does not tie', async () => {
    const pdf = await positionedPdf([
      [[30, 'Date'], [90, 'Narration'], [330, 'Withdrawal', 60], [400, 'Deposit', 60], [470, 'Balance', 70]],
      [[30, 'Opening Balance'], [470, '1,00,000.00', 70]],
      [[30, '01/04/2026'], [90, 'NEFT CR KAVERI'], [330, '0.00', 60], [400, '10,000.00', 60], [470, '1,10,000.00', 70]],
      [[30, '02/04/2026'], [90, 'UPI DR RENT'], [330, '5,000.00', 60], [400, '0.00', 60], [470, '1,15,000.00', 70]],
    ])
    await expect(run(pdf)).rejects.toThrow(/02\/04\/2026[\s\S]*1,05,000\.00[\s\S]*1,15,000\.00/)
  })

  it('refuses a statement without a running balance column instead of guessing directions', async () => {
    const pdf = await positionedPdf([
      [[30, 'Date'], [90, 'Narration'], [400, 'Amount', 60]],
      [[30, '01/04/2026'], [90, 'NEFT KAVERI'], [400, '10,000.00', 60]],
      [[30, '02/04/2026'], [90, 'UPI RENT'], [400, '5,000.00', 60]],
    ])
    await expect(run(pdf)).rejects.toThrow(/balance/i)
  })
})
