import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'

// SMTP is never configured in tests; the reminder path needs a fake mailer.
vi.mock('../../../lib/mailer.js', () => ({
  mailConfigured: () => true,
  sendMail: vi.fn(async () => 'msg-test-1'),
  MailError: class MailError extends Error {},
}))

import { createApp } from '../../../app.js'
import { env } from '../../../lib/env.js'
import { sendMail } from '../../../lib/mailer.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, setFirmGstin, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { generateForProfile } from '../../recurring/service.js'
import { runDunning } from '../reminders.js'

/**
 * A client under an organization is billed in the ORGANIZATION's name
 * (spec 2026-11-18 §A3): bill-to name, address, GSTIN and place of supply
 * default to the organization, never mixed with the client's; the invoice
 * stays the client's (clientId), carries a "Services for" line, and is sent
 * to the organization's email. Quotations take the organization into their
 * snapshot with `for_client`. The organization's invoice list also shows its
 * clients' invoices.
 */

let server: Server
let base = ''
let firmId = ''
let wsId = ''
let admin = ''
let managerId = ''

const ORG_GSTIN = '29AABCT1234F1Z5' // Karnataka
const CHILD_GSTIN = '33AABCC5678G1Z2' // Tamil Nadu

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

const invoiceBody = (clientId: string, extra: Record<string, unknown> = {}) => ({
  client_id: clientId, invoice_date: '2026-10-01', terms: 'net_15',
  items: [{ item_name: 'Tax audit fee', hsn_sac: '998221', quantity_centi: 100, rate_paise: 10_000_00, gst_rate_percent: 18 }],
  ...extra,
})

async function mkClient(data: { name: string; gstin?: string | null; address?: string | null; email?: string | null; org?: string; isOrg?: boolean; contactPerson?: string }) {
  return prisma.client.create({
    data: {
      organisationId: firmId, clientCode: uid('CLI'), companyName: data.name, gstin: data.gstin ?? null, address: data.address ?? null,
      email: data.email ?? null, isOrganization: data.isOrg ?? false, parentClientId: data.org ?? null,
      accountManagerId: managerId, contactPerson: data.contactPerson ?? 'P', contactNumber: '9876543210', onboardingDate: '2026-01-01',
    },
  })
}

let org: Awaited<ReturnType<typeof mkClient>>
let child: Awaited<ReturnType<typeof mkClient>>
let standalone: Awaited<ReturnType<typeof mkClient>>

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  firmId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: firmId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  await setFirmGstin()
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'hr_admin' } })
  const emp = await prisma.employee.create({ data: { organisationId: firmId, employeeCode: uid('OB'), firstName: 'O', lastName: 'B', fullName: 'O B', email: `${uid('ob')}@x.local`, joiningDate: '2024-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: firmId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  admin = `ao_access=${signToken(u.id)}`
  managerId = emp.id

  org = await mkClient({ name: 'Taxtable Partners LLP', gstin: ORG_GSTIN, address: '12 MG Road, Bengaluru', email: 'accounts@taxtable.in', isOrg: true, contactPerson: 'Tara' })
  child = await mkClient({ name: 'Kaveri Traders', gstin: CHILD_GSTIN, address: '5 Anna Salai, Chennai', email: 'owner@kaveri.in', org: org.id, contactPerson: 'Kumar' })
  standalone = await mkClient({ name: 'Solo Stores', gstin: CHILD_GSTIN, address: '9 Mount Road, Chennai', email: 'solo@solo.in' })
})
afterAll(async () => { await setFirmGstin(); server.close(); await prisma.$disconnect() })

describe('invoice for a client under an organization', () => {
  it("defaults bill-to name, address, GSTIN and place of supply to the organization, and notes whose services they are", async () => {
    const r = await api('/api/invoices', { method: 'POST', body: invoiceBody(child.id) })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.client_id).toBe(child.id)
    expect(r.body.billing_name).toBe('Taxtable Partners LLP')
    expect(r.body.billing_address).toBe('12 MG Road, Bengaluru')
    expect(r.body.customer_gstin).toBe(ORG_GSTIN)
    expect(r.body.shipping_name).toBe('Taxtable Partners LLP')
    // Karnataka organization, Tamil Nadu firm → inter-state IGST.
    expect(r.body.place_of_supply).toBe('Karnataka')
    expect(r.body.is_inter_state).toBe(true)
    expect(r.body.igst_paise).toBe(1_800_00)
    expect(r.body.notes).toBe(`Services for: Kaveri Traders (${child.clientCode})`)
    expect(r.body.billed_organization).toMatchObject({ id: org.id, name: 'Taxtable Partners LLP' })
    expect(r.body.party_email).toBe('accounts@taxtable.in')
  })

  it('an explicit billing name and notes in the request still win', async () => {
    const r = await api('/api/invoices', { method: 'POST', body: invoiceBody(child.id, { billing_name: 'Someone Else Pvt Ltd', notes: 'Thanks for your business.' }) })
    expect(r.status).toBe(201)
    expect(r.body.billing_name).toBe('Someone Else Pvt Ltd')
    expect(r.body.notes).toBe('Thanks for your business.')
    // Fields not overridden still come from the organization.
    expect(r.body.customer_gstin).toBe(ORG_GSTIN)
  })

  it('updating the draft keeps the organization as the party', async () => {
    const r = await api('/api/invoices', { method: 'POST', body: invoiceBody(standalone.id) })
    expect(r.body.billing_name).toBe('Solo Stores')
    const put = await api(`/api/invoices/${r.body.id}`, { method: 'PUT', body: invoiceBody(child.id) })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    expect(put.body.billing_name).toBe('Taxtable Partners LLP')
    expect(put.body.customer_gstin).toBe(ORG_GSTIN)
    expect(put.body.place_of_supply).toBe('Karnataka')
  })

  it('a client with no organization behaves as before', async () => {
    const r = await api('/api/invoices', { method: 'POST', body: invoiceBody(standalone.id) })
    expect(r.status).toBe(201)
    expect(r.body.billing_name).toBe('Solo Stores')
    expect(r.body.billing_address).toBe('9 Mount Road, Chennai')
    expect(r.body.customer_gstin).toBe(CHILD_GSTIN)
    expect(r.body.place_of_supply).toBe('Tamil Nadu')
    expect(r.body.notes).toBeNull()
    expect(r.body.billed_organization).toBeNull()
    expect(r.body.party_email).toBe('solo@solo.in')
  })

  it("an organization with no GSTIN or address: those stay null — never the client's", async () => {
    const bare = await mkClient({ name: 'Bare Org', isOrg: true })
    const kid = await mkClient({ name: 'Registered Kid', gstin: CHILD_GSTIN, address: 'Kid street', email: 'kid@kid.in', org: bare.id })
    const r = await api('/api/invoices', { method: 'POST', body: invoiceBody(kid.id) })
    expect(r.status).toBe(201)
    expect(r.body.billing_name).toBe('Bare Org')
    expect(r.body.customer_gstin).toBeNull()
    expect(r.body.billing_address).toBeNull()
    // No GSTIN to derive it from: the place of supply is left for the user.
    expect(r.body.place_of_supply).toBeNull()
    // Contact falls back to the client's when the organization has none.
    expect(r.body.party_email).toBe('kid@kid.in')
  })
})

describe('invoices raised without the builder', () => {
  it('quotation → invoice bills the organization', async () => {
    const q = await api('/api/quotations', { method: 'POST', body: {
      client_id: child.id, subject: 'GST compliance FY 2026-27', quote_date: '2026-10-01', valid_until: '2026-12-31',
      items: [{ description: 'GST returns', sac_code: '998231', quantity_centi: 100, unit_rate_paise: 20_000_00, gst_rate_percent: 18 }],
    } })
    expect(q.status, JSON.stringify(q.body)).toBe(201)
    expect((await api(`/api/quotations/${q.body.id}/send`, { method: 'POST', body: {} })).status).toBe(200)
    expect((await api(`/api/quotations/${q.body.id}/accept`, { method: 'POST', body: {} })).status).toBe(200)
    const conv = await api(`/api/quotations/${q.body.id}/convert-to-invoice`, { method: 'POST', body: {} })
    expect(conv.status, JSON.stringify(conv.body)).toBe(201)
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: conv.body.invoice_id } })
    expect(inv.clientId).toBe(child.id)
    expect(inv.billingName).toBe('Taxtable Partners LLP')
    expect(inv.customerGstin).toBe(ORG_GSTIN)
    expect(inv.placeOfSupply).toBe('Karnataka')
    expect(inv.notes).toContain('Raised from quotation')
    expect(inv.notes).toContain(`Services for: Kaveri Traders (${child.clientCode})`)
  })

  it('a recurring profile bills the organization', async () => {
    const created = await api('/api/recurring-invoices', { method: 'POST', body: {
      client_id: child.id, name: 'Retainer', frequency: 'monthly', day_of_month: 1, start_date: '2026-10-01',
      lines: [{ description: 'Retainer', sac_code: '998222', quantity_centi: 100, unit_rate_paise: 5_000_00, gst_rate: 18 }],
    } })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const run = await generateForProfile(created.body.id, { today: '2026-10-01' })
    expect(run.created).toBe(true)
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: run.invoice_id! } })
    expect(inv.clientId).toBe(child.id)
    expect(inv.billingName).toBe('Taxtable Partners LLP')
    expect(inv.billingAddress).toBe('12 MG Road, Bengaluru')
    expect(inv.customerGstin).toBe(ORG_GSTIN)
    expect(inv.placeOfSupply).toBe('Karnataka')
    expect(inv.isInterState).toBe(true)
    expect(inv.notes).toContain(`Services for: Kaveri Traders (${child.clientCode})`)
  })
})

describe('quotation for a client under an organization', () => {
  it('snapshots the organization and records for_client; the screen shows the organization as the party', async () => {
    const q = await api('/api/quotations', { method: 'POST', body: {
      client_id: child.id, subject: 'Audit', quote_date: '2026-10-01', valid_until: '2026-10-31',
      client_snapshot: { name: 'Kaveri Traders', industry: 'Trading', location: '5 Anna Salai, Chennai' },
      items: [{ description: 'Audit', quantity_centi: 100, unit_rate_paise: 10_000_00, gst_rate_percent: 18 }],
    } })
    expect(q.status, JSON.stringify(q.body)).toBe(201)
    expect(q.body.client_id).toBe(child.id)
    expect(q.body.client_snapshot).toMatchObject({ name: 'Taxtable Partners LLP', industry: 'Trading', location: '12 MG Road, Bengaluru', for_client: { name: 'Kaveri Traders', client_id: child.clientCode } })
    expect(q.body.for_client).toEqual({ name: 'Kaveri Traders', client_id: child.clientCode })
    expect(q.body.party_name).toBe('Taxtable Partners LLP')
    expect(q.body.party_gstin).toBe(ORG_GSTIN)
    expect(q.body.party_address).toBe('12 MG Road, Bengaluru')
    expect(q.body.party_email).toBe('accounts@taxtable.in')
    expect(q.body.notes).toBe(`For: Kaveri Traders (${child.clientCode})`)

    // Saving again keeps exactly one "For:" line above the user's notes.
    const put = await api(`/api/quotations/${q.body.id}`, { method: 'PUT', body: {
      client_id: child.id, subject: 'Audit', quote_date: '2026-10-01', valid_until: '2026-10-31',
      notes: `${q.body.notes}\nValid for one year.`, client_snapshot: q.body.client_snapshot,
      items: [{ description: 'Audit', quantity_centi: 100, unit_rate_paise: 10_000_00, gst_rate_percent: 18 }],
    } })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    expect(put.body.notes).toBe(`For: Kaveri Traders (${child.clientCode})\nValid for one year.`)

    // Moved to a standalone client: the For: line and for_client go.
    const moved = await api(`/api/quotations/${q.body.id}`, { method: 'PUT', body: {
      client_id: standalone.id, subject: 'Audit', quote_date: '2026-10-01', valid_until: '2026-10-31',
      notes: put.body.notes, client_snapshot: put.body.client_snapshot,
      items: [{ description: 'Audit', quantity_centi: 100, unit_rate_paise: 10_000_00, gst_rate_percent: 18 }],
    } })
    expect(moved.status).toBe(200)
    expect(moved.body.notes).toBe('Valid for one year.')
    expect(moved.body.for_client).toBeNull()
    expect(moved.body.client_snapshot.for_client).toBeUndefined()
  })

  it("a quotation on the organization itself, or on a standalone client, is unchanged", async () => {
    const own = await api('/api/quotations', { method: 'POST', body: {
      client_id: org.id, subject: 'Tie-up', quote_date: '2026-10-01', valid_until: '2026-10-31',
      items: [{ description: 'Retainer', quantity_centi: 100, unit_rate_paise: 1_000_00, gst_rate_percent: 18 }],
    } })
    expect(own.status).toBe(201)
    expect(own.body.party_name).toBe('Taxtable Partners LLP')
    expect(own.body.for_client).toBeNull()
    expect(own.body.notes).toBeNull()
    const solo = await api('/api/quotations', { method: 'POST', body: {
      client_id: standalone.id, subject: 'Audit', quote_date: '2026-10-01', valid_until: '2026-10-31',
      items: [{ description: 'Audit', quantity_centi: 100, unit_rate_paise: 1_000_00, gst_rate_percent: 18 }],
    } })
    expect(solo.body.party_name).toBe('Solo Stores')
    expect(solo.body.for_client).toBeNull()
  })
})

describe("the organization's invoices", () => {
  it("include its clients' invoices when asked; a plain client filter stays per client", async () => {
    const o = await mkClient({ name: 'Agg Org', gstin: ORG_GSTIN, isOrg: true })
    const k1 = await mkClient({ name: 'Agg Kid 1', org: o.id })
    const k2 = await mkClient({ name: 'Agg Kid 2', org: o.id })
    const other = await mkClient({ name: 'Unrelated' })
    const ids: string[] = []
    for (const c of [o, k1, k2, other]) {
      const r = await api('/api/invoices', { method: 'POST', body: invoiceBody(c.id) })
      expect(r.status).toBe(201)
      ids.push(r.body.id)
    }
    const all = await api(`/api/invoices?client_id=${o.id}&include_organization_clients=true&limit=50`)
    expect(all.status).toBe(200)
    expect(all.body.items.map((i: { id: string }) => i.id).sort()).toEqual(ids.slice(0, 3).sort())
    expect(all.body.items.map((i: { client_name: string }) => i.client_name).sort()).toEqual(['Agg Kid 1', 'Agg Kid 2', 'Agg Org'])
    const own = await api(`/api/invoices?client_id=${o.id}`)
    expect(own.body.items.map((i: { id: string }) => i.id)).toEqual([ids[0]])
  })
})

describe('sending to the organization', () => {
  it("overdue reminders — manual and the daily run — go to the organization's email", async () => {
    const prev = env.publicAppUrl
    ;(env as { publicAppUrl: string | null }).publicAppUrl = 'https://app.test'
    try {
      const mail = vi.mocked(sendMail)
      const r = await api('/api/invoices', { method: 'POST', body: invoiceBody(child.id, { invoice_date: '2026-01-05', terms: 'due_on_receipt' }) })
      expect(r.status).toBe(201)
      expect((await api(`/api/invoices/${r.body.id}/send`, { method: 'POST' })).status).toBe(200)

      mail.mockClear()
      const manual = await api(`/api/invoices/${r.body.id}/remind`, { method: 'POST' })
      expect(manual.status, JSON.stringify(manual.body)).toBe(200)
      expect(manual.body.to).toEqual(['accounts@taxtable.in'])
      expect(mail.mock.calls[0][0]).toMatchObject({ to: ['accounts@taxtable.in'] })
      expect(String((mail.mock.calls[0][0] as { text: string }).text)).toMatch(/^Dear Tara,/)

      // A client with no email of its own still gets dunned via its organization.
      const quiet = await mkClient({ name: 'Quiet Kid', org: org.id })
      const q = await api('/api/invoices', { method: 'POST', body: invoiceBody(quiet.id, { invoice_date: '2026-01-05', terms: 'due_on_receipt' }) })
      expect((await api(`/api/invoices/${q.body.id}/send`, { method: 'POST' })).status).toBe(200)
      mail.mockClear()
      await runDunning()
      const toQuiet = await prisma.auditLog.findFirst({ where: { entityType: 'Invoice', entityId: q.body.id, action: { startsWith: 'invoice.reminder.' } } })
      expect(toQuiet).not.toBeNull()
      expect(JSON.parse(toQuiet!.afterJson ?? '{}').to).toEqual(['accounts@taxtable.in'])
    } finally {
      ;(env as { publicAppUrl: string | null }).publicAppUrl = prev
    }
  })
})
