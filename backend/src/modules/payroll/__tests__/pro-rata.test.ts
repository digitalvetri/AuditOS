import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { applyPayrollInvariants } from '../db/invariants.js'

/**
 * End-to-end: calculate → process for a month that has a mid-month joiner,
 * a mid-month leaver (already deactivated), an employee who left last month,
 * and an employee whose TDS plan exceeds their pay.
 *
 * Pre-fix: the joiner was skipped (no structure effective on the 1st), the
 * leaver was dropped (status inactive / soft-deleted), and processing threw
 * "Journal unbalanced" because net floored at zero while TDS kept its value.
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
    where: { id: 'org-pr' }, update: {},
    create: { id: 'org-pr', name: 'TestFirm' },
  })
  const dept = await prisma.department.upsert({
    where: { id: 'dep-pr' }, update: {},
    create: { id: 'dep-pr', organisationId: org.id, code: 'GENPR', name: 'General PR' },
  })
  const desg = await prisma.designation.upsert({
    where: { id: 'desg-pr' }, update: {},
    create: { id: 'desg-pr', organisationId: org.id, name: 'Executive' },
  })
  const loc = await prisma.workLocation.upsert({
    where: { id: 'loc-pr' }, update: {},
    create: { id: 'loc-pr', organisationId: org.id, name: 'HQ', latitude: 13, longitude: 80 },
  })
  const sched = await prisma.workSchedule.upsert({
    where: { id: 'sch-pr' }, update: {},
    create: { id: 'sch-pr', organisationId: org.id, name: 'Std', standardStart: '09:30', standardEnd: '18:30' },
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

async function makeEmployee(
  ctx: Awaited<ReturnType<typeof seedOrg>>,
  opts: {
    name: string; joining: string; structureFrom?: string; exit?: string | null
    inactive?: boolean; annualTds?: number
  },
) {
  const emp = await prisma.employee.create({
    data: {
      id: uid('emp'), organisationId: ctx.org.id,
      employeeCode: uid('EC'), firstName: opts.name, lastName: 'B', fullName: `${opts.name} B`,
      type: 'executive', status: opts.inactive ? 'inactive' : 'active',
      deletedAt: opts.inactive ? new Date() : null,
      designationId: ctx.desg.id, departmentId: ctx.dept.id,
      workLocationId: ctx.loc.id, workScheduleId: ctx.sched.id,
      email: `${uid('e')}@x.local`, joiningDate: opts.joining, exitDate: opts.exit ?? null,
      annualTdsPlanPaise: opts.annualTds ?? 0,
    },
  })
  await prisma.salaryStructure.create({
    data: {
      employeeId: emp.id,
      effectiveFrom: opts.structureFrom ?? opts.joining,
      effectiveTo: null,
      basicPaise: 50_000_00,
      hraPaise: 20_000_00,
      conveyancePaise: 5_000_00,
      specialAllowancePaise: 10_000_00,
    },
  })
  return emp
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

describe('payroll joiners, leavers and over-deducted employees', () => {
  it('includes and pro-rates a mid-month joiner and leaver, and processes with a balanced ledger', async () => {
    const ctx = await seedOrg()
    const { cookie } = await mdUser(ctx.org.id)
    const full = await makeEmployee(ctx, { name: 'Full', joining: '2026-01-01' })
    const joiner = await makeEmployee(ctx, { name: 'Joiner', joining: '2026-09-16' })
    const leaver = await makeEmployee(ctx, {
      name: 'Leaver', joining: '2025-01-01', exit: '2026-09-10', inactive: true,
    })
    const gone = await makeEmployee(ctx, {
      name: 'Gone', joining: '2025-01-01', exit: '2026-08-20', inactive: true,
    })
    // Monthly TDS ₹1,00,000 against ₹85,000 gross.
    const overTaxed = await makeEmployee(ctx, { name: 'Taxed', joining: '2026-01-01', annualTds: 1_200_000_00 })
    // Absent all 30 days: gross 0, every deduction 0, nothing to journal.
    const absent = await makeEmployee(ctx, { name: 'Absent', joining: '2026-01-01', annualTds: 120_000_00 })
    for (let d = 1; d <= 30; d++) {
      await prisma.attendance.create({
        data: { employeeId: absent.id, date: `2026-09-${String(d).padStart(2, '0')}`, status: 'absent' },
      })
    }

    const run = await prisma.payrollRun.create({
      data: { organisationId: ctx.org.id, periodStart: '2026-09-01', periodEnd: '2026-09-30', stage: 'draft' },
    })

    const detail = await api(`/api/payroll/runs/${run.id}`, { cookie })
    expect(detail.status).toBe(200)
    expect(detail.body.data.blockers).toEqual([])

    const calc = await api(`/api/payroll/runs/${run.id}/calculate`, { method: 'POST', cookie })
    expect(calc.status).toBe(200)
    const items = calc.body.data.items as {
      employee_id: string; payable_days: number; lop_days: number; gross_paise: number; net_paise: number
      total_deductions_paise: number
    }[]
    const by = (id: string) => items.find((i) => i.employee_id === id)
    expect(items).toHaveLength(5)
    expect(by(gone.id)).toBeUndefined()

    expect(by(full.id)?.gross_paise).toBe(85_000_00)
    expect(by(full.id)?.payable_days).toBe(30)

    expect(by(joiner.id)?.payable_days).toBe(15)
    expect(by(joiner.id)?.lop_days).toBe(0)
    expect(by(joiner.id)?.gross_paise).toBe(42_500_00)

    expect(by(leaver.id)?.payable_days).toBe(10)
    expect(by(leaver.id)?.gross_paise).toBe(28_334_00)

    expect(by(overTaxed.id)?.net_paise).toBe(0)
    expect(by(absent.id)?.lop_days).toBe(30)
    expect(by(absent.id)?.gross_paise).toBe(0)
    expect(by(absent.id)?.total_deductions_paise).toBe(0)
    for (const i of items) expect(i.gross_paise).toBe(i.net_paise + i.total_deductions_paise)

    await prisma.payrollRun.update({ where: { id: run.id }, data: { stage: 'approved' } })
    const proc = await api(`/api/payroll/runs/${run.id}/process`, { method: 'POST', cookie })
    expect(proc.status).toBe(200)
    expect(proc.body.data.payslips).toHaveLength(5)
    const absentPayment = await prisma.payment.findFirst({ where: { employeeId: absent.id } })
    expect(absentPayment?.amountPaise).toBe(0)
    expect(await prisma.ledgerTransaction.count({ where: { employeeId: absent.id } })).toBe(0)

    const ledger = await prisma.ledgerTransaction.findMany({ where: { type: 'Payroll' } })
    const dr = ledger.reduce((s, l) => s + l.debitPaise, 0)
    const cr = ledger.reduce((s, l) => s + l.creditPaise, 0)
    expect(dr).toBe(cr)
    expect(dr).toBe(85_000_00 + 42_500_00 + 28_334_00 + 85_000_00)
  })
})
