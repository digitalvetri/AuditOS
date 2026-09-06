import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { requireSession } from '../../platform/auth.js'
import { employeeIdsInScope, widestScope } from '../../platform/scope.js'
import { canRunReport, findReport, REPORTS } from './definitions.js'
import { sendCsv, sendXlsx } from './export.js'

/**
 * Reports routes (§8.10). The catalogue is itself permission-filtered — you
 * only see the reports you can run — and the filter options are scoped, so a
 * Department Manager's employee picker lists only their department.
 */
export const reportsRouter = Router()

reportsRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  ok(res, {
    items: REPORTS.filter((r) => canRunReport(session, r)).map((r) => ({
      key: r.key, label: r.label, group: r.group, columns: r.columns,
    })),
  })
}))

reportsRouter.get('/filters', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = widestScope(session, 'employee.read', 'employee.read.restricted', 'attendance.read') ?? 'self'
  const ids = await employeeIdsInScope(session, scope)
  const employees = await prisma.employee.findMany({
    where: { deletedAt: null, ...(ids === 'ALL' ? {} : { id: { in: ids } }) },
    orderBy: { fullName: 'asc' },
  })
  const departmentIds = [...new Set(employees.map((e) => e.departmentId))]
  const departments = await prisma.department.findMany({
    where: { id: { in: departmentIds }, deletedAt: null }, orderBy: { name: 'asc' },
  })
  ok(res, {
    employees: employees.map((e) => ({
      id: e.id, full_name: e.fullName, employee_code: e.employeeCode, department_id: e.departmentId,
    })),
    departments: departments.map((d) => ({ id: d.id, name: d.name })),
  })
}))

const querySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  departmentId: z.string().optional(),
  employeeId: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(25),
  format: z.enum(['json', 'csv', 'xlsx']).default('json'),
})

reportsRouter.get('/:key', handler(async (req, res) => {
  const session = requireSession(req)
  const report = findReport(req.params.key)
  if (!report) throw ApiError.notFound(`No report named "${req.params.key}".`)
  // An explicit permission check — a role name is never sufficient.
  if (!canRunReport(session, report)) {
    throw ApiError.forbidden(`Your role (${session.roleName}) cannot run the ${report.label} report.`)
  }

  const parsed = querySchema.safeParse(req.query)
  if (!parsed.success) {
    throw ApiError.unprocessable('invalid_filters', 'Check the report filters.', parsed.error.flatten().fieldErrors)
  }
  const q = parsed.data

  if (q.format !== 'json') {
    // Export the full filtered set — still inside the caller's scope.
    const all = await report.run(session, { ...q, page: 1, pageSize: 100_000 })
    const name = `${report.key}-${new Date().toISOString().slice(0, 10)}`
    if (q.format === 'csv') return sendCsv(res, name, report.columns, all.rows)
    return sendXlsx(res, name, report.columns, all.rows)
  }

  const result = await report.run(session, q)
  ok(res, {
    key: report.key,
    label: report.label,
    group: report.group,
    columns: report.columns,
    rows: result.rows,
    page: q.page,
    page_size: q.pageSize,
    total: result.total,
  })
}))
