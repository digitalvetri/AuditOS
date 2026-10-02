import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { BookkeepingCompanyService } from './BookkeepingCompanyService.js'
import { BookkeepingSettingsService } from './BookkeepingSettingsService.js'
import { postVoucher, type EntryInput } from '../engine/posting.js'
import { applyBp } from '../engine/primitives.js'

/**
 * BookkeepingPayrollService — employees, pay heads, salary structures,
 * attendance and monthly processing.
 *
 * STATUTORY RATES ARE DATA. PF, ESI and professional tax come from the
 * company's payroll settings (or from the pay head itself); nothing in
 * this file hardcodes a percentage, so a rate change is a settings edit.
 *
 * A processed run is a working. Only POSTING it writes accounting
 * entries, and it does so through the same posting engine as every other
 * voucher — so a salary journal balances or it does not get written.
 */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export const BookkeepingPayrollService = {
  // ── Masters ────────────────────────────────────────────────────────
  async listEmployees(session: Session, companyId: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const rows = await prisma.bookkeepingEmployee.findMany({
      where: { tallyCompanyId: companyId, ...alive },
      include: { structureLines: { include: { payHead: { select: { name: true, headType: true } } } } },
      orderBy: { name: 'asc' },
    })
    return rows.map((e) => ({
      id: e.id, name: e.name, code: e.code, employee_group: e.employeeGroup, designation: e.designation,
      date_of_joining: e.dateOfJoining, date_of_leaving: e.dateOfLeaving, active: e.active,
      structure: e.structureLines.map((s) => ({
        pay_head_id: s.payHeadId, pay_head_name: s.payHead.name, head_type: s.payHead.headType,
        value_paise: s.valuePaise, percent_bp: s.percentBp,
      })),
    }))
  },

  async createEmployee(session: Session, companyId: string, input: {
    name: string; code?: string | null; employeeGroup?: string | null; designation?: string | null
    dateOfJoining?: string | null; pan?: string | null; bankAccountNumber?: string | null; bankIfsc?: string | null
  }) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const name = input.name.trim()
    if (!name) throw ApiError.badRequest('Employee name is required.')
    const clash = await prisma.bookkeepingEmployee.findFirst({ where: { tallyCompanyId: companyId, name, ...alive } })
    if (clash) throw ApiError.conflict('duplicate_name', `An employee named "${name}" already exists.`)
    const e = await prisma.bookkeepingEmployee.create({
      data: {
        tallyCompanyId: companyId, name, code: input.code ?? null, employeeGroup: input.employeeGroup ?? null,
        designation: input.designation ?? null, dateOfJoining: input.dateOfJoining ?? null,
        pan: input.pan ?? null, bankAccountNumber: input.bankAccountNumber ?? null, bankIfsc: input.bankIfsc ?? null,
      },
    })
    return { id: e.id, name: e.name }
  },

  async listPayHeads(session: Session, companyId: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const rows = await prisma.bookkeepingPayHead.findMany({
      where: { tallyCompanyId: companyId, ...alive },
      include: { ledger: { select: { id: true, name: true } } },
      orderBy: [{ headType: 'asc' }, { name: 'asc' }],
    })
    return rows.map((p) => ({
      id: p.id, name: p.name, head_type: p.headType, calc_type: p.calcType,
      value_paise: p.valuePaise, percent_bp: p.percentBp, statutory: p.statutory,
      ledger_id: p.ledgerId, ledger_name: p.ledger?.name ?? null, active: p.active,
    }))
  },

  async createPayHead(session: Session, companyId: string, input: {
    name: string; headType: string; calcType?: string; valuePaise?: number; percentBp?: number
    statutory?: string | null; ledgerId?: string | null
  }) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const name = input.name.trim()
    if (!name) throw ApiError.badRequest('Pay head name is required.')
    if (!['earning', 'deduction', 'employer_contribution'].includes(input.headType)) {
      throw ApiError.badRequest('Head type must be earning, deduction or employer_contribution.')
    }
    if (input.ledgerId) {
      const l = await prisma.bookkeepingLedger.findFirst({ where: { id: input.ledgerId, tallyCompanyId: companyId, ...alive } })
      if (!l) throw ApiError.badRequest('That ledger does not belong to this company.')
    }
    const clash = await prisma.bookkeepingPayHead.findFirst({ where: { tallyCompanyId: companyId, name, ...alive } })
    if (clash) throw ApiError.conflict('duplicate_name', `A pay head named "${name}" already exists.`)
    const p = await prisma.bookkeepingPayHead.create({
      data: {
        tallyCompanyId: companyId, name, headType: input.headType, calcType: input.calcType ?? 'flat',
        valuePaise: input.valuePaise ?? 0, percentBp: input.percentBp ?? 0,
        statutory: input.statutory ?? null, ledgerId: input.ledgerId ?? null,
      },
    })
    return { id: p.id, name: p.name, head_type: p.headType }
  },

  async setStructure(session: Session, companyId: string, employeeId: string, lines: { payHeadId: string; valuePaise?: number; percentBp?: number }[]) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const emp = await prisma.bookkeepingEmployee.findFirst({ where: { id: employeeId, tallyCompanyId: companyId, ...alive } })
    if (!emp) throw ApiError.notFound('No such employee.')
    const heads = await prisma.bookkeepingPayHead.findMany({ where: { tallyCompanyId: companyId, id: { in: lines.map((l) => l.payHeadId) }, ...alive } })
    if (heads.length !== new Set(lines.map((l) => l.payHeadId)).size) {
      throw ApiError.badRequest('A pay head in this structure does not belong to this company.')
    }
    await prisma.$transaction(async (tx) => {
      await tx.bookkeepingSalaryStructureLine.deleteMany({ where: { employeeId } })
      for (const l of lines) {
        await tx.bookkeepingSalaryStructureLine.create({
          data: {
            tallyCompanyId: companyId, employeeId, payHeadId: l.payHeadId,
            valuePaise: l.valuePaise ?? 0, percentBp: l.percentBp ?? 0,
          },
        })
      }
    })
    return { employee_id: employeeId, lines: lines.length }
  },

  async setAttendance(session: Session, companyId: string, period: string, rows: { employeeId: string; payableDays: number; presentDays: number; lopDays?: number }[]) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    if (!MONTH_RE.test(period)) throw ApiError.badRequest('Period must be YYYY-MM.')
    for (const r of rows) {
      await prisma.bookkeepingAttendanceRecord.upsert({
        where: { employeeId_period: { employeeId: r.employeeId, period } },
        create: {
          tallyCompanyId: companyId, employeeId: r.employeeId, period,
          payableDays: r.payableDays, presentDays: r.presentDays, lopDays: r.lopDays ?? Math.max(r.payableDays - r.presentDays, 0),
        },
        update: {
          payableDays: r.payableDays, presentDays: r.presentDays, lopDays: r.lopDays ?? Math.max(r.payableDays - r.presentDays, 0),
        },
      })
    }
    return { period, employees: rows.length }
  },

  async getAttendance(session: Session, companyId: string, period: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const rows = await prisma.bookkeepingAttendanceRecord.findMany({
      where: { tallyCompanyId: companyId, period },
      include: { employee: { select: { name: true } } },
    })
    return rows.map((r) => ({
      employee_id: r.employeeId, employee_name: r.employee.name, period: r.period,
      payable_days: r.payableDays, present_days: r.presentDays, lop_days: r.lopDays,
    }))
  },

  /**
   * Process a month. Earnings come from each employee's structure,
   * pro-rated by attendance where the pay head says so; statutory
   * deductions use the company's payroll settings.
   */
  async process(session: Session, companyId: string, period: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    if (!MONTH_RE.test(period)) throw ApiError.badRequest('Period must be YYYY-MM.')
    const existing = await prisma.bookkeepingPayrollRun.findFirst({ where: { tallyCompanyId: companyId, period, ...alive } })
    if (existing?.status === 'posted') throw ApiError.conflict('already_posted', `Payroll for ${period} is already posted.`)

    const [settings, employees, attendance] = await Promise.all([
      BookkeepingSettingsService.get(companyId, 'payroll'),
      prisma.bookkeepingEmployee.findMany({
        where: { tallyCompanyId: companyId, ...alive, active: true },
        include: { structureLines: { include: { payHead: true } } },
      }),
      prisma.bookkeepingAttendanceRecord.findMany({ where: { tallyCompanyId: companyId, period } }),
    ])
    const attendanceBy = new Map(attendance.map((a) => [a.employeeId, a]))

    const lines: { employeeId: string; payHeadId: string; headType: string; amountPaise: number }[] = []
    for (const e of employees) {
      const att = attendanceBy.get(e.id)
      const ratio = att && att.payableDays > 0 ? att.presentDays / att.payableDays : 1
      const basicLine = e.structureLines.find((s) => s.payHead.name.toLowerCase().includes('basic'))
      const basic = basicLine ? basicLine.valuePaise || basicLine.payHead.valuePaise : 0

      for (const s of e.structureLines) {
        const head = s.payHead
        if (!head.active) continue
        let amount = 0
        const percentBp = s.percentBp || head.percentBp || statutoryBp(head.statutory, head.headType, settings)
        if (head.calcType === 'percent_of_basic' || (percentBp && !s.valuePaise && !head.valuePaise)) {
          amount = applyBp(basic, percentBp)
        } else {
          amount = s.valuePaise || head.valuePaise
        }
        if (head.calcType === 'attendance') amount = Math.round(amount * ratio)
        else if (head.headType === 'earning') amount = Math.round(amount * ratio)
        if (amount === 0) continue
        lines.push({ employeeId: e.id, payHeadId: head.id, headType: head.headType, amountPaise: amount })
      }
    }

    const gross = lines.filter((l) => l.headType === 'earning').reduce((s, l) => s + l.amountPaise, 0)
    const deductions = lines.filter((l) => l.headType === 'deduction').reduce((s, l) => s + l.amountPaise, 0)

    const run = await prisma.$transaction(async (tx) => {
      const r = existing
        ? await tx.bookkeepingPayrollRun.update({
            where: { id: existing.id },
            data: { status: 'processed', grossPaise: gross, deductionsPaise: deductions, netPaise: gross - deductions, processedByUserId: session.userId },
          })
        : await tx.bookkeepingPayrollRun.create({
            data: {
              tallyCompanyId: companyId, period, status: 'processed',
              grossPaise: gross, deductionsPaise: deductions, netPaise: gross - deductions,
              processedByUserId: session.userId,
            },
          })
      await tx.bookkeepingPayrollLine.deleteMany({ where: { payrollRunId: r.id } })
      for (const l of lines) {
        await tx.bookkeepingPayrollLine.create({
          data: { tallyCompanyId: companyId, payrollRunId: r.id, employeeId: l.employeeId, payHeadId: l.payHeadId, headType: l.headType, amountPaise: l.amountPaise },
        })
      }
      return r
    })

    return BookkeepingPayrollService.getRun(session, companyId, run.id)
  },

  async getRun(session: Session, companyId: string, runId: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const run = await prisma.bookkeepingPayrollRun.findFirst({
      where: { id: runId, tallyCompanyId: companyId, ...alive },
      include: { lines: { include: { employee: { select: { name: true } }, payHead: { select: { name: true, headType: true, ledgerId: true } } } } },
    })
    if (!run) throw ApiError.notFound('No such payroll run.')
    const byEmployee = new Map<string, { employee_id: string; employee_name: string; earnings: { name: string; amount_paise: number }[]; deductions: { name: string; amount_paise: number }[]; gross_paise: number; deductions_paise: number; net_paise: number }>()
    for (const l of run.lines) {
      if (!byEmployee.has(l.employeeId)) {
        byEmployee.set(l.employeeId, {
          employee_id: l.employeeId, employee_name: l.employee.name,
          earnings: [], deductions: [], gross_paise: 0, deductions_paise: 0, net_paise: 0,
        })
      }
      const slip = byEmployee.get(l.employeeId)!
      if (l.headType === 'earning') { slip.earnings.push({ name: l.payHead.name, amount_paise: l.amountPaise }); slip.gross_paise += l.amountPaise }
      else if (l.headType === 'deduction') { slip.deductions.push({ name: l.payHead.name, amount_paise: l.amountPaise }); slip.deductions_paise += l.amountPaise }
    }
    for (const s of byEmployee.values()) s.net_paise = s.gross_paise - s.deductions_paise
    return {
      id: run.id, period: run.period, status: run.status,
      gross_paise: run.grossPaise, deductions_paise: run.deductionsPaise, net_paise: run.netPaise,
      voucher_id: run.voucherId, created_at: run.createdAt.toISOString(),
      payslips: Array.from(byEmployee.values()).sort((a, b) => a.employee_name.localeCompare(b.employee_name)),
    }
  },

  async listRuns(session: Session, companyId: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const rows = await prisma.bookkeepingPayrollRun.findMany({ where: { tallyCompanyId: companyId, ...alive }, orderBy: { period: 'desc' } })
    return rows.map((r) => ({
      id: r.id, period: r.period, status: r.status, gross_paise: r.grossPaise,
      deductions_paise: r.deductionsPaise, net_paise: r.netPaise, voucher_id: r.voucherId,
    }))
  },

  /**
   * Post the run as a payroll voucher.
   *   Dr each earning head's expense ledger
   *   Cr each deduction head's payable ledger
   *   Cr the payment ledger (bank / cash / salary payable) with the net
   * The engine refuses it if those three do not balance.
   */
  async post(session: Session, companyId: string, runId: string, input: { date: string; paymentLedgerId: string; defaultExpenseLedgerId?: string }) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const run = await prisma.bookkeepingPayrollRun.findFirst({
      where: { id: runId, tallyCompanyId: companyId, ...alive },
      include: { lines: { include: { payHead: true } } },
    })
    if (!run) throw ApiError.notFound('No such payroll run.')
    if (run.status === 'posted') throw ApiError.conflict('already_posted', 'This run is already posted.')
    if (!run.lines.length) throw ApiError.unprocessable('empty_run', 'This run has no payroll lines to post.')

    const byLedger = new Map<string, { dr: number; cr: number }>()
    const add = (ledgerId: string, side: 'dr' | 'cr', amount: number) => {
      if (!byLedger.has(ledgerId)) byLedger.set(ledgerId, { dr: 0, cr: 0 })
      byLedger.get(ledgerId)![side] += amount
    }
    for (const l of run.lines) {
      const ledgerId = l.payHead.ledgerId ?? input.defaultExpenseLedgerId
      if (!ledgerId) {
        throw ApiError.unprocessable('unmapped_pay_head', `Pay head "${l.payHead.name}" has no ledger. Map it, or supply a default expense ledger.`)
      }
      if (l.headType === 'earning' || l.headType === 'employer_contribution') add(ledgerId, 'dr', l.amountPaise)
      else add(ledgerId, 'cr', l.amountPaise)
    }
    add(input.paymentLedgerId, 'cr', run.netPaise)

    const entries: EntryInput[] = []
    for (const [ledgerId, sides] of byLedger) {
      const net = sides.dr - sides.cr
      if (net === 0) continue
      entries.push({ ledgerId, entryType: net > 0 ? 'dr' : 'cr', amountPaise: Math.abs(net) })
    }

    const posted = await postVoucher(companyId, {
      voucherTypeCode: 'payroll',
      date: input.date,
      narration: `Payroll for ${run.period}`,
      entries,
    }, session.userId)

    await prisma.bookkeepingPayrollRun.update({ where: { id: runId }, data: { status: 'posted', voucherId: posted.id } })
    return BookkeepingPayrollService.getRun(session, companyId, runId)
  },
}

/** Statutory percentage from settings when the pay head does not carry one. */
function statutoryBp(statutory: string | null, headType: string, settings: Record<string, unknown>): number {
  if (!statutory) return 0
  const num = (k: string) => (typeof settings[k] === 'number' ? settings[k] as number : 0)
  if (statutory === 'pf') return headType === 'deduction' ? num('pf_employee_pct_bp') : num('pf_employer_pct_bp')
  if (statutory === 'esi') return headType === 'deduction' ? num('esi_employee_pct_bp') : num('esi_employer_pct_bp')
  return 0
}
