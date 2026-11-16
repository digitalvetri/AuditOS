import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { RpParsedRow } from '@prisma/client'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { buildFromRows } from '../gstr1-builder.js'

/**
 * Ecommerce GSTR-1 from an Amazon MTR B2C file, end to end: upload →
 * parsed rows → preview. Every expected figure below is worked by hand from
 * the CSV in `mtr()`.
 */

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
/** A GSTIN with a correct check digit for the given first 14 characters. */
function gstin(first14: string): string {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1)
    sum += Math.floor(v / 36) + (v % 36)
  }
  return first14 + CHARS[(36 - (sum % 36)) % 36]
}
const SELLER = gstin('33AAACR1234A1Z')
const OTHER = gstin('29AAACR1234A1Z')

const HEAD = ['Seller Gstin', 'Invoice Number', 'Invoice Date', 'Transaction Type', 'Order Id', 'Quantity', 'Hsn/sac', 'Ship To State',
  'Invoice Amount', 'Tax Exclusive Gross', 'Total Tax Amount', 'Cgst Rate', 'Sgst Rate', 'Utgst Rate', 'Igst Rate',
  'Principal Amount', 'Cgst Tax', 'Sgst Tax', 'Utgst Tax', 'Igst Tax', 'Compensatory Cess Tax',
  'Shipping Amount', 'Shipping Cgst Tax', 'Shipping Sgst Tax', 'Shipping Utgst Tax', 'Shipping Igst Tax', 'Shipping Cess Tax Amount',
  'Gift Wrap Amount', 'Gift Wrap Cgst Tax', 'Gift Wrap Sgst Tax', 'Gift Wrap Utgst Tax', 'Gift Wrap Igst Tax', 'Gift Wrap Compensatory Cess Tax',
  'Item Promo Discount', 'Item Promo Tax', 'Shipping Promo Discount', 'Shipping Promo Tax', 'Gift Wrap Promo Discount', 'Gift Wrap Promo Tax',
  'Credit Note No', 'Credit Note Date']

type R = Partial<Record<(typeof HEAD)[number], string | number>>
const line = (r: R) => HEAD.map((h) => String(r[h] ?? (/(Amount|Tax|Gross|Discount|Rate)$/.test(h) ? 0 : ''))).join(',')

function mtr(extra: R[] = []): string {
  const rows: R[] = [
    // 1. Intra-state TN, 18%: ₹1,000 item + ₹50 shipping. Tax 90+90 and 4.50+4.50.
    { 'Seller Gstin': SELLER, 'Invoice Number': 'INV-1', 'Invoice Date': '2025-12-05 10:00:00', 'Transaction Type': 'Shipment', Quantity: 1, 'Hsn/sac': '6109', 'Ship To State': 'TAMIL NADU',
      'Invoice Amount': 1239, 'Tax Exclusive Gross': 1050, 'Total Tax Amount': 189, 'Cgst Rate': 0.09, 'Sgst Rate': 0.09, 'Principal Amount': 1180, 'Cgst Tax': 90, 'Sgst Tax': 90,
      'Shipping Amount': 59, 'Shipping Cgst Tax': 4.5, 'Shipping Sgst Tax': 4.5 },
    // 2. Inter-state KA, 18%: ₹1,000 item, ₹100 promo (tax −18). Taxable 900, IGST 162.
    { 'Seller Gstin': SELLER, 'Invoice Number': 'INV-2', 'Invoice Date': '2025-12-06', 'Transaction Type': 'Shipment', Quantity: 1, 'Hsn/sac': '6109', 'Ship To State': 'KARNATAKA',
      'Invoice Amount': 1062, 'Tax Exclusive Gross': 900, 'Total Tax Amount': 162, 'Igst Rate': 0.18, 'Principal Amount': 1180, 'Igst Tax': 180,
      'Item Promo Discount': -118, 'Item Promo Tax': -18 },
    // 3. Inter-state KA, 5%: ₹2,000, refunded in full in December.
    { 'Seller Gstin': SELLER, 'Invoice Number': 'INV-3', 'Invoice Date': '2025-12-07', 'Transaction Type': 'Shipment', Quantity: 1, 'Hsn/sac': '6110', 'Ship To State': 'KARNATAKA',
      'Invoice Amount': 2100, 'Tax Exclusive Gross': 2000, 'Total Tax Amount': 100, 'Igst Rate': 0.05, 'Principal Amount': 2100, 'Igst Tax': 100 },
    { 'Seller Gstin': SELLER, 'Invoice Number': 'INV-3', 'Invoice Date': '2025-12-07', 'Transaction Type': 'Refund', Quantity: 1, 'Hsn/sac': '6110', 'Ship To State': 'KARNATAKA',
      'Invoice Amount': -2100, 'Tax Exclusive Gross': -2000, 'Total Tax Amount': -100, 'Igst Rate': 0.05, 'Principal Amount': -2100, 'Igst Tax': -100,
      'Credit Note No': 'CN-1', 'Credit Note Date': '2025-12-20' },
    // 4. B2C large: inter-state MH, ₹1,20,000 + IGST 21,600; ₹10,000 of it returned (CN-2).
    { 'Seller Gstin': SELLER, 'Invoice Number': 'INV-4', 'Invoice Date': '2025-12-08', 'Transaction Type': 'Shipment', Quantity: 2, 'Hsn/sac': '6109', 'Ship To State': 'MAHARASHTRA',
      'Invoice Amount': 141600, 'Tax Exclusive Gross': 120000, 'Total Tax Amount': 21600, 'Igst Rate': 0.18, 'Principal Amount': 141600, 'Igst Tax': 21600 },
    { 'Seller Gstin': SELLER, 'Invoice Number': 'INV-4', 'Invoice Date': '2025-12-08', 'Transaction Type': 'Refund', Quantity: 1, 'Hsn/sac': '6109', 'Ship To State': 'MAHARASHTRA',
      'Invoice Amount': -11800, 'Tax Exclusive Gross': -10000, 'Total Tax Amount': -1800, 'Igst Rate': 0.18, 'Principal Amount': -11800, 'Igst Tax': -1800,
      'Credit Note No': 'CN-2', 'Credit Note Date': '2025-12-22' },
    // 5. The seller's Karnataka GSTIN — not this return.
    { 'Seller Gstin': OTHER, 'Invoice Number': 'KA-1', 'Invoice Date': '2025-12-09', 'Transaction Type': 'Shipment', Quantity: 1, 'Hsn/sac': '6109', 'Ship To State': 'KARNATAKA',
      'Invoice Amount': 5900, 'Tax Exclusive Gross': 5000, 'Total Tax Amount': 900, 'Cgst Rate': 0.09, 'Sgst Rate': 0.09, 'Cgst Tax': 450, 'Sgst Tax': 450 },
    // 6. A November invoice — not this period.
    { 'Seller Gstin': SELLER, 'Invoice Number': 'NOV-1', 'Invoice Date': '2025-11-30', 'Transaction Type': 'Shipment', Quantity: 1, 'Hsn/sac': '6109', 'Ship To State': 'TAMIL NADU',
      'Invoice Amount': 1180, 'Tax Exclusive Gross': 1000, 'Total Tax Amount': 180, 'Cgst Rate': 0.09, 'Sgst Rate': 0.09, 'Cgst Tax': 90, 'Sgst Tax': 90 },
    ...extra,
  ]
  return [HEAD.join(','), ...rows.map(line)].join('\n')
}

let server: Server
let base = ''
let orgId = ''
let cookie = ''
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
  clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Seller Co', contactPerson: 'P', contactNumber: '9876543210', accountManagerId: emp.id, onboardingDate: '2026-01-01' } })).id
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

async function upload(csv: string, over: Record<string, string> = {}) {
  const fd = new FormData()
  const fields = { client_id: clientId, gstin: SELLER, period: '2025-12', marketplace: 'amazon', report_kind: 'mtr_b2c', ...over }
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'mtr.csv')
  const res = await fetch(`${base}/api/repotic/ecommerce/uploads`, { method: 'POST', headers: { Cookie: cookie }, body: fd })
  return { status: res.status, body: await res.json() as any }
}
async function get(path: string) {
  const res = await fetch(`${base}${path}`, { headers: { Cookie: cookie } })
  const text = await res.text()
  return { status: res.status, body: text.startsWith('{') ? JSON.parse(text) : text }
}
async function portal() {
  const r = await get(`/api/repotic/ecommerce/gstr1?client_id=${clientId}&gstin=${SELLER}&period=2025-12&download=1`)
  expect(r.status).toBe(200)
  return r.body as any
}

describe('Amazon MTR → GSTR-1', () => {
  it('reads every tax column, keeps only this GSTIN and month, nets B2C returns and builds Table 14 from B2CS + B2CL', async () => {
    const up = await upload(mtr())
    expect(up.status).toBe(201)
    expect(up.body.data.detect_status).toBe('auto_detected')
    const p = await portal()

    // Table 7: TN intra 18% (item + shipping tax) and KA inter 18% (net of promo tax).
    // KA 5% is fully refunded, so it has no row at all.
    expect(p.b2cs).toEqual([
      expect.objectContaining({ pos: '29', rt: 18, sply_ty: 'INTER', txval: 900, iamt: 162, camt: 0, samt: 0 }),
      expect.objectContaining({ pos: '33', rt: 18, sply_ty: 'INTRA', txval: 1050, iamt: 0, camt: 94.5, samt: 94.5 }),
    ])
    // Table 5: the ₹1.2 lakh invoice; its return is a B2CL credit note.
    expect(p.b2cl).toHaveLength(1)
    expect(p.b2cl[0]).toMatchObject({ pos: '27', inv: [{ inum: 'INV-4', val: 141600 }] })
    expect(p.cdnur).toEqual([expect.objectContaining({ typ: 'B2CL', ntty: 'C', nt_num: 'CN-2', nt_dt: '22-12-2025', val: 11800, pos: '27' })])
    expect(p.cdnur[0].itms[0].itm_det).toEqual({ txval: 10000, rt: 18, iamt: 1800, csamt: 0 })
    // Table 12: net of both returns; HSN 6110 nets to nothing.
    expect(p.hsn).toHaveLength(1)
    expect(p.hsn[0]).toMatchObject({ hsn_sc: '6109', rt: 18, qty: 3, txval: 111950, iamt: 19962, camt: 94.5, samt: 94.5 })
    // Table 14: Amazon (TN ETIN known) carries B2CS + B2CL, net of returns.
    expect(p.supeco.clttx).toEqual([{ etin: '33AAICA3918J1C0', suppval: 111950, igst: 19962, cgst: 94.5, sgst: 94.5, cess: 0, flag: 'N' }])
  })

  it('the preview reports what it left out', async () => {
    const r = await get(`/api/repotic/ecommerce/gstr1?client_id=${clientId}&gstin=${SELLER}&period=2025-12`)
    expect(r.status).toBe(200)
    expect(r.body.data.counts).toMatchObject({ excluded_other_gstin: 1, excluded_out_of_period: 1, b2cs_returns: 1, cdnur: 1 })
    expect(r.body.data.warnings.join(' ')).toMatch(/another seller GSTIN/)
  })

  it('the portal file splits HSN into hsn_b2c (from May 2025) and has no wrapper fields', async () => {
    const r = await get(`/api/repotic/ecommerce/gstr1?client_id=${clientId}&gstin=${SELLER}&period=2025-12&download=1&portal=1`)
    expect(r.status).toBe(200)
    expect(Object.keys(r.body).sort()).toEqual(['b2cl', 'b2cs', 'cdnur', 'fp', 'gstin', 'hsn', 'supeco'])
    expect(r.body.fp).toBe('122025')
    expect(r.body.hsn.hsn_b2c[0]).toMatchObject({ num: 1, hsn_sc: '6109', rt: 18 })
    expect(r.body.hsn.hsn_b2c[0]).not.toHaveProperty('val')
  })

  it('a corrected file replaces the earlier one instead of doubling it; both are listed; a wrong file can be deleted', async () => {
    const extra = { 'Seller Gstin': SELLER, 'Invoice Number': 'INV-9', 'Invoice Date': '2025-12-28', 'Transaction Type': 'Shipment', Quantity: 1, 'Hsn/sac': '6109', 'Ship To State': 'TAMIL NADU',
      'Invoice Amount': 118, 'Tax Exclusive Gross': 100, 'Cgst Rate': 0.09, 'Sgst Rate': 0.09, 'Cgst Tax': 9, 'Sgst Tax': 9 }
    const up = await upload(mtr([extra]))
    expect(up.status).toBe(201)
    let p = await portal()
    expect(p.b2cs.find((e: any) => e.pos === '33')).toMatchObject({ txval: 1150, camt: 103.5 })

    const list = await get(`/api/repotic/ecommerce/uploads?client_id=${clientId}&gstin=${SELLER}&period=2025-12`)
    expect(list.body.data.items.map((i: any) => i.status)).toEqual(['parsed', 'superseded'])

    const del = await fetch(`${base}/api/repotic/ecommerce/uploads/${up.body.data.upload_id}`, { method: 'DELETE', headers: { Cookie: cookie } })
    expect(del.status).toBe(200)
    p = await portal()
    expect(p.b2cs ?? []).toEqual([])
    expect((await get(`/api/repotic/ecommerce/uploads?client_id=${clientId}&gstin=${SELLER}&period=2025-12`)).body.data.items).toHaveLength(1)

    // The same file again is the current upload once more.
    expect((await upload(mtr([extra]))).status).toBe(201)
    p = await portal()
    expect(p.b2cs.find((e: any) => e.pos === '33')).toMatchObject({ txval: 1150 })
  })

  it('refuses a GSTIN that is not a GSTIN', async () => {
    expect((await upload(mtr(), { gstin: 'NOTAGSTIN' })).status).toBe(400)
    expect((await upload(mtr(), { gstin: SELLER.slice(0, 14) + (SELLER[14] === 'A' ? 'B' : 'A') })).status).toBe(400)
    expect((await get(`/api/repotic/ecommerce/gstr1?client_id=${clientId}&gstin=NOTAGSTIN&period=2025-12`)).status).toBe(400)
  })
})

describe('GSTR-1 builder: Table 14 per marketplace', () => {
  const row = (over: Partial<RpParsedRow>): RpParsedRow => ({
    id: uid('r'), organisationId: 'o', uploadId: 'amz', sourceRowIndex: 2, txType: 'shipment', invoiceNumber: uid('I'), invoiceDate: '2025-12-01',
    invoiceAmount: 118_00, taxableValue: 100_00, cgstTax: 9_00, sgstTax: 9_00, igstTax: 0, cessTax: 0, rate: 1800, hsn: '6109', quantity: 1,
    shipToState: 'TAMIL NADU', sellerGstin: SELLER, stateCodeIntra: true, creditNoteNumber: null, creditNoteDate: null, rawJson: '{}', createdAt: new Date(), ...over,
  })
  it('each marketplace gets its own supplies, not an equal split', () => {
    const { preview, warnings } = buildFromRows([
      row({ uploadId: 'amz' }), row({ uploadId: 'amz' }), row({ uploadId: 'fk', taxableValue: 500_00, cgstTax: 45_00, sgstTax: 45_00, invoiceAmount: 590_00 }),
    ], SELLER, '2025-12', { marketplaceOf: { amz: 'amazon', fk: 'flipkart' } })
    expect(preview.supeco?.clttx).toEqual([{ etin: '33AAICA3918J1C0', suppval: 200, igst: 0, cgst: 18, sgst: 18, cess: 0, flag: 'N' }])
    expect(warnings.join(' ')).toMatch(/Table 14 omitted for flipkart/)
  })
})
