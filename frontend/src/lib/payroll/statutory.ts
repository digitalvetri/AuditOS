/**
 * Statutory resolution and computation.
 *
 * Rule from §3/§10: no rate, ceiling or slab as a literal in application
 * code. Everything comes from `StatutoryRate` rows, keyed by `code`, filtered
 * to the row where `onDate` ∈ [effective_from, effective_to].
 *
 * `snapshotAt(onDate, rates)` captures the currently-effective values as a
 * plain map. A PayrollRun stores this snapshot so a rate change AFTER the
 * run is calculated does NOT retroactively alter the payslips.
 *
 * All computation functions take a snapshot; never a raw rate list. That way
 * the calc module has one and only one entry point for "what were the rates
 * when we ran this?".
 */

import type { StatutoryRate, StatutorySnapshot } from '@/data/models';

/**
 * Resolve the row effective on `onDate` for a given code. Returns undefined
 * when no row is in force (caller decides how to treat missing rates).
 */
export function resolveRate(
  code: string,
  onDate: string,
  rates: StatutoryRate[],
): StatutoryRate | undefined {
  return rates.find(
    (r) =>
      r.code === code &&
      r.effective_from <= onDate &&
      (r.effective_to === null || r.effective_to >= onDate),
  );
}

/**
 * Snapshot every rate row effective on `onDate` as `{code: value}`.
 * Store this on the PayrollRun.
 */
export function snapshotAt(onDate: string, rates: StatutoryRate[]): StatutorySnapshot {
  const snap: StatutorySnapshot = {};
  const seen = new Set<string>();
  for (const r of rates) {
    if (seen.has(r.code)) continue;
    const eff = resolveRate(r.code, onDate, rates);
    if (eff) {
      snap[r.code] = eff.value;
      seen.add(r.code);
    }
  }
  return snap;
}

function num(snap: StatutorySnapshot, code: string, fallback = 0): number {
  const raw = snap[code];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// ── PF ────────────────────────────────────────────────────────────────────
// Formula: PF = employee_rate * min(basic, wage_ceiling) if restrict, else * basic.
// For the scaffold we default `restrict_to_ceiling` = true (spec §3 [DECIDE]).

export interface PFResult {
  employee_paise: number;
  employer_paise: number;
  basis_paise: number;
}

export function computePF(basic_paise: number, snap: StatutorySnapshot): PFResult {
  const employeeRate = num(snap, 'pf.employee_rate');
  const employerRate = num(snap, 'pf.employer_rate');
  const ceilingRupees = num(snap, 'pf.wage_ceiling');
  const ceilingPaise = ceilingRupees * 100;
  const basis = ceilingPaise > 0 ? Math.min(basic_paise, ceilingPaise) : basic_paise;
  return {
    employee_paise: roundHalfUp(basis * employeeRate),
    employer_paise: roundHalfUp(basis * employerRate),
    basis_paise: basis,
  };
}

// ── ESI ────────────────────────────────────────────────────────────────────
// ESI applies only when monthly GROSS ≤ threshold. Both sides charged on gross.

export interface ESIResult {
  employee_paise: number;
  employer_paise: number;
  applies: boolean;
}

export function computeESI(gross_paise: number, snap: StatutorySnapshot): ESIResult {
  const thresholdRupees = num(snap, 'esi.gross_threshold');
  const applies = thresholdRupees > 0 && gross_paise <= thresholdRupees * 100;
  if (!applies) return { employee_paise: 0, employer_paise: 0, applies: false };
  const employeeRate = num(snap, 'esi.employee_rate');
  const employerRate = num(snap, 'esi.employer_rate');
  return {
    employee_paise: roundHalfUp(gross_paise * employeeRate),
    employer_paise: roundHalfUp(gross_paise * employerRate),
    applies: true,
  };
}

// ── Professional Tax (Tamil Nadu — half-yearly slab) ─────────────────────
// TN charges PT half-yearly (Apr–Sep, Oct–Mar), typically realised in Aug
// and Feb payrolls. Two interpretations:
//   (a) accrue monthly = slab_amount / 6
//   (b) realise in the two months it's actually due (Aug + Feb)
// (b) matches what most firms do. Slabs stored as JSON in the rate's value.
//
// Called with the run's period_start month (1..12) so the handler decides
// month-by-month whether to charge PT.

interface PTSlab {
  half_yearly_income_up_to: number;
  tax_amount: number;
}

export function computePT(
  monthlyGrossPaise: number,
  periodStartMonth: number,
  snap: StatutorySnapshot,
): number {
  const raw = snap['pt.tn.slab'];
  if (!raw) return 0;
  // TN PT realised in Aug (8) and Feb (2). Other months: 0.
  const chargeMonth = periodStartMonth === 8 || periodStartMonth === 2;
  if (!chargeMonth) return 0;
  let slabs: PTSlab[];
  try {
    slabs = JSON.parse(raw) as PTSlab[];
  } catch {
    return 0;
  }
  const halfYearGrossRupees = (monthlyGrossPaise * 6) / 100;
  const slab = slabs.find((s) => halfYearGrossRupees <= s.half_yearly_income_up_to);
  if (!slab) return 0;
  return roundHalfUp(slab.tax_amount * 100);
}

// ── Utility ──────────────────────────────────────────────────────────────
/** Half-up rounding to the rupee (§3 rounding rule). Input in paise. */
export function roundHalfUp(paise: number): number {
  const rupees = paise / 100;
  return Math.round(rupees) * 100;
}
