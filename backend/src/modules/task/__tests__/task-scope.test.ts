import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'

/**
 * Task actions stay inside the caller's task scope (roles from setupRoles):
 * an Associate or Intern acts only on tasks assigned to them; a task outside
 * scope answers 404 BEFORE anything is written. Creating or editing a task
 * needs sight of its client. The duplicate-phone warning names only clients
 * the caller may see.
 */

let server: Server
let base = ''
let orgId = ''
let wsId = ''
let roleId: Record<string, string> = {}

async function api(path: string, cookie: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  const j = text ? JSON.parse(text) : null
  return { status: res.status, body: j && typeof j === 'object' && 'data' in j ? j.data : j }
}

async function staff(code: 'employee' | 'intern' | 'dept_manager' | 'md') {
  const emp = await prisma.employee.create({
    data: {
      organisationId: orgId, employeeCode: uid('TS'), firstName: 'Task', lastName: code, fullName: uid(`Task ${code}`),
      email: `${uid('ts')}@x.local`, joiningDate: '2025-01-01', status: 'active', workScheduleId: wsId,
    },
  })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: roleId[code], employeeId: emp.id } })
  return { emp, cookie: `ao_access=${signToken(u.id)}` }
}

async function client(ownerId: string, phone = '9999999999') {
  const code = uid('TC')
  return prisma.client.create({
    data: {
      organisationId: orgId, clientCode: code, companyName: code, contactPerson: 'C', contactNumber: phone,
      email: `${code.toLowerCase()}@client.test`, accountManagerId: ownerId, status: 'active', onboardingDate: '2026-01-01',
    },
  })
}

const task = (clientId: string | null, assignedEmployeeId: string, extra: Record<string, unknown> = {}) =>
  prisma.task.create({ data: { clientId, assignedEmployeeId, title: 'File ITR-6', status: 'pending', dueDate: '2026-12-31', ...extra } })

const snapshot = async (id: string) => {
  const t = await prisma.task.findUniqueOrThrow({ where: { id } })
  const sessions = await prisma.taskTimeSession.count({ where: { taskId: id } })
  const audits = await prisma.taskAuditLog.count({ where: { taskId: id } })
  return { status: t.status, title: t.title, assignee: t.assignedEmployeeId, clientId: t.clientId, sessions, audits }
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  // A firm of its own: other suites clear the first organisation's employees.
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.create({ data: { id: uid('ws'), organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  roleId = Object.fromEntries((await prisma.role.findMany()).map((r) => [r.code, r.id]))
})
afterAll(async () => {
  // Tasks pin their assignee (RESTRICT); other suites wipe every employee.
  const emps = (await prisma.employee.findMany({ where: { organisationId: orgId }, select: { id: true } })).map((e) => e.id)
  await prisma.task.deleteMany({ where: { assignedEmployeeId: { in: emps } } })
  server?.close()
})

describe('task actions outside the caller\'s scope: 404 and nothing written', () => {
  it('an Associate cannot start, pause, resume, complete, cancel, reopen, rename or reassign a colleague\'s task', async () => {
    const me = await staff('employee')
    const colleague = await staff('employee')
    const c = await client(colleague.emp.id)
    const pending = await task(c.id, colleague.emp.id)
    const running = await task(c.id, colleague.emp.id, { status: 'in_progress', startedAt: new Date() })
    await prisma.taskTimeSession.create({ data: { taskId: running.id, employeeId: colleague.emp.id, startedAt: new Date(), openedBy: 'start' } })
    const paused = await task(c.id, colleague.emp.id, { status: 'paused', startedAt: new Date() })
    const done = await task(c.id, colleague.emp.id, { status: 'completed' })

    const cases: [string, string, string, unknown?][] = [
      [pending.id, 'POST', 'start'],
      [running.id, 'POST', 'pause'],
      [paused.id, 'POST', 'resume'],
      [running.id, 'POST', 'complete', { note: 'x' }],
      [pending.id, 'POST', 'cancel', { reason: 'x' }],
      [done.id, 'POST', 'reopen', { reason: 'x' }],
      [pending.id, 'PATCH', '', { title: 'renamed by assoc' }],
      [pending.id, 'POST', 'reassign', { employee_id: me.emp.id }],
    ]
    for (const [id, method, action, body] of cases) {
      const before = await snapshot(id)
      const r = await api(`/api/tasks/${id}${action ? `/${action}` : ''}`, me.cookie, { method, body: body ?? {} })
      expect(r.status, `${method} ${action}`).toBe(404)
      expect(await snapshot(id), `${method} ${action}`).toEqual(before)
    }
  })

  it('an Intern cannot cancel or reopen someone else\'s task', async () => {
    const intern = await staff('intern')
    const owner = await staff('employee')
    const c = await client(owner.emp.id)
    const t = await task(c.id, owner.emp.id)
    const before = await snapshot(t.id)
    expect((await api(`/api/tasks/${t.id}/cancel`, intern.cookie, { method: 'POST', body: {} })).status).toBe(404)
    expect(await snapshot(t.id)).toEqual(before)
  })

  it('the assignee runs their own task\'s clock; a Senior Associate acts on anyone\'s', async () => {
    const me = await staff('employee')
    const senior = await staff('dept_manager')
    const c = await client(me.emp.id)
    const t = await task(c.id, me.emp.id)
    expect((await api(`/api/tasks/${t.id}/start`, me.cookie, { method: 'POST' })).status).toBe(200)
    expect((await api(`/api/tasks/${t.id}/pause`, me.cookie, { method: 'POST' })).status).toBe(200)
    expect((await api(`/api/tasks/${t.id}`, me.cookie, { method: 'PATCH', body: { title: 'Own rename' } })).status).toBe(200)

    const other = await staff('employee')
    const r = await api(`/api/tasks/${t.id}/reassign`, senior.cookie, { method: 'POST', body: { employee_id: other.emp.id } })
    expect(r.status).toBe(200)
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).assignedEmployeeId).toBe(other.emp.id)
  })

  it('handing one\'s own task to a colleague succeeds and answers with the task (no write-then-404)', async () => {
    const me = await staff('employee')
    const colleague = await staff('employee')
    const c = await client(me.emp.id)
    const t = await task(c.id, me.emp.id)
    const r = await api(`/api/tasks/${t.id}/reassign`, me.cookie, { method: 'POST', body: { employee_id: colleague.emp.id } })
    expect(r.status).toBe(200)
    expect(r.body.task.assigned_employee_id).toBe(colleague.emp.id)
    // It is now out of the Associate's scope.
    expect((await api(`/api/tasks/${t.id}`, me.cookie)).status).toBe(404)
  })
})

describe('task create / edit need sight of the client', () => {
  it('an Associate cannot attach a task to a client they cannot see', async () => {
    const me = await staff('employee')
    const owner = await staff('employee')
    const hidden = await client(owner.emp.id)
    const before = await prisma.task.count({ where: { clientId: hidden.id } })
    const r = await api('/api/tasks', me.cookie, {
      method: 'POST', body: { title: 'Peek', assigned_employee_id: me.emp.id, priority: 'low', due_date: '2026-12-31', client_id: hidden.id },
    })
    expect(r.status).toBe(403)
    expect(await prisma.task.count({ where: { clientId: hidden.id } })).toBe(before)
    // Nor through the client's project.
    const service = await prisma.service.create({ data: { organisationId: orgId, name: uid('Svc'), code: uid('S') } })
    const cs = await prisma.clientService.create({ data: { clientId: hidden.id, serviceId: service.id, assignedEmployeeId: owner.emp.id } })
    const p = await api('/api/tasks', me.cookie, {
      method: 'POST', body: { title: 'Peek', assigned_employee_id: me.emp.id, priority: 'low', due_date: '2026-12-31', project_id: cs.id },
    })
    expect(p.status).toBe(403)
    expect(await prisma.task.count({ where: { clientServiceId: cs.id } })).toBe(0)
  })

  it('an Intern cannot move their own task onto a client they cannot see', async () => {
    const intern = await staff('intern')
    const owner = await staff('employee')
    const mine = await client(intern.emp.id)
    const hidden = await client(owner.emp.id)
    const t = await task(mine.id, intern.emp.id)
    const before = await snapshot(t.id)
    const r = await api(`/api/tasks/${t.id}`, intern.cookie, { method: 'PATCH', body: { client_id: hidden.id } })
    expect(r.status).toBe(403)
    expect(await snapshot(t.id)).toEqual(before)
  })

  it('an Associate creates a task on their own client; a Senior Associate on any client', async () => {
    const me = await staff('employee')
    const senior = await staff('dept_manager')
    const mine = await client(me.emp.id)
    const r = await api('/api/tasks', me.cookie, {
      method: 'POST', body: { title: 'Mine', assigned_employee_id: me.emp.id, priority: 'low', due_date: '2026-12-31', client_id: mine.id },
    })
    expect(r.status).toBe(201)
    const s = await api('/api/tasks', senior.cookie, {
      method: 'POST', body: { title: 'Theirs', assigned_employee_id: me.emp.id, priority: 'low', due_date: '2026-12-31', client_id: mine.id },
    })
    expect(s.status).toBe(201)
  })
})

describe('duplicate-phone warning names only clients the caller may see', () => {
  it('an Associate is told how many other clients share the number, not which', async () => {
    const me = await staff('employee')
    const owner = await staff('employee')
    const phone = `98${String(Date.now()).slice(-8)}`
    const hidden = await client(owner.emp.id, phone)
    const r = await api('/api/clients', me.cookie, {
      method: 'POST',
      body: { company_name: uid('Dup Co'), contact_person: 'P', contact_number: phone, email: `${uid('d')}@client.test`, account_manager_id: me.emp.id },
    })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(JSON.stringify(r.body)).not.toContain(hidden.id)
    expect(JSON.stringify(r.body)).not.toContain(hidden.companyName)
    expect(r.body.phone_duplicates).toEqual([])
    expect(r.body.phone_duplicates_hidden).toBe(1)

    const md = await staff('md')
    const m = await api('/api/clients', md.cookie, {
      method: 'POST',
      body: { company_name: uid('Dup Co'), contact_person: 'P', contact_number: phone, email: `${uid('d')}@client.test`, account_manager_id: me.emp.id },
    })
    expect(m.status).toBe(201)
    expect(m.body.phone_duplicates.map((d: { id: string }) => d.id)).toContain(hidden.id)
    expect(m.body.phone_duplicates_hidden).toBe(0)
  })
})
