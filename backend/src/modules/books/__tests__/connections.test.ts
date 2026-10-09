import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { encryptToken } from '../../zpay/crypto.js'
import { booksConfig, resetBooksConfigForTests } from '../config.js'
import { clearBooksCacheForTests, setBooksFetchForTests } from '../client.js'
import { addConfiguredConnection, nameUnnamedConnections } from '../connection.js'
import { runBooksSyncPass } from '../scheduler.js'

/**
 * Pre-configured Zoho Books connections: three accounts, each with its own
 * client, refresh token and organisation. The fake Zoho only accepts an
 * account's own tokens for its own organisation, so any cross-connection
 * mix-up fails loudly.
 */
process.env.ZBOOKS_CLIENT_ID = 'cid-main' // the server-wide client the legacy Main Account uses
process.env.ZBOOKS_CLIENT_SECRET = 'sec-main'
process.env.ZBOOKS_ACCOUNTS_BASE = 'https://accounts.zoho.in'
process.env.ZBOOKS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.ZBOOKS_RATE_PER_MINUTE = '10000'
delete process.env.BOOKS_SELF_SERVICE_CONNECT
resetBooksConfigForTests()

// account → its client, refresh token and the one organisation it owns
const ACCOUNTS = {
  main: { clientId: 'cid-main', secret: 'sec-main', refresh: 'rt-main', org: { organization_id: '800', name: 'Meridian Logistics' } },
  testing: { clientId: 'cid-test', secret: 'sec-test', refresh: 'rt-test', org: { organization_id: '810', name: 'Test Company' } },
  client: { clientId: 'cid-client', secret: 'sec-client', refresh: 'rt-client', org: { organization_id: '820', name: 'ABC Pvt Ltd' } },
} as const
type Acct = keyof typeof ACCOUNTS
let seq = 0
const tokenOwner = new Map<string, Acct>()
let refreshes: { client_id: string; refresh_token: string }[] = []
let calls: { acct: Acct | undefined; org: string | null; path: string }[] = []

// An account added from the Settings form with a generated code.
const FRESH = { clientId: '1000.FRESHCLIENT0123456789', secret: 'freshsecret0123456789abcdef', code: '1000.aaaabbbbccccddddeeeeffff00001111.2222333344445555666677778888999a', org: { organization_id: '830', name: 'Kaarthi-DV' } }

async function fakeOAuth(_url: string, init: { body?: URLSearchParams }) {
  const p = Object.fromEntries(init.body ?? new URLSearchParams())
  if (p.grant_type === 'authorization_code') {
    if (p.code !== FRESH.code || p.client_id !== FRESH.clientId || p.client_secret !== FRESH.secret) return { ok: true, status: 200, json: async () => ({ error: 'invalid_code' }) }
    const token = `access-fresh-${++seq}`
    tokenOwner.set(token, 'fresh' as Acct)
    return { ok: true, status: 200, json: async () => ({ access_token: token, refresh_token: 'rt-fresh', expires_in: 3600, api_domain: 'https://www.zohoapis.in', token_type: 'Bearer' }) }
  }
  refreshes.push({ client_id: p.client_id, refresh_token: p.refresh_token })
  const acct = (Object.keys(ACCOUNTS) as Acct[]).find((k) => ACCOUNTS[k].refresh === p.refresh_token)
  // A refresh token only works with the client it was issued to.
  if (!acct || ACCOUNTS[acct].clientId !== p.client_id || ACCOUNTS[acct].secret !== p.client_secret) {
    return { ok: true, status: 200, json: async () => ({ error: 'invalid_client' }) }
  }
  const token = `access-${acct}-${++seq}`
  tokenOwner.set(token, acct)
  return { ok: true, status: 200, json: async () => ({ access_token: token, expires_in: 3600, api_domain: 'https://www.zohoapis.in', token_type: 'Bearer' }) }
}

async function fakeHttp(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url)
  const auth = String((init.headers as Record<string, string>)?.Authorization ?? '').replace('Zoho-oauthtoken ', '')
  const acct = tokenOwner.get(auth)
  const path = u.pathname.replace('/books/v3/', '')
  const orgId = u.searchParams.get('organization_id')
  calls.push({ acct, org: orgId, path })
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  if (!acct) return json(401, { code: 14, message: 'Invalid OAuth token' })
  if ((acct as string) === 'fresh') return path === 'organizations' ? json(200, { code: 0, organizations: [FRESH.org] }) : json(200, { code: 0 })
  if (path === 'organizations') return json(200, { code: 0, organizations: [ACCOUNTS[acct].org] })
  // An account may only read its own organisation.
  if (orgId !== ACCOUNTS[acct].org.organization_id) return json(403, { code: 57, message: 'not authorised for this organisation' })
  const page = { page: 1, per_page: 200, has_more_page: false }
  if (path === 'invoices') return json(200, { code: 0, invoices: [{ invoice_id: '1', invoice_number: `INV-${acct}`, customer_name: ACCOUNTS[acct].org.name, total: 100, balance: 0, status: 'paid', date: '2026-09-01', due_date: '2026-09-30' }], page_context: page })
  if (path === 'bankaccounts') return json(200, { code: 0, bankaccounts: [], page_context: page })
  return json(200, { code: 0, [path]: [], page_context: page })
}

let server: Server
let base = ''
let firmId = ''
let staff = ''
let superAdmin = ''
const refs: Record<Acct, string> = { main: '', testing: '', client: '' }

async function api(path: string, opts: { method?: string; body?: unknown; as?: string } = {}) {
  const res = await fetch(`${base}${path}`, { method: opts.method ?? 'GET', headers: { 'Content-Type': 'application/json', Cookie: opts.as ?? staff }, body: opts.body ? JSON.stringify(opts.body) : undefined })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, text }
}

beforeAll(async () => {
  setBooksFetchForTests(fakeHttp as never, fakeOAuth as never)
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const a = server.address()
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
  firmId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  // Staff with Books via the Tools module who see every client (clients.view_all) —
  // these organisations are not mapped to a client, and assignment-scoped
  // staff only see their own clients' books (client-assignment-scope.test.ts).
  for (const g of MATRIX.employee) await prisma.permission.upsert({ where: { code: g.permission }, update: {}, create: { id: `perm-${g.permission}`, code: g.permission, description: g.permission } })
  const role = await prisma.role.upsert({ where: { code: 'employee' }, update: {}, create: { id: 'role-employee', code: 'employee', name: 'employee' } })
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
  for (const code of ['books.access', 'books.manage', 'books.reports', 'books.settings', 'clients.view_all']) {
    await prisma.permission.upsert({ where: { code }, update: {}, create: { id: `perm-${code}`, code, description: code } })
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: `perm-${code}`, scope: 'organisation' } })
  }
  const u = await prisma.user.create({ data: { id: uid('u'), organisationId: firmId, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: role.id } })
  staff = `ao_access=${signToken(u.id)}`
  const mdRole = await prisma.role.upsert({ where: { code: 'md' }, update: {}, create: { id: 'role-md', code: 'md', name: 'md' } })
  await prisma.rolePermission.deleteMany({ where: { roleId: mdRole.id } })
  for (const code of ['books.access', 'books.settings', 'clients.view_all']) await prisma.rolePermission.create({ data: { roleId: mdRole.id, permissionId: `perm-${code}`, scope: 'organisation' } })
  const md = await prisma.user.create({ data: { id: uid('u'), organisationId: firmId, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: mdRole.id } })
  superAdmin = `ao_access=${signToken(md.id)}`

  // Main Account: an existing connection from before (server-wide client, no name yet).
  const key = booksConfig().encryptionKey
  const main = await prisma.booksZohoConnection.create({
    data: { organisationId: firmId, status: 'connected', refreshTokenEncrypted: encryptToken('rt-main', key), accountsServer: 'https://accounts.zoho.in', apiDomain: 'https://www.zohoapis.in', scopesGranted: [], connectedAt: new Date() },
  })
  const mainOrg = await prisma.booksZohoOrganization.create({ data: { organisationId: firmId, connectionId: main.id, zohoOrgId: '800', name: 'Meridian Logistics', isActive: true } })
  refs.main = mainOrg.id
  await nameUnnamedConnections()
  expect((await prisma.booksZohoConnection.findUniqueOrThrow({ where: { id: main.id } })).name).toBe('Main Account') // tokens untouched, just named

  // Testing and Client accounts: configured by the developer with their own clients.
  for (const [acct, name, method] of [['testing', 'Testing Account', 'SELF_CLIENT'], ['client', 'Client Account', 'SERVER_OAUTH']] as const) {
    const r = await addConfiguredConnection({
      organisationId: firmId, name, authMethod: method, clientId: ACCOUNTS[acct].clientId, clientSecret: ACCOUNTS[acct].secret,
      refreshToken: ACCOUNTS[acct].refresh, accountsServer: 'https://accounts.zoho.in',
    })
    expect(r.organizations).toEqual([{ zohoOrgId: ACCOUNTS[acct].org.organization_id, name: ACCOUNTS[acct].org.name, isActive: true }])
    refs[acct] = (await prisma.booksZohoOrganization.findFirstOrThrow({ where: { connectionId: r.connectionId } })).id
  }
})
afterAll(async () => { server.close(); setBooksFetchForTests(null, null); await prisma.$disconnect() })
beforeEach(() => { refreshes = []; calls = []; clearBooksCacheForTests() })

const invoicesOf = async (acct: Acct) => (await api(`/api/books/o/${refs[acct]}/e/invoices`)).body.data.items as { invoice_number: string; customer_name: string }[]

describe('Pre-configured Zoho Books connections', () => {
  it('1–3. lists every configured connection with its organisation, and never a secret', async () => {
    const s = await api('/api/books/status')
    expect(s.status).toBe(200)
    const orgs = s.body.data.organizations.filter((o: any) => Object.values(refs).includes(o.id))
    expect(orgs.map((o: any) => [o.connection_name, o.name, o.connection_status]).sort()).toEqual([
      ['Client Account', 'ABC Pvt Ltd', 'connected'], ['Main Account', 'Meridian Logistics', 'connected'], ['Testing Account', 'Test Company', 'connected'],
    ])
    expect(s.body.data.connections.find((c: any) => c.name === 'Testing Account').auth_method).toBe('SELF_CLIENT')
    expect(s.text).not.toMatch(/sec-|rt-|access-|cid-/) // no secret, token or client id
    expect(s.body.data.self_service_connect).toBe(false)
  })

  it('4–9. switches Main → Testing → Main → Client with the saved connection, each showing its own data', async () => {
    for (const acct of ['testing', 'main', 'client'] as const) {
      const sel = await api('/api/books/selection', { method: 'PUT', body: { org_ref: refs[acct] } })
      expect(sel.status).toBe(200)
      calls = []
      const inv = await invoicesOf(acct)
      expect(inv[0]).toMatchObject({ invoice_number: `INV-${acct}`, customer_name: ACCOUNTS[acct].org.name })
      // Every Zoho call carried this connection's token and this organisation's id.
      expect(calls.every((c) => c.acct === acct && c.org === ACCOUNTS[acct].org.organization_id)).toBe(true)
    }
    // No sign-in was started: only token refreshes, never an authorization-code exchange.
    expect(refreshes.every((r) => r.refresh_token.startsWith('rt-'))).toBe(true)
  })

  it('10–12. refreshes only the Testing token when it expires; Main is untouched', async () => {
    await invoicesOf('main')
    const mainBefore = await prisma.booksZohoConnection.findFirstOrThrow({ where: { name: 'Main Account', organisationId: firmId } })
    await prisma.booksZohoConnection.updateMany({ where: { name: 'Testing Account', organisationId: firmId }, data: { accessTokenExpiresAt: new Date(0) } })
    refreshes = []
    await invoicesOf('testing')
    expect(refreshes).toEqual([{ client_id: 'cid-test', refresh_token: 'rt-test' }])
    const mainAfter = await prisma.booksZohoConnection.findFirstOrThrow({ where: { name: 'Main Account', organisationId: firmId } })
    expect(mainAfter.accessTokenEncrypted).toBe(mainBefore.accessTokenEncrypted)
    expect(mainAfter.refreshTokenEncrypted).toBe(mainBefore.refreshTokenEncrypted)
  })

  it('13–14. background sync runs every connection with its own credentials; data never crosses', async () => {
    await prisma.booksZohoOrganization.updateMany({ where: { organisationId: firmId }, data: { lastSyncAt: null, syncStatus: 'idle' } })
    calls = []
    const r = await runBooksSyncPass()
    // (Other suites' organisations share this test database; only ours are judged.)
    const ours = new Set(Object.values(refs))
    expect(r.failed.filter((id) => ours.has(id))).toEqual([])
    expect(new Set(r.synced.filter((id) => ours.has(id)))).toEqual(ours)
    const ourOrgIds = new Set<string>(Object.values(ACCOUNTS).map((a) => a.org.organization_id))
    const bad = calls.filter((c) => c.path !== 'organizations' && (c.acct || ourOrgIds.has(c.org ?? '')) && (!c.acct || c.org !== ACCOUNTS[c.acct].org.organization_id))
    expect(bad).toEqual([])
    const logs = await prisma.booksSyncLog.findMany({ where: { zohoOrgRef: { in: Object.values(refs) }, trigger: 'scheduled' } })
    expect(logs.every((l) => l.status === 'succeeded')).toBe(true)
  })

  it('15. restores the saved selection on the next load', async () => {
    await api('/api/books/selection', { method: 'PUT', body: { org_ref: refs.client } })
    expect((await api('/api/books/status')).body.data.selected_org_ref).toBe(refs.client)
    // Only an active organisation of this firm can be selected.
    expect((await api('/api/books/selection', { method: 'PUT', body: { org_ref: 'nope' } })).status).toBe(404)
  })

  it('does not let users add, reconnect or disconnect connections', async () => {
    for (const [method, path] of [['POST', '/api/books/connect'], ['POST', '/api/books/connect/code'], ['POST', `/api/books/connections/x/reconnect`], ['POST', `/api/books/connections/x/disconnect`]] as const) {
      const r = await api(path, { method, body: { code: '1000.abcdefabcdefabcdefabcdefabcdef' } })
      expect(r.status, path).toBe(403)
      expect(r.body.error.code).toBe('books_connections_managed')
    }
  })

  it('refuses a duplicate name and leaves nothing behind when a refresh token is wrong', async () => {
    await expect(addConfiguredConnection({ organisationId: firmId, name: 'Testing Account', authMethod: 'SELF_CLIENT', clientId: 'cid-test', clientSecret: 'sec-test', refreshToken: 'rt-test', accountsServer: 'https://accounts.zoho.in' }))
      .rejects.toThrow(/already exists/)
    const before = await prisma.booksZohoConnection.count({ where: { organisationId: firmId, deletedAt: null } })
    await expect(addConfiguredConnection({ organisationId: firmId, name: 'Broken', authMethod: 'SELF_CLIENT', clientId: 'cid-test', clientSecret: 'wrong', refreshToken: 'rt-test', accountsServer: 'https://accounts.zoho.in' }))
      .rejects.toThrow()
    expect(await prisma.booksZohoConnection.count({ where: { organisationId: firmId, deletedAt: null } })).toBe(before)
  })
})

describe('Add organisation (Books → Settings)', () => {
  const form = { name: 'Kaarthi-DV', auth_method: 'SELF_CLIENT', data_center: 'in', client_id: FRESH.clientId, client_secret: FRESH.secret, code: FRESH.code }

  it('is offered to, and accepted from, a Super Admin only', async () => {
    expect((await api('/api/books/status')).body.data.can_add_connection).toBe(false)
    expect((await api('/api/books/status', { as: superAdmin })).body.data.can_add_connection).toBe(true)
    const denied = await api('/api/books/connections', { method: 'POST', body: form })
    expect(denied.status).toBe(403)
  })

  it('adds the account from its Client ID, Secret and generated code, and never returns a secret', async () => {
    const r = await api('/api/books/connections', { method: 'POST', as: superAdmin, body: form })
    expect(r.status).toBe(201)
    expect(r.body.data.organizations).toEqual([{ zoho_org_id: '830', name: 'Kaarthi-DV', is_active: true }])
    expect(r.text).not.toContain(FRESH.secret)
    expect(r.text).not.toContain('rt-fresh')
    const conn = await prisma.booksZohoConnection.findUniqueOrThrow({ where: { id: r.body.data.connection_id } })
    expect(conn).toMatchObject({ name: 'Kaarthi-DV', authMethod: 'SELF_CLIENT', clientId: FRESH.clientId, status: 'connected' })
    expect(conn.clientSecretEncrypted).not.toContain(FRESH.secret) // stored encrypted
    const status = await api('/api/books/status')
    expect(status.body.data.organizations.some((o: any) => o.connection_name === 'Kaarthi-DV' && o.name === 'Kaarthi-DV')).toBe(true)
    expect(status.text).not.toContain(FRESH.secret)
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'books.zoho.connection_added', entityId: conn.id } })
    expect(audit.afterJson).not.toContain(FRESH.secret)
  })

  it('names each wrong field, and reports a used or wrong code', async () => {
    const bad = await api('/api/books/connections', { method: 'POST', as: superAdmin, body: { ...form, name: '', client_id: 'abc', code: 'xyz' } })
    expect(bad.status).toBe(400)
    expect(Object.keys(bad.body.error.details).sort()).toEqual(['client_id', 'code', 'name'])
    const used = await api('/api/books/connections', { method: 'POST', as: superAdmin, body: { ...form, name: 'Again', code: '1000.ffffffffffffffffffffffffffffffff.ffffffffffffffffffffffffffffffff' } })
    expect(used.status).toBe(400)
    expect(used.body.error.message).toMatch(/code is wrong, already used or expired/)
  })
})
