import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'

/**
 * Financial years in the native books (roles from setupRoles), on a company
 * whose client every caller is assigned to — so each 403 is the permission:
 *  - adding a year: Senior Associate and above;
 *  - closing or reopening one: a partner, and both are audited.
 */

type Code = 'md' | 'hr_admin' | 'dept_manager' | 'employee' | 'intern'
let server: Server
let base = ''
let orgId = ''
let wsId = ''
let companyId = ''
const who: Record<Code, string> = {} as never

async function api(path: string, cookie: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let j: any = null
  try { j = text ? JSON.parse(text) : null } catch { j = text }
  return { status: res.status, body: j && typeof j === 'object' && 'data' in j ? j.data : j }
}

async function staff(code: Code) {
  const role = await prisma.role.findUniqueOrThrow({ where: { code } })
  const emp = await prisma.employee.create({
    data: {
      organisationId: orgId, employeeCode: uid('FY'), firstName: 'F', lastName: code, fullName: uid(`F ${code}`),
      email: `${uid('fy')}@x.local`, joiningDate: '2025-01-01', status: 'active', workScheduleId: wsId,
    },
  })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  return { emp, cookie: `ao_access=${signToken(u.id)}` }
}

const C = () => `/api/bookkeeping/companies/${companyId}`

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.create({ data: { id: uid('ws'), organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  const people = {
    md: await staff('md'), hr_admin: await staff('hr_admin'), dept_manager: await staff('dept_manager'),
    employee: await staff('employee'), intern: await staff('intern'),
  }
  for (const k of Object.keys(people) as Code[]) who[k] = people[k].cookie
  const client = await prisma.client.create({
    data: {
      organisationId: orgId, clientCode: uid('FYC'), companyName: 'FY Co', contactPerson: 'P', contactNumber: '9876543210',
      onboardingDate: '2026-01-01', accountManagerId: people.employee.emp.id, secondaryManagerId: people.intern.emp.id,
    },
  })
  const r = await api('/api/bookkeeping/companies', who.md, { method: 'POST', body: { name: uid('FY Books'), books_begin_from: '2025-04-01', client_id: client.id } })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  companyId = r.body.id
})
afterAll(() => server?.close())

describe('adding a financial year: Senior Associate and above', () => {
  it('Associate and Intern are refused and nothing is added; a Senior Associate adds it', async () => {
    const before = await prisma.bookkeepingFinancialYear.count({ where: { tallyCompanyId: companyId } })
    for (const code of ['employee', 'intern'] as const) {
      const r = await api(`${C()}/financial-years`, who[code], { method: 'POST', body: { label: '2026-27', start_date: '2026-04-01', end_date: '2027-03-31' } })
      expect(r.status, code).toBe(403)
    }
    expect(await prisma.bookkeepingFinancialYear.count({ where: { tallyCompanyId: companyId } })).toBe(before)
    const ok = await api(`${C()}/financial-years`, who.dept_manager, { method: 'POST', body: { label: '2026-27', start_date: '2026-04-01', end_date: '2027-03-31' } })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    // Everyone working the client can still list them.
    expect((await api(`${C()}/financial-years`, who.intern)).status).toBe(200)
  })
})

describe('closing and reopening a financial year: partners only', () => {
  it('Intern, Associate and Senior Associate cannot close; a partner closes, then reopens, both audited', async () => {
    const fy = await prisma.bookkeepingFinancialYear.findFirstOrThrow({ where: { tallyCompanyId: companyId, label: '2026-27' } })
    for (const code of ['intern', 'employee', 'dept_manager'] as const) {
      expect((await api(`${C()}/financial-years/${fy.id}/close`, who[code], { method: 'PATCH' })).status, code).toBe(403)
    }
    expect((await prisma.bookkeepingFinancialYear.findUniqueOrThrow({ where: { id: fy.id } })).closed).toBe(false)

    const closed = await api(`${C()}/financial-years/${fy.id}/close`, who.md, { method: 'PATCH' })
    expect(closed.status).toBe(200)
    expect(closed.body.closed).toBe(true)

    for (const code of ['intern', 'employee', 'dept_manager'] as const) {
      expect((await api(`${C()}/financial-years/${fy.id}/reopen`, who[code], { method: 'PATCH' })).status, code).toBe(403)
    }
    expect((await prisma.bookkeepingFinancialYear.findUniqueOrThrow({ where: { id: fy.id } })).closed).toBe(true)

    const reopened = await api(`${C()}/financial-years/${fy.id}/reopen`, who.hr_admin, { method: 'PATCH', body: { reason: 'Audit adjustment' } })
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200)
    expect(reopened.body.closed).toBe(false)
    const actions = (await prisma.auditLog.findMany({ where: { entityId: fy.id }, select: { action: true } })).map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['tally.fy_closed', 'tally.fy_reopened']))
    // Reopening an open year is a conflict, not a silent success.
    expect((await api(`${C()}/financial-years/${fy.id}/reopen`, who.md, { method: 'PATCH' })).status).toBe(409)
  })
})
