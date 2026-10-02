import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { applyPayrollInvariants } from '../db/invariants.js'
import { TDS_PLAN_GROSS_THRESHOLD_PAISE } from '../../../platform/constants.js'

/**
 * Step 5 — annual TDS plan + threshold guard. The pre-fix behaviour was:
 * TDS defaulted to 0 across a firm whose gross put several employees
 * across the taxable threshold, so nobody ever typed it in. This suite
 * proves:
 *   1. The plan field round-trips.
 *   2. GET /runs/:id blockers include `tds_plan_missing` above threshold.
 *   3. POST /runs/:id/process refuses on tds_plan_missing.
 *   4. Marking exempt with a reason clears the blocker.
 *   5. The "both a plan and a reason" combination is refused with 422.
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
    where: { id: 'org-t5' }, update: {},
    create: { id: 'org-t5', name: 'TestFirm' },
  })
  const dept = await prisma.department.upsert({
    where: { id: 'dep-t5' }, update: {},
    create: { id: 'dep-t5', organisationId: org.id, code: 'GEN5', name: 'General' },
  })
  const desg = await prisma.designation.upsert({
    where: { id: 'desg-t5' }, update: {},
    create: { id: 'desg-t5', organisationId: org.id, name: 'Executive' },
  })
  const loc = await prisma.workLocation.upsert({
    where: { id: 'loc-t5' }, update: {},
    create: { id: 'loc-t5', organisationId: org.id, name: 'HQ', latitude: 13, longitude: 80 },
  })
  const sched = await prisma.workSchedule.upsert({
    where: { id: 'sch-t5' }, update: {},
    create: { id: 'sch-t5', organisationId: org.id, name: 'Std', standardStart: '09:30', standardEnd: '18:30' },
  })
  return { org, dept, desg, loc, sched }
}

async function makeEmployeeWithHighGross(
  ctx: Awaited<ReturnType<typeof seedOrg>>,
  opts: { annualPlan?: number; exemptReason?: string | null; name?: string } = {},
) {
  // Structure sum crosses the threshold on its own so pre-calculate
  // preview flags the blocker.
  const emp = await prisma.employee.create({
    data: {
      id: uid('emp'), organisationId: ctx.org.id,
      employeeCode: uid('EC'), firstName: opts.name ?? 'Big', lastName: 'Earner',
      fullName: `${opts.name ?? 'Big'} Earner`,
      type: 'partner', status: 'active',
      designationId: ctx.desg.id, departmentId: ctx.dept.id,
      workLocationId: ctx.loc.id, workScheduleId: ctx.sched.id,
      email: `${uid('e')}@x.local`, joiningDate: '2026-01-01',
      annualTdsPlanPaise: opts.annualPlan ?? 0,
      tdsExemptReason: opts.exemptReason ?? null,
    },
  })
  await prisma.salaryStructure.create({
    data: {
      employeeId: emp.id,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      basicPaise: 90_000_00,
      hraPaise: 40_000_00,
      conveyancePaise: 5_000_00,
      specialAllowancePaise: 20_000_00,
    },
  })
  return emp
}

async function hrUser() {
  const org = await prisma.organisation.upsert({
    where: { id: 'org-t5' }, update: {},
    create: { id: 'org-t5', name: 'TestFirm' },
  })
  const role = await seedRole('hr_admin', MATRIX.hr_admin)
  const u = await prisma.user.create({
    data: {
      id: uid('u'), organisationId: org.id,
      email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: role.id,
    },
  })
  return { cookie: `ao_access=${signToken(u.id)}` }
}
async function financeUser() {
  const org = await prisma.organisation.upsert({
    where: { id: 'org-t5' }, update: {},
    create: { id: 'org-t5', name: 'TestFirm' },
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

describe('PATCH /api/employees/:id/salary/tds-plan', () => {
  it('stores annual_tds_plan_paise and derives monthly = plan ÷ 12', async () => {
    const { cookie } = await hrUser()
    const ctx = await seedOrg()
    const emp = await makeEmployeeWithHighGross(ctx)
    const res = await api(`/api/employees/${emp.id}/salary/tds-plan`, {
      method: 'PATCH', cookie, body: { annual_tds_plan_paise: 120_000_00 },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.annual_tds_plan_paise).toBe(120_000_00)
    expect(res.body.data.monthly_tds_paise).toBe(10_000_00) // 1.2L / 12 = 10k
  })

  it('refuses non-zero plan combined with exempt reason', async () => {
    const { cookie } = await hrUser()
    const ctx = await seedOrg()
    const emp = await makeEmployeeWithHighGross(ctx)
    const res = await api(`/api/employees/${emp.id}/salary/tds-plan`, {
      method: 'PATCH', cookie,
      body: { annual_tds_plan_paise: 50_000_00, exempt_reason: 'no salary' },
    })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('inconsistent_tds')
  })
})

describe('GET /api/payroll/runs/:id — tds_plan_missing blocker', () => {
  it('flags an employee above threshold with zero plan and no exempt reason', async () => {
    const { cookie } = await financeUser()
    const ctx = await seedOrg()
    const emp = await makeEmployeeWithHighGross(ctx, { annualPlan: 0 })
    const run = await prisma.payrollRun.create({
      data: {
        organisationId: ctx.org.id, periodStart: '2026-09-01', periodEnd: '2026-09-30',
        stage: 'draft',
      },
    })
    const res = await api(`/api/payroll/runs/${run.id}`, { cookie })
    expect(res.status).toBe(200)
    const tdsBlockers = res.body.data.blockers.filter(
      (b: { reason: string }) => b.reason === 'tds_plan_missing',
    )
    expect(tdsBlockers).toHaveLength(1)
    expect(tdsBlockers[0].employee.id).toBe(emp.id)
    expect(res.body.data.can_process).toBe(false)
  })

  it('does not flag an employee with a non-zero plan', async () => {
    const { cookie } = await financeUser()
    const ctx = await seedOrg()
    await makeEmployeeWithHighGross(ctx, { annualPlan: 200_000_00 })
    const run = await prisma.payrollRun.create({
      data: {
        organisationId: ctx.org.id, periodStart: '2026-09-01', periodEnd: '2026-09-30',
        stage: 'draft',
      },
    })
    const res = await api(`/api/payroll/runs/${run.id}`, { cookie })
    expect(res.body.data.blockers).toHaveLength(0)
    expect(res.body.data.can_process).toBe(true)
  })

  it('does not flag an employee marked "no TDS applicable" with a reason', async () => {
    const { cookie } = await financeUser()
    const ctx = await seedOrg()
    await makeEmployeeWithHighGross(ctx, { annualPlan: 0, exemptReason: 'has only capital gains' })
    const run = await prisma.payrollRun.create({
      data: {
        organisationId: ctx.org.id, periodStart: '2026-09-01', periodEnd: '2026-09-30',
        stage: 'draft',
      },
    })
    const res = await api(`/api/payroll/runs/${run.id}`, { cookie })
    expect(res.body.data.blockers).toHaveLength(0)
  })
})

describe('POST /api/payroll/runs/:id/process — TDS blocker refusal', () => {
  it('refuses with 422 blockers_present naming the TDS-missing employee', async () => {
    const { cookie } = await financeUser()
    const ctx = await seedOrg()
    await makeEmployeeWithHighGross(ctx, { annualPlan: 0, name: 'Ravi' })
    const run = await prisma.payrollRun.create({
      data: {
        organisationId: ctx.org.id, periodStart: '2026-09-01', periodEnd: '2026-09-30',
        stage: 'approved', headcount: 1,
        grossTotalPaise: 155_000_00, netTotalPaise: 155_000_00,
      },
    })
    const res = await api(`/api/payroll/runs/${run.id}/process`, { method: 'POST', cookie })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('blockers_present')
    expect(res.body.error.message).toContain('Ravi')
    expect(res.body.error.message).toContain('TDS')
  })
})

describe('threshold constant', () => {
  it('sits above ₹0 and below ₹5,00,000 monthly gross', () => {
    expect(TDS_PLAN_GROSS_THRESHOLD_PAISE).toBeGreaterThan(0)
    expect(TDS_PLAN_GROSS_THRESHOLD_PAISE).toBeLessThan(500_000_00)
  })
})
