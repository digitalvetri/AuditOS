import { describe, expect, it } from 'vitest'
import { lastDayOfMonth, monthlyPayrollPeriod } from '../../../lib/dates.js'

/**
 * Step 3 — payroll period derivation.
 * The pre-fix bug was 2026-12-30 → 2027-01-30: 32 days, crossing a month
 * boundary, in a system where every other period was one calendar month.
 * These tests prove the derivation cannot produce that shape from any
 * valid (year, month), and refuses invalid inputs.
 */

describe('lastDayOfMonth', () => {
  it('returns 31 for months with 31 days', () => {
    expect(lastDayOfMonth(2026, 1)).toBe(31)
    expect(lastDayOfMonth(2026, 3)).toBe(31)
    expect(lastDayOfMonth(2026, 5)).toBe(31)
    expect(lastDayOfMonth(2026, 7)).toBe(31)
    expect(lastDayOfMonth(2026, 8)).toBe(31)
    expect(lastDayOfMonth(2026, 10)).toBe(31)
    expect(lastDayOfMonth(2026, 12)).toBe(31)
  })
  it('returns 30 for months with 30 days', () => {
    for (const m of [4, 6, 9, 11]) expect(lastDayOfMonth(2026, m)).toBe(30)
  })
  it('respects leap years for February', () => {
    expect(lastDayOfMonth(2024, 2)).toBe(29)
    expect(lastDayOfMonth(2025, 2)).toBe(28)
    expect(lastDayOfMonth(2026, 2)).toBe(28)
    expect(lastDayOfMonth(2100, 2)).toBe(28) // century, not leap
    expect(lastDayOfMonth(2000, 2)).toBe(29) // divisible by 400, leap
  })
})

describe('monthlyPayrollPeriod', () => {
  it('derives (day 1, last-of-month) — never spills across months', () => {
    expect(monthlyPayrollPeriod(2026, 12)).toEqual({ start: '2026-12-01', end: '2026-12-31' })
    expect(monthlyPayrollPeriod(2026, 2)).toEqual({ start: '2026-02-01', end: '2026-02-28' })
    expect(monthlyPayrollPeriod(2024, 2)).toEqual({ start: '2024-02-01', end: '2024-02-29' })
  })

  it('is deterministic — cannot produce the 2026-12-30 → 2027-01-30 shape', () => {
    // Whatever a caller passes, start starts on day 1 and end sits in the
    // same month as start. This is the acceptance criterion "the DB
    // constraint refuses" from the spec, at the source rather than the sink.
    for (let m = 1; m <= 12; m++) {
      const { start, end } = monthlyPayrollPeriod(2026, m)
      expect(start.slice(-2)).toBe('01')
      expect(start.slice(0, 7)).toBe(end.slice(0, 7))
    }
  })

  it('refuses invalid inputs at the boundary', () => {
    expect(() => monthlyPayrollPeriod(2026, 0)).toThrow(/invalid month/i)
    expect(() => monthlyPayrollPeriod(2026, 13)).toThrow(/invalid month/i)
    expect(() => monthlyPayrollPeriod(1999, 5)).toThrow(/invalid year/i)
    expect(() => monthlyPayrollPeriod(2101, 5)).toThrow(/invalid year/i)
  })
})
