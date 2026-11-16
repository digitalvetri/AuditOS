import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addDays, istToday } from '../../../lib/dates.js'
import { startHarness, type Harness, type Staff } from '../../workstation/__tests__/ws-harness.js'

/**
 * UDIN register rules (ICAI: a UDIN is generated at signing or within 60 days
 * of signing — ICAI announcement "Aligning the time limit of generating UDIN
 * from 15 days to 60 days", 17 Sep 2021):
 *  - the 2-digit prefix is the year the UDIN was generated;
 *  - no future dates, and not generated before the document was signed;
 *  - generated more than 60 days after signing is recorded but flagged late;
 *  - the missing-UDIN list says how many days are left.
 */
let h: Harness
let md: Staff
let clientId = ''
let n = 0
const MNO = '234567'
const tail = () => `RULE${String(++n).padStart(6, '0')}`
const yy = (d: string) => d.slice(2, 4)

const post = (b: { udin: string; document_date: string; generated_on: string }) => h.api('/api/audits/udins', md.cookie, {
  method: 'POST', body: { client_id: clientId, document_type: 'certificate', membership_no: MNO, ...b },
})

beforeAll(async () => {
  h = await startHarness()
  md = await h.staff('md')
  clientId = (await h.client(md.emp.id)).id
})
afterAll(() => h?.close())

describe('UDIN dates', () => {
  const today = istToday()

  it('refuses a year prefix that is not the year it was generated', async () => {
    const r = await post({ udin: `19${MNO}${tail()}`, document_date: today, generated_on: today })
    expect(r.status).toBe(422)
    expect(JSON.stringify(r.body)).toContain('udin_year_mismatch')
  })

  it('refuses future dates, and a UDIN generated before the document was signed', async () => {
    const future = addDays(today, 40)
    expect((await post({ udin: `${yy(future)}${MNO}${tail()}`, document_date: today, generated_on: future })).status).toBe(400)
    expect((await post({ udin: `${yy(today)}${MNO}${tail()}`, document_date: addDays(today, 5), generated_on: today })).status).toBe(400)
    expect((await post({ udin: `${yy(today)}${MNO}${tail()}`, document_date: today, generated_on: addDays(today, -1) })).status).toBe(400)
  })

  it('records a UDIN generated more than 60 days after signing, flagged late', async () => {
    const signed = addDays(today, -120)
    const onTime = await post({ udin: `${yy(today)}${MNO}${tail()}`, document_date: addDays(today, -60), generated_on: today })
    expect(onTime.status, JSON.stringify(onTime.body)).toBe(201)
    expect(onTime.body.late).toBe(false)
    const late = await post({ udin: `${yy(today)}${MNO}${tail()}`, document_date: signed, generated_on: today })
    expect(late.status).toBe(201)
    expect(late.body).toMatchObject({ late: true, days_after_signing: 120 })
  })
})

describe('missing UDINs', () => {
  it('say by when the UDIN is due and how many days are left', async () => {
    const { prisma, uid } = await import('../../../__tests__/helpers.js')
    const reportDate = addDays(istToday(), -50)
    const e = await prisma.auditEngagement.create({
      data: { organisationId: h.orgId, auditCode: uid('AUD'), clientId, financialYear: '2025-26', auditType: 'statutory', title: 'Stat audit', status: 'signed', reportDate },
    })
    const r = await h.api('/api/audits/udins/missing', md.cookie)
    expect(r.status).toBe(200)
    const row = r.body.items.find((x: any) => x.id === e.id)
    expect(row).toMatchObject({ udin_due_by: addDays(reportDate, 60), udin_days_left: 10 })
  })
})
