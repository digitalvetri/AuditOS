import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { addDays, istToday } from '../../../lib/dates.js'
import { articleshipForms, computeArticleshipLeave, sendArticleshipFormAlerts } from '../service.js'

/**
 * Articleship register: the 1/6th leave rule and the extension it causes,
 * ICAI form status and alerts, the register endpoint, recompute on leave
 * approval, and the stipend paid by payroll (no PF).
 */

describe('computeArticleshipLeave (pure)', () => {
  const t = { trainingStart: '2025-01-01', trainingEnd: '2027-12-31', status: 'active' }

  it('allows one-sixth of the period actually served', () => {
    // 2025-01-01..2025-06-30 = 181 days served → 30 allowed.
    const r = computeArticleshipLeave(t, [], '2025-06-30')
    expect(r.served_days).toBe(181)
    expect(r.leave_allowed_days).toBe(30)
    expect(r.leave_allowed_full_term_days).toBe(Math.floor(1095 / 6))
    expect(r.excess_leave_days).toBe(0)
    expect(r.extended_training_end).toBeNull()
  })

  it('extends the end date by the excess, rounded up', () => {
    const leaves = [{ startDate: '2025-03-01', endDate: '2025-04-05', computedWorkingDays: 32.5 }]
    const r = computeArticleshipLeave(t, leaves, '2025-06-30')
    expect(r.leave_taken_days).toBe(32.5)
    expect(r.excess_leave_days).toBe(3) // 32.5 − 30 → 3 days
    expect(r.extended_training_end).toBe('2028-01-03')
  })

  it('counts only the part of a leave inside the training period', () => {
    const leaves = [{ startDate: '2024-12-27', endDate: '2025-01-05', computedWorkingDays: 10 }]
    const r = computeArticleshipLeave(t, leaves, '2025-06-30')
    expect(r.leave_taken_days).toBe(5) // 5 of 10 days fall on/after the start
  })

  it('uses the whole period once training has ended', () => {
    const r = computeArticleshipLeave({ ...t, status: 'completed' }, [], '2025-02-01')
    expect(r.served_days).toBe(1095)
  })
})

describe('articleshipForms (pure)', () => {
  const base = { trainingStart: '2026-01-01', status: 'active', form102Date: null, form103Date: null, form108Date: null, form109Date: null }
  it('Form 103 is due within 30 days of commencement, then overdue', () => {
    expect(articleshipForms(base, '2026-01-15').form103).toMatchObject({ state: 'due', due_date: '2026-01-31' })
    expect(articleshipForms(base, '2026-02-01').form103.state).toBe('overdue')
    expect(articleshipForms({ ...base, form103Date: '2026-01-20' }, '2026-03-01').form103.state).toBe('filed')
  })
  it('Form 108 on completion / termination, 109 on transfer', () => {
    expect(articleshipForms({ ...base, status: 'completed' }, '2028-01-01').form108.state).toBe('due')
    expect(articleshipForms({ ...base, status: 'transferred' }, '2027-01-01').form109.state).toBe('due')
    expect(articleshipForms(base, '2027-01-01').form108.state).toBe('not_due')
  })
})

let server: Server
let base = ''
let orgId = ''
let wsId = ''
let md: { emp: { id: string }; cookie: string }

async function api(p: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${p}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any }
}

async function employee(type: string, name: string) {
  return track(await prisma.employee.create({
    data: {
      organisationId: orgId, employeeCode: uid('AR'), firstName: name, lastName: 'T', fullName: `${name} ${uid('n')}`,
      email: `${uid('a')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId, type,
    },
  }))
}
function track<T extends { id: string }>(e: T): T { created.push(e.id); return e }

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'md' } })
  const emp = await employee('executive', 'Principal')
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  md = { emp, cookie: `ao_access=${signToken(u.id)}` }
})
const created: string[] = []
afterAll(async () => {
  server.close()
  // Leave nothing that pins an employee row: other suites delete employees wholesale.
  const ids = [...created, md.emp.id]
  await prisma.payrollItem.deleteMany({ where: { employeeId: { in: ids } } })
  await prisma.salaryStructure.deleteMany({ where: { employeeId: { in: ids } } })
  await prisma.articledTraining.deleteMany({ where: { OR: [{ employeeId: { in: ids } }, { principalEmployeeId: { in: ids } }] } })
  await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: ids } } })
  await prisma.leaveBalance.deleteMany({ where: { employeeId: { in: ids } } })
  await prisma.attendance.deleteMany({ where: { employeeId: { in: ids } } })
})

describe('articleship API', () => {
  it('saves the register fields, lists the assistant, and recomputes on leave approval', async () => {
    const art = await employee('articled', 'Arti')
    const start = addDays(istToday(), -60)
    const end = addDays(start, 3 * 365 - 1)
    const save = await api(`/api/employees/${art.id}/training`, {
      method: 'PATCH', cookie: md.cookie,
      body: {
        principal_employee_id: md.emp.id, icai_registration_no: 'SRO0123456', training_start: start, training_end: end,
        current_year: 1, stipend_paise: 12_000_00, icai_region: 'SIRC — Chennai', form102_date: start,
        // Computed fields are ignored if sent.
        excess_leave_days: 99,
      },
    })
    expect(save.status).toBe(200)
    expect(save.body.data.training).toMatchObject({
      stipend_paise: 12_000_00, icai_region: 'SIRC — Chennai', form102_date: start, excess_leave_days: 0, extended_training_end: null,
    })

    // 61 days served → 10 allowed. Approve 14 days of leave → 4 excess.
    const type = await prisma.leaveType.create({
      data: { organisationId: orgId, code: uid('lv'), name: 'Casual', annualEntitlement: 30, halfDayAllowed: true, minNoticeDays: 0, accrueDuringProbation: true },
    })
    const leave = await prisma.leaveRequest.create({
      data: { employeeId: art.id, leaveTypeId: type.id, startDate: addDays(start, 10), endDate: addDays(start, 23), computedWorkingDays: 14, reason: 'Exams', status: 'pending', approverId: 'mgr' },
    })
    const approve = await api(`/api/leaves/${leave.id}/approve`, { method: 'POST', cookie: md.cookie })
    expect(approve.status).toBe(200)
    const stored = await prisma.articledTraining.findUniqueOrThrow({ where: { employeeId: art.id } })
    expect(stored.excessLeaveDays).toBe(4)
    expect(stored.extendedTrainingEnd).toBe(addDays(end, 4))

    const list = await api('/api/articleship', { cookie: md.cookie })
    expect(list.status).toBe(200)
    const row = list.body.data.items.find((i: any) => i.employee.id === art.id)
    expect(row.principal.id).toBe(md.emp.id)
    expect(row.leave).toMatchObject({ leave_allowed_days: 10, leave_taken_days: 14, excess_leave_days: 4 })
    expect(row.forms.form103.state).toBe('overdue') // 60 days in, never filed
    expect(row.training.stipend_paise).toBe(12_000_00)

    const one = await api(`/api/employees/${art.id}/training`, { cookie: md.cookie })
    expect(one.body.data.leave.excess_leave_days).toBe(4)
  })

  it('refuses the register to a plain employee', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'employee' } })
    const emp = await employee('executive', 'Plain')
    const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
    const r = await api('/api/articleship', { cookie: `ao_access=${signToken(u.id)}` })
    expect(r.status).toBe(403)
  })

  it('alerts HR once about an overdue Form 103', async () => {
    const art = await employee('articled', 'Late')
    const t = await prisma.articledTraining.create({
      data: { employeeId: art.id, icaiRegistrationNo: 'X', principalEmployeeId: md.emp.id, trainingStart: addDays(istToday(), -45), trainingEnd: addDays(istToday(), 1000) },
    })
    await sendArticleshipFormAlerts(prisma)
    await sendArticleshipFormAlerts(prisma)
    const n = await prisma.notification.count({ where: { entityType: 'articleship_form', entityId: `articleship:${t.id}:form103:overdue` } })
    const holders = await prisma.user.count({
      where: { isActive: true, deletedAt: null, role: { permissions: { some: { scope: 'organisation', permission: { code: 'employee.manage' } } } } },
    })
    expect(n).toBe(holders) // one per HR login, not doubled by the second run
  })
})

describe('payroll pays the stipend', () => {
  it('uses stipendPaise as the monthly amount with no PF, creating a structure if none exists', async () => {
    const art = await employee('articled', 'Stipend')
    await prisma.articledTraining.create({
      data: { employeeId: art.id, icaiRegistrationNo: 'Y', principalEmployeeId: md.emp.id, trainingStart: '2026-01-01', trainingEnd: '2028-12-31', stipendPaise: 9_000_00 },
    })
    for (const [code, value] of [['pf.employee_rate', '0.12'], ['pf.employer_rate', '0.12'], ['pf.wage_ceiling', '15000'], ['esi.gross_threshold', '21000'], ['esi.employee_rate', '0.0075'], ['esi.employer_rate', '0.0325']]) {
      if (!await prisma.statutoryRate.findFirst({ where: { code, deletedAt: null } })) {
        await prisma.statutoryRate.create({ data: { organisationId: orgId, code, value, effectiveFrom: '2020-01-01' } })
      }
    }
    const run = await prisma.payrollRun.create({ data: { organisationId: orgId, periodStart: '2034-03-01', periodEnd: '2034-03-31', stage: 'draft' } })
    const detail = await api(`/api/payroll/runs/${run.id}`, { cookie: md.cookie })
    expect(detail.status).toBe(200)
    expect(detail.body.data.blockers.find((b: any) => b.employee.id === art.id)).toBeUndefined()

    const calc = await api(`/api/payroll/runs/${run.id}/calculate`, { method: 'POST', cookie: md.cookie })
    expect(calc.status).toBe(200)
    const item = await prisma.payrollItem.findFirstOrThrow({ where: { payrollRunId: run.id, employeeId: art.id }, include: { salaryStructure: true } })
    expect(item.grossPaise).toBe(9_000_00)
    const ded = JSON.parse(item.deductionsJson)
    expect(ded.pf_employee_paise).toBe(0)
    expect(ded.pf_employer_paise).toBe(0)
    expect(item.salaryStructure.basicPaise).toBe(9_000_00)
  })
})
