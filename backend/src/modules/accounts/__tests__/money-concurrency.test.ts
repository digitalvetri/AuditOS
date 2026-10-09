import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { heldLiabilityBalances, postJournal } from '../ledger.js'
import { CATEGORIES } from '../../../platform/constants.js'

/**
 * Money flows under concurrency. Each test fires several requests at once
 * against DIFFERENT records (or, for the reversal/remit cases, the same
 * record) and checks that number sequences never collide (a collision on
 * an @unique column surfaces as a 500) and that caps and one-shot state
 * changes hold when two requests race.
 *
 * Nothing global is wiped up front. Ledger rows are removed afterwards by
 * sequence watermark (files run one at a time), everything else by the
 * employees this file created.
 */

let server: Server
let base = ''
let ledgerWatermark = 0
const createdEmployees: string[] = []

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
    where: { id: 'org-mc' }, update: {},
    create: { id: 'org-mc', name: 'TestFirm' },
  })
  const dept = await prisma.department.upsert({
    where: { id: 'dep-mc' }, update: {},
    create: { id: 'dep-mc', organisationId: org.id, code: 'GENMC', name: 'General' },
  })
  const desg = await prisma.designation.upsert({
    where: { id: 'desg-mc' }, update: {},
    create: { id: 'desg-mc', organisationId: org.id, name: 'Executive' },
  })
  const loc = await prisma.workLocation.upsert({
    where: { id: 'loc-mc' }, update: {},
    create: { id: 'loc-mc', organisationId: org.id, name: 'HQ', latitude: 13, longitude: 80 },
  })
  const sched = await prisma.workSchedule.upsert({
    where: { id: 'sch-mc' }, update: {},
    create: { id: 'sch-mc', organisationId: org.id, name: 'Std', standardStart: '09:30', standardEnd: '18:30' },
  })
  const category = await prisma.expenseCategory.upsert({
    where: { id: 'ec-mc' }, update: {},
    create: { id: 'ec-mc', organisationId: org.id, code: 'GENMC', name: 'General' },
  })
  return { org, dept, desg, loc, sched, category }
}

type Ctx = Awaited<ReturnType<typeof seedOrg>>

async function makeEmployeeUser(ctx: Ctx, roleCode: 'finance_admin' | 'employee') {
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
  const last = await prisma.ledgerTransaction.findFirst({ orderBy: { sequence: 'desc' }, select: { sequence: true } })
  ledgerWatermark = last?.sequence ?? 0
})

afterAll(async () => {
  await prisma.ledgerTransaction.deleteMany({ where: { sequence: { gt: ledgerWatermark } } })
  const expenses = await prisma.expense.findMany({
    where: { employeeId: { in: createdEmployees } }, select: { id: true },
  })
  const expenseIds = expenses.map((e) => e.id)
  await prisma.expenseApproval.deleteMany({ where: { expenseId: { in: expenseIds } } })
  await prisma.payment.deleteMany({ where: { employeeId: { in: createdEmployees } } })
  await prisma.expense.deleteMany({ where: { id: { in: expenseIds } } })
  await prisma.notification.deleteMany({ where: { user: { employeeId: { in: createdEmployees } } } })
  await prisma.user.deleteMany({ where: { employeeId: { in: createdEmployees } } })
  await prisma.employee.deleteMany({ where: { id: { in: createdEmployees } } })
  server.close()
  await prisma.$disconnect()
})

const PARALLEL = 5

describe('number sequences under concurrency', () => {
  it('pays several DIFFERENT approved expenses at once with distinct payment numbers', async () => {
    const ctx = await seedOrg()
    const claimant = await makeEmployeeUser(ctx, 'employee')
    const finance = await makeEmployeeUser(ctx, 'finance_admin')
    const expenses = []
    for (let i = 0; i < PARALLEL; i++) {
      expenses.push(await prisma.expense.create({
        data: {
          expenseNo: uid('EXP'), employeeId: claimant.emp.id, categoryId: ctx.category.id,
          title: `Cab ${i}`, amountPaise: 1_000_00 + i, expenseDate: '2026-09-15', stage: 'approved',
        },
      }))
    }

    const results = await Promise.all(expenses.map((e) =>
      api(`/api/expenses/${e.id}/pay`, { method: 'POST', cookie: finance.cookie })))
    expect(results.map((r) => r.status)).toEqual(expenses.map(() => 200))

    const payments = await prisma.payment.findMany({ where: { expenseId: { in: expenses.map((e) => e.id) } } })
    expect(payments).toHaveLength(PARALLEL)
    expect(new Set(payments.map((p) => p.paymentNo)).size).toBe(PARALLEL)
    // Every expense got its own balanced reimbursement journal.
    const legs = await prisma.ledgerTransaction.findMany({
      where: { referenceType: 'Expense', referenceId: { in: expenses.map((e) => e.id) } },
    })
    expect(legs).toHaveLength(PARALLEL * 2)
  })

  it('records several manual payments at once with distinct numbers and a consistent running balance', async () => {
    const ctx = await seedOrg()
    const staff = await makeEmployeeUser(ctx, 'employee')
    const finance = await makeEmployeeUser(ctx, 'finance_admin')

    const results = await Promise.all(Array.from({ length: PARALLEL }, (_, i) =>
      api('/api/payments', {
        method: 'POST', cookie: finance.cookie,
        body: { employee_id: staff.emp.id, amount_paise: 500_00 + i, ledger_type: 'Employee Advance' },
      })))
    expect(results.map((r) => r.status)).toEqual(results.map(() => 200))
    const nos = results.map((r) => r.body.data.payment.payment_no)
    expect(new Set(nos).size).toBe(PARALLEL)

    // Sequences are unbroken and each running balance follows from the
    // previous row: no two posts read the same "last" row.
    const rows = await prisma.ledgerTransaction.findMany({
      where: { sequence: { gt: ledgerWatermark } }, orderBy: { sequence: 'asc' },
    })
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].sequence).toBe(rows[i - 1].sequence + 1)
      expect(rows[i].runningBalancePaise)
        .toBe(rows[i - 1].runningBalancePaise + rows[i].debitPaise - rows[i].creditPaise)
    }
  })

  it('creates several expense claims at once with distinct expense numbers', async () => {
    const ctx = await seedOrg()
    const claimant = await makeEmployeeUser(ctx, 'employee')
    const results = await Promise.all(Array.from({ length: PARALLEL }, (_, i) =>
      api('/api/expenses', {
        method: 'POST', cookie: claimant.cookie,
        body: { title: `Lunch ${i}`, category_id: ctx.category.id, amount_paise: 200_00, expense_date: '2026-09-20' },
      })))
    expect(results.map((r) => r.status)).toEqual(results.map(() => 200))
    const nos = results.map((r) => r.body.data.expense.expense_no)
    expect(new Set(nos).size).toBe(PARALLEL)
  })
})

describe('POST /api/accounts/liabilities/remit — concurrency', () => {
  it('never lets simultaneous remittances exceed the held balance', async () => {
    const ctx = await seedOrg()
    const finance = await makeEmployeeUser(ctx, 'finance_admin')
    await prisma.$transaction((tx) => postJournal(tx, {
      date: '2026-08-31', type: 'Payroll', description: 'Salary — August 2026',
      referenceId: uid('ref'), referenceType: 'PayrollItem', createdBy: null,
      legs: [
        { category: CATEGORIES.SALARIES, debitPaise: 100_000 },
        { category: CATEGORIES.PF_PAYABLE, creditPaise: 100_000 },
      ],
    }))
    const held = (await heldLiabilityBalances())[CATEGORIES.PF_PAYABLE]
    expect(held).toBeGreaterThanOrEqual(100_000)
    // Any two of these fit; three do not.
    const each = Math.floor(held * 0.4)

    const results = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      api('/api/accounts/liabilities/remit', {
        method: 'POST', cookie: finance.cookie,
        body: { category: CATEGORIES.PF_PAYABLE, amount_paise: each, reference: uid(`EPFO-${i}`) },
      })))
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([200, 200, 422, 422])
    for (const r of results.filter((x) => x.status === 422)) {
      expect(r.body.error.code).toBe('exceeds_balance')
    }
    const after = (await heldLiabilityBalances())[CATEGORIES.PF_PAYABLE]
    expect(after).toBe(held - 2 * each)
    expect(after).toBeGreaterThanOrEqual(0)
  })
})

describe('POST /api/accounts/ledger/:id/reverse — concurrency', () => {
  it('reverses a row once when several reversals race for it', async () => {
    const ctx = await seedOrg()
    const finance = await makeEmployeeUser(ctx, 'finance_admin')
    const [salary] = await prisma.$transaction((tx) => postJournal(tx, {
      date: '2026-09-30', type: 'Payroll', description: 'Salary — September 2026',
      referenceId: uid('ref'), referenceType: 'PayrollItem', createdBy: null,
      legs: [
        { category: CATEGORIES.SALARIES, debitPaise: 7_000 },
        { category: CATEGORIES.BANK, creditPaise: 7_000 },
      ],
    }))

    const results = await Promise.all(Array.from({ length: 4 }, () =>
      api(`/api/accounts/ledger/${salary.id}/reverse`, {
        method: 'POST', cookie: finance.cookie, body: { reason: 'Posted twice by mistake' },
      })))
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([200, 409, 409, 409])
    for (const r of results.filter((x) => x.status === 409)) {
      expect(r.body.error.code).toBe('already_reversed')
    }
    expect(await prisma.ledgerTransaction.count({ where: { reversesId: salary.id } })).toBe(1)
  })

  it('reverses a payment cluster once when two of its legs are reversed at the same moment', async () => {
    const ctx = await seedOrg()
    const staff = await makeEmployeeUser(ctx, 'employee')
    const finance = await makeEmployeeUser(ctx, 'finance_admin')
    const paid = await api('/api/payments', {
      method: 'POST', cookie: finance.cookie,
      body: { employee_id: staff.emp.id, amount_paise: 2_500_00, ledger_type: 'Employee Advance' },
    })
    expect(paid.status).toBe(200)
    const legs = await prisma.ledgerTransaction.findMany({
      where: { paymentId: paid.body.data.payment.id }, orderBy: { sequence: 'asc' },
    })
    expect(legs).toHaveLength(2)

    const results = await Promise.all(legs.map((l) =>
      api(`/api/accounts/ledger/${l.id}/reverse`, {
        method: 'POST', cookie: finance.cookie, body: { reason: 'Advance entered twice' },
      })))
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await prisma.ledgerTransaction.count({
      where: { reversesId: { in: legs.map((l) => l.id) } },
    })).toBe(2)
  })
})
