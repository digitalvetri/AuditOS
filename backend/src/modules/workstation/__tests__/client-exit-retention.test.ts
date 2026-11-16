import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { istToday } from '../../../lib/dates.js'
import { startHarness, type Harness, type Staff } from './ws-harness.js'

/**
 * Exit date = the day the firm stopped acting; the 7-year retention clock
 * runs from it. Every path that changes a client's status keeps it honest:
 * reactivating clears it, deactivating sets today when none is given, so a
 * client who left today is never "due for deletion" on an old date.
 */
let h: Harness
let md: Staff
const today = istToday()

beforeAll(async () => {
  h = await startHarness()
  md = await h.staff('md')
})
afterAll(() => h?.close())

const exitOf = async (id: string) => prisma.client.findUniqueOrThrow({ where: { id }, select: { status: true, exitDate: true, exitReason: true } })
const bulk = (ids: string[], status: string) => h.api('/api/clients/bulk', md.cookie, { method: 'POST', body: { action: 'set_status', ids, status } })

describe('single-client PATCH', () => {
  it('reactivating clears the exit date and reason; deactivating without a date sets today', async () => {
    const c = await h.client(md.emp.id, { status: 'inactive', exitDate: '2017-03-31', exitReason: 'Moved' })
    expect((await h.api(`/api/clients/${c.id}`, md.cookie, { method: 'PATCH', body: { status: 'active' } })).status).toBe(200)
    expect(await exitOf(c.id)).toMatchObject({ status: 'active', exitDate: null, exitReason: null })
    expect((await h.api(`/api/clients/${c.id}`, md.cookie, { method: 'PATCH', body: { status: 'inactive' } })).status).toBe(200)
    expect(await exitOf(c.id)).toMatchObject({ status: 'inactive', exitDate: today })
  })

  it('keeps an exit date the user gives', async () => {
    const c = await h.client(md.emp.id, { status: 'active' })
    expect((await h.api(`/api/clients/${c.id}`, md.cookie, { method: 'PATCH', body: { status: 'inactive', exit_date: '2026-10-31' } })).status).toBe(200)
    expect((await exitOf(c.id)).exitDate).toBe('2026-10-31')
  })
})

describe('bulk set_status', () => {
  it('reactivating clears stale exit dates; deactivating sets today', async () => {
    const stale = await h.client(md.emp.id, { status: 'inactive', exitDate: '2017-03-31', exitReason: 'Moved' })
    const never = await h.client(md.emp.id, { status: 'active' })
    expect((await bulk([stale.id], 'active')).status).toBe(200)
    expect(await exitOf(stale.id)).toMatchObject({ status: 'active', exitDate: null, exitReason: null })
    expect((await bulk([stale.id, never.id], 'inactive')).status).toBe(200)
    for (const id of [stale.id, never.id]) expect(await exitOf(id)).toMatchObject({ status: 'inactive', exitDate: today })
  })

  it('a client who left today is not due for deletion', async () => {
    const c = await h.client(md.emp.id, { status: 'inactive', exitDate: '2017-03-31' })
    await bulk([c.id], 'active')
    await bulk([c.id], 'inactive')
    const due = await h.api('/api/data-protection/retention/due', md.cookie)
    expect(due.status, JSON.stringify(due.body)).toBe(200)
    const items = (due.body.items ?? due.body) as Array<{ client_id: string }>
    expect(items.map((i) => i.client_id)).not.toContain(c.id)
  })
})

describe('completing a service', () => {
  it('does not bring a former client back to active', async () => {
    const c = await h.client(md.emp.id, { status: 'inactive', exitDate: '2026-09-30' })
    const svc = await prisma.service.create({ data: { organisationId: h.orgId, code: uid('SVC'), name: uid('Svc') } })
    const cs = await prisma.clientService.create({ data: { clientId: c.id, serviceId: svc.id, assignedEmployeeId: md.emp.id, status: 'in_progress' } })
    const r = await h.api(`/api/services/${cs.id}`, md.cookie, { method: 'PATCH', body: { status: 'completed' } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(await exitOf(c.id)).toMatchObject({ status: 'inactive', exitDate: '2026-09-30' })
  })
})
