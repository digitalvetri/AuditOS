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

describe('Audit Automation and Repotic', () => {
  const q = () => `client_id=${clientId}`
  it('the assigned Associate reaches the client; an unassigned one gets 403', async () => {
    for (const path of [
      `/api/audit-automation/gst/2b?${q()}`,
      `/api/audit-automation/gst/purchase-registers?${q()}`,
      `/api/audit-automation/gst/recon?${q()}`,
      `/api/audit-automation/jobs?${q()}`,
      `/api/audit-automation/accounts?${q()}`,
      `/api/audit-automation/clients/${clientId}/ledger-master`,
      `/api/repotic/ecommerce/uploads?${q()}&gstin=33ABCDE1234F1Z5&period=2026-09`,
    ]) {
      expect((await api(path, { cookie: assigned.cookie })).status, `assigned ${path}`).toBe(200)
      expect((await api(path, { cookie: other.cookie })).status, `unassigned ${path}`).toBe(403)
    }
  })
  it('a firm-wide ledger rule needs an Admin; a rule for an assigned client does not', async () => {
    const rule = { match_type: 'contains', pattern: 'ZOMATO', direction: 'withdrawal', ledger_name: 'Staff Welfare' }
    expect((await api('/api/audit-automation/rules', { method: 'POST', cookie: assigned.cookie, body: rule })).status).toBe(403)
    expect((await api('/api/audit-automation/rules', { method: 'POST', cookie: assigned.cookie, body: { ...rule, client_id: clientId } })).status).toBe(201)
    expect((await api('/api/audit-automation/rules', { method: 'POST', cookie: other.cookie, body: { ...rule, client_id: clientId } })).status).toBe(403)
    expect((await api('/api/audit-automation/rules', { method: 'POST', cookie: admin.cookie, body: rule })).status).toBe(201)
  })
})

describe('Bookkeeping', () => {
  const company = (name: string, client_id?: string | null) => ({ name, books_begin_from: '2026-04-01', ...(client_id !== undefined ? { client_id } : {}) })
  let clientBooks = ''
  let firmBooks = ''
  beforeAll(async () => {
    const a = await api('/api/bookkeeping/companies', { method: 'POST', cookie: admin.cookie, body: company(uid('Assigned Co Books'), clientId) })
    expect(a.status).toBe(201)
    clientBooks = a.body.data.id
    const f = await api('/api/bookkeeping/companies', { method: 'POST', cookie: admin.cookie, body: company(uid('Firm Books')) })
    expect(f.status).toBe(201)
    firmBooks = f.body.data.id
  })
  it('the assigned Associate opens the client’s books; an unassigned one gets 403', async () => {
    for (const path of [`/api/bookkeeping/companies/${clientBooks}`, `/api/bookkeeping/companies/${clientBooks}/client-reports`]) {
      expect((await api(path, { cookie: assigned.cookie })).status, `assigned ${path}`).toBe(200)
      expect((await api(path, { cookie: other.cookie })).status, `unassigned ${path}`).toBe(403)
    }
  })
  it('books with no client are firm-level: Admin only', async () => {
    expect((await api(`/api/bookkeeping/companies/${firmBooks}`, { cookie: admin.cookie })).status).toBe(200)
    expect((await api(`/api/bookkeeping/companies/${firmBooks}`, { cookie: assigned.cookie })).status).toBe(403)
  })
  it('lists only visible companies', async () => {
    const mine = JSON.stringify((await api('/api/bookkeeping/companies', { cookie: assigned.cookie })).body)
    expect(mine).toContain(clientBooks)
    expect(mine).not.toContain(firmBooks)
    expect(JSON.stringify((await api('/api/bookkeeping/companies', { cookie: other.cookie })).body)).not.toContain(clientBooks)
  })
  it('an Associate creates books only for their own client', async () => {
    expect((await api('/api/bookkeeping/companies', { method: 'POST', cookie: other.cookie, body: company(uid('X'), clientId) })).status).toBe(403)
    expect((await api('/api/bookkeeping/companies', { method: 'POST', cookie: assigned.cookie, body: company(uid('Y'), clientId) })).status).toBe(201)
    expect((await api('/api/bookkeeping/companies', { method: 'POST', cookie: assigned.cookie, body: company(uid('Z')) })).status).toBe(403)
  })
})
