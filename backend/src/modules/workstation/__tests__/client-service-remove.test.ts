import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { startHarness, type Harness, type Staff } from './ws-harness.js'

/** DELETE /api/services/:id — remove a service from a client. */
let h: Harness
let md: Staff
let gstFilingId = ''
let otherId = ''
const GSTIN = '27AAPFU0939F1ZV'

beforeAll(async () => {
  h = await startHarness()
  md = await h.staff('md')
  gstFilingId = (await prisma.service.findFirst({ where: { code: 'GST_FILING' } }))?.id
    ?? (await prisma.service.create({ data: { organisationId: h.orgId, code: 'GST_FILING', name: 'GST Filing' } })).id
  await prisma.service.update({ where: { id: gstFilingId }, data: { deletedAt: null, isActive: true } })
  if (!await prisma.documentCategory.findFirst({ where: { code: 'gst' } })) {
    await prisma.documentCategory.create({ data: { organisationId: h.orgId, code: 'gst', name: 'GST' } })
  }
  otherId = (await prisma.service.create({ data: { organisationId: h.orgId, name: uid('Svc R'), code: uid('SVCR') } })).id
})
afterAll(() => h?.close())

describe('DELETE /api/services/:id', () => {
  it('soft-deletes the service, logs it, and drops it from the client list', async () => {
    const c = await h.client(md.emp.id, { status: 'active' })
    const s = await prisma.clientService.create({ data: { clientId: c.id, serviceId: otherId } })
    const r = await h.api(`/api/services/${s.id}`, md.cookie, { method: 'DELETE' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((await prisma.clientService.findUniqueOrThrow({ where: { id: s.id } })).deletedAt).not.toBeNull()
    const list = await h.api(`/api/clients/${c.id}/services`, md.cookie)
    expect(list.body.items.map((i: { id: string }) => i.id)).not.toContain(s.id)
    expect(await prisma.activity.count({ where: { subjectId: c.id, action: 'service.removed' } })).toBe(1)
    // Gone: a second delete is a 404.
    expect((await h.api(`/api/services/${s.id}`, md.cookie, { method: 'DELETE' })).status).toBe(404)
  })

  it('refuses while an open task hangs off it, allows once the task is completed', async () => {
    const c = await h.client(md.emp.id, { status: 'active' })
    const s = await prisma.clientService.create({ data: { clientId: c.id, serviceId: otherId } })
    const t = await prisma.task.create({
      data: { title: 'Work', clientId: c.id, clientServiceId: s.id, assignedEmployeeId: md.emp.id, status: 'in_progress' },
    })
    const r = await h.api(`/api/services/${s.id}`, md.cookie, { method: 'DELETE' })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.body)).toMatch(/1 open task/)
    expect((await prisma.clientService.findUniqueOrThrow({ where: { id: s.id } })).deletedAt).toBeNull()

    await prisma.task.update({ where: { id: t.id }, data: { status: 'completed' } })
    expect((await h.api(`/api/services/${s.id}`, md.cookie, { method: 'DELETE' })).status).toBe(200)
    await prisma.task.delete({ where: { id: t.id } })
  })

  it('removing GST Filing deactivates the GST profile', async () => {
    const c = await h.client(md.emp.id, { status: 'onboarding', gstin: GSTIN })
    const add = await h.api(`/api/clients/${c.id}/services`, md.cookie, { method: 'POST', body: { service_ids: [gstFilingId] } })
    expect(add.status, JSON.stringify(add.body)).toBe(201)
    expect((await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })).active).toBe(true)
    const r = await h.api(`/api/services/${add.body.items[0].id}`, md.cookie, { method: 'DELETE' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })).active).toBe(false)
  })

  it('needs workstation.service.manage', async () => {
    const intern = await h.staff('intern')
    const c = await h.client(md.emp.id, { status: 'active' })
    const s = await prisma.clientService.create({ data: { clientId: c.id, serviceId: otherId } })
    expect((await h.api(`/api/services/${s.id}`, intern.cookie, { method: 'DELETE' })).status).toBe(403)
  })
})
