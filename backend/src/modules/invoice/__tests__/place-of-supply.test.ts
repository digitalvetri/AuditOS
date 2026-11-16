import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { FIRM_GSTIN_TN, prisma, setFirmGstin, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { generateForProfile } from '../../recurring/service.js'

/**
 * IGST vs CGST + SGST is decided by the firm's GSTIN in settings against the
 * place of supply, and the place of supply defaults from the client's GSTIN.
 * A Tamil Nadu firm (33…) billing a Karnataka client (29…) ₹10,000 @18%
 * charges IGST ₹1,800 — never CGST ₹900 + SGST ₹900.
 */

let server: Server
let base = ''
let orgId = ''
let wsId = ''
let admin = ''
let senior = ''
let kaClient = ''
let noGstinClient = ''

async function api(path: string, opts: { method?: string; body?: unknown; cookie?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: opts.cookie ?? admin },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  const b = body as { data?: unknown } | null
  return { status: res.status, body: (b && typeof b === 'object' && 'data' in b ? b.data : body) as any }
}

async function login(code: string) {
  const r = await prisma.role.findUniqueOrThrow({ where: { code } })
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('PS'), firstName: 'P', lastName: code, fullName: `P ${code}`, email: `${uid('p')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: r.id, employeeId: emp.id } })
  return { cookie: `ao_access=${signToken(u.id)}`, employeeId: emp.id }
}

const body = (clientId: string, extra: Record<string, unknown> = {}) => ({
  client_id: clientId, invoice_date: '2026-10-01', terms: 'net_15',
  items: [{ item_name: 'Tax audit fee', hsn_sac: '998221', quantity_centi: 100, rate_paise: 10_000_00, gst_rate_percent: 18 }],
  ...extra,
})

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  await setFirmGstin()
  const a = await login('hr_admin')
  admin = a.cookie
  senior = (await login('dept_manager')).cookie
  const mk = (name: string, gstin: string | null) => prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: name, gstin, accountManagerId: a.employeeId, contactPerson: 'P', contactNumber: '9876543210', onboardingDate: '2026-01-01' } })
  kaClient = (await mk('Kaveri Karnataka Pvt Ltd', '29AABCK1234F1Z5')).id
  noGstinClient = (await mk('Unregistered Trader', null)).id
})
afterAll(async () => { await setFirmGstin(); server.close(); await prisma.$disconnect() })

describe('place of supply and the tax split', () => {
  it('TN firm → Karnataka client, no POS sent: POS = Karnataka, IGST ₹1,800 on ₹10,000, no CGST/SGST', async () => {
    const r = await api('/api/invoices', { method: 'POST', body: body(kaClient) })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.place_of_supply).toBe('Karnataka')
    expect(r.body.is_inter_state).toBe(true)
    expect(r.body.igst_paise).toBe(1_800_00)
    expect(r.body.cgst_paise).toBe(0)
    expect(r.body.sgst_paise).toBe(0)
    const sent = await api(`/api/invoices/${r.body.id}/send`, { method: 'POST' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(200)
  })

  it('Karnataka client with is_inter_state=false asked for: still IGST ₹1,800', async () => {
    const r = await api('/api/invoices', { method: 'POST', body: body(kaClient, { place_of_supply: 'Karnataka (29)', is_inter_state: false }) })
    expect(r.status).toBe(201)
    expect(r.body.igst_paise).toBe(1_800_00)
    expect(r.body.cgst_paise).toBe(0)
  })

  it('free-text POS "Bangalore" is refused (400), on invoices, quotations and recurring profiles', async () => {
    const inv = await api('/api/invoices', { method: 'POST', body: body(kaClient, { place_of_supply: 'Bangalore' }) })
    expect(inv.status).toBe(400)
    const q = await api('/api/quotations', { method: 'POST', body: {
      client_id: kaClient, subject: 'Audit', quote_date: '2026-10-01', valid_until: '2026-10-31', place_of_supply: 'Bangalore',
      items: [{ description: 'Audit', quantity_centi: 100, unit_rate_paise: 10_000_00, gst_rate_percent: 18 }],
    } })
    expect(q.status).toBe(400)
    const rec = await api('/api/recurring-invoices', { method: 'POST', body: {
      client_id: kaClient, name: 'Retainer', frequency: 'monthly', day_of_month: 1, start_date: '2026-10-01', place_of_supply: 'Bangalore',
      lines: [{ description: 'Retainer', sac_code: '998222', quantity_centi: 100, unit_rate_paise: 5_000_00, gst_rate: 18 }],
    } })
    expect(rec.status).toBe(400)
  })

  it('a client with no GSTIN and no POS: the draft saves with no POS (never Tamil Nadu) and cannot be sent', async () => {
    const r = await api('/api/invoices', { method: 'POST', body: body(noGstinClient) })
    expect(r.status).toBe(201)
    expect(r.body.place_of_supply).toBeNull()
    const sent = await api(`/api/invoices/${r.body.id}/send`, { method: 'POST' })
    expect(sent.status).toBe(422)
    expect(sent.body.error.code).toBe('place_of_supply_missing')
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: r.body.id } })).invoiceNumber).toBeNull()
  })

  it('no firm GSTIN: draft allowed (CGST+SGST fallback), send refused; once set, the stale split must be re-saved to IGST', async () => {
    await setFirmGstin(null)
    try {
      const r = await api('/api/invoices', { method: 'POST', body: body(kaClient) })
      expect(r.status).toBe(201)
      expect(r.body.cgst_paise).toBe(900_00)
      const blocked = await api(`/api/invoices/${r.body.id}/send`, { method: 'POST' })
      expect(blocked.status).toBe(422)
      expect(blocked.body.error.code).toBe('firm_gstin_missing')

      await setFirmGstin()
      const stale = await api(`/api/invoices/${r.body.id}/send`, { method: 'POST' })
      expect(stale.status).toBe(422)
      expect(stale.body.error.code).toBe('tax_split_stale')

      const resaved = await api(`/api/invoices/${r.body.id}`, { method: 'PUT', body: body(kaClient, { place_of_supply: 'Karnataka' }) })
      expect(resaved.status).toBe(200)
      expect(resaved.body.igst_paise).toBe(1_800_00)
      expect(resaved.body.cgst_paise).toBe(0)
      expect((await api(`/api/invoices/${r.body.id}/send`, { method: 'POST' })).status).toBe(200)
    } finally {
      await setFirmGstin()
    }
  })

  it('recurring auto-send leaves the invoice a draft when it cannot be sent (no POS), instead of failing the run', async () => {
    const created = await api('/api/recurring-invoices', { method: 'POST', body: {
      client_id: noGstinClient, name: 'Retainer', frequency: 'monthly', day_of_month: 1, start_date: '2026-10-01', auto_send: true,
      lines: [{ description: 'Retainer', sac_code: '998222', quantity_centi: 100, unit_rate_paise: 5_000_00, gst_rate: 18 }],
    } })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const run = await generateForProfile(created.body.id, { today: '2026-10-01' })
    expect(run.created).toBe(true)
    expect(run.invoice_number).toBeNull()
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: run.invoice_id! } })).status).toBe('draft')
  })
})

describe('firm GSTIN setting', () => {
  it('reads back with its state; only an Admin may change it; a bad GSTIN is 400', async () => {
    const g = await api('/api/invoices/firm-gst', { cookie: senior })
    expect(g.status).toBe(200)
    expect(g.body).toMatchObject({ gstin: FIRM_GSTIN_TN, state_code: '33', state: 'Tamil Nadu' })

    expect((await api('/api/invoices/firm-gst', { method: 'PUT', cookie: senior, body: { gstin: '29AWHPN2628Q1Z2' } })).status).toBe(403)
    expect((await api('/api/invoices/firm-gst', { method: 'PUT', body: { gstin: '33ABC' } })).status).toBe(400)
    const put = await api('/api/invoices/firm-gst', { method: 'PUT', body: { gstin: '29awhpn2628q1z2' } })
    expect(put.status).toBe(200)
    expect(put.body).toMatchObject({ gstin: '29AWHPN2628Q1Z2', state: 'Karnataka' })
    // A Karnataka firm billing a Karnataka client: CGST ₹900 + SGST ₹900.
    const r = await api('/api/invoices', { method: 'POST', body: body(kaClient) })
    expect(r.body.cgst_paise).toBe(900_00)
    expect(r.body.igst_paise).toBe(0)
    await setFirmGstin()
  })
})
