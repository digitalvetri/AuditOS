import { describe, expect, it } from 'vitest'
import { computeTds, sectionByCode } from '../sections.js'
import { panCategoryMismatch } from '../deductions.js'

const base = { hasPan: true, priorFyTotal: 0, declaration: false, lowerCertificate: null } as const

describe('aggregate-threshold catch-up, every section with an annual limit', () => {
  it('194J(b) ₹30,000 then ₹30,000 → [0, 6,000]: the year crossed ₹50,000, TDS on ₹60,000 at 10%', () => {
    expect(computeTds({ ...base, section: '194J(b)', category: 'individual_huf', amount: 30_000 }).tds).toBe(0)
    const r = computeTds({ ...base, section: '194J(b)', category: 'individual_huf', amount: 30_000, priorFyTotal: 30_000, priorUntaxedFyTotal: 30_000 })
    expect(r.tds).toBe(6_000)
    expect(r.note).toContain('30,000')
  })

  it('194H ₹15,000 + ₹10,000 → [0, 500]: 2% on ₹25,000 once past ₹20,000', () => {
    expect(computeTds({ ...base, section: '194H', category: 'other', amount: 10_000, priorFyTotal: 15_000, priorUntaxedFyTotal: 15_000 }).tds).toBe(500)
  })

  it('194A ₹8,000 + ₹4,000 → 10% on ₹12,000 = ₹1,200; 194D individual ₹15,000 + ₹6,000 → 2% on ₹21,000 = ₹420', () => {
    expect(computeTds({ ...base, section: '194A', category: 'individual_huf', amount: 4_000, priorFyTotal: 8_000, priorUntaxedFyTotal: 8_000 }).tds).toBe(1_200)
    expect(computeTds({ ...base, section: '194D', category: 'individual_huf', amount: 6_000, priorFyTotal: 15_000, priorUntaxedFyTotal: 15_000 }).tds).toBe(420)
  })

  it('no catch-up once the year was already past the limit; 194Q still taxes only the excess over ₹50 lakh', () => {
    expect(computeTds({ ...base, section: '194J(b)', category: 'other', amount: 10_000, priorFyTotal: 60_000, priorUntaxedFyTotal: 0 }).tds).toBe(1_000)
    expect(computeTds({ ...base, section: '194Q', category: 'other', amount: 20_00_000, priorFyTotal: 40_00_000, priorUntaxedFyTotal: 40_00_000 }).tds).toBe(1_000)
  })
})

describe('194T — payments by a firm to its partners', () => {
  it('10% once the year passes ₹20,000: ₹15,000 then ₹10,000 → [0, 2,500]', () => {
    expect(sectionByCode('194T')).toMatchObject({ rateIndividual: 10, rateOther: 10, annualThreshold: 20_000, returnForm: '26Q' })
    expect(computeTds({ ...base, section: '194T', category: 'individual_huf', amount: 15_000 }).tds).toBe(0)
    expect(computeTds({ ...base, section: '194T', category: 'individual_huf', amount: 10_000, priorFyTotal: 15_000, priorUntaxedFyTotal: 15_000 }).tds).toBe(2_500)
  })
})

describe('194-I rent over several months', () => {
  it('₹1,20,000 for a quarter is ₹40,000 a month — within ₹50,000, no TDS; ₹1,80,000 a quarter → 10% = ₹18,000', () => {
    expect(computeTds({ ...base, section: '194I(b)', category: 'other', amount: 1_20_000, months: 3 }).tds).toBe(0)
    expect(computeTds({ ...base, section: '194I(b)', category: 'other', amount: 1_80_000, months: 3 }).tds).toBe(18_000)
    // Without a period it is one month's rent, as before.
    expect(computeTds({ ...base, section: '194I(b)', category: 'other', amount: 1_20_000 }).tds).toBe(12_000)
    // 194-IB: ₹6,00,000 for a year is ₹50,000 a month — not above the limit.
    expect(computeTds({ ...base, section: '194IB', category: 'individual_huf', amount: 6_00_000, months: 12 }).tds).toBe(0)
  })
})

describe('PAN 4th character vs the deductee category', () => {
  it('a company (C) or firm (F) PAN cannot be Individual/HUF; P and H can', () => {
    expect(panCategoryMismatch('AAACS7777Q', 'individual_huf')).toMatch(/company/i)
    expect(panCategoryMismatch('AAAFS7777Q', 'individual_huf')).toMatch(/firm/i)
    expect(panCategoryMismatch('ABCPS1234K', 'individual_huf')).toBeNull()
    expect(panCategoryMismatch('ABCHS1234K', 'individual_huf')).toBeNull()
    expect(panCategoryMismatch('AAACS7777Q', 'other')).toBeNull()
    expect(panCategoryMismatch(null, 'individual_huf')).toBeNull()
  })
})
