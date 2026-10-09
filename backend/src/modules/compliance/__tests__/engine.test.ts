import { describe, expect, it } from 'vitest'
import { COMPLIANCE_CATALOGUE } from '../../../../prisma/seed-compliance.js'
import {
  applyRule, dueFor, entityTypeOf, fyOfDate, fyOfPeriodKey, lateFeeEstimate, periodsOf, type FormRule,
} from '../engine.js'
import { suggestedForms } from '../service.js'

const form = (code: string): FormRule => {
  const f = COMPLIANCE_CATALOGUE.find((x) => x.code === code)
  if (!f) throw new Error(`no form ${code}`)
  return f
}
const due = (code: string, key: string, agm?: string | null) => dueFor(form(code), key, undefined, agm ?? null)?.statutory_due_date

describe('due-date engine — every seeded rule', () => {
  it.each([
    ['ITR_NON_BUSINESS', '2025-26', '2026-07-31'],
    ['ITR_NON_AUDIT_BUSINESS', '2025-26', '2026-08-31'],
    ['TAX_AUDIT_REPORT', '2025-26', '2026-09-30'],
    ['ITR_AUDIT', '2025-26', '2026-10-31'],
    ['FORM_3CEB', '2025-26', '2026-10-31'],
    ['ITR_TP', '2025-26', '2026-11-30'],
    ['SFT_61A', '2025-26', '2026-05-31'],
    ['FORM_10B', '2025-26', '2026-09-30'],
    ['GSTR9', '2025-26', '2026-12-31'],
    ['GSTR9C', '2025-26', '2026-12-31'],
    ['GSTR4', '2025-26', '2026-04-30'],
    ['AGM', '2025-26', '2026-09-30'],
    ['DIR3_KYC', '2026-27', '2026-09-30'],
    ['DPT3', '2025-26', '2026-06-30'],
    ['LLP11', '2025-26', '2026-05-30'],
    ['LLP8', '2025-26', '2026-10-30'],
  ])('%s %s → %s', (code, key, expected) => {
    expect(due(code, key)).toBe(expected)
  })

  it('ADVANCE_TAX: four instalments on the 15th of Jun, Sep, Dec, Mar', () => {
    const ps = periodsOf(form('ADVANCE_TAX'), '2026-27')
    expect(ps.map((p) => p.key)).toEqual(['2026-06', '2026-09', '2026-12', '2027-03'])
    expect(ps.map((p) => dueFor(form('ADVANCE_TAX'), p)!.statutory_due_date)).toEqual(['2026-06-15', '2026-09-15', '2026-12-15', '2027-03-15'])
  })

  it('PMT06: months 4,5,7,8,10,11,1,2 on the 25th of the next month', () => {
    const ps = periodsOf(form('PMT06'), '2026-27')
    expect(ps.map((p) => p.key)).toEqual(['2026-04', '2026-05', '2026-07', '2026-08', '2026-10', '2026-11', '2027-01', '2027-02'])
    expect(due('PMT06', '2026-04')).toBe('2026-05-25')
    expect(due('PMT06', '2027-02')).toBe('2027-03-25')
    expect(due('PMT06', '2026-06')).toBeUndefined() // a quarter-end month is not a PMT-06 period
  })

  it('CMP08: 18th of the month after each quarter', () => {
    expect(periodsOf(form('CMP08'), '2026-27').map((p) => p.key)).toEqual(['2026-27-Q1', '2026-27-Q2', '2026-27-Q3', '2026-27-Q4'])
    expect(due('CMP08', '2026-27-Q1')).toBe('2026-07-18')
    expect(due('CMP08', '2026-27-Q3')).toBe('2027-01-18')
    expect(due('CMP08', '2026-27-Q4')).toBe('2027-04-18')
  })

  it('MSME1: 31 Oct for H1, 30 Apr for H2 (clamped)', () => {
    expect(due('MSME1', '2025-26-H1')).toBe('2025-10-31')
    expect(due('MSME1', '2025-26-H2')).toBe('2026-04-30')
  })

  it('PT_TN: 30 Sep and 31 Mar', () => {
    expect(due('PT_TN', '2026-27-H1')).toBe('2026-09-30')
    expect(due('PT_TN', '2026-27-H2')).toBe('2027-03-31')
  })

  it('PF_ECR / ESI: 15th of the next month, every month', () => {
    for (const code of ['PF_ECR', 'ESI']) {
      expect(periodsOf(form(code), '2026-27')).toHaveLength(12)
      expect(due(code, '2026-04')).toBe('2026-05-15')
      expect(due(code, '2027-01')).toBe('2027-02-15')
      expect(due(code, '2027-03')).toBe('2027-04-15')
    }
  })

  it('AGM-anchored forms: from the AGM date, else 30 Sep and flagged', () => {
    expect(due('AOC4', '2025-26', '2026-09-27')).toBe('2026-10-27')
    expect(due('AOC4', '2025-26')).toBe('2026-10-30')
    expect(dueFor(form('AOC4'), '2025-26')!.anchor_missing).toBe(true)
    expect(dueFor(form('AOC4'), '2025-26', undefined, '2026-09-27')!.anchor_missing).toBe(false)
    expect(due('MGT7', '2025-26', '2026-09-27')).toBe('2026-11-26')
    expect(due('MGT7', '2025-26')).toBe('2026-11-29')
    expect(due('ADT1', '2025-26', '2026-09-27')).toBe('2026-10-12')
    expect(due('ADT1', '2025-26')).toBe('2026-10-15')
  })

  it('every catalogue form yields a due date for each of its periods', () => {
    for (const f of COMPLIANCE_CATALOGUE) {
      const ps = periodsOf(f, '2026-27')
      expect(ps.length, f.code).toBeGreaterThan(0)
      for (const p of ps) expect(dueFor(f, p)!.statutory_due_date, `${f.code} ${p.key}`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('clamps to month end and handles leap years', () => {
    expect(applyRule('2026-01-31', { offsetMonths: 1, dueDay: null, offsetDays: 0 })).toBe('2026-02-28')
    expect(applyRule('2027-12-31', { offsetMonths: 2, dueDay: 31, offsetDays: 0 })).toBe('2028-02-29')
    expect(applyRule('2026-03-31', { offsetMonths: -1, dueDay: 30, offsetDays: 2 })).toBe('2026-03-02')
    expect(applyRule('2026-09-30', { offsetMonths: 0, dueDay: null, offsetDays: 60 })).toBe('2026-11-29')
  })

  it('FY helpers', () => {
    expect(fyOfDate('2026-03-31')).toBe('2025-26')
    expect(fyOfDate('2026-04-01')).toBe('2026-27')
    expect(fyOfPeriodKey('2027-01')).toBe('2026-27')
    expect(fyOfPeriodKey('2025-26-H2')).toBe('2025-26')
    expect(() => fyOfPeriodKey('2025-27')).toThrow()
  })
})

describe('entity type from free-text business type', () => {
  it.each([
    ['Private Limited', 'company'], ['Pvt Ltd', 'company'], ['ABC Pvt. Ltd.', 'company'], ['Public Limited', 'company'],
    ['OPC', 'company'], ['One Person Company', 'company'], ['Section 8 Company', 'company'],
    ['LLP', 'llp'], ['Limited Liability Partnership', 'llp'],
    ['Partnership', 'firm'], ['Partnership Firm', 'firm'],
    ['Proprietorship', 'individual'], ['Sole Proprietor', 'individual'], ['Individual', 'individual'],
    ['HUF', 'huf'], ['Trust', 'trust'], ['Charitable Trust', 'trust'], ['Society', 'society'], ['Co-operative Society', 'society'],
    ['AOP', 'aop'], ['', 'any'], [null, 'any'], ['Something else', 'any'],
  ])('%s → %s', (text, expected) => {
    expect(entityTypeOf(text)).toBe(expected)
  })
})

describe('suggested obligations', () => {
  const forms = COMPLIANCE_CATALOGUE.map((f, i) => ({ ...f, id: f.code, sourceUrl: null, isActive: true, sortOrder: i, createdAt: new Date(), updatedAt: new Date() }))
  const codes = (s: { form_code: string }[]) => s.map((x) => x.form_code).sort()
  it('company: MCA forms, audited ITR, advance tax', () => {
    const s = codes(suggestedForms(forms, 'company', null))
    expect(s).toEqual(expect.arrayContaining(['AOC4', 'MGT7', 'ADT1', 'AGM', 'DIR3_KYC', 'DPT3', 'MSME1', 'ITR_AUDIT', 'ADVANCE_TAX']))
    expect(s).not.toContain('LLP11')
    expect(s).not.toContain('GSTR9')
  })
  it('GST link: composition → CMP08/GSTR4, QRMP → PMT06, regular → GSTR9/9C', () => {
    expect(codes(suggestedForms(forms, 'any', { registrationType: 'composition', filingFrequency: 'quarterly', active: true }))).toEqual(['CMP08', 'GSTR4'])
    expect(codes(suggestedForms(forms, 'any', { registrationType: 'regular', filingFrequency: 'quarterly', active: true }))).toEqual(['GSTR9', 'GSTR9C', 'PMT06'])
    expect(codes(suggestedForms(forms, 'any', { registrationType: 'regular', filingFrequency: 'monthly', active: true }))).toEqual(['GSTR9', 'GSTR9C'])
    expect(suggestedForms(forms, 'any', null)).toEqual([])
  })
  it('LLP gets LLP-11 / LLP-8 and the non-audit ITR', () => {
    expect(codes(suggestedForms(forms, 'llp', null))).toEqual(expect.arrayContaining(['LLP11', 'LLP8', 'ITR_NON_AUDIT_BUSINESS']))
  })
})

describe('late fee estimates', () => {
  const t = { today: '2027-01-10' }
  it('GSTR-9 ₹200/day; ROC ₹100/day; ITR ₹5,000; DIR-3 KYC ₹5,000; notes elsewhere', () => {
    expect(lateFeeEstimate(form('GSTR9'), '2026-12-31', t)).toMatchObject({ amount_paise: 200_00 * 10 })
    expect(lateFeeEstimate({ code: 'AOC4', lateFeeNote: null }, '2026-12-31', t)).toMatchObject({ amount_paise: 100_00 * 10 })
    expect(lateFeeEstimate(form('ITR_AUDIT'), '2026-10-31', t)).toMatchObject({ amount_paise: 5000_00 })
    expect(lateFeeEstimate(form('DIR3_KYC'), '2026-09-30', t)).toMatchObject({ amount_paise: 5000_00 })
    const cmp = lateFeeEstimate(form('CMP08'), '2026-10-18', t)!
    expect(cmp.amount_paise).toBeUndefined()
    expect(cmp.note).toMatch(/^Estimate: .*18%/)
    expect(lateFeeEstimate(form('TAX_AUDIT_REPORT'), '2026-09-30', t)!.note).toMatch(/271B/)
    expect(lateFeeEstimate(form('PF_ECR'), '2026-12-15', t)!.note).toMatch(/interest/i)
  })
  it('none when on time, filed on time or not applicable', () => {
    expect(lateFeeEstimate(form('GSTR9'), '2027-12-31', t)).toBeNull()
    expect(lateFeeEstimate(form('GSTR9'), '2026-12-31', { ...t, filedOn: '2026-12-20', status: 'filed' })).toBeNull()
    expect(lateFeeEstimate(form('GSTR9'), '2026-12-31', { ...t, filedOn: '2027-01-02', status: 'filed' })).toMatchObject({ amount_paise: 400_00 })
    expect(lateFeeEstimate(form('GSTR9'), '2026-12-31', { ...t, status: 'not_applicable' })).toBeNull()
  })
})
