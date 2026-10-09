import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { setupRoles } from '../../../prisma/setup-roles.js'

/**
 * Associates and Interns see only the clients they are assigned to. These
 * modules used to scope by firm only.
 */

let server: Server
let base = ''
let orgId = ''
let wsId = ''

async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body: body as any }
}

async function staff(code: string) {
  const r = await prisma.role.findUniqueOrThrow({ where: { code } })
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AO'), firstName: 'S', lastName: code, fullName: `S ${code}`, email: `${uid('s')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: r.id, employeeId: emp.id } })
  return { emp, cookie: `ao_access=${signToken(u.id)}` }
}

let assigned: Awaited<ReturnType<typeof staff>>
let other: Awaited<ReturnType<typeof staff>>
let admin: Awaited<ReturnType<typeof staff>>
let clientId = ''

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  assigned = await staff('employee')
  other = await staff('employee')
  admin = await staff('hr_admin')
  clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Assigned Co', contactPerson: 'P', contactNumber: '9876543210', accountManagerId: assigned.emp.id, onboardingDate: '2026-01-01' } })).id
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('Zoho Books', () => {
  let zohoOrg = ''
  beforeAll(async () => {
    const conn = await prisma.booksZohoConnection.create({ data: { organisationId: orgId, status: 'connected' } as never })
    zohoOrg = (await prisma.booksZohoOrganization.create({ data: { organisationId: orgId, connectionId: conn.id, zohoOrgId: uid('z'), name: 'Assigned Co Books', isActive: true, clientId } as never })).id
  })
  it('the assigned Associate and an Admin can open the client’s books', async () => {
    expect((await api(`/api/books/o/${zohoOrg}/sync-logs`, { cookie: assigned.cookie })).status).toBe(200)
    expect((await api(`/api/books/o/${zohoOrg}/sync-logs`, { cookie: admin.cookie })).status).toBe(200)
  })
  it('an unassigned Associate cannot', async () => {
    expect((await api(`/api/books/o/${zohoOrg}/sync-logs`, { cookie: other.cookie })).status).toBe(403)
  })
  it('the unassigned Associate does not see the organisation listed', async () => {
    const r = await api('/api/books/status', { cookie: other.cookie })
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.body)).not.toContain(zohoOrg)
  })
  it('only staff who see every client can remap or deactivate an organisation', async () => {
    expect((await api(`/api/books/organizations/${zohoOrg}`, { method: 'PATCH', cookie: assigned.cookie, body: { is_active: false } })).status).toBe(403)
  })
})
