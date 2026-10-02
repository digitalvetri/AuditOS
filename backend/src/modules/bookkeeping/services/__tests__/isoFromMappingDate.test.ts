import { describe, expect, it } from 'vitest'
import { isoFromMappingDate } from '../BookkeepingImportCommitService.js'

/**
 * The date parser lives on the commit path, so mis-parsing a date
 * means posting to the wrong FY. Worth locking down explicitly against
 * the two formats the mapping screen accepts.
 */
describe('isoFromMappingDate', () => {
  it('converts DD/MM/YYYY as the client writes it', () => {
    expect(isoFromMappingDate('08/04/2025', 'DD/MM/YYYY')).toBe('2025-04-08')
  })

  it('is dash-tolerant so 08-04-2025 works too', () => {
    expect(isoFromMappingDate('08-04-2025', 'DD/MM/YYYY')).toBe('2025-04-08')
  })

  it('passes through ISO dates untouched', () => {
    expect(isoFromMappingDate('2025-04-08', 'DD/MM/YYYY')).toBe('2025-04-08')
  })

  it('pads single-digit days and months so 8/4/2025 → 2025-04-08', () => {
    expect(isoFromMappingDate('8/4/2025', 'DD/MM/YYYY')).toBe('2025-04-08')
  })

  it('interprets 12/25/2025 as Christmas when format is MM/DD/YYYY', () => {
    expect(isoFromMappingDate('12/25/2025', 'MM/DD/YYYY')).toBe('2025-12-25')
  })

  it('throws with a helpful message on an unparseable value', () => {
    expect(() => isoFromMappingDate('yesterday', 'DD/MM/YYYY')).toThrowError(/date/i)
  })

  it('throws on empty input rather than silently defaulting', () => {
    expect(() => isoFromMappingDate('', 'DD/MM/YYYY')).toThrowError(/empty/i)
  })
})
