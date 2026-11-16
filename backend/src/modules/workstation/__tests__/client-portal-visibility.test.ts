import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.CLIENT_DOC_STORAGE_ROOT = `${process.env.TMPDIR ?? '/tmp'}/auditos-test-portal-visibility-${process.pid}`
})

import crypto from 'node:crypto'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { clientDocumentStorage } from '../client-folders.routes.js'
import { startHarness, type Harness, type Staff } from './ws-harness.js'

/**
 * What the client's portal link shows:
 *  - only documents shared with the client: ones asked of them (requests,
 *    and what they sent back) by default, plus any staff explicitly share;
 *    a staff upload is internal until shared;
 *  - no simulated (locally generated) e-way bills or e-invoices;
 *  - nothing at all once the client is inactive.
 */
let h: Harness
let md: Staff
let clientId = ''
let catId = ''
let token = ''
const SIM = uid('EWB-SIM')
const REAL = uid('EWB-REAL')
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n')

async function storedDoc(name: string, extra: Record<string, unknown> = {}, uploadedBy = 'staff') {
  const doc = await prisma.clientDocument.create({ data: { clientId, categoryId: catId, name, status: 'uploaded', currentVersion: 1, ...extra } })
  const key = `${clientId}/${doc.id}/${crypto.randomUUID()}.pdf`
  await clientDocumentStorage.put(key, PDF)
  const v = await prisma.clientDocumentVersion.create({ data: { documentId: doc.id, version: 1, fileKey: key, originalName: `${name}.pdf`, mimeType: 'application/pdf', uploadedBy } })
  return { doc, v }
}

async function portal(path = '') {
  const res = await fetch(`${h.base}/api/client-portal/${token}${path}`)
  const text = await res.text()
  let j: any = null
  try { j = text ? JSON.parse(text) : null } catch { j = text }
  return { status: res.status, body: j?.data ?? j }
}
const titles = (body: any) => (body.folders as any[]).flatMap((f) => f.items.map((i: any) => i.title))

let internal: Awaited<ReturnType<typeof storedDoc>>
let requested: Awaited<ReturnType<typeof storedDoc>>
let fromPortal: Awaited<ReturnType<typeof storedDoc>>

beforeAll(async () => {
  h = await startHarness()
  md = await h.staff('md')
  clientId = (await h.client(md.emp.id)).id
  catId = (await prisma.documentCategory.create({ data: { organisationId: h.orgId, code: uid('cat'), name: 'KYC' } })).id
  token = crypto.randomBytes(32).toString('base64url')
  await prisma.clientDocumentShareLink.create({ data: { clientId, token, createdBy: 'test' } })
  internal = await storedDoc('INTERNAL review notes')
  requested = await storedDoc('Bank statement', { requestedAt: new Date() })
  fromPortal = await storedDoc('PAN card', {}, 'portal')
  const ewb = { clientId, fromGstin: '33AABCS1234F1ZY', documentNo: uid('D'), documentDate: '2026-10-01', valuePaise: 100000, validUntil: '2026-10-05', generatedByEmployeeId: md.emp.id }
  await prisma.ewayBill.create({ data: { ...ewb, ewbNo: SIM, isSimulated: true } })
  await prisma.ewayBill.create({ data: { ...ewb, documentNo: uid('D'), ewbNo: REAL, isSimulated: false } })
})
afterAll(() => h?.close())

describe('documents on the portal', () => {
  it('lists requested and client-sent documents, never a staff upload', async () => {
    const r = await portal()
    expect(r.status).toBe(200)
    expect(titles(r.body)).toEqual(expect.arrayContaining(['Bank statement', 'PAN card']))
    expect(titles(r.body)).not.toContain('INTERNAL review notes')
  })

  it('will not open or zip an unshared file by its id', async () => {
    expect((await portal(`/open?source=upload&ref=${internal.v.id}`)).status).toBe(404)
    expect((await portal(`/open?source=upload&ref=${requested.v.id}`)).status).toBe(200)
  })

  it('staff can share a document, and hide one again (audited)', async () => {
    const share = await h.api(`/api/client-documents/${internal.doc.id}`, md.cookie, { method: 'PATCH', body: { visible_to_client: true } })
    expect(share.status, JSON.stringify(share.body)).toBe(200)
    expect(share.body.visible_to_client).toBe(true)
    expect(titles((await portal()).body)).toContain('INTERNAL review notes')
    const hide = await h.api(`/api/client-documents/${fromPortal.doc.id}`, md.cookie, { method: 'PATCH', body: { visible_to_client: false } })
    expect(hide.body.visible_to_client).toBe(false)
    expect(titles((await portal()).body)).not.toContain('PAN card')
    expect(await prisma.auditLog.count({ where: { entityId: internal.doc.id, action: 'client_document.update' } })).toBeGreaterThan(0)
  })

  it('a staff upload into a folder starts hidden; the staff document list says what the client sees', async () => {
    const up = await h.upload(`/api/clients/${clientId}/document-folders/uploads:${(await prisma.documentCategory.findUniqueOrThrow({ where: { id: catId } })).code}/upload`, md.cookie, PDF, 'working-paper.pdf')
    expect(up.status, JSON.stringify(up.body)).toBe(201)
    expect(titles((await portal()).body).join('|')).not.toContain('working-paper')
    const list = await h.api(`/api/clients/${clientId}/documents`, md.cookie)
    const byName = new Map((list.body.items as any[]).map((d) => [d.name, d.visible_to_client]))
    expect(byName.get('Bank statement')).toBe(true)
    expect(byName.get('INTERNAL review notes')).toBe(true)
    expect(byName.get('PAN card')).toBe(false)
  })
})

describe('e-way bills on the portal', () => {
  it('hides simulated ones', async () => {
    const t = titles((await portal()).body)
    expect(t).toContain(REAL)
    expect(t).not.toContain(SIM)
    const sim = await prisma.ewayBill.findFirstOrThrow({ where: { ewbNo: SIM, clientId } })
    expect((await portal(`/open?source=eway&ref=${sim.id}`)).status).toBe(404)
  })
})

describe('a former client', () => {
  it('loses the portal when made inactive, and gets it back when reactivated', async () => {
    await prisma.client.update({ where: { id: clientId }, data: { status: 'inactive', exitDate: '2026-11-01' } })
    for (const p of ['', '/requests', '/status', `/open?source=upload&ref=${requested.v.id}`, '/zip']) {
      expect((await portal(p)).status, p).toBe(410)
    }
    await prisma.client.update({ where: { id: clientId }, data: { status: 'active', exitDate: null } })
    expect((await portal()).status).toBe(200)
  })
})
