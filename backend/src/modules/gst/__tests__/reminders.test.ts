import { beforeAll, describe, expect, it } from 'vitest'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { computeUpcoming, sendGstReminders } from '../reminders.js'

/**
 * The reminder window must be fed by the statutory calendar, not only by
 * hand-set case due dates. A return is FOR period M and due in M+1, so on
 * any day in October the returns that can be due soon or overdue are the
 * September ones. computeUpcoming used to look only at the current month,
 * whose returns fall due next month, so the scheduler never fired.
 *
 * No case rows carry a due date here — every date below comes from the
 * rule resolver (monthly: fallback 11/16/20; quarterly: the rule rows this
 * file inserts, 13/16/22).
 */

let monthlyClientId = ''
let quarterlyClientId = ''

async function makeClient(orgId: string, frequency: 'monthly' | 'quarterly') {
  const code = uid('GSTREM')
  const client = await prisma.client.create({
    data: {
      organisationId: orgId, clientCode: code, companyName: code,
      contactPerson: 'Contact', contactNumber: '9999999999', email: 'client@example.test',
      accountManagerId: 'am-1', status: 'active', onboardingDate: '2026-01-01',
    },
  })
  await prisma.gstProfile.create({
    data: {
      clientId: client.id, gstin: '33AAACT1234A1Z5', registrationStatus: 'active',
      filingFrequency: frequency, assignedEmployeeId: 'emp-gst-rem',
    },
  })
  return client.id
}

beforeAll(async () => {
  const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'GST reminders firm' } })
  monthlyClientId = await makeClient(org.id, 'monthly')
  quarterlyClientId = await makeClient(org.id, 'quarterly')
  // QRMP calendar, as seeded by prisma/seed-gst.ts. Without these rows the
  // resolver falls back to the monthly days and the quarterly checks would
  // pass for the wrong reason.
  for (const r of [
    { kind: 'GSTR1', dueDay: 13 },
    { kind: 'GSTR2B', dueDay: 16 },
    { kind: 'GSTR3B', dueDay: 22 },
  ]) {
    const exists = await prisma.gstDueDateRule.findFirst({
      where: { kind: r.kind, filingFrequency: 'quarterly', stateGroup: null, effectiveFrom: null, deletedAt: null },
    })
    if (!exists) {
      await prisma.gstDueDateRule.create({
        data: { kind: r.kind, filingFrequency: 'quarterly', stateGroup: null, effectiveFrom: null, dueDay: r.dueDay, note: 'test' },
      })
    }
  }
})

describe('computeUpcoming — default window (what the scheduler sees)', () => {
  it('flags last month’s GSTR-1 as due soon two days before the 11th', async () => {
    const items = await computeUpcoming(prisma, { today: '2026-10-09', clientIdFilter: [monthlyClientId] })
    expect(items.map((i) => [i.kind, i.period, i.dueDate, i.state, i.daysToDue])).toEqual([
      ['GSTR1', '2026-09', '2026-10-11', 'due', 2],
    ])
    expect(items[0].key).toBe(`gst:${monthlyClientId}:GSTR1:2026-09:due`)
  })

  it('flags last month’s returns as overdue once their due date has passed', async () => {
    const items = await computeUpcoming(prisma, { today: '2026-10-21', clientIdFilter: [monthlyClientId] })
    const byKind = Object.fromEntries(items.map((i) => [i.kind, i]))
    expect(byKind.GSTR3B).toMatchObject({ period: '2026-09', dueDate: '2026-10-20', state: 'overdue', daysToDue: -1 })
    expect(byKind.GSTR1).toMatchObject({ period: '2026-09', state: 'overdue' })
    expect(byKind.GSTR2B).toMatchObject({ period: '2026-09', state: 'overdue' })
    expect(items.every((i) => i.period === '2026-09')).toBe(true)
  })

  it('drops a return once its case for that period is COMPLETED', async () => {
    const c = await prisma.partnershipCase.create({
      data: { caseCode: uid('GSTR1'), kind: 'GSTR1', clientId: monthlyClientId, period: '2026-09', status: 'COMPLETED' },
    })
    try {
      const items = await computeUpcoming(prisma, { today: '2026-10-09', clientIdFilter: [monthlyClientId] })
      expect(items).toEqual([])
    } finally {
      await prisma.partnershipCase.delete({ where: { id: c.id } })
    }
  })

  it('a COMPLETED case for another period does not hide this one', async () => {
    const c = await prisma.partnershipCase.create({
      data: { caseCode: uid('GSTR1'), kind: 'GSTR1', clientId: monthlyClientId, period: '2026-10', status: 'COMPLETED' },
    })
    try {
      const items = await computeUpcoming(prisma, { today: '2026-10-09', clientIdFilter: [monthlyClientId] })
      expect(items.map((i) => `${i.kind}:${i.period}`)).toEqual(['GSTR1:2026-09'])
    } finally {
      await prisma.partnershipCase.delete({ where: { id: c.id } })
    }
  })

  it('reminds a quarterly filer for the quarter that just ended', async () => {
    const items = await computeUpcoming(prisma, { today: '2026-10-11', clientIdFilter: [quarterlyClientId] })
    expect(items.map((i) => [i.kind, i.period, i.dueDate, i.state, i.daysToDue])).toEqual([
      ['GSTR1', '2026-09', '2026-10-13', 'due', 2],
    ])
  })

  it('stays quiet for a quarterly filer outside the quarter’s filing month', async () => {
    const items = await computeUpcoming(prisma, { today: '2026-11-12', clientIdFilter: [quarterlyClientId] })
    expect(items).toEqual([])
  })
})

describe('sendGstReminders — scheduler tick', () => {
  it('fires one bell per resolver-dated return and never repeats it', async () => {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'GST tick firm' } })
    const dept = await prisma.department.create({ data: { id: uid('dep'), organisationId: org.id, code: uid('D'), name: 'General' } })
    const desg = await prisma.designation.create({ data: { id: uid('desg'), organisationId: org.id, name: 'Executive' } })
    const loc = await prisma.workLocation.create({ data: { id: uid('loc'), organisationId: org.id, name: 'HQ', latitude: 13, longitude: 80 } })
    const sched = await prisma.workSchedule.create({ data: { id: uid('sch'), organisationId: org.id, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })
    const emp = await prisma.employee.create({ data: { id: uid('emp'), organisationId: org.id, employeeCode: uid('EC'), firstName: 'A', lastName: 'B', fullName: 'A B', type: 'executive', status: 'active', designationId: desg.id, departmentId: dept.id, workLocationId: loc.id, workScheduleId: sched.id, email: `${uid('e')}@x.local`, joiningDate: '2026-01-01' } })
    const role = await prisma.role.upsert({ where: { code: 'gst-rem-test' }, update: {}, create: { id: uid('role'), code: 'gst-rem-test', name: 'gst-rem-test' } })
    const user = await prisma.user.create({ data: { id: uid('u'), organisationId: org.id, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
    const clientId = await makeClient(org.id, 'monthly')
    await prisma.gstProfile.update({ where: { clientId }, data: { assignedEmployeeId: emp.id } })

    const ours = () => prisma.notification.findMany({
      where: { userId: user.id, entityType: 'gst_reminder', entityId: { contains: `:${clientId}:` } },
      select: { entityId: true },
    })
    await sendGstReminders(prisma, { today: '2026-10-09' })
    expect((await ours()).map((n) => n.entityId)).toEqual([`gst:${clientId}:GSTR1:2026-09:due`])

    await sendGstReminders(prisma, { today: '2026-10-09' })
    await sendGstReminders(prisma, { today: '2026-10-10' })
    expect(await ours()).toHaveLength(1)
  })
})

describe('computeUpcoming — explicit period', () => {
  it('still evaluates only the period asked for', async () => {
    const items = await computeUpcoming(prisma, { period: '2026-10', today: '2026-10-09', clientIdFilter: [monthlyClientId] })
    expect(items).toEqual([])
  })
})
