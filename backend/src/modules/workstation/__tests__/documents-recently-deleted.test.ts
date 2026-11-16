import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.CLIENT_DOC_STORAGE_ROOT = `${process.env.TMPDIR ?? '/tmp'}/auditos-test-recently-deleted-${process.pid}`
})

import { prisma, uid } from '../../../__tests__/helpers.js'
import { startHarness, type Harness, type Staff } from './ws-harness.js'

/**
 * Deleted documents go to Recently Deleted and can be restored; a move to
 * another client drops the old client's service tag and is not shared with
 * the new client until someone shares it.
 */
let h: Harness
let md: Staff
let assoc: Staff
let clientA = ''
let clientB = ''
let catId = ''

async function doc(clientId: string, extra: Record<string, unknown> = {}) {
  return prisma.clientDocument.create({ data: { clientId, categoryId: catId, name: uid('Doc'), status: 'uploaded', ...extra } })
}

beforeAll(async () => {
  h = await startHarness()
  md = await h.staff('md')
  assoc = await h.staff('employee')
  clientA = (await h.client(assoc.emp.id)).id
  clientB = (await h.client(md.emp.id)).id
  catId = (await prisma.documentCategory.create({ data: { organisationId: h.orgId, code: uid('cat'), name: 'Misc' } })).id
})
afterAll(() => h?.close())

describe('Recently Deleted', () => {
  it('lists a client\'s deleted documents and restores one', async () => {
    const d = await doc(clientA)
    expect((await h.api(`/api/client-documents/${d.id}`, md.cookie, { method: 'DELETE' })).status).toBe(200)
    const list = await h.api(`/api/client-documents/deleted?client_id=${clientA}`, md.cookie)
    expect(list.status, JSON.stringify(list.body)).toBe(200)
    expect(list.body.items.map((i: any) => i.id)).toContain(d.id)
    expect(list.body.items.find((i: any) => i.id === d.id).deleted_at).toBeTruthy()
    // Live list no longer has it.
    expect((await h.api(`/api/clients/${clientA}/documents`, md.cookie)).body.items.map((i: any) => i.id)).not.toContain(d.id)

    const r = await h.api(`/api/client-documents/${d.id}/restore`, md.cookie, { method: 'POST' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((await prisma.clientDocument.findUniqueOrThrow({ where: { id: d.id } })).deletedAt).toBeNull()
    expect(await prisma.auditLog.count({ where: { entityId: d.id, action: 'client_document.restore' } })).toBe(1)
    // Restoring a live document is a conflict.
    expect((await h.api(`/api/client-documents/${d.id}/restore`, md.cookie, { method: 'POST' })).status).toBe(409)
  })

  it('is scoped: staff not on the client see none of its deleted documents and cannot restore', async () => {
    const d = await doc(clientB, { deletedAt: new Date() })
    const list = await h.api(`/api/client-documents/deleted?client_id=${clientB}`, assoc.cookie)
    expect(list.status).toBe(403)
    const all = await h.api('/api/client-documents/deleted', assoc.cookie)
    expect(all.status).toBe(200)
    expect(all.body.items.map((i: any) => i.id)).not.toContain(d.id)
    expect((await h.api(`/api/client-documents/${d.id}/restore`, assoc.cookie, { method: 'POST' })).status).toBe(403)
  })
})

describe('moving to another client', () => {
  it('drops the service tag and hides it from the new client\'s portal until shared', async () => {
    const svc = await prisma.service.create({ data: { organisationId: h.orgId, code: uid('SVC'), name: uid('ITR') } })
    const cs = await prisma.clientService.create({ data: { clientId: clientB, serviceId: svc.id, assignedEmployeeId: md.emp.id } })
    const d = await doc(clientB, { clientServiceId: cs.id, requestedAt: new Date() })
    const r = await h.api(`/api/client-documents/${d.id}/move`, md.cookie, { method: 'POST', body: { client_id: clientA } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ client_id: clientA, client_service_id: null, visible_to_client: false })
  })

  it('a copy to another client is not shared either', async () => {
    const d = await doc(clientB, { requestedAt: new Date() })
    const r = await h.api(`/api/client-documents/${d.id}/copy`, md.cookie, { method: 'POST', body: { client_id: clientA } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const copy = await prisma.clientDocument.findUniqueOrThrow({ where: { id: r.body.id } })
    expect(copy.visibleToClient).toBe(false)
  })
})
