import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { setupRoles, ROLE_TIERS_ACTION } from '../../../prisma/setup-roles.js'
import { moduleCodes } from '../../platform/rbac/modules.js'

/**
 * Role tiers as a deployed firm has them (roles from setupRoles):
 *  - partners (Super Admin, Admin) hold Review & approvals and Partner sign-off;
 *  - a Senior Associate holds Review & approvals only;
 *  - Associate and Intern hold neither; an Intern's leads are their own and an
 *    Associate converts only their own leads.
 * A database set up before the tiers (Workstation granted in full) is
 * corrected once by the next seed run, and a later Settings grant survives.
 */

type Code = 'md' | 'hr_admin' | 'dept_manager' | 'employee' | 'intern'
let server: Server
let base = ''
let orgId = ''

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

async function user(code: Code) {
  const role = await prisma.role.findUniqueOrThrow({ where: { code } })
  const u = await prisma.user.create({ data: { id: uid('u'), organisationId: orgId, email: `${uid(code)}@x.local`, passwordHash: 'x', roleId: role.id } })
  return { id: u.id, cookie: `ao_access=${signToken(u.id)}` }
}

async function grantsOf(code: Code) {
  const rows = await prisma.rolePermission.findMany({ where: { role: { code } }, include: { permission: true } })
  return new Map(rows.map((rp) => [rp.permission.code, rp.scope]))
}

const APPROVALS = moduleCodes('approvals')
const PARTNER = moduleCodes('partner')

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  await setupRoles(prisma, { force: true })
})
afterAll(async () => { server.close() })

describe('Role-tier defaults', () => {
  it('the tier modules hold the codes that separate the roles', () => {
    expect(APPROVALS).toEqual(expect.arrayContaining([
      'workstation.audit.review', 'workstation.quotation.approve', 'workstation.document.verify',
      'workstation.invoice.credit', 'workstation.invoice.cancel',
      'workstation.gst.portal.reveal', 'workstation.tds.portal.reveal', 'workstation.registration.portal.reveal',
      'workstation.gst.portal.manage', 'workstation.tds.portal.manage', 'workstation.registration.portal.manage',
      'tools.audit_automation.bookkeeping.year.manage',
    ]))
    expect(PARTNER.sort()).toEqual([
      'tools.audit_automation.bookkeeping.year.close', 'workstation.audit.sign',
      'workstation.compliance.firm', 'workstation.invoice.refund',
    ])
    expect(moduleCodes('workstation')).not.toContain('workstation.audit.sign')
    expect(moduleCodes('tools')).not.toContain('tools.audit_automation.bookkeeping.year.close')
  })

  it('partners hold both tiers, the Senior Associate approvals only, Associate and Intern neither', async () => {
    for (const code of ['md', 'hr_admin'] as const) {
      const g = await grantsOf(code)
      for (const c of [...APPROVALS, ...PARTNER]) expect(g.get(c), `${code} ${c}`).toBe('organisation')
    }
    const dm = await grantsOf('dept_manager')
    for (const c of APPROVALS) expect(dm.get(c), c).toBe('organisation')
    for (const c of PARTNER) expect(dm.has(c), c).toBe(false)
    for (const code of ['employee', 'intern'] as const) {
      const g = await grantsOf(code)
      for (const c of [...APPROVALS, ...PARTNER]) expect(g.has(c), `${code} ${c}`).toBe(false)
      // Day-to-day work stays.
      expect(g.get('workstation.invoice.manage'), code).toBe('organisation')
      expect(g.get('workstation.audit.manage'), code).toBe('organisation')
      expect(g.get('workstation.tds.portal.view'), code).toBe('organisation')
    }
    expect((await grantsOf('employee')).get('workstation.lead.read')).toBe('organisation')
    expect((await grantsOf('employee')).get('workstation.lead.convert')).toBe('self')
    const intern = await grantsOf('intern')
    for (const c of ['workstation.lead.read', 'workstation.lead.manage', 'workstation.lead.convert']) expect(intern.get(c), c).toBe('self')
  })

  it('Settings → Roles shows the two tiers, and Workstation reads back as full', async () => {
    const admin = await user('hr_admin')
    const r = await api('/api/settings/role-modules', admin.cookie)
    expect(r.status).toBe(200)
    const codes = r.body.modules.map((m: { code: string }) => m.code)
    expect(codes).toEqual(expect.arrayContaining(['approvals', 'partner']))
    const employee = r.body.roles.find((x: { code: string }) => x.code === 'employee')
    const intern = r.body.roles.find((x: { code: string }) => x.code === 'intern')
    const senior = r.body.roles.find((x: { code: string }) => x.code === 'dept_manager')
    expect(employee.modules.workstation).toBe('full')
    expect(intern.modules.workstation).toBe('full')
    expect(employee.modules.approvals).toBe('none')
    expect(senior.modules.approvals).toBe('full')
    expect(senior.modules.partner).toBe('none')
  })
})

describe('Settings cannot hand out what the caller does not hold', () => {
  it('a Senior Associate (who holds Settings) cannot give the Associate role Partner sign-off, by module or by code', async () => {
    await setupRoles(prisma, { force: true })
    const senior = await user('dept_manager')
    const employee = await prisma.role.findUniqueOrThrow({ where: { code: 'employee' } })
    const before = await grantsOf('employee')
    expect((await api(`/api/settings/roles/${employee.id}/modules/partner`, senior.cookie, { method: 'PUT', body: { access: 'full' } })).status).toBe(403)
    expect((await api(`/api/settings/roles/${employee.id}/permissions/workstation.invoice.refund`, senior.cookie, { method: 'PUT', body: { scope: 'organisation' } })).status).toBe(403)
    expect(await grantsOf('employee')).toEqual(before)
    // What they hold themselves they may still grant (and take away).
    expect((await api(`/api/settings/roles/${employee.id}/modules/approvals`, senior.cookie, { method: 'PUT', body: { access: 'full' } })).status).toBe(200)
    expect((await api(`/api/settings/roles/${employee.id}/modules/approvals`, senior.cookie, { method: 'PUT', body: { access: 'none' } })).status).toBe(200)
    // A partner may.
    const admin = await user('hr_admin')
    expect((await api(`/api/settings/roles/${employee.id}/permissions/workstation.invoice.refund`, admin.cookie, { method: 'PUT', body: { scope: 'organisation' } })).status).toBe(200)
    await setupRoles(prisma, { force: true })
  })
})

describe('Deploy correction for databases set up before the role tiers', () => {
  async function oldGrants() {
    // What setupRoles wrote before: Workstation (and the bookkeeping year
    // codes in Tools) in full, at organisation scope, for these three roles.
    const perms = await prisma.permission.findMany({ where: { code: { in: [...APPROVALS, ...PARTNER, 'workstation.lead.read', 'workstation.lead.manage', 'workstation.lead.convert'] } } })
    for (const code of ['dept_manager', 'employee', 'intern'] as const) {
      const role = await prisma.role.findUniqueOrThrow({ where: { code } })
      await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionId: p.id, scope: 'organisation' })), skipDuplicates: true })
      await prisma.rolePermission.updateMany({ where: { roleId: role.id, permission: { code: { startsWith: 'workstation.lead.' } } }, data: { scope: 'organisation' } })
      await prisma.auditLog.deleteMany({ where: { action: ROLE_TIERS_ACTION, entityId: role.id } })
    }
  }

  it('the seed (setupRoles without force) removes the extra tiers and narrows leads, once', async () => {
    await setupRoles(prisma, { force: true })
    await oldGrants()
    expect((await grantsOf('intern')).get('workstation.audit.sign')).toBe('organisation')

    await setupRoles(prisma)

    for (const code of ['employee', 'intern'] as const) {
      const g = await grantsOf(code)
      for (const c of [...APPROVALS, ...PARTNER]) expect(g.has(c), `${code} ${c}`).toBe(false)
      expect(g.get('workstation.invoice.manage'), code).toBe('organisation')
      expect(g.get('workstation.lead.convert'), code).toBe('self')
      const role = await prisma.role.findUniqueOrThrow({ where: { code } })
      expect(await prisma.auditLog.count({ where: { action: ROLE_TIERS_ACTION, entityId: role.id } })).toBe(1)
    }
    expect((await grantsOf('intern')).get('workstation.lead.read')).toBe('self')
    expect((await grantsOf('employee')).get('workstation.lead.read')).toBe('organisation')
    const dm = await grantsOf('dept_manager')
    for (const c of PARTNER) expect(dm.has(c), c).toBe(false)
    for (const c of APPROVALS) expect(dm.get(c), c).toBe('organisation')
    expect(dm.get('workstation.lead.convert')).toBe('organisation')
    // Partners untouched (and topped up with every tier code).
    const md = await grantsOf('md')
    for (const c of [...APPROVALS, ...PARTNER]) expect(md.get(c), c).toBe('organisation')

    // A later deliberate grant in Settings survives the next deploy.
    const admin = await user('hr_admin')
    const senior = await prisma.role.findUniqueOrThrow({ where: { code: 'dept_manager' } })
    expect((await api(`/api/settings/roles/${senior.id}/modules/partner`, admin.cookie, { method: 'PUT', body: { access: 'full' } })).status).toBe(200)
    await setupRoles(prisma)
    expect((await grantsOf('dept_manager')).get('workstation.audit.sign')).toBe('organisation')
    expect(await prisma.auditLog.count({ where: { action: ROLE_TIERS_ACTION, entityId: senior.id } })).toBe(1)
    await setupRoles(prisma, { force: true })
  })
})
