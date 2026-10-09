import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mail = vi.hoisted(() => ({ configured: false, sent: [] as { to: string[]; subject: string; text: string }[] }))
vi.mock('../../../lib/mailer.js', () => ({
  mailConfigured: () => mail.configured,
  sendMail: async (m: { to: string[]; subject: string; text: string }) => { mail.sent.push(m); return 'mid' },
}))

import { client, employee, login, org, prisma, startServer, stopServer, uid } from './fixtures.js'
import { sendComplianceClientReminders, sendComplianceStaffReminders, staffStage } from '../reminders.js'
import { runComplianceJobs, runExclusive } from '../scheduler.js'

beforeAll(startServer)
afterAll(stopServer)
beforeEach(() => { mail.configured = false; mail.sent = [] })

// A far-future "today" keeps these rows apart from every other suite's data.
const TODAY = '2031-06-10'

async function setup() {
  const o = await org()
  const emp = await employee(o, 'Owner')
  const user = await login(o, 'employee', emp.id)
  const mgr = await employee(o, 'Manager')
  const mgrUser = await login(o, 'employee', mgr.id)
  const email = `${uid('delta')}@Client.test`
  const c = await client(o, 'Delta Pvt Ltd', { email, accountManagerId: mgr.id, businessType: 'Pvt Ltd' })
  const mk = async (formCode: string, dueDate: string, extra: Record<string, unknown> = {}, remindClient = true) => {
    await prisma.clientObligation.upsert({
      where: { clientId_formCode: { clientId: c.id, formCode } }, update: { remindClient },
      create: { organisationId: o.id, clientId: c.id, formCode, remindClient },
    })
    return prisma.complianceItem.create({
      data: { organisationId: o.id, clientId: c.id, formCode, periodKey: dueDate.slice(0, 7), periodLabel: dueDate.slice(0, 7), dueDate, ...extra },
    })
  }
  return { o, emp, user, mgr, mgrUser, c, mk, email: email.toLowerCase() }
}

const notes = (userId: string) => prisma.notification.findMany({ where: { userId, entityType: 'compliance_reminder' }, orderBy: { createdAt: 'asc' } })

describe('staff reminders', () => {
  it('stage thresholds', () => {
    expect([8, 7, 2, 1, 0, -1, -7, -8].map(staffStage)).toEqual([null, 'd7', 'd7', 'd1', 'd1', 'overdue', 'overdue', null])
  })

  it('7 days, 1 day, overdue — once each, to the assignee else the account manager', async () => {
    const { user, mgrUser, emp, mk } = await setup()
    const mine = await mk('PF_ECR', '2031-06-15', { assignedEmployeeId: emp.id })
    await mk('ESI', '2031-06-15') // unassigned → account manager
    await mk('PT_TN', '2031-06-15', { status: 'filed', filedOn: '2031-06-01' }) // closed: silent

    await sendComplianceStaffReminders(prisma, TODAY)
    expect((await notes(user.id)).map((n) => n.entityId)).toEqual([`compliance:${mine.id}:2031-06-15:d7`])
    expect(await notes(mgrUser.id)).toHaveLength(1)
    await sendComplianceStaffReminders(prisma, TODAY)
    await sendComplianceStaffReminders(prisma, '2031-06-12')
    expect(await notes(user.id)).toHaveLength(1) // no repeats within a stage
    await sendComplianceStaffReminders(prisma, '2031-06-14')
    await sendComplianceStaffReminders(prisma, '2031-06-16')
    await sendComplianceStaffReminders(prisma, '2031-06-17')
    expect((await notes(user.id)).map((n) => n.entityId!.split(':').at(-1))).toEqual(['d7', 'd1', 'overdue'])
    expect((await notes(user.id))[2].title).toMatch(/^Overdue/)
  })

  it('an extension re-arms the reminders for the new date', async () => {
    const { o, user, emp, mk } = await setup()
    const item = await mk('GSTR9', '2031-06-15', { assignedEmployeeId: emp.id, periodKey: '2029-30' })
    await sendComplianceStaffReminders(prisma, '2031-06-16')
    expect((await notes(user.id)).map((n) => n.entityId)).toEqual([`compliance:${item.id}:2031-06-15:overdue`])
    await prisma.dueDateExtension.create({ data: { organisationId: o.id, formCode: 'GSTR9', periodKey: '2029-30', newDueDate: '2031-06-20', reference: 'NN 1/2031' } })
    await sendComplianceStaffReminders(prisma, '2031-06-16')
    expect((await notes(user.id)).map((n) => n.entityId).at(-1)).toBe(`compliance:${item.id}:2031-06-20:d7`)
  })
})

describe('client reminders', () => {
  it('off unless SMTP is configured', async () => {
    const { mk } = await setup()
    await mk('PF_ECR', '2031-06-15')
    expect(await sendComplianceClientReminders(prisma, TODAY)).toEqual({ emails: 0, whatsapp: 0 })
    expect(mail.sent).toHaveLength(0)
  })

  it('one email to the address on record, listing pending documents; never repeated', async () => {
    const { email, mk } = await setup()
    mail.configured = true
    const due = await mk('PF_ECR', '2031-06-15', { status: 'documents_pending' })
    await mk('ESI', '2031-06-15', {}, false) // remindClient off
    await mk('PT_TN', '2031-07-30', { status: 'documents_pending' }) // not due yet, but pending docs
    await mk('LLP11', '2031-06-30') // outside the 7-day window
    const r = await sendComplianceClientReminders(prisma, TODAY)
    const ours = mail.sent.filter((m) => m.to.includes(email))
    expect(r.emails).toBeGreaterThanOrEqual(1)
    expect(ours).toHaveLength(1)
    expect(ours[0].to).toEqual([email])
    expect(ours[0].text).toMatch(/PF return and payment/)
    expect(ours[0].text).not.toMatch(/ESI contribution/)
    expect(ours[0].text).toMatch(/waiting for your documents for:\n {2}• PT_TN/)
    expect((await prisma.complianceItem.findUniqueOrThrow({ where: { id: due.id } })).lastClientReminderAt).not.toBeNull()
    await sendComplianceClientReminders(prisma, '2031-06-12')
    expect(mail.sent.filter((m) => m.to.includes(email))).toHaveLength(1)
  })

  it('no email on record → nothing sent', async () => {
    const { c, mk } = await setup()
    await prisma.client.update({ where: { id: c.id }, data: { email: null } })
    mail.configured = true
    await mk('PF_ECR', '2031-06-15')
    await sendComplianceClientReminders(prisma, TODAY)
    expect(mail.sent.some((m) => m.text.includes('Delta Pvt Ltd'))).toBe(false)
  })
})

describe('scheduler', () => {
  it('runExclusive: a second process skips while the first holds the lock', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const first = runExclusive(prisma, 'test.lock', async () => { await gate; return 'ran' })
    await new Promise((r) => setTimeout(r, 200))
    const second = await runExclusive(prisma, 'test.lock', async () => 'also ran')
    release()
    expect(await first).toBe('ran')
    expect(second).toBeNull()
    expect(await runExclusive(prisma, 'test.lock', async () => 'free again')).toBe('free again')
  })

  it('runComplianceJobs runs every job and reports', async () => {
    const r = await runComplianceJobs(prisma, TODAY)
    expect(r.generated).toMatchObject({ created: expect.any(Number) })
    expect(typeof r.staff_reminders).toBe('number')
    expect(r.client_reminders).toEqual({ emails: 0, whatsapp: 0 })
    expect(typeof r.notice_reminders).toBe('number')
    expect(typeof r.dsc_alerts).toBe('number')
  })
})
