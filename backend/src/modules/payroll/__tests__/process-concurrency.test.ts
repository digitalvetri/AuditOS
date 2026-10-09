import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { applyPayrollInvariants } from '../db/invariants.js'

/**
 * POST /api/payroll/runs/:id/process must pay an Approved run exactly
 * once. Two concurrent requests (double-click, two Finance users) must not
 * both pass the stage check and post two sets of payments and journals:
 * one wins, the other gets 409 already_processed. Fixtures mirror
 * run-detail.test.ts.
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
    where: { id: 'org-tpc' }, update: {},
    create: { id: 'org-tpc', name: 'TestFirm' },
  })
  const dept = await prisma.department.upsert({
    where: { id: 'dep-tpc' }, update: {},
    create: { id: 'dep-tpc', organisationId: org.id, code: 'GENPC', name: 'General' },
  })
  const desg = await prisma.designation.upsert({
    where: { id: 'desg-tpc' }, update: {},
    create: { id: 'desg-tpc', organisationId: org.id, name: 'Executive' },
  })
  const loc = await prisma.workLocation.upsert({
    where: { id: 'loc-tpc' }, update: {},
    create: { id: 'loc-tpc', organisationId: org.id, name: 'HQ', latitude: 13, longitude: 80 },
  })
  const sched = await prisma.workSchedule.upsert({
    where: { id: 'sch-tpc' }, update: {},
    create: { id: 'sch-tpc', organisationId: org.id, name: 'Std', standardStart: '09:30', standardEnd: '18:30' },
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
  createdEmployees.push(emp.id)
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
    where: { id: 'org-tpc' }, update: {},
    create: { id: 'org-tpc', name: 'TestFirm' },
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
// Process checks every active employee for blockers, and other files leave
// employees behind (some still referenced by expenses). Rather than delete
// them, retire them for the duration of this file and restore them after.
// Everything this file creates is removed again in afterAll so later files
// that delete-all payroll rows are not blocked by our payslips.
const retired: { id: string; status: string }[] = []
const createdEmployees: string[] = []
const createdRuns: string[] = []
beforeAll(async () => {
  const others = await prisma.employee.findMany({
    where: { status: { not: 'inactive' } }, select: { id: true, status: true },
  })
  retired.push(...others)
  await prisma.employee.updateMany({
    where: { id: { in: others.map((e) => e.id) } }, data: { status: 'inactive' },
  })
})
afterAll(async () => {
  const items = await prisma.payrollItem.findMany({
    where: { payrollRunId: { in: createdRuns } }, select: { id: true },
  })
  await prisma.ledgerTransaction.deleteMany({
    where: { referenceType: 'PayrollItem', referenceId: { in: items.map((i) => i.id) } },
  })
  await prisma.payslip.deleteMany({ where: { payrollRunId: { in: createdRuns } } })
  await prisma.payment.deleteMany({ where: { payrollRunId: { in: createdRuns } } })
  await prisma.payrollItem.deleteMany({ where: { payrollRunId: { in: createdRuns } } })
  await prisma.payrollRun.deleteMany({ where: { id: { in: createdRuns } } })
  await prisma.notification.deleteMany({ where: { entityId: { in: createdRuns } } })
  await prisma.salaryStructure.deleteMany({ where: { employeeId: { in: createdEmployees } } })
  await prisma.employee.deleteMany({ where: { id: { in: createdEmployees } } })
  for (const e of retired) {
    await prisma.employee.update({ where: { id: e.id }, data: { status: e.status } })
  }
  server.close()
  await prisma.$disconnect()
})

describe('POST /api/payroll/runs/:id/process — concurrency', () => {
  it('processes once when two requests race for the same approved run', async () => {
    const a = await financeUser()
    const b = await financeUser()
    const ctx = await seedOrg()
    const emp = await makeEmployee(ctx, { withStructure: true, name: 'Alice' })
    const structure = await prisma.salaryStructure.findFirstOrThrow({ where: { employeeId: emp.id } })
    const run = await prisma.payrollRun.create({
      data: {
        organisationId: ctx.org.id, periodStart: '2026-05-01', periodEnd: '2026-05-31',
        stage: 'approved', headcount: 1, grossTotalPaise: 85_000_00, netTotalPaise: 83_200_00,
      },
    })
    createdRuns.push(run.id)
    await prisma.payrollItem.create({
      data: {
        payrollRunId: run.id, employeeId: emp.id, salaryStructureId: structure.id,
        payableDays: 30, presentDays: 30, onLeaveDays: 0, absentDays: 0, lopDays: 0,
        earningsJson: '{}', deductionsJson: JSON.stringify({ pf_employee_paise: 1_800_00 }),
        grossPaise: 85_000_00, totalDeductionsPaise: 1_800_00, netPaise: 83_200_00,
      },
    })

    const results = await Promise.all([
      api(`/api/payroll/runs/${run.id}/process`, { method: 'POST', cookie: a.cookie }),
      api(`/api/payroll/runs/${run.id}/process`, { method: 'POST', cookie: b.cookie }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('already_processed')

    expect(await prisma.payment.count({ where: { payrollRunId: run.id } })).toBe(1)
    expect(await prisma.payslip.count({ where: { payrollRunId: run.id } })).toBe(1)
    const item = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: run.id } })
    expect(await prisma.ledgerTransaction.count({
      where: { referenceType: 'PayrollItem', referenceId: item.id },
    })).toBe(3)
    const after = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.stage).toBe('processed')
  })
})
