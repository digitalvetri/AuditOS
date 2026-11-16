import { describe, expect, it } from 'vitest'
import {
  certificateDue, challanDue, challanStatementCertificateDue, challanStatementDue, expectedItems, fyMonths, fyOf,
  formForFy, quarterEnd, returnDue, type FilingLike,
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
  it('194C: crossing ₹1,00,000 in the year catches up TDS on the earlier untaxed payments', () => {
    // 25k, 25k, 25k: each within ₹30,000 and the year within ₹1,00,000 → nothing.
    expect(computeTds({ ...base, section: '194C', category: 'other', amount: 25_000, priorFyTotal: 50_000, priorUntaxedFyTotal: 50_000 }).tds).toBe(0)
    // 30k (single limit not crossed) takes the year to ₹1,05,000 → TDS on the whole ₹1,05,000.
    const crossing = computeTds({ ...base, section: '194C', category: 'other', amount: 30_000, priorFyTotal: 75_000, priorUntaxedFyTotal: 75_000 })
    expect(crossing).toMatchObject({ tds: 2_100, rate: 2, basis: 'normal' })
    expect(crossing.note).toMatch(/75,000/)
    // Only payments that escaped TDS are caught up (a 40k payment was taxed when made).
    expect(computeTds({ ...base, section: '194C', category: 'individual_huf', amount: 20_000, priorFyTotal: 90_000, priorUntaxedFyTotal: 50_000 }).tds).toBe(700)
    // Once the year is over the limit, later payments carry no catch-up.
    expect(computeTds({ ...base, section: '194C', category: 'other', amount: 10_000, priorFyTotal: 1_05_000, priorUntaxedFyTotal: 75_000 }).tds).toBe(200)
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

describe('TDS fixes (threshold boundaries, s. 206AA, TCS dates)', () => {
  const base = { hasPan: true, priorFyTotal: 0, declaration: false, lowerCertificate: null, category: 'other' } as const
  it('does not deduct at exactly the "exceeds" limit, but 194IA taxes ₹50 lakh itself', () => {
    expect(computeTds({ ...base, section: '194C', amount: 30_000 }).tds).toBe(0)
    expect(computeTds({ ...base, section: '194C', amount: 30_001 }).tds).toBe(600)
    expect(computeTds({ ...base, section: '194B', amount: 10_000 }).tds).toBe(0)
    expect(computeTds({ ...base, section: '194IA', amount: 50_00_000 }).tds).toBe(50_000)
  })
  it('uses the higher of the section rate and 20% when there is no PAN', () => {
    expect(computeTds({ ...base, section: '194B', amount: 50_000, hasPan: false })).toMatchObject({ rate: 30, tds: 15_000 })
    expect(computeTds({ ...base, section: '194C', amount: 50_000, hasPan: false })).toMatchObject({ rate: 20 })
  })
  it('up to FY 2025-26: 27EQ on the 15th and Form 27D 15 days after it', () => {
    expect(['Q1', 'Q2', 'Q3', 'Q4'].map((q) => returnDue(q as 'Q1', '2025-26', '27EQ'))).toEqual(['2025-07-15', '2025-10-15', '2026-01-15', '2026-05-15'])
    expect(certificateDue('Q1', '2025-26', '27D')).toBe('2025-07-30')
    expect(returnDue('Q1', '2025-26', '26Q')).toBe('2025-07-31')
  })
  it('tax year 2026-27 on (Income-tax Rules 2026, rule 219): Form 143 (TCS) on the same 31st dates as TDS; Form 133 15 days later', () => {
    for (const f of ['143', '27EQ']) {
      expect(['Q1', 'Q2', 'Q3', 'Q4'].map((q) => returnDue(q as 'Q1', '2026-27', f))).toEqual(['2026-07-31', '2026-10-31', '2027-01-31', '2027-05-31'])
    }
    expect(certificateDue('Q1', '2026-27', '133')).toBe('2026-08-15')
    expect(certificateDue('Q1', '2026-27', '27D')).toBe('2026-08-15')
    expect(certificateDue('Q2', '2026-27', '131')).toBe('2026-11-15')
  })
  it('forms are named for the FY: 24Q/26Q/27Q/27EQ up to 2025-26, 138/140/144/143 from 2026-27', () => {
    expect(['24Q', '26Q', '27Q', '27EQ'].map((f) => formForFy(f, '2026-27'))).toEqual(['138', '140', '144', '143'])
    expect(['138', '140', '144', '143'].map((f) => formForFy(f, '2025-26'))).toEqual(['24Q', '26Q', '27Q', '27EQ'])
    expect(formForFy('26Q', '2025-26')).toBe('26Q')
  })
  it('FY 2026-27 expects Form 140 / 143 returns and Form 131 / 133 / 130 certificates — a TCS return filed on the 20th is not overdue', () => {
    const today = '2026-07-20'
    const items = expectedItems([], '2026-27', ['26Q', '27EQ'], today)
    expect(items.filter((i) => i.kind === 'return').map((i) => [i.formType, i.period, i.due, i.state])).toEqual([
      ['140', 'Q1', '2026-07-31', 'due'], ['143', 'Q1', '2026-07-31', 'due'],
    ])
    // A return recorded under the old name for the new year still counts.
    const recs: FilingLike[] = [
      { kind: 'return', fy: '2026-27', period: 'Q1', formType: '26Q', status: 'done', eventDate: '2026-07-20' },
      { kind: 'return', fy: '2026-27', period: 'Q4', formType: '138', status: 'done', eventDate: '2027-05-20' },
      { kind: 'return', fy: '2026-27', period: 'Q1', formType: '143', status: 'done', eventDate: '2026-07-20' },
    ]
    const later = expectedItems(recs, '2026-27', ['26Q', '24Q', '27EQ'], '2026-07-25')
    expect(later.filter((i) => i.kind === 'return' && i.period === 'Q1').every((i) => i.state === 'done' || i.formType === '138')).toBe(true)
    expect(later.filter((i) => i.kind === 'certificate').map((i) => [i.formType, i.period, i.due])).toEqual(expect.arrayContaining([
      ['131', 'Q1', '2026-08-15'], ['130', 'FY', '2027-06-15'], ['133', 'Q1', '2026-08-15'],
    ]))
  })
})
