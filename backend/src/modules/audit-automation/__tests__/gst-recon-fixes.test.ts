import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import ExcelJS from 'exceljs'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { runMatcher, type Entry } from '../services/GstMatchingService.js'
import { toIsoDate } from '../parsers/types.js'
import { parsePurchaseRegisterExcel } from '../parsers/purchaseRegisterExcel.js'

/**
 * GSTR-2B vs books: an absolute per-invoice tolerance (₹1 by default,
 * configurable per reconciliation), credit notes from the books pairing
 * with 2B's, and text dates that do not shift a day.
 */
const SUP = '33AAACS1234A1Z5'
const e = (over: Partial<Entry>): Entry => ({
  id: uid('e'), supplierGstin: SUP, invoiceNumber: 'INV-1', invoiceDate: '2025-06-10', taxableValue: 10_00_000_00,
  igst: 0, cgst: 90_000_00, sgst: 90_000_00, cess: 0, docType: 'INV', ...over,
})

describe('matcher tolerance', () => {
  it('a ₹999 taxable / ₹89.91 tax difference on a ₹10 lakh invoice is a variance, not a match', () => {
    const r = runMatcher({ filing2B: [e({})], purchaseRegister: [e({ taxableValue: 10_00_999_00, cgst: 90_089_91, sgst: 90_089_91 })] })
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].matchStatus).toBe('variance')
    expect(r.rows[0].mismatchFields).toEqual(expect.arrayContaining(['taxable_value', 'cgst', 'sgst']))
  })
  it('a difference within ₹1 is still matched', () => {
    const r = runMatcher({ filing2B: [e({})], purchaseRegister: [e({ cgst: 90_000_50, sgst: 89_999_50 })] })
    expect(r.rows[0].matchStatus).toBe('matched')
  })
  it('the tolerance is configurable: ₹100 lets a ₹90 difference through', () => {
    const books = e({ cgst: 90_090_00 })
    expect(runMatcher({ filing2B: [e({})], purchaseRegister: [books] }).rows[0].matchStatus).toBe('variance')
    expect(runMatcher({ filing2B: [e({})], purchaseRegister: [books], tolerancePaise: 100_00 }).rows[0].matchStatus).toBe('matched')
  })
})

async function register(rows: Array<Array<string | number | Date>>) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Purchases')
  ws.addRow(['GSTIN', 'Supplier', 'Doc No', 'Date', 'Type', 'Taxable', 'IGST', 'CGST', 'SGST'])
  for (const r of rows) ws.addRow(r)
  return Buffer.from(await wb.xlsx.writeBuffer())
}
const MAP = { supplierGstin: 'A', supplierName: 'B', invoiceNumber: 'C', invoiceDate: 'D', docType: 'E', taxableValue: 'F', igst: 'G', cgst: 'H', sgst: 'I' }

describe('purchase register document type', () => {
  it('a mapped Type column makes credit and debit notes, with credit notes negative', async () => {
    const bytes = await register([
      [SUP, 'S', 'KY-1', '01/06/2025', 'Invoice', 1000, 0, 90, 90],
      [SUP, 'S', 'KY-CN-01', '05/06/2025', 'Credit Note', 200, 0, 18, 18],
      [SUP, 'S', 'KY-DN-01', '06/06/2025', 'Debit note', 50, 0, 4.5, 4.5],
    ])
    const { entries } = await parsePurchaseRegisterExcel(bytes, MAP)
    expect(entries.map((x) => [x.docType, x.taxableValue, x.cgst])).toEqual([['INV', 1000_00, 90_00], ['CRN', -200_00, -18_00], ['DBN', 50_00, 4_50]])
  })
  it('with no Type column, a negative amount is a credit note', async () => {
    const bytes = await register([[SUP, 'S', 'KY-CN-02', '05/06/2025', '', -200, 0, -18, -18]])
    const { entries } = await parsePurchaseRegisterExcel(bytes, { ...MAP, docType: undefined })
    expect(entries[0].docType).toBe('CRN')
  })
  it('a credit note in both 2B and the books pairs', () => {
    const cn = { invoiceNumber: 'KY-CN-01', docType: 'CRN' as const, taxableValue: -200_00, cgst: -18_00, sgst: -18_00 }
    const r = runMatcher({ filing2B: [e({ ...cn, section: 'cdnr' })], purchaseRegister: [e(cn)] })
    expect(r.rows.map((x) => x.matchStatus)).toEqual(['matched'])
    expect(r.rows[0].itcClassification).toBe('reversal')
  })
})

describe('text dates', () => {
  it('10-Jun-2025 and similar are read as written, whatever the server time zone', () => {
    expect(toIsoDate('10-Jun-2025')).toBe('2025-06-10')
    expect(toIsoDate('10 Jun 2025')).toBe('2025-06-10')
    expect(toIsoDate('1-Sept-2025')).toBe('2025-09-01')
    expect(toIsoDate('Jun 10, 2025')).toBe('2025-06-10')
    expect(toIsoDate('2025-06-10T00:00:00+05:30')).toBe('2025-06-10')
  })
})

describe('tolerance per reconciliation (HTTP)', () => {
  let server: Server
  let base = ''
  let cookie = ''
  let orgId = ''
  let clientId = ''
  beforeAll(async () => {
    server = createApp().listen(0)
    await new Promise((r) => server.once('listening', r))
    const addr = server.address()
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
    await setupRoles(prisma, { force: true })
    const ws = await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'md' } })
    const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('E'), firstName: 'M', lastName: 'D', fullName: 'M D', email: `${uid('md')}@x.local`, joiningDate: '2026-01-01', workScheduleId: ws.id } })
    const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
    cookie = `ao_access=${signToken(u.id)}`
    clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Buyer Co', contactPerson: 'P', contactNumber: '9876543210', accountManagerId: emp.id, onboardingDate: '2026-01-01' } })).id
  })
  afterAll(() => { server.close() })

  it('stores the tolerance on the job and matches with it', async () => {
    const f = await prisma.aaGstFiling2B.create({ data: { organisationId: orgId, clientId, uploadedByUserId: (await prisma.user.findFirstOrThrow({ where: { organisationId: orgId } })).id, periodMonth: 6, periodYear: 2025, sourceFormat: 'json', originalFilename: '2b.json', fileSize: 1, fileSha256: uid('sha'), storagePath: 'x' } })
    const p = await prisma.aaPurchaseRegister.create({ data: { organisationId: orgId, clientId, uploadedByUserId: f.uploadedByUserId, periodMonth: 6, periodYear: 2025, sourceFormat: 'xlsx', originalFilename: 'pr.xlsx', fileSize: 1, fileSha256: uid('sha'), storagePath: 'x' } })
    await prisma.aaGstFiling2BEntry.create({ data: { filingId: f.id, section: 'b2b', supplierGstin: SUP, invoiceNumber: 'INV-1', invoiceDate: '2025-06-10', taxableValue: 100000, cgst: 9000, sgst: 9000 } })
    await prisma.aaPurchaseRegisterEntry.create({ data: { registerId: p.id, supplierGstin: SUP, invoiceNumber: 'INV-1', invoiceDate: '2025-06-10', taxableValue: 100000, cgst: 9500, sgst: 9000 } })
    const post = (tolerance_rupees?: number) => fetch(`${base}/api/audit-automation/gst/recon`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ client_id: clientId, filing_2b_id: f.id, purchase_register_id: p.id, ...(tolerance_rupees !== undefined ? { tolerance_rupees } : {}) }),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }))
    const strict = await post()
    expect(strict.status).toBe(201)
    expect(strict.body.data).toMatchObject({ tolerance_rupees: 1, variance_count: 1, matched_count: 0 })
    const loose = await post(10)
    expect(loose.body.data).toMatchObject({ tolerance_rupees: 10, variance_count: 0, matched_count: 1 })
    expect((await post(-1)).status).toBe(400)
  })
})
