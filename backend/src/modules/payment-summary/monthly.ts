/**
 * Billed vs collected, month by month — the dashboard's cash-flow chart.
 *
 *   billed    = sum of invoice totals, bucketed by the invoice's `invoiceDate`
 *   collected = sum of payments received, bucketed by the payment's `paidOn`,
 *               LESS refunds paid back, bucketed by the refund's `refundedOn`
 *
 * Both dates are stored as 'YYYY-MM-DD' strings in IST already, so the month
 * is simply the first seven characters — no timezone conversion needed.
 * Kept free of Prisma so the bucketing is unit-testable.
 */

export interface MonthPoint {
  /** 'YYYY-MM' */
  month: string
  billed_paise: number
  /** Cash in, net of refunds paid back in the month. */
  collected_paise: number
  /** Refunds paid back in the month (already taken out of collected_paise). */
  refunded_paise: number
  invoices: number
  payments: number
}

/** The `count` months ending with the month of `today` ('YYYY-MM-DD'), oldest first. */
export function monthWindow(today: string, count: number): string[] {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7)) // 1-12
  const out: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const index = year * 12 + (month - 1) - i
    const y = Math.floor(index / 12)
    const m = (index % 12) + 1
    out.push(`${y}-${String(m).padStart(2, '0')}`)
  }
  return out
}

export function bucketMonthly(
  months: string[],
  invoices: { invoiceDate: string; totalPaise: number }[],
  payments: { paidOn: string; amountPaise: number }[],
  refunds: { refundedOn: string; amountPaise: number }[] = [],
): MonthPoint[] {
  const points = new Map<string, MonthPoint>(
    months.map((m) => [m, { month: m, billed_paise: 0, collected_paise: 0, refunded_paise: 0, invoices: 0, payments: 0 }]),
  )
  for (const inv of invoices) {
    const p = points.get(inv.invoiceDate.slice(0, 7))
    if (!p) continue
    p.billed_paise += inv.totalPaise
    p.invoices += 1
  }
  for (const pay of payments) {
    const p = points.get(pay.paidOn.slice(0, 7))
    if (!p) continue
    p.collected_paise += pay.amountPaise
    p.payments += 1
  }
  for (const r of refunds) {
    const p = points.get(r.refundedOn.slice(0, 7))
    if (!p) continue
    p.collected_paise -= r.amountPaise
    p.refunded_paise += r.amountPaise
  }
  return months.map((m) => points.get(m)!)
}

/**
 * Average days from invoice date to payment, weighted by amount, over the
 * payments in the window — "how long money takes to come in". Null when no
 * payment was received in the window.
 */
export function avgDaysToCollect(payments: { paidOn: string; amountPaise: number; invoiceDate: string }[]): number | null {
  let weight = 0
  let total = 0
  for (const p of payments) {
    const days = Math.max(0, Math.round((Date.parse(`${p.paidOn}T00:00:00Z`) - Date.parse(`${p.invoiceDate}T00:00:00Z`)) / 86_400_000))
    total += days * p.amountPaise
    weight += p.amountPaise
  }
  return weight > 0 ? Math.round(total / weight) : null
}
