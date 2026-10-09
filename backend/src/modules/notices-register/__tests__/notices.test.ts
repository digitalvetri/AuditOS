import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { api, client, employee, login, org, prisma, startServer, stopServer } from '../../compliance/__tests__/fixtures.js'
import { statusMoveAllowed } from '../routes.js'
import { noticeStage, sendNoticeReminders } from '../reminders.js'

beforeAll(async () => {
  process.env.CLIENT_NOTICE_STORAGE_ROOT = mkdtempSync(path.join(tmpdir(), 'auditos-test-notices-'))
  await startServer()
})
afterAll(stopServer)

type Row = Record<string, any>

describe('status flow', () => {
  it('forward-only; back only for a manager', () => {
    expect(statusMoveAllowed('received', 'replied', false)).toBe(true)
    expect(statusMoveAllowed('replied', 'replied', false)).toBe(true)
    expect(statusMoveAllowed('hearing', 'in_progress', false)).toBe(false)
    expect(statusMoveAllowed('closed', 'received', true)).toBe(true)
    expect(statusMoveAllowed('received', 'bogus', true)).toBe(false)
  })
})

describe('notices register API', () => {
  it('records notices, merges GST notices, keeps the status flow, and scopes by client', async () => {
    const o = await org()
    const staffEmp = await employee(o, 'Staff')
    const md = await login(o, 'md')
    const staff = await login(o, 'employee', staffEmp.id)
    const mine = await client(o, 'Echo Pvt Ltd', { accountManagerId: staffEmp.id })
    const other = await client(o, 'Foxtrot LLP')

    // Create (JSON) — validation first
    const bad = await api('/api/notices-register', { method: 'POST', cookie: md.cookie, body: { client_id: mine.id, authority: 'nope', notice_date: '2026-13-01' } })
    expect(bad.status).toBe(400)
    expect(Object.keys(bad.body.error.details)).toEqual(expect.arrayContaining(['authority', 'section', 'notice_date']))
    const created = await api('/api/notices-register', {
      method: 'POST', cookie: md.cookie,
      body: { client_id: mine.id, authority: 'income_tax', section: '143(2)', notice_date: '2026-09-01', response_due_date: '2026-09-15', din: 'ITBA/AST/S/143(2)/2026', demand_paise: 1250000, assessment_year: '2025-26' },
    })
    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({ source: 'notice', status: 'received', section: '143(2)', demand_paise: 1250000, overdue: true, has_file: false })

    // Create (multipart, with a PDF) by the staff member on their own client
    const form = new FormData()
    form.set('client_id', mine.id)
    form.set('authority', 'mca')
    form.set('section', 'ADJ')
    form.set('notice_date', '2026-10-01')
    form.set('response_due_date', '2099-01-01')
    form.set('file', new Blob([Buffer.from('%PDF-1.4\n%fake\n')], { type: 'application/pdf' }), 'notice.pdf')
    const withFile = await api('/api/notices-register', { method: 'POST', cookie: staff.cookie, form })
    expect(withFile.status).toBe(201)
    expect(withFile.body.data).toMatchObject({ has_file: true, file_name: 'notice.pdf', overdue: false })
    const file = await api(`/api/notices-register/${withFile.body.data.id}/file`, { cookie: staff.cookie })
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toBe('application/pdf')
    expect(file.raw.subarray(0, 4).toString()).toBe('%PDF')
    // A file whose bytes do not match is refused
    const fake = new FormData()
    fake.set('client_id', mine.id); fake.set('authority', 'other'); fake.set('section', 'X'); fake.set('notice_date', '2026-10-01')
    fake.set('file', new Blob([Buffer.from('<html>not a pdf</html>')], { type: 'application/pdf' }), 'evil.pdf')
    expect((await api('/api/notices-register', { method: 'POST', cookie: md.cookie, form: fake })).status).toBe(422)

    // A GST notice on the same client merges in, read-only
    const gst = await prisma.gstNotice.create({ data: { organisationId: o.id, clientId: mine.id, kind: 'DRC01', status: 'review', referenceNo: 'ZD330926000001', noticeDate: '2026-09-20', totalDemand: 5000.5 } })
    const theirs = await api('/api/notices-register', { method: 'POST', cookie: md.cookie, body: { client_id: other.id, authority: 'income_tax', section: '148A(b)', notice_date: '2026-09-02' } })
    expect(theirs.status).toBe(201)

    const all = (await api('/api/notices-register', { cookie: md.cookie })).body.data as Row[]
    expect(all.map((r) => r.id)).toEqual(expect.arrayContaining([created.body.data.id, withFile.body.data.id, gst.id, theirs.body.data.id]))
    expect(all.find((r) => r.id === gst.id)).toMatchObject({ source: 'gst', authority: 'gst', read_only: true, section: 'DRC01', demand_paise: 500050, response_due_date: null, link: `/workstation/services/registration/gst/clients/${mine.id}` })
    expect(all[0].id).toBe(created.body.data.id) // overdue reply first
    expect(((await api('/api/notices-register?authority=gst', { cookie: md.cookie })).body.data as Row[]).every((r) => r.source === 'gst')).toBe(true)
    expect(((await api('/api/notices-register?overdue=1', { cookie: md.cookie })).body.data as Row[]).map((r) => r.id)).toContain(created.body.data.id)

    // Scoping
    const staffList = (await api('/api/notices-register', { cookie: staff.cookie })).body.data as Row[]
    expect(new Set(staffList.map((r) => r.client_id))).toEqual(new Set([mine.id]))
    expect((await api(`/api/notices-register?client_id=${other.id}`, { cookie: staff.cookie })).status).toBe(403)
    expect((await api(`/api/notices-register/${theirs.body.data.id}`, { method: 'PATCH', cookie: staff.cookie, body: { status: 'replied' } })).status).toBe(403)
    expect((await api(`/api/notices-register/${theirs.body.data.id}/file`, { cookie: staff.cookie })).status).toBe(403)

    // GstNotice deadline + owner; mine=1
    const g = await api(`/api/notices-register/gst/${gst.id}`, { method: 'PATCH', cookie: md.cookie, body: { response_due_date: '2026-11-30', assigned_employee_id: staffEmp.id } })
    expect(g.status).toBe(200)
    expect(g.body.data).toMatchObject({ response_due_date: '2026-11-30', assigned_employee_id: staffEmp.id })
    expect(await prisma.gstNotice.findUniqueOrThrow({ where: { id: gst.id } })).toMatchObject({ responseDueDate: '2026-11-30', assignedEmployeeId: staffEmp.id })
    expect(((await api('/api/notices-register?mine=1', { cookie: staff.cookie })).body.data as Row[]).map((r) => r.id)).toEqual([gst.id])
    expect((await api(`/api/notices-register/gst/${gst.id}`, { method: 'PATCH', cookie: md.cookie, body: { response_due_date: '30/11/2026' } })).status).toBe(400)

    // Status flow over HTTP. md sees every client with org-wide manage → a manager.
    const id = theirs.body.data.id
    expect((await api(`/api/notices-register/${id}`, { method: 'PATCH', cookie: md.cookie, body: { status: 'replied', reply_filed_on: '2026-09-10', reply_ack_no: 'ACK1' } })).body.data).toMatchObject({ status: 'replied', reply_ack_no: 'ACK1', overdue: false })
    expect((await api(`/api/notices-register/${id}`, { method: 'PATCH', cookie: md.cookie, body: { status: 'in_progress' } })).body.data.status).toBe('in_progress') // reopen by manager
    // Staff on their own client is its account manager → may reopen too; a non-manager may not.
    const sid = withFile.body.data.id
    await api(`/api/notices-register/${sid}`, { method: 'PATCH', cookie: staff.cookie, body: { status: 'hearing' } })
    expect((await api(`/api/notices-register/${sid}`, { method: 'PATCH', cookie: staff.cookie, body: { status: 'received' } })).status).toBe(200)
    await prisma.client.update({ where: { id: mine.id }, data: { accountManagerId: 'someone-else', secondaryManagerId: staffEmp.id } })
    await api(`/api/notices-register/${sid}`, { method: 'PATCH', cookie: staff.cookie, body: { status: 'order_received' } })
    const back = await api(`/api/notices-register/${sid}`, { method: 'PATCH', cookie: staff.cookie, body: { status: 'hearing' } })
    expect(back.status).toBe(422)
    expect(back.body.error.code).toBe('status_backwards')

    // Soft delete
    expect((await api(`/api/notices-register/${id}`, { method: 'DELETE', cookie: md.cookie })).status).toBe(204)
    expect(((await api('/api/notices-register', { cookie: md.cookie })).body.data as Row[]).map((r) => r.id)).not.toContain(id)
    expect(await prisma.clientNotice.findUnique({ where: { id } })).toMatchObject({ deletedAt: expect.any(Date) })
    expect(await prisma.auditLog.count({ where: { entityType: 'ClientNotice', entityId: id } })).toBeGreaterThanOrEqual(3)
  })
})

describe('notice reply reminders', () => {
  it('7 / 3 / 1 days before, once each, to the owner', async () => {
    expect([8, 7, 4, 3, 2, 1, 0, -1].map(noticeStage)).toEqual([null, 'd7', 'd7', 'd3', 'd3', 'd1', 'd1', null])
    const o = await org()
    const emp = await employee(o, 'Owner')
    const u = await login(o, 'employee', emp.id)
    const c = await client(o, 'Golf Pvt Ltd', { accountManagerId: emp.id })
    await prisma.clientNotice.create({ data: { organisationId: o.id, clientId: c.id, authority: 'income_tax', section: '142(1)', noticeDate: '2032-01-01', responseDueDate: '2032-01-20' } })
    await prisma.gstNotice.create({ data: { organisationId: o.id, clientId: c.id, kind: 'ASMT10', status: 'draft', responseDueDate: '2032-01-20', assignedEmployeeId: emp.id } })
    await prisma.clientNotice.create({ data: { organisationId: o.id, clientId: c.id, authority: 'mca', section: 'X', noticeDate: '2032-01-01', responseDueDate: '2032-01-20', status: 'replied' } })
    const keys = async () => (await prisma.notification.findMany({ where: { userId: u.id, entityType: 'notice_reminder' } })).map((n) => n.entityId!.split(':').at(-1)).sort()
    await sendNoticeReminders(prisma, '2032-01-13')
    await sendNoticeReminders(prisma, '2032-01-14')
    expect(await keys()).toEqual(['d7', 'd7'])
    await sendNoticeReminders(prisma, '2032-01-17')
    await sendNoticeReminders(prisma, '2032-01-19')
    await sendNoticeReminders(prisma, '2032-01-20')
    expect(await keys()).toEqual(['d1', 'd1', 'd3', 'd3', 'd7', 'd7'])
  })
})
