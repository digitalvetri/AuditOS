import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'

/**
 * The invoice lifecycle rules that live on the server:
 *   - a draft has no number; the number is taken when it is sent, so the
 *     GST series has no gaps from abandoned drafts,
 *   - an invoice with money against it cannot be cancelled,
 *   - the tax split follows the place of supply, and "false" means false,
 *   - overdue is judged on the IST calendar day.
 */

let server: Server
let base = ''
let orgId = ''
let wsId = ''
let cookie = ''
let clientId = ''

async function api(path: string, opts: { method?: string; body?: unknown; cookie?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: opts.cookie ?? cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  // ok() wraps success bodies in { data }; errors arrive as { error }.
  const b = body as { data?: unknown } | null
  return { status: res.status, body: (b && typeof b === 'object' && 'data' in b ? b.data : body) as any }
}

async function adminCookie() {
  const r = await prisma.role.findUniqueOrThrow({ where: { code: 'hr_admin' } })
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AO'), firstName: 'A', lastName: 'Admin', fullName: 'A Admin', email: `${uid('a')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: r.id, employeeId: emp.id } })
  return `ao_access=${signToken(u.id)}`
}

const body = (extra: Record<string, unknown> = {}) => ({
  client_id: clientId,
  invoice_date: '2026-10-01',
  terms: 'net_15',
  items: [{ item_name: 'Audit fee', quantity_centi: 100, rate_paise: 10_000_00, gst_rate_percent: 18 }],
  ...extra,
})

async function draft(extra: Record<string, unknown> = {}) {
  const r = await api('/api/invoices', { method: 'POST', body: body(extra) })
  expect(r.status).toBe(201)
  return r.body
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  cookie = await adminCookie()
  const manager = await prisma.user.findFirstOrThrow({ where: { employeeId: { not: null } }, orderBy: { createdAt: 'desc' } })
  clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Billed Co', accountManagerId: manager.employeeId!, contactPerson: 'P', contactNumber: '9876543210', onboardingDate: '2026-01-01' } })).id
})
afterEach(() => { vi.useRealTimers() })
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('invoice numbers', () => {
  it('a draft has no number; sending takes the next one, and a deleted draft leaves no gap', async () => {
    const a = await draft()
    expect(a.invoice_number).toBeNull()
    expect(a.display_number).toBe('Draft')

    const sentA = await api(`/api/invoices/${a.id}/send`, { method: 'POST' })
    expect(sentA.status).toBe(200)
    expect(sentA.body.invoice_number).toMatch(/^INV-\d{6}$/)
    const n = Number(sentA.body.invoice_number.slice(4))

    // Abandoned in between: before, this one took a number and left a hole.
    const abandoned = await draft()
    expect((await api(`/api/invoices/${abandoned.id}`, { method: 'DELETE' })).status).toBe(204)

    const b = await draft()
    const sentB = await api(`/api/invoices/${b.id}/send`, { method: 'POST' })
    expect(sentB.body.invoice_number).toBe(`INV-${String(n + 1).padStart(6, '0')}`)
  })

  it('sending twice does not take a second number', async () => {
    const a = await draft()
    const [r1, r2] = await Promise.all([
      api(`/api/invoices/${a.id}/send`, { method: 'POST' }),
      api(`/api/invoices/${a.id}/send`, { method: 'POST' }),
    ])
    expect([r1.status, r2.status].sort()).toEqual([200, 409])
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: a.id } })
    const next = await draft()
    const sent = await api(`/api/invoices/${next.id}/send`, { method: 'POST' })
    expect(Number(sent.body.invoice_number.slice(4))).toBe(Number(row.invoiceNumber!.slice(4)) + 1)
  })
})

describe('cancelling', () => {
  it('is refused while payments are recorded, and allowed once they are removed', async () => {
    const a = await draft()
    await api(`/api/invoices/${a.id}/send`, { method: 'POST' })
    const paid = await api(`/api/invoices/${a.id}/payments`, { method: 'POST', body: { amount_paise: 1000_00, paid_on: '2026-10-02' } })
    expect(paid.status).toBe(200)
    expect(paid.body.stored_status).toBe('partially_paid')

    const refused = await api(`/api/invoices/${a.id}/cancel`, { method: 'POST', body: { reason: 'wrong client' } })
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toBe('This invoice has payments recorded. Remove the payments first, or issue a credit note.')

    const payments = await api(`/api/invoices/${a.id}/payments`)
    for (const p of payments.body.items) {
      expect((await api(`/api/invoices/${a.id}/payments/${p.id}`, { method: 'DELETE' })).status).toBe(200)
    }
    const ok = await api(`/api/invoices/${a.id}/cancel`, { method: 'POST', body: {} })
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('cancelled')
  })
})

describe('tax split', () => {
  it('"false" is false when the server cannot tell the states apart', async () => {
    const r = await draft({ is_inter_state: 'false', ship_same_as_bill: 'false', shipping_name: 'Depot' })
    expect(r.is_inter_state).toBe(false)
    expect(r.ship_same_as_bill).toBe(false)
    expect(r.cgst_paise).toBeGreaterThan(0)
    expect(r.igst_paise).toBe(0)
  })

  it('the place of supply against the firm GSTIN decides, whatever the request says', async () => {
    const company = { name: 'Firm', gstin: '33AWHPN2628Q1Z2' }
    const inter = await draft({ place_of_supply: 'Karnataka', is_inter_state: false, layout_config: { company } })
    expect(inter.is_inter_state).toBe(true)
    expect(inter.igst_paise).toBeGreaterThan(0)
    expect(inter.cgst_paise).toBe(0)

    const intra = await draft({ place_of_supply: 'Tamil Nadu (33)', is_inter_state: true, layout_config: { company } })
    expect(intra.is_inter_state).toBe(false)
    expect(intra.igst_paise).toBe(0)
  })

  it('applies to quotations too', async () => {
    const r = await api('/api/quotations', {
      method: 'POST',
      body: {
        client_id: clientId, subject: 'Audit', quote_date: '2026-10-01', valid_until: '2026-10-31',
        place_of_supply: 'Kerala', is_inter_state: 'false', layout_config: { company: { state: 'Tamil Nadu' } },
        items: [{ description: 'Audit', quantity_centi: 100, unit_rate_paise: 10_000_00, gst_rate_percent: 18 }],
      },
    })
    expect(r.status).toBe(201)
    expect(r.body.is_inter_state).toBe(true)
  })

  it('rejects a malformed customer GSTIN and stores a valid one in capitals', async () => {
    const bad = await api('/api/invoices', { method: 'POST', body: body({ customer_gstin: '33ABC' }) })
    expect(bad.status).toBe(400)
    const good = await draft({ customer_gstin: '29aaacb1234f1z5' })
    expect(good.customer_gstin).toBe('29AAACB1234F1Z5')
  })
})

describe('overdue', () => {
  it('uses the IST day: due "today" in UTC is already late after midnight IST', async () => {
    // 20:00 UTC is 01:30 the next day in IST.
    const now = new Date()
    const utcDay = now.toISOString().slice(0, 10)
    const inv = await prisma.invoice.create({
      data: {
        organisationId: orgId, invoiceNumber: uid('TST'), clientId, invoiceDate: utcDay, dueDate: utcDay,
        status: 'sent', totalPaise: 1000_00, balanceDuePaise: 1000_00, billingName: 'Billed Co',
      },
    })
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${utcDay}T20:00:00Z`) })
    const fresh = await adminCookie()
    const one = await api(`/api/invoices/${inv.id}`, { cookie: fresh })
    expect(one.body.status).toBe('overdue')

    const list = await api('/api/invoices?status=overdue&limit=200', { cookie: fresh })
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(inv.id)
    expect(list.body.items.every((i: { status: string }) => i.status === 'overdue')).toBe(true)
    vi.useRealTimers()

    // Still the same UTC day at 10:00 UTC (15:30 IST): not late yet.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${utcDay}T10:00:00Z`) })
    const notYet = await api(`/api/invoices/${inv.id}`, { cookie: await adminCookie() })
    expect(notYet.body.status).toBe('sent')
  })
})
