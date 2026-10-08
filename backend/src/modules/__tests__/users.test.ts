import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { hashPassword, signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'

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

async function login(code: 'md' | 'hr_admin' | 'employee') {
  const u = await prisma.user.create({
    data: { id: uid('u'), organisationId: orgId, email: `${uid(code)}@x.local`, passwordHash: hashPassword('Pass1234'), roleId: roleId[code] },
  })
  return { ...u, cookie: `ao_access=${signToken(u.id)}` }
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  await prisma.workSchedule.create({
    data: { id: uid('ws'), organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' },
  })
  for (const [code, name] of [['md', 'Super Admin'], ['hr_admin', 'Admin'], ['employee', 'Associate']] as const) {
    roleId[code] = (await prisma.role.upsert({ where: { code }, update: {}, create: { id: `role-${code}`, code, name } })).id
  }
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('/api/users access', () => {
  it('is closed to non-admins', async () => {
    const emp = await login('employee')
    expect((await api('/api/users', { cookie: emp.cookie })).status).toBe(403)
  })
})

describe('create + reset', () => {
  it('creates an employee and a login that must change its password', async () => {
    const admin = await login('hr_admin')
    const email = `${uid('new')}@x.local`
    const r = await api('/api/users', {
      method: 'POST', cookie: admin.cookie,
      body: { first_name: 'Asha', last_name: 'K', email, role_id: roleId.employee, temp_password: 'Temp1234' },
    })
    expect(r.status).toBe(201)
    expect(r.body.data.user.must_change_password).toBe(true)
    expect(r.body.data.user.employee_id).toBeTruthy()
    const dup = await api('/api/users', {
      method: 'POST', cookie: admin.cookie,
      body: { first_name: 'A', last_name: 'B', email, role_id: roleId.employee, temp_password: 'Temp1234' },
    })
    expect(dup.status).toBe(409)
  })

  it('rejects a weak temporary password', async () => {
    const admin = await login('hr_admin')
    const r = await api('/api/users', {
      method: 'POST', cookie: admin.cookie,
      body: { first_name: 'A', last_name: 'B', email: `${uid('w')}@x.local`, role_id: roleId.employee, temp_password: 'abc' },
    })
    expect(r.status).toBe(400)
  })

  it('admin reset sets the flag and ends the target’s sessions', async () => {
    const admin = await login('hr_admin')
    const target = await login('employee')
    expect((await api('/api/auth/me', { cookie: target.cookie })).status).toBe(200)
    const r = await api(`/api/users/${target.id}/reset-password`, {
      method: 'POST', cookie: admin.cookie, body: { temp_password: 'Reset1234' },
    })
    expect(r.status).toBe(200)
    expect(r.body.data.user.must_change_password).toBe(true)
    expect((await api('/api/auth/me', { cookie: target.cookie })).status).toBe(401)
  })
})

describe('Super Admin is invisible to Admin', () => {
  it('is not listed, not editable, not resettable, and not assignable', async () => {
    const admin = await login('hr_admin')
    const owner = await login('md')
    const list = await api('/api/users', { cookie: admin.cookie })
    expect(list.body.data.items.some((u: { id: string }) => u.id === owner.id)).toBe(false)
    expect((await api(`/api/users/${owner.id}`, { method: 'PATCH', cookie: admin.cookie, body: { is_active: false } })).status).toBe(404)
    expect((await api(`/api/users/${owner.id}/reset-password`, { method: 'POST', cookie: admin.cookie, body: { temp_password: 'Reset1234' } })).status).toBe(404)
    const roles = await api('/api/users/roles', { cookie: admin.cookie })
    expect(roles.body.data.items.some((r: { code: string }) => r.code === 'md')).toBe(false)
    const target = await login('employee')
    expect((await api(`/api/users/${target.id}`, { method: 'PATCH', cookie: admin.cookie, body: { role_id: roleId.md } })).status).toBe(400)
  })

  it('is visible to Super Admin', async () => {
    const owner = await login('md')
    const list = await api('/api/users', { cookie: owner.cookie })
    expect(list.body.data.items.some((u: { id: string }) => u.id === owner.id)).toBe(true)
  })
})

describe('self-protection', () => {
  it('cannot change own role, deactivate self or admin-reset self', async () => {
    const admin = await login('hr_admin')
    expect((await api(`/api/users/${admin.id}`, { method: 'PATCH', cookie: admin.cookie, body: { is_active: false } })).status).toBe(409)
    expect((await api(`/api/users/${admin.id}`, { method: 'PATCH', cookie: admin.cookie, body: { role_id: roleId.employee } })).status).toBe(409)
    expect((await api(`/api/users/${admin.id}/reset-password`, { method: 'POST', cookie: admin.cookie, body: { temp_password: 'Reset1234' } })).status).toBe(409)
  })

  it('deactivation ends the target’s sessions', async () => {
    const admin = await login('hr_admin')
    const target = await login('employee')
    const r = await api(`/api/users/${target.id}`, { method: 'PATCH', cookie: admin.cookie, body: { is_active: false } })
    expect(r.status).toBe(200)
    expect((await api('/api/auth/me', { cookie: target.cookie })).status).toBe(401)
  })
})
