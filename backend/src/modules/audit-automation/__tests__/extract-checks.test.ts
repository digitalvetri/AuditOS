import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { extractInvoice } from '../parsers/invoicePdf.js'
import { extractTransit } from '../parsers/transitPdf.js'
import type { ExtractedPage } from '../lib/pdfInspect.js'

/**
 * Invoice and transit extraction: a PDF with no text answers "needs OCR",
 * and a value that fails a check (GSTIN check digit, date, amounts adding
 * up, the same GSTIN on both parties) is never labelled high confidence.
 */
function page(lines: string[]): ExtractedPage {
  return { pageNumber: 1, width: 600, height: 842, items: lines.map((str, i) => ({ str, x: 50, y: 800 - i * 20, width: str.length * 5, height: 10, fontName: 'Helvetica' })) }
}
const GOOD_SUP = '33AAACR1234A1ZA' // check digits verified in the first test
const GOOD_BUY = '29AABCT1332L1ZA'

describe('invoice checks', () => {
  it('fixtures use valid GSTINs', async () => {
    const { isValidGstin } = await import('../parsers/types.js')
    expect([isValidGstin(GOOD_SUP), isValidGstin(GOOD_BUY)]).toEqual([true, true])
  })

  it('a clean invoice keeps its confidence; the heading is not the supplier name', () => {
    const inv = extractInvoice([page([
      'TAX INVOICE', 'Sri Vari Traders', '12, Main Road, Coimbatore 641001', `GSTIN: ${GOOD_SUP}`,
      'Invoice No: SVT/101', 'Invoice Date: 15/10/2025', `Bill To: Buyer Co GSTIN: ${GOOD_BUY}`,
      'Taxable Value 10,000.00', 'IGST 1,800.00', 'Grand Total 11,800.00',
    ])])
    expect(inv.supplierName.value).toBe('Sri Vari Traders')
    expect(inv.supplierGstin.value).toBe(GOOD_SUP)
    expect(inv.invoiceDate.confidence).toBe('high')
    expect(inv.totalPaise.confidence).toBe('medium')
    expect(inv.warnings).toEqual([])
  })

  it('a GSTIN with a wrong check digit, a total that does not add up and an impossible date are low', () => {
    const bad = GOOD_SUP.slice(0, 14) + (GOOD_SUP[14] === 'A' ? 'B' : 'A')
    const inv = extractInvoice([page([
      'Sri Vari Traders', `GSTIN: ${bad}`, 'Invoice No: SVT/102', 'Invoice Date: 15/10/2035',
      'Taxable Value 10,000.00', 'CGST 900.00', 'SGST 900.00', 'Grand Total 12,800.00',
    ])])
    expect(inv.supplierGstin.confidence).toBe('low')
    expect(inv.invoiceDate.confidence).toBe('low')
    expect(inv.totalPaise.confidence).toBe('low')
    expect(inv.taxablePaise.confidence).toBe('low')
    expect(inv.warnings.join(' ')).toMatch(/check digit/)
    expect(inv.warnings.join(' ')).toMatch(/do not add up/)
  })
})

describe('transit checks', () => {
  it('the consignee GSTIN is never the consignor’s', () => {
    const t = extractTransit([page([
      'LORRY RECEIPT', 'LR No: LR-5521', 'Date: 12/10/2025', `Consignor: Sri Vari Traders GSTIN: ${GOOD_SUP}`,
      'From: Coimbatore To: Bengaluru', 'Consignee: Buyer Co', 'Vehicle No: TN 37 AB 1234',
    ])])
    expect(t.consigneeGstin.value).not.toBe(GOOD_SUP)
    expect(t.consigneeGstin.confidence).not.toBe('high')
  })
})

describe('no text layer (HTTP)', () => {
  let server: Server
  let base = ''
  let cookie = ''
  beforeAll(async () => {
    server = createApp().listen(0)
    await new Promise((r) => server.once('listening', r))
    const addr = server.address()
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    const orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
    await setupRoles(prisma, { force: true })
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'md' } })
    const u = await prisma.user.create({ data: { organisationId: orgId, email: `${uid('md')}@x.local`, passwordHash: 'x', roleId: role.id } })
    cookie = `ao_access=${signToken(u.id)}`
  })
  afterAll(() => { server.close() })

  it.each(['invoices', 'transit'])('/%s/extract on a scanned (image-only) PDF → 422 needs_ocr', async (kind) => {
    const doc = await PDFDocument.create()
    const p = doc.addPage([595, 842])
    p.drawRectangle({ x: 50, y: 50, width: 400, height: 600 }) // a "scan": no text at all
    const fd = new FormData()
    fd.append('file', new Blob([Buffer.from(await doc.save())], { type: 'application/pdf' }), 'scan.pdf')
    const res = await fetch(`${base}/api/audit-automation/${kind}/extract`, { method: 'POST', headers: { Cookie: cookie }, body: fd })
    expect(res.status).toBe(422)
    expect(((await res.json()) as any).error.code).toBe('needs_ocr')
  })

  it('a PDF with text still extracts', async () => {
    const doc = await PDFDocument.create()
    const f = await doc.embedFont(StandardFonts.Helvetica)
    const p = doc.addPage([595, 842])
    ;['Sri Vari Traders', `GSTIN: ${GOOD_SUP}`, 'Invoice No: SVT/101', 'Invoice Date: 15/10/2025', 'Taxable Value 10,000.00', 'IGST 1,800.00', 'Grand Total 11,800.00']
      .forEach((t, i) => p.drawText(t, { x: 50, y: 800 - i * 20, size: 10, font: f }))
    const fd = new FormData()
    fd.append('file', new Blob([Buffer.from(await doc.save())], { type: 'application/pdf' }), 'inv.pdf')
    const res = await fetch(`${base}/api/audit-automation/invoices/extract`, { method: 'POST', headers: { Cookie: cookie }, body: fd })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.invoice_number.value).toBe('SVT/101')
    expect(body.data.warnings).toEqual([])
  })
})
