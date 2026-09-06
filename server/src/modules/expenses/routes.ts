import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { istToday } from '../../lib/dates.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { notifyEmployee, notifyRole } from '../../platform/notify.js'
import {
  employeeRef, employeeRefWithDept, expenseApprovalToApi, expenseToApi,
} from '../../api/serialize.js'
import { nextPaymentNo, postLedger } from '../accounts/ledger.js'
import type { Scope } from '../../platform/rbac/matrix.js'

/**
 * EXPENSES (§8.5 / §9)
 *
 *   draft → pending_manager → pending_finance → approved → paid
 *                                            ↘ rejected
 *
 * Every transition writes an ExpenseApproval row, an AuditLog entry and a
 * notification. On `paid`, the Payment and the LedgerTransaction are created
 * in ONE transaction with the stage change — the ledger is never written by
 * hand for an expense, and a half-applied payment is not reachable.
 */
export const expensesRouter = Router()

type ExpenseStage = 'draft' | 'pending_manager' | 'pending_finance' | 'approved' | 'paid' | 'rejected'

function viewScope(session: Session): Scope | 'blocked' {
  // Finance and MD see the organisation; a Dept Manager sees their department;
  // an employee sees their own. HR has no expense grant at all.
  if (can(session, 'expense.manage', 'organisation')) return 'organisation'
  if (can(session, 'expense.approve', 'organisation')) return 'organisation'
  if (can(session, 'expense.approve', 'department')) return 'department'
  if (can(session, 'expense.submit', 'self')) return 'self'
  return 'blocked'
}

const canApproveManager = (s: Session) =>
  can(s, 'expense.approve', 'department') || can(s, 'expense.approve', 'organisation')
const canApproveFinance = (s: Session) => can(s, 'expense.approve', 'organisation')
const canPay = (s: Session) => can(s, 'expense.pay', 'organisation')

async function logApproval(
  expenseId: string, actorUserId: string, from: string, to: string, notes: string | null,
) {
  await prisma.expenseApproval.create({
    data: { expenseId, actorUserId, fromStage: from, toStage: to, notes },
  })
}

// GET /api/expenses
expensesRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = viewScope(session)
  if (scope === 'blocked') throw ApiError.forbidden()
  const q = z.object({ stage: z.string().optional(), scope: z.string().optional() }).parse(req.query)

  const where: Record<string, unknown> = { deletedAt: null }
  if (scope === 'self') {
    if (!session.employeeId) return ok(res, { items: [], count: 0, scope })
    where.employeeId = session.employeeId
  } else if (scope === 'department') {
    where.employee = { departmentId: session.departmentId ?? '__none__' }
  }

  if (q.scope === 'mine') {
    if (!session.employeeId) return ok(res, { items: [], count: 0, scope })
    where.employeeId = session.employeeId
    delete where.employee
  } else if (q.scope === 'team-queue') {
    where.employee = { departmentId: session.departmentId ?? '__none__' }
    where.stage = 'pending_manager'
  } else if (q.scope === 'finance-queue') {
    where.stage = { in: ['pending_finance', 'approved'] }
  }
  if (q.stage) where.stage = q.stage

  const rows = await prisma.expense.findMany({
    where, include: { employee: true, category: true }, orderBy: { createdAt: 'desc' },
  })
  const items = rows.map((e) => ({
    ...expenseToApi(e),
    employee: employeeRefWithDept(e.employee),
    category: { id: e.category.id, name: e.category.name, code: e.category.code },
  }))
  ok(res, { items, count: items.length, scope })
}))

// POST /api/expenses — create as draft
expensesRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  if (!session.employeeId) throw ApiError.unprocessable('no_employee', 'This account has no employee record.')
  const b = z.object({
    title: z.string().trim().min(1),
    category_id: z.string().min(1),
    amount_paise: z.number().int(),
    expense_date: z.string().min(1),
    description: z.string().optional(),
    payment_method: z.enum(['cash', 'card', 'upi', 'bank_transfer', 'other']).optional(),
    receipt_file_key: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) {
    throw ApiError.badRequest('title, category_id, amount_paise, expense_date required.')
  }
  if (b.data.amount_paise <= 0) throw ApiError.unprocessable('amount', 'Amount must be positive.')

  const category = await prisma.expenseCategory.findUnique({ where: { id: b.data.category_id } })
  if (!category || category.deletedAt) throw new ApiError(400, 'invalid_category', 'Unknown expense category.')
  if (!category.isActive) throw ApiError.unprocessable('inactive_category', 'This category is inactive.')

  const count = await prisma.expense.count()
  const row = await prisma.expense.create({
    data: {
      expenseNo: `EXP-${String(count + 1).padStart(5, '0')}`,
      employeeId: session.employeeId,
      categoryId: category.id,
      title: b.data.title,
      amountPaise: b.data.amount_paise,
      expenseDate: b.data.expense_date,
      description: b.data.description ?? '',
      paymentMethod: b.data.payment_method ?? 'card',
      receiptFileKey: b.data.receipt_file_key ?? null,
      notes: b.data.notes ?? null,
      stage: 'draft',
      createdBy: session.userId,
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'expense.created', entityType: 'Expense', entityId: row.id,
    after: { title: row.title, amount_paise: row.amountPaise }, req,
  })
  ok(res, { expense: expenseToApi(row) })
}))

// GET /api/expenses/:id
expensesRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = viewScope(session)
  if (scope === 'blocked') throw ApiError.forbidden()
  const row = await prisma.expense.findUnique({
    where: { id: req.params.id }, include: { employee: true, category: true },
  })
  if (!row) throw ApiError.notFound('Expense not found.')

  const allowed =
    scope === 'organisation' ||
    (scope === 'department' && row.employee.departmentId === session.departmentId) ||
    (scope === 'self' && row.employeeId === session.employeeId)
  if (!allowed) throw ApiError.forbidden()

  const approvals = await prisma.expenseApproval.findMany({
    where: { expenseId: row.id }, orderBy: { createdAt: 'asc' },
  })
  ok(res, {
    expense: {
      ...expenseToApi(row),
      employee: employeeRefWithDept(row.employee),
      category: { id: row.category.id, name: row.category.name, code: row.category.code },
    },
    approvals: approvals.map(expenseApprovalToApi),
  })
}))

// PATCH /api/expenses/:id — owner, draft only
expensesRouter.patch('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const row = await prisma.expense.findUnique({ where: { id: req.params.id } })
  if (!row) throw ApiError.notFound('Expense not found.')
  if (row.stage !== 'draft') throw ApiError.conflict('not_draft', 'Only Draft expenses can be edited.')
  if (row.employeeId !== session.employeeId) throw ApiError.forbidden('Only the claimant can edit.')

  const editable = {
    title: 'title', category_id: 'categoryId', amount_paise: 'amountPaise',
    expense_date: 'expenseDate', description: 'description',
    payment_method: 'paymentMethod', receipt_file_key: 'receiptFileKey', notes: 'notes',
  } as const
  const body = (req.body ?? {}) as Record<string, unknown>
  const disallowed = Object.keys(body).filter((k) => !(k in editable))
  if (disallowed.length) throw ApiError.unprocessable('unknown_fields', 'Unknown fields.', { disallowed })

  const data: Record<string, unknown> = { updatedBy: session.userId }
  for (const [k, v] of Object.entries(body)) data[editable[k as keyof typeof editable]] = v

  const updated = await prisma.expense.update({ where: { id: row.id }, data })
  await writeAudit({
    actorUserId: session.userId, action: 'expense.updated', entityType: 'Expense', entityId: row.id,
    before: expenseToApi(row), after: expenseToApi(updated), req,
  })
  ok(res, { expense: expenseToApi(updated) })
}))

// POST /api/expenses/:id/submit
expensesRouter.post('/:id/submit', handler(async (req, res) => {
  const session = requireSession(req)
  const row = await prisma.expense.findUnique({ where: { id: req.params.id }, include: { employee: true } })
  if (!row) throw ApiError.notFound('Expense not found.')
  if (row.employeeId !== session.employeeId) throw ApiError.forbidden('Only the claimant can submit.')
  if (row.stage !== 'draft') throw ApiError.conflict('not_draft', 'Only Draft expenses can be submitted.')

  const updated = await prisma.expense.update({
    where: { id: row.id },
    data: { stage: 'pending_manager', submittedAt: new Date(), updatedBy: session.userId },
  })
  await logApproval(row.id, session.userId, 'draft', 'pending_manager', null)
  await writeAudit({
    actorUserId: session.userId, action: 'expense.submitted', entityType: 'Expense', entityId: row.id,
    before: { stage: 'draft' }, after: { stage: 'pending_manager' }, req,
  })
  if (row.employee.managerId) {
    await notifyEmployee(row.employee.managerId, {
      type: 'expense.submitted', module: 'expense', title: 'Expense to review',
      body: `${row.employee.fullName} — ${row.title} · ₹${(row.amountPaise / 100).toLocaleString('en-IN')}`,
      entityType: 'Expense', entityId: row.id, actionUrl: '/hrms/expenses?tab=team',
    })
  }
  ok(res, { expense: expenseToApi(updated) })
}))

// POST /api/expenses/:id/approve
expensesRouter.post('/:id/approve', handler(async (req, res) => {
  const session = requireSession(req)
  const row = await prisma.expense.findUnique({ where: { id: req.params.id }, include: { employee: true } })
  if (!row) throw ApiError.notFound('Expense not found.')

  let next: ExpenseStage
  if (row.stage === 'pending_manager') {
    const asDeptManager = can(session, 'expense.approve', 'department')
      && row.employee.departmentId === session.departmentId
    if (!asDeptManager && !canApproveFinance(session)) {
      throw ApiError.forbidden('Only the department manager (or Finance/MD) can approve at this stage.')
    }
    next = 'pending_finance'
  } else if (row.stage === 'pending_finance') {
    if (!canApproveFinance(session)) throw ApiError.forbidden('Only Finance/MD can approve at this stage.')
    next = 'approved'
  } else {
    throw ApiError.conflict('wrong_stage', `Expense is ${row.stage}; cannot approve.`)
  }

  const now = new Date()
  const updated = await prisma.expense.update({
    where: { id: row.id },
    data: {
      stage: next,
      ...(next === 'pending_finance'
        ? { managerApprovedBy: session.userId, managerApprovedAt: now }
        : { financeApprovedBy: session.userId, financeApprovedAt: now }),
      updatedBy: session.userId,
    },
  })
  await logApproval(row.id, session.userId, row.stage, next, null)
  await writeAudit({
    actorUserId: session.userId, action: `expense.${next}`, entityType: 'Expense', entityId: row.id,
    before: { stage: row.stage }, after: { stage: next }, req,
  })

  await notifyEmployee(row.employeeId, {
    type: `expense.${next}`, module: 'expense',
    title: next === 'pending_finance' ? 'Expense manager-approved' : 'Expense finance-approved',
    body: `${row.title} → ${next.replace('_', ' ')}`,
    entityType: 'Expense', entityId: row.id, actionUrl: '/hrms/expenses',
  })
  if (next === 'pending_finance') {
    await notifyRole('finance_admin', {
      type: 'expense.pending_finance', module: 'expense', title: 'Expense awaiting Finance',
      body: `${row.employee.fullName} — ${row.title}`,
      entityType: 'Expense', entityId: row.id, actionUrl: '/hrms/expenses?tab=finance',
    })
  }
  ok(res, { expense: expenseToApi(updated) })
}))

// POST /api/expenses/:id/reject
expensesRouter.post('/:id/reject', handler(async (req, res) => {
  const session = requireSession(req)
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
  if (!reason) throw ApiError.badRequest('A reason is required.')

  const row = await prisma.expense.findUnique({ where: { id: req.params.id }, include: { employee: true } })
  if (!row) throw ApiError.notFound('Expense not found.')
  if (row.stage !== 'pending_manager' && row.stage !== 'pending_finance') {
    throw ApiError.conflict('wrong_stage', 'Only pending expenses can be rejected.')
  }

  const permitted =
    (row.stage === 'pending_manager' &&
      (canApproveFinance(session) ||
        (canApproveManager(session) && row.employee.departmentId === session.departmentId))) ||
    (row.stage === 'pending_finance' && canApproveFinance(session))
  if (!permitted) throw ApiError.forbidden()

  const updated = await prisma.expense.update({
    where: { id: row.id },
    data: {
      stage: 'rejected', rejectionReason: reason,
      rejectedBy: session.userId, rejectedAt: new Date(), updatedBy: session.userId,
    },
  })
  await logApproval(row.id, session.userId, row.stage, 'rejected', reason)
  await writeAudit({
    actorUserId: session.userId, action: 'expense.rejected', entityType: 'Expense', entityId: row.id,
    before: { stage: row.stage }, after: { stage: 'rejected', reason }, req,
  })
  await notifyEmployee(row.employeeId, {
    type: 'expense.rejected', module: 'expense', title: 'Expense rejected',
    body: `${row.title}: ${reason}`,
    entityType: 'Expense', entityId: row.id, actionUrl: '/hrms/expenses',
  })
  ok(res, { expense: expenseToApi(updated) })
}))

// POST /api/expenses/:id/pay — Finance only. Payment + ledger + stage, atomically.
expensesRouter.post('/:id/pay', handler(async (req, res) => {
  const session = requireSession(req)
  if (!canPay(session)) throw ApiError.forbidden('Only Finance/MD can pay.')
  const row = await prisma.expense.findUnique({ where: { id: req.params.id }, include: { employee: true } })
  if (!row) throw ApiError.notFound('Expense not found.')
  if (row.stage === 'paid') throw ApiError.conflict('already_paid', 'Expense is already Paid.')
  if (row.stage !== 'approved') {
    throw ApiError.conflict('wrong_stage', `Expense is ${row.stage}; must be Approved.`)
  }

  const now = new Date()
  const { updated, payment } = await prisma.$transaction(async (tx) => {
    const paymentNo = await nextPaymentNo(tx)
    const created = await tx.payment.create({
      data: {
        paymentNo,
        employeeId: row.employeeId,
        expenseId: row.id,
        amountPaise: row.amountPaise,
        method: 'mock',
        reference: `${paymentNo}/${row.expenseNo}`,
        status: 'completed',
        paidAt: now,
        createdBy: session.userId,
        updatedBy: session.userId,
      },
    })
    await postLedger(tx, {
      date: istToday(),
      type: 'Expense Reimbursement',
      description: `Reimbursement — ${row.title}`,
      employeeId: row.employeeId,
      category: 'Expense',
      debitPaise: row.amountPaise,
      referenceId: row.id,
      referenceType: 'Expense',
      paymentId: created.id,
      createdBy: session.userId,
    })
    const exp = await tx.expense.update({
      where: { id: row.id },
      data: { stage: 'paid', paidAt: now, paymentId: created.id, updatedBy: session.userId },
    })
    return { updated: exp, payment: created }
  })

  await logApproval(row.id, session.userId, 'approved', 'paid', null)
  await writeAudit({
    actorUserId: session.userId, action: 'expense.paid', entityType: 'Expense', entityId: row.id,
    before: { stage: 'approved' }, after: { stage: 'paid', payment_id: payment.id }, req,
  })
  await notifyEmployee(row.employeeId, {
    type: 'expense.paid', module: 'expense', title: 'Expense reimbursed',
    body: `${row.title} — ₹${(row.amountPaise / 100).toLocaleString('en-IN')} paid.`,
    entityType: 'Expense', entityId: row.id, actionUrl: '/hrms/expenses',
  })
  ok(res, { expense: expenseToApi(updated), payment_id: payment.id })
}))
