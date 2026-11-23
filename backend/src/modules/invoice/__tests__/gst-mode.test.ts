import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, setFirmGstin, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'

/**
 * With GST / without GST. Without GST every line is 0% whatever the builder
 * sent, the GST-only send checks (SAC, place of supply) do not apply, and a
 * quotation's choice is carried to the invoice it converts into.
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
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('QC'), firstName: 'Q', lastName: 'C', fullName: 'Q C', email: `${uid('qc')}@x.local`, joiningDate: '2024-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  cookie = `ao_access=${signToken(u.id)}`
  clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Quoted Co', accountManagerId: emp.id, contactPerson: 'P', contactNumber: '9876543210', onboardingDate: '2024-01-01' } })).id
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('without GST', () => {
  it('an invoice raised without GST carries no tax and sends without a SAC or place of supply', async () => {
    const made = await api('/api/invoices', { method: 'POST', body: {
      client_id: clientId, invoice_date: '2026-11-20', terms: 'due_on_receipt', gst_applicable: false,
      items: [{ item_name: 'Accounting', quantity_centi: 100, rate_paise: 10_000_00, discount_percent: 0, gst_rate_percent: 18 }],
    } })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.gst_applicable).toBe(false)
    expect(made.body.items[0].gst_rate_percent).toBe(0)
    expect(made.body.total_paise).toBe(10_000_00)
    expect(made.body.cgst_paise + made.body.sgst_paise + made.body.igst_paise).toBe(0)

    // Saving the draft again without saying keeps the choice.
    const put = await api(`/api/invoices/${made.body.id}`, { method: 'PUT', body: {
      client_id: clientId, invoice_date: '2026-11-20', terms: 'due_on_receipt',
      items: [{ item_name: 'Accounting', quantity_centi: 100, rate_paise: 12_000_00, discount_percent: 0, gst_rate_percent: 18 }],
    } })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    expect(put.body.gst_applicable).toBe(false)
    expect(put.body.total_paise).toBe(12_000_00)

    const sent = await api(`/api/invoices/${made.body.id}/send`, { method: 'POST' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
  })

  it('a quotation without GST is 0% and converts into an invoice without GST', async () => {
    const q = await api('/api/quotations', { method: 'POST', body: {
      client_id: clientId, subject: 'Bookkeeping', quote_date: '2026-11-01', valid_until: '2026-12-31', gst_applicable: false,
      items: [{ description: 'Bookkeeping', quantity_centi: 100, unit_rate_paise: 5_000_00, gst_rate_percent: 18 }],
    } })
    expect(q.status, JSON.stringify(q.body)).toBe(201)
    expect(q.body.gst_applicable).toBe(false)
    expect(q.body.total_paise).toBe(5_000_00)
    expect((await api(`/api/quotations/${q.body.id}/send`, { method: 'POST', body: {} })).status).toBe(200)
    expect((await api(`/api/quotations/${q.body.id}/accept`, { method: 'POST', body: {} })).status).toBe(200)
    const conv = await api(`/api/quotations/${q.body.id}/convert-to-invoice`, { method: 'POST', body: {} })
    expect(conv.status, JSON.stringify(conv.body)).toBe(201)
    const inv = await api(`/api/invoices/${conv.body.invoice_id}`)
    expect(inv.body.gst_applicable).toBe(false)
    expect(inv.body.total_paise).toBe(5_000_00)
  })

  it('with GST stays the default', async () => {
    const made = await api('/api/invoices', { method: 'POST', body: {
      client_id: clientId, invoice_date: '2026-11-20', terms: 'due_on_receipt', place_of_supply: 'Tamil Nadu',
      items: [{ item_name: 'Audit', hsn_sac: '998221', quantity_centi: 100, rate_paise: 10_000_00, discount_percent: 0, gst_rate_percent: 18 }],
    } })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.gst_applicable).toBe(true)
    expect(made.body.total_paise).toBe(11_800_00)
  })
})
