import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { setupRoles } from '../../../prisma/setup-roles.js'
import { ensureOwners } from '../../../prisma/owners.js'
import { payrollEmployeeWhere } from '../../domain/payroll/employment.js'

/**
 * The Admin owner login gets a staff record so they can use Messages, but
 * that record is never tracked for attendance, leave or payroll. The hidden
 * Super Admin gets no staff record at all.
 */

let server: Server
let base = ''
const adminEmail = `${uid('admin')}@x.local`
const superEmail = `${uid('super')}@x.local`

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
  const org = (await prisma.organisation.findFirst({ where: { deletedAt: null } })) ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } }))
  if (!(await prisma.workSchedule.findFirst({ where: { deletedAt: null } }))) {
    await prisma.workSchedule.create({ data: { organisationId: org.id, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })
  }
  await setupRoles(prisma, { force: true })
  await ensureOwners(prisma, [
    { email: superEmail, password: 'Super2026x', roleCode: 'md' },
    { email: adminEmail, password: 'Admin2026x', roleCode: 'hr_admin', name: 'JNS Admin' },
  ], { resetPasswords: false })
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

const cookieFor = async (email: string) => `ao_access=${signToken((await prisma.user.findUniqueOrThrow({ where: { email } })).id)}`

describe('owner logins and staff records', () => {
  it('the Admin owner has a staff record excluded from HR; the Super Admin has none', async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: adminEmail }, include: { employee: true } })
    expect(admin.employee?.excludeFromHr).toBe(true)
    expect(admin.employee?.fullName).toBe('JNS Admin')
    expect((await prisma.user.findUniqueOrThrow({ where: { email: superEmail } })).employeeId).toBeNull()
  })
  it('running setup again does not add a second record', async () => {
    await ensureOwners(prisma, [{ email: adminEmail, password: 'Admin2026x', roleCode: 'hr_admin' }], { resetPasswords: false })
    expect(await prisma.employee.count({ where: { email: adminEmail } })).toBe(1)
  })
  it('the Admin can open Messages', async () => {
    expect((await api('/api/chats', { cookie: await cookieFor(adminEmail) })).status).toBe(200)
  })
  it('the Admin is never asked for attendance and cannot check in', async () => {
    const r = await api('/api/attendance/check-in', { method: 'POST', cookie: await cookieFor(adminEmail), body: {} })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('hr_exempt')
  })
  it('the Admin is not on payroll', async () => {
    const onPayroll = await prisma.employee.findMany({ where: { ...payrollEmployeeWhere('2020-01-01', '2099-12-31'), email: adminEmail } })
    expect(onPayroll).toHaveLength(0)
  })
  it('the session tells the app the Admin is not HR-tracked', async () => {
    const me = await api('/api/auth/me', { cookie: await cookieFor(adminEmail) })
    expect(me.body.data.employee.exclude_from_hr).toBe(true)
  })
})
