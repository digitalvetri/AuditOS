import { describe, expect, it } from 'vitest'
import { validateImport } from '../imports.js'

/**
 * The two blocking validations from spec §5. `validateImport` is pure —
 * everything about file storage, row insertion and audit lives in the
 * route handler, so these tests need no database.
 */
describe('bookkeeping/imports — validateImport', () => {
  const baseline = {
    clientCompanyName: 'ABC Private Limited',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    companyNameInFile: 'ABC Private Limited',
    periodFromInFile: '2026-08-01',
    periodToInFile: '2026-08-31',
    periodLabel: 'August 2026',
  } as const

  it('accepts a file whose company and period both match the target', () => {
    expect(validateImport({ ...baseline })).toEqual({ status: 'imported', reason: null })
  })

  it('rejects a period mismatch with a message pointing at both windows', () => {
    const outcome = validateImport({
      ...baseline,
      periodFromInFile: '2026-07-01',
      periodToInFile: '2026-07-31',
    })
    expect(outcome.status).toBe('rejected_period_mismatch')
    expect(outcome.reason).toContain('2026-07-01')
    expect(outcome.reason).toContain('2026-07-31')
    expect(outcome.reason).toContain('August 2026')
  })

  it('rejects a company mismatch with a message pointing at both names', () => {
    const outcome = validateImport({
      ...baseline,
      companyNameInFile: 'XYZ Traders',
    })
    expect(outcome.status).toBe('rejected_company_mismatch')
    expect(outcome.reason).toContain('XYZ Traders')
    expect(outcome.reason).toContain('ABC Private Limited')
  })

  it('company mismatch wins when BOTH company and period are wrong', () => {
    // Spec §5 rationale: importing another client\'s books silently is the
    // worst mistake, so its rejection reason must be the one surfaced.
    const outcome = validateImport({
      ...baseline,
      companyNameInFile: 'XYZ Traders',
      periodFromInFile: '2026-07-01',
      periodToInFile: '2026-07-31',
    })
    expect(outcome.status).toBe('rejected_company_mismatch')
  })

  it('trims outer whitespace but does no other normalisation', () => {
    // Leading/trailing whitespace is tolerable — an accountant copy-pastes
    // a name and adds a stray tab. But no case fold, no punctuation strip:
    // "ABC Pvt Ltd" is a different company from "ABC Pvt. Ltd." and the
    // check is deliberately unforgiving.
    expect(validateImport({ ...baseline, companyNameInFile: '  ABC Private Limited\t' }).status).toBe('imported')
    expect(validateImport({ ...baseline, companyNameInFile: 'abc private limited' }).status).toBe('rejected_company_mismatch')
    expect(validateImport({ ...baseline, companyNameInFile: 'ABC Pvt Ltd' }).status).toBe('rejected_company_mismatch')
  })
})
