import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import type { PayrollDeductions, PayrollEarnings } from '../../domain/payroll/calc.js'

/**
 * REPORTS (§8.10)
 *
 *   GET /api/reports/:type
 *     attendance  per-employee summary for a period
 *     leave       utilisation by employee, per leave type
 *     payroll     salary summary for one payroll run
 *     expenses    per-employee and per-category summary for a period
 *
 * RBAC is applied at QUERY level, not as a response filter: the caller's scope
 * decides which employee ids enter the `where`, so a Department Manager's
 * query cannot return another department's rows even by accident.
 *
 *   attendance / leave  Employee=self, Manager=dept, HR/MD=org, Finance=denied
 *   payroll / expenses  Employee=self, Finance/MD=org, HR/Manager=denied
 */
export const reportsRouter = Router()

type ReportScope = Scope | 'blocked'

/** Scope for the people-facing reports (attendance, leave). */
function peopleScope(session: Session): ReportScope {
  if (can(session, 'reports.all', 'organisation')) return 'organisation'
  if (can(session, 'reports.hr', 'organisation')) return 'organisation'
  if (can(session, 'reports.hr', 'department')) return 'department'
  if (can(session, 'reports.hr', 'self')) return 'self'
  return 'blocked'
}

/** Scope for the money-facing reports (payroll, expenses). */
function financeScope(session: Session): ReportScope {
  if (can(session, 'reports.all', 'organisation')) return 'organisation'
  if (can(session, 'reports.finance', 'organisation')) return 'organisation'
  // An employee may see their own expense history; nothing wider.
  if (can(session, 'expense.submit', 'self')) return 'self'
  return 'blocked'
}

/** Employee ids the caller may report on, before explicit filters. */
async function employeesInScope(scope: ReportScope, session: Session) {
  if (scope === 'organisation') {
    return prisma.employee.findMany({ where: { deletedAt: null }, orderBy: { employeeCode: 'asc' } })
  }
  if (scope === 'department') {
    return prisma.employee.findMany({
      where: { deletedAt: null, departmentId: session.departmentId ?? '__none__' },
      orderBy: { employeeCode: 'asc' },
    })
  }
  if (scope === 'self' && session.employeeId) {
    return prisma.employee.findMany({ where: { id: session.employeeId } })
  }
  return []
}

const querySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  departmentId: z.string().optional(),
  employeeId: z.string().optional(),
  runId: z.string().optional(),
})

reportsRouter.get('/:type', handler(async (req, res) => {
  const session = requireSession(req)
  const type = req.params.type
  const parsed = querySchema.safeParse(req.query)
  if (!parsed.success) {
    throw ApiError.unprocessable('invalid_filters', 'Check the report filters.', parsed.error.flatten().fieldErrors)
  }
  const q = parsed.data
  const generated_at = new Date().toISOString()

  // ── Attendance ──────────────────────────────────────────────────────────
  if (type === 'attendance') {
    const scope = peopleScope(session)
    if (scope === 'blocked') throw ApiError.forbidden()
    let employees = await employeesInScope(scope, session)
    if (q.departmentId) employees = employees.filter((e) => e.departmentId === q.departmentId)
    if (q.employeeId) {
      const target = employees.find((e) => e.id === q.employeeId)
      if (!target) throw ApiError.forbidden()
      employees = [target]
    }

    const rows = await prisma.attendance.findMany({
      where: {
        deletedAt: null,
        employeeId: { in: employees.map((e) => e.id) },
        ...(q.from || q.to ? { date: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      },
      select: { employeeId: true, status: true, locationType: true, workedMinutes: true },
    })

    const items = employees.map((e) => {
      const att = rows.filter((a) => a.employeeId === e.id)
      const count = (s: string) => att.filter((a) => a.status === s).length
      const minutes = att.reduce((sum, a) => sum + (a.workedMinutes ?? 0), 0)
      return {
        employee_id: e.id,
        employee_code: e.employeeCode,
        full_name: e.fullName,
        department_id: e.departmentId,
        days_recorded: att.length,
        present: count('present'),
        late: count('late'),
        half_day: count('half_day'),
        wfh: count('wfh'),
        absent: count('absent'),
        on_leave: count('on_leave'),
        missing_check_out: count('missing_check_out'),
        off_site_days: att.filter((a) => a.locationType && a.locationType !== 'office').length,
        hours: Math.round((minutes / 60) * 100) / 100,
      }
    })
    return ok(res, { type, items, generated_at, scope })
  }

  // ── Leave utilisation ───────────────────────────────────────────────────
  if (type === 'leave') {
    const scope = peopleScope(session)
    if (scope === 'blocked') throw ApiError.forbidden()
    let employees = await employeesInScope(scope, session)
    if (q.departmentId) employees = employees.filter((e) => e.departmentId === q.departmentId)
    if (q.employeeId) {
      const target = employees.find((e) => e.id === q.employeeId)
      if (!target) throw ApiError.forbidden()
      employees = [target]
    }
    const ids = employees.map((e) => e.id)

    const [types, balances, pending] = await Promise.all([
      prisma.leaveType.findMany({ where: { deletedAt: null }, orderBy: { code: 'asc' } }),
      prisma.leaveBalance.findMany({ where: { employeeId: { in: ids } } }),
      prisma.leaveRequest.findMany({
        where: { employeeId: { in: ids }, status: 'pending', deletedAt: null },
        select: { employeeId: true, leaveTypeId: true, computedWorkingDays: true },
      }),
    ])

    const items = employees.map((e) => ({
      employee_id: e.id,
      employee_code: e.employeeCode,
      full_name: e.fullName,
      department_id: e.departmentId,
      by_type: types.map((t) => {
        const b = balances.find((x) => x.employeeId === e.id && x.leaveTypeId === t.id)
        const pendingDays = pending
          .filter((p) => p.employeeId === e.id && p.leaveTypeId === t.id)
          .reduce((s, p) => s + p.computedWorkingDays, 0)
        // Carry-forward is entitlement too — it is spendable this year.
        const entitled = (b?.entitled ?? 0) + (b?.carriedForward ?? 0)
        const availed = b?.availed ?? 0
        return {
          type_code: t.code,
          type_name: t.name,
          entitled,
          availed,
          pending: pendingDays,
          available: Math.max(0, entitled - availed - pendingDays),
        }
      }),
    }))
    return ok(res, { type, items, generated_at, scope })
  }

  // ── Payroll (one run) ───────────────────────────────────────────────────
  if (type === 'payroll') {
    const scope = financeScope(session)
    if (scope === 'blocked') throw ApiError.forbidden()
    if (!can(session, 'payroll.view', 'organisation') && !can(session, 'payroll.view.own', 'self')) {
      throw ApiError.forbidden()
    }

    // Default to the newest processed run — the one people actually ask about.
    const run = q.runId
      ? await prisma.payrollRun.findFirst({ where: { id: q.runId, deletedAt: null } })
      : await prisma.payrollRun.findFirst({
          where: { stage: 'processed', deletedAt: null },
          orderBy: { periodStart: 'desc' },
        })
    if (!run) throw ApiError.notFound('No payroll run found.')

    const departmentEmployeeIds = q.departmentId && scope !== 'self'
      ? (await prisma.employee.findMany({
          where: { departmentId: q.departmentId }, select: { id: true },
        })).map((e) => e.id)
      : null

    const rows = await prisma.payrollItem.findMany({
      where: {
        payrollRunId: run.id,
        deletedAt: null,
        ...(scope === 'self' ? { employeeId: session.employeeId ?? '__none__' } : {}),
        ...(departmentEmployeeIds ? { employeeId: { in: departmentEmployeeIds } } : {}),
      },
      include: { employee: true },
      orderBy: { employee: { employeeCode: 'asc' } },
    })

    const items = rows.map((i) => {
      const earnings = JSON.parse(i.earningsJson) as PayrollEarnings
      const deductions = JSON.parse(i.deductionsJson) as PayrollDeductions
      return {
        employee_id: i.employeeId,
        employee_code: i.employee.employeeCode,
        full_name: i.employee.fullName,
        department_id: i.employee.departmentId,
        payable_days: i.payableDays,
        lop_days: i.lopDays,
        basic_paise: earnings.basic_paise,
        hra_paise: earnings.hra_paise,
        gross_paise: i.grossPaise,
        pf_paise: deductions.pf_employee_paise,
        esi_paise: deductions.esi_employee_paise,
        pt_paise: deductions.pt_paise,
        tds_paise: deductions.tds_paise,
        lop_paise: deductions.lop_paise,
        total_deductions_paise: i.totalDeductionsPaise,
        net_paise: i.netPaise,
      }
    })

    return ok(res, {
      type,
      run: { id: run.id, period_start: run.periodStart, period_end: run.periodEnd, stage: run.stage },
      items,
      totals: {
        gross_paise: items.reduce((s, r) => s + r.gross_paise, 0),
        deductions_paise: items.reduce((s, r) => s + r.total_deductions_paise, 0),
        net_paise: items.reduce((s, r) => s + r.net_paise, 0),
      },
      generated_at,
      scope,
    })
  }

  // ── Expenses ────────────────────────────────────────────────────────────
  if (type === 'expenses') {
    const scope = financeScope(session)
    if (scope === 'blocked') throw ApiError.forbidden()
    if (scope === 'self' && q.employeeId && q.employeeId !== session.employeeId) {
      throw ApiError.forbidden()
    }

    const departmentEmployeeIds = q.departmentId && scope !== 'self'
      ? (await prisma.employee.findMany({
          where: { departmentId: q.departmentId }, select: { id: true },
        })).map((e) => e.id)
      : null

    const expenses = await prisma.expense.findMany({
      where: {
        deletedAt: null,
        ...(q.from || q.to
          ? { expenseDate: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
          : {}),
        ...(scope === 'self' ? { employeeId: session.employeeId ?? '__none__' } : {}),
        ...(departmentEmployeeIds ? { employeeId: { in: departmentEmployeeIds } } : {}),
        ...(q.employeeId ? { employeeId: q.employeeId } : {}),
      },
      include: { employee: true, category: true },
    })

    const byEmployee = new Map<string, {
      employee_id: string; employee_code: string; full_name: string; department_id: string
      count: number; drafts: number; claimed_paise: number; reimbursed_paise: number
    }>()
    for (const e of expenses) {
      let row = byEmployee.get(e.employeeId)
      if (!row) {
        row = {
          employee_id: e.employeeId,
          employee_code: e.employee.employeeCode,
          full_name: e.employee.fullName,
          department_id: e.employee.departmentId,
          count: 0, drafts: 0, claimed_paise: 0, reimbursed_paise: 0,
        }
        byEmployee.set(e.employeeId, row)
      }
      row.count += 1
      if (e.stage === 'draft') row.drafts += 1
      // "Claimed" means submitted for money — a draft is not a claim and a
      // rejected one never became a liability.
      if (e.stage !== 'draft' && e.stage !== 'rejected') row.claimed_paise += e.amountPaise
      if (e.stage === 'paid') row.reimbursed_paise += e.amountPaise
    }

    const byCategory = new Map<string, {
      category_id: string; category_code: string; category_name: string
      count: number; reimbursed_paise: number
    }>()
    for (const e of expenses) {
      let row = byCategory.get(e.categoryId)
      if (!row) {
        row = {
          category_id: e.categoryId,
          category_code: e.category.code,
          category_name: e.category.name,
          count: 0, reimbursed_paise: 0,
        }
        byCategory.set(e.categoryId, row)
      }
      row.count += 1
      if (e.stage === 'paid') row.reimbursed_paise += e.amountPaise
    }

    const items = [...byEmployee.values()]
    return ok(res, {
      type,
      items,
      by_category: [...byCategory.values()],
      totals: {
        expense_count: expenses.length,
        claimed_paise: items.reduce((s, r) => s + r.claimed_paise, 0),
        reimbursed_paise: items.reduce((s, r) => s + r.reimbursed_paise, 0),
      },
      generated_at,
      scope,
    })
  }

  throw new ApiError(400, 'unknown_type', `Unknown report type: ${type}`)
}))
