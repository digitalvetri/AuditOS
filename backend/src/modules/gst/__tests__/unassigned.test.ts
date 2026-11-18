import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { ensurePeriodJobs, syncGstEnrolment } from '../filing.js'
import { sendGstReminders } from '../reminders.js'

/**
 * Services are added UNASSIGNED (ClientService.assignedEmployeeId null).
 * GST Filing still enrols the client, with nobody on the profile; the GST
 * Filing page's Assign select (PATCH /api/gst/clients/:id) gives it a person,
 * who then sees the client. Until then its due alerts go to the Partner tier.
 */

let server: Server
let base = ''
let orgId = ''
let wsId = ''
let serviceId = ''
let roleId: Record<string, string> = {}
let mdCookie = ''

async function api(path: string, cookie: string, opts: { method?: string; body?: unknown } = {}) {
  const r = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const t = await r.text()
  const j = t ? JSON.parse(t) : null
  return { status: r.status, body: j && typeof j === 'object' && 'data' in j ? j.data : j, raw: t }
}

async function employee(name = 'Staff') {
  return prisma.employee.create({
    data: {
      organisationId: orgId, employeeCode: uid('UA'), firstName: name, lastName: 'X', fullName: uid(name),
      email: `${uid('u')}@x.local`, joiningDate: '2026-01-01', status: 'active', workScheduleId: wsId,
    },
  })
}

async function login(role: string) {
  const emp = await employee(role)
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: roleId[role], employeeId: emp.id } })
  return { emp, user: u, cookie: `ao_access=${signToken(u.id)}` }
}

/** A client on the GST Filing service with NO assignee, owned by nobody the tests log in as. */
async function unassignedClient(owner: string) {
  const code = uid('UG')
  const c = await prisma.client.create({
    data: {
      organisationId: orgId, clientCode: code, companyName: code, contactPerson: 'C', contactNumber: '9999999999',
      email: `${code.toLowerCase()}@client.test`, accountManagerId: owner, status: 'active', onboardingDate: '2026-01-01',
      gstin: '27AAPFU0939F1ZV',
    },
  })
  const cs = await prisma.clientService.create({ data: { clientId: c.id, serviceId, status: 'not_started' } })
  return { c, cs }
}

let ownerId = ''
beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const a = server.address()
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id
    ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.findFirst())?.id
    ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  serviceId = (await prisma.service.findFirst({ where: { code: 'GST_FILING' } }))?.id
    ?? (await prisma.service.create({ data: { organisationId: orgId, code: 'GST_FILING', name: 'GST Filing' } })).id
  // Another suite may have soft-deleted it; enrolment needs it alive.
  await prisma.service.update({ where: { id: serviceId }, data: { deletedAt: null } })
  if (!await prisma.documentCategory.findFirst({ where: { code: 'gst' } })) {
    await prisma.documentCategory.create({ data: { organisationId: orgId, code: 'gst', name: 'GST' } })
  }
  await setupRoles(prisma, { force: true })
  roleId = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.code, r.id]))
  mdCookie = (await login('md')).cookie
  ownerId = (await employee('Owner')).id
})
afterAll(() => server?.close())

describe('a GST Filing service with no assignee', () => {
  it('enrols with a null profile assignee; jobs, the board and the serializers cope', async () => {
    const { c } = await unassignedClient(ownerId)
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    expect(p).toMatchObject({ active: true, assignedEmployeeId: null })
    const { periodId } = await ensurePeriodJobs(prisma, p.id, '2026-09')
    expect(periodId).toBeTruthy()
    expect(await prisma.gstFiling.count({ where: { gstProfileId: p.id, period: '2026-09' } })).toBe(2)

    const board = await api('/api/gst/filing-board?period=2026-09', mdCookie)
    expect(board.status).toBe(200)
    const row = board.body.rows.find((x: { client_id: string }) => x.client_id === c.id)
    expect(row).toMatchObject({ gst_profile_id: p.id, assigned: null, profile_assigned: null })

    const services = await api(`/api/clients/${c.id}/services`, mdCookie)
    expect(services.status).toBe(200)
    expect(services.body.items[0]).toMatchObject({ assigned_employee_id: null, assigned_employee: null })
    const gst = await api(`/api/clients/${c.id}/gst`, mdCookie)
    expect(gst.status).toBe(200)
    expect(gst.body).toMatchObject({ assigned_employee_id: null, assigned_employee: null })
    expect(gst.body.filings.every((f: { assigned_employee_id: string | null }) => f.assigned_employee_id === null)).toBe(true)
    const list = await api('/api/gst/clients', mdCookie)
    expect(list.status).toBe(200)
    for (const r of [board, services, gst]) expect(r.raw).not.toContain('undefined')
  })

  it('re-sync never clears an existing profile assignee', async () => {
    const senior = await employee('Senior')
    // 1. Assigned by hand on the profile while the service has nobody.
    const a = await unassignedClient(ownerId)
    await syncGstEnrolment(prisma, { clientId: a.c.id })
    const pa = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: a.c.id } })
    expect((await api(`/api/gst/clients/${pa.id}`, mdCookie, { method: 'PATCH', body: { assigned_employee_id: senior.id } })).status).toBe(200)
    await syncGstEnrolment(prisma, { clientId: a.c.id })
    expect((await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: a.c.id } })).assignedEmployeeId).toBe(senior.id)

    // 2. The service had an assignee, then lost it: the profile keeps them.
    const b = await unassignedClient(ownerId)
    await prisma.clientService.update({ where: { id: b.cs.id }, data: { assignedEmployeeId: senior.id } })
    await syncGstEnrolment(prisma, { clientId: b.c.id })
    expect((await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: b.c.id } })).assignedEmployeeId).toBe(senior.id)
    await prisma.clientService.update({ where: { id: b.cs.id }, data: { assignedEmployeeId: null } })
    await syncGstEnrolment(prisma, { clientId: b.c.id })
    await syncGstEnrolment(prisma, { clientId: b.c.id })
    expect((await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: b.c.id } })).assignedEmployeeId).toBe(senior.id)
  })
})

describe('Assign on the GST Filing page (PATCH /api/gst/clients/:id)', () => {
  it('sets the assignee, fills the open period, and the Associate then sees the client', async () => {
    const assoc = await login('employee')
    const { c } = await unassignedClient(ownerId)
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    const { periodId } = await ensurePeriodJobs(prisma, p.id, '2026-09')

    // Before: the Associate has no link to the client.
    expect((await api(`/api/clients/${c.id}`, assoc.cookie)).status).toBe(403)
    expect(JSON.stringify((await api('/api/clients?page_size=100', assoc.cookie)).body)).not.toContain(c.id)

    // An Associate cannot assign (no workstation.gst.manage on a client they don't see).
    expect((await api(`/api/gst/clients/${p.id}`, assoc.cookie, { method: 'PATCH', body: { assigned_employee_id: assoc.emp.id } })).status).not.toBe(200)

    const r = await api(`/api/gst/clients/${p.id}`, mdCookie, { method: 'PATCH', body: { assigned_employee_id: assoc.emp.id } })
    expect(r.status).toBe(200)
    expect((await prisma.gstProfile.findUniqueOrThrow({ where: { id: p.id } })).assignedEmployeeId).toBe(assoc.emp.id)
    expect((await prisma.gstCompliancePeriod.findUniqueOrThrow({ where: { id: periodId! } })).assignedEmployeeId).toBe(assoc.emp.id)
    expect(await prisma.gstFiling.count({ where: { gstProfileId: p.id, assignedEmployeeId: assoc.emp.id } })).toBe(2)

    expect((await api(`/api/clients/${c.id}`, assoc.cookie)).status).toBe(200)
    expect(JSON.stringify((await api('/api/clients?page_size=100', assoc.cookie)).body)).toContain(c.id)
    const board = await api('/api/gst/filing-board?period=2026-09', mdCookie)
    const row = board.body.rows.find((x: { client_id: string }) => x.client_id === c.id)
    expect(row.profile_assigned).toMatchObject({ id: assoc.emp.id })

    // "Unassigned" is allowed, and the Associate loses the client again.
    expect((await api(`/api/gst/clients/${p.id}`, mdCookie, { method: 'PATCH', body: { assigned_employee_id: null } })).status).toBe(200)
    expect((await prisma.gstProfile.findUniqueOrThrow({ where: { id: p.id } })).assignedEmployeeId).toBeNull()
    expect((await api(`/api/clients/${c.id}`, assoc.cookie)).status).toBe(403)
  })

  it('never overwrites a period someone assigned by hand', async () => {
    const assoc = await employee('Assoc')
    const handPicked = await employee('Hand')
    const { c } = await unassignedClient(ownerId)
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    const { periodId } = await ensurePeriodJobs(prisma, p.id, '2026-08')
    await prisma.gstCompliancePeriod.update({ where: { id: periodId! }, data: { assignedEmployeeId: handPicked.id } })
    expect((await api(`/api/gst/clients/${p.id}`, mdCookie, { method: 'PATCH', body: { assigned_employee_id: assoc.id } })).status).toBe(200)
    expect((await prisma.gstCompliancePeriod.findUniqueOrThrow({ where: { id: periodId! } })).assignedEmployeeId).toBe(handPicked.id)
  })
})

describe('due alerts on an unassigned GST client go to the Partner tier', () => {
  it('md and hr_admin get the overdue bell; an Associate does not', async () => {
    const md = await login('md')
    const admin = await login('hr_admin')
    const assoc = await login('employee')
    const { c } = await unassignedClient(ownerId)
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    await ensurePeriodJobs(prisma, p.id, '2026-09')
    await sendGstReminders(prisma, { today: '2026-10-12' })
    const key = `gst:${c.id}:GSTR1:2026-09:overdue`
    for (const u of [md.user, admin.user]) {
      const n = await prisma.notification.findFirst({ where: { userId: u.id, entityType: 'gst_reminder', entityId: key } })
      expect(n).toBeTruthy()
      expect(n!.body).not.toContain('undefined')
      expect(n!.body).toMatch(/Nobody is assigned/)
    }
    expect(await prisma.notification.count({ where: { userId: assoc.user.id, entityId: key } })).toBe(0)
    // Deduped: a second tick adds nothing.
    await sendGstReminders(prisma, { today: '2026-10-12' })
    expect(await prisma.notification.count({ where: { userId: md.user.id, entityId: key } })).toBe(1)
  })
})

describe('changing who does a client\'s GST work is a manager action', () => {
  it('an Associate who can see the client may edit GST facts but not the assignee or reviewer', async () => {
    const assoc = await login('employee')
    const senior = await employee('Senior')
    // The Associate manages the client, so they see it (this is a 403, not a 404).
    const { c } = await unassignedClient(assoc.emp.id)
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    expect((await api(`/api/clients/${c.id}`, assoc.cookie)).status).toBe(200)

    const assign = await api(`/api/gst/clients/${p.id}`, assoc.cookie, { method: 'PATCH', body: { assigned_employee_id: assoc.emp.id } })
    expect(assign.status).toBe(403)
    const review = await api(`/api/gst/clients/${p.id}`, assoc.cookie, { method: 'PATCH', body: { reviewer_employee_id: senior.id } })
    expect(review.status).toBe(403)
    expect(await prisma.gstProfile.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ assignedEmployeeId: null, reviewerEmployeeId: null })

    // Other GST facts are still theirs to edit, and resending the current
    // (null) assignee with a whole-form save is not a change.
    const facts = await api(`/api/gst/clients/${p.id}`, assoc.cookie, {
      method: 'PATCH', body: { contact_person: 'Ravi', assigned_employee_id: null, reviewer_employee_id: '' },
    })
    expect(facts.status, facts.raw).toBe(200)
    expect((await prisma.gstProfile.findUniqueOrThrow({ where: { id: p.id } })).contactPerson).toBe('Ravi')

    // The Partner tier may change it.
    const r = await api(`/api/gst/clients/${p.id}`, mdCookie, { method: 'PATCH', body: { assigned_employee_id: senior.id, reviewer_employee_id: senior.id } })
    expect(r.status).toBe(200)
    // ...after which the Associate resending that same assignee is fine, changing it is not.
    expect((await api(`/api/gst/clients/${p.id}`, assoc.cookie, { method: 'PATCH', body: { assigned_employee_id: senior.id } })).status).toBe(200)
    expect((await api(`/api/gst/clients/${p.id}`, assoc.cookie, { method: 'PATCH', body: { assigned_employee_id: null } })).status).toBe(403)
    expect((await prisma.gstProfile.findUniqueOrThrow({ where: { id: p.id } })).assignedEmployeeId).toBe(senior.id)

    const deptManager = await login('dept_manager')
    expect((await api(`/api/gst/clients/${p.id}`, deptManager.cookie, { method: 'PATCH', body: { assigned_employee_id: null } })).status).toBe(200)
  })
})
