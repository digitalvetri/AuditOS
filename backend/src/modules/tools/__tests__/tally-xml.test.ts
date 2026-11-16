import { describe, expect, it } from 'vitest'
import { ComplianceService } from '../services/tools/ComplianceService.js'
import { fixture, workbook } from './compliance-helpers.js'

/**
 * Excel to Tally XML. Tally's import convention (as in Tally's own
 * integration samples and the app's tally-export module): a debit line is
 * ISDEEMEDPOSITIVE=Yes with a NEGATIVE amount, a credit line No with a
 * positive amount.
 */
type Side = 'Dr' | 'Cr'
function vouchers(xml: string): Map<string, { ledger: string; side: Side; amount: number }[]> {
  const out = new Map<string, { ledger: string; side: Side; amount: number }[]>()
  for (const m of xml.matchAll(/<VOUCHER [\s\S]*?<\/VOUCHER>/g)) {
    const v = m[0]
    const no = v.match(/<VOUCHERNUMBER>(.*?)<\/VOUCHERNUMBER>/)?.[1] ?? ''
    const entries = [...v.matchAll(/<LEDGERNAME>(.*?)<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>(Yes|No)<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)]
      .map((e) => {
        const amount = Number(e[3])
        // Yes + negative = debit; the two must agree.
        expect(e[2] === 'Yes').toBe(amount < 0)
        return { ledger: e[1].replace(/&amp;/g, '&'), side: (amount < 0 ? 'Dr' : 'Cr') as Side, amount: Math.abs(amount) }
      })
    out.set(no, entries)
  }
  return out
}

describe('Excel to Tally XML', () => {
  it('Receipt debits the bank and credits the party; Payment debits the party and credits the bank', async () => {
    const r = await ComplianceService.excelToTallyXml(await fixture('tally-vouchers.xlsx'))
    const v = vouchers(r.bytes.toString('utf8'))
    expect(v.get('R/001')).toEqual([
      { ledger: 'Sharma Traders', side: 'Cr', amount: 147500 },
      { ledger: 'HDFC Bank', side: 'Dr', amount: 147500 },
    ])
    expect(v.get('PY/001')).toEqual([
      { ledger: 'Lakshmi Textiles Pvt Ltd', side: 'Dr', amount: 56876.59 },
      { ledger: 'HDFC Bank', side: 'Cr', amount: 56876.59 },
    ])
    expect(v.get('KT/001')).toEqual([
      { ledger: 'Sharma Traders', side: 'Dr', amount: 147500 },
      { ledger: 'Sales @18%', side: 'Cr', amount: 147500 },
    ])
    expect(v.get('P/001')?.[0]).toEqual({ ledger: 'Lakshmi Textiles Pvt Ltd', side: 'Cr', amount: 56876.59 })
    expect(v.get('KT/002')?.[0]).toEqual({ ledger: 'Murugan & Co', side: 'Dr', amount: 123456.78 })
  })

  it('rejects a Receipt with no bank/cash ledger instead of posting it to Sales, with the real sheet row', async () => {
    const r = await ComplianceService.excelToTallyXml(await fixture('tally-vouchers.xlsx'))
    const xml = r.bytes.toString('utf8')
    expect(xml).not.toContain('R/002')
    expect(xml).not.toMatch(/<LEDGERNAME>Sales<\/LEDGERNAME>/)
    expect(r.skipped).toBe(2)
    // The sheet opens with a title row, so the data rows are Excel rows 4–11.
    expect(r.warning).toMatch(/row 8 \(Receipt needs the Bank or Cash ledger/)
    expect(r.warning).toMatch(/row 11 \(unreadable date/)
  })

  it('credit and debit notes, and a Contra that says which side the party is on', async () => {
    const xlsx = await workbook(
      ['Date', 'Voucher Type', 'Voucher No', 'Party Ledger', 'Ledger Name', 'Amount', 'Dr/Cr'],
      [
        ['12/04/2026', 'Credit Note', 'CN/001', 'Sharma Traders', 'Sales Returns', 11800, ''],
        ['13/04/2026', 'Debit Note', 'DN/001', 'Lakshmi Textiles Pvt Ltd', 'Purchase Returns', 5900, ''],
        ['14/04/2026', 'Contra', 'C/001', 'HDFC Bank', 'Cash', 50000, 'Dr'],
        ['15/04/2026', 'Contra', 'C/002', 'HDFC Bank', 'Cash', 20000, ''],
        ['16/04/2026', 'Payment', 'PY/002', 'Ravi Kumar', '', 5000, ''],
      ],
    )
    const r = await ComplianceService.excelToTallyXml(xlsx)
    const v = vouchers(r.bytes.toString('utf8'))
    expect(v.get('CN/001')?.map((e) => e.side)).toEqual(['Cr', 'Dr'])
    expect(v.get('DN/001')?.map((e) => e.side)).toEqual(['Dr', 'Cr'])
    expect(v.get('C/001')).toEqual([
      { ledger: 'HDFC Bank', side: 'Dr', amount: 50000 },
      { ledger: 'Cash', side: 'Cr', amount: 50000 },
    ])
    expect(v.has('C/002')).toBe(false)
    expect(v.has('PY/002')).toBe(false)
    expect(r.warning).toMatch(/row 5 \(Contra needs a Dr\/Cr/)
    expect(r.warning).toMatch(/row 6 \(Payment needs the Bank or Cash ledger/)
  })
})
