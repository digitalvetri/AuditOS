import { describe, expect, it } from 'vitest'
import { calculatePayrollItem, type CalcInputs, type StructureShape } from '../../../domain/payroll/calc.js'
import { summarize } from '../../../domain/payroll/attendanceSummary.js'
import { employmentWindow } from '../../../domain/payroll/employment.js'
import type { StatutorySnapshot } from '../../../domain/payroll/statutory.js'
import { payrollJournalLegs } from '../routes.js'

/**
 * Pure calc tests for:
 *   - pro-rata pay for mid-month joiners and leavers (calendar days, the
 *     same basis LOP already uses), and
 *   - deductions capped at gross, so gross = net + Σ deductions exactly and
 *     the payroll journal always balances.
 */

const SNAP: StatutorySnapshot = {
  'pf.employee_rate': '0.12',
  'pf.employer_rate': '0.12',
  'pf.wage_ceiling': '15000',
  'esi.gross_threshold': '21000',
  'esi.employee_rate': '0.0075',
  'esi.employer_rate': '0.0325',
  'pt.tn.slab': JSON.stringify([
    { half_yearly_income_up_to: 21000, tax_amount: 0 },
    { half_yearly_income_up_to: 30000, tax_amount: 135 },
    { half_yearly_income_up_to: 45000, tax_amount: 315 },
    { half_yearly_income_up_to: 60000, tax_amount: 690 },
    { half_yearly_income_up_to: 75000, tax_amount: 1025 },
    { half_yearly_income_up_to: Number.MAX_SAFE_INTEGER, tax_amount: 1250 },
  ]),
  'gratuity.eligible_after_years': '5',
}

const SMALL: StructureShape = {
  basic_paise: 10_000_00, hra_paise: 4_000_00, conveyance_paise: 0, special_allowance_paise: 2_000_00,
  custom_components: [],
}
const BIG: StructureShape = {
  basic_paise: 50_000_00, hra_paise: 20_000_00, conveyance_paise: 5_000_00, special_allowance_paise: 10_000_00,
  custom_components: [],
}

function att(payable: number, lop = 0) {
  return { payable_days: payable, present_days: payable - lop, on_leave_days: 0, absent_days: lop, lop_days: lop }
}

function sumDeductions(c: ReturnType<typeof calculatePayrollItem>) {
  const d = c.deductions
  return d.pf_employee_paise + d.esi_employee_paise + d.pt_paise + d.tds_paise + d.advance_paise
    + d.other.reduce((s, o) => s + o.amount_paise, 0)
}

function journalBalances(c: ReturnType<typeof calculatePayrollItem>) {
  const legs = payrollJournalLegs(c.gross_paise, c.net_paise, JSON.stringify(c.deductions))
    .filter((l) => (l.debitPaise ?? 0) > 0 || (l.creditPaise ?? 0) > 0)
  const dr = legs.reduce((s, l) => s + (l.debitPaise ?? 0), 0)
  const cr = legs.reduce((s, l) => s + (l.creditPaise ?? 0), 0)
  return { dr, cr, legs: legs.length }
}

describe('employmentWindow + summarize — joiners and leavers', () => {
  it('clips the window to joining and exit dates', () => {
    expect(employmentWindow('2026-09-01', '2026-09-30', '2026-01-01', null))
      .toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(employmentWindow('2026-09-01', '2026-09-30', '2026-09-16', null))
      .toEqual({ start: '2026-09-16', end: '2026-09-30' })
    expect(employmentWindow('2026-09-01', '2026-09-30', '2025-01-01', '2026-09-10'))
      .toEqual({ start: '2026-09-01', end: '2026-09-10' })
    expect(employmentWindow('2026-09-01', '2026-09-30', '2025-01-01', '2026-08-31')).toBeNull()
  })

  it('a joiner on the 16th of a 30-day month has 15 payable days and no LOP', () => {
    const s = summarize([], [], '2026-09-16', '2026-09-30')
    expect(s.payable_days).toBe(15)
    expect(s.lop_days).toBe(0)
  })
})

describe('calculatePayrollItem — pro-rata', () => {
  it('full-month employee is unchanged by period_days', () => {
    const base: CalcInputs = { structure: BIG, attendance: att(30), snap: SNAP, periodStartMonth: 9 }
    const a = calculatePayrollItem(base)
    const b = calculatePayrollItem({ ...base, period_days: 30 })
    expect(b).toEqual(a)
    expect(a.gross_paise).toBe(85_000_00)
    expect(a.deductions.pf_employee_paise).toBe(1_800_00)
  })

  it('mid-month joiner (15 of 30 days) is paid half, statutory on the half', () => {
    const c = calculatePayrollItem({
      structure: SMALL, attendance: att(15), snap: SNAP, periodStartMonth: 9, period_days: 30,
    })
    expect(c.earnings.basic_paise).toBe(5_000_00)
    expect(c.gross_paise).toBe(8_000_00)
    expect(c.deductions.pf_employee_paise).toBe(600_00)
    expect(c.deductions.esi_employee_paise).toBe(60_00)
    expect(c.net_paise).toBe(8_000_00 - 600_00 - 60_00)
  })

  it('leaver after 10 of 30 days is paid a third, rounded per component', () => {
    const c = calculatePayrollItem({
      structure: BIG, attendance: att(10), snap: SNAP, periodStartMonth: 9, period_days: 30,
    })
    // 16,667 + 6,667 + 1,667 + 3,333
    expect(c.gross_paise).toBe(28_334_00)
  })
})

describe('calculatePayrollItem — LOP-adjusted PF and deduction cap', () => {
  it('PF is on the Basic actually paid after LOP', () => {
    const c = calculatePayrollItem({ structure: SMALL, attendance: att(30, 15), snap: SNAP, periodStartMonth: 9 })
    expect(c.gross_paise).toBe(8_000_00)
    expect(c.deductions.pf_employee_paise).toBe(600_00) // 12% of 5,000, not of 10,000
  })

  it('caps deductions at gross: TDS absorbs the shortfall, net is exactly zero', () => {
    const c = calculatePayrollItem({
      structure: SMALL, attendance: att(30, 15), snap: SNAP, periodStartMonth: 9, tds_paise: 50_000_00,
    })
    expect(c.net_paise).toBe(0)
    expect(c.total_deductions_paise).toBe(c.gross_paise)
    expect(c.deductions.pf_employee_paise).toBe(600_00)
    expect(c.deductions.tds_paise).toBe(8_000_00 - 600_00 - 60_00)
  })

  it('advance is reduced before TDS', () => {
    const c = calculatePayrollItem({
      structure: SMALL, attendance: att(30), snap: SNAP, periodStartMonth: 9,
      tds_paise: 1_000_00, advance_recovery_paise: 50_000_00,
    })
    expect(c.deductions.tds_paise).toBe(1_000_00)
    expect(c.net_paise).toBe(0)
    expect(sumDeductions(c)).toBe(c.gross_paise)
  })

  it('full-month LOP: gross zero, every deduction zero', () => {
    const c = calculatePayrollItem({
      structure: SMALL, attendance: att(30, 30), snap: SNAP, periodStartMonth: 8, tds_paise: 5_000_00,
    })
    expect(c.gross_paise).toBe(0)
    expect(c.total_deductions_paise).toBe(0)
    expect(c.net_paise).toBe(0)
  })
})

describe('invariant — every item journal balances (gross = net + Σ deductions)', () => {
  const customDeduct: StructureShape = {
    ...SMALL,
    custom_components: [
      { code: 'CANT', label: 'Canteen', amount_paise: 3_000_00, kind: 'deduction' },
      { code: 'BON', label: 'Bonus', amount_paise: 1_000_00, kind: 'earning' },
    ],
  }
  const cases: [string, CalcInputs][] = []
  for (const structure of [SMALL, BIG, customDeduct]) {
    for (const month of [8, 9]) {
      for (const [payable, lop] of [[30, 0], [30, 15], [30, 29], [30, 30], [15, 0], [10, 3]]) {
        for (const tds of [0, 2_000_00, 200_000_00]) {
          for (const adv of [0, 100_000_00]) {
            cases.push([
              `${structure.basic_paise}/${month}/${payable}-${lop}/tds${tds}/adv${adv}`,
              {
                structure, attendance: att(payable, lop), snap: SNAP, periodStartMonth: month,
                period_days: 30, tds_paise: tds, advance_recovery_paise: adv,
              },
            ])
          }
        }
      }
    }
  }

  it.each(cases)('%s', (_name, input) => {
    const c = calculatePayrollItem(input)
    expect(c.net_paise).toBeGreaterThanOrEqual(0)
    expect(c.total_deductions_paise).toBe(sumDeductions(c))
    expect(c.net_paise).toBe(c.gross_paise - c.total_deductions_paise)
    const j = journalBalances(c)
    expect(j.dr).toBe(j.cr)
    if (c.gross_paise > 0) expect(j.legs).toBeGreaterThanOrEqual(2)
  })
})
