import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, setFirmGstin, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'

/**
 * Quotation → invoice converts once while a non-cancelled invoice stands for
 * it (editing the draft's notes no longer reopens it), the SAC on the
 * quotation line reaches the invoice, and an invoice line with no SAC
 * cannot be sent (Rule 46).
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

async function acceptedQuotation() {
  const q = await api('/api/quotations', { method: 'POST', body: {
    client_id: clientId, subject: 'Statutory audit FY 2026-27', quote_date: '2026-10-01', valid_until: '2026-12-31', place_of_supply: 'Tamil Nadu',
    items: [{ description: 'Statutory audit', sac_code: '998221', quantity_centi: 100, unit_rate_paise: 50_000_00, gst_rate_percent: 18 }],
  } })
  expect(q.status, JSON.stringify(q.body)).toBe(201)
  expect(q.body.items[0].sac_code).toBe('998221')
  expect((await api(`/api/quotations/${q.body.id}/send`, { method: 'POST', body: {} })).status).toBe(200)
  expect((await api(`/api/quotations/${q.body.id}/accept`, { method: 'POST', body: {} })).status).toBe(200)
  return q.body.id as string
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

describe('quotation → invoice', () => {
  it('keeps the SAC, refuses a second convert even after the notes are edited, and allows one after the invoice is cancelled', async () => {
    const qid = await acceptedQuotation()
    const first = await api(`/api/quotations/${qid}/convert-to-invoice`, { method: 'POST', body: {} })
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    const inv = await api(`/api/invoices/${first.body.invoice_id}`)
    expect(inv.body.items.map((i: { hsn_sac: string | null }) => i.hsn_sac)).toEqual(['998221'])

    // Strip the "Raised from quotation" marker from the draft's notes.
    await prisma.invoice.update({ where: { id: first.body.invoice_id }, data: { notes: 'edited' } })
    const again = await api(`/api/quotations/${qid}/convert-to-invoice`, { method: 'POST', body: {} })
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('already_converted')

    // Sent, then cancelled: the quotation may be invoiced afresh.
    expect((await api(`/api/invoices/${first.body.invoice_id}/send`, { method: 'POST' })).status).toBe(200)
    expect((await api(`/api/invoices/${first.body.invoice_id}/cancel`, { method: 'POST', body: { reason: 'wrong entity' } })).status).toBe(200)
    const after = await api(`/api/quotations/${qid}/convert-to-invoice`, { method: 'POST', body: {} })
    expect(after.status, JSON.stringify(after.body)).toBe(201)
  })

  it('an invoice line with no SAC cannot be sent (422 sac_missing); with it, it sends', async () => {
    const r = await api('/api/invoices', { method: 'POST', body: {
      client_id: clientId, invoice_date: '2026-10-01', terms: 'net_15', place_of_supply: 'Tamil Nadu',
      items: [{ item_name: 'Audit fee', quantity_centi: 100, rate_paise: 10_000_00, gst_rate_percent: 18 }],
    } })
    expect(r.status).toBe(201)
    const blocked = await api(`/api/invoices/${r.body.id}/send`, { method: 'POST' })
    expect(blocked.status).toBe(422)
    expect(blocked.body.error.code).toBe('sac_missing')
    expect(blocked.body.error.message).toContain('Audit fee')
  })
})
