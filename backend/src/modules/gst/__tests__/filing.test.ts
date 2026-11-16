import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { istToday } from '../../../lib/dates.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { dataReminderBody, ensurePeriodJobs, generateGstFilingJobs, markDataFromPortal, previousPeriod, refreshClientGst, syncGstEnrolment } from '../filing.js'
import { assertGstr1Transition, assertGstr3bTransition, toPaise } from '../validate.js'
import { computeUpcoming, sendGstReminders } from '../reminders.js'
import { gstRows } from '../../compliance/merge.js'

let orgId = ''
let serviceId = ''
let empId = ''

beforeAll(async () => {
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id
    ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'GST filing firm' } })).id
  serviceId = (await prisma.service.findFirst({ where: { code: 'GST_FILING' } }))?.id
    ?? (await prisma.service.create({ data: { organisationId: orgId, code: 'GST_FILING', name: 'GST Filing' } })).id
  const ws = (await prisma.workSchedule.findFirst())?.id
    ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  empId = (await prisma.employee.create({
    data: { organisationId: orgId, employeeCode: uid('E'), firstName: 'Gst', lastName: 'Staff', fullName: uid('Gst Staff'), email: `${uid('g')}@x.local`, joiningDate: '2026-01-01', workScheduleId: ws },
  })).id
  if (!await prisma.documentCategory.findFirst({ where: { code: 'gst' } })) {
    await prisma.documentCategory.create({ data: { organisationId: orgId, code: 'gst', name: 'GST' } })
  }
})

/** A client, optionally with the GST Filing service. */
export async function gstClient(opts: { gstin?: string | null; withService?: boolean; serviceStatus?: string; frequency?: 'monthly' | 'quarterly' } = {}) {
  const code = uid('GF')
  const client = await prisma.client.create({
    data: {
      organisationId: orgId, clientCode: code, companyName: code, contactPerson: 'C', contactNumber: '9999999999',
      email: `${code.toLowerCase()}@client.test`, accountManagerId: empId, status: 'active', onboardingDate: '2026-01-01',
      gstin: opts.gstin === undefined ? '27AAPFU0939F1ZV' : opts.gstin,
    },
  })
  if (opts.withService !== false) {
    await prisma.clientService.create({
      data: { clientId: client.id, serviceId, assignedEmployeeId: empId, status: opts.serviceStatus ?? 'not_started' },
    })
  }
  if (opts.frequency === 'quarterly') {
    await syncGstEnrolment(prisma, { clientId: client.id })
    await prisma.gstProfile.update({ where: { clientId: client.id }, data: { filingFrequency: 'quarterly' } })
  }
  return client
}

/** This month: its GSTR-1 falls due on the 11th of next month, always after today. */
const futurePeriod = () => istToday().slice(0, 7)
const futureName = () => `GST data — ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(futurePeriod().slice(5, 7)) - 1]} ${futurePeriod().slice(0, 4)}`

describe('previousPeriod', () => {
  it('is the month before, across a year boundary', () => {
    expect(previousPeriod('2026-11-16')).toBe('2026-10')
    expect(previousPeriod('2027-01-01')).toBe('2026-12')
  })
})

describe('syncGstEnrolment', () => {
  it('enrols a GST Filing client with a GSTIN, assigned to the service staff', async () => {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    expect(p).toMatchObject({ gstin: '27AAPFU0939F1ZV', assignedEmployeeId: empId, active: true, filingFrequency: 'monthly' })
  })
  it('does not enrol without a GSTIN, without the service, or when on hold', async () => {
    const a = await gstClient({ gstin: null })
    const b = await gstClient({ withService: false })
    const h = await gstClient({ serviceStatus: 'on_hold' })
    for (const c of [a, b, h]) await syncGstEnrolment(prisma, { clientId: c.id })
    expect(await prisma.gstProfile.count({ where: { clientId: { in: [a.id, b.id, h.id] } } })).toBe(0)
  })
  it('deactivates the profile when the service is removed, and keeps past periods', async () => {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    await ensurePeriodJobs(prisma, p.id, '2026-09')
    await prisma.clientService.updateMany({ where: { clientId: c.id }, data: { deletedAt: new Date() } })
    await syncGstEnrolment(prisma, { clientId: c.id })
    expect((await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })).active).toBe(false)
    expect(await prisma.gstCompliancePeriod.count({ where: { gstProfileId: p.id } })).toBe(1)
  })
  it('deactivates when the service goes on hold', async () => {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    await prisma.clientService.updateMany({ where: { clientId: c.id }, data: { status: 'on_hold' } })
    await syncGstEnrolment(prisma, { clientId: c.id })
    expect((await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })).active).toBe(false)
  })
  it('deactivates when the client GSTIN is cleared', async () => {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    await prisma.client.update({ where: { id: c.id }, data: { gstin: null } })
    await syncGstEnrolment(prisma, { clientId: c.id })
    expect((await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })).active).toBe(false)
  })
  it('reactivates with the new service assignee', async () => {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    await prisma.clientService.updateMany({ where: { clientId: c.id }, data: { deletedAt: new Date() } })
    await syncGstEnrolment(prisma, { clientId: c.id })
    const ws = (await prisma.workSchedule.findFirstOrThrow()).id
    const other = await prisma.employee.create({
      data: { organisationId: orgId, employeeCode: uid('E'), firstName: 'Gst', lastName: 'Other', fullName: uid('Gst Other'), email: `${uid('g')}@x.local`, joiningDate: '2026-01-01', workScheduleId: ws },
    })
    await prisma.clientService.create({ data: { clientId: c.id, serviceId, assignedEmployeeId: other.id, status: 'not_started' } })
    await syncGstEnrolment(prisma, { clientId: c.id })
    expect(await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })).toMatchObject({ active: true, assignedEmployeeId: other.id })
  })
  it('takes the assignee from the newest active service row', async () => {
    const ws = (await prisma.workSchedule.findFirstOrThrow()).id
    const mk = async (n: string) => (await prisma.employee.create({
      data: { organisationId: orgId, employeeCode: uid('E'), firstName: 'Gst', lastName: n, fullName: uid(`Gst ${n}`), email: `${uid('g')}@x.local`, joiningDate: '2026-01-01', workScheduleId: ws },
    })).id
    const [older, newer, done] = [await mk('Older'), await mk('Newer'), await mk('Done')]
    const c = await gstClient({ withService: false })
    await prisma.clientService.create({ data: { clientId: c.id, serviceId, assignedEmployeeId: older, status: 'not_started', createdAt: new Date('2026-01-01T00:00:00Z') } })
    await prisma.clientService.create({ data: { clientId: c.id, serviceId, assignedEmployeeId: newer, status: 'in_progress', createdAt: new Date('2026-02-01T00:00:00Z') } })
    await prisma.clientService.create({ data: { clientId: c.id, serviceId, assignedEmployeeId: done, status: 'completed', createdAt: new Date('2026-03-01T00:00:00Z') } })
    await syncGstEnrolment(prisma, { clientId: c.id })
    expect((await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })).assignedEmployeeId).toBe(newer)
  })
  it('leaves a hand-added GST profile alone when the client has no GST Filing service', async () => {
    const c = await gstClient({ withService: false })
    await prisma.gstProfile.create({ data: { clientId: c.id, gstin: '27AAPFU0939F1ZV', assignedEmployeeId: empId, active: true } })
    await syncGstEnrolment(prisma, { clientId: c.id })
    await syncGstEnrolment(prisma)
    expect((await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })).active).toBe(true)
  })
  it('does not mass-deactivate when the GST_FILING service is soft-deleted', async () => {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    await prisma.service.update({ where: { id: serviceId }, data: { deletedAt: new Date() } })
    try {
      expect(await syncGstEnrolment(prisma)).toEqual({ enrolled: 0, deactivated: 0 })
      expect((await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })).active).toBe(true)
    } finally {
      await prisma.service.update({ where: { id: serviceId }, data: { deletedAt: null } })
    }
  })
})

describe('ensurePeriodJobs / generateGstFilingJobs', () => {
  it('creates one GSTR-1 and one GSTR-3B with due dates, and is idempotent', async () => {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    const first = await ensurePeriodJobs(prisma, p.id, '2026-10')
    const again = await ensurePeriodJobs(prisma, p.id, '2026-10')
    expect(first.created).toBe(2)
    expect(again.created).toBe(0)
    const filings = await prisma.gstFiling.findMany({ where: { gstProfileId: p.id, period: '2026-10' }, orderBy: { returnType: 'asc' } })
    expect(filings.map((f) => [f.returnType, f.status])).toEqual([['GSTR-1', 'pending'], ['GSTR-3B', 'pending']])
    expect(filings.every((f) => f.dueDate?.startsWith('2026-11-'))).toBe(true)
    const period = await prisma.gstCompliancePeriod.findUniqueOrThrow({ where: { id: first.periodId! } })
    expect(period.dataStatus).toBe('pending')
  })
  it('opens a portal data request for a period whose GSTR-1 is still to come', async () => {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    const { periodId } = await ensurePeriodJobs(prisma, p.id, futurePeriod())
    const period = await prisma.gstCompliancePeriod.findUniqueOrThrow({ where: { id: periodId! } })
    const doc = await prisma.clientDocument.findUniqueOrThrow({ where: { id: period.dataRequestDocId! } })
    expect(doc).toMatchObject({ clientId: c.id, status: 'requested', name: futureName() })
  })
  it('opens no data request once the period\'s GSTR-1 due date has passed', async () => {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    const { periodId } = await ensurePeriodJobs(prisma, p.id, '2026-01')
    expect((await prisma.gstCompliancePeriod.findUniqueOrThrow({ where: { id: periodId! } })).dataRequestDocId).toBeNull()
    expect(await prisma.clientDocument.count({ where: { clientId: c.id } })).toBe(0)
  })
  it('gives a quarterly filer jobs only for a quarter-end month', async () => {
    const c = await gstClient({ frequency: 'quarterly' })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    expect((await ensurePeriodJobs(prisma, p.id, '2026-10')).created).toBe(0)
    expect((await ensurePeriodJobs(prisma, p.id, '2026-09')).created).toBe(2)
  })
  it('gives a composition dealer nothing', async () => {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.update({ where: { clientId: c.id }, data: { registrationType: 'composition' } })
    expect((await ensurePeriodJobs(prisma, p.id, '2026-10')).created).toBe(0)
  })
  it('creates exactly one data-request document across repeated runs', async () => {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    await ensurePeriodJobs(prisma, p.id, futurePeriod())
    await ensurePeriodJobs(prisma, p.id, futurePeriod())
    expect(await prisma.clientDocument.count({ where: { clientId: c.id, name: futureName() } })).toBe(1)
  })
  it('refreshClientGst enrols the client and creates last month\'s two filings', async () => {
    const c = await gstClient()
    await refreshClientGst(prisma, c.id, null)
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    expect(p.active).toBe(true)
    expect(await prisma.gstFiling.count({ where: { gstProfileId: p.id, period: previousPeriod(istToday()) } })).toBe(2)
  })
  it('the daily run enrols and generates last month for every GST Filing client', async () => {
    const c = await gstClient()
    const r = await generateGstFilingJobs(prisma, '2026-11-01')
    expect(r.filings).toBeGreaterThanOrEqual(2)
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    expect(await prisma.gstFiling.count({ where: { gstProfileId: p.id, period: '2026-10' } })).toBe(2)
  })
})

let server: Server
let base = ''
let cookie = ''
export async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const r = await fetch(`${base}${path}`, { method: opts.method ?? 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined })
  const t = await r.text()
  const j = t ? JSON.parse(t) : null
  return { status: r.status, body: j && typeof j === 'object' && 'data' in j ? j.data : j }
}
beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const a = server.address()
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
  await setupRoles(prisma, { force: true })
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'md' } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: `${uid('md')}@x.local`, passwordHash: 'x', roleId: role.id, employeeId: empId } })
  cookie = `ao_access=${signToken(u.id)}`
})
afterAll(() => server?.close())

describe('adding the GST Filing service through the API', () => {
  it('enrols the client and opens last month at once', async () => {
    const c = await gstClient({ withService: false })
    const r = await api(`/api/clients/${c.id}/services`, { method: 'POST', body: { service_id: serviceId, assigned_employee_id: empId } })
    expect(r.status).toBe(201)
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    expect(await prisma.gstFiling.count({ where: { gstProfileId: p.id } })).toBe(2)
  })
})

describe('Start → Finish', () => {
  it('records a return as filed straight from preparation', () => {
    expect(() => assertGstr1Transition('in_preparation', 'filed')).not.toThrow()
    expect(() => assertGstr3bTransition('preparation', 'filed')).not.toThrow()
  })
  it('lets a legacy 3B in data preparation be filed', () => {
    expect(() => assertGstr3bTransition('data_preparation', 'filed')).not.toThrow()
    expect(() => assertGstr3bTransition('in_preparation', 'filed')).not.toThrow()
  })
  it('reads Indian-format amounts', () => {
    expect(toPaise('1,50,000.50', 'x')).toBe(15000050n)
    expect(toPaise(' 1 200 ', 'x')).toBe(120000n)
  })
  it('still refuses filing a return nobody started', () => {
    expect(() => assertGstr1Transition('pending', 'filed')).toThrow()
    expect(() => assertGstr3bTransition('pending', 'filed')).toThrow()
  })
})

describe('data received', () => {
  async function openPeriod() {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    const { periodId } = await ensurePeriodJobs(prisma, p.id, futurePeriod())
    return prisma.gstCompliancePeriod.findUniqueOrThrow({ where: { id: periodId! } })
  }
  it('staff tick and untick', async () => {
    const period = await openPeriod()
    expect((await api(`/api/gst/periods/${period.id}/data`, { method: 'POST', body: { received: true } })).status).toBe(200)
    expect(await prisma.gstCompliancePeriod.findUniqueOrThrow({ where: { id: period.id } })).toMatchObject({ dataStatus: 'received' })
    await api(`/api/gst/periods/${period.id}/data`, { method: 'POST', body: { received: false } })
    expect(await prisma.gstCompliancePeriod.findUniqueOrThrow({ where: { id: period.id } })).toMatchObject({ dataStatus: 'pending', dataReceivedAt: null })
  })
  it('a portal upload to the request marks it received', async () => {
    const period = await openPeriod()
    expect(await markDataFromPortal(prisma, period.dataRequestDocId!)).toBe(true)
    expect(await prisma.gstCompliancePeriod.findUniqueOrThrow({ where: { id: period.id } })).toMatchObject({ dataStatus: 'received', dataReceivedBy: 'portal' })
    expect(await markDataFromPortal(prisma, 'not-a-gst-request')).toBe(false)
  })
  it('ticking received withdraws the untouched portal request; unticking restores it', async () => {
    const period = await openPeriod()
    const doc = () => prisma.clientDocument.findUniqueOrThrow({ where: { id: period.dataRequestDocId! } })
    await api(`/api/gst/periods/${period.id}/data`, { method: 'POST', body: { received: true } })
    expect((await doc()).deletedAt).not.toBeNull()
    await api(`/api/gst/periods/${period.id}/data`, { method: 'POST', body: { received: false } })
    expect((await doc()).deletedAt).toBeNull()
  })
  it('never touches a request the client already uploaded to', async () => {
    const period = await openPeriod()
    await prisma.clientDocument.update({ where: { id: period.dataRequestDocId! }, data: { currentVersion: 1, status: 'uploaded' } })
    await api(`/api/gst/periods/${period.id}/data`, { method: 'POST', body: { received: true } })
    expect((await prisma.clientDocument.findUniqueOrThrow({ where: { id: period.dataRequestDocId! } })).deletedAt).toBeNull()
  })
  it('does not restore a request someone else deleted', async () => {
    const period = await openPeriod()
    await prisma.clientDocument.update({ where: { id: period.dataRequestDocId! }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } })
    await api(`/api/gst/periods/${period.id}/data`, { method: 'POST', body: { received: true } })
    await api(`/api/gst/periods/${period.id}/data`, { method: 'POST', body: { received: false } })
    expect((await prisma.clientDocument.findUniqueOrThrow({ where: { id: period.dataRequestDocId! } })).deletedAt).not.toBeNull()
  })
  it('remind refuses an empty list', async () => {
    expect((await api('/api/gst/filing/remind', { method: 'POST', body: { period_ids: [] } })).status).toBe(400)
  })
  it('remind takes at most 50 clients at a time', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `p${i}`)
    const r = await api('/api/gst/filing/remind', { method: 'POST', body: { period_ids: ids } })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toContain('between 1 and 50')
  })
})

describe('dataReminderBody', () => {
  it('writes the due date for people and signs off with the firm', () => {
    const { body } = dataReminderBody('Acme', '2026-10', '2026-11-11', null, 'Kumar & Co')
    expect(body).toContain('GSTR-1 is due on 11 Nov 2026')
    expect(body.trimEnd().endsWith('\u2014 Kumar & Co')).toBe(true)
    expect(dataReminderBody('Acme', '2026-10', null, null).body.trimEnd().endsWith('Thank you.')).toBe(true)
  })
  it('without a portal link asks the client to reply, with no relative path', () => {
    const { body } = dataReminderBody('Acme', '2026-10', null, null)
    expect(body).toContain('reply to this email')
    expect(body).not.toContain('/portal/')
  })
})

describe('GET /api/gst/filing-board', () => {
  it('lists enrolled clients with their two jobs and Needs setup clients', async () => {
    const c = await gstClient()
    const bare = await gstClient({ gstin: null })
    const blank = await gstClient({ gstin: '' })
    await generateGstFilingJobs(prisma, '2026-11-05')
    const r = await api('/api/gst/filing-board?period=2026-10')
    expect(r.status).toBe(200)
    const row = r.body.rows.find((x: any) => x.client_id === c.id)
    expect(row).toMatchObject({ data_status: 'pending', gstr1: { status: 'pending' }, gstr3b: { status: 'pending' } })
    expect(r.body.needs_setup.some((x: any) => x.client_id === bare.id)).toBe(true)
    expect(r.body.needs_setup.some((x: any) => x.client_id === blank.id)).toBe(true)
    expect(r.body.tiles.clients).toBeGreaterThanOrEqual(1)
  })
  it('drops a client that left the GST Filing service', async () => {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    await ensurePeriodJobs(prisma, p.id, '2026-10')
    expect((await api('/api/gst/filing-board?period=2026-10')).body.rows.some((x: any) => x.client_id === c.id)).toBe(true)
    await prisma.clientService.updateMany({ where: { clientId: c.id }, data: { deletedAt: new Date() } })
    await syncGstEnrolment(prisma, { clientId: c.id })
    expect((await api('/api/gst/filing-board?period=2026-10')).body.rows.some((x: any) => x.client_id === c.id)).toBe(false)
  })
  it('counts the period\'s GSTR-1/3B returns for the sidebar card: filed, total and overdue', async () => {
    const period = '2025-05'
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    await ensurePeriodJobs(prisma, p.id, period)
    const derived = (b: any) => {
      const cells = b.rows.flatMap((r: any) => [r.gstr1, r.gstr3b]).filter(Boolean)
      return {
        total: cells.length,
        filed: cells.filter((x: any) => ['filed', 'payment_pending', 'completed'].includes(x.status)).length,
        overdue: cells.filter((x: any) => x.overdue).length,
      }
    }
    const before = (await api(`/api/gst/filing-board?period=${period}`)).body
    expect(before.tiles.returns).toEqual(derived(before))
    // Filed with the payment still due counts as filed; the GSTR-1 stays open and late.
    await prisma.gstFiling.updateMany({ where: { gstProfileId: p.id, period, returnType: 'GSTR-3B' }, data: { status: 'payment_pending', arn: 'AA1' } })
    const after = (await api(`/api/gst/filing-board?period=${period}`)).body
    expect(after.tiles.returns).toEqual(derived(after))
    expect(after.tiles.returns.total).toBe(before.tiles.returns.total)
    expect(after.tiles.returns.filed).toBe(before.tiles.returns.filed + 1)
    expect(after.tiles.returns.overdue).toBe(before.tiles.returns.overdue - 1)
  })
})

describe('POST /api/gst/periods/:id/payment — record a GSTR-3B payment later', () => {
  async function filed3b(data: Record<string, unknown>) {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    const { periodId } = await ensurePeriodJobs(prisma, p.id, '2026-09')
    await prisma.gstFiling.updateMany({ where: { gstProfileId: p.id, period: '2026-09', returnType: 'GSTR-3B' }, data: { arn: 'AA9', ...data } })
    const read = () => prisma.gstFiling.findFirstOrThrow({ where: { gstProfileId: p.id, period: '2026-09', returnType: 'GSTR-3B' } })
    return { periodId: periodId!, read }
  }
  it('a 3B filed with payment due becomes completed, with the date and challan', async () => {
    const f = await filed3b({ status: 'filed', paymentStatus: 'pending' })
    const r = await api(`/api/gst/periods/${f.periodId}/payment`, { method: 'POST', body: { payment_date: '2026-10-22', challan_ref: 'CIN123' } })
    expect(r.status).toBe(200)
    expect(await f.read()).toMatchObject({ status: 'completed', paymentStatus: 'completed', paymentDate: '2026-10-22', challanRef: 'CIN123' })
  })
  it('accepts a 3B in payment_pending status too (the board shows it as payment due)', async () => {
    const f = await filed3b({ status: 'payment_pending', paymentStatus: 'not_applicable' })
    const r = await api(`/api/gst/periods/${f.periodId}/payment`, { method: 'POST', body: { payment_date: '2026-10-22' } })
    expect(r.status).toBe(200)
    expect(await f.read()).toMatchObject({ status: 'completed', paymentStatus: 'completed', challanRef: null })
  })
  it('needs a payment date, and a filed 3B', async () => {
    const f = await filed3b({ status: 'filed', paymentStatus: 'pending' })
    expect((await api(`/api/gst/periods/${f.periodId}/payment`, { method: 'POST', body: {} })).status).toBe(400)
    const open = await filed3b({ status: 'preparation', paymentStatus: 'not_applicable' })
    expect((await api(`/api/gst/periods/${open.periodId}/payment`, { method: 'POST', body: { payment_date: '2026-10-22' } })).status).toBe(400)
  })
})

describe('bell reminders and compliance calendar follow GST Filing', () => {
  async function enrolled(period = '2026-09') {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    const { periodId } = await ensurePeriodJobs(prisma, p.id, period)
    return { c, p, periodId: periodId! }
  }
  it('a filed GSTR-1 produces no reminder; an unfiled overdue one still does; no GSTR-2B without a 2B record', async () => {
    const filed = await enrolled()
    const open = await enrolled()
    await prisma.gstFiling.updateMany({ where: { gstProfileId: filed.p.id, period: '2026-09', returnType: 'GSTR-1' }, data: { status: 'filed', arn: 'AA1' } })
    const items = await computeUpcoming(prisma, { today: '2026-10-12', clientIdFilter: [filed.c.id, open.c.id] })
    expect(items.filter((i) => i.clientId === filed.c.id)).toEqual([])
    expect(items.filter((i) => i.clientId === open.c.id).map((i) => `${i.kind}:${i.period}:${i.state}`)).toEqual(['GSTR1:2026-09:overdue'])
  })
  it('GSTR-2B is reminded only while its 2B record is still open', async () => {
    const a = await enrolled()
    await prisma.gstR2BRecord.create({ data: { compliancePeriodId: a.periodId, status: 'pending' } })
    const kinds = async () => (await computeUpcoming(prisma, { today: '2026-10-17', clientIdFilter: [a.c.id] })).map((i) => i.kind)
    expect(await kinds()).toContain('GSTR2B')
    await prisma.gstR2BRecord.update({ where: { compliancePeriodId: a.periodId }, data: { status: 'reconciliation_completed' } })
    expect(await kinds()).not.toContain('GSTR2B')
  })
  it('the bell links to Services → GST Filing', async () => {
    const a = await enrolled()
    await sendGstReminders(prisma, { today: '2026-10-12' })
    const u = await prisma.user.findFirst({ where: { employeeId: empId } })
    const n = await prisma.notification.findFirst({ where: { userId: u!.id, entityId: `gst:${a.c.id}:GSTR1:2026-09:overdue` } })
    expect(n?.actionUrl).toBe('/workstation/services/gst-filing')
  })
  it('the compliance calendar shows a filed GSTR-1 as filed and drops an untracked GSTR-2B', async () => {
    const a = await enrolled()
    await prisma.gstFiling.updateMany({ where: { gstProfileId: a.p.id, period: '2026-09', returnType: 'GSTR-1' }, data: { status: 'completed', arn: 'AA1' } })
    const rows = await gstRows(prisma, { clientIds: [a.c.id], organisationId: orgId, from: '2026-10-01', to: '2026-10-31', today: '2026-10-12', employees: new Map() })
    expect(rows.find((r) => r.form_code === 'GSTR1' && r.period_key === '2026-09')).toMatchObject({ status: 'filed', overdue: false })
    expect(rows.find((r) => r.form_code === 'GSTR3B' && r.period_key === '2026-09')).toMatchObject({ status: 'not_started' })
    expect(rows.some((r) => r.form_code === 'GSTR2B')).toBe(false)
  })
})
