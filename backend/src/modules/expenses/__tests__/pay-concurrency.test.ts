import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { prisma, uid } from '../../../__tests__/helpers.js'

/**
 * POST /api/expenses/:id/pay must pay an Approved claim exactly once. A
 * double-click or two Finance users paying at the same moment must not
 * create two Payments or two reimbursement journals: one request wins,
 * the other gets 409. Fixtures mirror self-approval.test.ts, but there is
 * no global cleanup: ids are unique per test and every assertion is scoped
 * to the expense under test, so rows left by other files do not matter.
 */

let server: Server
let base = ''

async function seedRole(code: string, grants: { permission: string; scope: string }[]) {
  for (const g of grants) {
    await prisma.permission.upsert({
      where: { code: g.permission }, update: {},
      create: { id: `perm-${g.permission}`, code: g.permission, description: g.permission },
    })
  }
  const role = await prisma.role.upsert({
    where: { code }, update: {},
    create: { id: `role-${code}`, code, name: code },
  })
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
  for (const g of grants) {
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: `perm-${g.permission}`, scope: g.scope },
    }).catch(() => undefined)
  }
  return role
}

async function seedOrg() {
  const org = await prisma.organisation.upsert({
    where: { id: 'org-pay' }, update: {},
    create: { id: 'org-pay', name: 'TestFirm' },
  })
  const dept = await prisma.department.upsert({
    where: { id: 'dep-pay' }, update: {},
    create: { id: 'dep-pay', organisationId: org.id, code: 'GENP', name: 'General' },
  })
  const desg = await prisma.designation.upsert({
    where: { id: 'desg-pay' }, update: {},
    create: { id: 'desg-pay', organisationId: org.id, name: 'Executive' },
  })
  const loc = await prisma.workLocation.upsert({
    where: { id: 'loc-pay' }, update: {},
    create: { id: 'loc-pay', organisationId: org.id, name: 'HQ', latitude: 13, longitude: 80 },
  })
  const sched = await prisma.workSchedule.upsert({
    where: { id: 'sch-pay' }, update: {},
    create: { id: 'sch-pay', organisationId: org.id, name: 'Std', standardStart: '09:30', standardEnd: '18:30' },
  })
  const category = await prisma.expenseCategory.upsert({
    where: { id: 'ec-pay' }, update: {},
    create: { id: 'ec-pay', organisationId: org.id, code: 'GENP', name: 'General' },
  })
  return { org, dept, desg, loc, sched, category }
}

async function makeEmployeeUser(ctx: Awaited<ReturnType<typeof seedOrg>>, roleCode: 'finance_admin' | 'employee') {
  const emp = await prisma.employee.create({
    data: {
      id: uid('emp'), organisationId: ctx.org.id,
      employeeCode: uid('EC'), firstName: 'A', lastName: 'B', fullName: 'A B',
      type: 'executive', status: 'active',
      designationId: ctx.desg.id, departmentId: ctx.dept.id,
      workLocationId: ctx.loc.id, workScheduleId: ctx.sched.id,
      email: `${uid('e')}@x.local`, joiningDate: '2026-01-01',
    },
  })
  createdEmployees.push(emp.id)
  const role = await seedRole(roleCode, MATRIX[roleCode])
  const u = await prisma.user.create({
    data: {
      id: uid('u'), organisationId: ctx.org.id,
      email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: role.id,
      employeeId: emp.id,
    },
  })
  return { emp, user: u, cookie: `ao_access=${signToken(u.id)}` }
}

async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
const createdEmployees: string[] = []
afterAll(async () => {
  // Leave nothing behind: later files delete all employees and would trip
  // over our Expense / Payment rows.
  const expenses = await prisma.expense.findMany({
    where: { employeeId: { in: createdEmployees } }, select: { id: true },
  })
  const expenseIds = expenses.map((e) => e.id)
  await prisma.ledgerTransaction.deleteMany({ where: { referenceType: 'Expense', referenceId: { in: expenseIds } } })
  await prisma.expenseApproval.deleteMany({ where: { expenseId: { in: expenseIds } } })
  await prisma.payment.deleteMany({ where: { expenseId: { in: expenseIds } } })
  await prisma.expense.deleteMany({ where: { id: { in: expenseIds } } })
  await prisma.notification.deleteMany({ where: { user: { employeeId: { in: createdEmployees } } } })
  await prisma.user.deleteMany({ where: { employeeId: { in: createdEmployees } } })
  await prisma.employee.deleteMany({ where: { id: { in: createdEmployees } } })
  server.close()
  await prisma.$disconnect()
})

async function approvedExpense(ctx: Awaited<ReturnType<typeof seedOrg>>, employeeId: string) {
  return prisma.expense.create({
    data: {
      expenseNo: uid('EXP'), employeeId, categoryId: ctx.category.id,
      title: 'Client visit cab', amountPaise: 1_500_00, expenseDate: '2026-09-15',
      stage: 'approved',
    },
  })
}

describe('POST /api/expenses/:id/pay — concurrency', () => {
  it('pays once when two requests race for the same approved expense', async () => {
    const ctx = await seedOrg()
    const claimant = await makeEmployeeUser(ctx, 'employee')
    const financeA = await makeEmployeeUser(ctx, 'finance_admin')
    const financeB = await makeEmployeeUser(ctx, 'finance_admin')
    const exp = await approvedExpense(ctx, claimant.emp.id)

    const results = await Promise.all([
      api(`/api/expenses/${exp.id}/pay`, { method: 'POST', cookie: financeA.cookie }),
      api(`/api/expenses/${exp.id}/pay`, { method: 'POST', cookie: financeB.cookie }),
    ])
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([200, 409])
    const loser = results.find((r) => r.status === 409)!
    expect(loser.body.error.code).toBe('already_paid')

    expect(await prisma.payment.count({ where: { expenseId: exp.id } })).toBe(1)
    const legs = await prisma.ledgerTransaction.findMany({
      where: { referenceType: 'Expense', referenceId: exp.id },
    })
    expect(legs).toHaveLength(2)
    const payment = await prisma.payment.findFirstOrThrow({ where: { expenseId: exp.id } })
    const after = await prisma.expense.findUniqueOrThrow({ where: { id: exp.id } })
    expect(after.stage).toBe('paid')
    expect(after.paymentId).toBe(payment.id)
    expect(await prisma.expenseApproval.count({ where: { expenseId: exp.id, toStage: 'paid' } })).toBe(1)
  })

  it('a sequential second pay is refused with already_paid and writes nothing', async () => {
    const ctx = await seedOrg()
    const claimant = await makeEmployeeUser(ctx, 'employee')
    const finance = await makeEmployeeUser(ctx, 'finance_admin')
    const exp = await approvedExpense(ctx, claimant.emp.id)
    const first = await api(`/api/expenses/${exp.id}/pay`, { method: 'POST', cookie: finance.cookie })
    expect(first.status).toBe(200)
    const second = await api(`/api/expenses/${exp.id}/pay`, { method: 'POST', cookie: finance.cookie })
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('already_paid')
    expect(await prisma.payment.count({ where: { expenseId: exp.id } })).toBe(1)
  })
})
