import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { hashPassword, signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { setupRoles } from '../../../prisma/setup-roles.js'
import { addDays, istToday } from '../../lib/dates.js'

/**
 * Nothing seeds LeaveBalance rows any more, so the leave module has to give
 * each employee their entitlement for the fiscal year itself — otherwise
 * every Casual/Earned request is refused for "insufficient balance".
 */

let server: Server
let base = ''
let orgId = ''
const roleId: Record<string, string> = {}

async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

/** Indian FY start ('YYYY-04-01') for a date. */
function fyOf(iso: string) {
  const [y, m] = iso.split('-').map(Number)
  return `${m >= 4 ? y : y - 1}-04-01`
}

/** A Monday at least a week out, whose Mon–Wed stays inside one fiscal year. */
function upcomingMonday() {
  let d = addDays(istToday(), 7)
  for (;;) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay()
    if (dow === 1 && fyOf(d) === fyOf(addDays(d, 2))) return d
    d = addDays(d, 1)
  }
}

async function leaveType(organisationId: string, annualEntitlement: number) {
  return prisma.leaveType.create({
    data: {
      organisationId, code: uid('casual'), name: 'Casual', annualEntitlement,
      halfDayAllowed: true, minNoticeDays: 0, accrueDuringProbation: true,
    },
  })
}

async function loginFor(employeeId: string, email: string) {
  const u = await prisma.user.create({
    data: { organisationId: orgId, email, passwordHash: hashPassword('Pass1234'), roleId: roleId.employee, employeeId },
  })
  return `ao_access=${signToken(u.id)}`
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  await prisma.workSchedule.create({ data: { id: uid('ws'), organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })
  await setupRoles(prisma, { force: true })
  // Other test files may have created these roles first under different ids.
  for (const r of await prisma.role.findMany()) roleId[r.code] = r.id
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('Leave balances', () => {
  it('an employee added through the API can apply for Casual leave', async () => {
    const hr = await prisma.user.create({
      data: { organisationId: orgId, email: `${uid('hr')}@x.local`, passwordHash: 'x', roleId: roleId.hr_admin },
    })
    // The route files the employee under the first organisation (same query); the type lives there.
    const firstOrg = await prisma.organisation.findFirstOrThrow({ where: { deletedAt: null } })
    const type = await leaveType(firstOrg.id, 12)
    const email = `${uid('e')}@x.local`
    const created = await api('/api/employees', {
      method: 'POST', cookie: `ao_access=${signToken(hr.id)}`,
      // Joined on the first day of the fiscal year, so the whole year's quota
      // applies (mid-year joiners are pro-rated: domain/__tests__/leaveBalances.test.ts).
      body: { first_name: 'Asha', last_name: 'K', email, password: 'Temp2026x', joining_date: fyOf(istToday()) },
    })
    expect(created.status).toBe(200)
    const emp = await prisma.employee.findFirstOrThrow({ where: { email } })
    expect(emp.organisationId).toBe(firstOrg.id)
    // Created with the employee, before anything reads it.
    const row = await prisma.leaveBalance.findUnique({
      where: {
        employeeId_leaveTypeId_fiscalYearStart: {
          employeeId: emp.id, leaveTypeId: type.id, fiscalYearStart: fyOf(istToday()),
        },
      },
    })
    expect(row?.entitled).toBe(12)

    // They have signed in and chosen their own password since.
    const login = await prisma.user.update({ where: { email }, data: { mustChangePassword: false } })
    const cookie = `ao_access=${signToken(login.id)}`
    const start = upcomingMonday()
    const r = await api('/api/leaves', {
      method: 'POST', cookie,
      body: { leave_type_id: type.id, start_date: start, end_date: addDays(start, 1), reason: 'Family' },
    })
    expect(r.body?.error?.code).toBeUndefined()
    expect(r.status).toBe(200)

    const balances = await api(`/api/leaves/balances/${emp.id}`, { cookie })
    expect(balances.status).toBe(200)
    const mine = balances.body.data.items.find((i: { type: { id: string } }) => i.type.id === type.id)
    expect(mine.entitled).toBe(12)
    expect(mine.pending).toBe(2)
  })

  it('next fiscal year’s balance does not count toward this year', async () => {
    const type = await leaveType(orgId, 1)
    const email = `${uid('e')}@x.local`
    const emp = await prisma.employee.create({
      data: {
        organisationId: orgId, employeeCode: uid('AO'), firstName: 'B', lastName: 'C', fullName: 'B C',
        email, joiningDate: '2025-01-01', status: 'active',
        workScheduleId: (await prisma.workSchedule.findFirstOrThrow({ where: { organisationId: orgId } })).id,
      },
    })
    const start = upcomingMonday()
    const [y] = fyOf(start).split('-').map(Number)
    await prisma.leaveBalance.create({
      data: { employeeId: emp.id, leaveTypeId: type.id, fiscalYearStart: `${y + 1}-04-01`, entitled: 30 },
    })
    const cookie = await loginFor(emp.id, email)

    const r = await api('/api/leaves', {
      method: 'POST', cookie,
      body: { leave_type_id: type.id, start_date: start, end_date: addDays(start, 2), reason: 'Trip' },
    })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('insufficient_balance')
  })

  it('approval deducts from the fiscal year of the leave', async () => {
    const type = await leaveType(orgId, 12)
    const email = `${uid('e')}@x.local`
    const emp = await prisma.employee.create({
      data: {
        organisationId: orgId, employeeCode: uid('AO'), firstName: 'D', lastName: 'E', fullName: 'D E',
        email, joiningDate: '2025-01-01', status: 'active',
        workScheduleId: (await prisma.workSchedule.findFirstOrThrow({ where: { organisationId: orgId } })).id,
      },
    })
    const start = upcomingMonday()
    const [y] = fyOf(start).split('-').map(Number)
    const next = await prisma.leaveBalance.create({
      data: { employeeId: emp.id, leaveTypeId: type.id, fiscalYearStart: `${y + 1}-04-01`, entitled: 12 },
    })
    const cookie = await loginFor(emp.id, email)
    const applied = await api('/api/leaves', {
      method: 'POST', cookie,
      body: { leave_type_id: type.id, start_date: start, end_date: addDays(start, 1), reason: 'Rest' },
    })
    expect(applied.status).toBe(200)

    const hr = await prisma.user.create({
      data: { organisationId: orgId, email: `${uid('hr')}@x.local`, passwordHash: 'x', roleId: roleId.hr_admin },
    })
    const approved = await api(`/api/leaves/${applied.body.data.request.id}/approve`, {
      method: 'POST', cookie: `ao_access=${signToken(hr.id)}`,
    })
    expect(approved.status).toBe(200)

    const thisYear = await prisma.leaveBalance.findUniqueOrThrow({
      where: { employeeId_leaveTypeId_fiscalYearStart: { employeeId: emp.id, leaveTypeId: type.id, fiscalYearStart: fyOf(start) } },
    })
    expect(thisYear.availed).toBe(2)
    expect((await prisma.leaveBalance.findUniqueOrThrow({ where: { id: next.id } })).availed).toBe(0)
  })
})
