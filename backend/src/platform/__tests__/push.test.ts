import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'

/**
 * Web Push: subscriptions are per browser (unique endpoint), follow whoever
 * signs in, are fanned out by notifyUser, are pruned when the push service
 * says they are gone, and are detached on logout.
 */
const sendNotification = vi.fn()
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    generateVAPIDKeys: vi.fn(() => ({ publicKey: 'pub', privateKey: 'priv' })),
    sendNotification: (...args: unknown[]) => sendNotification(...args),
  },
}))
process.env.VAPID_PUBLIC_KEY = 'test-public-key'
process.env.VAPID_PRIVATE_KEY = 'test-private-key'

const { createApp } = await import('../../app.js')
const { signToken } = await import('../auth.js')
const { notifyUser } = await import('../notify.js')
const { prisma, uid } = await import('../../__tests__/helpers.js')

let server: Server
let base = ''

async function user() {
  const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
  const role = await prisma.role.upsert({ where: { code: 'employee' }, update: {}, create: { id: 'role-employee', code: 'employee', name: 'Employee' } })
  const u = await prisma.user.create({
    data: { id: uid('u'), organisationId: org.id, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: role.id },
  })
  return { ...u, cookie: `ao_access=${signToken(u.id)}` }
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

const flush = () => new Promise((r) => setTimeout(r, 150))
const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' } })

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => { server.close(); await prisma.$disconnect() })
beforeEach(() => { sendNotification.mockReset(); sendNotification.mockResolvedValue({ statusCode: 201 }) })

describe('web push', () => {
  it('serves the public key to a signed-in user only', async () => {
    const a = await user()
    expect((await api('/api/notifications/push/key')).status).toBe(401)
    const r = await api('/api/notifications/push/key', { cookie: a.cookie })
    expect(r.body.data.public_key).toBe('test-public-key')
  })

  it('moves a browser subscription to whoever signs in on it', async () => {
    const a = await user()
    const b = await user()
    const endpoint = `https://push.example/${uid('ep')}`
    expect((await api('/api/notifications/push/subscribe', { method: 'POST', cookie: a.cookie, body: sub(endpoint) })).status).toBe(200)
    expect((await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint } })).userId).toBe(a.id)
    await api('/api/notifications/push/subscribe', { method: 'POST', cookie: b.cookie, body: sub(endpoint) })
    expect((await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint } })).userId).toBe(b.id)
    expect(await prisma.pushSubscription.count({ where: { endpoint } })).toBe(1)
  })

  it('rejects a malformed subscription', async () => {
    const a = await user()
    const r = await api('/api/notifications/push/subscribe', { method: 'POST', cookie: a.cookie, body: { endpoint: 'not-a-url' } })
    expect(r.status).toBe(400)
  })

  it('fans a notification out to every browser of that user, and nobody else', async () => {
    const a = await user()
    const other = await user()
    const e1 = `https://push.example/${uid('ep')}`
    const e2 = `https://push.example/${uid('ep')}`
    const e3 = `https://push.example/${uid('ep')}`
    await api('/api/notifications/push/subscribe', { method: 'POST', cookie: a.cookie, body: sub(e1) })
    await api('/api/notifications/push/subscribe', { method: 'POST', cookie: a.cookie, body: sub(e2) })
    await api('/api/notifications/push/subscribe', { method: 'POST', cookie: other.cookie, body: sub(e3) })

    await notifyUser({ userId: a.id, type: 'leave.requested', module: 'leave', title: 'Leave request to review', body: 'Meera — 1 day', actionUrl: '/hrms/leave' })
    await flush()

    const endpoints = sendNotification.mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint).sort()
    expect(endpoints).toEqual([e1, e2].sort())
    const payload = JSON.parse(sendNotification.mock.calls[0][1] as string)
    expect(payload).toMatchObject({ title: 'Leave request to review', action_url: '/hrms/leave', module: 'leave' })
  })

  it('forgets a subscription the push service reports as gone, and never fails the notification', async () => {
    const a = await user()
    const endpoint = `https://push.example/${uid('ep')}`
    await api('/api/notifications/push/subscribe', { method: 'POST', cookie: a.cookie, body: sub(endpoint) })
    sendNotification.mockRejectedValue(Object.assign(new Error('Gone'), { statusCode: 410 }))

    const row = await notifyUser({ userId: a.id, type: 't', module: 'system', title: 'Hello', body: '' })
    expect(row.id).toBeTruthy()
    await flush()
    expect(await prisma.pushSubscription.count({ where: { endpoint } })).toBe(0)
  })

  it('detaches this browser on logout', async () => {
    const a = await user()
    const endpoint = `https://push.example/${uid('ep')}`
    await api('/api/notifications/push/subscribe', { method: 'POST', cookie: a.cookie, body: sub(endpoint) })
    const r = await api('/api/auth/logout', { method: 'POST', cookie: a.cookie, body: { push_endpoint: endpoint } })
    expect(r.status).toBe(204)
    expect(await prisma.pushSubscription.count({ where: { endpoint } })).toBe(0)
  })
})
