import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { firstIssueDate, nextIssueDate, occurrence } from '../../recurring/dates.js'
import { generateForProfile, linesToItems } from '../../recurring/service.js'
import { postCollectionToInvoice, unpostCollection } from '../../zpay/ledger.js'
import { istToday } from '../../../lib/dates.js'

/**
 * Billing completeness:
 *   - TDS on fee receipts settles the invoice (cash + TDS),
 *   - credit notes: numbering on issue, limits, balance effect, cancel,
 *   - recurring retainers: date math and one invoice per profile + period,
 *   - Zoho Payments collections post to the invoice exactly once,
 *   - an accepted quotation converts to a draft invoice once.
 */

let server: Server
let base = ''
let orgId = ''
let wsId = ''
let cookie = ''
let clientId = ''
let userId = ''

async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  const b = body as { data?: unknown } | null
  return { status: res.status, body: (b && typeof b === 'object' && 'data' in b ? b.data : body) as any }
}

/** A sent invoice of ₹10,000 + 18% intra-state GST = ₹11,800. */
async function sentInvoice(extra: Record<string, unknown> = {}) {
  const r = await api('/api/invoices', {
    method: 'POST',
    body: {
      client_id: clientId, invoice_date: '2026-09-01', terms: 'net_15', is_inter_state: false,
      items: [{ item_name: 'Audit fee', quantity_centi: 100, rate_paise: 10_000_00, gst_rate_percent: 18 }],
      ...extra,
    },
  })
  expect(r.status).toBe(201)
  const s = await api(`/api/invoices/${r.body.id}/send`, { method: 'POST' })
  expect(s.status).toBe(200)
  expect(s.body.total_paise).toBe(11_800_00)
  return s.body
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'hr_admin' } })
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('BL'), firstName: 'B', lastName: 'Admin', fullName: 'B Admin', email: `${uid('b')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  userId = u.id
  cookie = `ao_access=${signToken(u.id)}`
  clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Billing Co', accountManagerId: emp.id, contactPerson: 'P', contactNumber: '9876543210', onboardingDate: '2026-01-01' } })).id
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('TDS on fee receipts', () => {
  it('cash + TDS settles the invoice; amount_paid stays cash only', async () => {
    const inv = await sentInvoice()
    // Client pays ₹10,800 and deducts ₹1,000 TDS u/s 194J (10% of the fee).
    const r = await api(`/api/invoices/${inv.id}/payments`, { method: 'POST', body: { amount_paise: 10_800_00, tds_paise: 1_000_00, paid_on: '2026-09-10' } })
    expect(r.status).toBe(200)
    expect(r.body.stored_status).toBe('paid')
    expect(r.body.balance_due_paise).toBe(0)
    expect(r.body.amount_paid_paise).toBe(10_800_00)
    expect(r.body.tds_deducted_paise).toBe(1_000_00)
    expect(r.body.payment_state).toBe('paid')

    const list = await api(`/api/invoices/${inv.id}/payments`)
    expect(list.body.items[0]).toMatchObject({ tds_paise: 1_000_00, tds_section: '194J', tds_certificate_received: false, settled_paise: 11_800_00 })
    expect(list.body.items[0].receipt_number).toMatch(/^RCT-\d{6}$/)

    const cert = await api(`/api/invoices/${inv.id}/payments/${list.body.items[0].id}`, { method: 'PATCH', body: { tds_certificate_received: true } })
    expect(cert.status).toBe(200)
    expect(cert.body.payment.tds_certificate_received).toBe(true)

    const receipt = await api(`/api/invoices/${inv.id}/payments/${list.body.items[0].id}/receipt-url`)
    expect(receipt.status).toBe(200)
    const pdf = await fetch(`${base}${receipt.body.url}`)
    expect(pdf.status).toBe(200)
    expect(pdf.headers.get('content-type')).toContain('application/pdf')
  })

  it('refuses amount + TDS above the balance, and removing the payment reopens the invoice', async () => {
    const inv = await sentInvoice()
    const over = await api(`/api/invoices/${inv.id}/payments`, { method: 'POST', body: { amount_paise: 11_000_00, tds_paise: 1_000_00 } })
    expect(over.status).toBe(400)
    const part = await api(`/api/invoices/${inv.id}/payments`, { method: 'POST', body: { amount_paise: 0, tds_paise: 1_000_00, tds_section: '194C' } })
    expect(part.status).toBe(200)
    expect(part.body.stored_status).toBe('partially_paid')
    expect(part.body.balance_due_paise).toBe(10_800_00)
    const pid = (await api(`/api/invoices/${inv.id}/payments`)).body.items[0].id
    const del = await api(`/api/invoices/${inv.id}/payments/${pid}`, { method: 'DELETE' })
    expect(del.body.stored_status).toBe('sent')
    expect(del.body.tds_deducted_paise).toBe(0)
    expect(del.body.balance_due_paise).toBe(11_800_00)
  })
})

describe('credit notes', () => {
  it('numbers on issue, reduces the balance, respects the limit, and cancel restores it', async () => {
    const draftInv = (await api('/api/invoices', { method: 'POST', body: { client_id: clientId, invoice_date: '2026-09-01', terms: 'net_15', items: [{ item_name: 'Fee', quantity_centi: 100, rate_paise: 100_00, gst_rate_percent: 18 }] } })).body
    const refused = await api('/api/credit-notes', { method: 'POST', body: { invoice_id: draftInv.id, note_date: '2026-09-05', reason: 'discount', lines: [{ description: 'x', taxable_paise: 100, gst_rate: 18 }] } })
    expect(refused.status).toBe(409)

    const inv = await sentInvoice()
    // ₹2,000 taxable + 18% = ₹2,360 credit, CGST/SGST like the invoice.
    const a = await api('/api/credit-notes', { method: 'POST', body: { invoice_id: inv.id, note_date: '2026-09-05', reason: 'fee_reduction', lines: [{ description: 'Fee reduced', sac_code: '998222', taxable_paise: 2_000_00, gst_rate: 18 }] } })
    expect(a.status).toBe(201)
    expect(a.body).toMatchObject({ status: 'draft', credit_note_number: null, total_paise: 2_360_00, cgst_paise: 180_00, sgst_paise: 180_00, igst_paise: 0 })

    const issued = await api(`/api/credit-notes/${a.body.id}/issue`, { method: 'POST' })
    expect(issued.status).toBe(200)
    expect(issued.body.credit_note_number).toMatch(/^CN-\d{6}$/)
    const after = await api(`/api/invoices/${inv.id}`)
    expect(after.body.credited_paise).toBe(2_360_00)
    expect(after.body.balance_due_paise).toBe(9_440_00)
    expect(after.body.stored_status).toBe('partially_paid')

    // Over the remaining ₹9,440: refused at create.
    const tooMuch = await api('/api/credit-notes', { method: 'POST', body: { invoice_id: inv.id, note_date: '2026-09-06', reason: 'other', lines: [{ description: 'x', taxable_paise: 8_100_00, gst_rate: 18 }] } })
    expect(tooMuch.status).toBe(400)

    // Two drafts that each fit, but not together: the second is refused at issue.
    const b = await api('/api/credit-notes', { method: 'POST', body: { invoice_id: inv.id, note_date: '2026-09-06', reason: 'other', lines: [{ description: 'b', taxable_paise: 5_000_00, gst_rate: 18 }] } })
    const c = await api('/api/credit-notes', { method: 'POST', body: { invoice_id: inv.id, note_date: '2026-09-06', reason: 'other', lines: [{ description: 'c', taxable_paise: 5_000_00, gst_rate: 18 }] } })
    expect(b.status).toBe(201)
    expect(c.status).toBe(201)
    const ib = await api(`/api/credit-notes/${b.body.id}/issue`, { method: 'POST' })
    expect(ib.status).toBe(200)
    const nb = Number(ib.body.credit_note_number.slice(3))
    expect(nb).toBe(Number(issued.body.credit_note_number.slice(3)) + 1)
    expect((await api(`/api/credit-notes/${c.body.id}/issue`, { method: 'POST' })).status).toBe(400)

    // The invoice cannot be cancelled while credit notes stand.
    expect((await api(`/api/invoices/${inv.id}/cancel`, { method: 'POST', body: {} })).status).toBe(409)

    // Cancel restores the balance.
    const cancelled = await api(`/api/credit-notes/${b.body.id}/cancel`, { method: 'POST', body: { reason: 'raised in error' } })
    expect(cancelled.body.status).toBe('cancelled')
    expect((await api(`/api/invoices/${inv.id}`)).body.balance_due_paise).toBe(9_440_00)
    // A draft can be deleted; an issued note cannot.
    expect((await api(`/api/credit-notes/${c.body.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await api(`/api/credit-notes/${a.body.id}`, { method: 'DELETE' })).status).toBe(409)

    const pdfUrl = await api(`/api/credit-notes/${a.body.id}/pdf-url`)
    const pdf = await fetch(`${base}${pdfUrl.body.url}`)
    expect(pdf.status).toBe(200)
    expect(pdf.headers.get('content-type')).toContain('application/pdf')
  })

  it('a credit note that clears the balance marks the invoice paid', async () => {
    const inv = await sentInvoice({ place_of_supply: 'Karnataka (29)', is_inter_state: true })
    const n = await api('/api/credit-notes', { method: 'POST', body: { invoice_id: inv.id, note_date: '2026-09-07', reason: 'deficiency', lines: [{ description: 'Full credit', taxable_paise: 10_000_00, gst_rate: 18 }] } })
    expect(n.body).toMatchObject({ igst_paise: 1_800_00, cgst_paise: 0, total_paise: 11_800_00 })
    await api(`/api/credit-notes/${n.body.id}/issue`, { method: 'POST' })
    const after = await api(`/api/invoices/${inv.id}`)
    expect(after.body.stored_status).toBe('paid')
    expect(after.body.balance_due_paise).toBe(0)
  })
})

describe('recurring retainers', () => {
  it('date math: month end without drift, quarterly steps, first date on/after start', () => {
    expect(nextIssueDate('2026-01-31', 'monthly', 31)).toBe('2026-02-28')
    expect(nextIssueDate('2026-02-28', 'monthly', 31)).toBe('2026-03-31')
    expect(nextIssueDate('2028-01-31', 'monthly', 31)).toBe('2028-02-29')
    expect(nextIssueDate('2026-11-30', 'quarterly', 30)).toBe('2027-02-28')
    expect(nextIssueDate('2027-02-28', 'quarterly', 30)).toBe('2027-05-30')
    expect(nextIssueDate('2026-04-01', 'half_yearly', 1)).toBe('2026-10-01')
    expect(nextIssueDate('2026-04-01', 'annual', 1)).toBe('2027-04-01')
    expect(firstIssueDate('2026-01-15', 'monthly', 1)).toBe('2026-02-01')
    expect(firstIssueDate('2026-01-15', 'monthly', 20)).toBe('2026-01-20')
    expect(firstIssueDate('2026-04-15', 'quarterly', 1)).toBe('2026-07-01')
    expect(occurrence(2026, 13, 31)).toBe('2027-02-28')
  })

  it('maps rupee line discounts onto invoice items exactly', () => {
    const r = linesToItems([
      { description: 'A', sac_code: null, quantity_centi: 200, unit_rate_paise: 1000_00, gst_rate: 18, discount_paise: 200_00 },
      { description: 'B', sac_code: null, quantity_centi: 300, unit_rate_paise: 1000_00, gst_rate: 18, discount_paise: 100 },
    ])
    expect(r.items[0].ratePaise).toBe(900_00)
    expect(r.discountPaise).toBe(100)
  })

  it('creates one invoice per profile + period, advances the date, and is idempotent', async () => {
    const today = istToday()
    const created = await api('/api/recurring-invoices', {
      method: 'POST',
      body: {
        client_id: clientId, name: 'Monthly bookkeeping', frequency: 'monthly', day_of_month: 31,
        start_date: '2026-01-01', terms: 'net_7', auto_send: true,
        lines: [{ description: 'Bookkeeping retainer', sac_code: '998222', quantity_centi: 100, unit_rate_paise: 5_000_00, gst_rate: 18 }],
      },
    })
    expect(created.status).toBe(201)
    expect(created.body.next_issue_date).toBe('2026-01-31')

    const first = await api(`/api/recurring-invoices/${created.body.id}/run`, { method: 'POST' })
    expect(first.body.created).toBe(true)
    expect(first.body.invoice_number).toMatch(/^INV-\d{6}$/)
    const p1 = await api(`/api/recurring-invoices/${created.body.id}`)
    expect(p1.body.next_issue_date).toBe('2026-02-28')
    expect(p1.body.last_invoice_id).toBe(first.body.invoice_id)

    // Simulate a crash after the invoice was made but before the pointer
    // moved: putting the date back must not make a second invoice.
    await prisma.recurringInvoiceProfile.update({ where: { id: created.body.id }, data: { nextIssueDate: '2026-01-31' } })
    const again = await generateForProfile(created.body.id, { today })
    expect(again.created).toBe(false)
    expect(again.invoice_id).toBe(first.body.invoice_id)
    expect(await prisma.invoice.count({ where: { recurringProfileId: created.body.id, invoiceDate: '2026-01-31', deletedAt: null } })).toBe(1)

    // Concurrent runs serialise on the profile lock: the second sees the
    // advanced date and raises the NEXT period — never a second Feb invoice.
    const results = await Promise.all([
      generateForProfile(created.body.id, { today }), generateForProfile(created.body.id, { today }),
    ])
    expect(await prisma.invoice.count({ where: { recurringProfileId: created.body.id, invoiceDate: '2026-02-28', deletedAt: null } })).toBe(1)
    expect(await prisma.invoice.count({ where: { recurringProfileId: created.body.id, invoiceDate: '2026-03-31', deletedAt: null } })).toBe(1)
    expect(new Set(results.map((r) => r.invoice_id)).size).toBe(2)

    // Not yet due → nothing.
    await prisma.recurringInvoiceProfile.update({ where: { id: created.body.id }, data: { nextIssueDate: '2099-01-31' } })
    const notDue = await api(`/api/recurring-invoices/${created.body.id}/run`, { method: 'POST' })
    expect(notDue.body.created).toBe(false)
    expect(notDue.body.reason).toMatch(/Not due/)
  })
})

describe('Zoho Payments → receivables ledger', () => {
  it('posts a matched collection once, and unposting releases it', async () => {
    const inv = await sentInvoice()
    const conn = await prisma.zpayConnection.create({ data: { organisationId: orgId, zohoOrgLabel: uid('ZL'), scopesGranted: [], status: 'connected' } })
    const acct = await prisma.zpayAccount.create({ data: { connectionId: conn.id, accountId: uid('acct'), label: 'GST', isGstRegistered: true, legalEntityName: 'Firm', invoiceSeriesPrefix: 'ZZ/' } })
    const pay = await prisma.zpayPayment.create({
      data: {
        accountRowId: acct.id, zohoPaymentId: uid('zp'), amountPaise: 5_000_00, status: 'captured', paymentMode: 'upi',
        referenceNumber: `Fees ${inv.invoice_number}`, paidAt: new Date('2026-09-12T06:00:00Z'), createdAtZoho: new Date('2026-09-12T06:00:00Z'), raw: {},
        matchType: 'exact', matchedInvoiceRef: inv.invoice_number,
      },
    })
    const a = await postCollectionToInvoice(pay.id)
    expect(a.posted).toBe(true)
    const b = await postCollectionToInvoice(pay.id)
    expect(b.posted).toBe(false)
    const [c, d] = await Promise.all([postCollectionToInvoice(pay.id), postCollectionToInvoice(pay.id)])
    expect(c.posted || d.posted).toBe(false)
    expect(await prisma.invoicePayment.count({ where: { externalPaymentId: pay.id } })).toBe(1)
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })
    expect(after.amountPaidPaise).toBe(5_000_00)
    expect(after.balanceDuePaise).toBe(6_800_00)

    expect(await unpostCollection(pay.id, userId)).toBe(true)
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).balanceDuePaise).toBe(11_800_00)

    // Manual link from the queue re-posts it.
    await prisma.zpayPayment.update({ where: { id: pay.id }, data: { matchType: 'unmatched', matchedInvoiceRef: null } })
    const link = await api(`/api/zpay/payments/${pay.id}/link-invoice`, { method: 'POST', body: { invoice_id: inv.id } })
    expect(link.status).toBe(200)
    expect(link.body.posted).toBe(true)
    expect(await prisma.invoicePayment.count({ where: { externalPaymentId: pay.id, deletedAt: null } })).toBe(1)

    // Leave no Zoho connection behind for other suites (accounts overview).
    await prisma.zpayPayment.deleteMany({ where: { accountRowId: acct.id } })
    await prisma.zpayAccount.delete({ where: { id: acct.id } })
    await prisma.zpayConnection.delete({ where: { id: conn.id } })
  })
})

describe('quotation → invoice', () => {
  it('an accepted quotation converts once to a draft with its lines', async () => {
    const q = await prisma.quotation.create({
      data: {
        organisationId: orgId, quotationCode: uid('QT'), clientId, subject: 'Statutory audit FY 2025-26',
        quoteDate: '2026-08-01', validUntil: '2026-12-31', status: 'accepted', placeOfSupply: 'Tamil Nadu (33)', isInterState: false,
        items: { create: [
          { description: 'Statutory audit', quantityCenti: 100, unitRatePaise: 50_000_00, gstRatePercent: 18, sortOrder: 0 },
          { description: 'Tax audit', quantityCenti: 100, unitRatePaise: 25_000_00, gstRatePercent: 18, discountPercent: 10, sortOrder: 1 },
        ] },
      },
    })
    const r = await api(`/api/quotations/${q.id}/convert-to-invoice`, { method: 'POST' })
    expect(r.status).toBe(201)
    const inv = await api(`/api/invoices/${r.body.invoice_id}`)
    expect(inv.body.stored_status).toBe('draft')
    expect(inv.body.client_id).toBe(clientId)
    expect(inv.body.place_of_supply).toBe('Tamil Nadu (33)')
    expect(inv.body.items.map((i: any) => i.item_name)).toEqual(['Statutory audit', 'Tax audit'])
    expect(inv.body.taxable_paise).toBe(50_000_00 + 22_500_00)

    const again = await api(`/api/quotations/${q.id}/convert-to-invoice`, { method: 'POST' })
    expect(again.status).toBe(409)

    const sent = await prisma.quotation.create({ data: { organisationId: orgId, quotationCode: uid('QT'), clientId, subject: 'x', quoteDate: '2026-08-01', validUntil: '2026-12-31', status: 'sent' } })
    expect((await api(`/api/quotations/${sent.id}/convert-to-invoice`, { method: 'POST' })).status).toBe(409)
  })
})
