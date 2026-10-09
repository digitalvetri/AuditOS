import { Router } from 'express'
import { handler, ApiError, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { istToday } from '../../lib/dates.js'
import { can, requireSession } from '../../platform/auth.js'
import { articledTrainingToApi, employeeRef } from '../../api/serialize.js'
import { articleshipForms, recomputeArticleship } from './service.js'

/**
 * GET /api/articleship — the articleship register: every articled assistant
 * with principal, period, year, leave allowed / taken / excess, the extended
 * end date, ICAI form status and stipend. Edits go through
 * PATCH /api/employees/:id/training.
 */
export const articleshipRouter = Router()

articleshipRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'employee.read', 'organisation') && !can(session, 'employee.manage', 'organisation')) {
    throw ApiError.forbidden('Only HR or MD can see the articleship register.')
  }
  const employees = await prisma.employee.findMany({
    where: { type: 'articled', deletedAt: null },
    select: { id: true, fullName: true, employeeCode: true, status: true, training: { select: { id: true } } },
    orderBy: { fullName: 'asc' },
  })
  const today = istToday()
  const items = []
  for (const e of employees) {
    const r = e.training ? await recomputeArticleship(e.id, prisma, today) : null
    if (!r) {
      items.push({ employee: employeeRef(e), training: null, principal: null, leave: null, forms: null })
      continue
    }
    const principal = await prisma.employee.findUnique({ where: { id: r.training.principalEmployeeId }, select: { id: true, fullName: true, employeeCode: true } })
    items.push({
      employee: employeeRef(e),
      training: articledTrainingToApi(r.training),
      principal: employeeRef(principal),
      leave: r.leave,
      forms: articleshipForms(r.training, today),
    })
  }
  ok(res, { items, count: items.length })
}))
