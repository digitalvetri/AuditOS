import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { startHarness, type Harness, type Staff } from './ws-harness.js'

/**
 * Spec B2 / B4:
 *  - POST /api/clients/:id/services takes `service_ids` (tick several at
 *    once): one row per service the client does not already have live,
 *    skipped ones named, GST Filing enrolled once, no assignee needed. The
 *    single `service_id` body still works, with or without an assignee.
 *  - GET /api/clients/:id reports `service_codes`, `gst_data_exists` and
 *    `eway_bill_count`, so the workspace can hide the GST / E-way tabs for a
 *    client that has neither the service nor any data.
 */
let h: Harness
let md: Staff
let gstFilingId = ''
let otherA = ''
let otherB = ''
const GSTIN = '27AAPFU0939F1ZV'

beforeAll(async () => {
  h = await startHarness()
  md = await h.staff('md')
  gstFilingId = (await prisma.service.findFirst({ where: { code: 'GST_FILING' } }))?.id
    ?? (await prisma.service.create({ data: { organisationId: h.orgId, code: 'GST_FILING', name: 'GST Filing' } })).id
  // Another suite may have soft-deleted it; enrolment needs it alive.
  await prisma.service.update({ where: { id: gstFilingId }, data: { deletedAt: null, isActive: true } })
  if (!await prisma.documentCategory.findFirst({ where: { code: 'gst' } })) {
    await prisma.documentCategory.create({ data: { organisationId: h.orgId, code: 'gst', name: 'GST' } })
  }
  otherA = (await prisma.service.create({ data: { organisationId: h.orgId, name: uid('Svc A'), code: uid('SVCA') } })).id
  otherB = (await prisma.service.create({ data: { organisationId: h.orgId, name: uid('Svc B'), code: uid('SVCB') } })).id
})
afterAll(() => h?.close())

const onboardingClient = () => h.client(md.emp.id, { status: 'onboarding', gstin: GSTIN })

describe('POST /api/clients/:id/services with service_ids', () => {
  it('creates one unassigned row per service, skips a live duplicate, enrols GST once', async () => {
    const c = await onboardingClient()
    // Already live: otherA. A completed otherB does not count as live.
    await prisma.clientService.create({ data: { clientId: c.id, serviceId: otherA, status: 'in_progress' } })
    await prisma.clientService.create({ data: { clientId: c.id, serviceId: otherB, status: 'completed' } })

    const r = await h.api(`/api/clients/${c.id}/services`, md.cookie, {
      method: 'POST',
      body: { service_ids: [gstFilingId, otherA, otherB, otherB], filing_frequency: 'quarterly', due_date: '2026-12-31', notes: 'Batch' },
    })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(JSON.stringify(r.body)).not.toContain('undefined')
    expect(r.body.items.map((i: { service_id: string }) => i.service_id).sort()).toEqual([gstFilingId, otherB].sort())
    for (const i of r.body.items) {
      expect(i).toMatchObject({ assigned_employee_id: null, assigned_employee: null, manager_id: null, due_date: '2026-12-31', notes: 'Batch', status: 'not_started' })
    }
    expect(r.body.skipped).toEqual([{ service_id: otherA, service_name: expect.any(String) }])

    expect(await prisma.clientService.count({ where: { clientId: c.id, serviceId: otherA, deletedAt: null } })).toBe(1)
    expect(await prisma.clientService.count({ where: { clientId: c.id, serviceId: otherB, deletedAt: null } })).toBe(2)
    // GST Filing enrolment: one profile, with the requested frequency, unassigned.
    const profiles = await prisma.gstProfile.findMany({ where: { clientId: c.id } })
    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({ filingFrequency: 'quarterly', assignedEmployeeId: null })
    // First-service activation, once.
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('active')
    expect(await prisma.activity.count({ where: { subjectId: c.id, action: 'client.status_updated' } })).toBe(1)
    const added = await prisma.activity.findMany({ where: { subjectId: c.id, action: 'client.service_assigned' } })
    expect(added).toHaveLength(2)
    for (const a of added) expect(a.description).toMatch(/ added\.$/)

    // Ticking the same services again adds nothing and re-enrols nothing.
    const again = await h.api(`/api/clients/${c.id}/services`, md.cookie, { method: 'POST', body: { service_ids: [gstFilingId, otherA] } })
    expect(again.status).toBe(200)
    expect(again.body.items).toEqual([])
    expect(again.body.skipped.map((s: { service_id: string }) => s.service_id).sort()).toEqual([gstFilingId, otherA].sort())
    expect(await prisma.gstProfile.count({ where: { clientId: c.id } })).toBe(1)
  })

  it('refuses an empty list or an unknown service, and creates nothing', async () => {
    const c = await onboardingClient()
    const empty = await h.api(`/api/clients/${c.id}/services`, md.cookie, { method: 'POST', body: { service_ids: [] } })
    expect(empty.status).toBe(400)
    expect(JSON.stringify(empty.body)).toContain('service_ids')
    const unknown = await h.api(`/api/clients/${c.id}/services`, md.cookie, { method: 'POST', body: { service_ids: [otherA, 'no-such-service'] } })
    expect(unknown.status).toBe(400)
    expect(JSON.stringify(unknown.body)).toContain('service_ids')
    expect(await prisma.clientService.count({ where: { clientId: c.id } })).toBe(0)
  })

  it('still accepts an assignee and notifies them', async () => {
    const assoc = await h.staff('employee')
    const c = await onboardingClient()
    const r = await h.api(`/api/clients/${c.id}/services`, md.cookie, {
      method: 'POST', body: { service_ids: [otherA], assigned_employee_id: assoc.emp.id },
    })
    expect(r.status).toBe(201)
    expect(r.body.items[0]).toMatchObject({ assigned_employee_id: assoc.emp.id, assigned_employee: { id: assoc.emp.id } })
    expect(await prisma.notification.count({ where: { userId: assoc.userId, entityId: r.body.items[0].id } })).toBe(1)
  })
})

describe('POST /api/clients/:id/services with the single service_id body', () => {
  it('works without an assignee and answers the row, as before', async () => {
    const c = await onboardingClient()
    const r = await h.api(`/api/clients/${c.id}/services`, md.cookie, { method: 'POST', body: { service_id: otherA } })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body).toMatchObject({ client_id: c.id, service_id: otherA, assigned_employee_id: null, assigned_employee: null })
    expect(JSON.stringify(r.body)).not.toContain('undefined')
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('active')
  })

  it('works with an assignee and a manager (older callers)', async () => {
    const c = await onboardingClient()
    const r = await h.api(`/api/clients/${c.id}/services`, md.cookie, {
      method: 'POST', body: { service_id: otherB, assigned_employee_id: md.emp.id, manager_id: md.emp.id },
    })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ assigned_employee_id: md.emp.id, manager_id: md.emp.id })
    const bad = await h.api(`/api/clients/${c.id}/services`, md.cookie, {
      method: 'POST', body: { service_id: otherB, assigned_employee_id: 'nobody' },
    })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).toContain('assigned_employee_id')
  })
})

describe('GET /api/clients/:id tab-visibility fields', () => {
  it('reports services taken and whether GST or e-way data exists', async () => {
    const get = async (id: string) => (await h.api(`/api/clients/${id}`, md.cookie)).body

    const none = await h.client(md.emp.id)
    expect(await get(none.id)).toMatchObject({ service_codes: [], gst_data_exists: false, eway_bill_count: 0 })

    const withService = await h.client(md.emp.id)
    await prisma.clientService.create({ data: { clientId: withService.id, serviceId: gstFilingId, status: 'not_started' } })
    expect(await get(withService.id)).toMatchObject({ service_codes: ['GST_FILING'], gst_data_exists: false })

    const checklistOnly = await h.client(md.emp.id)
    await prisma.clientChecklistItem.create({ data: { organisationId: h.orgId, clientId: checklistOnly.id, kind: 'gst', customName: 'GSTR-9' } })
    expect(await get(checklistOnly.id)).toMatchObject({ service_codes: [], gst_data_exists: true })

    const profileOnly = await h.client(md.emp.id)
    await prisma.gstProfile.create({ data: { clientId: profileOnly.id, gstin: GSTIN } })
    expect(await get(profileOnly.id)).toMatchObject({ gst_data_exists: true, eway_bill_count: 0 })

    const eway = await h.client(md.emp.id)
    await prisma.ewayBill.create({
      data: { clientId: eway.id, ewbNo: uid('EWB'), documentNo: 'INV-1', documentDate: '2026-11-01', generatedByEmployeeId: md.emp.id },
    })
    expect(await get(eway.id)).toMatchObject({ gst_data_exists: false, eway_bill_count: 1 })
  })
})
