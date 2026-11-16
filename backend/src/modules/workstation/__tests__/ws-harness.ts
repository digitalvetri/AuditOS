import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'

/**
 * A small in-process harness for the Workstation client-data tests: the real
 * app on a random port, its own organisation (tests in the shared one break
 * suites that wipe employees), production roles from setupRoles, and staff
 * with cookies.
 */
export type RoleCode = 'md' | 'dept_manager' | 'employee' | 'intern'
export interface Staff { emp: { id: string; fullName: string }; userId: string; cookie: string }

export interface Harness {
  base: string
  orgId: string
  wsId: string
  server: Server
  staff(code: RoleCode): Promise<Staff>
  client(managerId: string, extra?: Record<string, unknown>): Promise<{ id: string }>
  api(path: string, cookie: string, opts?: { method?: string; body?: unknown }): Promise<{ status: number; body: any }>
  upload(path: string, cookie: string, bytes: Buffer, name: string, fields?: Record<string, string>): Promise<{ status: number; body: any }>
  close(): void
}

export async function startHarness(): Promise<Harness> {
  const server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  const orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  const wsId = (await prisma.workSchedule.create({ data: { id: uid('ws'), organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })

  const unwrap = async (res: Response) => {
    const text = await res.text()
    let j: any = null
    try { j = text ? JSON.parse(text) : null } catch { j = text }
    return { status: res.status, body: j && typeof j === 'object' && 'data' in j ? j.data : j }
  }

  return {
    base, orgId, wsId, server,
    async staff(code) {
      const role = await prisma.role.findUniqueOrThrow({ where: { code } })
      const emp = await prisma.employee.create({
        data: {
          organisationId: orgId, employeeCode: uid('WS'), firstName: 'W', lastName: code, fullName: uid(`W ${code}`),
          email: `${uid('ws')}@x.local`, joiningDate: '2025-01-01', status: 'active', workScheduleId: wsId,
        },
      })
      const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
      return { emp, userId: u.id, cookie: `ao_access=${signToken(u.id)}` }
    },
    async client(managerId, extra = {}) {
      return prisma.client.create({
        data: {
          organisationId: orgId, clientCode: uid('CLI'), companyName: uid('Client Co'), contactPerson: 'P',
          contactNumber: '9876543210', accountManagerId: managerId, onboardingDate: '2026-01-01', ...extra,
        },
      })
    },
    async api(path, cookie, opts = {}) {
      return unwrap(await fetch(`${base}${path}`, {
        method: opts.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      }))
    },
    async upload(path, cookie, bytes, name, fields = {}) {
      const form = new FormData()
      for (const [k, v] of Object.entries(fields)) form.append(k, v)
      form.append('file', new Blob([bytes]), name)
      return unwrap(await fetch(`${base}${path}`, { method: 'POST', headers: { Cookie: cookie }, body: form }))
    },
    close() { server.close() },
  }
}
