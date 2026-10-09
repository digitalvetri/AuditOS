/**
 * FINANCE MIS — pure computation.
 *
 * Everything here is free of Prisma and Express so the arithmetic (cost
 * rates, profitability, utilisation, DSO) can be tested on plain fixtures.
 * Money is integer paise throughout; hours and percentages are rounded only
 * at the edge, when a row is built.
 */

/** Notional working hours in a month, used to turn a monthly CTC into an hourly cost. */
export const STANDARD_HOURS_PER_MONTH = 200

export interface CostRateEmployee {
  costRatePaisePerHour: number | null
}

export interface CostRateSalary {
  effectiveFrom: string
  monthlyCtcPaise: number
  deletedAt?: Date | null
}

/**
 * The hourly cost of an employee, in paise:
 *   1. the explicit cost rate on the employee, when set;
 *   2. else the latest salary structure effective on or before `asOf`
 *      (not deleted): monthly CTC ÷ 200 hours, rounded to whole paise;
 *   3. else 0 — time is still reported, it just carries no cost.
 */
export function costRatePerHour(employee: CostRateEmployee, structures: CostRateSalary[], asOf: string): number {
  if (employee.costRatePaisePerHour != null && employee.costRatePaisePerHour >= 0) {
    return employee.costRatePaisePerHour
  }
  const latest = structures
    .filter((s) => !s.deletedAt && s.effectiveFrom <= asOf)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0))[0]
  if (!latest) return 0
  return Math.round(latest.monthlyCtcPaise / STANDARD_HOURS_PER_MONTH)
}

/** Cost of `minutes` at `ratePaisePerHour`, in whole paise. */
export function timeCostPaise(minutes: number, ratePaisePerHour: number): number {
  return Math.round((minutes * ratePaisePerHour) / 60)
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export function minutesToHours(minutes: number): number {
  return round2(minutes / 60)
}

/** Percentage `part / whole`, one decimal; null when the base is not positive. */
export function percent(part: number, whole: number): number | null {
  if (!(whole > 0)) return null
  return round1((part / whole) * 100)
}

// ── Periods ─────────────────────────────────────────────────────────────

/** 'YYYY-MM' for every month touched by [from, to], in order. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  let [y, m] = from.slice(0, 7).split('-').map(Number)
  const [ey, em] = to.slice(0, 7).split('-').map(Number)
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

/** Indian FY label ('2026-27') for the FY containing `isoDate`. */
export function fyLabelOf(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number)
  const start = m >= 4 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

/** Date window of an FY label: '2026-27' → 2026-04-01 … 2027-03-31. Null if malformed. */
export function fyWindow(label: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(label)
  if (!m) return null
  const start = Number(m[1])
  if ((start + 1) % 100 !== Number(m[2])) return null
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` }
}

// ── Profitability ───────────────────────────────────────────────────────

export interface TimeEntry {
  /** What the time is grouped under: a client id, a client-service id… */
  key: string
  employeeId: string
  minutes: number
}

export interface ProfitabilityRow {
  key: string
  feesPaise: number
  minutes: number
  hours: number
  timeCostPaise: number
  marginPaise: number
  marginPercent: number | null
}

/**
 * Fees (ex-GST, net of credit notes) less time cost, per key. A key with
 * fees but no time, or time but no fees, still gets a row.
 */
export function computeProfitability(
  fees: Map<string, number>,
  time: TimeEntry[],
  rates: Map<string, number>,
): ProfitabilityRow[] {
  const minutes = new Map<string, number>()
  const cost = new Map<string, number>()
  // Cost is summed per employee per key before rounding, so many small
  // sessions do not each lose a fraction of a paisa.
  const perEmp = new Map<string, number>()
  for (const t of time) {
    minutes.set(t.key, (minutes.get(t.key) ?? 0) + t.minutes)
    const k = `${t.key}\u0000${t.employeeId}`
    perEmp.set(k, (perEmp.get(k) ?? 0) + t.minutes)
  }
  for (const [k, mins] of perEmp) {
    const [key, emp] = k.split('\u0000')
    cost.set(key, (cost.get(key) ?? 0) + timeCostPaise(mins, rates.get(emp) ?? 0))
  }
  const keys = new Set<string>([...fees.keys(), ...minutes.keys()])
  return [...keys].map((key) => {
    const f = fees.get(key) ?? 0
    const c = cost.get(key) ?? 0
    const mins = minutes.get(key) ?? 0
    return {
      key,
      feesPaise: f,
      minutes: mins,
      hours: minutesToHours(mins),
      timeCostPaise: c,
      marginPaise: f - c,
      marginPercent: percent(f - c, f),
    }
  })
}

// ── Utilisation ─────────────────────────────────────────────────────────

export interface MonthMinutes {
  employeeId: string
  /** 'YYYY-MM' */
  month: string
  minutes: number
}

export interface UtilisationRow {
  employeeId: string
  month: string
  taskMinutes: number
  attendanceMinutes: number
  taskHours: number
  attendanceHours: number
  /** Null when there is no attendance to divide by. */
  utilisationPercent: number | null
}

/** Task hours ÷ attendance hours, per employee per month. */
export function computeUtilisation(task: MonthMinutes[], attendance: MonthMinutes[]): UtilisationRow[] {
  const t = new Map<string, number>()
  const a = new Map<string, number>()
  for (const r of task) t.set(`${r.employeeId}|${r.month}`, (t.get(`${r.employeeId}|${r.month}`) ?? 0) + r.minutes)
  for (const r of attendance) a.set(`${r.employeeId}|${r.month}`, (a.get(`${r.employeeId}|${r.month}`) ?? 0) + r.minutes)
  const keys = [...new Set([...t.keys(), ...a.keys()])]
  return keys
    .map((k) => {
      const [employeeId, month] = k.split('|')
      const tm = t.get(k) ?? 0
      const am = a.get(k) ?? 0
      return {
        employeeId,
        month,
        taskMinutes: tm,
        attendanceMinutes: am,
        taskHours: minutesToHours(tm),
        attendanceHours: minutesToHours(am),
        utilisationPercent: percent(tm, am),
      }
    })
    .sort((x, y) => (x.employeeId === y.employeeId ? x.month.localeCompare(y.month) : x.employeeId.localeCompare(y.employeeId)))
}

// ── DSO ─────────────────────────────────────────────────────────────────

/**
 * Days sales outstanding: closing receivables ÷ revenue (incl. GST) in the
 * period × days in the period. Null when there was no revenue.
 */
export function computeDso(closingReceivablesPaise: number, revenuePaise: number, days: number): number | null {
  if (!(revenuePaise > 0)) return null
  return round1((closingReceivablesPaise / revenuePaise) * days)
}

/** Payment-weighted average of (paid on − invoice date), in days. */
export function weightedDaysToCollect(payments: { amountPaise: number; days: number }[]): number | null {
  let w = 0
  let sum = 0
  for (const p of payments) {
    if (p.amountPaise <= 0) continue
    w += p.amountPaise
    sum += p.amountPaise * p.days
  }
  return w > 0 ? round1(sum / w) : null
}
