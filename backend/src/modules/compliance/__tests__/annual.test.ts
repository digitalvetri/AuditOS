import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, client, employee, login, org, prisma, startServer, stopServer, uid } from './fixtures.js'
import { generateAnnualFilings, itrFormFor } from '../annual.js'
import { enrolTdsClients } from '../../tds/enrol.js'

/**
 * Annual filings (compliance/annual.ts): IT returns on 1 May for Income Tax
 * Filing clients; LLP Form 11 (1 Apr → 31 May) and Form 8 (1 Sep → 31 Oct);
 * company ADT-1 / AOC-4 (1 Aug → 31 Oct) and MGT-7 (1 Aug → 30 Nov).
 * Far-future dates keep these rows apart from other suites.
 */
beforeAll(startServer)
afterAll(stopServer)

async function serviceId(code: string, organisationId: string) {
  const s = await prisma.service.findFirst({ where: { code } })
  if (s) {
    await prisma.service.update({ where: { id: s.id }, data: { deletedAt: null, isActive: true } })
    return s.id
  }
  return (await prisma.service.create({ data: { organisationId, code, name: code } })).id
}

async function firm() {
  const o = await org()
  const emp = await employee(o, 'Preparer')
  const llp = await client(o, 'Alpha LLP', { businessType: 'Limited Liability Partnership', status: 'active' })
  const co = await client(o, 'Beta Pvt Ltd', { businessType: 'Private Limited', status: 'active' })
  const person = await client(o, 'Gamma', { businessType: 'Individual', status: 'active' })
  const firmNoItr = await client(o, 'Delta & Co', { businessType: 'Partnership firm', status: 'active' })
  const gone = await client(o, 'Old LLP', { businessType: 'LLP', status: 'inactive' })
  await prisma.clientService.create({ data: { clientId: person.id, serviceId: await serviceId('INCOME_TAX_FILING', o.id), status: 'in_progress', assignedEmployeeId: emp.id } })
  const items = (clientId: string) => prisma.complianceItem.findMany({ where: { clientId }, orderBy: { formCode: 'asc' } })
  return { o, emp, llp, co, person, firmNoItr, gone, items }
}

describe('generateAnnualFilings', () => {
  it('creates each form on its open date with the firm due dates, once', async () => {
    const f = await firm()
    const run = (today: string) => generateAnnualFilings(prisma, today, { organisationId: f.o.id })

    expect((await run('2031-03-31')).created).toBe(0)

    await run('2031-04-01')
    expect(await f.items(f.llp.id)).toMatchObject([{ formCode: 'LLP11', periodKey: '2030-31', dueDate: '2031-05-31', status: 'not_started' }])
    expect(await f.items(f.co.id)).toEqual([])
    expect(await f.items(f.gone.id)).toEqual([])

    await run('2031-05-01')
    expect(await f.items(f.person.id)).toMatchObject([{ formCode: 'ITR_NON_BUSINESS', periodKey: '2030-31', dueDate: '2031-07-31', assignedEmployeeId: f.emp.id }])
    expect(await f.items(f.firmNoItr.id)).toEqual([]) // no Income Tax Filing service

    await run('2031-08-01')
    expect((await f.items(f.co.id)).map((i) => [i.formCode, i.dueDate])).toEqual([
      ['ADT1', '2031-10-31'], ['AOC4', '2031-10-31'], ['MGT7', '2031-11-30'],
    ])
    expect((await f.items(f.llp.id)).map((i) => i.formCode)).toEqual(['LLP11'])

    await run('2031-09-01')
    expect((await f.items(f.llp.id)).map((i) => [i.formCode, i.dueDate])).toEqual([['LLP11', '2031-05-31'], ['LLP8', '2031-10-31']])

    // Running again adds nothing.
    const again = await run('2031-09-02')
    expect(again.created).toBe(0)
    expect(await prisma.complianceItem.count({ where: { organisationId: f.o.id } })).toBe(6)
  })

  it('does not create a return whose due date passed before it ran', async () => {
    const f = await firm()
    const r = await generateAnnualFilings(prisma, '2031-12-15', { organisationId: f.o.id })
    expect(r.created).toBe(0)
    // 15 Nov: only MGT-7 (due 30 Nov) is still open for the company.
    await generateAnnualFilings(prisma, '2032-11-15', { organisationId: f.o.id })
    expect((await f.items(f.co.id)).map((i) => i.formCode)).toEqual(['MGT7'])
  })

  it('never duplicates a return made by hand or from an obligation', async () => {
    const f = await firm()
    await prisma.complianceItem.create({ data: { organisationId: f.o.id, clientId: f.person.id, formCode: 'ITR_AUDIT', periodKey: '2032-33', periodLabel: 'FY 2032-33', dueDate: '2033-10-31' } })
    await generateAnnualFilings(prisma, '2033-05-02', { organisationId: f.o.id })
    expect((await f.items(f.person.id)).map((i) => i.formCode)).toEqual(['ITR_AUDIT'])
  })

  it('picks the ITR by entity type and tax audit', () => {
    expect(itrFormFor('individual', false)).toBe('ITR_NON_BUSINESS')
    expect(itrFormFor('firm', false)).toBe('ITR_NON_AUDIT_BUSINESS')
    expect(itrFormFor('individual', true)).toBe('ITR_AUDIT')
    expect(itrFormFor('company', false)).toBe('ITR_AUDIT')
  })
})

describe('TDS enrolment', () => {
  it('gives a TDS Filing client a profile so its quarters reach the TDS board', async () => {
    const o = await org()
    const c = await client(o, 'Epsilon', { status: 'active' })
    await prisma.clientService.create({ data: { clientId: c.id, serviceId: await serviceId('TDS_FILING', o.id), status: 'not_started' } })
    expect(await enrolTdsClients(prisma, { organisationId: o.id })).toBe(1)
    expect(await prisma.tdsProfile.findUnique({ where: { clientId: c.id } })).toMatchObject({ returnForms: '26Q' })
    expect(await enrolTdsClients(prisma, { organisationId: o.id })).toBe(0)
  })
})

describe('GET /api/compliance/annual/:group and form_codes', () => {
  it('serves the schedule and filters items to the group', async () => {
    const f = await firm()
    const md = await login(f.o, 'md')
    await generateAnnualFilings(prisma, '2031-09-01', { organisationId: f.o.id })
    const sched = await api('/api/compliance/annual/llp', { cookie: md.cookie })
    expect(sched.status).toBe(200)
    const body = sched.body.data ?? sched.body
    expect(body.form_codes).toEqual(['LLP11', 'LLP8'])
    expect(body.schedule.map((s: { form_code: string; due: string }) => [s.form_code, s.due])).toEqual([['LLP11', '05-31'], ['LLP8', '10-31']])
    expect((await api('/api/compliance/annual/nope', { cookie: md.cookie })).status).toBe(404)

    const items = await api(`/api/compliance/items?form_codes=LLP8,AOC4&client_id=${f.llp.id}`, { cookie: md.cookie })
    const list = items.body.data?.items ?? items.body.data ?? items.body.items
    expect(list.map((i: { form_code: string }) => i.form_code)).toEqual(['LLP8'])
    void uid
  })
})
