import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, client as mkClient, login, org, startServer, stopServer } from '../../compliance/__tests__/fixtures.js'

beforeAll(startServer)
afterAll(stopServer)

type Item = Record<string, unknown>

describe('audit-automation transit (LR / delivery challan) persistence', () => {
  it('POST /transit saves, GET returns it, PATCH corrects vehicle and confirms, export.xlsx streams', async () => {
    const o = await org()
    const md = await login(o, 'md')
    const c = await mkClient(o, 'Sri Lakshmi Transports')

    const saved = await api('/api/audit-automation/transit', { method: 'POST', cookie: md.cookie, body: {
      client_id: c.id,
      filename: 'LR-0427.pdf',
      pdf_sha256: 'a'.repeat(64),
      doc_type: 'lorry_receipt',
      doc_number: 'LR/2026/0427', doc_number_confidence: 'high',
      doc_date: '2026-05-18', doc_date_confidence: 'high',
      consignor: 'ABC Textiles Pvt Ltd', consignor_confidence: 'medium',
      consignor_gstin: '33AABCV1234N1ZE', consignor_gstin_confidence: 'high',
      consignee: 'XYZ Retail Ltd', consignee_confidence: 'medium',
      vehicle_number: 'TN38BZ4213', vehicle_number_confidence: 'medium',
      from_place: 'Coimbatore', from_place_confidence: 'medium',
      to_place: 'Bengaluru', to_place_confidence: 'medium',
      goods_description: 'Cotton fabric rolls', goods_description_confidence: 'medium',
      quantity: '50 bundles', quantity_confidence: 'medium',
      value_paise: 24500000, value_confidence: 'high',
    } })
    expect(saved.status).toBe(201)
    const d = saved.body.data as Item
    expect(d).toMatchObject({
      client_id: c.id, status: 'extracted',
      doc_type: 'lorry_receipt', doc_number: 'LR/2026/0427',
      vehicle_number: 'TN38BZ4213', value_paise: 24500000,
    })
    const id = d.id as string

    const read = await api(`/api/audit-automation/transit/${id}`, { cookie: md.cookie })
    expect(read.status).toBe(200)
    expect((read.body.data as Item).consignor_gstin).toBe('33AABCV1234N1ZE')

    // Reviewer caught a wrong vehicle plate and confirms the row.
    const patched = await api(`/api/audit-automation/transit/${id}`, { method: 'PATCH', cookie: md.cookie, body: {
      vehicle_number: 'tn38bz4214', status: 'confirmed',
    } })
    expect(patched.status).toBe(200)
    const p = patched.body.data as Item
    expect(p).toMatchObject({ status: 'confirmed', vehicle_number: 'TN38BZ4214', vehicle_number_confidence: 'high' })
    expect(p.reviewed_at).toBeTruthy()

    const xlsx = await api(`/api/audit-automation/transit/${id}/export.xlsx`, { cookie: md.cookie })
    expect(xlsx.status).toBe(200)
    expect(xlsx.headers.get('content-type')).toContain('spreadsheetml')
    expect(xlsx.headers.get('content-disposition')).toContain('transit-LR_2026_0427.xlsx')
    expect(xlsx.raw.subarray(0, 2).toString('utf8')).toBe('PK') // zip magic
  })

  it('POST /transit rejects a payload without a client_id', async () => {
    const o = await org()
    const md = await login(o, 'md')
    const r = await api('/api/audit-automation/transit', { method: 'POST', cookie: md.cookie, body: {
      pdf_sha256: 'b'.repeat(64), filename: 'x.pdf',
    } })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('client_required')
  })

  it('PATCH clears reviewedAt when a confirmed row is reopened', async () => {
    const o = await org()
    const md = await login(o, 'md')
    const c = await mkClient(o, 'Reopen Transit Co')
    const saved = await api('/api/audit-automation/transit', { method: 'POST', cookie: md.cookie, body: {
      client_id: c.id, pdf_sha256: 'c'.repeat(64), filename: 'x.pdf', status: 'confirmed',
    } })
    const id = (saved.body.data as Item).id as string
    expect((saved.body.data as Item).reviewed_at).toBeTruthy()

    const reopen = await api(`/api/audit-automation/transit/${id}`, { method: 'PATCH', cookie: md.cookie, body: { status: 'extracted' } })
    expect(reopen.status).toBe(200)
    expect((reopen.body.data as Item).reviewed_at).toBeNull()
  })
})
