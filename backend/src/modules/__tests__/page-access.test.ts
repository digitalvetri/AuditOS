import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { hashPassword, signToken } from '../../platform/auth.js'
import { PAGES, effectiveGrants, grantCodes, hiddenPageForPath } from '../../platform/pages.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { setupRoles } from '../../../prisma/setup-roles.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Per-employee page access (platform/pages.ts): an Admin switches pages off
 * for one login; a switch removes the page's permission families from that
 * login's grants and refuses the page's own API paths. Never widens a role.
 */
let server: Server
let base = ''
let orgId = ''
let wsId = ''

async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : null
  // Successful responses are wrapped as { data }; errors are not.
  return { status: res.status, body: json && typeof json === 'object' && 'data' in json ? json.data : json }
}

type Code = 'md' | 'hr_admin' | 'dept_manager' | 'employee' | 'intern'
async function staff(code: Code) {
  const r = await prisma.role.findUniqueOrThrow({ where: { code } })
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AO'), firstName: 'S', lastName: code, fullName: `S ${code}`, email: `${uid('s')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: hashPassword('Old12345'), roleId: r.id, employeeId: emp.id } })
  return { emp, user: u, cookie: `ao_access=${signToken(u.id)}` }
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.create({ data: { id: uid('ws'), organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('page catalogue', () => {
  it('matches the keys the sidebar uses', () => {
    const sidebar = readFileSync(fileURLToPath(new URL('../../../../frontend/src/shell/v2/Sidebar.tsx', import.meta.url)), 'utf8')
    const used = new Set([...sidebar.matchAll(/page: '([a-z0-9_]+)'/g)].map((m) => m[1]).filter((k) => k !== 'dashboard'))
    expect([...used].sort()).toEqual(PAGES.map((p) => p.key).sort())
  })

  it('strips families by prefix and exact code, and matches API paths on a segment boundary', () => {
    const grants = [{ permission: 'workstation.lead.read' }, { permission: 'workstation.client.read' }, { permission: 'audit.read.all' }]
    expect(effectiveGrants(grants, ['leads', 'audit_trail']).map((g) => g.permission)).toEqual(['workstation.client.read'])
    expect(hiddenPageForPath('/api/tds/overview', ['tds_filing'])).toBe('tds_filing')
    expect(hiddenPageForPath('/api/tds-recon/jobs', ['tds_filing'])).toBeNull()
    expect(hiddenPageForPath('/api/tds-recon/jobs', ['it_26as'])).toBe('it_26as')
  })
})

describe('GET/PUT /api/employees/:id/page-access', () => {
  it('lets an Admin switch pages off for an Associate, cleaned and audited', async () => {
    const admin = await staff('hr_admin')
    const assoc = await staff('employee')
    const get = await api(`/api/employees/${assoc.emp.id}/page-access`, { cookie: admin.cookie })
    expect(get.status).toBe(200)
    expect(get.body).toMatchObject({ role: { code: 'employee' }, hidden_pages: [] })
    expect(get.body.role_grants.some((g: { permission: string }) => g.permission === 'workstation.lead.read')).toBe(true)

    const put = await api(`/api/employees/${assoc.emp.id}/page-access`, {
      method: 'PUT', cookie: admin.cookie, body: { hidden_pages: ['tally_export', 'leads', 'leads'] },
    })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    expect(put.body.hidden_pages).toEqual(['leads', 'tally_export'])
    // Role grants are reported unnarrowed, so the editor can show "switched off".
    expect(put.body.role_grants.some((g: { permission: string }) => g.permission === 'workstation.lead.read')).toBe(true)
    expect(await prisma.auditLog.count({ where: { entityId: assoc.user.id, action: 'user.page_access_changed' } })).toBe(1)

    const bad = await api(`/api/employees/${assoc.emp.id}/page-access`, { method: 'PUT', cookie: admin.cookie, body: { hidden_pages: ['nope'] } })
    expect(bad.status).toBe(400)
  })

  it('refuses non-admins, your own login and (for an Admin) the Super Admin', async () => {
    const admin = await staff('hr_admin')
    const assoc = await staff('employee')
    const md = await staff('md')
    expect((await api(`/api/employees/${admin.emp.id}/page-access`, { cookie: assoc.cookie })).status).toBe(403)
    expect((await api(`/api/employees/${admin.emp.id}/page-access`, { method: 'PUT', cookie: admin.cookie, body: { hidden_pages: ['leads'] } })).status).toBe(409)
    expect([403, 404]).toContain((await api(`/api/employees/${md.emp.id}/page-access`, { cookie: admin.cookie })).status)
  })
})

describe('a switched-off page for the signed-in login', () => {
  it('drops its permission family from the session and refuses its API', async () => {
    const assoc = await staff('employee')
    const before = await api('/api/leads', { cookie: assoc.cookie })
    expect(before.status).toBe(200)

    await prisma.user.update({ where: { id: assoc.user.id }, data: { hiddenPages: ['leads', 'tally_export'] } })
    const me = await api('/api/auth/me', { cookie: assoc.cookie })
    expect(me.body.hidden_pages).toEqual(['leads', 'tally_export'])
    expect(me.body.grants.some((g: { permission: string }) => g.permission.startsWith('workstation.lead.'))).toBe(false)
    expect(me.body.grants.some((g: { permission: string }) => g.permission === 'workstation.client.read')).toBe(true)

    expect((await api('/api/leads', { cookie: assoc.cookie })).status).toBe(403)
    const tally = await api('/api/tally-export/companies', { cookie: assoc.cookie })
    expect(tally.status).toBe(403)
    expect(JSON.stringify(tally.body)).toContain('page_switched_off')
    // A page left on is untouched.
    expect((await api('/api/clients', { cookie: assoc.cookie })).status).toBe(200)
  })
})

describe('switching a page ON beyond the role', () => {
  it('never hands out Settings, approval or partner codes', () => {
    expect(grantCodes('settings')).toEqual([])
    expect(grantCodes('invoices')).toEqual(expect.arrayContaining(['workstation.invoice.read', 'workstation.invoice.manage', 'workstation.access']))
    expect(grantCodes('invoices')).not.toContain('workstation.invoice.credit')
    expect(grantCodes('audit_section')).not.toContain('workstation.audit.sign')
    expect(grantCodes('zoho_books')).toEqual(['books.access', 'books.reports'])
    expect(grantCodes('tools').some((c) => c.startsWith('tools.audit_automation.'))).toBe(false)
  })

  it('adds the page to an Intern, refuses Settings, and a page cannot be both on and off', async () => {
    const admin = await staff('hr_admin')
    const intern = await staff('intern')
    const me0 = await api('/api/auth/me', { cookie: intern.cookie })
    expect(me0.body.grants.some((g: { permission: string }) => g.permission === 'reports.finance')).toBe(false)

    const put = await api(`/api/employees/${intern.emp.id}/page-access`, {
      method: 'PUT', cookie: admin.cookie, body: { hidden_pages: ['leads'], extra_pages: ['finance_mis', 'leads'] },
    })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    expect(put.body).toMatchObject({ hidden_pages: ['leads'], extra_pages: ['finance_mis'] })
    expect(put.body.grantable_pages).not.toContain('settings')

    const me = await api('/api/auth/me', { cookie: intern.cookie })
    expect(me.body.extra_pages).toEqual(['finance_mis'])
    expect(me.body.grants.some((g: { permission: string }) => g.permission === 'reports.finance')).toBe(true)
    expect(me.body.grants.some((g: { permission: string }) => g.permission.startsWith('workstation.lead.'))).toBe(false)

    const settings = await api(`/api/employees/${intern.emp.id}/page-access`, {
      method: 'PUT', cookie: admin.cookie, body: { hidden_pages: [], extra_pages: ['settings'] },
    })
    expect(settings.status).toBe(400)

    // Sending hidden pages only keeps the pages already switched on.
    const keep = await api(`/api/employees/${intern.emp.id}/page-access`, { method: 'PUT', cookie: admin.cookie, body: { hidden_pages: [] } })
    expect(keep.body.extra_pages).toEqual(['finance_mis'])
  })

  it('switching Settings off takes settings.manage away from an Admin', async () => {
    const md = await staff('md')
    const admin = await staff('hr_admin')
    await api(`/api/employees/${admin.emp.id}/page-access`, { method: 'PUT', cookie: md.cookie, body: { hidden_pages: ['settings'] } })
    const me = await api('/api/auth/me', { cookie: admin.cookie })
    expect(me.body.grants.some((g: { permission: string }) => g.permission === 'settings.manage')).toBe(false)
  })
})
