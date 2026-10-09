import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { istToday, addDays } from '../../../lib/dates.js'
import { api, client, employee, login, org, prisma, startServer, stopServer } from '../../compliance/__tests__/fixtures.js'
import { dscThreshold, sendDscAlerts } from '../alerts.js'

beforeAll(startServer)
afterAll(stopServer)

type Row = Record<string, any>

describe('DSC alert thresholds', () => {
  it('30 / 15 / 7, smallest crossed, never repeated or re-raised upward', () => {
    expect(dscThreshold(45, null)).toBeNull()
    expect(dscThreshold(30, null)).toBe(30)
    expect(dscThreshold(20, 30)).toBeNull()
    expect(dscThreshold(15, 30)).toBe(15)
    expect(dscThreshold(10, 15)).toBeNull()
    expect(dscThreshold(7, 15)).toBe(7)
    expect(dscThreshold(3, 7)).toBeNull()
    expect(dscThreshold(5, null)).toBe(7) // first seen late: one alert, not three
    expect(dscThreshold(-2, null)).toBe(7)
  })
})

describe('DSC register', () => {
  it('CRUD, scoping, firm DSCs, expiry filter', async () => {
    const o = await org()
    const staffEmp = await employee(o, 'Staff')
    const md = await login(o, 'md')
    const staff = await login(o, 'employee', staffEmp.id)
    const mine = await client(o, 'Hotel Pvt Ltd', { accountManagerId: staffEmp.id })
    const other = await client(o, 'India LLP')
    const today = istToday()

    const bad = await api('/api/dsc', { method: 'POST', cookie: md.cookie, body: { client_id: mine.id, holder_pan: 'X1', expiry_date: 'soon', dsc_class: 'class9' } })
    expect(bad.status).toBe(400)
    expect(Object.keys(bad.body.error.details).sort()).toEqual(['dsc_class', 'expiry_date', 'holder_name', 'holder_pan'])
    const d1 = await api('/api/dsc', { method: 'POST', cookie: staff.cookie, body: { client_id: mine.id, holder_name: 'R. Director', holder_pan: 'abcde1234f', holder_role: 'director', expiry_date: addDays(today, 10), custody: 'with_firm', provider: 'eMudhra' } })
    expect(d1.status).toBe(201)
    expect(d1.body.data).toMatchObject({ holder_pan: 'ABCDE1234F', days_left: 10, expired: false, dsc_class: 'class3', usage: 'signing', client_name: 'Hotel Pvt Ltd' })
    const d2 = await api('/api/dsc', { method: 'POST', cookie: md.cookie, body: { client_id: other.id, holder_name: 'P. Partner', expiry_date: addDays(today, 400) } })
    const expired = await api('/api/dsc', { method: 'POST', cookie: md.cookie, body: { client_id: other.id, holder_name: 'Old Token', expiry_date: addDays(today, -3) } })
    expect(expired.body.data).toMatchObject({ expired: true, days_left: -3 })
    // Firm DSC: only for staff who see every client
    expect((await api('/api/dsc', { method: 'POST', cookie: staff.cookie, body: { holder_name: 'Firm', expiry_date: addDays(today, 90) } })).status).toBe(403)
    const firm = await api('/api/dsc', { method: 'POST', cookie: md.cookie, body: { holder_name: 'Firm Partner', holder_role: 'firm', expiry_date: addDays(today, 90) } })
    expect(firm.status).toBe(201)

    const all = (await api('/api/dsc', { cookie: md.cookie })).body.data as Row[]
    expect(all.map((r) => r.id)).toEqual([expired.body.data.id, d1.body.data.id, firm.body.data.id, d2.body.data.id]) // by expiry
    const soon = (await api('/api/dsc?expiring_within_days=30', { cookie: md.cookie })).body.data as Row[]
    expect(soon.map((r) => r.id)).toEqual([expired.body.data.id, d1.body.data.id]) // already expired included
    const staffList = (await api('/api/dsc', { cookie: staff.cookie })).body.data as Row[]
    expect(staffList.map((r) => r.id)).toEqual([d1.body.data.id])
    expect((await api(`/api/dsc?client_id=${other.id}`, { cookie: staff.cookie })).status).toBe(403)
    expect((await api(`/api/dsc/${d2.body.data.id}`, { method: 'PATCH', cookie: staff.cookie, body: { notes: 'x' } })).status).toBe(403)
    expect((await api(`/api/dsc/${firm.body.data.id}`, { method: 'DELETE', cookie: staff.cookie })).status).toBe(403)

    // Renewal resets the alert marker
    await prisma.digitalSignature.update({ where: { id: d1.body.data.id }, data: { lastAlertDays: 15 } })
    expect((await api(`/api/dsc/${d1.body.data.id}`, { method: 'PATCH', cookie: staff.cookie, body: { valid_from: addDays(today, 500) } })).status).toBe(400)
    const renewed = await api(`/api/dsc/${d1.body.data.id}`, { method: 'PATCH', cookie: staff.cookie, body: { expiry_date: addDays(today, 730), token_serial: 'T-1' } })
    expect(renewed.body.data).toMatchObject({ last_alert_days: null, token_serial: 'T-1', days_left: 730 })
    const notes = await api(`/api/dsc/${d1.body.data.id}`, { method: 'PATCH', cookie: staff.cookie, body: { notes: 'kept in locker' } })
    expect(notes.body.data.last_alert_days).toBeNull()

    expect((await api(`/api/dsc/${d2.body.data.id}`, { method: 'DELETE', cookie: md.cookie })).status).toBe(204)
    expect(((await api('/api/dsc', { cookie: md.cookie })).body.data as Row[]).map((r) => r.id)).not.toContain(d2.body.data.id)
    expect(await prisma.auditLog.count({ where: { entityType: 'DigitalSignature', entityId: d1.body.data.id } })).toBe(3)
  })

  it('daily alerts: account manager notified + follow-up, at 30/15/7, no repeats', async () => {
    const o = await org()
    const mgr = await employee(o, 'Mgr')
    const u = await login(o, 'employee', mgr.id)
    const c = await client(o, 'Juliet Pvt Ltd', { accountManagerId: mgr.id })
    const dsc = await prisma.digitalSignature.create({ data: { organisationId: o.id, clientId: c.id, holderName: 'J. Director', expiryDate: '2033-03-31' } })
    const run = (today: string) => sendDscAlerts(prisma, today)
    const alerts = async () => (await prisma.notification.findMany({ where: { userId: u.id, entityType: 'dsc_expiry' }, orderBy: { createdAt: 'asc' } })).map((n) => n.entityId!.split(':').at(-1))

    await run('2033-02-01') // 58 days: nothing
    expect(await alerts()).toEqual([])
    await run('2033-03-01') // 30 days
    await run('2033-03-02')
    await run('2033-03-10')
    expect(await alerts()).toEqual(['30'])
    await run('2033-03-16') // 15
    await run('2033-03-20')
    await run('2033-03-24') // 7
    await run('2033-03-30')
    await run('2033-04-02') // expired: nothing more
    expect(await alerts()).toEqual(['30', '15', '7'])
    expect((await prisma.digitalSignature.findUniqueOrThrow({ where: { id: dsc.id } })).lastAlertDays).toBe(7)
    const fus = await prisma.followUp.findMany({ where: { clientId: c.id } })
    expect(fus).toHaveLength(3)
    expect(fus[0]).toMatchObject({ assignedEmployeeId: mgr.id, status: 'pending' })
    expect(fus[0].title).toMatch(/Renew DSC of J\. Director/)
  })
})
