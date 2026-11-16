import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, client as mkClient, login, org } from '../../compliance/__tests__/fixtures.js'
import { startServer, stopServer } from '../../compliance/__tests__/fixtures.js'

beforeAll(startServer)
afterAll(stopServer)

type Item = Record<string, unknown>

describe('audit-automation invoice extraction persistence', () => {
  it('POST /invoices saves a reviewed invoice, GET returns it, PATCH corrects fields, export.xlsx streams a workbook', async () => {
    const o = await org()
    const md = await login(o, 'md')
    const c = await mkClient(o, 'Acme Traders')

    // Save (what the UI does after the reviewer edits the extracted preview).
    const saved = await api('/api/audit-automation/invoices', { method: 'POST', cookie: md.cookie, body: {
      client_id: c.id,
      filename: 'INV-001.pdf',
      pdf_sha256: 'a'.repeat(64),
      page_count: 1,
      supplier_gstin: '33AABCV1234N1ZE', supplier_gstin_confidence: 'high',
      supplier_name: 'Vellore Supplies', supplier_name_confidence: 'high',
      invoice_number: 'INV/2026/001', invoice_number_confidence: 'high',
      invoice_date: '2026-04-15', invoice_date_confidence: 'high',
      taxable_paise: 100000, taxable_confidence: 'high',
      cgst_paise: 9000, cgst_confidence: 'medium',
      sgst_paise: 9000, sgst_confidence: 'medium',
      total_paise: 118000, total_confidence: 'high',
      hsn_candidates: ['998313'],
      line_items: [{ description: 'Consulting', hsn: '998313', taxable_paise: 100000 }],
    } })
    expect(saved.status).toBe(201)
    const d = saved.body.data as Item
    expect(d).toMatchObject({ client_id: c.id, status: 'extracted', supplier_gstin: '33AABCV1234N1ZE', total_paise: 118000 })
    const id = d.id as string

    // GET round-trip.
    const read = await api(`/api/audit-automation/invoices/${id}`, { cookie: md.cookie })
    expect(read.status).toBe(200)
    expect((read.body.data as Item).invoice_number).toBe('INV/2026/001')

    // PATCH: correct igst (reviewer notices this was an inter-state sale),
    // and move status to confirmed.
    const patched = await api(`/api/audit-automation/invoices/${id}`, { method: 'PATCH', cookie: md.cookie, body: {
      igst_paise: 18000, cgst_paise: null, sgst_paise: null, status: 'confirmed',
    } })
    expect(patched.status).toBe(200)
    const p = patched.body.data as Item
    expect(p).toMatchObject({ status: 'confirmed', igst_paise: 18000, cgst_paise: null, sgst_paise: null })
    expect(p.reviewed_at).toBeTruthy()

    // Export: bytes, right MIME, right filename.
    const xlsx = await api(`/api/audit-automation/invoices/${id}/export.xlsx`, { cookie: md.cookie })
    expect(xlsx.status).toBe(200)
    expect(xlsx.headers.get('content-type')).toContain('spreadsheetml')
    expect(xlsx.headers.get('content-disposition')).toContain('invoice-INV_2026_001.xlsx')
    expect(xlsx.raw.byteLength).toBeGreaterThan(500) // real workbook, not an empty response
    // The xlsx format is a zip archive — magic bytes `PK`.
    expect(xlsx.raw.subarray(0, 2).toString('utf8')).toBe('PK')
  })

  it('POST /invoices rejects a payload without a client_id', async () => {
    const o = await org()
    const md = await login(o, 'md')
    const r = await api('/api/audit-automation/invoices', { method: 'POST', cookie: md.cookie, body: {
      pdf_sha256: 'b'.repeat(64), filename: 'x.pdf',
    } })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('client_required')
  })

  it('PATCH clears reviewedAt when a confirmed row is reopened', async () => {
    const o = await org()
    const md = await login(o, 'md')
    const c = await mkClient(o, 'Open Again Co')
    const saved = await api('/api/audit-automation/invoices', { method: 'POST', cookie: md.cookie, body: {
      client_id: c.id, pdf_sha256: 'c'.repeat(64), filename: 'x.pdf', status: 'confirmed',
    } })
    const id = (saved.body.data as Item).id as string
    expect((saved.body.data as Item).reviewed_at).toBeTruthy()

    const reopen = await api(`/api/audit-automation/invoices/${id}`, { method: 'PATCH', cookie: md.cookie, body: { status: 'extracted' } })
    expect(reopen.status).toBe(200)
    expect((reopen.body.data as Item).reviewed_at).toBeNull()
  })
})
