import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, client, login, org, prisma, startServer, stopServer, uid } from '../../compliance/__tests__/fixtures.js'
import { seedServiceMaster } from '../../../../prisma/seed-service-master.js'
import { JNS_SERVICE_MASTER } from '../../../../prisma/data-jns-service-master.js'

/**
 * Service master: the JNS scope of work as selectable activities, edited by
 * partners, and the coverage check engagement letters feed.
 */
beforeAll(startServer)
afterAll(stopServer)

describe('JNS service master seed', () => {
  it('holds the 15 services and all 257 activities of the document', () => {
    expect(JNS_SERVICE_MASTER).toHaveLength(15)
    expect(JNS_SERVICE_MASTER.reduce((n, s) => n + s.items.length, 0)).toBe(257)
    const gst = JNS_SERVICE_MASTER[0]
    expect(gst.name).toBe('GST Return Filing & Compliance')
    expect(gst.items.filter((i) => i.kind === 'scope')).toHaveLength(10)
    expect(gst.items.filter((i) => i.kind === 'exclusion').map((i) => i.content)).toContain('Annual return GSTR-9 and reconciliation statement GSTR-9C.')
  })

  it('creates once and never overwrites the firm’s edits', async () => {
    const o = await org()
    await seedServiceMaster(prisma, o.id)
    const row = await prisma.serviceMaster.findUniqueOrThrow({ where: { code: 'JNS_MIS' }, include: { items: true } })
    expect(row.items).toHaveLength(26)
    await prisma.serviceMaster.update({ where: { id: row.id }, data: { billingFrequency: 'Quarterly' } })
    const again = await seedServiceMaster(prisma, o.id)
    expect(again.created).toBe(0)
    expect((await prisma.serviceMaster.findUniqueOrThrow({ where: { code: 'JNS_MIS' } })).billingFrequency).toBe('Quarterly')
  })
})

describe('/api/service-master', () => {
  it('lists for readers; only a partner edits', async () => {
    const o = await org()
    await seedServiceMaster(prisma, o.id)
    const md = await login(o, 'md')
    const emp = await login(o, 'employee')

    const list = await api('/api/service-master', { cookie: md.cookie })
    expect(list.status).toBe(200)
    const health = list.body.data.find((s: { code: string }) => s.code === 'JNS_HEALTH_CHECK')
    expect(health).toMatchObject({ category: 'Internal audit & review', billing_frequency: 'One-time' })
    expect(health.items[0]).toMatchObject({ kind: 'scope', default_selected: true })

    const body = { category: 'Advisory', name: uid('Payroll support'), billing_frequency: 'Monthly', items: [{ kind: 'scope', content: 'Process monthly payroll.' }] }
    expect((await api('/api/service-master', { method: 'POST', cookie: emp.cookie, body })).status).toBe(403)
    const made = await api('/api/service-master', { method: 'POST', cookie: md.cookie, body })
    expect(made.status).toBe(201)
    const id = made.body.data.id

    const put = await api(`/api/service-master/${id}`, {
      method: 'PUT', cookie: md.cookie,
      body: { ...body, items: [{ kind: 'scope', content: 'Run payroll.' }, { kind: 'exclusion', content: 'PF filings.', default_selected: false }] },
    })
    expect(put.status).toBe(200)
    expect(put.body.data.items.map((i: { kind: string; default_selected: boolean }) => [i.kind, i.default_selected])).toEqual([['scope', true], ['exclusion', false]])
    expect((await api(`/api/service-master/${id}`, { method: 'PUT', cookie: md.cookie, body: { ...body, service_code: 'NOPE_X' } })).status).toBe(400)

    expect((await api(`/api/service-master/${id}`, { method: 'DELETE', cookie: md.cookie })).status).toBe(204)
    expect((await api(`/api/service-master/${id}`, { cookie: md.cookie })).status).toBe(404)
  })

  it('reports which of a client’s services an engagement letter covers', async () => {
    const o = await org()
    const c = await client(o, 'Coverage Client')
    const md = await login(o, 'md')
    const letter = (status: string, codes: string[]) => prisma.engagementLetter.create({
      data: {
        organisationId: o.id, letterCode: uid('EL'), clientId: c.id, subject: 'Engagement', letterDate: '2026-11-23', status,
        serviceScopes: codes.map((code) => ({ code: `JNS_${code}`, name: code, service_code: code, items: [] })),
      },
    })
    await letter('accepted', ['GST_FILING'])
    await letter('draft', ['GST_FILING', 'BOOKKEEPING'])
    await letter('archived', ['TDS_FILING'])

    const id = async (code: string) => (await prisma.service.findFirst({ where: { code } }))?.id
      ?? (await prisma.service.create({ data: { organisationId: o.id, code, name: code } })).id
    const [gst, book, tds] = [await id('GST_FILING'), await id('BOOKKEEPING'), await id('TDS_FILING')]
    const r = await api(`/api/service-master/coverage?client_id=${c.id}`, { cookie: md.cookie })
    expect(r.status).toBe(200)
    expect(r.body.data[gst]).toMatchObject({ service_code: 'GST_FILING', status: 'accepted' })
    expect(r.body.data[book].status).toBe('draft')
    expect(r.body.data[tds]).toBeUndefined()
  })

  it('round-trips service_scopes on an engagement letter', async () => {
    const o = await org()
    const c = await client(o, 'Scopes Client')
    const md = await login(o, 'md')
    const service_scopes = [{ code: 'JNS_GST_RETURNS', name: 'GST Return Filing & Compliance', service_code: 'GST_FILING', items: [{ kind: 'scope', content: 'File GSTR-1.' }], extras: { timeline: '11th of each month' } }]
    const made = await api('/api/engagement-letters', {
      method: 'POST', cookie: md.cookie,
      body: { client_id: c.id, subject: 'Engagement for GST', letter_date: '2026-11-23', service_scopes, fee_items: [] },
    })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.data.service_scopes).toEqual(service_scopes)
  })
})
