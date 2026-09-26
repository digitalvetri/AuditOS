import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'

/** TDS service records over HTTP — real app, real RBAC, real PostgreSQL. */
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
  // Uploads go to a throwaway folder, not the dev uploads/ tree.
  process.env.TDS_STORAGE_ROOT = mkdtempSync(path.join(tmpdir(), 'auditos-test-tds-'))
  // portalCrypto reads the key per call; tests get a throwaway one.
  process.env.PORTAL_ACCESS_ENC_KEY ??= randomBytes(32).toString('base64')
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => { server.close(); await prisma.$disconnect() })


describe('TDS service API', () => {
  it('records the full TDS cycle for one client without leaking into another', async () => {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const cookie = (await user(org.id, (await seedRole('md', MATRIX.md)).id)).cookie
    const a = await client(org.id, 'ABC Private Limited')
    const b = await client(org.id, 'XYZ & Co')
    const post = (id: string, body: unknown) => api(`/api/tds/${id}/records`, { method: 'POST', cookie, body })

    // Empty client: default profile, no TAN, no records
    const empty = await api(`/api/tds/${a.id}?fy=2026-27`, { cookie })
    expect(empty.status).toBe(200)
    expect(empty.body.data).toMatchObject({ client: { tan: null }, profile: { return_forms: ['26Q'] }, records: [], any_filed_return: false })

    // Registration: validation, then TAN lands on the client record
    expect((await post(a.id, { kind: 'registration', reference: '123', event_date: '2026-04-02' })).status).toBe(400)
    expect((await post(a.id, { kind: 'registration', reference: '12345678901234', event_date: '2026-04-02', tan: 'bad' })).status).toBe(400)
    const reg = await post(a.id, { kind: 'registration', reference: '12345678901234', event_date: '2026-04-02', tan: 'CHEA12345B' })
    expect(reg.status).toBe(201)
    expect((await prisma.client.findUniqueOrThrow({ where: { id: a.id } })).tan).toBe('CHEA12345B')

    // Profile
    const prof = await api(`/api/tds/${a.id}/profile`, { method: 'PUT', cookie, body: { return_forms: ['26Q', '24Q'], deductor_type: 'company', responsible_person: 'R. Kumar' } })
    expect(prof.body.data.profile).toMatchObject({ return_forms: ['24Q', '26Q'], deductor_type: 'company', responsible_person: 'R. Kumar', rp_pan: null })
    const f49 = await api(`/api/tds/${a.id}/profile`, { method: 'PUT', cookie, body: { rp_pan: 'abcde1234f', rp_mobile: '9840011111', addr_pin: '600001', ao_code: 'CHE W 51 1' } })
    expect(f49.body.data.profile).toMatchObject({ rp_pan: 'ABCDE1234F', rp_mobile: '9840011111', addr_pin: '600001', ao_code: 'CHE W 51 1', responsible_person: 'R. Kumar' })
    expect((await api(`/api/tds/${a.id}/profile`, { method: 'PUT', cookie, body: { rp_mobile: '123', addr_pin: 'x' } })).status).toBe(400)
    expect((await api(`/api/tds/${a.id}/profile`, { method: 'PUT', cookie, body: { return_forms: ['99Q'] } })).status).toBe(400)

    // Challan: evidence gate, then one per month
    expect((await post(a.id, { kind: 'challan', fy: '2026-27', period: '2026-04', event_date: '2026-05-05' })).status).toBe(400)
    const ch = { kind: 'challan', fy: '2026-27', period: '2026-04', bsr_code: '0510308', reference: '12345', event_date: '2026-05-05', amount_tax: 15000 }
    expect((await post(a.id, ch)).status).toBe(201)
    expect((await post(a.id, ch)).status).toBe(409)

    // Return + correction
    const ret = await post(a.id, { kind: 'return', fy: '2026-27', period: 'Q1', form_type: '26Q', reference: '123456789012345', event_date: '2026-07-20' })
    expect(ret.status).toBe(201)
    expect((await post(a.id, { kind: 'correction', fy: '2026-27', period: 'Q1', form_type: '26Q', original_id: 'nope', reference: '223456789012345', event_date: '2026-08-01' })).status).toBe(400)
    const corr = await post(a.id, { kind: 'correction', original_id: ret.body.data.record.id, reference: '223456789012345', event_date: '2026-08-01', status: 'in_progress' })
    expect(corr.status).toBe(201)
    expect(corr.body.data.record).toMatchObject({ fy: '2026-27', period: 'Q1', form_type: '26Q' })
    // A return with corrections can't be deleted
    expect((await api(`/api/tds/${a.id}/records/${ret.body.data.record.id}`, { method: 'DELETE', cookie })).status).toBe(409)

    // Certificate + notices
    expect((await post(a.id, { kind: 'certificate', fy: '2026-27', period: 'Q1', form_type: '16A', event_date: '2026-08-10' })).status).toBe(201)
    expect((await post(a.id, { kind: 'notice_check', event_date: '2026-09-20' })).status).toBe(201)
    const notice = await post(a.id, { kind: 'notice', status: 'pending', reference: 'Short payment Q1', amount_tax: 1200 })
    expect(notice.status).toBe(201)
    const closed = await api(`/api/tds/${a.id}/records/${notice.body.data.record.id}`, { method: 'PATCH', cookie, body: { status: 'done' } })
    expect(closed.body.data.record.status).toBe('done')

    const full = await api(`/api/tds/${a.id}?fy=2026-27`, { cookie })
    expect(full.body.data.any_filed_return).toBe(true)
    expect(full.body.data.records.map((r: { kind: string }) => r.kind).sort())
      .toEqual(['certificate', 'challan', 'correction', 'notice', 'notice_check', 'registration', 'return'])
    // Another FY hides FY-bound rows but keeps registration + notices
    const other = await api(`/api/tds/${a.id}?fy=2025-26`, { cookie })
    expect(other.body.data.records.map((r: { kind: string }) => r.kind).sort()).toEqual(['notice', 'notice_check', 'registration'])

    // Client B sees none of it, and can't touch A's records through its own URL
    const bData = await api(`/api/tds/${b.id}?fy=2026-27`, { cookie })
    expect(bData.body.data.records).toEqual([])
    expect(bData.body.data.client.tan).toBeNull()
    expect((await api(`/api/tds/${b.id}/records/${notice.body.data.record.id}`, { method: 'PATCH', cookie, body: { status: 'pending' } })).status).toBe(404)
    expect((await api(`/api/tds/${b.id}/records/${notice.body.data.record.id}`, { method: 'DELETE', cookie })).status).toBe(404)

    // Audit trail
    const actions = (await prisma.auditLog.findMany({ where: { entityType: 'tds_filing' } })).map((x) => x.action)
    expect(actions).toEqual(expect.arrayContaining(['tds_registration.create', 'tds_challan.create', 'tds_return.create', 'tds_notice.update']))
  })

  it('enforces permissions and client scope', async () => {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const c = await client(org.id, 'PQR Industries')
    expect((await api(`/api/tds/${c.id}`)).status).toBe(401)
    const hr = await user(org.id, (await seedRole('hr_admin', MATRIX.hr_admin)).id)
    expect((await api(`/api/tds/${c.id}`, { cookie: hr.cookie })).status).toBe(403)
    const reader = await user(org.id, (await seedRole('tds_reader_test', [{ permission: 'workstation.service.read', scope: 'organisation' }])).id)
    expect((await api(`/api/tds/${c.id}`, { cookie: reader.cookie })).status).toBe(200)
    expect((await api(`/api/tds/${c.id}/records`, { method: 'POST', cookie: reader.cookie, body: { kind: 'notice_check', event_date: '2026-09-01' } })).status).toBe(403)
    const self = await user(org.id, (await seedRole('tds_self_test2', [{ permission: 'workstation.service.manage', scope: 'self' }])).id)
    expect((await api(`/api/tds/${c.id}`, { cookie: self.cookie })).status).toBe(404)
    expect((await api(`/api/tds/${c.id}/records`, { method: 'POST', cookie: self.cookie, body: { kind: 'notice_check', event_date: '2026-09-01' } })).status).toBe(404)
  })

  it('keeps each TAN of a client separate', async () => {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const cookie = (await user(org.id, (await seedRole('md', MATRIX.md)).id)).cookie
    const c = await client(org.id, 'Multi Branch Ltd')
    await prisma.client.update({ where: { id: c.id }, data: { tan: 'CHEM11111A' } })
    const post = (body: unknown) => api(`/api/tds/${c.id}/records`, { method: 'POST', cookie, body })

    // Registration of a second TAN while the primary exists → becomes an additional TAN
    expect((await post({ kind: 'registration', reference: '11111111111111', event_date: '2026-04-02', tan: 'MUMB22222B' })).status).toBe(201)
    const base = await api(`/api/tds/${c.id}?fy=2026-27`, { cookie })
    expect(base.body.data.client.tans).toEqual(['CHEM11111A', 'MUMB22222B'])
    expect(base.body.data.active_tan).toBe('CHEM11111A')

    const ret = { kind: 'return', fy: '2026-27', period: 'Q1', form_type: '26Q', reference: '123456789012345', event_date: '2026-07-20' }
    expect((await post(ret)).status).toBe(201)
    // Same quarter on the branch TAN is not a duplicate
    expect((await post({ ...ret, for_tan: 'MUMB22222B' })).status).toBe(201)
    expect((await post({ ...ret, for_tan: 'MUMB22222B' })).status).toBe(409)
    expect((await post({ ...ret, for_tan: 'ZZZZ99999Z' })).status).toBe(400)

    const branch = await api(`/api/tds/${c.id}?fy=2026-27&tan=MUMB22222B`, { cookie })
    expect(branch.body.data.active_tan).toBe('MUMB22222B')
    expect(branch.body.data.records.filter((r: { kind: string }) => r.kind === 'return')).toHaveLength(1)
    expect(branch.body.data.records.every((r: { tan: string | null }) => r.tan === 'MUMB22222B')).toBe(true)
    const primary = await api(`/api/tds/${c.id}?fy=2026-27`, { cookie })
    expect(primary.body.data.records.every((r: { tan: string | null }) => r.tan === null)).toBe(true)

    // Can't drop a TAN that still has records
    expect((await api(`/api/tds/${c.id}/profile`, { method: 'PUT', cookie, body: { additional_tans: [] } })).status).toBe(400)
  })

  it('attaches files to a record and serves them only through that client', async () => {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const cookie = (await user(org.id, (await seedRole('md', MATRIX.md)).id)).cookie
    const a = await client(org.id, 'File Co')
    const b = await client(org.id, 'Other Co')
    await prisma.client.update({ where: { id: a.id }, data: { tan: 'CHEF11111A' } })
    const rec = await api(`/api/tds/${a.id}/records`, { method: 'POST', cookie, body: { kind: 'notice', status: 'pending', reference: 'N1' } })
    const id = rec.body.data.record.id

    const upload = async (name: string, content: string) => {
      const fd = new FormData()
      fd.append('file', new Blob([content], { type: 'application/pdf' }), name)
      const r = await fetch(`${base}/api/tds/${a.id}/records/${id}/file`, { method: 'POST', headers: { Cookie: cookie }, body: fd })
      return { status: r.status, body: (await r.json()) as { data: { document: { version: number } } } }
    }
    expect((await upload('bad.exe', 'x')).status).toBe(422)
    const up1 = await upload('receipt.pdf', '%PDF-first')
    expect(up1.status).toBe(201)
    const up2 = await upload('receipt-v2.pdf', '%PDF-second')
    expect(up2.body.data.document.version).toBe(2)

    const dl = await fetch(`${base}/api/tds/${a.id}/records/${id}/file`, { headers: { Cookie: cookie } })
    expect(dl.status).toBe(200)
    expect(await dl.text()).toBe('%PDF-second')
    // Listed on the record, and in the client's document store under category 'tds'
    const got = await api(`/api/tds/${a.id}?fy=2026-27`, { cookie })
    expect(got.body.data.records.find((r: { id: string }) => r.id === id).document).toMatchObject({ version: 2, original_name: 'receipt-v2.pdf' })
    const doc = await prisma.clientDocument.findFirstOrThrow({ where: { clientId: a.id }, include: { category: true } })
    expect(doc.category.code).toBe('tds')

    // Through another client's URL: not found
    expect((await fetch(`${base}/api/tds/${b.id}/records/${id}/file`, { headers: { Cookie: cookie } })).status).toBe(404)
    expect((await fetch(`${base}/api/tds/${a.id}/records/${id}/file`)).status).toBe(401)
  })
})
