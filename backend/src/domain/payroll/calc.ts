/**
 * Payroll calculation — one pure function, the single authority for what an
 * employee is paid. The React app never recomputes any of this; it renders
 * what comes back.
 *
 * LOP (§3): (gross / payable_days) × lop_days, deducted from gross BEFORE the
 * statutory bases are computed, so it is never double-counted as a deduction.
 * payable_days = calendar days employed in the period (the whole month for
 * everyone except joiners and leavers).
 *
 * Pro-rata (joiners/leavers): when payable_days < period_days, each fixed
 * earning is scaled by payable_days / period_days (calendar days, the same
 * basis as LOP) before LOP, so the per-day rate is unchanged.
 *
 * Deduction cap: deductions never exceed gross. The shortfall is absorbed in
 * order advance → custom deductions → TDS → PT → ESI → PF, written back into
 * the individual fields so gross = net + Σ deductions exactly and the
 * payroll journal always balances.
 * Rounding: half-up to the rupee.
 *
 * PF applies only to employees covered by it (pfAppliesTo): an articled
 * assistant is a trainee on a stipend, not an employee under the EPF Act, and
 * HR can switch PF off for anyone else. Not covered means neither the
 * employee's nor the employer's share.
 */
import {
  computeESI, computeGratuityAccrual, computePF, computePT, roundHalfUp,
  type StatutorySnapshot,
} from './statutory.js'

export interface CustomComponent {
  code: string
  label: string
  amount_paise: number
  kind: 'earning' | 'deduction'
}

export interface StructureShape {
  basic_paise: number
  hra_paise: number
  conveyance_paise: number
  special_allowance_paise: number
  custom_components: CustomComponent[]
}

export interface AttendanceSummary {
  payable_days: number
  present_days: number
  on_leave_days: number
  absent_days: number
  lop_days: number
}

export interface PayrollEarnings {
  basic_paise: number
  hra_paise: number
  conveyance_paise: number
  special_paise: number
  incentive_paise: number
  other: CustomComponent[]
}

export interface PayrollDeductions {
  pf_employee_paise: number
  pf_employer_paise: number
  esi_employee_paise: number
  esi_employer_paise: number
  pt_paise: number
  tds_paise: number
  lop_paise: number
  advance_paise: number
  other: CustomComponent[]
}

export interface CalcInputs {
  structure: StructureShape
  attendance: AttendanceSummary
  snap: StatutorySnapshot
  periodStartMonth: number
  /** Calendar days in the whole period. Defaults to attendance.payable_days (no pro-rata). */
  period_days?: number
  incentive_paise?: number
  tds_paise?: number
  advance_recovery_paise?: number
  /** False skips PF entirely (both shares). Defaults to covered. */
  pf_applicable?: boolean
}

/** Whether PF is deducted for this employee. The one place the rule lives. */
export function pfAppliesTo(employee: { type: string; pfApplicable: boolean }): boolean {
  return employee.type !== 'articled' && employee.pfApplicable !== false
}

export interface CalcOutput {
  earnings: PayrollEarnings
  deductions: PayrollDeductions
  gross_paise: number
  total_deductions_paise: number
  net_paise: number
  gratuity_accrual_paise: number
}

export function calculatePayrollItem(input: CalcInputs): CalcOutput {
  const { structure, attendance, snap, periodStartMonth } = input
  const incentive_paise = input.incentive_paise ?? 0

  // Pro-rata for a partial month of employment (calendar days).
  const periodDays = input.period_days ?? attendance.payable_days
  const prorate = (paise: number) =>
    periodDays > 0 && attendance.payable_days < periodDays
      ? roundHalfUp((paise * attendance.payable_days) / periodDays)
      : paise
  const basic_paise = prorate(structure.basic_paise)
  const hra_paise = prorate(structure.hra_paise)
  const conveyance_paise = prorate(structure.conveyance_paise)
  const special_allowance_paise = prorate(structure.special_allowance_paise)
  const customEarnings = structure.custom_components
    .filter((c) => c.kind === 'earning')
    .map((c) => ({ ...c, amount_paise: prorate(c.amount_paise) }))

  const otherEarnPaise = customEarnings.reduce((s, c) => s + c.amount_paise, 0)
  const grossBeforeLop =
    basic_paise + hra_paise + conveyance_paise + special_allowance_paise + incentive_paise + otherEarnPaise

  const perDay = attendance.payable_days > 0 ? grossBeforeLop / attendance.payable_days : 0
  const lop_paise = roundHalfUp(perDay * attendance.lop_days)
  const gross_paise = Math.max(0, grossBeforeLop - lop_paise)

  // PF basis is the Basic actually earned: Basic less its share of LOP.
  const basicLop = attendance.payable_days > 0
    ? roundHalfUp((basic_paise / attendance.payable_days) * attendance.lop_days)
    : basic_paise
  const pf = input.pf_applicable === false
    ? { employee_paise: 0, employer_paise: 0 }
    : computePF(Math.max(0, basic_paise - basicLop), snap)
  const esi = computeESI(gross_paise, snap)

  // Deductions in absorb order: the first entry is reduced first when the
  // total would exceed gross. Statutory items come last.
  const customDeductions = structure.custom_components
    .filter((c) => c.kind === 'deduction')
    .map((c) => ({ ...c }))
  const capped = {
    advance: input.advance_recovery_paise ?? 0,
    custom: customDeductions.map((c) => c.amount_paise),
    tds: input.tds_paise ?? 0,
    pt: computePT(gross_paise, periodStartMonth, snap),
    esi: esi.employee_paise,
    pf: pf.employee_paise,
  }
  const sum = () => capped.advance + capped.custom.reduce((s, n) => s + n, 0)
    + capped.tds + capped.pt + capped.esi + capped.pf
  let excess = sum() - gross_paise
  const absorb = (amount: number) => {
    const cut = Math.min(amount, Math.max(0, excess))
    excess -= cut
    return amount - cut
  }
  capped.advance = absorb(capped.advance)
  capped.custom = capped.custom.map(absorb)
  capped.tds = absorb(capped.tds)
  capped.pt = absorb(capped.pt)
  capped.esi = absorb(capped.esi)
  capped.pf = absorb(capped.pf)
  customDeductions.forEach((c, i) => { c.amount_paise = capped.custom[i] })

  const total_deductions_paise = sum()

  return {
    earnings: {
      basic_paise,
      hra_paise,
      conveyance_paise,
      special_paise: special_allowance_paise,
      incentive_paise,
      other: customEarnings,
    },
    deductions: {
      pf_employee_paise: capped.pf,
      pf_employer_paise: pf.employer_paise,
      esi_employee_paise: capped.esi,
      esi_employer_paise: esi.employer_paise,
      pt_paise: capped.pt,
      tds_paise: capped.tds,
      lop_paise,
      advance_paise: capped.advance,
      other: customDeductions,
    },
    gross_paise,
    total_deductions_paise,
    net_paise: gross_paise - total_deductions_paise,
    gratuity_accrual_paise: computeGratuityAccrual(basic_paise, snap),
  }
}
