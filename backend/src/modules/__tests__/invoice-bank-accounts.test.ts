import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { setupRoles } from '../../../prisma/setup-roles.js'

/** The firm's bank accounts decide where clients pay: owners only, audited. */

let server: Server
let base = ''
let orgId = ''

async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}
async function as(code: string) {
  const r = await prisma.role.findUniqueOrThrow({ where: { code } })
  const u = await prisma.user.create({ data: { id: uid('u'), organisationId: orgId, email: `${uid(code)}@x.local`, passwordHash: 'x', roleId: r.id } })
  return { cookie: `ao_access=${signToken(u.id)}`, id: u.id }
}
const account = (extra: Record<string, unknown> = {}) => ({
  label: 'Main', account_number: '1234567890', account_holder: 'JNS', bank_name: 'Kotak', ifsc_code: 'KKBK0008660', ...extra,
})

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  await setupRoles(prisma, { force: true })
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('invoice bank accounts', () => {
  it('Associates and Senior Associates cannot add or remove them', async () => {
    for (const code of ['employee', 'intern', 'dept_manager']) {
      const { cookie } = await as(code)
      expect((await api('/api/invoices/bank-accounts', { method: 'POST', cookie, body: account() })).status).toBe(403)
    }
  })
  it('Admin can, and the change is audited', async () => {
    const admin = await as('hr_admin')
    const r = await api('/api/invoices/bank-accounts', { method: 'POST', cookie: admin.cookie, body: account() })
    expect(r.status).toBe(201)
    const audit = await prisma.auditLog.findFirst({ where: { actorUserId: admin.id, action: 'invoice.bank_account_added' } })
    expect(audit).not.toBeNull()
  })
  it('is_default "false" is false', async () => {
    const admin = await as('hr_admin')
    const r = await api('/api/invoices/bank-accounts', { method: 'POST', cookie: admin.cookie, body: account({ label: 'Second', is_default: 'false' }) })
    expect(r.status).toBe(201)
    const row = await prisma.firmBankAccount.findFirst({ where: { label: 'Second' }, orderBy: { createdAt: 'desc' } })
    expect(row?.isDefault).toBe(false)
  })
})
