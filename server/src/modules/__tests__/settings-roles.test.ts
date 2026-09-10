import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { signToken } from '../../platform/auth.js'
import { prisma, uid } from '../books/__tests__/helpers.js'
import { MATRIX } from '../../platform/rbac/matrix.js'

/**
 * HTTP-level tests for the editable roles/permissions endpoint. The matrix
 * returned by GET is derived from RolePermission rows, and PUT grants or
 * revokes them, guarded so the caller can never lock the firm out of
 * `settings.manage`.
 */

let server: Server
let base = ''

async function seedRole(code: keyof typeof MATRIX) {
  for (const g of MATRIX[code]) {
    await prisma.permission.upsert({
      where: { code: g.permission }, update: {},
      create: { id: `perm-${g.permission}`, code: g.permission, description: g.permission },
    })
  }
  const role = await prisma.role.upsert({
    where: { code }, update: {}, create: { id: `role-${code}`, code, name: code },
  })
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
  for (const g of MATRIX[code]) {
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: `perm-${g.permission}`, scope: g.scope },
    }).catch(() => undefined)
  }
  return role
}

async function user(orgId: string, roleId: string) {
  const u = await prisma.user.create({
    data: { id: uid('u'), organisationId: orgId, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId },
  })
  return { ...u, cookie: `ao_access=${signToken(u.id)}` }
}

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
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('Settings — roles & permissions API', () => {
  it('rejects unauthenticated and non-settings-manage callers', async () => {
    expect((await api('/api/settings/roles')).status).toBe(401)
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const emp = await user(org.id, (await seedRole('employee')).id)
    expect((await api('/api/settings/roles', { cookie: emp.cookie })).status).toBe(403)
  })

  it('returns a matrix derived from RolePermission, not the code constant', async () => {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const md = await user(org.id, (await seedRole('md')).id)

    // Drop one grant directly so the DB and the code MATRIX disagree; the
    // GET response must reflect the DB.
    const perm = await prisma.permission.findUniqueOrThrow({ where: { code: 'settings.manage' } })
    const empRole = await seedRole('employee')
    await prisma.rolePermission.deleteMany({
      where: { roleId: empRole.id, permissionId: perm.id },
    })
    await prisma.rolePermission.create({
      data: { roleId: empRole.id, permissionId: perm.id, scope: 'self' },
    })

    const r = await api('/api/settings/roles', { cookie: md.cookie })
    expect(r.status).toBe(200)
    const empGrants: { permission: string; scope: string }[] = r.body.data.matrix.employee
    expect(empGrants.find((g) => g.permission === 'settings.manage')).toEqual({
      permission: 'settings.manage', scope: 'self',
    })
  })

  it('grants and revokes a permission and invalidates unknown scopes/roles/permissions', async () => {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const md = await user(org.id, (await seedRole('md')).id)
    const empRole = await seedRole('employee')

    // Employee does not hold chat.manage by default. Grant it.
    const grant = await api(
      `/api/settings/roles/${empRole.id}/permissions/chat.manage`,
      { method: 'PUT', cookie: md.cookie, body: { scope: 'department' } },
    )
    expect(grant.status).toBe(200)
    const permId = (await prisma.permission.findUniqueOrThrow({ where: { code: 'chat.manage' } })).id
    const rp = await prisma.rolePermission.findUnique({
      where: { roleId_permissionId: { roleId: empRole.id, permissionId: permId } },
    })
    expect(rp?.scope).toBe('department')

    // Revoke it.
    const revoke = await api(
      `/api/settings/roles/${empRole.id}/permissions/chat.manage`,
      { method: 'PUT', cookie: md.cookie, body: { scope: null } },
    )
    expect(revoke.status).toBe(200)
    expect(await prisma.rolePermission.findUnique({
      where: { roleId_permissionId: { roleId: empRole.id, permissionId: permId } },
    })).toBeNull()

    // Bad scope.
    expect((await api(
      `/api/settings/roles/${empRole.id}/permissions/chat.manage`,
      { method: 'PUT', cookie: md.cookie, body: { scope: 'global' } },
    )).status).toBe(400)

    // Unknown role.
    expect((await api(
      `/api/settings/roles/role-nope/permissions/chat.manage`,
      { method: 'PUT', cookie: md.cookie, body: { scope: 'self' } },
    )).status).toBe(404)

    // Unknown permission.
    expect((await api(
      `/api/settings/roles/${empRole.id}/permissions/does.not.exist`,
      { method: 'PUT', cookie: md.cookie, body: { scope: 'self' } },
    )).status).toBe(404)
  })

  it('refuses to let the caller strip settings.manage from their own role', async () => {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const mdRole = await seedRole('md')
    // Give a second role settings.manage too, so the "last admin" guard
    // does not fire first and mask what we are testing.
    const hr = await seedRole('hr_admin')
    const perm = await prisma.permission.findUniqueOrThrow({ where: { code: 'settings.manage' } })
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: hr.id, permissionId: perm.id } },
      update: { scope: 'organisation' },
      create: { roleId: hr.id, permissionId: perm.id, scope: 'organisation' },
    })

    const md = await user(org.id, mdRole.id)
    const r = await api(
      `/api/settings/roles/${mdRole.id}/permissions/settings.manage`,
      { method: 'PUT', cookie: md.cookie, body: { scope: null } },
    )
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('self_lockout')
  })

  // The `last_admin` guard is defense-in-depth. In the current auth model it
  // is unreachable — the caller needs settings.manage to reach the endpoint,
  // so their own role always counts as an other-holder — but leaving it in
  // guards a future permission model where a non-holder can also edit grants.
})
