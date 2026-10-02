import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { postJournal } from '../ledger.js'
import { CATEGORIES } from '../../../platform/constants.js'

/**
 * Step 8 — GET /api/accounts/overview aggregates the §6.3 dashboard in
 * one round trip: this-month tiles, Needs-you queue, held liabilities,
 * and the balanced-ledger strip.
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

async function financeUser() {
  const org = await prisma.organisation.upsert({
    where: { id: 'org-t8' }, update: {},
    create: { id: 'org-t8', name: 'TestFirm' },
  })
  const role = await seedRole('finance_admin', MATRIX.finance_admin)
  const u = await prisma.user.create({
    data: {
      id: uid('u'), organisationId: org.id,
      email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: role.id,
    },
  })
  return { cookie: `ao_access=${signToken(u.id)}`, orgId: org.id }
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
afterAll(async () => { server.close(); await prisma.$disconnect() })
beforeEach(async () => {
  await prisma.ledgerTransaction.deleteMany({})
  await prisma.expenseApproval.deleteMany({})
  await prisma.payment.deleteMany({})
  await prisma.expense.deleteMany({})
  await prisma.payrollItem.deleteMany({})
  await prisma.payrollRun.deleteMany({})
})

describe('GET /api/accounts/overview', () => {
  it('returns the four sections in one round trip', async () => {
    const { cookie, orgId } = await financeUser()
    // A draft payroll run for the target month → Needs-you row.
    await prisma.payrollRun.create({
      data: {
        organisationId: orgId, periodStart: '2026-09-01', periodEnd: '2026-09-30',
        stage: 'draft', headcount: 3, grossTotalPaise: 300_000_00,
      },
    })
    // A balanced posting → non-zero PF Payable + balanced ledger.
    await prisma.$transaction((tx) => postJournal(tx, {
      date: '2026-09-15',
      type: 'Payroll',
      description: 'Salary — September 2026',
      referenceId: uid('ref'),
      referenceType: 'PayrollItem',
      createdBy: null,
      legs: [
        { category: CATEGORIES.SALARIES, debitPaise: 100_000_00 },
        { category: CATEGORIES.BANK, creditPaise: 90_000_00 },
        { category: CATEGORIES.PF_PAYABLE, creditPaise: 10_000_00 },
      ],
    }))

    const res = await api('/api/accounts/overview?month=2026-09', { cookie })
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.month).toBe('2026-09')
    expect(d.month_label).toBe('September 2026')

    // This month tiles
    expect(d.this_month.salary_cost_paise).toBe(300_000_00)
    expect(d.this_month.salary_employee_count).toBe(3)
    expect(d.this_month.zpay_connected).toBe(false)

    // Needs-you includes the draft payroll
    const kinds = d.needs_you.map((n: { kind: string }) => n.kind)
    expect(kinds).toContain('payroll_open')

    // Held liabilities include PF Payable at credit sum
    const pf = d.held_liabilities.find((h: { category: string }) => h.category === 'PF Payable')
    expect(pf.balance_paise).toBe(10_000_00)

    // Ledger strip
    expect(d.ledger.debit_paise).toBe(d.ledger.credit_paise)
    expect(d.ledger.balanced).toBe(true)
    expect(d.ledger.balance_paise).toBe(0)
  })

  it('defaults month to the current calendar month when not specified', async () => {
    const { cookie } = await financeUser()
    const res = await api('/api/accounts/overview', { cookie })
    expect(res.status).toBe(200)
    const now = new Date()
    const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    expect(res.body.data.month).toBe(currentYm)
  })

  it('rejects a malformed month with 400', async () => {
    const { cookie } = await financeUser()
    const res = await api('/api/accounts/overview?month=2026-9', { cookie })
    expect(res.status).toBe(400)
  })

  it('emits an "approved, not yet paid" needs-you row with the total', async () => {
    const { cookie, orgId } = await financeUser()
    // Two approved-but-not-paid expenses.
    const category = await prisma.expenseCategory.upsert({
      where: { id: 'ec-t8' }, update: {},
      create: { id: 'ec-t8', organisationId: orgId, code: 'GEN8', name: 'General' },
    })
    // We need at least one employee since expense FK-references employee.
    const dept = await prisma.department.upsert({
      where: { id: 'dep-t8' }, update: {},
      create: { id: 'dep-t8', organisationId: orgId, code: 'GEN8', name: 'General' },
    })
    const desg = await prisma.designation.upsert({
      where: { id: 'desg-t8' }, update: {},
      create: { id: 'desg-t8', organisationId: orgId, name: 'Ex' },
    })
    const loc = await prisma.workLocation.upsert({
      where: { id: 'loc-t8' }, update: {},
      create: { id: 'loc-t8', organisationId: orgId, name: 'HQ', latitude: 13, longitude: 80 },
    })
    const sched = await prisma.workSchedule.upsert({
      where: { id: 'sch-t8' }, update: {},
      create: { id: 'sch-t8', organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' },
    })
    const emp = await prisma.employee.create({
      data: {
        id: uid('emp'), organisationId: orgId,
        employeeCode: uid('EC'), firstName: 'A', lastName: 'B', fullName: 'A B',
        type: 'executive', status: 'active',
        designationId: desg.id, departmentId: dept.id,
        workLocationId: loc.id, workScheduleId: sched.id,
        email: `${uid('e')}@x.local`, joiningDate: '2026-01-01',
      },
    })
    await prisma.expense.createMany({
      data: [
        {
          expenseNo: uid('E'), employeeId: emp.id, categoryId: category.id,
          title: 'A', amountPaise: 5000_00, expenseDate: '2026-09-01', stage: 'approved',
        },
        {
          expenseNo: uid('E'), employeeId: emp.id, categoryId: category.id,
          title: 'B', amountPaise: 7000_00, expenseDate: '2026-09-15', stage: 'approved',
        },
      ],
    })
    const res = await api('/api/accounts/overview?month=2026-09', { cookie })
    const row = res.body.data.needs_you.find((n: { kind: string }) => n.kind === 'expense_approved_unpaid')
    expect(row).toBeTruthy()
    expect(row.amount_paise).toBe(12000_00)
    expect(row.count).toBe(2)
  })
})
