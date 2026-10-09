import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { hashPassword, lockDurationMs, signToken } from '../../platform/auth.js'
import { verifyAuditChain, writeAudit } from '../../platform/audit.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { MATRIX, type PermissionCode } from '../../platform/rbac/matrix.js'

/**
 * Security hardening: real client IP behind proxies, per-account lockout,
 * server-side logout, Super Admin audit visibility, the tamper-evident audit
 * chain, and audit-reader scoping.
 */

let server: Server
let base = ''
let orgId = ''
let ipSeq = 10

/** A distinct public client IP per call, so the 20/min per-IP login bucket never interferes. */
const nextIp = () => `198.51.100.${ipSeq++}`

async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown; xff?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': opts.xff ?? nextIp(),
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  const setCookie = res.headers.get('set-cookie')
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body, text, cookie: setCookie ? setCookie.split(';')[0] : null, headers: res.headers }
}

async function seedRole(code: keyof typeof MATRIX, extra: { permission: PermissionCode; scope: string }[] = [], asCode?: string) {
  const grants = [...MATRIX[code], ...extra]
  for (const g of grants) {
    await prisma.permission.upsert({ where: { code: g.permission }, update: {}, create: { id: `perm-${g.permission}`, code: g.permission, description: g.permission } })
  }
  const roleCode = asCode ?? code
  const role = await prisma.role.upsert({ where: { code: roleCode }, update: {}, create: { id: `role-${roleCode}`, code: roleCode, name: roleCode } })
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
  for (const g of grants) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: `perm-${g.permission}`, scope: g.scope } }).catch(() => undefined)
  }
  return role
}

async function makeUser(roleId: string, password = 'Start1234') {
  const email = `${uid('e')}@x.local`
  const u = await prisma.user.create({
    data: { id: uid('u'), organisationId: orgId, email, passwordHash: hashPassword(password), roleId },
  })
  return { ...u, password, cookie: `ao_access=${signToken(u.id)}` }
}

let roles: Record<'md' | 'hr_admin' | 'finance_admin' | 'employee' | 'hr_reader', string> = {} as never

beforeAll(async () => {
  const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
  orgId = org.id
  roles = {
    md: (await seedRole('md')).id,
    hr_admin: (await seedRole('hr_admin')).id,
    finance_admin: (await seedRole('finance_admin')).id,
    employee: (await seedRole('employee')).id,
    // A non-admin role holding only the HR audit grant.
    hr_reader: (await seedRole('employee', [{ permission: 'audit.read.hr', scope: 'organisation' }], 'sec_hr_reader')).id,
  }
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('client IP behind Traefik → nginx', () => {
  it('takes the right-most public address from X-Forwarded-For', async () => {
    const email = `${uid('ghost')}@x.local`
    await api('/api/auth/login', { method: 'POST', body: { email, password: 'nope' }, xff: '203.0.113.9, 172.18.0.5' })
    const row = await prisma.auditLog.findFirst({ where: { action: 'auth.login_failed', entityId: email } })
    expect(row?.ip).toBe('203.0.113.9')
  })

  it('a spoofed left-hand entry does not override the real client', async () => {
    const email = `${uid('ghost')}@x.local`
    await api('/api/auth/login', { method: 'POST', body: { email, password: 'nope' }, xff: '1.2.3.4, 203.0.113.10, 10.0.0.7' })
    const row = await prisma.auditLog.findFirst({ where: { action: 'auth.login_failed', entityId: email } })
    expect(row?.ip).toBe('203.0.113.10')
  })
})

describe('per-account login lockout', () => {
  it('schedule: 1 min at 5 failures, doubling, capped at 30 min', () => {
    expect(lockDurationMs(4)).toBe(0)
    expect(lockDurationMs(5)).toBe(60_000)
    expect(lockDurationMs(6)).toBe(120_000)
    expect(lockDurationMs(9)).toBe(16 * 60_000)
    expect(lockDurationMs(10)).toBe(30 * 60_000)
    expect(lockDurationMs(50)).toBe(30 * 60_000)
  })

  it('locks after 5 failures — even the right password is refused — then resets on success', async () => {
    const u = await makeUser(roles.employee)
    for (let i = 0; i < 5; i++) {
      const r = await api('/api/auth/login', { method: 'POST', body: { email: u.email, password: 'wrong' } })
      expect(r.status).toBe(401)
      expect(r.body.error.message).toBe('Invalid email or password.')
    }
    const locked = await api('/api/auth/login', { method: 'POST', body: { email: u.email, password: u.password } })
    expect(locked.status).toBe(429)
    expect(locked.body.error.message).toMatch(/Too many attempts\. Try again in 1 minute/)

    // Lock expires; one more failure locks for twice as long.
    await prisma.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1000) } })
    expect((await api('/api/auth/login', { method: 'POST', body: { email: u.email, password: 'wrong' } })).status).toBe(401)
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } })
    expect(row.failedLoginCount).toBe(6)
    const ms = row.lockedUntil!.getTime() - Date.now()
    expect(ms).toBeGreaterThan(100_000)
    expect(ms).toBeLessThanOrEqual(120_000)

    await prisma.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1000) } })
    expect((await api('/api/auth/login', { method: 'POST', body: { email: u.email, password: u.password } })).status).toBe(200)
    const reset = await prisma.user.findUniqueOrThrow({ where: { id: u.id } })
    expect(reset.failedLoginCount).toBe(0)
    expect(reset.lockedUntil).toBeNull()
  })

  it('an unknown email locks on the same schedule (no account-existence tell)', async () => {
    const email = `${uid('nobody')}@x.local`
    for (let i = 0; i < 5; i++) {
      expect((await api('/api/auth/login', { method: 'POST', body: { email, password: 'x' } })).status).toBe(401)
    }
    const r = await api('/api/auth/login', { method: 'POST', body: { email, password: 'x' } })
    expect(r.status).toBe(429)
    expect(r.body.error.message).toMatch(/Too many attempts/)
  })
})

describe('logout ends the session server-side', () => {
  it('the old cookie stops working after logout', async () => {
    const u = await makeUser(roles.employee)
    const login = await api('/api/auth/login', { method: 'POST', body: { email: u.email, password: u.password } })
    expect(login.status).toBe(200)
    expect((await api('/api/auth/me', { cookie: login.cookie! })).status).toBe(200)
    expect((await api('/api/auth/logout', { method: 'POST', cookie: login.cookie! })).status).toBe(204)
    expect((await api('/api/auth/me', { cookie: login.cookie! })).status).toBe(401)
  })
})

describe('Super Admin sign-ins are recorded and visible to Admin', () => {
  it('writes md login/logout; Admin and Super Admin see them, an HR reader does not', async () => {
    const md = await makeUser(roles.md)
    const admin = await makeUser(roles.hr_admin)
    const reader = await makeUser(roles.hr_reader)
    const login = await api('/api/auth/login', { method: 'POST', body: { email: md.email, password: md.password } })
    expect(login.status).toBe(200)
    await api('/api/auth/logout', { method: 'POST', cookie: login.cookie! })
    expect(await prisma.auditLog.count({ where: { actorUserId: md.id, action: { in: ['auth.login', 'auth.logout'] } } })).toBe(2)

    const byAdmin = await api(`/api/audit-logs?actor=${md.id}`, { cookie: admin.cookie })
    expect(byAdmin.status).toBe(200)
    expect(byAdmin.body.data.items.map((r: any) => r.action).sort()).toEqual(['auth.login', 'auth.logout'])
    // Labelled, never by email.
    expect(byAdmin.body.data.items[0].actor_label).toBe('System administrator')

    const newMd = await makeUser(roles.md)
    const byMd = await api(`/api/audit-logs?actor=${md.id}`, { cookie: newMd.cookie })
    expect(byMd.body.data.items).toHaveLength(2)

    const byReader = await api(`/api/audit-logs?actor=${md.id}`, { cookie: reader.cookie })
    expect(byReader.status).toBe(200)
    expect(byReader.body.data.items).toHaveLength(0)
  })
})

describe('audit reader scoping', () => {
  it('HR readers see HR types, finance readers finance types, full readers everything', async () => {
    const tag = uid('scope')
    await writeAudit({ actorUserId: null, action: `${tag}.leave`, entityType: 'LeaveRequest', entityId: tag })
    await writeAudit({ actorUserId: null, action: `${tag}.inv`, entityType: 'Invoice', entityId: tag })
    await writeAudit({ actorUserId: null, action: `${tag}.inv2`, entityType: 'invoice', entityId: tag })
    await writeAudit({ actorUserId: null, action: `${tag}.client`, entityType: 'Client', entityId: tag })
    const actions = async (cookie: string) => {
      const r = await api(`/api/audit-logs?entity_id=${tag}`, { cookie })
      expect(r.status).toBe(200)
      return r.body.data.items.map((x: any) => x.action.replace(`${tag}.`, '')).sort()
    }
    expect(await actions((await makeUser(roles.hr_admin)).cookie)).toEqual(['leave'])
    expect(await actions((await makeUser(roles.finance_admin)).cookie)).toEqual(['inv', 'inv2'])
    expect(await actions((await makeUser(roles.md)).cookie)).toEqual(['client', 'inv', 'inv2', 'leave'])
    expect((await api(`/api/audit-logs?entity_id=${tag}`, { cookie: (await makeUser(roles.employee)).cookie })).status).toBe(403)
  })

  it('filters by date range and pages with a cursor; exports CSV', async () => {
    const md = await makeUser(roles.md)
    const tag = uid('page')
    for (let i = 0; i < 3; i++) await writeAudit({ actorUserId: null, action: `${tag}.${i}`, entityType: 'Client', entityId: tag })
    const p1 = await api(`/api/audit-logs?entity_id=${tag}&limit=2`, { cookie: md.cookie })
    expect(p1.body.data.items.map((r: any) => r.action)).toEqual([`${tag}.2`, `${tag}.1`])
    expect(p1.body.data.next_cursor).toBeTypeOf('number')
    const p2 = await api(`/api/audit-logs?entity_id=${tag}&limit=2&cursor=${p1.body.data.next_cursor}`, { cookie: md.cookie })
    expect(p2.body.data.items.map((r: any) => r.action)).toEqual([`${tag}.0`])
    expect(p2.body.data.next_cursor).toBeNull()

    const future = await api(`/api/audit-logs?entity_id=${tag}&from=2999-01-01`, { cookie: md.cookie })
    expect(future.body.data.items).toHaveLength(0)
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
    const inRange = await api(`/api/audit-logs?entity_id=${tag}&from=${today}&to=${today}`, { cookie: md.cookie })
    expect(inRange.body.data.items).toHaveLength(3)

    await writeAudit({ actorUserId: null, action: `${tag}.csv`, entityType: 'Client', entityId: tag, after: { note: '=HYPERLINK("x")' } })
    const csv = await api(`/api/audit-logs?entity_id=${tag}&format=csv`, { cookie: md.cookie })
    expect(csv.status).toBe(200)
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/)
    expect(csv.text).toContain('"seq","created_at","actor"')
    expect(csv.text.split('\r\n').filter(Boolean)).toHaveLength(5)
  })
})

describe('tamper-evident audit chain', () => {
  it('chains concurrent writes and verifies clean', async () => {
    const tag = uid('chain')
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeAudit({ actorUserId: null, action: `${tag}.${i}`, entityType: 'Client', entityId: tag })))
    const rows = await prisma.auditLog.findMany({ where: { entityId: tag }, orderBy: { seq: 'asc' } })
    expect(rows).toHaveLength(20)
    expect(rows.every((r) => r.hash && r.prevHash)).toBe(true)
    // Every prevHash is unique: nobody chained to the same predecessor twice.
    expect(new Set(rows.map((r) => r.prevHash)).size).toBe(20)
    const report = await verifyAuditChain()
    expect(report.ok).toBe(true)
    expect(report.checked).toBeGreaterThanOrEqual(20)
  })

  it('verify reports the first edited row, and is admin-only', async () => {
    const tag = uid('tamper')
    for (let i = 0; i < 3; i++) await writeAudit({ actorUserId: null, action: `${tag}.${i}`, entityType: 'Client', entityId: tag })
    const victim = await prisma.auditLog.findFirstOrThrow({ where: { action: `${tag}.1` } })
    const admin = await makeUser(roles.hr_admin)
    try {
      await prisma.auditLog.update({ where: { id: victim.id }, data: { action: 'innocent' } })
      const r = await api('/api/platform/audit-log/verify', { cookie: admin.cookie })
      expect(r.status).toBe(200)
      expect(r.body.data.ok).toBe(false)
      expect(r.body.data.first_broken).toMatchObject({ seq: victim.seq, id: victim.id, reason: 'hash_mismatch' })
    } finally {
      await prisma.auditLog.update({ where: { id: victim.id }, data: { action: victim.action } })
    }
    expect((await verifyAuditChain()).ok).toBe(true)
    expect((await api('/api/platform/audit-log/verify', { cookie: (await makeUser(roles.finance_admin)).cookie })).status).toBe(403)
  })

  it('a deleted row breaks the link to the next one', async () => {
    const tag = uid('gap')
    for (let i = 0; i < 3; i++) await writeAudit({ actorUserId: null, action: `${tag}.${i}`, entityType: 'Client', entityId: tag })
    const victim = await prisma.auditLog.findFirstOrThrow({ where: { action: `${tag}.1` } })
    const next = await prisma.auditLog.findFirstOrThrow({ where: { action: `${tag}.2` } })
    await prisma.auditLog.delete({ where: { id: victim.id } })
    try {
      const report = await verifyAuditChain()
      expect(report.ok).toBe(false)
      expect(report.first_broken).toMatchObject({ seq: next.seq, reason: 'prev_hash_mismatch' })
    } finally {
      const { id, seq, ...rest } = victim
      await prisma.auditLog.create({ data: { ...rest, id, seq } })
    }
    expect((await verifyAuditChain()).ok).toBe(true)
  })
})

describe('health', () => {
  it('answers up when the database is reachable', async () => {
    const r = await api('/api/health')
    expect(r.status).toBe(200)
    expect(r.body.data.db).toBe('up')
  })
})
