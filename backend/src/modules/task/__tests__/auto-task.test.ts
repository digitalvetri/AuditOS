import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { startHarness, type Harness, type Staff } from '../../workstation/__tests__/ws-harness.js'

/**
 * A service added to a client becomes a task at once, unassigned. Work is
 * handed out only from the Task module: the task cannot be started until a
 * manager assigns it, and leads / clients are created without naming anyone.
 */
let h: Harness
let md: Staff
let emp: Staff
let svcA = ''
let svcB = ''

beforeAll(async () => {
  h = await startHarness()
  md = await h.staff('md')
  emp = await h.staff('employee')
  svcA = (await prisma.service.create({ data: { organisationId: h.orgId, name: uid('Bookkeeping'), code: uid('SVCA') } })).id
  svcB = (await prisma.service.create({ data: { organisationId: h.orgId, name: uid('TDS returns'), code: uid('SVCB') } })).id
})
afterAll(() => h?.close())

const tasksFor = (clientServiceId: string) => prisma.task.findMany({ where: { clientServiceId, deletedAt: null } })

describe('automatic tasks', () => {
  it('assigning services raises one unassigned task per service, once', async () => {
    const c = await h.client(md.emp.id, { status: 'active' })
    const r = await h.api(`/api/clients/${c.id}/services`, md.cookie, { method: 'POST', body: { service_ids: [svcA, svcB], due_date: '2026-12-15' } })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const rows = await prisma.clientService.findMany({ where: { clientId: c.id } })
    expect(rows).toHaveLength(2)
    for (const cs of rows) {
      const ts = await tasksFor(cs.id)
      expect(ts).toHaveLength(1)
      expect(ts[0]).toMatchObject({ assignedEmployeeId: null, source: 'service_added', status: 'pending', dueDate: '2026-12-15', clientId: c.id })
    }
    // Adding the same services again skips them and raises nothing new.
    await h.api(`/api/clients/${c.id}/services`, md.cookie, { method: 'POST', body: { service_ids: [svcA, svcB] } })
    expect(await prisma.task.count({ where: { clientId: c.id } })).toBe(2)
  })

  it('cannot be started until assigned; assigning hands it to that person', async () => {
    const c = await h.client(md.emp.id, { status: 'active' })
    await h.api(`/api/clients/${c.id}/services`, md.cookie, { method: 'POST', body: { service_ids: [svcA] } })
    const task = (await prisma.task.findFirstOrThrow({ where: { clientId: c.id } }))

    const listed = await h.api('/api/tasks?employee_id=unassigned&limit=200', md.cookie)
    expect(listed.status).toBe(200)
    expect(listed.body.items.map((t: { id: string }) => t.id)).toContain(task.id)
    expect(listed.body.items.find((t: { id: string }) => t.id === task.id).assigned_employee_name).toBeNull()

    const start = await h.api(`/api/tasks/${task.id}/start`, md.cookie, { method: 'POST' })
    expect(start.status).toBe(422)

    const assign = await h.api(`/api/tasks/${task.id}/reassign`, md.cookie, { method: 'POST', body: { employee_id: emp.emp.id } })
    expect(assign.status, JSON.stringify(assign.body)).toBe(200)
    expect(assign.body.task?.assigned_employee_id ?? assign.body.assigned_employee_id).toBe(emp.emp.id)
    expect((await h.api(`/api/tasks/${task.id}/start`, emp.cookie, { method: 'POST' })).status).toBe(200)
  })

  it('a lead converts into a client with its service raised as an unassigned task', async () => {
    const lead = await h.api('/api/leads', md.cookie, { method: 'POST', body: { name: 'Auto Task Lead', contact_number: '9876500011', service_id: svcA, price_quoted: 0 } })
    expect(lead.status, JSON.stringify(lead.body)).toBe(201)
    // Nobody was named: the lead is the creator's.
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.body.id } })
    expect(row.assignedEmployeeId).toBe(md.emp.id)
    await prisma.lead.update({ where: { id: row.id }, data: { status: 'won' } })

    const conv = await h.api(`/api/leads/${row.id}/convert`, md.cookie, { method: 'POST', body: { company_name: 'Auto Task Co', contact_person: 'P', contact_number: '9876500011' } })
    expect(conv.status, JSON.stringify(conv.body)).toBe(201)
    const clientId = conv.body.client.id
    const cs = await prisma.clientService.findFirstOrThrow({ where: { clientId } })
    expect(cs.assignedEmployeeId).toBeNull()
    expect(await tasksFor(cs.id)).toMatchObject([{ assignedEmployeeId: null, source: 'service_added' }])
  })

  it('a client is created without naming anyone', async () => {
    const r = await h.api('/api/clients', md.cookie, { method: 'POST', body: { company_name: uid('No Owner Co'), contact_person: 'P', contact_number: '9876500022' } })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect((await prisma.client.findUniqueOrThrow({ where: { id: r.body.id } })).accountManagerId).toBe(md.emp.id)
  })

  it('removing a service cancels its untouched automatic task instead of refusing', async () => {
    const c = await h.client(md.emp.id, { status: 'active' })
    await h.api(`/api/clients/${c.id}/services`, md.cookie, { method: 'POST', body: { service_ids: [svcB] } })
    const cs = await prisma.clientService.findFirstOrThrow({ where: { clientId: c.id } })
    const r = await h.api(`/api/services/${cs.id}`, md.cookie, { method: 'DELETE' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((await tasksFor(cs.id))[0].status).toBe('cancelled')
  })
})
