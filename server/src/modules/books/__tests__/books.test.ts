import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { resetBooksConfigForTests } from '../config.js'
import { clearBooksCacheForTests, setBooksFetchForTests } from '../client.js'

/**
 * Books over a fake Zoho: the real Express app, real RBAC and Postgres, with
 * only the two HTTP seams (OAuth token endpoint, Books REST API) replaced.
 * The fake records every call so tests can assert what reached "Zoho".
 */
process.env.ZBOOKS_CLIENT_ID = 'test-client'
process.env.ZBOOKS_CLIENT_SECRET = 'test-secret'
process.env.ZBOOKS_ACCOUNTS_BASE = 'https://accounts.zoho.in'
process.env.ZBOOKS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.ZBOOKS_RATE_PER_MINUTE = '10000'
resetBooksConfigForTests()

type Handler = (url: URL, init: RequestInit) => { status?: number; json?: unknown; body?: Buffer } | undefined
interface Call { method: string; url: URL; body?: unknown; auth?: string }
let calls: Call[] = []
let oauthCalls: Record<string, string>[] = []
let overrides: Handler[] = []
let tokenSeq = 0
let refreshResponse: () => unknown = () => ({ access_token: `access-${++tokenSeq}`, expires_in: 3600, scope: 'ZohoBooks.fullaccess.all', token_type: 'Bearer' })

const today = new Date().toISOString().slice(0, 10)
const longAgo = '2020-01-01'
const INVOICES = [
  { invoice_id: '1001', invoice_number: 'INV-1', customer_id: '11', customer_name: 'Acme', date: today, due_date: longAgo, total: 1000, balance: 400, status: 'overdue', currency_code: 'INR' },
  { invoice_id: '1002', invoice_number: 'INV-2', customer_id: '12', customer_name: 'Beta', date: today, due_date: '2999-01-01', total: 500, balance: 500, status: 'sent', currency_code: 'INR' },
  { invoice_id: '1003', invoice_number: 'INV-3', customer_id: '12', customer_name: 'Beta', date: today, due_date: today, total: 300, balance: 0, status: 'void', currency_code: 'INR' },
]

function zoho(url: URL, init: RequestInit): { status?: number; json?: unknown; body?: Buffer } {
  for (const o of overrides) { const r = o(url, init); if (r) return r }
  const p = url.pathname.replace('/books/v3/', '')
  const m = init.method ?? 'GET'
  const page = { page: 1, per_page: 200, has_more_page: false }
  if (p === 'organizations') return { json: { code: 0, organizations: [{ organization_id: '900', name: 'Acme Books', currency_code: 'INR' }, { organization_id: '901', name: 'Beta Books', currency_code: 'INR' }] } }
  if (p === 'contacts' && m === 'GET') return { json: { code: 0, contacts: [{ contact_id: '11', contact_name: 'Acme', outstanding_receivable_amount: 400 }], page_context: { ...page, per_page: 25 } } }
  if (p === 'invoices' && m === 'GET') {
    const f = url.searchParams.get('filter_by')
    const rows = f ? INVOICES.filter((i) => i.status !== 'void') : INVOICES
    return { json: { code: 0, invoices: rows, page_context: page } }
  }
  if (p === 'invoices' && m === 'POST') {
    const b = JSON.parse(String(init.body))
    if (b.invoice_number === 'DUP') return { status: 400, json: { code: 1001, message: 'Invoice "DUP" already exists.' } }
    return { status: 201, json: { code: 0, message: 'The invoice has been created.', invoice: { invoice_id: '2001', invoice_number: 'INV-9', ...b } } }
  }
  if (/^invoices\/\d+$/.test(p) && url.searchParams.get('accept') === 'pdf') return { body: Buffer.from('%PDF-1.4 fake') }
  if (/^invoices\/\d+$/.test(p)) return { json: { code: 0, invoice: INVOICES[0] } }
  if (/^invoices\/\d+\/status\/void$/.test(p)) return { json: { code: 0, message: 'Invoice has been voided.' } }
  if (['bills', 'expenses', 'customerpayments', 'vendorpayments'].includes(p)) return { json: { code: 0, [p]: [], page_context: page } }
  if (p === 'bankaccounts') return { json: { code: 0, bankaccounts: [{ account_id: '5', account_name: 'HDFC', balance: 2500, is_active: true }], page_context: page } }
  return { status: 404, json: { code: 404, message: 'not found in fake' } }
}

async function fakeHttp(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url)
  if (u.pathname === '/oauth/v2/token/revoke') { calls.push({ method: 'REVOKE', url: u }); return new Response('{}', { status: 200 }) }
  const headers = init.headers as Record<string, string> | undefined
  calls.push({ method: init.method ?? 'GET', url: u, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined, auth: headers?.Authorization })
  const r = zoho(u, init)
  if (r.body) return new Response(r.body, { status: r.status ?? 200, headers: { 'Content-Type': 'application/pdf' } })
  return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } })
}

async function fakeOAuth(_url: string, init: { body?: URLSearchParams }) {
  const params = Object.fromEntries(init.body ?? new URLSearchParams())
  oauthCalls.push(params)
  const json = params.grant_type === 'authorization_code'
    ? (params.code === 'bad' ? { error: 'invalid_code' } : { access_token: 'access-0', refresh_token: 'refresh-SECRET-0', expires_in: 3600, scope: 'ZohoBooks.fullaccess.all', token_type: 'Bearer', api_domain: 'https://www.zohoapis.in' })
    : refreshResponse()
  return { ok: true, status: 200, json: async () => json }
}

let server: Server
let base = ''
let firmId = ''
let admin = { id: '', cookie: '' }
let employee = { id: '', cookie: '' }

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
async function mkUser(roleId: string) {
  const u = await prisma.user.create({ data: { id: uid('u'), organisationId: firmId, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId } })
  return { id: u.id, cookie: `ao_access=${signToken(u.id)}` }
}
async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body, text, location: res.headers.get('location') }
}
async function mkClient(name: string) {
  return prisma.client.create({ data: { id: uid('cli'), organisationId: firmId, clientCode: uid('CLI'), companyName: name, contactPerson: 'C', contactNumber: '9840011111', accountManagerId: uid('emp'), onboardingDate: '2026-01-01' } })
}

/** Connect end-to-end through the real routes; returns the activated org ref. */
async function connectAndActivate(): Promise<string> {
  const start = await api('/api/books/connect', { method: 'POST', cookie: admin.cookie })
  const state = new URL(start.body.data.authorizeUrl).searchParams.get('state')!
  const cb = await api(`/api/books/callback?code=good&state=${encodeURIComponent(state)}&accounts-server=${encodeURIComponent('https://accounts.zoho.in')}`)
  expect(cb.location).toContain('zoho=connected')
  const org = await prisma.booksZohoOrganization.findFirstOrThrow({ where: { organisationId: firmId, zohoOrgId: '900' } })
  const r = await api(`/api/books/organizations/${org.id}`, { method: 'PATCH', cookie: admin.cookie, body: { is_active: true } })
  expect(r.status).toBe(200)
  return org.id
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => { setBooksFetchForTests(null); server.close(); await prisma.$disconnect() })

beforeEach(async () => {
  calls = []; oauthCalls = []; overrides = []; tokenSeq = 0
  refreshResponse = () => ({ access_token: `access-${++tokenSeq}`, expires_in: 3600, scope: 'ZohoBooks.fullaccess.all', token_type: 'Bearer' })
  setBooksFetchForTests(fakeHttp, fakeOAuth as never)
  clearBooksCacheForTests()
  const firm = await prisma.organisation.create({ data: { id: uid('firm'), name: 'Firm' } })
  firmId = firm.id
  admin = await mkUser((await seedRole('finance_admin')).id)
  employee = await mkUser((await seedRole('employee')).id)
})

describe('Books — OAuth', () => {
  it('starts consent with a signed state and never exposes tokens', async () => {
    const r = await api('/api/books/connect', { method: 'POST', cookie: admin.cookie })
    expect(r.status).toBe(200)
    const url = new URL(r.body.data.authorizeUrl)
    expect(url.origin).toBe('https://accounts.zoho.in')
    expect(url.searchParams.get('client_id')).toBe('test-client')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('state')).toBeTruthy()
    expect(r.text).not.toContain('test-secret')

    await connectAndActivate()
    const st = await api('/api/books/status', { cookie: admin.cookie })
    expect(st.status).toBe(200)
    expect(st.body.data.organizations).toHaveLength(2)
    expect(st.body.data.connections[0].status).toBe('connected')
    expect(st.text).not.toMatch(/refresh-SECRET|access-0|Encrypted|test-secret/)
    const row = await prisma.booksZohoConnection.findFirstOrThrow({ where: { organisationId: firmId, status: 'connected' } })
    expect(row.refreshTokenEncrypted).not.toContain('refresh-SECRET')
  })

  it('rejects a forged or foreign state', async () => {
    const r = await api('/api/books/callback?code=good&state=not-a-jwt')
    expect(r.status).toBe(302)
    expect(r.location).toContain('reason=invalid_state')
  })

  it('records a refused code as an error, not a connection', async () => {
    const start = await api('/api/books/connect', { method: 'POST', cookie: admin.cookie })
    const state = new URL(start.body.data.authorizeUrl).searchParams.get('state')!
    const r = await api(`/api/books/callback?code=bad&state=${encodeURIComponent(state)}`)
    expect(r.location).toContain('reason=oauth_failed')
    const conn = await prisma.booksZohoConnection.findUniqueOrThrow({ where: { id: start.body.data.connectionId } })
    expect(conn.status).toBe('error')
    expect(conn.refreshTokenEncrypted).toBeNull()
  })

  it('ignores an untrusted accounts-server from the callback', async () => {
    const start = await api('/api/books/connect', { method: 'POST', cookie: admin.cookie })
    const state = new URL(start.body.data.authorizeUrl).searchParams.get('state')!
    await api(`/api/books/callback?code=good&state=${encodeURIComponent(state)}&accounts-server=${encodeURIComponent('https://evil.example.com')}`)
    const conn = await prisma.booksZohoConnection.findUniqueOrThrow({ where: { id: start.body.data.connectionId } })
    expect(conn.accountsServer).toBe('https://accounts.zoho.in')
  })

  it('refreshes an expired access token before calling Zoho', async () => {
    const ref = await connectAndActivate()
    await prisma.booksZohoConnection.updateMany({ where: { organisationId: firmId }, data: { accessTokenExpiresAt: new Date(Date.now() - 1000) } })
    const r = await api(`/api/books/o/${ref}/e/customers`, { cookie: admin.cookie })
    expect(r.status).toBe(200)
    expect(oauthCalls.some((c) => c.grant_type === 'refresh_token' && c.refresh_token === 'refresh-SECRET-0')).toBe(true)
    expect(calls.at(-1)!.auth).toBe('Zoho-oauthtoken access-1')
  })

  it('marks a revoked grant and asks for reconnect', async () => {
    const ref = await connectAndActivate()
    await prisma.booksZohoConnection.updateMany({ where: { organisationId: firmId }, data: { accessTokenExpiresAt: new Date(Date.now() - 1000) } })
    refreshResponse = () => ({ error: 'invalid_code' })
    const r = await api(`/api/books/o/${ref}/e/customers?search_text=zz`, { cookie: admin.cookie })
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('books_reconnect_required')
    const conn = await prisma.booksZohoConnection.findFirstOrThrow({ where: { organisationId: firmId, connectedAt: { not: null } } })
    expect(conn.status).toBe('revoked')
    // And every later call short-circuits until the user reconnects.
    const again = await api(`/api/books/o/${ref}/e/customers`, { cookie: admin.cookie })
    expect(again.status).toBe(409)
  })

  it('retries once with a fresh token when Zoho answers 401', async () => {
    const ref = await connectAndActivate()
    let first = true
    overrides.push((url) => {
      if (url.pathname.endsWith('/items') && first) { first = false; return { status: 401, json: { code: 57, message: 'You are not authorized to perform this operation' } } }
      return url.pathname.endsWith('/items') ? { json: { code: 0, items: [], page_context: {} } } : undefined
    })
    const r = await api(`/api/books/o/${ref}/e/items`, { cookie: admin.cookie })
    expect(r.status).toBe(200)
    expect(oauthCalls.filter((c) => c.grant_type === 'refresh_token')).toHaveLength(1)
  })

  it('disconnect revokes at Zoho, wipes tokens and closes the organisation', async () => {
    const ref = await connectAndActivate()
    const conn = await prisma.booksZohoConnection.findFirstOrThrow({ where: { organisationId: firmId, status: 'connected' } })
    const r = await api(`/api/books/connections/${conn.id}/disconnect`, { method: 'POST', cookie: admin.cookie })
    expect(r.status).toBe(200)
    expect(calls.some((c) => c.method === 'REVOKE')).toBe(true)
    const after = await prisma.booksZohoConnection.findUniqueOrThrow({ where: { id: conn.id } })
    expect(after.status).toBe('disconnected')
    expect(after.refreshTokenEncrypted).toBeNull()
    expect((await api(`/api/books/o/${ref}/dashboard`, { cookie: admin.cookie })).status).toBe(404)
    expect(await prisma.auditLog.count({ where: { action: 'books.zoho.disconnected', entityId: conn.id } })).toBe(1)
  })
})

describe('Books — connect with a Self Client code', () => {
  it('exchanges a pasted code without a redirect URI and lists organisations', async () => {
    expect((await api('/api/books/connect/code', { method: 'POST', cookie: admin.cookie, body: { code: 'not-a-code' } })).status).toBe(400)
    expect((await api('/api/books/connect/code', { method: 'POST', cookie: employee.cookie, body: { code: '1000.' + 'a'.repeat(30) } })).status).toBe(403)
    const r = await api('/api/books/connect/code', { method: 'POST', cookie: admin.cookie, body: { code: '1000.' + 'a'.repeat(30), data_center: 'https://accounts.zoho.in' } })
    expect(r.status).toBe(200)
    expect(r.body.data.organizations).toBe(2)
    const exchange = oauthCalls.find((c) => c.grant_type === 'authorization_code')!
    expect(exchange.code).toBe('1000.' + 'a'.repeat(30))
    expect(exchange).not.toHaveProperty('redirect_uri')
    const conn = await prisma.booksZohoConnection.findUniqueOrThrow({ where: { id: r.body.data.connectionId } })
    expect(conn.status).toBe('connected')
    expect(conn.refreshTokenEncrypted).not.toContain('refresh-SECRET')
    expect(r.text).not.toMatch(/refresh-SECRET|access-0|test-secret/)
  })
})

describe('Books — permissions and organisations', () => {
  it('an employee cannot open Books', async () => {
    expect((await api('/api/books/status', { cookie: employee.cookie })).status).toBe(403)
  })

  it('maps a client to one organisation only', async () => {
    const ref = await connectAndActivate()
    const other = await prisma.booksZohoOrganization.findFirstOrThrow({ where: { organisationId: firmId, zohoOrgId: '901' } })
    const client = await mkClient('Acme Pvt Ltd')
    expect((await api(`/api/books/organizations/${ref}`, { method: 'PATCH', cookie: admin.cookie, body: { client_id: client.id } })).status).toBe(200)
    const dup = await api(`/api/books/organizations/${other.id}`, { method: 'PATCH', cookie: admin.cookie, body: { client_id: client.id } })
    expect(dup.status).toBe(409)
    expect(dup.body.error.code).toBe('books_client_already_mapped')
  })

  it('an inactive organisation is not addressable', async () => {
    await connectAndActivate()
    const other = await prisma.booksZohoOrganization.findFirstOrThrow({ where: { organisationId: firmId, zohoOrgId: '901' } })
    expect((await api(`/api/books/o/${other.id}/e/invoices`, { cookie: admin.cookie })).status).toBe(404)
  })
})

describe('Books — resources', () => {
  it('lists customers with server-side filters and the organisation id', async () => {
    const ref = await connectAndActivate()
    const r = await api(`/api/books/o/${ref}/e/customers?search_text=acme&page=2&per_page=25&evil=1`, { cookie: admin.cookie })
    expect(r.status).toBe(200)
    expect(r.body.data.items[0].contact_name).toBe('Acme')
    const q = calls.at(-1)!.url.searchParams
    expect(q.get('organization_id')).toBe('900')
    expect(q.get('contact_type')).toBe('customer')
    expect(q.get('search_text')).toBe('acme')
    expect(q.get('page')).toBe('2')
    expect(q.has('evil')).toBe(false)
  })

  it('creates an invoice in Zoho and audits it', async () => {
    const ref = await connectAndActivate()
    const r = await api(`/api/books/o/${ref}/e/invoices`, { method: 'POST', cookie: admin.cookie, body: { customer_id: '11', line_items: [{ item_id: '1', quantity: 1, rate: 100 }], organization_id: 'other' } })
    expect(r.status).toBe(201)
    expect(r.body.data.invoice_id).toBe('2001')
    const sent = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/invoices'))!
    expect((sent.body as Record<string, unknown>).organization_id).toBeUndefined()
    expect(sent.url.searchParams.get('organization_id')).toBe('900')
    expect(await prisma.auditLog.count({ where: { action: 'books.invoices.created', entityId: '2001' } })).toBe(1)
  })

  it('surfaces a Zoho validation error without pretending success', async () => {
    const ref = await connectAndActivate()
    const r = await api(`/api/books/o/${ref}/e/invoices`, { method: 'POST', cookie: admin.cookie, body: { customer_id: '11', invoice_number: 'DUP' } })
    expect(r.status).toBe(422)
    expect(r.body.error.message).toContain('already exists')
    expect(calls.find((c) => c.method === 'POST')!.url.searchParams.get('ignore_auto_number_generation')).toBe('true')
  })

  it('runs a status action and streams a PDF', async () => {
    const ref = await connectAndActivate()
    expect((await api(`/api/books/o/${ref}/e/invoices/1001/a/void`, { method: 'POST', cookie: admin.cookie })).status).toBe(200)
    const pdf = await fetch(`${base}/api/books/o/${ref}/e/invoices/1001/pdf`, { headers: { Cookie: admin.cookie } })
    expect(pdf.headers.get('content-type')).toBe('application/pdf')
    expect((await pdf.text()).startsWith('%PDF')).toBe(true)
  })

  it('rejects unknown resources, actions and malformed ids before calling Zoho', async () => {
    const ref = await connectAndActivate()
    const before = calls.length
    expect((await api(`/api/books/o/${ref}/e/journals`, { cookie: admin.cookie })).status).toBe(404)
    expect((await api(`/api/books/o/${ref}/e/invoices/..%2Fsettings`, { cookie: admin.cookie })).status).toBe(400)
    expect((await api(`/api/books/o/${ref}/e/invoices/1/a/explode`, { method: 'POST', cookie: admin.cookie })).status).toBe(404)
    expect(calls.length).toBe(before)
  })

  it('maps Zoho outages to a clean error', async () => {
    const ref = await connectAndActivate()
    overrides.push((url) => (url.pathname.endsWith('/vendorpayments') ? { status: 503, json: { code: 1, message: 'internal stack trace here' } } : undefined))
    const r = await api(`/api/books/o/${ref}/e/vendorpayments`, { cookie: admin.cookie })
    expect(r.status).toBe(502)
    expect(r.text).not.toContain('stack trace')
    // GETs are retried: 1 + 2 retries.
    expect(calls.filter((c) => c.url.pathname.endsWith('/vendorpayments'))).toHaveLength(3)
  })
})

describe('Books — sync, dashboard and reports', () => {
  it('computes the dashboard from Zoho records and logs the sync', async () => {
    const ref = await connectAndActivate()
    const r = await api(`/api/books/o/${ref}/sync`, { method: 'POST', cookie: admin.cookie })
    expect(r.status).toBe(200)
    const s = r.body.data.snapshot
    expect(s.totals.receivables).toBe(900)
    expect(s.totals.overdue_receivables).toBe(400)
    expect(s.counts.outstanding_invoices).toBe(2)
    expect(s.totals.revenue).toBe(1500)
    expect(s.totals.bank_balance).toBe(2500)
    const logs = await api(`/api/books/o/${ref}/sync-logs`, { cookie: admin.cookie })
    expect(logs.body.data.items[0].status).toBe('succeeded')
    expect(logs.body.data.items[0].api_calls).toBeGreaterThan(0)
    // A fresh snapshot is served without calling Zoho again.
    const n = calls.length
    const d = await api(`/api/books/o/${ref}/dashboard`, { cookie: admin.cookie })
    expect(d.body.data.snapshot.totals.receivables).toBe(900)
    expect(calls.length).toBe(n)
  })

  it('refuses a second concurrent sync', async () => {
    const ref = await connectAndActivate()
    await prisma.booksZohoOrganization.update({ where: { id: ref }, data: { syncStatus: 'syncing', lastSyncAttemptAt: new Date() } })
    const r = await api(`/api/books/o/${ref}/sync`, { method: 'POST', cookie: admin.cookie })
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('books_sync_in_progress')
  })

  it('records a failed sync and succeeds on retry', async () => {
    const ref = await connectAndActivate()
    overrides.push((url) => (url.pathname.endsWith('/bankaccounts') ? { status: 400, json: { code: 5, message: 'Invalid URL' } } : undefined))
    const r = await api(`/api/books/o/${ref}/sync`, { method: 'POST', cookie: admin.cookie })
    expect(r.status).toBe(422)
    const org = await prisma.booksZohoOrganization.findUniqueOrThrow({ where: { id: ref } })
    expect(org.syncStatus).toBe('failed')
    expect(org.lastSyncError).toBeTruthy()
    overrides = []
    expect((await api(`/api/books/o/${ref}/sync`, { method: 'POST', cookie: admin.cookie })).status).toBe(200)
  })

  it('computes available reports and refuses to fake the rest', async () => {
    const ref = await connectAndActivate()
    const ageing = await api(`/api/books/o/${ref}/reports/receivables_ageing`, { cookie: admin.cookie })
    expect(ageing.body.data.source).toBe('computed')
    expect(ageing.body.data.totals.total).toBe(900)
    const pl = await api(`/api/books/o/${ref}/reports/profit_and_loss`, { cookie: admin.cookie })
    expect(pl.body.data.source).toBe('unavailable')
    expect(pl.body.data.rows).toHaveLength(0)
    expect(pl.body.data.note).toContain('not available through the current Zoho Books API integration')
  })
})
