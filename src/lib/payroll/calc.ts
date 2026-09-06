/**
 * Payroll calculation — pure function.
 *
 * Inputs:  employee salary structure (versioned) + attendance summary for the
 *          period + statutory snapshot + monthly incentive + TDS override
 * Output:  a PayrollItem-shaped record with every earning + deduction spelled
 *          out per employee ("show the working" — §8.4).
 *
 * LOP: §3 formula = (gross / payable_days) * lop_days.
 * Payable days = calendar days in period.
 * LOP days = absent days that are NOT approved leave. (Approved-leave rows
 *            are written as `on_leave` attendance status; those don't LOP.)
 * Rounding: nearest rupee, half-up (see statutory.roundHalfUp).
 */

import type {
  PayrollDeductions,
  PayrollEarnings,
  SalaryStructure,
  StatutorySnapshot,
} from '@/data/models';
import { computeESI, computePF, computePT, roundHalfUp } from './statutory';

export interface AttendanceSummary {
  payable_days: number;
  present_days: number;
  on_leave_days: number;
  absent_days: number;
  lop_days: number;
}

export interface CalcInputs {
  structure: SalaryStructure;
  attendance: AttendanceSummary;
  snap: StatutorySnapshot;
  periodStartMonth: number; // 1..12 (IST)
  incentive_paise?: number;
  tds_paise?: number;
  advance_recovery_paise?: number;
}

export interface CalcOutput {
  earnings: PayrollEarnings;
  deductions: PayrollDeductions;
  gross_paise: number;
  total_deductions_paise: number;
  net_paise: number;
}

export function calculatePayrollItem(input: CalcInputs): CalcOutput {
  const { structure, attendance, snap, periodStartMonth } = input;
  const {
    basic_paise, hra_paise, conveyance_paise, special_allowance_paise, custom_components,
  } = structure;
  const incentive_paise = input.incentive_paise ?? 0;

  // ── Earnings ─────────────────────────────────────────────────────────
  const customEarnings = custom_components.filter((c) => c.kind === 'earning');
  const otherEarnPaise = customEarnings.reduce((s, c) => s + c.amount_paise, 0);
  const grossBeforeLop =
    basic_paise + hra_paise + conveyance_paise + special_allowance_paise + incentive_paise + otherEarnPaise;

  // ── LOP first (deducts from gross) ─────────────────────────────────
  const perDay = attendance.payable_days > 0 ? grossBeforeLop / attendance.payable_days : 0;
  const lop_paise = roundHalfUp(perDay * attendance.lop_days);
  const gross_paise = Math.max(0, grossBeforeLop - lop_paise);

  // ── Statutory ─────────────────────────────────────────────────────
  // PF basis is Basic (proportionately reduced for LOP days? Common practice
  // is yes, but the spec is silent; conservative: use full Basic). Documented.
  const pf = computePF(basic_paise, snap);
  const esi = computeESI(gross_paise, snap);
  const pt_paise = computePT(gross_paise, periodStartMonth, snap);
  const tds_paise = input.tds_paise ?? 0;
  const advance_paise = input.advance_recovery_paise ?? 0;

  const customDeductions = custom_components.filter((c) => c.kind === 'deduction');
  const otherDeductPaise = customDeductions.reduce((s, c) => s + c.amount_paise, 0);

  const total_deductions_paise =
    pf.employee_paise +
    esi.employee_paise +
    pt_paise +
    tds_paise +
    // NB: LOP is NOT here — it already reduced gross, avoiding double count.
    advance_paise +
    otherDeductPaise;

  const net_paise = Math.max(0, gross_paise - total_deductions_paise);

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
    net_paise,
  };
}
