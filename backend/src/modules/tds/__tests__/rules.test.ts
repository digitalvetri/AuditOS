import { describe, expect, it } from 'vitest'
import {
  certificateDue, challanDue, challanStatementCertificateDue, challanStatementDue, expectedItems, fyMonths, fyOf,
  quarterEnd, returnDue, type FilingLike,
} from '../calendar.js'
import { computeTds, returnFormFor } from '../sections.js'

describe('TDS calendar (must match the TDS page — src/pages/workstation/tds/status.ts)', () => {
  it('puts challans on the 7th of next month, and March on 30 April', () => {
    expect(challanDue('2026-04')).toBe('2026-05-07')
    expect(challanDue('2026-12')).toBe('2027-01-07')
    expect(challanDue('2027-03')).toBe('2027-04-30')
  })
  it('puts returns on 31 Jul / 31 Oct / 31 Jan / 31 May', () => {
    expect(['Q1', 'Q2', 'Q3', 'Q4'].map((q) => returnDue(q as 'Q1', '2026-27'))).toEqual(['2026-07-31', '2026-10-31', '2027-01-31', '2027-05-31'])
    expect(quarterEnd('Q4', '2026-27')).toBe('2027-03-31')
  })
  it('puts Form 16A 15 days after the return, Form 16 on 15 June', () => {
    expect(certificateDue('Q1', '2026-27')).toBe('2026-08-15')
    expect(certificateDue('FY', '2026-27')).toBe('2027-06-15')
  })
  it('gives 26QB/QC/QD 30 days after the month and the certificate 15 days after that', () => {
    expect(challanStatementDue('2026-08')).toBe('2026-09-30')
    expect(challanStatementCertificateDue('2026-08')).toBe('2026-10-15')
  })
  it('knows the FY of a date and its months', () => {
    expect(fyOf('2026-04-01')).toBe('2026-27')
    expect(fyOf('2027-03-31')).toBe('2026-27')
    expect(fyMonths('2026-27')[0]).toBe('2026-04')
    expect(fyMonths('2026-27')[11]).toBe('2027-03')
  })
  it('expects only ended periods, and marks overdue / due / done', () => {
    const recs: FilingLike[] = [{ kind: 'challan', fy: '2026-27', period: '2026-04', formType: null, status: 'done', eventDate: '2026-05-07' }]
    const items = expectedItems(recs, '2026-27', ['26Q'], '2026-08-05')
    const challans = items.filter((i) => i.kind === 'challan')
    expect(challans.map((i) => [i.period, i.state])).toEqual([
      ['2026-04', 'done'], ['2026-05', 'overdue'], ['2026-06', 'overdue'], ['2026-07', 'due'],
    ])
    expect(items.filter((i) => i.kind === 'return').map((i) => [i.period, i.state])).toEqual([['Q1', 'overdue']])
  })
})

describe('TDS calculator', () => {
  const base = { hasPan: true, priorFyTotal: 0, declaration: false, lowerCertificate: null } as const
  it('applies the 194C rate by deductee type', () => {
    expect(computeTds({ ...base, section: '194C', category: 'individual_huf', amount: 50_000 })).toMatchObject({ tds: 500, rate: 1, basis: 'normal' })
    expect(computeTds({ ...base, section: '194C', category: 'other', amount: 50_000 })).toMatchObject({ tds: 1000, rate: 2 })
  })
  it('respects 194C thresholds: ₹30,000 single and ₹1,00,000 in the year', () => {
    expect(computeTds({ ...base, section: '194C', category: 'other', amount: 25_000 }).basis).toBe('below_threshold')
    expect(computeTds({ ...base, section: '194C', category: 'other', amount: 25_000, priorFyTotal: 80_000 })).toMatchObject({ tds: 500, basis: 'normal' })
  })
  it('uses the monthly rent threshold for 194I', () => {
    expect(computeTds({ ...base, section: '194I(b)', category: 'other', amount: 50_000 }).tds).toBe(0)
    expect(computeTds({ ...base, section: '194I(b)', category: 'other', amount: 60_000 }).tds).toBe(6000)
  })
  it('charges the higher no-PAN rate (s. 206AA)', () => {
    expect(computeTds({ ...base, hasPan: false, section: '194J(b)', category: 'other', amount: 1_00_000 })).toMatchObject({ tds: 20_000, rate: 20, basis: 'no_pan' })
    expect(computeTds({ ...base, hasPan: false, section: '194Q', category: 'other', amount: 60_00_000, priorFyTotal: 0 })).toMatchObject({ rate: 5, tds: 50_000 })
  })
  it('honours a 15G / 15H only where the section allows it', () => {
    expect(computeTds({ ...base, declaration: true, section: '194A', category: 'individual_huf', amount: 40_000 })).toMatchObject({ tds: 0, basis: 'declaration' })
    expect(computeTds({ ...base, declaration: true, section: '194J(b)', category: 'individual_huf', amount: 80_000 }).basis).toBe('normal')
  })
  it('applies a lower-deduction certificate up to its limit', () => {
    const r = computeTds({ ...base, section: '194J(b)', category: 'other', amount: 1_00_000, lowerCertificate: { rate: 2, remainingLimit: 60_000 } })
    expect(r).toMatchObject({ basis: 'lower_certificate', tds: 1200 + 4000 })
  })
  it('taxes only the part of 194Q purchases above ₹50 lakh', () => {
    expect(computeTds({ ...base, section: '194Q', category: 'other', amount: 20_00_000, priorFyTotal: 40_00_000 }).tds).toBe(1000)
  })
  it('leaves salary and non-resident payments to the firm', () => {
    expect(computeTds({ ...base, section: '192', category: 'individual_huf', amount: 1_00_000 })).toMatchObject({ tds: null, basis: 'manual' })
    expect(returnFormFor('194C', 'non_resident')).toBe('27Q')
    expect(returnFormFor('192', 'resident')).toBe('24Q')
  })
})
