import { describe, expect, it } from 'vitest'
import { normalizeParty, similarity, findFuzzyMatches } from '../partyMatch.js'

describe('normalizeParty', () => {
  it('strips common Indian and international legal suffixes', () => {
    expect(normalizeParty('Loopet Pte Ltd')).toBe('loopet')
    expect(normalizeParty('Loopet Pte. Ltd.')).toBe('loopet')
    expect(normalizeParty('Loopet Pvt. Ltd.')).toBe('loopet')
    expect(normalizeParty('Loopet Private Limited')).toBe('loopet')
    expect(normalizeParty('Loopet LLP')).toBe('loopet')
    expect(normalizeParty('Loopet & Co.')).toBe('loopet')
    expect(normalizeParty('Loopet Corp')).toBe('loopet')
  })

  it('is case- and whitespace-insensitive', () => {
    expect(normalizeParty('   LOOPET   ')).toBe('loopet')
    expect(normalizeParty('loopet')).toBe('loopet')
  })

  it('keeps digits so numbered clients do not collapse', () => {
    expect(normalizeParty('Client 12')).toBe('client 12')
    expect(normalizeParty('Client 21')).toBe('client 21')
    expect(normalizeParty('Client 12')).not.toBe(normalizeParty('Client 21'))
  })

  it('keeps meaningful middle words intact — no over-stripping', () => {
    // "Ltd" is a suffix, but "Limited Editions" is not.
    expect(normalizeParty('Limited Editions Pvt Ltd')).toBe('limited editions')
  })

  it('handles ampersands inside the name', () => {
    expect(normalizeParty('Smith & Jones Pvt Ltd')).toBe('smith  jones'.replace(/\s+/g, ' '))
  })
})

describe('similarity', () => {
  it('is 1 for identical normalised names', () => {
    expect(similarity('Loopet Pte Ltd', 'loopet')).toBeCloseTo(1, 5)
  })

  it('is above the 0.85 threshold for the canonical Loopet case from the spec', () => {
    expect(similarity('Loopet', 'Loopet Pte Ltd')).toBeGreaterThan(0.85)
  })

  it('is below threshold for genuinely different names', () => {
    expect(similarity('Loopet', 'Andy Brar')).toBeLessThan(0.3)
    expect(similarity('Alexandra', 'Andy Brar')).toBeLessThan(0.5)
  })

  it('rejects single-character typos short-circuit', () => {
    // Empty vs anything → 0
    expect(similarity('', 'anything')).toBe(0)
    expect(similarity('', '')).toBe(1)
  })

  it('robust to one-character typos on longer names — "Loopat" vs "Loopet"', () => {
    expect(similarity('Loopat', 'Loopet')).toBeGreaterThanOrEqual(0.6)
  })
})

describe('findFuzzyMatches — the guard the operator actually sees', () => {
  const existing = [
    { ledgerId: 'L-1', name: 'Loopet Pte Ltd' },
    { ledgerId: 'L-2', name: 'Alexandra' },
    { ledgerId: 'L-3', name: 'Andy Brar' },
    { ledgerId: 'L-4', name: 'Inkbolt Pvt Ltd' },
  ]

  it('flags "Loopet" as a probable dup of the existing Loopet Pte Ltd', () => {
    const hits = findFuzzyMatches('Loopet', existing)
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]).toMatchObject({ ledgerId: 'L-1', name: 'Loopet Pte Ltd' })
    expect(hits[0].score).toBeGreaterThan(0.85)
  })

  it('does not flag a genuinely new party', () => {
    const hits = findFuzzyMatches('PinaPop Inc', existing)
    expect(hits).toEqual([])
  })

  it('is safe on empty input', () => {
    expect(findFuzzyMatches('', existing)).toEqual([])
    expect(findFuzzyMatches('Loopet', [])).toEqual([])
  })

  it('caps at topK matches so the wizard row stays readable', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ledgerId: `L-${i}`,
      name: 'Loopet',
    }))
    const hits = findFuzzyMatches('Loopet', many, { topK: 3 })
    expect(hits).toHaveLength(3)
  })
})
