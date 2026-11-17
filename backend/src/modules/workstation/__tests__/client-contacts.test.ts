import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'

/**
 * POST-DELIVERY-CHANGES §B2 — multiple contacts per client.
 *
 * The client complained that only one phone number could live on a client.
 * These tests pin the invariant and the Client.contactNumber sync.
 */

let server: Server
let base = ''
let orgId = ''
let wsId = ''
let ownerId = ''
let adminCookie = ''

async function api(path: string, cookie: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function employee() {
  return prisma.employee.create({
    data: {
      organisationId: orgId, employeeCode: uid('EC'), firstName: 'Admin', lastName: 'Staff', fullName: uid('Admin'),
      email: `${uid('e')}@x.local`, joiningDate: '2025-01-01', status: 'active', workScheduleId: wsId,
    },
  })
}

async function makeClient(name = uid('TC')) {
  return prisma.client.create({
    data: {
      organisationId: orgId, clientCode: name, companyName: name, contactPerson: 'Owner', contactNumber: '9888811111',
      email: `${name.toLowerCase()}@x.test`, accountManagerId: ownerId, status: 'active', onboardingDate: '2026-01-01',
    },
  })
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id
    ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.create({ data: { id: uid('ws'), organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  const roleId = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.code, r.id]))
  ownerId = (await employee()).id
  const admin = await prisma.user.create({
    data: { organisationId: orgId, email: `${uid('a')}@x.local`, passwordHash: 'x', roleId: roleId.senior_associate, employeeId: ownerId },
  })
  adminCookie = `ao_access=${signToken(admin.id)}`
})
afterAll(() => server?.close())

describe('POST-DELIVERY-CHANGES §B2 · multiple contacts per client', () => {
  it('POST adds a contact; GET returns it; primary stays unique', async () => {
    const c = await makeClient()
    // One primary is seeded by the DB (via the create shared helper) in production,
    // but tests created the client directly without contacts. Add one as primary,
    // then add a second as non-primary.
    const first = await api(`/api/clients/${c.id}/contacts`, adminCookie, { method: 'POST', body: {
      name: 'Rajesh Kumar', designation: 'Owner', phone: '9888811111', email: 'rk@acme.test', is_primary: true,
    } })
    expect(first.status).toBe(201)
    expect(first.body.data).toMatchObject({ name: 'Rajesh Kumar', phone: '9888811111', is_primary: true })

    const second = await api(`/api/clients/${c.id}/contacts`, adminCookie, { method: 'POST', body: {
      name: 'Priya Accountant', designation: 'Accountant', phone: '9000022222', email: 'priya@acme.test',
    } })
    expect(second.status).toBe(201)
    expect(second.body.data.is_primary).toBe(false)

    const list = await api(`/api/clients/${c.id}/contacts`, adminCookie)
    expect(list.body.data.items).toHaveLength(2)
    // Primary appears first in the list order.
    expect(list.body.data.items[0].is_primary).toBe(true)
  })

  it('promoting a second contact to primary demotes the first and updates Client.contactNumber', async () => {
    const c = await makeClient()
    const p = await api(`/api/clients/${c.id}/contacts`, adminCookie, { method: 'POST', body: {
      name: 'A', phone: '9000011111', is_primary: true,
    } })
    const q = await api(`/api/clients/${c.id}/contacts`, adminCookie, { method: 'POST', body: {
      name: 'B', phone: '9000022222',
    } })
    const promoted = await api(`/api/clients/${c.id}/contacts/${q.body.data.id}`, adminCookie, {
      method: 'PATCH', body: { is_primary: true },
    })
    expect(promoted.status).toBe(200)
    expect(promoted.body.data.is_primary).toBe(true)

    const re = await prisma.clientContact.findUniqueOrThrow({ where: { id: p.body.data.id } })
    expect(re.isPrimary).toBe(false)

    const client = await prisma.client.findUniqueOrThrow({ where: { id: c.id } })
    expect(client.contactNumber).toBe('9000022222')
  })

  it('DELETE soft-deletes and removes the row from the list', async () => {
    const c = await makeClient()
    const extra = await api(`/api/clients/${c.id}/contacts`, adminCookie, { method: 'POST', body: {
      name: 'Transient', phone: '9111133333',
    } })
    const del = await api(`/api/clients/${c.id}/contacts/${extra.body.data.id}`, adminCookie, { method: 'DELETE' })
    expect(del.status).toBe(200)
    const list = await api(`/api/clients/${c.id}/contacts`, adminCookie)
    expect(list.body.data.items.find((i: { id: string }) => i.id === extra.body.data.id)).toBeUndefined()
  })

  it('a bad phone is rejected and the row is not created', async () => {
    const c = await makeClient()
    const r = await api(`/api/clients/${c.id}/contacts`, adminCookie, { method: 'POST', body: {
      name: 'Malformed', phone: '12345',
    } })
    expect(r.status).toBe(400)
    const list = await api(`/api/clients/${c.id}/contacts`, adminCookie)
    expect(list.body.data.items.find((i: { name: string }) => i.name === 'Malformed')).toBeUndefined()
  })
})
