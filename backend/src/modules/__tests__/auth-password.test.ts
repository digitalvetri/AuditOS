import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { hashPassword } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'

/**
 * Forced password change after an Admin-issued password, and the
 * self-service change-password endpoint (which also ends older sessions).
 */

let server: Server
let base = ''

async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  const setCookie = res.headers.get('set-cookie')
  const cookie = setCookie ? setCookie.split(';')[0] : null
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie }
}

async function makeUser(password: string, mustChange: boolean) {
  const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
  const role = await prisma.role.upsert({
    where: { code: 'employee' }, update: {}, create: { id: 'role-employee', code: 'employee', name: 'Associate' },
  })
  const email = `${uid('e')}@x.local`
  await prisma.user.create({
    data: { id: uid('u'), organisationId: org.id, email, passwordHash: hashPassword(password), roleId: role.id, mustChangePassword: mustChange },
  })
  return email
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('forced password change', () => {
  it('reports must_change_password and blocks other APIs until changed', async () => {
    const email = await makeUser('Temp1234', true)
    const login = await api('/api/auth/login', { method: 'POST', body: { email, password: 'Temp1234' } })
    expect(login.status).toBe(200)
    expect(login.body.data.must_change_password).toBe(true)

    const me = await api('/api/auth/me', { cookie: login.cookie! })
    expect(me.status).toBe(200)
    const blocked = await api('/api/notifications', { cookie: login.cookie! })
    expect(blocked.status).toBe(403)
    expect(blocked.body.error.code).toBe('password_change_required')
  })
})

describe('POST /api/auth/change-password', () => {
  it('rejects a wrong current password', async () => {
    const email = await makeUser('Start1234', false)
    const login = await api('/api/auth/login', { method: 'POST', body: { email, password: 'Start1234' } })
    const r = await api('/api/auth/change-password', {
      method: 'POST', cookie: login.cookie!, body: { current_password: 'nope', new_password: 'Better1234' },
    })
    expect(r.status).toBe(400)
    expect(r.body.error.message).toBe('Your current password is incorrect.')
  })

  it('rejects a weak or unchanged new password', async () => {
    const email = await makeUser('Start1234', false)
    const login = await api('/api/auth/login', { method: 'POST', body: { email, password: 'Start1234' } })
    const weak = await api('/api/auth/change-password', {
      method: 'POST', cookie: login.cookie!, body: { current_password: 'Start1234', new_password: 'short' },
    })
    expect(weak.status).toBe(400)
    const same = await api('/api/auth/change-password', {
      method: 'POST', cookie: login.cookie!, body: { current_password: 'Start1234', new_password: 'Start1234' },
    })
    expect(same.status).toBe(400)
  })

  it('changes the password, clears the flag, re-issues this cookie and ends older sessions', async () => {
    const email = await makeUser('Temp1234', true)
    const first = await api('/api/auth/login', { method: 'POST', body: { email, password: 'Temp1234' } })
    const second = await api('/api/auth/login', { method: 'POST', body: { email, password: 'Temp1234' } })

    const r = await api('/api/auth/change-password', {
      method: 'POST', cookie: first.cookie!, body: { current_password: 'Temp1234', new_password: 'Mine12345' },
    })
    expect(r.status).toBe(200)
    expect(r.body.data.must_change_password).toBe(false)
    expect(r.cookie).toBeTruthy()

    expect((await api('/api/notifications', { cookie: r.cookie! })).status).toBe(200)
    expect((await api('/api/auth/me', { cookie: second.cookie! })).status).toBe(401)
    const relogin = await api('/api/auth/login', { method: 'POST', body: { email, password: 'Mine12345' } })
    expect(relogin.status).toBe(200)
  })
})

describe('GET /api/auth/session', () => {
  it('answers 200 with null when signed out, so the sign-in page logs no error', async () => {
    const r = await api('/api/auth/session')
    expect(r.status).toBe(200)
    expect(r.body.data).toBeNull()
    expect((await api('/api/auth/session', { cookie: 'ao_access=garbage' })).body.data).toBeNull()
  })

  it('answers with the session when signed in', async () => {
    const email = await makeUser('Start1234', false)
    const login = await api('/api/auth/login', { method: 'POST', body: { email, password: 'Start1234' } })
    const r = await api('/api/auth/session', { cookie: login.cookie! })
    expect(r.status).toBe(200)
    expect(r.body.data.user.email).toBe(email)
  })
})
