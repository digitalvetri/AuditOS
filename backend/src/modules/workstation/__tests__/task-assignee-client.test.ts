import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'

/**
 * Staff assigned a task for a client may OPEN that client (read only), even
 * when nothing else ties them to it. Writes and every other client stay
 * closed.
 */

let server: Server
let base = ''
let orgId = ''
let wsId = ''
let ownerId = ''
let roleId: Record<string, string> = {}

async function api(path: string, cookie: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function employee() {
  return prisma.employee.create({
    data: {
      organisationId: orgId, employeeCode: uid('TA'), firstName: 'Task', lastName: 'Staff', fullName: uid('Task Staff'),
      email: `${uid('t')}@x.local`, joiningDate: '2025-01-01', status: 'active', workScheduleId: wsId,
    },
  })
}

/** A client owned by someone else: no manager, service or GST link to the associate. */
async function client() {
  const code = uid('TC')
  return prisma.client.create({
    data: {
      organisationId: orgId, clientCode: code, companyName: code, contactPerson: 'C', contactNumber: '9999999999',
      email: `${code.toLowerCase()}@client.test`, accountManagerId: ownerId, status: 'active', onboardingDate: '2026-01-01',
    },
  })
}

async function associate() {
  const emp = await employee()
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: roleId.employee, employeeId: emp.id } })
  return { emp, cookie: `ao_access=${signToken(u.id)}` }
}

const task = (clientId: string, assignedEmployeeId: string, extra: Record<string, unknown> = {}) =>
  prisma.task.create({ data: { clientId, assignedEmployeeId, title: 'Prepare GSTR-1', status: 'pending', ...extra } })

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
  ownerId = (await employee()).id
})
afterAll(() => server?.close())

describe('a task assignee can open the task\'s client, read only', () => {
  it('GET the client works for the assignee; an unrelated client stays 403', async () => {
    const me = await associate()
    const mine = await client()
    const other = await client()
    await task(mine.id, me.emp.id)
    const r = await api(`/api/clients/${mine.id}`, me.cookie)
    expect(r.status).toBe(200)
    expect(r.body.data.id).toBe(mine.id)
    expect((await api(`/api/clients/${other.id}`, me.cookie)).status).toBe(403)
  })

  it('cannot PATCH the client, nor reach its nested routes or the client list', async () => {
    const me = await associate()
    const mine = await client()
    await task(mine.id, me.emp.id)
    const p = await api(`/api/clients/${mine.id}`, me.cookie, { method: 'PATCH', body: { contact_person: 'Changed' } })
    expect(p.status).toBe(403)
    expect((await prisma.client.findUniqueOrThrow({ where: { id: mine.id } })).contactPerson).toBe('C')
    const list = await api('/api/clients?page_size=100', me.cookie)
    expect(JSON.stringify(list.body)).not.toContain(mine.id)
  })

  it('a deleted or cancelled task, or someone else\'s task, grants nothing', async () => {
    const me = await associate()
    const colleague = await associate()
    const deleted = await client()
    const cancelled = await client()
    const theirs = await client()
    await task(deleted.id, me.emp.id, { deletedAt: new Date() })
    await task(cancelled.id, me.emp.id, { status: 'cancelled' })
    await task(theirs.id, colleague.emp.id)
    for (const c of [deleted, cancelled, theirs]) {
      expect((await api(`/api/clients/${c.id}`, me.cookie)).status).toBe(403)
    }
  })
})
