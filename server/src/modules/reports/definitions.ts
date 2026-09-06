import { prisma } from '../../lib/prisma.js'
import { compareHHMM, istTimeOf, monthLabel } from '../../lib/dates.js'
import type { Session } from '../../platform/auth.js'
import { can } from '../../platform/auth.js'
import { employeeIdsInScope, widestScope } from '../../platform/scope.js'
import type { PayrollDeductions } from '../../domain/payroll/calc.js'
import type { PermissionCode } from '../../platform/rbac/matrix.js'

/**
 * REPORTS (§8.10).
 *
 * Every report resolves the caller's scope FIRST and folds it into the Prisma
 * `where`, so a Department Manager's query can never return another
 * department's rows. Nothing is filtered in memory after the fact.
 *
 * A report is a definition, not a route: adding one is a new entry in this
 * array — the catalogue, the filters, the table and the CSV/XLSX export all
 * follow from `columns`.
 */

export type ColumnType = 'text' | 'number' | 'currency' | 'date' | 'days'

export interface ReportColumn {
  key: string
  label: string
  type: ColumnType
}

export interface ReportFilters {
  from?: string
  to?: string
  departmentId?: string
  employeeId?: string
  search?: string
  page: number
  pageSize: number
}

export interface ReportDefinition {
  key: string
  label: string
  group: 'Attendance' | 'Leave' | 'Payroll' | 'Expenses'
  /** Any ONE of these opens the report. */
  permissions: PermissionCode[]
  columns: ReportColumn[]
  run: (session: Session, filters: ReportFilters) => Promise<{ rows: Record<string, unknown>[]; total: number }>
}

const LATE_AFTER = '09:45'

const EMP_COLS: ReportColumn[] = [
  { key: 'employee_code', label: 'Employee ID', type: 'text' },
  { key: 'employee_name', label: 'Employee', type: 'text' },
  { key: 'department', label: 'Department', type: 'text' },
]

/** Reports read across HR and finance data; scope follows the widest read grant. */
async function scopedEmployeeIds(session: Session, filters: ReportFilters): Promise<string[]> {
  const scope = widestScope(session, 'employee.read', 'employee.read.restricted', 'attendance.read', 'leave.read')
    ?? 'self'
  const ids = await employeeIdsInScope(session, scope)

  const where: Record<string, unknown> = { deletedAt: null }
  if (ids !== 'ALL') where.id = { in: ids }
  if (filters.departmentId) where.departmentId = filters.departmentId
  if (filters.employeeId) {
    // An out-of-scope employeeId filter yields nothing, never someone else's rows.
    where.id = ids === 'ALL' || ids.includes(filters.employeeId) ? filters.employeeId : '__out_of_scope__'
  }
  if (filters.search) {
    where.OR = [
      { fullName: { contains: filters.search } },
      { employeeCode: { contains: filters.search } },
    ]
  }
  const rows = await prisma.employee.findMany({ where, select: { id: true } })
  return rows.map((r) => r.id)
}

function dateRange(filters: ReportFilters) {
  return {
    ...(filters.from ? { gte: filters.from } : {}),
    ...(filters.to ? { lte: filters.to } : {}),
  }
}

function paginate<T>(rows: T[], filters: ReportFilters) {
  const start = (filters.page - 1) * filters.pageSize
  return { rows: rows.slice(start, start + filters.pageSize), total: rows.length }
}

function empCols(e: { employeeCode: string; fullName: string; department: { name: string } }) {
  return {
    employee_code: e.employeeCode,
    employee_name: e.fullName,
    department: e.department.name,
  }
}

export const REPORTS: ReportDefinition[] = [
  // ── Attendance ──────────────────────────────────────────────────────────
  {
    key: 'attendance-daily',
    label: 'Daily attendance',
    group: 'Attendance',
    permissions: ['reports.hr', 'reports.all'],
    columns: [
      { key: 'date', label: 'Date', type: 'date' },
      ...EMP_COLS,
      { key: 'status', label: 'Status', type: 'text' },
      { key: 'check_in', label: 'Check in', type: 'text' },
      { key: 'check_out', label: 'Check out', type: 'text' },
      { key: 'worked_hours', label: 'Hours', type: 'number' },
      { key: 'location', label: 'Location', type: 'text' },
    ],
    async run(session, filters) {
      const ids = await scopedEmployeeIds(session, filters)
      const where = {
        deletedAt: null, employeeId: { in: ids },
        ...(filters.from || filters.to ? { date: dateRange(filters) } : {}),
      }
      const [rows, total] = await Promise.all([
        prisma.attendance.findMany({
          where, include: { employee: { include: { department: true } } },
          orderBy: [{ date: 'desc' }, { employeeId: 'asc' }],
          take: filters.pageSize, skip: (filters.page - 1) * filters.pageSize,
        }),
        prisma.attendance.count({ where }),
      ])
      return {
        total,
        rows: rows.map((a) => ({
          date: a.date,
          ...empCols(a.employee),
          status: a.status,
          check_in: a.checkInAt ? istTimeOf(a.checkInAt) : '—',
          check_out: a.checkOutAt ? istTimeOf(a.checkOutAt) : '—',
          worked_hours: Number(((a.workedMinutes ?? 0) / 60).toFixed(2)),
          location: a.locationType && a.locationType !== 'office'
            ? `Off-site — ${a.locationType.replace('_', ' ')}`
            : 'Office',
        })),
      }
    },
  },
  {
    key: 'attendance-monthly',
    label: 'Monthly attendance summary',
    group: 'Attendance',
    permissions: ['reports.hr', 'reports.all'],
    columns: [
      ...EMP_COLS,
      { key: 'present', label: 'Present', type: 'days' },
      { key: 'absent', label: 'Absent', type: 'days' },
      { key: 'leave', label: 'Leave', type: 'days' },
      { key: 'offsite', label: 'Off-site', type: 'days' },
      { key: 'worked_hours', label: 'Hours worked', type: 'number' },
    ],
    async run(session, filters) {
      const ids = await scopedEmployeeIds(session, filters)
      const rows = await prisma.attendance.findMany({
        where: {
          deletedAt: null, employeeId: { in: ids },
          ...(filters.from || filters.to ? { date: dateRange(filters) } : {}),
        },
        include: { employee: { include: { department: true } } },
      })
      const map = new Map<string, Record<string, number | string>>()
      for (const a of rows) {
        if (!map.has(a.employeeId)) {
          map.set(a.employeeId, { ...empCols(a.employee), present: 0, absent: 0, leave: 0, offsite: 0, worked_hours: 0 })
        }
        const r = map.get(a.employeeId)!
        if (a.status === 'present' || a.status === 'late' || a.status === 'wfh') r.present = (r.present as number) + 1
        if (a.status === 'half_day') r.present = (r.present as number) + 0.5
        if (a.status === 'absent') r.absent = (r.absent as number) + 1
        if (a.status === 'on_leave') r.leave = (r.leave as number) + 1
        if (a.locationType && a.locationType !== 'office') r.offsite = (r.offsite as number) + 1
        r.worked_hours = Number(((r.worked_hours as number) + (a.workedMinutes ?? 0) / 60).toFixed(2))
      }
      return paginate([...map.values()], filters)
    },
  },
  {
    key: 'attendance-late-arrivals',
    label: 'Late arrivals',
    group: 'Attendance',
    permissions: ['reports.hr', 'reports.all'],
    columns: [
      { key: 'date', label: 'Date', type: 'date' },
      ...EMP_COLS,
      { key: 'check_in', label: 'Check in', type: 'text' },
      { key: 'late_by_minutes', label: 'Late by (min)', type: 'number' },
    ],
    async run(session, filters) {
      const ids = await scopedEmployeeIds(session, filters)
      const rows = await prisma.attendance.findMany({
        where: {
          deletedAt: null, employeeId: { in: ids }, checkInAt: { not: null },
          ...(filters.from || filters.to ? { date: dateRange(filters) } : {}),
        },
        include: { employee: { include: { department: true } } },
        orderBy: { date: 'desc' },
      })
      const late = rows
        .map((a) => ({ a, lateBy: compareHHMM(istTimeOf(a.checkInAt!), LATE_AFTER) }))
        .filter((x) => x.lateBy > 0)
        .map(({ a, lateBy }) => ({
          date: a.date,
          ...empCols(a.employee),
          check_in: istTimeOf(a.checkInAt!),
          late_by_minutes: lateBy,
        }))
      return paginate(late, filters)
    },
  },
  {
    key: 'attendance-missing-checkouts',
    label: 'Missing check-outs',
    group: 'Attendance',
    permissions: ['reports.hr', 'reports.all'],
    columns: [
      { key: 'date', label: 'Date', type: 'date' },
      ...EMP_COLS,
      { key: 'check_in', label: 'Check in', type: 'text' },
    ],
    async run(session, filters) {
      const ids = await scopedEmployeeIds(session, filters)
      const where = {
        deletedAt: null, employeeId: { in: ids }, checkInAt: { not: null }, checkOutAt: null,
        ...(filters.from || filters.to ? { date: dateRange(filters) } : {}),
      }
      const [rows, total] = await Promise.all([
        prisma.attendance.findMany({
          where, include: { employee: { include: { department: true } } },
          orderBy: { date: 'desc' },
          take: filters.pageSize, skip: (filters.page - 1) * filters.pageSize,
        }),
        prisma.attendance.count({ where }),
      ])
      return {
        total,
        rows: rows.map((a) => ({ date: a.date, ...empCols(a.employee), check_in: istTimeOf(a.checkInAt!) })),
      }
    },
  },
  {
    key: 'attendance-offsite',
    label: 'Off-site days',
    group: 'Attendance',
    permissions: ['reports.hr', 'reports.all'],
    columns: [
      { key: 'date', label: 'Date', type: 'date' },
      ...EMP_COLS,
      { key: 'location_type', label: 'Type', type: 'text' },
      { key: 'reason', label: 'Reason', type: 'text' },
    ],
    async run(session, filters) {
      const ids = await scopedEmployeeIds(session, filters)
      const where = {
        deletedAt: null, employeeId: { in: ids },
        locationType: { in: ['client_site', 'remote', 'field'] },
        ...(filters.from || filters.to ? { date: dateRange(filters) } : {}),
      }
      const [rows, total] = await Promise.all([
        prisma.attendance.findMany({
          where, include: { employee: { include: { department: true } } },
          orderBy: { date: 'desc' },
          take: filters.pageSize, skip: (filters.page - 1) * filters.pageSize,
        }),
        prisma.attendance.count({ where }),
      ])
      return {
        total,
        rows: rows.map((a) => ({
          date: a.date,
          ...empCols(a.employee),
          location_type: a.locationType ?? '—',
          reason: a.offSiteReason ?? '—',
        })),
      }
    },
  },
  // ── Leave ───────────────────────────────────────────────────────────────
  {
    key: 'leave-utilisation',
    label: 'Leave utilisation',
    group: 'Leave',
    permissions: ['reports.hr', 'reports.all'],
    columns: [
      ...EMP_COLS,
      { key: 'leave_type', label: 'Type', type: 'text' },
      { key: 'days', label: 'Days', type: 'days' },
      { key: 'requests', label: 'Requests', type: 'number' },
    ],
    async run(session, filters) {
      const ids = await scopedEmployeeIds(session, filters)
      const rows = await prisma.leaveRequest.findMany({
        where: {
          deletedAt: null, employeeId: { in: ids }, status: 'approved',
          ...(filters.from || filters.to ? { startDate: dateRange(filters) } : {}),
        },
        include: { employee: { include: { department: true } }, leaveType: true },
      })
      const map = new Map<string, Record<string, number | string>>()
      for (const l of rows) {
        const key = `${l.employeeId}:${l.leaveTypeId}`
        if (!map.has(key)) {
          map.set(key, { ...empCols(l.employee), leave_type: l.leaveType.name, days: 0, requests: 0 })
        }
        const r = map.get(key)!
        r.days = (r.days as number) + l.computedWorkingDays
        r.requests = (r.requests as number) + 1
      }
      return paginate([...map.values()], filters)
    },
  },
  {
    key: 'leave-pending',
    label: 'Pending leave requests',
    group: 'Leave',
    permissions: ['reports.hr', 'reports.all'],
    columns: [
      ...EMP_COLS,
      { key: 'leave_type', label: 'Type', type: 'text' },
      { key: 'start_date', label: 'From', type: 'date' },
      { key: 'end_date', label: 'To', type: 'date' },
      { key: 'days', label: 'Days', type: 'days' },
      { key: 'stage', label: 'Awaiting', type: 'text' },
    ],
    async run(session, filters) {
      const ids = await scopedEmployeeIds(session, filters)
      const where = { deletedAt: null, employeeId: { in: ids }, status: 'pending' }
      const [rows, total] = await Promise.all([
        prisma.leaveRequest.findMany({
          where, include: { employee: { include: { department: true } }, leaveType: true },
          orderBy: { startDate: 'asc' },
          take: filters.pageSize, skip: (filters.page - 1) * filters.pageSize,
        }),
        prisma.leaveRequest.count({ where }),
      ])
      return {
        total,
        rows: rows.map((l) => ({
          ...empCols(l.employee),
          leave_type: l.leaveType.name,
          start_date: l.startDate,
          end_date: l.endDate,
          days: l.computedWorkingDays,
          stage: l.approverId ? 'HR' : 'Manager',
        })),
      }
    },
  },
  // ── Payroll ─────────────────────────────────────────────────────────────
  {
    key: 'payroll-monthly',
    label: 'Monthly payroll',
    group: 'Payroll',
    permissions: ['reports.finance', 'reports.all'],
    columns: [
      { key: 'period', label: 'Period', type: 'text' },
      ...EMP_COLS,
      { key: 'payable_days', label: 'Payable days', type: 'days' },
      { key: 'lop_days', label: 'LOP days', type: 'days' },
      { key: 'gross_paise', label: 'Gross', type: 'currency' },
      { key: 'deductions_paise', label: 'Deductions', type: 'currency' },
      { key: 'net_paise', label: 'Net pay', type: 'currency' },
    ],
    async run(session, filters) {
      const ids = await scopedEmployeeIds(session, filters)
      const where = {
        deletedAt: null, employeeId: { in: ids },
        payrollRun: {
          deletedAt: null,
          ...(filters.from || filters.to ? { periodEnd: dateRange(filters) } : {}),
        },
      }
      const [rows, total] = await Promise.all([
        prisma.payrollItem.findMany({
          where,
          include: { employee: { include: { department: true } }, payrollRun: true },
          orderBy: { payrollRun: { periodStart: 'desc' } },
          take: filters.pageSize, skip: (filters.page - 1) * filters.pageSize,
        }),
        prisma.payrollItem.count({ where }),
      ])
      return {
        total,
        rows: rows.map((i) => ({
          period: monthLabel(i.payrollRun.periodStart),
          ...empCols(i.employee),
          payable_days: i.payableDays,
          lop_days: i.lopDays,
          gross_paise: i.grossPaise,
          deductions_paise: i.totalDeductionsPaise,
          net_paise: i.netPaise,
        })),
      }
    },
  },
  {
    key: 'payroll-deductions',
    label: 'Deductions summary',
    group: 'Payroll',
    permissions: ['reports.finance', 'reports.all'],
    columns: [
      { key: 'period', label: 'Period', type: 'text' },
      ...EMP_COLS,
      { key: 'pf_paise', label: 'PF', type: 'currency' },
      { key: 'esi_paise', label: 'ESI', type: 'currency' },
      { key: 'pt_paise', label: 'Professional Tax', type: 'currency' },
      { key: 'tds_paise', label: 'TDS', type: 'currency' },
      { key: 'lop_paise', label: 'LOP', type: 'currency' },
      { key: 'total_paise', label: 'Total', type: 'currency' },
    ],
    async run(session, filters) {
      const ids = await scopedEmployeeIds(session, filters)
      const items = await prisma.payrollItem.findMany({
        where: {
          deletedAt: null, employeeId: { in: ids },
          payrollRun: {
            deletedAt: null,
            ...(filters.from || filters.to ? { periodEnd: dateRange(filters) } : {}),
          },
        },
        include: { employee: { include: { department: true } }, payrollRun: true },
        orderBy: { payrollRun: { periodStart: 'desc' } },
      })
      const rows = items.map((i) => {
        const d = JSON.parse(i.deductionsJson) as PayrollDeductions
        return {
          period: monthLabel(i.payrollRun.periodStart),
          ...empCols(i.employee),
          pf_paise: d.pf_employee_paise ?? 0,
          esi_paise: d.esi_employee_paise ?? 0,
          pt_paise: d.pt_paise ?? 0,
          tds_paise: d.tds_paise ?? 0,
          lop_paise: d.lop_paise ?? 0,
          total_paise: i.totalDeductionsPaise,
        }
      })
      return paginate(rows, filters)
    },
  },
  {
    key: 'payroll-history',
    label: 'Payroll run history',
    group: 'Payroll',
    permissions: ['reports.finance', 'reports.all'],
    columns: [
      { key: 'period', label: 'Period', type: 'text' },
      { key: 'stage', label: 'Stage', type: 'text' },
      { key: 'headcount', label: 'Employees', type: 'number' },
      { key: 'gross_paise', label: 'Gross', type: 'currency' },
      { key: 'deductions_paise', label: 'Deductions', type: 'currency' },
      { key: 'net_paise', label: 'Net', type: 'currency' },
      { key: 'processed_at', label: 'Processed', type: 'date' },
    ],
    async run(_session, filters) {
      const where = {
        deletedAt: null,
        ...(filters.from || filters.to ? { periodEnd: dateRange(filters) } : {}),
      }
      const [rows, total] = await Promise.all([
        prisma.payrollRun.findMany({
          where, orderBy: { periodStart: 'desc' },
          take: filters.pageSize, skip: (filters.page - 1) * filters.pageSize,
        }),
        prisma.payrollRun.count({ where }),
      ])
      return {
        total,
        rows: rows.map((r) => ({
          period: monthLabel(r.periodStart),
          stage: r.stage,
          headcount: r.headcount,
          gross_paise: r.grossTotalPaise,
          deductions_paise: r.deductionsTotalPaise,
          net_paise: r.netTotalPaise,
          processed_at: r.processedAt ? r.processedAt.toISOString().slice(0, 10) : '—',
        })),
      }
    },
  },
  // ── Expenses ────────────────────────────────────────────────────────────
  {
    key: 'expense-employee',
    label: 'Expenses by employee',
    group: 'Expenses',
    permissions: ['reports.finance', 'reports.hr', 'reports.all'],
    columns: [
      { key: 'expense_no', label: 'Claim', type: 'text' },
      { key: 'expense_date', label: 'Date', type: 'date' },
      ...EMP_COLS,
      { key: 'category', label: 'Category', type: 'text' },
      { key: 'title', label: 'Title', type: 'text' },
      { key: 'amount_paise', label: 'Amount', type: 'currency' },
      { key: 'stage', label: 'Stage', type: 'text' },
    ],
    async run(session, filters) {
      const ids = await scopedEmployeeIds(session, filters)
      const where = {
        deletedAt: null, employeeId: { in: ids },
        ...(filters.from || filters.to ? { expenseDate: dateRange(filters) } : {}),
        ...(filters.search ? { title: { contains: filters.search } } : {}),
      }
      const [rows, total] = await Promise.all([
        prisma.expense.findMany({
          where, include: { employee: { include: { department: true } }, category: true },
          orderBy: { expenseDate: 'desc' },
          take: filters.pageSize, skip: (filters.page - 1) * filters.pageSize,
        }),
        prisma.expense.count({ where }),
      ])
      return {
        total,
        rows: rows.map((e) => ({
          expense_no: e.expenseNo,
          expense_date: e.expenseDate,
          ...empCols(e.employee),
          category: e.category.name,
          title: e.title,
          amount_paise: e.amountPaise,
          stage: e.stage,
        })),
      }
    },
  },
  {
    key: 'expense-category',
    label: 'Expenses by category',
    group: 'Expenses',
    permissions: ['reports.finance', 'reports.hr', 'reports.all'],
    columns: [
      { key: 'category', label: 'Category', type: 'text' },
      { key: 'claims', label: 'Claims', type: 'number' },
      { key: 'amount_paise', label: 'Claimed', type: 'currency' },
      { key: 'paid_paise', label: 'Reimbursed', type: 'currency' },
    ],
    async run(session, filters) {
      const ids = await scopedEmployeeIds(session, filters)
      const rows = await prisma.expense.findMany({
        where: {
          deletedAt: null, employeeId: { in: ids },
          ...(filters.from || filters.to ? { expenseDate: dateRange(filters) } : {}),
        },
        include: { category: true },
      })
      const map = new Map<string, Record<string, number | string>>()
      for (const e of rows) {
        const key = e.category.name
        if (!map.has(key)) map.set(key, { category: key, claims: 0, amount_paise: 0, paid_paise: 0 })
        const r = map.get(key)!
        r.claims = (r.claims as number) + 1
        r.amount_paise = (r.amount_paise as number) + e.amountPaise
        if (e.stage === 'paid') r.paid_paise = (r.paid_paise as number) + e.amountPaise
      }
      const sorted = [...map.values()].sort((a, b) => (b.amount_paise as number) - (a.amount_paise as number))
      return paginate(sorted, filters)
    },
  },
  {
    key: 'expense-department',
    label: 'Expenses by department',
    group: 'Expenses',
    permissions: ['reports.finance', 'reports.hr', 'reports.all'],
    columns: [
      { key: 'department', label: 'Department', type: 'text' },
      { key: 'claims', label: 'Claims', type: 'number' },
      { key: 'amount_paise', label: 'Claimed', type: 'currency' },
      { key: 'paid_paise', label: 'Reimbursed', type: 'currency' },
    ],
    async run(session, filters) {
      const ids = await scopedEmployeeIds(session, filters)
      const rows = await prisma.expense.findMany({
        where: {
          deletedAt: null, employeeId: { in: ids },
          ...(filters.from || filters.to ? { expenseDate: dateRange(filters) } : {}),
        },
        include: { employee: { include: { department: true } } },
      })
      const map = new Map<string, Record<string, number | string>>()
      for (const e of rows) {
        const key = e.employee.department.name
        if (!map.has(key)) map.set(key, { department: key, claims: 0, amount_paise: 0, paid_paise: 0 })
        const r = map.get(key)!
        r.claims = (r.claims as number) + 1
        r.amount_paise = (r.amount_paise as number) + e.amountPaise
        if (e.stage === 'paid') r.paid_paise = (r.paid_paise as number) + e.amountPaise
      }
      return paginate([...map.values()], filters)
    },
  },
  {
    key: 'expense-reimbursements',
    label: 'Reimbursements',
    group: 'Expenses',
    permissions: ['reports.finance', 'reports.all'],
    columns: [
      { key: 'expense_no', label: 'Claim', type: 'text' },
      { key: 'paid_at', label: 'Paid on', type: 'date' },
      ...EMP_COLS,
      { key: 'category', label: 'Category', type: 'text' },
      { key: 'amount_paise', label: 'Amount', type: 'currency' },
    ],
    async run(session, filters) {
      const ids = await scopedEmployeeIds(session, filters)
      const where = { deletedAt: null, employeeId: { in: ids }, stage: 'paid' }
      const [rows, total] = await Promise.all([
        prisma.expense.findMany({
          where, include: { employee: { include: { department: true } }, category: true },
          orderBy: { paidAt: 'desc' },
          take: filters.pageSize, skip: (filters.page - 1) * filters.pageSize,
        }),
        prisma.expense.count({ where }),
      ])
      return {
        total,
        rows: rows.map((e) => ({
          expense_no: e.expenseNo,
          paid_at: e.paidAt ? e.paidAt.toISOString().slice(0, 10) : '—',
          ...empCols(e.employee),
          category: e.category.name,
          amount_paise: e.amountPaise,
        })),
      }
    },
  },
]

export function findReport(key: string) {
  return REPORTS.find((r) => r.key === key)
}

export function canRunReport(session: Session, report: ReportDefinition): boolean {
  return report.permissions.some((p) => can(session, p, 'department') || can(session, p, 'organisation'))
}
