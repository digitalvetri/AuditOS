/**
 * Shared fixtures for the compliance / notices-register / dsc / tds-recon
 * tests: a real app on a random port, real RBAC, real PostgreSQL.
 */
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { MATRIX, type Grant } from '../../../platform/rbac/matrix.js'
import { seedCompliance } from '../../../../prisma/seed-compliance.js'

export { prisma, uid }

let server: Server | null = null
let base = ''

export async function startServer() {
  await seedCompliance(prisma)
  server = createApp().listen(0)
  await new Promise((r) => server!.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}
export async function stopServer() {
  server?.close()
  await prisma.$disconnect()
}

export async function seedRole(code: string, grants: { permission: string; scope: string }[]) {
  for (const g of grants) {
    await prisma.permission.upsert({
      where: { code: g.permission }, update: {},
      create: { id: `perm-${g.permission}`, code: g.permission, description: g.permission },
    })
  }
  const role = await prisma.role.upsert({ where: { code }, update: {}, create: { id: `role-${code}`, code, name: code } })
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
  for (const g of grants) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: `perm-${g.permission}`, scope: g.scope } }).catch(() => undefined)
  }
  return role
}

export async function org() {
  const o = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
  const dept = await prisma.department.create({ data: { id: uid('dep'), organisationId: o.id, code: uid('D'), name: 'General' } })
  const desg = await prisma.designation.create({ data: { id: uid('desg'), organisationId: o.id, name: 'Executive' } })
  const loc = await prisma.workLocation.create({ data: { id: uid('loc'), organisationId: o.id, name: 'HQ', latitude: 13, longitude: 80 } })
  const sched = await prisma.workSchedule.create({ data: { id: uid('sch'), organisationId: o.id, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })
  return { ...o, dept, desg, loc, sched }
}
type Org = Awaited<ReturnType<typeof org>>

export async function employee(o: Org, name = 'Staff') {
  return prisma.employee.create({
    data: {
      id: uid('emp'), organisationId: o.id, employeeCode: uid('EC'), firstName: name, lastName: 'X', fullName: `${name} X`,
      type: 'executive', status: 'active', designationId: o.desg.id, departmentId: o.dept.id, workLocationId: o.loc.id,
      workScheduleId: o.sched.id, email: `${uid('e')}@x.local`, joiningDate: '2026-01-01',
    },
  })
}

/** A login. `role` 'md' = every client; 'employee' = assigned clients only. */
export async function login(o: Org, role: 'md' | 'employee', employeeId?: string) {
  const grants: Grant[] = MATRIX[role]
  const r = await seedRole(role, grants)
  const u = await prisma.user.create({
    data: { id: uid('u'), organisationId: o.id, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: r.id, employeeId: employeeId ?? null },
  })
  return { ...u, cookie: `ao_access=${signToken(u.id)}` }
}

export async function client(o: { id: string }, name: string, extra: Record<string, unknown> = {}) {
  return prisma.client.create({
    data: {
      id: uid('cli'), organisationId: o.id, clientCode: uid('CLI'), companyName: name,
      contactPerson: 'Contact', contactNumber: '9840011111', accountManagerId: uid('emp'),
      onboardingDate: '2026-01-01', ...extra,
    },
  })
}

export async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown; form?: FormData } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { ...(opts.form ? {} : { 'Content-Type': 'application/json' }), ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
  })
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('json')) {
    const buf = Buffer.from(await res.arrayBuffer())
    return { status: res.status, body: null as any, raw: buf, headers: res.headers }
  }
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null, raw: Buffer.from(text), headers: res.headers }
}
