import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { hashPassword, signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { MATRIX } from '../../platform/rbac/matrix.js'

/**
 * Passwords an Admin sets from the Employees screens follow the same rules as
 * Settings → Users: temporary (must change at next sign-in), letters and
 * numbers, and a reset ends the person's other sessions.
 */

let server: Server
let base = ''
let orgId = ''

async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function role(code: keyof typeof MATRIX) {
  for (const g of MATRIX[code]) {
    await prisma.permission.upsert({ where: { code: g.permission }, update: {}, create: { id: `perm-${g.permission}`, code: g.permission, description: g.permission } })
  }
  const r = await prisma.role.upsert({ where: { code }, update: {}, create: { id: `role-${code}`, code, name: code } })
  for (const g of MATRIX[code]) {
    await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: `perm-${g.permission}`, scope: g.scope } }).catch(() => undefined)
  }
  return r
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  await prisma.workSchedule.create({ data: { id: uid('ws'), organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })
  await role('employee')
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

async function admin() {
  const r = await role('hr_admin')
  const u = await prisma.user.create({ data: { id: uid('u'), organisationId: orgId, email: `${uid('a')}@x.local`, passwordHash: 'x', roleId: r.id } })
  return `ao_access=${signToken(u.id)}`
}

describe('Employees → passwords set by an Admin', () => {
  it('a login created with a new employee must change its password', async () => {
    const cookie = await admin()
    const email = `${uid('e')}@x.local`
    const r = await api('/api/employees', { method: 'POST', cookie, body: { first_name: 'A', last_name: 'B', email, password: 'Temp2026x' } })
    expect(r.status).toBe(200)
    const u = await prisma.user.findUniqueOrThrow({ where: { email } })
    expect(u.mustChangePassword).toBe(true)
  })

  it('rejects a typed password without letters and numbers', async () => {
    const cookie = await admin()
    const r = await api('/api/employees', { method: 'POST', cookie, body: { first_name: 'A', last_name: 'B', email: `${uid('e')}@x.local`, password: 'onlyletters' } })
    expect(r.status).toBe(400)
  })

  it('Set password makes it temporary and ends the person’s sessions', async () => {
    const cookie = await admin()
    const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AO'), firstName: 'C', lastName: 'D', fullName: 'C D', email: `${uid('e')}@x.local`, joiningDate: '2026-01-01', workScheduleId: (await prisma.workSchedule.findFirstOrThrow()).id } })
    const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: hashPassword('Old12345'), roleId: 'role-employee', employeeId: emp.id } })
    const theirs = `ao_access=${signToken(u.id)}`
    expect((await api('/api/auth/me', { cookie: theirs })).status).toBe(200)

    const r = await api(`/api/employees/${emp.id}/password`, { method: 'PUT', cookie, body: { password: 'Reset2026x' } })
    expect(r.status).toBe(200)
    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } })
    expect(after.mustChangePassword).toBe(true)
    expect((await api('/api/auth/me', { cookie: theirs })).status).toBe(401)
  })
})

describe('Deactivating an employee', () => {
  it('records today as the exit date when none was set, so payroll pays their last part-month', async () => {
    const cookie = await admin()
    const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AO'), firstName: 'L', lastName: 'V', fullName: 'L V', email: `${uid('e')}@x.local`, joiningDate: '2026-01-01', workScheduleId: (await prisma.workSchedule.findFirstOrThrow()).id } })
    const r = await api(`/api/employees/${emp.id}/deactivate`, { method: 'POST', cookie })
    expect(r.status).toBe(200)
    const after = await prisma.employee.findUniqueOrThrow({ where: { id: emp.id } })
    expect(after.exitDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('keeps an exit date HR already set', async () => {
    const cookie = await admin()
    const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AO'), firstName: 'L', lastName: 'W', fullName: 'L W', email: `${uid('e')}@x.local`, joiningDate: '2026-01-01', exitDate: '2026-09-10', workScheduleId: (await prisma.workSchedule.findFirstOrThrow()).id } })
    await api(`/api/employees/${emp.id}/deactivate`, { method: 'POST', cookie })
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: emp.id } })).exitDate).toBe('2026-09-10')
  })
})
