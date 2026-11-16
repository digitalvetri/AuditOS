import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'

/**
 * Tally Export follows client assignment (the bookkeeping company's owned
 * check): an Intern on client A cannot preview, preflight, generate, read the
 * history of, or touch the rules of client B's company. Global rules (no
 * company) are firm-wide and need "sees every client".
 */

let server: Server
let base = ''
let orgId = ''
let wsId = ''
let roleId: Record<string, string> = {}
const co: Record<'A' | 'B', { id: string; bank: string }> = {} as never
let intern = ''
let senior = ''

async function api(path: string, cookie: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let j: any = null
  try { j = text ? JSON.parse(text) : null } catch { j = text }
  return { status: res.status, body: j && typeof j === 'object' && 'data' in j ? j.data : j }
}

async function staff(code: string) {
  const emp = await prisma.employee.create({
    data: {
      organisationId: orgId, employeeCode: uid('TX'), firstName: 'T', lastName: code, fullName: uid(`T ${code}`),
      email: `${uid('tx')}@x.local`, joiningDate: '2025-01-01', status: 'active', workScheduleId: wsId,
    },
  })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: roleId[code], employeeId: emp.id } })
  return { emp, cookie: `ao_access=${signToken(u.id)}` }
}

async function client(managerId: string) {
  const code = uid('TXC')
  return prisma.client.create({
    data: {
      organisationId: orgId, clientCode: code, companyName: code, contactPerson: 'C', contactNumber: '9999999999',
      email: `${code.toLowerCase()}@client.test`, accountManagerId: managerId, status: 'active', onboardingDate: '2026-01-01',
    },
  })
}

const opts = (k: 'A' | 'B') => ({ company_id: co[k].id, bank_ledger_id: co[k].bank, period_from: '2026-04-01', period_to: '2026-04-30' })

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id
    ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.create({ data: { id: uid('ws'), organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  roleId = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.code, r.id]))
  const i = await staff('intern')
  const s = await staff('dept_manager')
  const md = await staff('md')
  intern = i.cookie
  senior = s.cookie
  const clientA = await client(i.emp.id)
  const clientB = await client(s.emp.id)
  for (const [k, c] of [['A', clientA], ['B', clientB]] as const) {
    const r = await api('/api/bookkeeping/companies', md.cookie, { method: 'POST', body: { name: uid(`Tally ${k}`), books_begin_from: '2026-04-01', client_id: c.id } })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const g = await prisma.bookkeepingGroup.findFirstOrThrow({ where: { tallyCompanyId: r.body.id, name: 'Bank Accounts' } })
    const bank = await prisma.bookkeepingLedger.create({ data: { tallyCompanyId: r.body.id, groupId: g.id, name: uid('HDFC') } as never })
    co[k] = { id: r.body.id, bank: bank.id }
  }
})
afterAll(() => server?.close())

describe('Tally Export: another client\'s company is closed', () => {
  it('preview, preflight, generate and history of client B → 403 for the Intern; nothing recorded', async () => {
    for (const p of ['preview', 'preflight', 'generate']) {
      const r = await api(`/api/tally-export/${p}`, intern, { method: 'POST', body: opts('B') })
      expect(r.status, p).toBe(403)
    }
    expect(await prisma.tallyExport.count({ where: { companyId: co.B.id } })).toBe(0)
    expect((await api(`/api/tally-export/history?companyId=${co.B.id}`, intern)).status).toBe(403)
    expect((await api(`/api/tally-export/rules?companyId=${co.B.id}`, intern)).status).toBe(403)
  })

  it('the Intern cannot create, edit, move or delete client B\'s rules, nor global rules', async () => {
    const created = await api('/api/tally-export/rules', senior, { method: 'POST', body: { company_id: co.B.id, pattern: 'SALARY', ledger_name: 'Salary' } })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const ruleB = created.body.id as string

    expect((await api('/api/tally-export/rules', intern, { method: 'POST', body: { company_id: co.B.id, pattern: 'X', ledger_name: 'Y' } })).status).toBe(403)
    expect((await api('/api/tally-export/rules', intern, { method: 'POST', body: { pattern: 'GLOBAL', ledger_name: 'Y' } })).status).toBe(403)
    expect((await api('/api/tally-export/rules/bulk', intern, { method: 'POST', body: { items: [{ company_id: co.A.id, pattern: 'OK', ledger_name: 'Y' }, { company_id: co.B.id, pattern: 'X', ledger_name: 'Y' }] } })).status).toBe(403)
    expect(await prisma.tallyLedgerRule.count({ where: { companyId: co.B.id } })).toBe(1)
    expect(await prisma.tallyLedgerRule.count({ where: { companyId: co.A.id } })).toBe(0)

    expect((await api(`/api/tally-export/rules/${ruleB}`, intern, { method: 'PATCH', body: { pattern: 'HIJACK' } })).status).toBe(403)
    expect((await api(`/api/tally-export/rules/${ruleB}`, intern, { method: 'DELETE' })).status).toBe(403)
    const row = await prisma.tallyLedgerRule.findUniqueOrThrow({ where: { id: ruleB } })
    expect(row.pattern).toBe('SALARY')
    expect(row.deletedAt).toBeNull()

    // Moving their own rule onto client B is refused too.
    const own = await api('/api/tally-export/rules', intern, { method: 'POST', body: { company_id: co.A.id, pattern: 'RENT', ledger_name: 'Rent' } })
    expect(own.status).toBe(201)
    expect((await api(`/api/tally-export/rules/${own.body.id}`, intern, { method: 'PATCH', body: { company_id: co.B.id } })).status).toBe(403)
    expect((await prisma.tallyLedgerRule.findUniqueOrThrow({ where: { id: own.body.id } })).companyId).toBe(co.A.id)

    // The unfiltered list shows only visible companies' rules (plus global ones).
    const list = await api('/api/tally-export/rules', intern)
    expect(list.status).toBe(200)
    expect(list.body.items.map((r: { company_id: string | null }) => r.company_id)).not.toContain(co.B.id)
  })

  it('the Intern works client A; a Senior Associate works both', async () => {
    expect((await api('/api/tally-export/preview', intern, { method: 'POST', body: opts('A') })).status).toBe(200)
    expect((await api(`/api/tally-export/history?companyId=${co.A.id}`, intern)).status).toBe(200)
    for (const k of ['A', 'B'] as const) {
      expect((await api('/api/tally-export/preflight', senior, { method: 'POST', body: opts(k) })).status, k).toBe(200)
    }
    const g = await api('/api/tally-export/rules', senior, { method: 'POST', body: { pattern: uid('GLOBAL'), ledger_name: 'Bank Charges' } })
    expect(g.status).toBe(201)
  })
})
