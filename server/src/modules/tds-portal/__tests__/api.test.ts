import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'

/**
 * TDS portal credentials over HTTP — real app, real RBAC, real PostgreSQL.
 * The point of these tests is isolation + secrecy: client A's request can
 * never yield client B's data, and the password never leaves the server
 * except through /reveal (and never lands in the DB or the audit log).
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
  const role = await prisma.role.upsert({ where: { code }, update: {}, create: { id: `role-${code}`, code, name: code } })
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
  for (const g of grants) {
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: `perm-${g.permission}`, scope: g.scope },
    }).catch(() => undefined)
  }
  return role
}

async function user(orgId: string, roleId: string) {
  const u = await prisma.user.create({
    data: { id: uid('u'), organisationId: orgId, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId },
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
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: text }
}

async function client(orgId: string, name: string) {
  return prisma.client.create({
    data: {
      id: uid('cli'), organisationId: orgId, clientCode: uid('CLI'), companyName: name,
      contactPerson: 'Contact', contactNumber: '9840011111', accountManagerId: uid('emp'),
      onboardingDate: '2026-01-01',
    },
  })
}

beforeAll(async () => {
  // portalCrypto reads the key per call; tests get a throwaway one.
  process.env.PORTAL_ACCESS_ENC_KEY ??= randomBytes(32).toString('base64')
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('TDS portal credentials API', () => {
  it('keeps each client’s credentials isolated and the password encrypted', async () => {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const md = await user(org.id, (await seedRole('md', MATRIX.md)).id)
    const cookie = md.cookie
    const a = await client(org.id, 'ABC Private Limited')
    const b = await client(org.id, 'XYZ & Co')

    // Empty state
    expect((await api(`/api/tds-portal/${a.id}`, { cookie })).body.data.record).toBeNull()
    // Create requires a password
    expect((await api(`/api/tds-portal/${a.id}`, { method: 'PUT', cookie, body: { user_id: 'ABCD12345E' } })).status).toBe(400)

    const putA = await api(`/api/tds-portal/${a.id}`, { method: 'PUT', cookie, body: { user_id: 'ABCD12345E', password: 'PasswordA!1' } })
    expect(putA.status).toBe(200)
    expect(putA.raw).not.toContain('PasswordA!1')
    expect(putA.body.data.record).toMatchObject({ user_id: 'ABCD12345E', password_present: true })
    await api(`/api/tds-portal/${b.id}`, { method: 'PUT', cookie, body: { user_id: 'XYZP98765F', password: 'PasswordB!2' } })

    // Stored as ciphertext, not plaintext
    const rowA = await prisma.tdsPortalCredential.findUniqueOrThrow({ where: { clientId: a.id } })
    expect(rowA.passwordCiphertext).toBeTruthy()
    expect(rowA.passwordCiphertext).not.toContain('PasswordA!1')

    // GET never carries the password; each client reads only its own record
    const getA = await api(`/api/tds-portal/${a.id}`, { cookie })
    expect(getA.raw).not.toContain('PasswordA!1')
    expect(getA.body.data.record.user_id).toBe('ABCD12345E')
    expect((await api(`/api/tds-portal/${b.id}`, { cookie })).body.data.record.user_id).toBe('XYZP98765F')

    expect((await api(`/api/tds-portal/${a.id}/reveal`, { method: 'POST', cookie })).body.data.value).toBe('PasswordA!1')
    expect((await api(`/api/tds-portal/${b.id}/reveal`, { method: 'POST', cookie })).body.data.value).toBe('PasswordB!2')

    // Status lists ids + user ids only
    const status = await api('/api/tds-portal/status', { cookie })
    expect(status.raw).not.toContain('Password')
    const ids = status.body.data.items.map((i: { client_id: string }) => i.client_id)
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]))

    // Edit User ID only — password kept
    const edit = await api(`/api/tds-portal/${a.id}`, { method: 'PUT', cookie, body: { user_id: 'ABCD99999E' } })
    expect(edit.status).toBe(200)
    expect((await api(`/api/tds-portal/${a.id}/reveal`, { method: 'POST', cookie })).body.data.value).toBe('PasswordA!1')
    // Edit password
    await api(`/api/tds-portal/${a.id}`, { method: 'PUT', cookie, body: { user_id: 'ABCD99999E', password: 'NewA!3' } })
    expect((await api(`/api/tds-portal/${a.id}/reveal`, { method: 'POST', cookie })).body.data.value).toBe('NewA!3')

    // Audit rows exist and never contain a password
    const audits = await prisma.auditLog.findMany({ where: { entityType: 'tds_portal_credential', entityId: rowA.id } })
    expect(audits.map((x) => x.action)).toEqual(expect.arrayContaining([
      'tds_portal_credential.create', 'tds_portal_credential.update', 'tds_portal_credential.reveal',
    ]))
    for (const x of audits) {
      expect(`${x.beforeJson ?? ''}${x.afterJson ?? ''}`).not.toMatch(/PasswordA|NewA!3/)
    }

    // Delete removes only the credential; client B and the client A row remain
    expect((await api(`/api/tds-portal/${a.id}`, { method: 'DELETE', cookie })).status).toBe(200)
    expect((await api(`/api/tds-portal/${a.id}`, { cookie })).body.data.record).toBeNull()
    expect((await api(`/api/tds-portal/${a.id}/reveal`, { method: 'POST', cookie })).status).toBe(404)
    expect((await prisma.tdsPortalCredential.findUniqueOrThrow({ where: { clientId: a.id } })).passwordCiphertext).toBeNull()
    expect(await prisma.client.findUnique({ where: { id: a.id } })).not.toBeNull()
    expect((await api(`/api/tds-portal/${b.id}`, { cookie })).body.data.record.user_id).toBe('XYZP98765F')

    // Re-adding after delete revives the single row — no duplicates
    await api(`/api/tds-portal/${a.id}`, { method: 'PUT', cookie, body: { user_id: 'ABCD12345E', password: 'Again!4' } })
    expect(await prisma.tdsPortalCredential.count({ where: { clientId: a.id } })).toBe(1)
  })

  it('rejects anonymous callers, roles without the grant, and out-of-scope clients', async () => {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const md = await user(org.id, (await seedRole('md', MATRIX.md)).id)
    const c = await client(org.id, 'PQR Industries')
    await api(`/api/tds-portal/${c.id}`, { method: 'PUT', cookie: md.cookie, body: { user_id: 'PQRS11111A', password: 'Secret!5' } })

    expect((await api(`/api/tds-portal/${c.id}`)).status).toBe(401)
    expect((await api(`/api/tds-portal/${c.id}/reveal`, { method: 'POST' })).status).toBe(401)

    const hr = await user(org.id, (await seedRole('hr_admin', MATRIX.hr_admin)).id)
    expect((await api(`/api/tds-portal/${c.id}`, { cookie: hr.cookie })).status).toBe(403)
    expect((await api(`/api/tds-portal/${c.id}/reveal`, { method: 'POST', cookie: hr.cookie })).status).toBe(403)

    // View without reveal: sees the User ID, cannot decrypt
    const viewer = await user(org.id, (await seedRole('tds_viewer_test', [{ permission: 'workstation.tds.portal.view', scope: 'organisation' }])).id)
    expect((await api(`/api/tds-portal/${c.id}`, { cookie: viewer.cookie })).status).toBe(200)
    expect((await api(`/api/tds-portal/${c.id}/reveal`, { method: 'POST', cookie: viewer.cookie })).status).toBe(403)

    // Self scope, not assigned to this client → 404 on every verb; status is empty
    const self = await user(org.id, (await seedRole('tds_self_test', [
      { permission: 'workstation.tds.portal.view', scope: 'self' },
      { permission: 'workstation.tds.portal.reveal', scope: 'self' },
    ])).id)
    expect((await api(`/api/tds-portal/${c.id}`, { cookie: self.cookie })).status).toBe(404)
    expect((await api(`/api/tds-portal/${c.id}/reveal`, { method: 'POST', cookie: self.cookie })).status).toBe(404)
    expect((await api(`/api/tds-portal/${c.id}`, { method: 'PUT', cookie: self.cookie, body: { user_id: 'X', password: 'y' } })).status).toBe(404)
    expect((await api(`/api/tds-portal/${c.id}`, { method: 'DELETE', cookie: self.cookie })).status).toBe(404)
    expect((await api('/api/tds-portal/status', { cookie: self.cookie })).body.data.items).toEqual([])
  })
})
