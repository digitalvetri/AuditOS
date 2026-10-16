import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { ALL_PERMISSION_CODES } from '../../platform/rbac/matrix.js'
import {
  GATES, grantsAt, levelHeld, levelsOf, sectionCodes, SECTIONS, topLevel, unassignedCodes,
} from '../../platform/rbac/sections.js'
import { setupRoles, topUp } from '../../../prisma/setup-roles.js'

/**
 * Settings → Roles & permissions, section by section: every code sits in one
 * section (or is a module gate), a role holds each section at one level, the
 * gates follow the sections, and the deploy top-up never widens a level.
 */

let server: Server
let base = ''

async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function userWithRole(roleCode: string) {
  const org = await prisma.organisation.findFirst({ where: { deletedAt: null } })
    ?? await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
  const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } })
  const u = await prisma.user.create({
    data: { id: uid('u'), organisationId: org.id, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: role.id },
  })
  return { ...u, cookie: `ao_access=${signToken(u.id)}` }
}

const heldOf = async (roleCode: string) => {
  const rows = await prisma.rolePermission.findMany({ where: { role: { code: roleCode } }, include: { permission: true } })
  return new Map(rows.map((r) => [r.permission.code, r.scope as string]))
}

beforeAll(async () => {
  await setupRoles(prisma, { force: true })
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => {
  server.close()
  await setupRoles(prisma, { force: true }) // leave the default roles for the next file
  await prisma.$disconnect()
})

describe('section catalogue', () => {
  it('puts every permission code in exactly one section, or makes it a gate', () => {
    expect(unassignedCodes()).toEqual([])
    const seen = new Map<string, string>()
    for (const s of SECTIONS) for (const c of sectionCodes(s)) {
      expect(seen.get(c), `${c} in ${seen.get(c)} and ${s.code}`).toBeUndefined()
      seen.set(c, s.code)
    }
    for (const g of GATES) expect(seen.has(g.code), g.code).toBe(false)
    expect(seen.size + GATES.length).toBe(ALL_PERMISSION_CODES.length)
  })

  it('gives each section a top level of every code (organisation scope unless it is own-only), and nested levels', () => {
    for (const s of SECTIONS) {
      expect(sectionCodes(s).every((c) => ALL_PERMISSION_CODES.includes(c)), `${s.code} grants a code that is never seeded`).toBe(true)
      const top = grantsAt(s, topLevel(s))
      expect(top.map((g) => g.code).sort(), s.code).toEqual(sectionCodes(s).sort())
      if (topLevel(s) !== 'own') expect(top.every((g) => g.scope === 'organisation'), s.code).toBe(true)
      const ls = levelsOf(s).filter((l) => l !== 'none')
      for (let i = 1; i < ls.length; i++) {
        const lower = grantsAt(s, ls[i - 1]).map((g) => g.code)
        const higher = new Set(grantsAt(s, ls[i]).map((g) => g.code))
        expect(lower.every((c) => higher.has(c)), `${s.code}: ${ls[i - 1]} ⊆ ${ls[i]}`).toBe(true)
      }
    }
  })
})

describe('Settings — role sections API', () => {
  it('returns each role\'s level per section: Associates get Workstation and Tools, assigned clients only', async () => {
    const md = await userWithRole('md')
    const r = await api('/api/settings/role-modules', { cookie: md.cookie })
    expect(r.status).toBe(200)
    expect(r.body.data.sections.length).toBe(SECTIONS.length)
    const assoc = r.body.data.roles.find((x: { code: string }) => x.code === 'employee')
    expect(assoc.sections['hrms.attendance']).toBe('none')
    expect(assoc.sections['workstation.tasks']).toBe('full')
    expect(assoc.sections['workstation.client_visibility']).toBe('none')
    expect(assoc.sections['tools.gst_json_excel']).toBe('full')
    expect(assoc.modules).toMatchObject({ hrms: 'none', workstation: 'partial', tools: 'full', integrations: 'none' })
    const admin = r.body.data.roles.find((x: { code: string }) => x.code === 'hr_admin')
    expect(Object.values(admin.modules)).toEqual(['full', 'full', 'full', 'full'])
  })

  it('sets one section to Own records: self-scoped grants, read back as own', async () => {
    const md = await userWithRole('md')
    const put = await api('/api/settings/roles/role-employee/sections/hrms.attendance', { method: 'PUT', cookie: md.cookie, body: { level: 'own' } })
    expect(put.status).toBe(200)
    const held = await heldOf('employee')
    expect(held.get('attendance.read')).toBe('self')
    expect(held.get('attendance.check_in')).toBe('self')
    expect(held.has('attendance.manage')).toBe(false)
    const s = SECTIONS.find((x) => x.code === 'hrms.attendance')!
    expect(levelHeld(s, held)).toBe('own')
    const r = await api('/api/settings/role-modules', { cookie: md.cookie })
    expect(r.body.data.roles.find((x: { code: string }) => x.code === 'employee').modules.hrms).toBe('partial')
  })

  it('keeps the module gate in step: on while any Workstation section is held, off when none is', async () => {
    const md = await userWithRole('md')
    await api('/api/settings/roles/role-intern/modules/workstation', { method: 'PUT', cookie: md.cookie, body: { access: 'none' } })
    expect((await heldOf('intern')).has('workstation.access')).toBe(false)
    await api('/api/settings/roles/role-intern/sections/workstation.tasks', { method: 'PUT', cookie: md.cookie, body: { level: 'view' } })
    let held = await heldOf('intern')
    expect(held.get('workstation.access')).toBe('organisation')
    expect(held.has('workstation.task.read')).toBe(true)
    expect(held.has('workstation.task.manage')).toBe(false)
    await api('/api/settings/roles/role-intern/sections/workstation.tasks', { method: 'PUT', cookie: md.cookie, body: { level: 'none' } })
    held = await heldOf('intern')
    expect(held.has('workstation.access')).toBe(false)
  })

  it('refuses a level a section does not offer, and an unknown section', async () => {
    const md = await userWithRole('md')
    expect((await api('/api/settings/roles/role-employee/sections/tools.pdf_to_excel', { method: 'PUT', cookie: md.cookie, body: { level: 'view' } })).status).toBe(400)
    expect((await api('/api/settings/roles/role-employee/sections/nope', { method: 'PUT', cookie: md.cookie, body: { level: 'full' } })).status).toBe(404)
  })

  it('will not let a caller remove Settings from their own role', async () => {
    const md = await userWithRole('md')
    const r = await api('/api/settings/roles/role-md/sections/hrms.settings', { method: 'PUT', cookie: md.cookie, body: { level: 'none' } })
    expect(r.status).toBe(409)
    expect((await heldOf('md')).has('settings.manage')).toBe(true)
  })

  it('needs settings.manage', async () => {
    await setupRoles(prisma, { force: true })
    const assoc = await userWithRole('employee')
    expect((await api('/api/settings/role-modules', { cookie: assoc.cookie })).status).toBe(403)
    expect((await api('/api/settings/roles/role-employee/sections/hrms.settings', { method: 'PUT', cookie: assoc.cookie, body: { level: 'full' } })).status).toBe(403)
  })
})

describe('deploy top-up', () => {
  it('adds codes new to the level a role holds, and never widens it', () => {
    // A role at Tasks = full that predates task.report picks it up…
    const full = new Map([['workstation.task.read', 'organisation'], ['workstation.task.manage', 'organisation']])
    expect(topUp(full).map((g) => g.code)).toContain('workstation.task.report')
    // …one at View does not get the write codes…
    const view = new Map([['workstation.task.read', 'organisation']])
    expect(topUp(view).map((g) => g.code)).not.toContain('workstation.task.manage')
    // …and Own attendance stays own.
    const own = new Map([['attendance.read', 'self'], ['attendance.check_in', 'self']])
    expect(topUp(own)).toEqual([{ code: 'attendance.correct.request', scope: 'self' }])
  })
})
