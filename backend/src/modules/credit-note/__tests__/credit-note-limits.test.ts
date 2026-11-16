import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, setFirmGstin, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { istToday } from '../../../lib/dates.js'
import { creditNoteDeadline } from '../service.js'

/**
 * Credit notes cannot reverse more GST at a rate than the invoice charged at
 * that rate (less earlier notes), and their date must fall between the
 * invoice date and today, inside the s.34(2) limit (30 November after the
 * invoice's financial year).
 */

let server: Server
let base = ''
let cookie = ''
let clientId = ''

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

const daysAgo = (n: number) => new Date(Date.parse(`${istToday()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10)

/** A sent invoice: ₹1,000 fee @18% + ₹1,00,000 reimbursement @0% unless items are given. */
async function sentInvoice(invoiceDate: string, items?: unknown[]) {
  const r = await api('/api/invoices', { method: 'POST', body: {
    client_id: clientId, invoice_date: invoiceDate, terms: 'net_15', place_of_supply: 'Tamil Nadu',
    items: items ?? [
      { item_name: 'Fee', hsn_sac: '998221', quantity_centi: 100, rate_paise: 1_000_00, gst_rate_percent: 18 },
      { item_name: 'Reimbursement', hsn_sac: '998221', quantity_centi: 100, rate_paise: 1_00_000_00, gst_rate_percent: 0 },
    ],
  } })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  const s = await api(`/api/invoices/${r.body.id}/send`, { method: 'POST' })
  expect(s.status, JSON.stringify(s.body)).toBe(200)
  return s.body
}
const cn = (invoiceId: string, noteDate: string, lines: { taxable_paise: number; gst_rate: number }[]) =>
  api('/api/credit-notes', { method: 'POST', body: { invoice_id: invoiceId, note_date: noteDate, reason: 'fee_reduction', lines: lines.map((l) => ({ description: 'Credit', ...l })) } })

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  const orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  const wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  await setFirmGstin()
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'hr_admin' } })
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('CN'), firstName: 'C', lastName: 'N', fullName: 'C N', email: `${uid('cn')}@x.local`, joiningDate: '2024-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  cookie = `ao_access=${signToken(u.id)}`
  clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Credit Co', accountManagerId: emp.id, contactPerson: 'P', contactNumber: '9876543210', onboardingDate: '2024-01-01' } })).id
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('credit note: per-rate cap', () => {
  it('₹1,000 @18% + ₹1,00,000 @0%: crediting ₹50,000 @18% (₹9,000 GST on ₹180 charged) is refused', async () => {
    const inv = await sentInvoice(daysAgo(5))
    const r = await cn(inv.id, daysAgo(1), [{ taxable_paise: 50_000_00, gst_rate: 18 }])
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('credit_exceeds_rate')
    expect(r.body.error.details).toMatchObject({ gst_rate: 18, creditable_taxable_paise: 1_000_00 })
  })

  it('₹600 @18% issued leaves ₹400 @18%: ₹401 is refused, ₹400 is fine; ₹1,00,000 @0% still creditable', async () => {
    const inv = await sentInvoice(daysAgo(5))
    const a = await cn(inv.id, daysAgo(1), [{ taxable_paise: 600_00, gst_rate: 18 }])
    expect(a.status).toBe(201)
    expect((await api(`/api/credit-notes/${a.body.id}/issue`, { method: 'POST' })).status).toBe(200)
    const over = await cn(inv.id, daysAgo(1), [{ taxable_paise: 401_00, gst_rate: 18 }])
    expect(over.status).toBe(422)
    expect(over.body.error.details.creditable_taxable_paise).toBe(400_00)
    expect((await cn(inv.id, daysAgo(1), [{ taxable_paise: 400_00, gst_rate: 18 }, { taxable_paise: 1_00_000_00, gst_rate: 0 }])).status).toBe(201)
  })

  it('two drafts each within the cap cannot both be issued past it', async () => {
    const inv = await sentInvoice(daysAgo(5))
    const a = await cn(inv.id, daysAgo(1), [{ taxable_paise: 700_00, gst_rate: 18 }])
    const b = await cn(inv.id, daysAgo(1), [{ taxable_paise: 700_00, gst_rate: 18 }])
    expect((await api(`/api/credit-notes/${a.body.id}/issue`, { method: 'POST' })).status).toBe(200)
    const ib = await api(`/api/credit-notes/${b.body.id}/issue`, { method: 'POST' })
    expect(ib.status).toBe(422)
    expect(ib.body.error.code).toBe('credit_exceeds_rate')
  })
})

describe('credit note: dates and the s.34(2) limit', () => {
  it('deadline is 30 Nov after the FY: invoice 10 May 2024 → 30 Nov 2025; 15 Mar 2025 → 30 Nov 2025; 1 Apr 2025 → 30 Nov 2026', () => {
    expect(creditNoteDeadline('2024-05-10')).toBe('2025-11-30')
    expect(creditNoteDeadline('2025-03-15')).toBe('2025-11-30')
    expect(creditNoteDeadline('2025-04-01')).toBe('2026-11-30')
  })

  it('refuses a note dated before the invoice, or in the future', async () => {
    const inv = await sentInvoice(daysAgo(5))
    const before = await cn(inv.id, daysAgo(6), [{ taxable_paise: 100_00, gst_rate: 18 }])
    expect(before.status).toBe(422)
    expect(before.body.error.code).toBe('note_before_invoice')
    const future = await cn(inv.id, '2030-01-01', [{ taxable_paise: 100_00, gst_rate: 18 }])
    expect(future.status).toBe(422)
    expect(future.body.error.code).toBe('note_in_future')
    expect((await cn(inv.id, daysAgo(5), [{ taxable_paise: 100_00, gst_rate: 18 }])).status).toBe(201)
  })

  it('an invoice of 10 May 2024 cannot be credited after 30 Nov 2025', async () => {
    const inv = await sentInvoice('2024-05-10')
    const r = await cn(inv.id, istToday(), [{ taxable_paise: 100_00, gst_rate: 18 }])
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('credit_note_time_barred')
    expect(r.body.error.details.deadline).toBe('2025-11-30')
  })
})
