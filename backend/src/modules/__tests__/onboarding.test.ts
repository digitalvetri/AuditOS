import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { setupRoles } from '../../../prisma/setup-roles.js'

let server: Server
let base = ''
let orgId = ''
let wsId = ''

async function api(path: string, cookie: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as any }
}

async function staff(code: string) {
  const r = await prisma.role.findUniqueOrThrow({ where: { code } })
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AO'), firstName: 'S', lastName: code, fullName: `S ${code}`, email: `${uid('s')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: r.id, employeeId: emp.id } })
  return `ao_access=${signToken(u.id)}`
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('first-run setup checklist', () => {
  it('lists live steps for an Admin, can be dismissed and restored', async () => {
    const admin = await staff('hr_admin')
    await staff('employee')
    const r = await api('/api/settings/onboarding', admin)
    expect(r.status).toBe(200)
    expect(r.body.data.steps.map((s: any) => s.key)).toEqual(['firm', 'staff', 'clients', 'services', 'compliance', 'audit'])
    expect(r.body.data.steps.find((s: any) => s.key === 'staff').done).toBe(true)
    const d = await api('/api/settings/onboarding', admin, { dismissed: true })
    expect(d.status).toBe(200)
    expect(d.body.data.dismissed_at).toBeTruthy()
    const back = await api('/api/settings/onboarding', admin, { dismissed: false })
    expect(back.body.data.dismissed_at).toBeNull()
  })
  it('is not for an Associate', async () => {
    const a = await staff('employee')
    expect((await api('/api/settings/onboarding', a)).status).toBe(403)
    expect((await api('/api/settings/onboarding', a, { dismissed: true })).status).toBe(403)
  })
})
