/**
 * Payroll calculation — one pure function, the single authority for what an
 * employee is paid. The React app never recomputes any of this; it renders
 * what comes back.
 *
 * LOP (§3): (gross / payable_days) × lop_days, deducted from gross BEFORE the
 * statutory bases are computed, so it is never double-counted as a deduction.
 * payable_days = calendar days in the period.
 * Rounding: half-up to the rupee.
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
  incentive_paise?: number
  tds_paise?: number
  advance_recovery_paise?: number
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
  const {
    basic_paise, hra_paise, conveyance_paise, special_allowance_paise, custom_components,
  } = structure
  const incentive_paise = input.incentive_paise ?? 0

  const customEarnings = custom_components.filter((c) => c.kind === 'earning')
  const otherEarnPaise = customEarnings.reduce((s, c) => s + c.amount_paise, 0)
  const grossBeforeLop =
    basic_paise + hra_paise + conveyance_paise + special_allowance_paise + incentive_paise + otherEarnPaise

  const perDay = attendance.payable_days > 0 ? grossBeforeLop / attendance.payable_days : 0
  const lop_paise = roundHalfUp(perDay * attendance.lop_days)
  const gross_paise = Math.max(0, grossBeforeLop - lop_paise)

  // PF basis is full Basic. Reducing it for LOP days is defensible but the
  // spec is silent, so we take the conservative reading and document it here.
  const pf = computePF(basic_paise, snap)
  const esi = computeESI(gross_paise, snap)
  const pt_paise = computePT(gross_paise, periodStartMonth, snap)
  const tds_paise = input.tds_paise ?? 0
  const advance_paise = input.advance_recovery_paise ?? 0

  const customDeductions = custom_components.filter((c) => c.kind === 'deduction')
  const otherDeductPaise = customDeductions.reduce((s, c) => s + c.amount_paise, 0)

  const total_deductions_paise =
    pf.employee_paise + esi.employee_paise + pt_paise + tds_paise + advance_paise + otherDeductPaise

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
      pf_employee_paise: pf.employee_paise,
      pf_employer_paise: pf.employer_paise,
      esi_employee_paise: esi.employee_paise,
      esi_employer_paise: esi.employer_paise,
      pt_paise,
      tds_paise,
      lop_paise,
      advance_paise,
      other: customDeductions,
    },
    gross_paise,
    total_deductions_paise,
    net_paise: Math.max(0, gross_paise - total_deductions_paise),
    gratuity_accrual_paise: computeGratuityAccrual(basic_paise, snap),
  }
}
