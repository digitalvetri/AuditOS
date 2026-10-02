import { describe, expect, it } from 'vitest'
import { bucketMonthly, monthWindow } from '../monthly.js'

describe('monthWindow', () => {
  it('returns the months ending with the current one, oldest first', () => {
    expect(monthWindow('2026-10-03', 6)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
  })

  it('crosses a year boundary', () => {
    expect(monthWindow('2026-02-15', 4)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
  })
})

describe('bucketMonthly', () => {
  const months = ['2026-08', '2026-09', '2026-10']

  it('buckets billed by invoice date and collected by payment date', () => {
    const points = bucketMonthly(
      months,
      [
        { invoiceDate: '2026-08-14', totalPaise: 10_000 },
        { invoiceDate: '2026-09-01', totalPaise: 25_000 },
        { invoiceDate: '2026-09-30', totalPaise: 5_000 },
      ],
      [
        // Paid in October for a September invoice — counts in October.
        { paidOn: '2026-10-02', amountPaise: 25_000 },
        { paidOn: '2026-08-20', amountPaise: 4_000 },
      ],
    )
    expect(points).toEqual([
      { month: '2026-08', billed_paise: 10_000, collected_paise: 4_000, invoices: 1, payments: 1 },
      { month: '2026-09', billed_paise: 30_000, collected_paise: 0, invoices: 2, payments: 0 },
      { month: '2026-10', billed_paise: 0, collected_paise: 25_000, invoices: 0, payments: 1 },
    ])
  })

  it('ignores anything outside the window', () => {
    const points = bucketMonthly(months, [{ invoiceDate: '2026-01-10', totalPaise: 99 }], [{ paidOn: '2027-01-01', amountPaise: 1 }])
    expect(points.every((p) => p.billed_paise === 0 && p.collected_paise === 0)).toBe(true)
  })
})
