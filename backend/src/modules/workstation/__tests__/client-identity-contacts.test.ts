import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { startHarness, type Harness, type Staff } from './ws-harness.js'

/**
 * Client master data:
 *  - a GSTIN must carry the client's PAN (characters 3–12);
 *  - a GSTIN already on another client is warned about, naming only clients
 *    the caller may see;
 *  - a client moves from onboarding to active when its first service is assigned;
 *  - the primary contact follows the client's contact fields, and contacts
 *    can be listed, added, edited and removed.
 */
let h: Harness
let md: Staff
let assoc: Staff
let serviceId = ''
const GSTIN = '33AABCS1234F1ZY'
const PAN = 'AABCS1234F'

const create = (s: Staff, extra: Record<string, unknown> = {}) => h.api('/api/clients', s.cookie, {
  method: 'POST',
  body: { company_name: uid('Ident Co'), contact_person: 'P', contact_number: '9876543210', account_manager_id: s.emp.id, ...extra },
})

beforeAll(async () => {
  h = await startHarness()
  md = await h.staff('md')
  assoc = await h.staff('employee')
  serviceId = (await prisma.service.create({ data: { organisationId: h.orgId, name: uid('Svc'), code: uid('SVC') } })).id
  // Clean slate for this GSTIN: earlier runs may have left clients with it.
  await prisma.client.updateMany({ where: { gstin: GSTIN, deletedAt: null }, data: { deletedAt: new Date() } })
})
afterAll(() => h?.close())

describe('GSTIN and PAN', () => {
  it('refuses a GSTIN whose PAN part differs from the PAN, on create and on edit', async () => {
    const bad = await create(md, { gstin: GSTIN, pan: 'AAAPL9999Q' })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).toContain('gstin')
    const okc = await create(md, { gstin: GSTIN, pan: PAN })
    expect(okc.status, JSON.stringify(okc.body)).toBe(201)
    expect((await h.api(`/api/clients/${okc.body.id}`, md.cookie, { method: 'PATCH', body: { pan: 'AAAPL9999Q' } })).status).toBe(400)
    // A legacy mismatch does not block an unrelated edit.
    await prisma.client.update({ where: { id: okc.body.id }, data: { pan: 'AAAPL9999Q' } })
    expect((await h.api(`/api/clients/${okc.body.id}`, md.cookie, { method: 'PATCH', body: { notes: 'hello' } })).status).toBe(200)
    await prisma.client.update({ where: { id: okc.body.id }, data: { deletedAt: new Date() } })
  })

  it('warns about a GSTIN already on another client, naming only clients the caller can see', async () => {
    const first = await create(md, { gstin: GSTIN })
    expect(first.status).toBe(201)
    expect(first.body.gstin_duplicates).toEqual([])
    const second = await create(md, { gstin: GSTIN })
    expect(second.status).toBe(201)
    expect(second.body.gstin_duplicates.map((d: any) => d.id)).toContain(first.body.id)
    // The Associate cannot see either: told how many, never which.
    const third = await create(assoc, { gstin: GSTIN })
    expect(third.status).toBe(201)
    expect(third.body.gstin_duplicates).toEqual([])
    expect(third.body.gstin_duplicates_hidden).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(third.body)).not.toContain(first.body.company_name)
    // PATCH warns too, when it touches the GSTIN.
    const other = await create(md)
    const p = await h.api(`/api/clients/${other.body.id}`, md.cookie, { method: 'PATCH', body: { gstin: GSTIN } })
    expect(p.status).toBe(200)
    expect(p.body.gstin_duplicates.length).toBeGreaterThanOrEqual(2)
  })
})

describe('onboarding to active', () => {
  it('a new client becomes active when its first service is assigned', async () => {
    const c = await create(md)
    expect(c.body.status).toBe('onboarding')
    const s = await h.api(`/api/clients/${c.body.id}/services`, md.cookie, { method: 'POST', body: { service_id: serviceId, assigned_employee_id: md.emp.id } })
    expect(s.status, JSON.stringify(s.body)).toBe(201)
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.body.id } })).status).toBe('active')
  })

  it('a converted lead (which arrives with its service) is active', async () => {
    const lead = await prisma.lead.create({
      data: { organisationId: h.orgId, leadCode: uid('LD'), name: uid('Lead'), contactNumber: '9876543210', serviceId, assignedEmployeeId: md.emp.id, status: 'won' },
    })
    const r = await h.api(`/api/leads/${lead.id}/convert`, md.cookie, { method: 'POST', body: { company_name: uid('Conv'), contact_person: 'P', contact_number: '9876543210', account_manager_id: md.emp.id } })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const client = await prisma.client.findFirstOrThrow({ where: { sourceLeadId: lead.id } })
    expect(client.status).toBe('active')
  })

  it('does not touch a client that is already past onboarding', async () => {
    const c = await create(md)
    await h.api(`/api/clients/${c.body.id}`, md.cookie, { method: 'PATCH', body: { status: 'pending_documents' } })
    await h.api(`/api/clients/${c.body.id}/services`, md.cookie, { method: 'POST', body: { service_id: serviceId, assigned_employee_id: md.emp.id } })
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.body.id } })).status).toBe('pending_documents')
  })
})

describe('contacts', () => {
  it('the primary contact follows the client\'s contact fields', async () => {
    const c = await create(md)
    const r = await h.api(`/api/clients/${c.body.id}`, md.cookie, { method: 'PATCH', body: { contact_person: 'New Person', contact_number: '9899988877', email: 'new@x.local' } })
    expect(r.status).toBe(200)
    const primary = await prisma.clientContact.findFirstOrThrow({ where: { clientId: c.body.id, isPrimary: true, deletedAt: null } })
    expect(primary).toMatchObject({ name: 'New Person', phone: '9899988877', email: 'new@x.local' })
  })

  it('a client with no primary contact row gets one on edit', async () => {
    const c = await h.client(md.emp.id)
    await h.api(`/api/clients/${c.id}`, md.cookie, { method: 'PATCH', body: { contact_number: '9811122233' } })
    expect(await prisma.clientContact.count({ where: { clientId: c.id, isPrimary: true, deletedAt: null } })).toBe(1)
  })

  it('lists, adds, edits and removes contacts; the primary cannot be removed and editing it updates the client', async () => {
    const c = await create(md)
    const base = `/api/clients/${c.body.id}/contacts`
    const added = await h.api(base, md.cookie, { method: 'POST', body: { name: 'Accountant A', designation: 'Accountant', phone: '9876500001', email: 'acc@x.local' } })
    expect(added.status, JSON.stringify(added.body)).toBe(201)
    expect(added.body.is_primary).toBe(false)
    expect((await h.api(base, md.cookie, { method: 'POST', body: { name: 'X', phone: '12' } })).status).toBe(400)
    const list = await h.api(base, md.cookie)
    expect(list.body.items.length).toBe(2)
    expect((await h.api(`${base}/${added.body.id}`, md.cookie, { method: 'PATCH', body: { designation: 'CFO' } })).body.designation).toBe('CFO')

    const primary = list.body.items.find((x: any) => x.is_primary)
    expect((await h.api(`${base}/${primary.id}`, md.cookie, { method: 'DELETE' })).status).toBe(409)
    await h.api(`${base}/${primary.id}`, md.cookie, { method: 'PATCH', body: { phone: '9822233344', name: 'Owner' } })
    const client = await prisma.client.findUniqueOrThrow({ where: { id: c.body.id } })
    expect(client).toMatchObject({ contactNumber: '9822233344', contactPerson: 'Owner' })

    expect((await h.api(`${base}/${added.body.id}`, md.cookie, { method: 'DELETE' })).status).toBe(200)
    expect((await h.api(base, md.cookie)).body.items.length).toBe(1)
  })

  it('refuses another client\'s contact id, a missing client, and an unseen client', async () => {
    const a = await create(md)
    const b = await create(md)
    const contactOfB = (await h.api(`/api/clients/${b.body.id}/contacts`, md.cookie)).body.items[0]
    expect((await h.api(`/api/clients/${a.body.id}/contacts/${contactOfB.id}`, md.cookie, { method: 'PATCH', body: { name: 'Hijack' } })).status).toBe(404)
    expect((await h.api('/api/clients/no-such-client/contacts', md.cookie, { method: 'POST', body: { name: 'N', phone: '9876543210' } })).status).toBe(404)
    expect((await h.api(`/api/clients/${a.body.id}/contacts`, assoc.cookie)).status).toBe(403)
  })
})

describe('one-time onboarding backfill', () => {
  it('moves onboarding clients that have a service to active, once', async () => {
    const { backfillOnboardingWithServices, ONBOARDING_BACKFILL_ACTION } = await import('../clients.shared.js')
    const markers = await prisma.auditLog.findMany({ where: { action: ONBOARDING_BACKFILL_ACTION }, select: { id: true } })
    // Not yet run in this database: run it now. Already run: a re-run changes nothing.
    const withService = await h.client(md.emp.id, { status: 'onboarding' })
    await prisma.clientService.create({ data: { clientId: withService.id, serviceId, assignedEmployeeId: md.emp.id } })
    const bare = await h.client(md.emp.id, { status: 'onboarding' })
    const moved = await backfillOnboardingWithServices(prisma)
    if (markers.length === 0) {
      expect(moved).toBeGreaterThanOrEqual(1)
      expect((await prisma.client.findUniqueOrThrow({ where: { id: withService.id } })).status).toBe('active')
    } else {
      expect(moved).toBe(0)
    }
    expect((await prisma.client.findUniqueOrThrow({ where: { id: bare.id } })).status).toBe('onboarding')
    expect(await backfillOnboardingWithServices(prisma)).toBe(0)
    expect(await prisma.auditLog.count({ where: { action: ONBOARDING_BACKFILL_ACTION } })).toBe(1)
  })
})
