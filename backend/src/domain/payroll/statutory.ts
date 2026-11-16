/**
 * Statutory resolution and computation (§3 / §10).
 *
 * No rate, ceiling or slab appears as a literal in application code. Every
 * value comes from a StatutoryRate row keyed by `code` and filtered to the row
 * effective on the pay-period start date.
 *
 * `snapshotAt` captures the effective values as a flat map. A PayrollRun
 * stores that snapshot, so a rate change AFTER the run is calculated cannot
 * retroactively alter a processed payslip.
 */
export type StatutorySnapshot = Record<string, string>

export interface RateRow {
  code: string
  value: string
  effectiveFrom: string
  effectiveTo: string | null
}

export function resolveRate(code: string, onDate: string, rates: RateRow[]): RateRow | undefined {
  return rates
    .filter((r) => r.code === code && r.effectiveFrom <= onDate && (r.effectiveTo === null || r.effectiveTo >= onDate))
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0]
}

export function snapshotAt(onDate: string, rates: RateRow[]): StatutorySnapshot {
  const snap: StatutorySnapshot = {}
  for (const code of new Set(rates.map((r) => r.code))) {
    const eff = resolveRate(code, onDate, rates)
    if (eff) snap[code] = eff.value
  }
  return snap
}

function num(snap: StatutorySnapshot, code: string, fallback = 0): number {
  const raw = snap[code]
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/** Half-up rounding to the rupee (§3). Input and output in paise. */
export function roundHalfUp(paise: number): number {
  const sign = paise < 0 ? -1 : 1
  return sign * Math.round(Math.abs(paise) / 100) * 100
}

// ── PF ────────────────────────────────────────────────────────────────────
export interface PFResult { employee_paise: number; employer_paise: number; basis_paise: number }

export function computePF(basicPaise: number, snap: StatutorySnapshot): PFResult {
  const employeeRate = num(snap, 'pf.employee_rate')
  const employerRate = num(snap, 'pf.employer_rate')
  const ceilingPaise = num(snap, 'pf.wage_ceiling') * 100
  const basis = ceilingPaise > 0 ? Math.min(basicPaise, ceilingPaise) : basicPaise
  return {
    employee_paise: roundHalfUp(basis * employeeRate),
    employer_paise: roundHalfUp(basis * employerRate),
    basis_paise: basis,
  }
}

// ── ESI ───────────────────────────────────────────────────────────────────
export interface ESIResult { employee_paise: number; employer_paise: number; applies: boolean }

/**
 * ESI contribution periods run Apr–Sep and Oct–Mar. Returns the first day of
 * the period containing `periodStart` ('YYYY-MM-DD').
 */
export function esiContributionPeriodStart(periodStart: string): string {
  const [y, m] = periodStart.split('-').map(Number)
  if (m >= 4 && m <= 9) return `${y}-04-01`
  if (m >= 10) return `${y}-10-01`
  return `${y - 1}-10-01`
}

/**
 * Coverage for a whole contribution period (ESI Act s.2(9) proviso, ESI
 * (General) Regulations reg. 2): an employee whose wages were within the
 * ceiling at the start of the period (or on joining, if later) stays covered
 * until the period ends, even if wages rise above it mid-period; one above
 * the ceiling at the start is not covered for that period.
 */
export function esiCoveredForPeriod(wageAtPeriodStartPaise: number, snap: StatutorySnapshot): boolean {
  const thresholdRupees = num(snap, 'esi.gross_threshold')
  return thresholdRupees > 0 && wageAtPeriodStartPaise <= thresholdRupees * 100
}

/**
 * `covered` is the contribution-period decision (esiCoveredForPeriod). When
 * given, contributions are on actual gross whatever this month's gross is;
 * when omitted, this month's gross is tested against the ceiling.
 */
export function computeESI(grossPaise: number, snap: StatutorySnapshot, covered?: boolean): ESIResult {
  const thresholdRupees = num(snap, 'esi.gross_threshold')
  const applies = covered ?? (thresholdRupees > 0 && grossPaise <= thresholdRupees * 100)
  if (!applies) return { employee_paise: 0, employer_paise: 0, applies: false }
  return {
    employee_paise: roundHalfUp(grossPaise * num(snap, 'esi.employee_rate')),
    employer_paise: roundHalfUp(grossPaise * num(snap, 'esi.employer_rate')),
    applies: true,
  }
}

// ── Professional Tax (Tamil Nadu, half-yearly slab) ──────────────────────
interface PTSlab { half_yearly_income_up_to: number; tax_amount: number }

/**
 * TN realises PT half-yearly, in the August and February payrolls. Other
 * months charge nothing rather than accruing a sixth — that matches practice.
 */
export function computePT(monthlyGrossPaise: number, periodStartMonth: number, snap: StatutorySnapshot): number {
  const raw = snap['pt.tn.slab']
  if (!raw) return 0
  if (periodStartMonth !== 8 && periodStartMonth !== 2) return 0
  let slabs: PTSlab[]
  try {
    slabs = JSON.parse(raw) as PTSlab[]
  } catch {
    return 0
  }
  const halfYearGrossRupees = (monthlyGrossPaise * 6) / 100
  const slab = slabs.find((s) => halfYearGrossRupees <= s.half_yearly_income_up_to)
  return slab ? roundHalfUp(slab.tax_amount * 100) : 0
}

/**
 * Gratuity is ACCRUED, never paid through payroll: 15/26 of monthly basic per
 * completed year, shown so Finance can see the liability building.
 */
export function computeGratuityAccrual(basicPaise: number, snap: StatutorySnapshot): number {
  const eligibleAfter = num(snap, 'gratuity.eligible_after_years')
  if (eligibleAfter <= 0) return 0
  return roundHalfUp((basicPaise * 15) / 26 / 12)
}
