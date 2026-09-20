import { describe, expect, it } from 'vitest'
import {
  computeDueDate, dowOf, periodEndOf, periodStartOf, rollForwardBusinessDay,
} from '../dates.js'

describe('bookkeeping/dates — periodStartOf', () => {
  it('is the first of the month for every frequency', () => {
    expect(periodStartOf(2026, 8, 'monthly')).toBe('2026-08-01')
    expect(periodStartOf(2026, 4, 'quarterly')).toBe('2026-04-01')
    expect(periodStartOf(2026, 4, 'annual')).toBe('2026-04-01')
  })
})

describe('bookkeeping/dates — periodEndOf', () => {
  it('monthly: last day of the identified month', () => {
    expect(periodEndOf(2026, 1, 'monthly')).toBe('2026-01-31')
    expect(periodEndOf(2026, 2, 'monthly')).toBe('2026-02-28')      // non-leap
    expect(periodEndOf(2024, 2, 'monthly')).toBe('2024-02-29')      // leap year
    expect(periodEndOf(2026, 4, 'monthly')).toBe('2026-04-30')
    expect(periodEndOf(2026, 12, 'monthly')).toBe('2026-12-31')     // year edge
  })
  it('quarterly: last day of month + 2, wraps across the year edge', () => {
    expect(periodEndOf(2026, 4, 'quarterly')).toBe('2026-06-30')    // Q2
    expect(periodEndOf(2026, 10, 'quarterly')).toBe('2026-12-31')   // Q4 same year
    expect(periodEndOf(2026, 11, 'quarterly')).toBe('2027-01-31')   // crosses year
  })
  it('annual: last day of month + 11', () => {
    expect(periodEndOf(2026, 4, 'annual')).toBe('2027-03-31')       // FY 2026-27
    expect(periodEndOf(2026, 1, 'annual')).toBe('2026-12-31')       // calendar year
  })
})

describe('bookkeeping/dates — weekend rolling', () => {
  it('slides Saturday forward to Monday', () => {
    expect(dowOf('2026-09-05')).toBe(6)          // Saturday
    expect(rollForwardBusinessDay('2026-09-05')).toBe('2026-09-07')
  })
  it('slides Sunday forward to Monday', () => {
    expect(dowOf('2026-09-06')).toBe(0)          // Sunday
    expect(rollForwardBusinessDay('2026-09-06')).toBe('2026-09-07')
  })
  it('leaves weekdays alone', () => {
    expect(rollForwardBusinessDay('2026-09-07')).toBe('2026-09-07') // Monday
    expect(rollForwardBusinessDay('2026-09-11')).toBe('2026-09-11') // Friday
  })
})

describe('bookkeeping/dates — computeDueDate', () => {
  it('adds the offset to period_end and rolls weekends', () => {
    // Aug 2026 ends Sun 31 Aug? Actually Aug 31 2026 is a Monday. + 5 = Sat 5 Sep → Mon 7 Sep.
    expect(computeDueDate('2026-08-31', 5)).toBe('2026-09-07')
  })
  it('treats a 0-day offset as "same day as period end", still rolls weekends', () => {
    // 2026-05-31 is a Sunday → rolls to Monday.
    expect(computeDueDate('2026-05-31', 0)).toBe('2026-06-01')
  })
  it('clamps a negative offset to zero rather than moving backwards', () => {
    expect(computeDueDate('2026-08-31', -3)).toBe(computeDueDate('2026-08-31', 0))
  })
  it('supports the spec example: Aug 2026 due 05 Sep 2026, not 05 Aug', () => {
    // The whole point of PR-2 — anchor to period END, not period START.
    expect(computeDueDate(periodEndOf(2026, 8, 'monthly'), 5)).toBe('2026-09-07')
    // A 4-day offset — this happens to be a business day, so no roll needed.
    expect(computeDueDate(periodEndOf(2026, 8, 'monthly'), 4)).toBe('2026-09-04')
  })
})
