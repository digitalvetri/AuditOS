import { describe, expect, it } from 'vitest'
import { calculatePayrollItem, pfAppliesTo, type CalcInputs } from '../../../domain/payroll/calc.js'
import type { StatutorySnapshot } from '../../../domain/payroll/statutory.js'

/**
 * PF is for employees covered by it. An articled assistant is a trainee on a
 * stipend, and HR can switch PF off for anyone else; either way neither the
 * employee's nor the employer's share is computed.
 */

const SNAP: StatutorySnapshot = {
  'pf.employee_rate': '0.12',
  'pf.employer_rate': '0.12',
  'pf.wage_ceiling': '15000',
  'esi.gross_threshold': '21000',
  'esi.employee_rate': '0.0075',
  'esi.employer_rate': '0.0325',
}

const base: CalcInputs = {
  structure: { basic_paise: 12_000_00, hra_paise: 4_000_00, conveyance_paise: 0, special_allowance_paise: 2_000_00, custom_components: [] },
  attendance: { payable_days: 30, present_days: 30, on_leave_days: 0, absent_days: 0, lop_days: 0 },
  snap: SNAP,
  periodStartMonth: 9,
}

describe('pfAppliesTo', () => {
  it('covers employees by default, never articled assistants, and honours the flag', () => {
    expect(pfAppliesTo({ type: 'executive', pfApplicable: true })).toBe(true)
    expect(pfAppliesTo({ type: 'articled', pfApplicable: true })).toBe(false)
    expect(pfAppliesTo({ type: 'manager', pfApplicable: false })).toBe(false)
  })
})

describe('calculatePayrollItem — PF applicability', () => {
  it('computes PF when covered (the default)', () => {
    const c = calculatePayrollItem(base)
    expect(c.deductions.pf_employee_paise).toBe(1_440_00)
    expect(c.deductions.pf_employer_paise).toBe(1_440_00)
  })

  it('skips both shares when not covered, and net rises by exactly the employee share', () => {
    const covered = calculatePayrollItem(base)
    const c = calculatePayrollItem({ ...base, pf_applicable: false })
    expect(c.deductions.pf_employee_paise).toBe(0)
    expect(c.deductions.pf_employer_paise).toBe(0)
    expect(c.gross_paise).toBe(covered.gross_paise)
    expect(c.net_paise).toBe(covered.net_paise + covered.deductions.pf_employee_paise)
    // ESI is untouched — only PF is skipped.
    expect(c.deductions.esi_employee_paise).toBe(covered.deductions.esi_employee_paise)
  })
})
