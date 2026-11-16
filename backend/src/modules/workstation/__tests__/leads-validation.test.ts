import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { startHarness, type Harness, type Staff } from './ws-harness.js'

/** Lead search ignores case; lead edit and conversion refuse employees and services that do not exist. */
let h: Harness
let md: Staff
let serviceId = ''
const tag = uid('MixedCaseLead')

async function lead(status = 'won') {
  return prisma.lead.create({
    data: {
      organisationId: h.orgId, leadCode: uid('LD'), name: `${tag} ${uid('n')}`, contactNumber: '9876543210',
      serviceId, assignedEmployeeId: md.emp.id, status,
    },
  })
}

beforeAll(async () => {
  h = await startHarness()
  md = await h.staff('md')
  serviceId = (await prisma.service.create({ data: { organisationId: h.orgId, name: uid('Svc'), code: uid('SVC') } })).id
})
afterAll(() => h?.close())

describe('lead search', () => {
  it('matches regardless of case', async () => {
    const l = await lead('new')
    for (const q of [tag.toLowerCase(), tag.toUpperCase()]) {
      const r = await h.api(`/api/leads?q=${encodeURIComponent(q)}`, md.cookie)
      expect(r.status).toBe(200)
      expect(r.body.items.map((i: any) => i.id)).toContain(l.id)
    }
  })
})

describe('lead edit', () => {
  it('refuses an unknown assignee or service with 400 and leaves the lead alone', async () => {
    const l = await lead('new')
    const a = await h.api(`/api/leads/${l.id}`, md.cookie, { method: 'PATCH', body: { assigned_employee_id: 'ghost-employee' } })
    expect(a.status).toBe(400)
    const s = await h.api(`/api/leads/${l.id}`, md.cookie, { method: 'PATCH', body: { service_id: 'ghost-service' } })
    expect(s.status).toBe(400)
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } })
    expect(after.assignedEmployeeId).toBe(md.emp.id)
    expect(after.serviceId).toBe(serviceId)
  })
})

describe('lead conversion', () => {
  const body = (extra: Record<string, unknown>) => ({ company_name: uid('Conv Co'), contact_person: 'P', contact_number: '9876543210', ...extra })

  it('refuses an unknown account manager or second staff and creates no client', async () => {
    const l = await lead()
    const a = await h.api(`/api/leads/${l.id}/convert`, md.cookie, { method: 'POST', body: body({ account_manager_id: 'ghost-employee' }) })
    expect(a.status).toBe(400)
    const s = await h.api(`/api/leads/${l.id}/convert`, md.cookie, { method: 'POST', body: body({ account_manager_id: md.emp.id, secondary_manager_id: 'ghost-employee' }) })
    expect(s.status).toBe(400)
    expect(await prisma.client.count({ where: { sourceLeadId: l.id } })).toBe(0)
  })

  it('still converts with real staff', async () => {
    const l = await lead()
    const r = await h.api(`/api/leads/${l.id}/convert`, md.cookie, { method: 'POST', body: body({ account_manager_id: md.emp.id }) })
    expect(r.status).toBe(201)
  })
})
