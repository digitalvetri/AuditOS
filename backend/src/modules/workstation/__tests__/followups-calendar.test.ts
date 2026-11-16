import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { addDays, istToday } from '../../../lib/dates.js'
import { sendFollowUpReminders } from '../followupReminders.js'
import { startHarness, type Harness, type Staff } from './ws-harness.js'

/**
 * Follow-ups:
 *  - the reminder fires once, `reminder_minutes_before` ahead, to the assignee;
 *  - a pending follow-up whose day has passed is marked missed (and still
 *    counts as overdue);
 *  - the assignee can complete a follow-up assigned to them on a client they
 *    are not otherwise on — but cannot reassign it;
 *  - reminder minutes are 0–10080.
 * Calendar: follow-ups, task due dates and compliance due dates for the
 * clients the caller can see, within a date range.
 */
let h: Harness
let md: Staff
let priya: Staff // owns the client
let arun: Staff // assigned the follow-up only
let clientId = ''
let otherClientId = ''

const followUp = (extra: Record<string, unknown>) => prisma.followUp.create({
  data: {
    organisationId: h.orgId, clientId, title: uid('FU'), type: 'call', assignedEmployeeId: arun.emp.id,
    scheduledAt: new Date(Date.now() + 3600_000), status: 'pending', reminderMinutesBefore: 30, ...extra,
  },
})

beforeAll(async () => {
  h = await startHarness()
  md = await h.staff('md')
  priya = await h.staff('employee')
  arun = await h.staff('employee')
  clientId = (await h.client(priya.emp.id)).id
  otherClientId = (await h.client(md.emp.id)).id
})
afterAll(() => h?.close())

describe('reminders and missed', () => {
  it('reminds the assignee once inside the reminder window, and not before', async () => {
    const now = new Date()
    const soon = await followUp({ scheduledAt: new Date(now.getTime() + 20 * 60_000), reminderMinutesBefore: 30 })
    const later = await followUp({ scheduledAt: new Date(now.getTime() + 120 * 60_000), reminderMinutesBefore: 30 })
    const none = await followUp({ scheduledAt: new Date(now.getTime() + 10 * 60_000), reminderMinutesBefore: null })
    await sendFollowUpReminders(prisma, now)
    await sendFollowUpReminders(prisma, now)
    const notes = await prisma.notification.findMany({ where: { userId: arun.userId, type: 'followup.reminder' } })
    const about = (id: string) => notes.filter((n) => (n.entityId ?? '').includes(id)).length
    expect(about(soon.id)).toBe(1)
    expect(about(later.id)).toBe(0)
    expect(about(none.id)).toBe(0)
  })

  it('marks a pending follow-up missed once its day is over, and it still shows as overdue', async () => {
    const past = await followUp({ scheduledAt: new Date(`${addDays(istToday(), -2)}T05:00:00Z`) })
    const earlierToday = await followUp({ scheduledAt: new Date(Date.now() - 60_000) })
    await sendFollowUpReminders(prisma, new Date())
    expect((await prisma.followUp.findUniqueOrThrow({ where: { id: past.id } })).status).toBe('missed')
    expect((await prisma.followUp.findUniqueOrThrow({ where: { id: earlierToday.id } })).status).toBe('pending')
    const overdue = await h.api('/api/follow-ups?range=overdue', arun.cookie)
    expect(overdue.body.items.map((i: any) => i.id)).toEqual(expect.arrayContaining([past.id, earlierToday.id]))
  })
})

describe('the assignee', () => {
  it('can complete and update a follow-up assigned to them on a client they are not on, but not reassign it', async () => {
    const f = await followUp({})
    expect((await h.api(`/api/clients/${clientId}`, arun.cookie)).status).toBe(403)
    expect((await h.api(`/api/follow-ups/${f.id}`, arun.cookie, { method: 'PATCH', body: { notes: 'Called, no answer' } })).status).toBe(200)
    expect((await h.api(`/api/follow-ups/${f.id}`, arun.cookie, { method: 'PATCH', body: { assigned_employee_id: md.emp.id } })).status).toBe(403)
    const done = await h.api(`/api/follow-ups/${f.id}/complete`, arun.cookie, { method: 'POST', body: { completion_notes: 'Collected' } })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.status).toBe('completed')
  })

  it('someone who is neither the assignee nor on the client is still refused', async () => {
    const f = await followUp({ assignedEmployeeId: priya.emp.id })
    expect((await h.api(`/api/follow-ups/${f.id}/complete`, arun.cookie, { method: 'POST', body: {} })).status).toBe(403)
  })
})

describe('reminder minutes', () => {
  it('must be 0 to 10080', async () => {
    const body = (m: unknown) => ({ title: 'x', type: 'call', scheduled_at: new Date(Date.now() + 3600_000).toISOString(), assigned_employee_id: priya.emp.id, client_id: clientId, reminder_minutes_before: m })
    expect((await h.api('/api/follow-ups', priya.cookie, { method: 'POST', body: body(-500) })).status).toBe(400)
    expect((await h.api('/api/follow-ups', priya.cookie, { method: 'POST', body: body(20000) })).status).toBe(400)
    const ok = await h.api('/api/follow-ups', priya.cookie, { method: 'POST', body: body(60) })
    expect(ok.status).toBe(201)
    expect((await h.api(`/api/follow-ups/${ok.body.id}`, priya.cookie, { method: 'PATCH', body: { reminder_minutes_before: 15 } })).body.reminder_minutes_before).toBe(15)
  })
})

describe('calendar', () => {
  it('shows follow-ups, task due dates and compliance due dates for visible clients only', async () => {
    const due = addDays(istToday(), 3)
    const f = await followUp({ assignedEmployeeId: priya.emp.id, scheduledAt: new Date(`${due}T05:00:00Z`) })
    const task = await prisma.task.create({ data: { title: uid('Task'), clientId, assignedEmployeeId: priya.emp.id, dueDate: due } })
    const item = await prisma.complianceItem.create({ data: { organisationId: h.orgId, clientId, formCode: uid('GSTR3B'), periodKey: uid('p'), periodLabel: 'Oct 2026', dueDate: due } })
    const hidden = await prisma.complianceItem.create({ data: { organisationId: h.orgId, clientId: otherClientId, formCode: uid('GSTR1'), periodKey: uid('p'), periodLabel: 'Oct 2026', dueDate: due } })
    const filed = await prisma.complianceItem.create({ data: { organisationId: h.orgId, clientId, formCode: uid('TDS'), periodKey: uid('p'), periodLabel: 'Q2', dueDate: due, status: 'filed' } })

    const r = await h.api(`/api/workstation/calendar?from=${addDays(istToday(), -1)}&to=${addDays(istToday(), 10)}`, priya.cookie)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const ids = (r.body.items as any[]).map((e) => `${e.kind}:${e.id}`)
    expect(ids).toEqual(expect.arrayContaining([`followup:${f.id}`, `task:${task.id}`, `compliance:${item.id}`]))
    expect(ids).not.toContain(`compliance:${hidden.id}`)
    expect(ids).not.toContain(`compliance:${filed.id}`)
    const c = (r.body.items as any[]).find((e) => e.id === item.id)
    expect(c).toMatchObject({ date: due, client_id: clientId })

    // Outside the range: not returned.
    const outside = await h.api(`/api/workstation/calendar?from=${addDays(istToday(), 20)}&to=${addDays(istToday(), 30)}`, priya.cookie)
    expect((outside.body.items as any[]).map((e) => e.id)).not.toContain(item.id)
  })

  it('refuses a missing or oversized range', async () => {
    expect((await h.api('/api/workstation/calendar', priya.cookie)).status).toBe(400)
    expect((await h.api(`/api/workstation/calendar?from=2026-01-01&to=2027-06-01`, priya.cookie)).status).toBe(400)
  })
})
