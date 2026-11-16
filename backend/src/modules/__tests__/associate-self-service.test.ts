import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { setupRoles } from '../../../prisma/setup-roles.js'
import { addDays, istToday } from '../../lib/dates.js'

/**
 * An Associate holds only the Workstation and Tools modules — no HRMS code
 * at all — yet must still apply for their own leave and check in/out. Those
 * self endpoints act on the caller's own employee row; everything about
 * anyone else, and the HR admin lists, stays closed.
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

async function staff(role: string) {
  const email = `${uid('a')}@x.local`
  const emp = await prisma.employee.create({
    data: {
      organisationId: orgId, employeeCode: uid('AS'), firstName: 'Asso', lastName: 'Ciate', fullName: uid('Associate'),
      email, joiningDate: '2025-01-01', status: 'active', workScheduleId: wsId,
    },
  })
  const u = await prisma.user.create({ data: { organisationId: orgId, email, passwordHash: 'x', roleId: roleId[role], employeeId: emp.id } })
  return { emp, cookie: `ao_access=${signToken(u.id)}` }
}

/** A weekday at least a week out. */
function upcomingWeekday() {
  let d = addDays(istToday(), 8)
  while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = addDays(d, 1)
  return d
}

let typeId = ''
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
  typeId = (await prisma.leaveType.create({
    data: { organisationId: orgId, code: uid('cl'), name: 'Casual', annualEntitlement: 12, halfDayAllowed: true, minNoticeDays: 0, accrueDuringProbation: true },
  })).id
})
afterAll(() => server?.close())

describe('Associate self-service (Workstation + Tools only)', () => {
  it('the Associate role holds no HRMS permission', async () => {
    const held = await prisma.rolePermission.findMany({ where: { roleId: roleId.employee }, include: { permission: true } })
    expect(held.some((h) => /^(leave|attendance|employee|payroll)\./.test(h.permission.code))).toBe(false)
  })

  it('applies for, lists and cancels their own leave, and loads what the leave page reads', async () => {
    const me = await staff('employee')
    for (const path of ['/api/leaves/holidays', `/api/leaves/balances/${me.emp.id}`, `/api/leaves?employeeId=${me.emp.id}`, '/api/settings/work-schedules/mine']) {
      expect((await api(path, me.cookie)).status, path).toBe(200)
    }
    const start = upcomingWeekday()
    const applied = await api('/api/leaves', me.cookie, { method: 'POST', body: { leave_type_id: typeId, start_date: start, end_date: start, reason: 'Family' } })
    expect(applied.body?.error?.code).toBeUndefined()
    expect(applied.status).toBe(200)
    const id = applied.body.request.id
    const mine = await api('/api/leaves', me.cookie)
    expect(mine.body.items.map((r: { id: string }) => r.id)).toContain(id)
    expect((await api(`/api/leaves/${id}`, me.cookie)).status).toBe(200)
    expect((await api(`/api/leaves/${id}/cancel`, me.cookie, { method: 'POST' })).status).toBe(200)
  })

  it('checks in and out, and loads their own attendance', async () => {
    const me = await staff('employee')
    expect((await api('/api/attendance/check-in', me.cookie, { method: 'POST', body: {} })).status).toBe(200)
    expect((await api('/api/attendance/today', me.cookie)).status).toBe(200)
    expect((await api('/api/attendance/check-out', me.cookie, { method: 'POST', body: {} })).status).toBe(200)
    const list = await api('/api/attendance', me.cookie)
    expect(list.status).toBe(200)
    expect(list.body.scope).toBe('self')
    expect(list.body.items.every((r: { employee_id: string }) => r.employee_id === me.emp.id)).toBe(true)
    expect(list.body.items.length).toBeGreaterThanOrEqual(1)
    expect((await api('/api/attendance/corrections', me.cookie)).status).toBe(200)
  })

  it('still cannot reach another employee\'s leave or attendance, or approve anything', async () => {
    const me = await staff('employee')
    const other = await staff('employee')
    const start = upcomingWeekday()
    const theirs = await api('/api/leaves', other.cookie, { method: 'POST', body: { leave_type_id: typeId, start_date: start, end_date: start, reason: 'Trip' } })
    expect(theirs.status).toBe(200)
    const lid = theirs.body.request.id
    await api('/api/attendance/check-in', other.cookie, { method: 'POST', body: {} })

    expect((await api(`/api/leaves/${lid}`, me.cookie)).status).toBe(403)
    expect((await api(`/api/leaves?employeeId=${other.emp.id}`, me.cookie)).status).toBe(403)
    expect((await api(`/api/leaves/balances/${other.emp.id}`, me.cookie)).status).toBe(403)
    expect((await api(`/api/leaves/${lid}/approve`, me.cookie, { method: 'POST' })).status).toBe(403)
    expect((await api(`/api/leaves/${lid}/cancel`, me.cookie, { method: 'POST' })).status).toBe(403)
    expect((await api(`/api/attendance?employeeId=${other.emp.id}`, me.cookie)).status).toBe(403)
    // The unfiltered lists only ever hold their own rows.
    const leaves = await api('/api/leaves', me.cookie)
    expect(leaves.body.items.some((r: { id: string }) => r.id === lid)).toBe(false)
    const att = await api('/api/attendance', me.cookie)
    expect(att.body.items.some((r: { employee_id: string }) => r.employee_id === other.emp.id)).toBe(false)
    expect((await api('/api/leaves?scope=queue', me.cookie)).body.items).toEqual([])
  })

  it('still gets 403 on the HR admin lists', async () => {
    const me = await staff('employee')
    for (const path of ['/api/payroll/runs', `/api/employees/${(await staff('employee')).emp.id}`]) {
      expect((await api(path, me.cookie)).status, path).toBe(403)
    }
  })
})
