import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'

/**
 * Leads and document verification by role (roles from setupRoles):
 *  - an Intern sees and works only the leads assigned to them (list, detail,
 *    dashboard count, search);
 *  - an Associate sees every lead but converts only their own, and cannot
 *    take over someone else's lead to convert it;
 *  - converting or reassigning anyone's lead: Senior Associate and above;
 *  - verifying a client document: Senior Associate and above.
 */

type Code = 'dept_manager' | 'employee' | 'intern'
let server: Server
let base = ''
let orgId = ''
let wsId = ''
let serviceId = ''
const p: Record<Code, { emp: { id: string }; cookie: string }> = {} as never
let other: { emp: { id: string }; cookie: string }

async function api(path: string, cookie: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let j: any = null
  try { j = text ? JSON.parse(text) : null } catch { j = text }
  return { status: res.status, body: j && typeof j === 'object' && 'data' in j ? j.data : j }
}

async function staff(code: Code) {
  const role = await prisma.role.findUniqueOrThrow({ where: { code } })
  const emp = await prisma.employee.create({
    data: {
      organisationId: orgId, employeeCode: uid('LR'), firstName: 'L', lastName: code, fullName: uid(`L ${code}`),
      email: `${uid('lr')}@x.local`, joiningDate: '2025-01-01', status: 'active', workScheduleId: wsId,
    },
  })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  return { emp, cookie: `ao_access=${signToken(u.id)}` }
}

const tag = uid('Lead')
async function lead(assignedEmployeeId: string, status = 'won') {
  return prisma.lead.create({
    data: {
      organisationId: orgId, leadCode: uid('LD'), name: `${tag} ${uid('n')}`, contactNumber: '9876543210',
      serviceId, assignedEmployeeId, status,
    },
  })
}

const convertBody = (managerId: string) => ({
  company_name: uid('Converted Co'), contact_person: 'P', contact_number: '9876543210', account_manager_id: managerId,
})

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.create({ data: { id: uid('ws'), organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  serviceId = (await prisma.service.create({ data: { organisationId: orgId, name: uid('GST Registration'), code: uid('SVC') } })).id
  for (const c of ['dept_manager', 'employee', 'intern'] as Code[]) p[c] = await staff(c)
  other = await staff('employee')
})
afterAll(() => server?.close())

describe('an Intern works only their own leads', () => {
  it('list, detail, dashboard and search show only the Intern\'s leads', async () => {
    const mine = await lead(p.intern.emp.id, 'new')
    const theirs = await lead(other.emp.id, 'new')
    const list = await api('/api/leads', p.intern.cookie)
    expect(list.status).toBe(200)
    const ids = (list.body.items ?? list.body).map((l: { id: string }) => l.id)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(theirs.id)
    expect((await api(`/api/leads/${theirs.id}`, p.intern.cookie)).status).toBe(403)
    expect((await api(`/api/leads/${theirs.id}`, p.intern.cookie, { method: 'PATCH', body: { notes: 'x' } })).status).toBe(403)

    const dash = await api('/api/workstation/dashboard', p.intern.cookie)
    expect(dash.status).toBe(200)
    const mineCount = await prisma.lead.count({ where: { assignedEmployeeId: p.intern.emp.id, deletedAt: null } })
    expect(dash.body.kpis?.total_leads ?? dash.body.total_leads).toBe(mineCount)

    const search = await api(`/api/workstation/search?q=${encodeURIComponent(tag)}`, p.intern.cookie)
    expect(search.status).toBe(200)
    const found = search.body.leads.map((l: { id: string }) => l.id)
    expect(found).toContain(mine.id)
    expect(found).not.toContain(theirs.id)

    // An Associate still sees every lead.
    expect((await api(`/api/leads/${theirs.id}`, p.employee.cookie)).status).toBe(200)
  })
})

describe('converting someone else\'s lead: Senior Associate and above', () => {
  it('an Associate cannot convert a colleague\'s lead, nor take it over first; nothing is created', async () => {
    const theirs = await lead(other.emp.id)
    const clients = await prisma.client.count()
    const r = await api(`/api/leads/${theirs.id}/convert`, p.employee.cookie, { method: 'POST', body: convertBody(p.employee.emp.id) })
    expect(r.status).toBe(403)
    expect(await prisma.client.count()).toBe(clients)
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: theirs.id } })).convertedClientId).toBeNull()

    const take = await api(`/api/leads/${theirs.id}`, p.employee.cookie, { method: 'PATCH', body: { assigned_employee_id: p.employee.emp.id } })
    expect(take.status).toBe(403)
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: theirs.id } })).assignedEmployeeId).toBe(other.emp.id)
  })

  it('an Associate converts their own lead and may hand it to a colleague', async () => {
    const mine = await lead(p.employee.emp.id)
    const r = await api(`/api/leads/${mine.id}/convert`, p.employee.cookie, { method: 'POST', body: convertBody(p.employee.emp.id) })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const handOver = await lead(p.employee.emp.id, 'new')
    expect((await api(`/api/leads/${handOver.id}`, p.employee.cookie, { method: 'PATCH', body: { assigned_employee_id: other.emp.id } })).status).toBe(200)
  })

  it('a Senior Associate converts and reassigns anyone\'s lead', async () => {
    const theirs = await lead(other.emp.id)
    const r = await api(`/api/leads/${theirs.id}/convert`, p.dept_manager.cookie, { method: 'POST', body: convertBody(other.emp.id) })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const again = await lead(other.emp.id, 'new')
    expect((await api(`/api/leads/${again.id}`, p.dept_manager.cookie, { method: 'PATCH', body: { assigned_employee_id: p.employee.emp.id } })).status).toBe(200)
  })
})

describe('verifying a client document: Senior Associate and above', () => {
  it('Associate and Intern on the client are refused; the Senior Associate verifies', async () => {
    const client = await prisma.client.create({
      data: {
        organisationId: orgId, clientCode: uid('DV'), companyName: 'Docs Co', contactPerson: 'P', contactNumber: '9876543210',
        onboardingDate: '2026-01-01', accountManagerId: p.employee.emp.id, secondaryManagerId: p.intern.emp.id,
      },
    })
    const cat = await prisma.documentCategory.create({ data: { organisationId: orgId, code: uid('CAT'), name: 'Bank statement' } })
    const doc = await prisma.clientDocument.create({ data: { clientId: client.id, categoryId: cat.id, name: 'HDFC Apr', currentVersion: 1, status: 'uploaded' } as never })
    await prisma.clientDocumentVersion.create({ data: { documentId: doc.id, version: 1, fileKey: 'x/y.pdf', uploadedBy: other.emp.id } })
    for (const code of ['employee', 'intern'] as const) {
      expect((await api(`/api/client-documents/${doc.id}/verify`, p[code].cookie, { method: 'POST', body: { approve: true } })).status, code).toBe(403)
    }
    expect((await prisma.clientDocument.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe('uploaded')
    const ok = await api(`/api/client-documents/${doc.id}/verify`, p.dept_manager.cookie, { method: 'POST', body: { approve: true } })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })
})
