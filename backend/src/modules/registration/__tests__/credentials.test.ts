import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'

/**
 * Registration details with a second secret (ESI: Employer login + Insured
 * Person login). The secret is never in a read, revealed only on request,
 * kept when the field is left blank, absent from the audit log, wiped on delete.
 */
let server: Server
let base = ''
let cookie = ''
let clientId = ''

async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, { method: opts.method ?? 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, text }
}

beforeAll(async () => {
  process.env.PORTAL_ACCESS_ENC_KEY ??= randomBytes(32).toString('base64')
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const a = server.address()
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
  const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
  for (const g of MATRIX.md) await prisma.permission.upsert({ where: { code: g.permission }, update: {}, create: { id: `perm-${g.permission}`, code: g.permission, description: g.permission } })
  const role = await prisma.role.upsert({ where: { code: 'md' }, update: {}, create: { id: 'role-md', code: 'md', name: 'md' } })
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
  for (const g of MATRIX.md) await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: `perm-${g.permission}`, scope: g.scope } }).catch(() => undefined)
  const u = await prisma.user.create({ data: { id: uid('u'), organisationId: org.id, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: role.id } })
  cookie = `ao_access=${signToken(u.id)}`
  clientId = (await prisma.client.create({ data: { id: uid('cli'), organisationId: org.id, clientCode: uid('C'), companyName: 'ESI Client', contactPerson: 'C', contactNumber: '9840011111', accountManagerId: uid('emp'), onboardingDate: '2026-01-01' } })).id
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('registration details — a second secret (ESI)', () => {
  it('stores the Insured Person password encrypted, reveals it only on request, keeps it when left blank, wipes it on delete', async () => {
    const url = `/api/registration-credentials/esi/${clientId}`
    const save = await api(url, { method: 'PUT', body: { mode: 'existing', fields: { username: 'LIN12345', ip_user_id: 'IP-0001', ip_password: 'ip-Secret-9' }, password: 'employer-Pass-1' } })
    expect(save.status).toBe(201)
    expect(save.text).not.toContain('ip-Secret-9')
    expect(save.body.data.record).toMatchObject({ fields: { username: 'LIN12345', ip_user_id: 'IP-0001' }, password_present: true, secrets_present: { ip_password: true } })

    const read = await api(url)
    expect(read.text).not.toContain('ip-Secret-9')
    expect(read.text).not.toContain('employer-Pass-1')

    expect((await api(`${url}/reveal`, { method: 'POST', body: { action: 'show', field: 'ip_password' } })).body.data.value).toBe('ip-Secret-9')
    expect((await api(`${url}/reveal`, { method: 'POST', body: { action: 'show' } })).body.data.value).toBe('employer-Pass-1')
    expect((await api(`${url}/reveal`, { method: 'POST', body: { action: 'show', field: 'username' } })).status).toBe(400) // only secret fields

    // Edit other fields, leave the secret blank: it is kept.
    await api(url, { method: 'PUT', body: { mode: 'existing', fields: { username: 'LIN99999', ip_user_id: 'IP-0001', ip_password: '' } } })
    expect((await api(`${url}/reveal`, { method: 'POST', body: { action: 'show', field: 'ip_password' } })).body.data.value).toBe('ip-Secret-9')

    // Never in the audit log.
    const audit = await prisma.auditLog.findMany({ where: { entityType: 'registration_credential' } })
    expect(JSON.stringify(audit)).not.toContain('ip-Secret-9')
    const row = await prisma.registrationCredential.findFirstOrThrow({ where: { clientId, typeCode: 'esi' } })
    expect(row.fieldsJson).not.toContain('ip-Secret-9') // encrypted at rest

    expect((await api(url, { method: 'DELETE' })).status).toBe(200)
    const gone = await prisma.registrationCredential.findFirstOrThrow({ where: { clientId, typeCode: 'esi' } })
    expect(gone.fieldsJson).not.toContain('enc:')
  })

  it('first-time ESI registration needs the employer sign-up details', async () => {
    const r = await api(`/api/registration-credentials/esi/${clientId}`, { method: 'PUT', body: { mode: 'new', fields: { company_name: 'X' } } })
    expect(r.status).toBe(400)
    expect(Object.keys(r.body.error.details).sort()).toEqual(['fields.principal_employer_name', 'fields.region', 'fields.signup_email', 'fields.state'])
  })

  it('Partnership Firm (TNREGINET): login is username + password; the password must meet the portal rules', async () => {
    const url = `/api/registration-credentials/partnership-firm/${clientId}`
    const weak = await api(url, { method: 'PUT', body: { mode: 'existing', fields: { username: 'firmuser' }, password: 'short1$' } })
    expect(weak.status).toBe(400)
    expect(weak.body.error.details.password).toMatch(/10–16/)
    for (const bad of ['NoNumber$abcd', 'nospecial12345', 'abc12345$#xyz', ' lead12345$ab', 'UPPER12345$AB']) {
      expect((await api(url, { method: 'PUT', body: { mode: 'existing', fields: { username: 'firmuser' }, password: bad } })).status).toBe(400)
    }
    const ok = await api(url, { method: 'PUT', body: { mode: 'existing', fields: { username: 'firmuser' }, password: 'firm pass@2026' } })
    expect(ok.status).toBe(201)

    const first = await api(url, { method: 'PUT', body: { mode: 'new', fields: { username: 'firmuser' }, password: 'firm pass@2026' } })
    expect(first.status).toBe(400)
    expect(Object.keys(first.body.error.details)).toEqual(expect.arrayContaining(['fields.security_answer', 'fields.identification_no', 'fields.dob', 'fields.district', 'fields.village_town']))
  })
})
