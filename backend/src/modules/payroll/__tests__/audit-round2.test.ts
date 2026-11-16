import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { applyPayrollInvariants } from '../db/invariants.js'

/**
 * Audit round 2 — payroll guards:
 *   1. Process refuses a run that silently omits a payable employee.
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
    where: { id: 'org-s1' }, update: {},
    create: { id: 'org-s1', name: 'TestFirm' },
  })
  const dept = await prisma.department.upsert({
    where: { id: 'dep-s1' }, update: {},
    create: { id: 'dep-s1', organisationId: org.id, code: 'GENS1', name: 'General S1' },
  })
  const desg = await prisma.designation.upsert({
    where: { id: 'desg-s1' }, update: {},
    create: { id: 'desg-s1', organisationId: org.id, name: 'Executive' },
  })
  const loc = await prisma.workLocation.upsert({
    where: { id: 'loc-s1' }, update: {},
    create: { id: 'loc-s1', organisationId: org.id, name: 'HQ', latitude: 13, longitude: 80 },
  })
  const sched = await prisma.workSchedule.upsert({
    where: { id: 'sch-s1' }, update: {},
    create: { id: 'sch-s1', organisationId: org.id, name: 'Std', standardStart: '09:30', standardEnd: '18:30' },
  })
  const rates: [string, string][] = [
    ['pf.employee_rate', '0.12'], ['pf.employer_rate', '0.12'], ['pf.wage_ceiling', '15000'],
    ['esi.gross_threshold', '21000'], ['esi.employee_rate', '0.0075'], ['esi.employer_rate', '0.0325'],
  ]
  for (const [code, value] of rates) {
    await prisma.statutoryRate.create({
      data: { organisationId: org.id, code, value, effectiveFrom: '2020-01-01' },
    })
  }
  return { org, dept, desg, loc, sched }
}

type Ctx = Awaited<ReturnType<typeof seedOrg>>

/** Monthly gross of a structure = basic only (everything else zero), in rupees. */
async function makeEmployee(
  ctx: Ctx,
  opts: {
    name: string; joining: string; annualTds?: number
    structures?: { from: string; to?: string | null; grossRupees: number }[]
  },
) {
  const emp = await prisma.employee.create({
    data: {
      id: uid('emp'), organisationId: ctx.org.id,
      employeeCode: uid('EC'), firstName: opts.name, lastName: 'S', fullName: `${opts.name} S`,
      type: 'executive', status: 'active', pfApplicable: false,
      designationId: ctx.desg.id, departmentId: ctx.dept.id,
      workLocationId: ctx.loc.id, workScheduleId: ctx.sched.id,
      email: `${uid('e')}@x.local`, joiningDate: opts.joining,
      annualTdsPlanPaise: opts.annualTds ?? 0,
    },
  })
  for (const s of opts.structures ?? [{ from: opts.joining, grossRupees: 20_000 }]) {
    await prisma.salaryStructure.create({
      data: {
        employeeId: emp.id, effectiveFrom: s.from, effectiveTo: s.to ?? null,
        basicPaise: s.grossRupees * 100,
      },
    })
  }
  return emp
}

async function makeRun(ctx: Ctx, ym: string, last: number) {
  return prisma.payrollRun.create({
    data: { organisationId: ctx.org.id, periodStart: `${ym}-01`, periodEnd: `${ym}-${last}`, stage: 'draft' },
  })
}

async function mdUser(orgId: string) {
  const role = await seedRole('md', MATRIX.md)
  const u = await prisma.user.create({
    data: {
      id: uid('u'), organisationId: orgId,
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

async function wipe() {
  await prisma.attendance.deleteMany({})
  await prisma.leaveRequest.deleteMany({})
  await prisma.holiday.deleteMany({})
  await prisma.ledgerTransaction.deleteMany({})
  await prisma.payslip.deleteMany({})
  await prisma.payment.deleteMany({})
  await prisma.payrollItem.deleteMany({})
  await prisma.payrollRun.deleteMany({})
  await prisma.salaryStructure.deleteMany({})
  await prisma.statutoryRate.deleteMany({})
  await prisma.notification.deleteMany({})
  await prisma.employee.deleteMany({})
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  await applyPayrollInvariants(prisma)
})
afterAll(async () => { await wipe(); server.close(); await prisma.$disconnect() })
beforeEach(wipe)

describe('1. Process refuses a run that omits a payable employee', () => {
  it('returns 409 naming an employee whose structure was added after Calculate', async () => {
    const ctx = await seedOrg()
    const { cookie } = await mdUser(ctx.org.id)
    await makeEmployee(ctx, { name: 'Early', joining: '2026-01-01' })
    const run = await makeRun(ctx, '2026-09', 30)
    const calc = await api(`/api/payroll/runs/${run.id}/calculate`, { method: 'POST', cookie })
    expect(calc.status).toBe(200)
    expect(calc.body.data.items).toHaveLength(1)

    // Joins the headcount after the run was calculated.
    await makeEmployee(ctx, { name: 'Latecomer', joining: '2026-01-01' })
    await prisma.payrollRun.update({ where: { id: run.id }, data: { stage: 'approved' } })

    const proc = await api(`/api/payroll/runs/${run.id}/process`, { method: 'POST', cookie })
    expect(proc.status).toBe(409)
    expect(proc.body.error.code).toBe('employees_missing_from_run')
    expect(proc.body.error.message).toContain('Latecomer S')
    const fresh = await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(fresh.stage).toBe('approved')
    expect(await prisma.payslip.count()).toBe(0)

    // Run detail tells the same story before anyone presses Process.
    const detail = await api(`/api/payroll/runs/${run.id}`, { cookie })
    expect(detail.body.data.can_process).toBe(false)
    expect(detail.body.data.blockers.map((b: { reason: string }) => b.reason)).toContain('not_in_run')
  })

  it('processes normally when every payable employee has a line', async () => {
    const ctx = await seedOrg()
    const { cookie } = await mdUser(ctx.org.id)
    await makeEmployee(ctx, { name: 'One', joining: '2026-01-01' })
    await makeEmployee(ctx, { name: 'Two', joining: '2026-01-01' })
    const run = await makeRun(ctx, '2026-09', 30)
    expect((await api(`/api/payroll/runs/${run.id}/calculate`, { method: 'POST', cookie })).status).toBe(200)
    await prisma.payrollRun.update({ where: { id: run.id }, data: { stage: 'approved' } })
    const proc = await api(`/api/payroll/runs/${run.id}/process`, { method: 'POST', cookie })
    expect(proc.status).toBe(200)
    expect(proc.body.data.payslips).toHaveLength(2)
  })
})

describe('2. Attendance-gap warnings (pay unchanged)', () => {
  // September 2026, Mon–Fri schedule: 22 working days (1st is a Tuesday).
  const workingDays = (from: number, to: number) => {
    const out: string[] = []
    for (let d = from; d <= to; d++) {
      const iso = `2026-09-${String(d).padStart(2, '0')}`
      const wd = new Date(`${iso}T00:00:00Z`).getUTCDay()
      if (wd !== 0 && wd !== 6) out.push(iso)
    }
    return out
  }

  it('counts working days with no attendance and no approved leave, on Calculate and run detail', async () => {
    const ctx = await seedOrg()
    const { cookie } = await mdUser(ctx.org.id)
    const gappy = await makeEmployee(ctx, { name: 'Gappy', joining: '2026-01-01' })
    const full = await makeEmployee(ctx, { name: 'Full', joining: '2026-01-01' })
    const joiner = await makeEmployee(ctx, { name: 'Joiner', joining: '2026-09-28' })

    await prisma.holiday.create({ data: { organisationId: ctx.org.id, date: '2026-09-15', name: 'Festival' } })
    const casual = await prisma.leaveType.upsert({
      where: { id: 'lt-s1-casual' }, update: {},
      create: { id: 'lt-s1-casual', organisationId: ctx.org.id, code: 'casual', name: 'Casual' },
    })
    await prisma.leaveRequest.create({
      data: {
        employeeId: gappy.id, leaveTypeId: casual.id, startDate: '2026-09-08', endDate: '2026-09-09',
        computedWorkingDays: 2, reason: 'x', status: 'approved',
      },
    })
    // Gappy: no row on 1, 2, 3 (gap), 8, 9 (approved leave), 15 (holiday).
    const skip = new Set(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-08', '2026-09-09', '2026-09-15'])
    for (const date of workingDays(1, 30)) {
      if (!skip.has(date)) await prisma.attendance.create({ data: { employeeId: gappy.id, date, status: 'present' } })
      await prisma.attendance.create({ data: { employeeId: full.id, date, status: 'present' } })
    }

    const run = await makeRun(ctx, '2026-09', 30)
    const calc = await api(`/api/payroll/runs/${run.id}/calculate`, { method: 'POST', cookie })
    expect(calc.status).toBe(200)
    type W = { employee: { id: string }; days_without_attendance: number; message: string }
    const byEmp = (ws: W[]) => Object.fromEntries(ws.map((w) => [w.employee.id, w.days_without_attendance]))
    expect(byEmp(calc.body.data.warnings)).toEqual({ [gappy.id]: 3, [joiner.id]: 3 })
    expect((calc.body.data.warnings as W[]).find((w) => w.employee.id === gappy.id)?.message)
      .toBe('3 days with no attendance record — paid as present')

    // Pay is unchanged: no LOP for the gaps.
    const gItem = (calc.body.data.items as { employee_id: string; lop_days: number; gross_paise: number }[])
      .find((i) => i.employee_id === gappy.id)
    expect(gItem?.lop_days).toBe(0)
    expect(gItem?.gross_paise).toBe(20_000_00)

    const detail = await api(`/api/payroll/runs/${run.id}`, { cookie })
    expect(byEmp(detail.body.data.warnings)).toEqual({ [gappy.id]: 3, [joiner.id]: 3 })
    expect(detail.body.data.can_process).toBe(true)
  })
})
