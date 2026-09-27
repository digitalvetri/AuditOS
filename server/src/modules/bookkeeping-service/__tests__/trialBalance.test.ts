import { describe, expect, it } from 'vitest'
import { parseAmount, parseTrialBalanceCsv } from '../parsers/trialBalance.js'

describe('bookkeeping/parsers/trialBalance — parseAmount', () => {
  it('normalises plain integers to paise', () => {
    expect(parseAmount('150000')).toBe(15_000_000n)
  })
  it('normalises decimals to paise, half-away-from-zero on the third digit', () => {
    expect(parseAmount('150000.50')).toBe(15_000_050n)
    expect(parseAmount('0.005')).toBe(1n)
    expect(parseAmount('0.004')).toBe(0n)
    expect(parseAmount('-0.005')).toBe(-1n)
  })
  it('handles Indian comma formatting and currency symbols', () => {
    expect(parseAmount('1,50,000.50')).toBe(15_000_050n)
    expect(parseAmount('₹1,50,000')).toBe(15_000_000n)
    expect(parseAmount('  1 50 000 ')).toBe(15_000_000n)
  })
  it('treats empty, dash and em-dash as zero', () => {
    expect(parseAmount('')).toBe(0n)
    expect(parseAmount('  ')).toBe(0n)
    expect(parseAmount('—')).toBe(0n)
    expect(parseAmount('–')).toBe(0n)
    expect(parseAmount('-')).toBe(0n)
    expect(parseAmount(null)).toBe(0n)
  })
  it('preserves sign for credit balances', () => {
    expect(parseAmount('-1,50,000.50')).toBe(-15_000_050n)
  })
  it('rejects garbage input rather than silently zeroing', () => {
    expect(() => parseAmount('abc')).toThrow()
    expect(() => parseAmount('12abc')).toThrow()
  })
})

describe('bookkeeping/parsers/trialBalance — parseTrialBalanceCsv', () => {
  it('parses a minimal file with the canonical column names', () => {
    const csv = [
      'Ledger Name,Parent Group,Opening,Debit,Credit,Closing',
      'Kotak Bank A/c,Bank Accounts,150000,50000,20000,180000',
      'Cash on Hand,Cash-in-Hand,25000,5000,0,30000',
    ].join('\n')
    const out = parseTrialBalanceCsv(csv)
    expect(out.rowCount).toBe(2)
    expect(out.rows[0]).toMatchObject({
      ledgerName: 'Kotak Bank A/c',
      parentGroup: 'Bank Accounts',
      openingPaise: 15_000_000n,
      debitPaise: 5_000_000n,
      creditPaise: 2_000_000n,
      closingPaise: 18_000_000n,
    })
  })

  it('accepts header spellings tolerantly (case, spacing, aliases)', () => {
    const csv = [
      'particulars,Under,Op Balance,Debit,Credit,Balance',
      'Sales A/c,Sales Accounts,0,0,1500000,-1500000',
    ].join('\n')
    const out = parseTrialBalanceCsv(csv)
    expect(out.rows[0].parentGroup).toBe('Sales Accounts')
    expect(out.rows[0].closingPaise).toBe(-150_000_000n)
  })

  it('skips totals and blank rows so the file\'s own totals do not double-count', () => {
    const csv = [
      'Ledger Name,Parent Group,Closing',
      'Kotak Bank A/c,Bank Accounts,100000',
      '',
      'Total:,,100000',
      'Grand Total,,100000',
    ].join('\n')
    const out = parseTrialBalanceCsv(csv)
    expect(out.rowCount).toBe(1)
    expect(out.rows[0].ledgerName).toBe('Kotak Bank A/c')
  })

  it('rejects a file missing a required column', () => {
    expect(() => parseTrialBalanceCsv('Ledger,Opening\nX,1')).toThrow(/Parent Group/)
    expect(() => parseTrialBalanceCsv('Parent Group,Opening\nX,1')).toThrow(/Ledger Name/)
    expect(() => parseTrialBalanceCsv('Ledger Name,Parent Group\nX,Y')).toThrow(/Opening|Debit|Credit|Closing/)
  })

  it('supports quoted fields that contain a comma', () => {
    const csv = [
      'Ledger Name,Parent Group,Closing',
      '"Sundry, Ltd","Sundry Creditors","1,50,000"',
    ].join('\n')
    const out = parseTrialBalanceCsv(csv)
    expect(out.rows[0].ledgerName).toBe('Sundry, Ltd')
    expect(out.rows[0].closingPaise).toBe(15_000_000n)
  })
})
