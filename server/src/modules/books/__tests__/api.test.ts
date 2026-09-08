import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from './helpers.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'

/**
 * HTTP-level tests: the real Express app, real cookies, real RBAC. These
 * assert what a client can reach, not what a service function does.
 */
let server: Server
let base = ''

async function seedRole(code: keyof typeof MATRIX) {
  for (const g of MATRIX[code]) {
    await prisma.permission.upsert({ where: { code: g.permission }, update: {}, create: { id: `perm-${g.permission}`, code: g.permission, description: g.permission } })
  }
  const role = await prisma.role.upsert({ where: { code }, update: {}, create: { id: `role-${code}`, code, name: code } })
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
  for (const g of MATRIX[code]) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: `perm-${g.permission}`, scope: g.scope } }).catch(() => undefined)
  }
  return role
}

async function user(orgId: string, roleId: string) {
  const u = await prisma.user.create({ data: { id: uid('u'), organisationId: orgId, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId } })
  return { ...u, cookie: `ao_access=${signToken(u.id)}` }
}

async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('Books API', () => {
  it('is closed to unauthenticated callers and to roles without a books grant', async () => {
    expect((await api('/api/books')).status).toBe(401)
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const hr = await user(org.id, (await seedRole('hr_admin')).id)   // hr_admin has no books.* grant
    expect((await api('/api/books', { cookie: hr.cookie })).status).toBe(403)
  })

  it('runs a full cycle over HTTP: create books, contact, invoice, post, pay, report', async () => {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const md = await user(org.id, (await seedRole('md')).id)
    const cookie = md.cookie

    const created = await api('/api/books', { method: 'POST', cookie, body: { name: 'Client A Books', gstin: '33AAACS1234A1Z5', state_code: '33' } })
    expect(created.status).toBe(201)
    const orgId = created.body.data.id
    expect(created.body.data.base_currency).toBe('INR')

    const list = await api('/api/books', { cookie })
    expect(list.body.data.items.map((o: { id: string }) => o.id)).toContain(orgId)

    const ledgers = await api(`/api/books/${orgId}/chart/ledgers`, { cookie })
    expect(ledgers.body.data.items.length).toBeGreaterThan(30)
    expect(ledgers.body.data.items.every((l: { root_category: string }) => ['asset', 'liability', 'equity', 'income', 'expense'].includes(l.root_category))).toBe(true)
    const cash = ledgers.body.data.items.find((l: { system_key: string }) => l.system_key === 'cash')

    const taxes = await api(`/api/books/${orgId}/tax-rates?type=gst`, { cookie })
    const gst18 = taxes.body.data.items.find((t: { name: string }) => t.name === 'GST 18%')

    const contact = await api(`/api/books/${orgId}/contacts`, { method: 'POST', cookie, body: { type: 'customer', display_name: 'Sharma Traders', gstin: '33AAACS1234A1Z5' } })
    expect(contact.status).toBe(201)

    const bad = await api(`/api/books/${orgId}/contacts`, { method: 'POST', cookie, body: { type: 'customer', display_name: 'Bad', gstin: 'nope' } })
    expect(bad.status).toBe(422)
    expect(bad.body.error.code).toBe('invalid_gstin')

    const inv = await api(`/api/books/${orgId}/documents/invoice`, { method: 'POST', cookie, body: { contact_id: contact.body.data.id, date: '2026-04-01', lines: [{ description: 'Audit fee', rate: 100000, tax_rate_id: gst18.id }] } })
    expect(inv.status).toBe(201)
    expect(inv.body.data.total).toBe(118000)      // BigInt paise serialised as a number
    expect(inv.body.data.cgst_total).toBe(9000)

    const posted = await api(`/api/books/${orgId}/documents/invoice/${inv.body.data.id}/post`, { method: 'POST', cookie })
    expect(posted.body.data.status).toBe('posted')

    const detail = await api(`/api/books/${orgId}/documents/invoice/${inv.body.data.id}`, { cookie })
    expect(detail.body.data.journal.lines.length).toBe(4)
    expect(detail.body.data.open_item.balance).toBe(118000)
    expect(detail.body.data.audit.map((a: { action: string }) => a.action)).toEqual(['invoice.created', 'invoice.posted'])

    const pay = await api(`/api/books/${orgId}/payments/received`, { method: 'POST', cookie, body: { contact_id: contact.body.data.id, date: '2026-04-10', amount: 118000, deposit_ledger_id: cash.id, allocations: [{ document_id: inv.body.data.id, amount: 118000 }] } })
    expect(pay.status).toBe(201)
    expect((await api(`/api/books/${orgId}/documents/invoice/${inv.body.data.id}`, { cookie })).body.data.document.status).toBe('paid')

    const tb = await api(`/api/books/${orgId}/reports/trial-balance?as_of=2026-04-30`, { cookie })
    expect(tb.body.data.totals.debit).toBe(tb.body.data.totals.credit)
    const dash = await api(`/api/books/${orgId}/dashboard`, { cookie })
    expect(dash.body.data.receivables.total).toBe(0)
    expect(dash.body.data.cash.find((a: { id: string }) => a.id === cash.id).balance).toBe(118000)

    const over = await api(`/api/books/${orgId}/payments/received`, { method: 'POST', cookie, body: { contact_id: contact.body.data.id, date: '2026-04-11', amount: 100, deposit_ledger_id: cash.id, allocations: [{ document_id: inv.body.data.id, amount: 100 }] } })
    expect(over.status).toBe(422)
    expect(over.body.error.code).toBe('bill_closed')
  })

  it('scopes every route to the caller: another firm 404, a non-member 403, a staff member no settings', async () => {
    const firm1 = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm 1' } })
    const firm2 = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm 2' } })
    const mdRole = (await seedRole('md')).id
    const empRole = (await seedRole('employee')).id
    const partner1 = await user(firm1.id, mdRole)
    const partner2 = await user(firm2.id, mdRole)
    const staff = await user(firm1.id, empRole)

    const a = (await api('/api/books', { method: 'POST', cookie: partner1.cookie, body: { name: 'Firm1 Client' } })).body.data
    const b = (await api('/api/books', { method: 'POST', cookie: partner2.cookie, body: { name: 'Firm2 Client' } })).body.data

    // Another firm's books: not found, at every entry point.
    for (const path of [`/api/books/${b.id}`, `/api/books/${b.id}/contacts`, `/api/books/${b.id}/reports/trial-balance`, `/api/books/${b.id}/journals`]) {
      expect((await api(path, { cookie: partner1.cookie })).status).toBe(404)
    }
    expect((await api(`/api/books/${b.id}/contacts`, { method: 'POST', cookie: partner1.cookie, body: { type: 'customer', display_name: 'X' } })).status).toBe(404)
    expect((await api('/api/books', { cookie: partner2.cookie })).body.data.items.map((o: { id: string }) => o.id)).toEqual([b.id])

    // Same firm, employee role (books.access at self scope) but not a member.
    expect((await api(`/api/books/${a.id}`, { cookie: staff.cookie })).status).toBe(403)
    expect((await api('/api/books', { cookie: staff.cookie })).body.data.items).toEqual([])
    // Added as staff: can read and write documents, but not settings, reports or journals.
    await api(`/api/books/${a.id}/members`, { method: 'POST', cookie: partner1.cookie, body: { user_id: staff.id, role: 'staff' } })
    expect((await api(`/api/books/${a.id}`, { cookie: staff.cookie })).body.data.my_role).toBe('staff')
    expect((await api(`/api/books/${a.id}/contacts`, { cookie: staff.cookie })).status).toBe(200)
    expect((await api(`/api/books/${a.id}/contacts`, { method: 'POST', cookie: staff.cookie, body: { type: 'customer', display_name: 'Staff created' } })).status).toBe(201)
    expect((await api(`/api/books/${a.id}/reports/trial-balance`, { cookie: staff.cookie })).status).toBe(403)
    expect((await api(`/api/books/${a.id}/members`, { cookie: staff.cookie })).status).toBe(403)
    expect((await api(`/api/books/${a.id}/chart/ledgers`, { method: 'POST', cookie: staff.cookie, body: { name: 'Sneaky', group_id: 'x' } })).status).toBe(403)
    expect((await api(`/api/books/${a.id}/journals`, { method: 'POST', cookie: staff.cookie, body: { date: '2026-04-01', lines: [] } })).status).toBe(403)
    // A viewer cannot write at all.
    await api(`/api/books/${a.id}/members`, { method: 'POST', cookie: partner1.cookie, body: { user_id: staff.id, role: 'viewer' } })
    expect((await api(`/api/books/${a.id}/contacts`, { method: 'POST', cookie: staff.cookie, body: { type: 'customer', display_name: 'Nope' } })).status).toBe(403)
    expect((await api(`/api/books/${a.id}/contacts`, { cookie: staff.cookie })).status).toBe(200)
  })

  it('refuses to edit a posted document and returns a readable error', async () => {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const md = await user(org.id, (await seedRole('md')).id)
    const cookie = md.cookie
    const books = (await api('/api/books', { method: 'POST', cookie, body: { name: 'Books', state_code: '33', gstin: '33AAACS1234A1Z5' } })).body.data
    const contact = (await api(`/api/books/${books.id}/contacts`, { method: 'POST', cookie, body: { type: 'customer', display_name: 'C' } })).body.data
    const inv = (await api(`/api/books/${books.id}/documents/invoice`, { method: 'POST', cookie, body: { contact_id: contact.id, date: '2026-04-01', lines: [{ description: 'x', rate: 1000 }] } })).body.data
    await api(`/api/books/${books.id}/documents/invoice/${inv.id}/post`, { method: 'POST', cookie })
    const edit = await api(`/api/books/${books.id}/documents/invoice/${inv.id}`, { method: 'PATCH', cookie, body: { contact_id: contact.id, date: '2026-04-01', lines: [{ description: 'y', rate: 9999 }] } })
    expect(edit.status).toBe(422)
    expect(edit.body.error.code).toBe('not_editable')
    expect(edit.body.error.message).toMatch(/void it and raise a new one/i)
    const voided = await api(`/api/books/${books.id}/documents/invoice/${inv.id}/void`, { method: 'POST', cookie, body: { reason: 'error' } })
    expect(voided.body.data.status).toBe('void')
    const journals = (await api(`/api/books/${books.id}/journals`, { cookie })).body.data.items
    expect(journals.filter((j: { source_id: string }) => j.source_id === inv.id).length).toBe(2)
  })
})
