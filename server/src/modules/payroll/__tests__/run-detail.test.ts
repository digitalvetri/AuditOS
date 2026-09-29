import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { applyPayrollInvariants } from '../db/invariants.js'

/**
 * Step 4 — GET /api/payroll/runs/:id and POST /process refuse when any
 * active employee has no salary structure covering the period.
 *
 * The pre-fix Sept run had headcount = 7 and gross ₹41,666 below August:
 * headcount was counted from active employees while gross was counted
 * from employees-with-a-structure, so one silent zero row dropped gross
 * by one salary without anyone noticing.
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
    where: { id: 'org-t4' }, update: {},
    create: { id: 'org-t4', name: 'TestFirm' },
  })
  const dept = await prisma.department.upsert({
    where: { id: 'dep-t4' }, update: {},
    create: { id: 'dep-t4', organisationId: org.id, code: 'GEN', name: 'General' },
  })
  const desg = await prisma.designation.upsert({
    where: { id: 'desg-t4' }, update: {},
    create: { id: 'desg-t4', organisationId: org.id, name: 'Executive' },
  })
  const loc = await prisma.workLocation.upsert({
    where: { id: 'loc-t4' }, update: {},
    create: { id: 'loc-t4', organisationId: org.id, name: 'HQ', latitude: 13, longitude: 80 },
  })
  const sched = await prisma.workSchedule.upsert({
    where: { id: 'sch-t4' }, update: {},
    create: { id: 'sch-t4', organisationId: org.id, name: 'Std', standardStart: '09:30', standardEnd: '18:30' },
  })
  return { org, dept, desg, loc, sched }
}

async function makeEmployee(
  ctx: Awaited<ReturnType<typeof seedOrg>>,
  opts: { withStructure: boolean; name?: string; joining?: string } = { withStructure: true },
) {
  const emp = await prisma.employee.create({
    data: {
      id: uid('emp'), organisationId: ctx.org.id,
      employeeCode: uid('EC'), firstName: opts.name ?? 'A', lastName: 'B', fullName: `${opts.name ?? 'A'} B`,
      type: 'executive', status: 'active',
      designationId: ctx.desg.id, departmentId: ctx.dept.id,
      workLocationId: ctx.loc.id, workScheduleId: ctx.sched.id,
      email: `${uid('e')}@x.local`, joiningDate: opts.joining ?? '2026-01-01',
    },
  })
  if (opts.withStructure) {
    await prisma.salaryStructure.create({
      data: {
        employeeId: emp.id,
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        basicPaise: 50_000_00,
        hraPaise: 20_000_00,
        conveyancePaise: 5_000_00,
        specialAllowancePaise: 10_000_00,
      },
    })
  }
  return emp
}

async function financeUser() {
  const org = await prisma.organisation.upsert({
    where: { id: 'org-t4' }, update: {},
    create: { id: 'org-t4', name: 'TestFirm' },
  })
  const role = await seedRole('finance_admin', MATRIX.finance_admin)
  const u = await prisma.user.create({
    data: {
      id: uid('u'), organisationId: org.id,
      email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: role.id,
    },
  })
  return { cookie: `ao_access=${signToken(u.id)}` }
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
  await applyPayrollInvariants(prisma)
})
afterAll(async () => { server.close(); await prisma.$disconnect() })
beforeEach(async () => {
  await prisma.payrollItem.deleteMany({})
  await prisma.payrollRun.deleteMany({})
  await prisma.salaryStructure.deleteMany({})
  await prisma.employee.deleteMany({})
})

describe('GET /api/payroll/runs/:id blockers + variance + label', () => {
  it('exposes the human label PR/YYYY-MM', async () => {
    const { cookie } = await financeUser()
    const ctx = await seedOrg()
    await makeEmployee(ctx, { withStructure: true, name: 'Alice' })
    const run = await prisma.payrollRun.create({
      data: { organisationId: ctx.org.id, periodStart: '2026-07-01', periodEnd: '2026-07-31', stage: 'draft' },
    })
    const res = await api(`/api/payroll/runs/${run.id}`, { cookie })
    expect(res.status).toBe(200)
    expect(res.body.data.run.label).toBe('PR/2026-07')
  })

  it('returns a blocker row for an employee with no salary structure', async () => {
    const { cookie } = await financeUser()
    const ctx = await seedOrg()
    await makeEmployee(ctx, { withStructure: true, name: 'Ravi' })
    const noStruct = await makeEmployee(ctx, { withStructure: false, name: 'Divya' })
    const run = await prisma.payrollRun.create({
      data: { organisationId: ctx.org.id, periodStart: '2026-09-01', periodEnd: '2026-09-30', stage: 'draft' },
    })
    const res = await api(`/api/payroll/runs/${run.id}`, { cookie })
    expect(res.status).toBe(200)
    expect(res.body.data.blockers).toHaveLength(1)
    expect(res.body.data.blockers[0].employee.id).toBe(noStruct.id)
    expect(res.body.data.blockers[0].reason).toBe('no_salary_structure')
    expect(res.body.data.can_process).toBe(false)
  })

  it('reports variance vs the previous approved run at the same headcount', async () => {
    const { cookie } = await financeUser()
    const ctx = await seedOrg()
    await makeEmployee(ctx, { withStructure: true })
    await prisma.payrollRun.create({
      data: {
        organisationId: ctx.org.id, periodStart: '2026-07-01', periodEnd: '2026-07-31',
        stage: 'processed', headcount: 1, grossTotalPaise: 100_000_00,
      },
    })
    const sept = await prisma.payrollRun.create({
      data: {
        organisationId: ctx.org.id, periodStart: '2026-09-01', periodEnd: '2026-09-30',
        stage: 'draft', headcount: 1, grossTotalPaise: 58_334_00,
      },
    })
    const res = await api(`/api/payroll/runs/${sept.id}`, { cookie })
    expect(res.status).toBe(200)
    expect(res.body.data.variance).not.toBeNull()
    expect(res.body.data.variance.previous_label).toBe('PR/2026-07')
    expect(res.body.data.variance.delta_paise).toBe(-41_666_00)
    expect(res.body.data.variance.same_headcount).toBe(true)
  })

  it('returns null variance when previous month has a different headcount', async () => {
    const { cookie } = await financeUser()
    const ctx = await seedOrg()
    await makeEmployee(ctx, { withStructure: true })
    await prisma.payrollRun.create({
      data: {
        organisationId: ctx.org.id, periodStart: '2026-07-01', periodEnd: '2026-07-31',
        stage: 'processed', headcount: 8, grossTotalPaise: 100_000_00,
      },
    })
    const sept = await prisma.payrollRun.create({
      data: {
        organisationId: ctx.org.id, periodStart: '2026-09-01', periodEnd: '2026-09-30',
        stage: 'draft', headcount: 7, grossTotalPaise: 90_000_00,
      },
    })
    const res = await api(`/api/payroll/runs/${sept.id}`, { cookie })
    expect(res.body.data.variance).toBeNull()
  })
})

describe('POST /api/payroll/runs/:id/process refuses blockers', () => {
  it('refuses to process an approved run while any employee lacks a structure', async () => {
    const { cookie } = await financeUser()
    const ctx = await seedOrg()
    await makeEmployee(ctx, { withStructure: true, name: 'Alice' })
    await makeEmployee(ctx, { withStructure: false, name: 'NoStruct' })
    const run = await prisma.payrollRun.create({
      data: {
        organisationId: ctx.org.id, periodStart: '2026-09-01', periodEnd: '2026-09-30',
        stage: 'approved', headcount: 1, grossTotalPaise: 85_000_00, netTotalPaise: 80_000_00,
      },
    })
    const res = await api(`/api/payroll/runs/${run.id}/process`, { method: 'POST', cookie })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('blockers_present')
  })
})
