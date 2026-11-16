import { beforeAll, describe, expect, it } from 'vitest'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { ensurePeriodJobs, generateGstFilingJobs, previousPeriod, syncGstEnrolment } from '../filing.js'

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
})

describe('ensurePeriodJobs / generateGstFilingJobs', () => {
  it('creates one GSTR-1 and one GSTR-3B with due dates, a data request, and is idempotent', async () => {
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
    const doc = await prisma.clientDocument.findUniqueOrThrow({ where: { id: period.dataRequestDocId! } })
    expect(doc).toMatchObject({ clientId: c.id, status: 'requested', name: 'GST data — Oct 2026' })
  })
  it('gives a quarterly filer jobs only for a quarter-end month', async () => {
    const c = await gstClient({ frequency: 'quarterly' })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    expect((await ensurePeriodJobs(prisma, p.id, '2026-10')).created).toBe(0)
    expect((await ensurePeriodJobs(prisma, p.id, '2026-09')).created).toBe(2)
  })
  it('the daily run enrols and generates last month for every GST Filing client', async () => {
    const c = await gstClient()
    const r = await generateGstFilingJobs(prisma, '2026-11-01')
    expect(r.filings).toBeGreaterThanOrEqual(2)
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    expect(await prisma.gstFiling.count({ where: { gstProfileId: p.id, period: '2026-10' } })).toBe(2)
  })
})
