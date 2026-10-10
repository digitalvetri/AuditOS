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
 *   - refunds: refund due from a credit after payment, caps, numbering, removal,
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

const OVER_BALANCE = 'This credit is more than the invoice total less the credit notes already issued against it. Reduce the credit.'

async function api(path: string, opts: { method?: string; body?: unknown; cookie?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: opts.cookie ?? cookie },
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
    expect(tooMuch.status).toBe(422)
    expect(tooMuch.body.error.message).toBe(OVER_BALANCE)

    // Two drafts that each fit, but not together: the second is refused at issue.
    const b = await api('/api/credit-notes', { method: 'POST', body: { invoice_id: inv.id, note_date: '2026-09-06', reason: 'other', lines: [{ description: 'b', taxable_paise: 5_000_00, gst_rate: 18 }] } })
    const c = await api('/api/credit-notes', { method: 'POST', body: { invoice_id: inv.id, note_date: '2026-09-06', reason: 'other', lines: [{ description: 'c', taxable_paise: 5_000_00, gst_rate: 18 }] } })
    expect(b.status).toBe(201)
    expect(c.status).toBe(201)
    const ib = await api(`/api/credit-notes/${b.body.id}/issue`, { method: 'POST' })
    expect(ib.status).toBe(200)
    const nb = Number(ib.body.credit_note_number.slice(3))
    expect(nb).toBe(Number(issued.body.credit_note_number.slice(3)) + 1)
    expect((await api(`/api/credit-notes/${c.body.id}/issue`, { method: 'POST' })).status).toBe(422)

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
    // Nothing was received, so there is no paid date to invent.
    expect(after.body.paid_at).toBeNull()
  })

  it('a credit may go up to the total less earlier credits, even after cash and TDS', async () => {
    const inv = await sentInvoice()
    // ₹5,000 cash + ₹1,000 TDS against ₹11,800 leaves ₹5,800 due — but the
    // whole ₹11,800 may still be credited (the GST limit is the invoice total).
    const pay = await api(`/api/invoices/${inv.id}/payments`, { method: 'POST', body: { amount_paise: 5_000_00, tds_paise: 1_000_00, paid_on: '2026-09-08' } })
    expect(pay.status).toBe(200)
    const room = await api(`/api/credit-notes/creditable/${inv.id}`)
    expect(room.status).toBe(200)
    expect(room.body).toMatchObject({ creditable_paise: 11_800_00, balance_due_paise: 5_800_00 })

    // ₹10,000 + 18% = ₹11,800 fits; ₹10,001 + 18% does not.
    const over = await api('/api/credit-notes', { method: 'POST', body: { invoice_id: inv.id, note_date: '2026-09-09', reason: 'discount', lines: [{ description: 'Too much', taxable_paise: 10_001_00, gst_rate: 18 }] } })
    expect(over.status).toBe(422)
    expect(over.body.error).toMatchObject({ code: 'credit_exceeds_balance', message: OVER_BALANCE, details: { creditable_paise: 11_800_00 } })

    // Two drafts that each fit, but not together: the second is refused at issue.
    const a = await api('/api/credit-notes', { method: 'POST', body: { invoice_id: inv.id, note_date: '2026-09-09', reason: 'discount', lines: [{ description: 'A', taxable_paise: 6_000_00, gst_rate: 18 }] } })
    const b = await api('/api/credit-notes', { method: 'POST', body: { invoice_id: inv.id, note_date: '2026-09-09', reason: 'discount', lines: [{ description: 'B', taxable_paise: 6_000_00, gst_rate: 18 }] } })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect((await api(`/api/credit-notes/${a.body.id}/issue`, { method: 'POST' })).status).toBe(200)
    const late = await api(`/api/credit-notes/${b.body.id}/issue`, { method: 'POST' })
    expect(late.status).toBe(422)
    expect(late.body.error).toMatchObject({ message: OVER_BALANCE, details: { creditable_paise: 11_800_00 - 7_080_00 } })
    // ₹7,080 credit + ₹6,000 settled = ₹13,080: paid, with ₹1,280 due back.
    const after = await api(`/api/invoices/${inv.id}`)
    expect(after.body).toMatchObject({ stored_status: 'paid', balance_due_paise: 0, refund_due_paise: 1_280_00, refunded_paise: 0 })
    expect(after.body.paid_at?.slice(0, 10)).toBe('2026-09-08')
  })

  it('a credit equal to the balance settles the invoice without moving its paid date', async () => {
    const inv = await sentInvoice()
    expect((await api(`/api/invoices/${inv.id}/payments`, { method: 'POST', body: { amount_paise: 10_000_00, paid_on: '2026-09-08' } })).status).toBe(200)
    // ₹1,800 due: a ₹1,525.42 + 18% credit rounds to exactly ₹1,800.
    const n = await api('/api/credit-notes', { method: 'POST', body: { invoice_id: inv.id, note_date: '2026-09-20', reason: 'discount', lines: [{ description: 'Rest waived', taxable_paise: 1_525_42, gst_rate: 18 }] } })
    expect(n.status).toBe(201)
    expect(n.body.total_paise).toBe(1_800_00)
    expect((await api(`/api/credit-notes/${n.body.id}/issue`, { method: 'POST' })).status).toBe(200)
    const after = await api(`/api/invoices/${inv.id}`)
    expect(after.body.stored_status).toBe('paid')
    expect(after.body.balance_due_paise).toBe(0)
    expect(after.body.refund_due_paise).toBe(0)
    expect(after.body.paid_at?.slice(0, 10)).toBe('2026-09-08')
    // A paid invoice can still be credited up to its total less earlier credits.
    expect((await api(`/api/credit-notes/creditable/${inv.id}`)).body).toMatchObject({ creditable_paise: 10_000_00, balance_due_paise: 0 })
  })

  it('accepts the GST 2.0 40% slab', async () => {
    const r = await api('/api/invoices', { method: 'POST', body: { client_id: clientId, invoice_date: '2026-09-25', terms: 'net_15', is_inter_state: false, items: [{ item_name: 'Fee', quantity_centi: 100, rate_paise: 1_000_00, gst_rate_percent: 40 }] } })
    expect(r.status).toBe(201)
    expect(r.body.total_paise).toBe(1_400_00)
  })
})

describe('refunds', () => {
  const REFUND_OVER = (rupees: string) => `Refund is more than the amount due back to the client (₹ ${rupees}).`

  /** A fully-paid ₹11,800 invoice with a ₹2,360 credit issued after payment. */
  async function paidAndCredited(clientOverride?: string, invoiceDate?: string, paidOn = '2026-09-10') {
    const r = await api('/api/invoices', {
      method: 'POST',
      body: {
        client_id: clientOverride ?? clientId, invoice_date: invoiceDate ?? '2026-09-01', terms: 'net_15', is_inter_state: false,
        items: [{ item_name: 'Audit fee', quantity_centi: 100, rate_paise: 10_000_00, gst_rate_percent: 18 }],
      },
    })
    expect(r.status).toBe(201)
    expect((await api(`/api/invoices/${r.body.id}/send`, { method: 'POST' })).status).toBe(200)
    const paid = await api(`/api/invoices/${r.body.id}/payments`, { method: 'POST', body: { amount_paise: 11_800_00, paid_on: paidOn } })
    expect(paid.body.stored_status).toBe('paid')
    const cn = await api('/api/credit-notes', { method: 'POST', body: { invoice_id: r.body.id, note_date: paidOn, reason: 'fee_reduction', lines: [{ description: 'Fee reduced', taxable_paise: 2_000_00, gst_rate: 18 }] } })
    expect(cn.status).toBe(201)
    expect((await api(`/api/credit-notes/${cn.body.id}/issue`, { method: 'POST' })).status).toBe(200)
    return { invoiceId: r.body.id as string, creditNoteId: cn.body.id as string }
  }

  it('a credit on a paid invoice creates a refund due; refunds are capped, numbered, listed and removable', async () => {
    const { invoiceId, creditNoteId } = await paidAndCredited()
    const inv = await api(`/api/invoices/${invoiceId}`)
    expect(inv.body).toMatchObject({
      stored_status: 'paid', balance_due_paise: 0, credited_paise: 2_360_00, refund_due_paise: 2_360_00, refunded_paise: 0, refunds: [],
    })
    expect(inv.body.paid_at.slice(0, 10)).toBe('2026-09-10')
    // Listed under the Refund due filter.
    const due = await api('/api/invoices?status=refund_due&limit=200')
    expect(due.body.items.map((i: { id: string }) => i.id)).toContain(invoiceId)
    expect((await api('/api/invoices/summary')).body.counts.refund_due).toBeGreaterThan(0)

    // More than is due back: 422 with the amount in the message.
    const over = await api(`/api/invoices/${invoiceId}/refunds`, { method: 'POST', body: { amount_paise: 2_360_01, refunded_on: '2026-09-15', mode: 'bank_transfer' } })
    expect(over.status).toBe(422)
    expect(over.body.error).toMatchObject({ code: 'refund_exceeds_due', message: REFUND_OVER('2,360.00') })
    // Not dated in the future, and the credit note must be this invoice's.
    expect((await api(`/api/invoices/${invoiceId}/refunds`, { method: 'POST', body: { amount_paise: 100, refunded_on: '2999-01-01' } })).status).toBe(400)
    expect((await api(`/api/invoices/${invoiceId}/refunds`, { method: 'POST', body: { amount_paise: 100, credit_note_id: 'nope' } })).status).toBe(400)

    const first = await api(`/api/invoices/${invoiceId}/refunds`, { method: 'POST', body: { amount_paise: 1_000_00, refunded_on: '2026-09-15', mode: 'upi', reference: 'UTR1', credit_note_id: creditNoteId } })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ stored_status: 'paid', balance_due_paise: 0, refunded_paise: 1_000_00, refund_due_paise: 1_360_00 })
    expect(first.body.refunds).toHaveLength(1)
    expect(first.body.refunds[0]).toMatchObject({ amount_paise: 1_000_00, refunded_on: '2026-09-15', mode: 'upi', reference: 'UTR1', credit_note_id: creditNoteId })
    expect(first.body.refunds[0].refund_number).toMatch(/^RFD-\d{6}$/)
    // The paid date follows payments only.
    expect(first.body.paid_at.slice(0, 10)).toBe('2026-09-10')

    const over2 = await api(`/api/invoices/${invoiceId}/refunds`, { method: 'POST', body: { amount_paise: 1_360_01, refunded_on: '2026-09-16' } })
    expect(over2.status).toBe(422)
    expect(over2.body.error.message).toBe(REFUND_OVER('1,360.00'))
    const second = await api(`/api/invoices/${invoiceId}/refunds`, { method: 'POST', body: { amount_paise: 1_360_00, refunded_on: '2026-09-16' } })
    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({ stored_status: 'paid', balance_due_paise: 0, refunded_paise: 2_360_00, refund_due_paise: 0 })
    expect(second.body.paid_at.slice(0, 10)).toBe('2026-09-10')
    const n1 = Number(second.body.refunds[0].refund_number.slice(4))
    const n2 = Number(second.body.refunds[1].refund_number.slice(4))
    expect(n2).toBe(n1 + 1)
    // Nothing more is due back.
    const none = await api(`/api/invoices/${invoiceId}/refunds`, { method: 'POST', body: { amount_paise: 100 } })
    expect(none.status).toBe(422)
    expect(none.body.error.message).toBe(REFUND_OVER('0.00'))

    // The voucher PDF.
    const v = await api(`/api/invoices/${invoiceId}/refunds/${second.body.refunds[0].id}/voucher-url`)
    expect(v.status).toBe(200)
    const pdf = await fetch(`${base}${v.body.url}`)
    expect(pdf.status).toBe(200)
    expect(pdf.headers.get('content-type')).toContain('application/pdf')

    // Removing a refund recomputes; removing it twice is a 404.
    const del = await api(`/api/invoices/${invoiceId}/refunds/${second.body.refunds[1].id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(del.body).toMatchObject({ stored_status: 'paid', refunded_paise: 1_000_00, refund_due_paise: 1_360_00 })
    expect(del.body.refunds).toHaveLength(1)
    expect(del.body.paid_at.slice(0, 10)).toBe('2026-09-10')
    expect((await api(`/api/invoices/${invoiceId}/refunds/${second.body.refunds[1].id}`, { method: 'DELETE' })).status).toBe(404)
    // A removed voucher number is never handed out again.
    const again = await api(`/api/invoices/${invoiceId}/refunds`, { method: 'POST', body: { amount_paise: 1_360_00, refunded_on: '2026-09-17' } })
    expect(Number(again.body.refunds[1].refund_number.slice(4))).toBeGreaterThan(n2)

    // Cancelling the credit after the refund: the refunded ₹2,360 is owed again.
    const cancelled = await api(`/api/credit-notes/${creditNoteId}/cancel`, { method: 'POST', body: { reason: 'raised in error' } })
    expect(cancelled.status).toBe(200)
    const reopened = await api(`/api/invoices/${invoiceId}`)
    expect(reopened.body).toMatchObject({ stored_status: 'partially_paid', balance_due_paise: 2_360_00, refund_due_paise: 0, refunded_paise: 2_360_00 })
    // Removing the payment now would leave refunds with nothing settled behind them.
    const pid = (await api(`/api/invoices/${invoiceId}/payments`)).body.items[0].id
    const blocked = await api(`/api/invoices/${invoiceId}/payments/${pid}`, { method: 'DELETE' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.error.code).toBe('refunds_exceed_settlement')

    // Both are audited.
    const actions = (await prisma.auditLog.findMany({ where: { entityType: 'Invoice', entityId: invoiceId }, select: { action: true } })).map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['invoice_refund.recorded', 'invoice_refund.removed']))
  })

  it('a refund recorded on an unpaid invoice is refused, and concurrent refunds never share a number', async () => {
    const open = await sentInvoice()
    const r = await api(`/api/invoices/${open.id}/refunds`, { method: 'POST', body: { amount_paise: 100 } })
    expect(r.status).toBe(422)

    const a = await paidAndCredited()
    const b = await paidAndCredited()
    const [ra, rb] = await Promise.all([
      api(`/api/invoices/${a.invoiceId}/refunds`, { method: 'POST', body: { amount_paise: 2_360_00, refunded_on: '2026-09-20' } }),
      api(`/api/invoices/${b.invoiceId}/refunds`, { method: 'POST', body: { amount_paise: 2_360_00, refunded_on: '2026-09-20' } }),
    ])
    expect(ra.status).toBe(200)
    expect(rb.status).toBe(200)
    const nums = [ra.body.refunds[0].refund_number, rb.body.refunds[0].refund_number].map((x: string) => Number(x.slice(4))).sort((x, y) => x - y)
    expect(nums[1]).toBe(nums[0] + 1)
  })

  it('payment summary and finance reports count collections net of refunds', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'md' } })
    const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('RF'), firstName: 'R', lastName: 'F', fullName: 'R F', email: `${uid('rf')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId } })
    const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
    const md = `ao_access=${signToken(u.id)}`
    const cid = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Refund Co', accountManagerId: emp.id, contactPerson: 'P', contactNumber: '9876543210', onboardingDate: '2026-01-01' } })).id
    const today = istToday()
    const month = today.slice(0, 7)

    const monthBefore = await api('/api/payment-summary/monthly?months=1', { cookie: md })
    expect(monthBefore.status).toBe(200)
    const { invoiceId } = await paidAndCredited(cid, today, today)

    const mid = await api('/api/payment-summary', { cookie: md })
    const row = mid.body.clients.find((c: { client_id: string }) => c.client_id === cid)
    expect(row).toMatchObject({ paid_paise: 11_800_00, refund_due_paise: 2_360_00, refunded_paise: 0, pending_paise: 0 })
    const thisMonthMid = mid.body.totals.collected_this_month_paise

    expect((await api(`/api/invoices/${invoiceId}/refunds`, { method: 'POST', body: { amount_paise: 2_360_00, refunded_on: today } })).status).toBe(200)

    const after = await api('/api/payment-summary', { cookie: md })
    const row2 = after.body.clients.find((c: { client_id: string }) => c.client_id === cid)
    expect(row2).toMatchObject({ paid_paise: 9_440_00, refund_due_paise: 0, refunded_paise: 2_360_00, pending_paise: 0 })
    expect(after.body.totals.collected_this_month_paise).toBe(thisMonthMid - 2_360_00)
    const detail = await api(`/api/payment-summary/clients/${cid}`, { cookie: md })
    expect(detail.body.invoices[0]).toMatchObject({ paid_paise: 9_440_00, refunded_paise: 2_360_00, refund_due_paise: 0, state: 'paid' })

    const monthAfter = await api('/api/payment-summary/monthly?months=1', { cookie: md })
    const mb = monthBefore.body.months.find((m: { month: string }) => m.month === month)
    const ma = monthAfter.body.months.find((m: { month: string }) => m.month === month)
    expect(ma.collected_paise - mb.collected_paise).toBe(11_800_00 - 2_360_00)
    expect(ma.refunded_paise - mb.refunded_paise).toBe(2_360_00)

    const range = `from=${month}-01&to=${today}&client_id=${cid}`
    const coll = await api(`/api/reports/finance/collections?${range}`, { cookie: md })
    expect(coll.status).toBe(200)
    expect(coll.body.totals).toMatchObject({ cash_paise: 11_800_00, refunded_paise: 2_360_00, net_cash_paise: 9_440_00, settled_paise: 9_440_00 })
    const byClient = await api(`/api/reports/finance/revenue-by-client?${range}`, { cookie: md })
    expect(byClient.body.rows[0]).toMatchObject({ cash_collected_paise: 9_440_00, credited_paise: 2_360_00, refunded_paise: 2_360_00, outstanding_paise: 0 })
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
