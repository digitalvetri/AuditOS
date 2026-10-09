import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { prisma, uid } from '../../../__tests__/helpers.js'

/**
 * Step 6 — Bug 8: when the approver / payer is the claimant themselves
 * (the partner approving their own ICAI subscription), the API surfaces
 * `self_approved: true` on the row and exposes a report endpoint.
 * Self-approval is NOT blocked — a seven-person firm cannot function if
 * the MD cannot approve their own membership renewal — but it is
 * recorded and queryable, per §4.
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
    where: { id: 'org-t6' }, update: {},
    create: { id: 'org-t6', name: 'TestFirm' },
  })
  const dept = await prisma.department.upsert({
    where: { id: 'dep-t6' }, update: {},
    create: { id: 'dep-t6', organisationId: org.id, code: 'GEN6', name: 'General' },
  })
  const desg = await prisma.designation.upsert({
    where: { id: 'desg-t6' }, update: {},
    create: { id: 'desg-t6', organisationId: org.id, name: 'Executive' },
  })
  const loc = await prisma.workLocation.upsert({
    where: { id: 'loc-t6' }, update: {},
    create: { id: 'loc-t6', organisationId: org.id, name: 'HQ', latitude: 13, longitude: 80 },
  })
  const sched = await prisma.workSchedule.upsert({
    where: { id: 'sch-t6' }, update: {},
    create: { id: 'sch-t6', organisationId: org.id, name: 'Std', standardStart: '09:30', standardEnd: '18:30' },
  })
  const category = await prisma.expenseCategory.upsert({
    where: { id: 'ec-t6' }, update: {},
    create: { id: 'ec-t6', organisationId: org.id, code: 'GEN6', name: 'General' },
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
afterAll(async () => { server.close(); await prisma.$disconnect() })
beforeEach(async () => {
  await prisma.ledgerTransaction.deleteMany({})
  await prisma.expenseApproval.deleteMany({})
  await prisma.payment.deleteMany({})
  await prisma.expense.deleteMany({})
  await prisma.notification.deleteMany({})
  // Other test files leave rows that point at employees and users (salary
  // structures, leave balances, payslips…). Test files run one at a time on
  // a throwaway database, so clear both tables and everything hanging off them.
  await prisma.$executeRawUnsafe('TRUNCATE "Employee", "User" CASCADE')
  await prisma.expenseCategory.deleteMany({})
})

async function fullApproveExpense(ctx: Awaited<ReturnType<typeof seedOrg>>, claimant: {
  emp: { id: string }; user: { id: string }; cookie: string
}, approver: { user: { id: string }; cookie: string }) {
  // Claim
  const created = await api('/api/expenses', {
    method: 'POST', cookie: claimant.cookie,
    body: {
      title: 'ICAI subscription', category_id: ctx.category.id,
      amount_paise: 12000_00, expense_date: '2026-09-15',
    },
  })
  expect(created.status).toBe(200)
  const id = created.body.data.expense.id
  // Submit
  await api(`/api/expenses/${id}/submit`, { method: 'POST', cookie: claimant.cookie })
  // Manager-approve (as the same finance approver — org scope covers dept)
  await api(`/api/expenses/${id}/approve`, { method: 'POST', cookie: approver.cookie })
  // Finance-approve
  await api(`/api/expenses/${id}/approve`, { method: 'POST', cookie: approver.cookie })
  return id
}

describe('expense self-approval flag', () => {
  it('reports self_approved: true when the claimant is also the finance approver', async () => {
    const ctx = await seedOrg()
    const partner = await makeEmployeeUser(ctx, 'finance_admin')
    // The claim is submitted BY the partner and approved BY the partner.
    const id = await fullApproveExpense(ctx, partner, partner)
    // Pay it too — makes the row show `paid_by` = same employee.
    await api(`/api/expenses/${id}/pay`, { method: 'POST', cookie: partner.cookie })
    // The list is claimant-scoped for a self-only role; the partner has
    // organisation scope so they see all.
    const list = await api('/api/expenses', { cookie: partner.cookie })
    expect(list.status).toBe(200)
    const row = list.body.data.items.find((e: { id: string }) => e.id === id)
    expect(row.self_approved).toBe(true)
    expect(row.paid_by).toBe(partner.user.id)
  })

  it('reports self_approved: false when a different employee approves', async () => {
    const ctx = await seedOrg()
    const claimant = await makeEmployeeUser(ctx, 'employee')
    const finance = await makeEmployeeUser(ctx, 'finance_admin')
    const id = await fullApproveExpense(ctx, claimant, finance)
    const list = await api('/api/expenses', { cookie: finance.cookie })
    const row = list.body.data.items.find((e: { id: string }) => e.id === id)
    expect(row.self_approved).toBe(false)
  })

  it('does NOT refuse self-approval — the partner can approve their own claim', async () => {
    const ctx = await seedOrg()
    const partner = await makeEmployeeUser(ctx, 'finance_admin')
    const id = await fullApproveExpense(ctx, partner, partner)
    // The row must actually be Approved (or Paid) — not blocked.
    const detail = await api(`/api/expenses/${id}`, { cookie: partner.cookie })
    expect(detail.body.data.expense.stage).toBe('approved')
  })
})

describe('GET /api/expenses/reports/self-approved', () => {
  it('lists only self-approved rows with a running total', async () => {
    const ctx = await seedOrg()
    const partner = await makeEmployeeUser(ctx, 'finance_admin')
    const other = await makeEmployeeUser(ctx, 'employee')
    // One self-approved (partner claims + approves).
    await fullApproveExpense(ctx, partner, partner)
    // One not self-approved (other claims, partner approves).
    await fullApproveExpense(ctx, other, partner)
    const rep = await api('/api/expenses/reports/self-approved', { cookie: partner.cookie })
    expect(rep.status).toBe(200)
    expect(rep.body.data.count).toBe(1)
    expect(rep.body.data.total_paise).toBe(12000_00)
    for (const it of rep.body.data.items) expect(it.self_approved).toBe(true)
  })
})
