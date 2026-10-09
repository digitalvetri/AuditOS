import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { env } from '../../lib/env.js'
import { signToken } from '../../platform/auth.js'
import {
  revokeSharedLinks, signPermanentResource, signResource, verifyLinkToken, verifyResourceToken,
} from '../../platform/signedUrl.js'
import { clientDocContentMatches } from '../workstation/client-folders.routes.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { MATRIX } from '../../platform/rbac/matrix.js'

/**
 * Revocable shared links (permanent tokens) and content-sniffed client-folder
 * uploads.
 */

let server: Server
let base = ''
let orgId = ''
let mdId = ''
let mdCookie = ''

async function seedRole(code: keyof typeof MATRIX) {
  for (const g of MATRIX[code]) {
    await prisma.permission.upsert({ where: { code: g.permission }, update: {}, create: { id: `perm-${g.permission}`, code: g.permission, description: g.permission } })
  }
  const role = await prisma.role.upsert({ where: { code }, update: {}, create: { id: `role-${code}`, code, name: code } })
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
  for (const g of MATRIX[code]) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: `perm-${g.permission}`, scope: g.scope } }).catch(() => undefined)
  }
  return role
}

async function makeUser(roleId: string) {
  return prisma.user.create({ data: { id: uid('u'), organisationId: orgId, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId } })
}

beforeAll(async () => {
  const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
  orgId = org.id
  const md = await makeUser((await seedRole('md')).id)
  mdId = md.id
  mdCookie = `ao_access=${signToken(md.id)}`
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

/** A permanent token in the pre-iat format: `exp.sub.hmac`, 100-year expiry. */
function legacyPermanentToken(resource: string, sub: string, issuedAtSec: number) {
  const exp = issuedAtSec + 100 * 365 * 24 * 60 * 60
  const sig = crypto.createHmac('sha256', env.permanentLinkSecret).update(`${resource}.${sub}.${exp}`).digest('hex')
  return `${exp}.${sub}.${sig}`
}

describe('revocable shared links', () => {
  it('new permanent links expire after PERMANENT_LINK_TTL_DAYS (365 by default)', () => {
    const { token, expiresAt } = signPermanentResource(`quotation:${uid('q')}`, mdId)
    expect(token.split('.')).toHaveLength(4)
    const days = (expiresAt.getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(364)
    expect(days).toBeLessThanOrEqual(365)
  })

  it('revocation kills links issued before it; links issued after still work', async () => {
    const resource = `quotation:${uid('q')}`
    const before = signPermanentResource(resource, mdId, Date.now() - 1000).token
    expect(await verifyLinkToken(resource, before)).toEqual({ subject: mdId, permanent: true })
    await revokeSharedLinks(resource, mdId)
    await expect(verifyLinkToken(resource, before)).rejects.toMatchObject({ code: 'link_revoked' })
    const after = signPermanentResource(resource, mdId, Date.now() + 5).token
    expect((await verifyLinkToken(resource, after)).permanent).toBe(true)
    // Another resource is unaffected.
    const other = `quotation:${uid('q')}`
    expect((await verifyLinkToken(other, signPermanentResource(other, mdId).token)).subject).toBe(mdId)
  })

  it('old 3-part permanent tokens still verify, and are revocable', async () => {
    const resource = `invoice:${uid('i')}`
    const legacy = legacyPermanentToken(resource, mdId, Math.floor(Date.now() / 1000) - 3600)
    expect(await verifyLinkToken(resource, legacy)).toEqual({ subject: mdId, permanent: true })
    await revokeSharedLinks(resource, mdId)
    await expect(verifyLinkToken(resource, legacy)).rejects.toMatchObject({ code: 'link_revoked' })
  })

  it('a link shared by a user who is now inactive stops working', async () => {
    const u = await makeUser((await seedRole('employee')).id)
    const resource = `engagement:${uid('e')}`
    const token = signPermanentResource(resource, u.id).token
    expect((await verifyLinkToken(resource, token)).subject).toBe(u.id)
    await prisma.user.update({ where: { id: u.id }, data: { isActive: false } })
    await expect(verifyLinkToken(resource, token)).rejects.toMatchObject({ code: 'link_revoked' })
  })

  it('a tampered issue time is rejected; the sync verifier never accepts a shared link', async () => {
    const resource = `quotation:${uid('q')}`
    const token = signPermanentResource(resource, mdId).token
    const [exp, sub, sig, iat] = token.split('.')
    await expect(verifyLinkToken(resource, `${exp}.${sub}.${sig}.${Number(iat) + 60_000}`)).rejects.toMatchObject({ code: 'invalid_token' })
    expect(() => verifyResourceToken(resource, token)).toThrow()
    // Short-lived tokens still pass both.
    const short = signResource(resource, mdId).token
    expect(verifyResourceToken(resource, short)).toBe(mdId)
    expect((await verifyLinkToken(resource, short)).permanent).toBe(false)
  })

  it('the public PDF route refuses a revoked link and logs an accepted one', async () => {
    const id = uid('q')
    const resource = `quotation:${id}`
    const token = signPermanentResource(resource, mdId, Date.now() - 1000).token
    const ok = await fetch(`${base}/api/quotations/${id}/pdf?t=${encodeURIComponent(token)}`)
    expect(ok.status).toBe(404) // no such quotation — but the link itself was accepted
    const row = await prisma.auditLog.findFirst({ where: { action: 'document.download', entityId: id } })
    expect(row).toMatchObject({ actorUserId: mdId, entityType: 'Quotation' })
    expect(row?.afterJson).not.toContain(token)

    await revokeSharedLinks(resource, mdId)
    const revoked = await fetch(`${base}/api/quotations/${id}/pdf?t=${encodeURIComponent(token)}`)
    expect(revoked.status).toBe(403)
    expect(((await revoked.json()) as any).error.code).toBe('link_revoked')
  })

  it('POST /api/share/revoke needs the document read permission', async () => {
    const r = await fetch(`${base}/api/share/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: mdCookie },
      body: JSON.stringify({ kind: 'quotation', id: uid('missing') }),
    })
    expect(r.status).toBe(404) // the read check runs first: no such quotation
    const emp = await makeUser((await seedRole('intern')).id)
    const denied = await fetch(`${base}/api/share/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `ao_access=${signToken(emp.id)}` },
      body: JSON.stringify({ kind: 'quotation', id: uid('q') }),
    })
    expect(denied.status).toBe(403)
  })
})

describe('client-folder uploads are content-sniffed', () => {
  const pdf = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF')
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const html = Buffer.from('<html><script>alert(1)</script></html>')

  it('matches bytes to the claimed extension', () => {
    expect(clientDocContentMatches(pdf, 'pdf')).toBe(true)
    expect(clientDocContentMatches(png, 'png')).toBe(true)
    expect(clientDocContentMatches(png, 'jpg')).toBe(false)
    expect(clientDocContentMatches(html, 'pdf')).toBe(false)
    expect(clientDocContentMatches(Buffer.from('{"a":1}'), 'json')).toBe(true)
    expect(clientDocContentMatches(Buffer.from([0x7b, 0x00, 0x7d]), 'json')).toBe(false)
    expect(clientDocContentMatches(Buffer.from('a,b\n1,2'), 'csv')).toBe(true)
  })

  it('rejects a mismatched upload with 422 and accepts a real one', async () => {
    const client = await prisma.client.create({
      data: { id: uid('cli'), organisationId: orgId, clientCode: uid('CLI'), companyName: 'Sniff Co', contactPerson: 'C', contactNumber: '9840011111', accountManagerId: uid('emp'), onboardingDate: '2026-01-01' },
    })
    const send = (bytes: Buffer, name: string) => {
      const form = new FormData()
      form.append('file', new Blob([bytes]), name)
      return fetch(`${base}/api/clients/${client.id}/document-folders/invoices/upload`, { method: 'POST', headers: { Cookie: mdCookie }, body: form })
    }
    const bad = await send(html, 'invoice.pdf')
    expect(bad.status).toBe(422)
    expect(((await bad.json()) as any).error.code).toBe('file_content')
    const good = await send(pdf, 'invoice.pdf')
    expect(good.status).toBeLessThan(300)
  })
})
