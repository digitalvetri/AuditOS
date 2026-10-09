import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { hashPassword, signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { setupRoles } from '../../../prisma/setup-roles.js'

/**
 * Nobody below Super Admin can create, become or touch a Super Admin, and
 * staff-managers below Admin (Senior Associate) only hand out roles ranked
 * below their own — on every path: Employees role / password / create,
 * Settings → Roles.
 */

let server: Server
let base = ''
let orgId = ''
let wsId = ''

async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

type Code = 'md' | 'hr_admin' | 'dept_manager' | 'employee' | 'intern'
/** Roles as a deployed firm has them: the module grants from setupRoles. */
const role = (code: Code) => prisma.role.findUniqueOrThrow({ where: { code } })
const rid = async (code: Code) => (await role(code)).id

async function caller(code: Code) {
  const r = await role(code)
  const u = await prisma.user.create({ data: { id: uid('u'), organisationId: orgId, email: `${uid(code)}@x.local`, passwordHash: 'x', roleId: r.id } })
  return `ao_access=${signToken(u.id)}`
}

/** An employee with a login holding `code`. */
async function staff(code: Code) {
  const r = await role(code)
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AO'), firstName: 'S', lastName: code, fullName: `S ${code}`, email: `${uid('s')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: hashPassword('Old12345'), roleId: r.id, employeeId: emp.id } })
  return { emp, user: u }
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.create({ data: { id: uid('ws'), organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('PUT /api/employees/:id/role', () => {
  it('Admin cannot make anyone Super Admin', async () => {
    const admin = await caller('hr_admin')
    const { emp } = await staff('employee')
    expect((await api(`/api/employees/${emp.id}/role`, { method: 'PUT', cookie: admin, body: { role_id: await rid('md') } })).status).toBe(400)
  })
  it('Senior Associate cannot hand out Admin, but can move someone to Intern', async () => {
    const senior = await caller('dept_manager')
    const { emp } = await staff('employee')
    expect((await api(`/api/employees/${emp.id}/role`, { method: 'PUT', cookie: senior, body: { role_id: await rid('hr_admin') } })).status).toBe(400)
    expect((await api(`/api/employees/${emp.id}/role`, { method: 'PUT', cookie: senior, body: { role_id: await rid('intern') } })).status).toBe(200)
  })
  it('Senior Associate cannot change an Admin, and Admin cannot change a Super Admin', async () => {
    const senior = await caller('dept_manager')
    const admin = await caller('hr_admin')
    const a = await staff('hr_admin')
    const m = await staff('md')
    expect((await api(`/api/employees/${a.emp.id}/role`, { method: 'PUT', cookie: senior, body: { role_id: await rid('intern') } })).status).toBe(404)
    expect((await api(`/api/employees/${m.emp.id}/role`, { method: 'PUT', cookie: admin, body: { role_id: await rid('intern') } })).status).toBe(404)
  })
  it('Super Admin can grant Super Admin', async () => {
    const md = await caller('md')
    const { emp } = await staff('employee')
    expect((await api(`/api/employees/${emp.id}/role`, { method: 'PUT', cookie: md, body: { role_id: await rid('md') } })).status).toBe(200)
  })
})

describe('PUT /api/employees/:id/password', () => {
  it('Senior Associate cannot reset an Admin; Admin cannot reset a Super Admin', async () => {
    const senior = await caller('dept_manager')
    const admin = await caller('hr_admin')
    const a = await staff('hr_admin')
    const m = await staff('md')
    expect((await api(`/api/employees/${a.emp.id}/password`, { method: 'PUT', cookie: senior, body: { password: 'Reset2026x' } })).status).toBe(404)
    expect((await api(`/api/employees/${m.emp.id}/password`, { method: 'PUT', cookie: admin, body: { password: 'Reset2026x' } })).status).toBe(404)
  })
  it('a new login for an employee without one respects the role rule', async () => {
    const senior = await caller('dept_manager')
    const r = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AO'), firstName: 'N', lastName: 'L', fullName: 'N L', email: `${uid('n')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId } })
    expect((await api(`/api/employees/${r.id}/password`, { method: 'PUT', cookie: senior, body: { password: 'Reset2026x', role_code: 'hr_admin' } })).status).toBe(400)
  })
})

describe('POST /api/employees', () => {
  it('Senior Associate cannot create an Admin login', async () => {
    const senior = await caller('dept_manager')
    const r = await api('/api/employees', { method: 'POST', cookie: senior, body: { first_name: 'A', last_name: 'B', email: `${uid('e')}@x.local`, role_code: 'hr_admin', password: 'Temp2026x' } })
    expect(r.status).toBe(400)
  })
})

describe('PUT /api/settings/roles/:roleId/modules/:module', () => {
  it('Senior Associate cannot edit the Admin role', async () => {
    const senior = await caller('dept_manager')
    expect((await api(`/api/settings/roles/${await rid('hr_admin')}/modules/hrms`, { method: 'PUT', cookie: senior, body: { access: 'none' } })).status).toBe(404)
  })
})
