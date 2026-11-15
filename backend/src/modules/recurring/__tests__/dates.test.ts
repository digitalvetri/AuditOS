import { describe, expect, it } from 'vitest'
import { firstIssueDate, nextIssueDate, prorateFactor } from '../dates.js'

describe('firstIssueDate / nextIssueDate (unchanged, baseline coverage)', () => {
  it('monthly, day 1, start Oct 15 → Nov 1 (first full period)', () => {
    expect(firstIssueDate('2026-10-15', 'monthly', 1)).toBe('2026-11-01')
  })
  it('monthly, day 1, start on the day → same day', () => {
    expect(firstIssueDate('2026-10-01', 'monthly', 1)).toBe('2026-10-01')
  })
  it('monthly, day 31 clamps to short months', () => {
    expect(nextIssueDate('2026-01-31', 'monthly', 31)).toBe('2026-02-28')
    expect(nextIssueDate('2026-02-28', 'monthly', 31)).toBe('2026-03-31')
  })
})

describe('prorateFactor (POST-DELIVERY-CHANGES §E2)', () => {
  it('returns 1 when start equals the first full issue (no stub)', () => {
    expect(prorateFactor('2026-10-01', '2026-10-01', 'monthly')).toBe(1)
  })

  it('monthly: Oct 15 → Nov 1 stub is 17 / 31 days', () => {
    const f = prorateFactor('2026-10-15', '2026-11-01', 'monthly')
    expect(f).toBeCloseTo(17 / 31, 5)
  })

  it('monthly: Feb 10 2026 → Mar 1 stub uses 28-day Feb (non-leap)', () => {
    const f = prorateFactor('2026-02-10', '2026-03-01', 'monthly')
    expect(f).toBeCloseTo(19 / 28, 5)
  })

  it('monthly: Feb 10 2028 → Mar 1 stub uses 29-day Feb (leap)', () => {
    const f = prorateFactor('2028-02-10', '2028-03-01', 'monthly')
    expect(f).toBeCloseTo(20 / 29, 5)
  })

  it('quarterly: canonical 91-day denominator (stable across 90/92-day quarters)', () => {
    // 45 days into a quarter, regardless of which calendar quarter.
    expect(prorateFactor('2026-10-15', '2026-11-29', 'quarterly')).toBeCloseTo(45 / 91, 5)
  })

  it('annual: 365-day canonical denominator', () => {
    expect(prorateFactor('2026-10-01', '2027-01-01', 'annual')).toBeCloseTo(92 / 365, 5)
  })

  it('defensively caps at 1 if misconfigured (stub shouldn\'t exceed one period)', () => {
    // Something's wrong if start is >1 year before fullIssue on an annual
    // retainer, but we won't let it charge double a full period.
    const f = prorateFactor('2026-01-01', '2028-01-01', 'annual')
    expect(f).toBe(1)
  })
})
