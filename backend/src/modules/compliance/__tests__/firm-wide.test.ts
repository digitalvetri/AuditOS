import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signToken } from '../../../platform/auth.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { api as call, org, prisma, startServer, stopServer, uid } from './fixtures.js'

/**
 * Firm-wide calendar changes are a partner's call (roles from setupRoles):
 * due-date extensions (create, delete), generating items for every client
 * (any FY, past years included) and editing the statutory catalogue. A
 * Senior Associate, Associate or Intern is refused before anything is written.
 */

type Code = 'md' | 'hr_admin' | 'dept_manager' | 'employee' | 'intern'
let o: Awaited<ReturnType<typeof org>>
const who: Record<Code, string> = {} as never

const api = (path: string, cookie: string, opts: { method?: string; body?: unknown } = {}) => call(path, { ...opts, cookie })

const EXT = { form_code: 'GSTR9', period_key: '2025-26', new_due_date: '2030-12-31', reference: 'CBIC Notification 9/2026' }

beforeAll(async () => {
  await startServer()
  await setupRoles(prisma, { force: true })
  o = await org()
  for (const code of ['md', 'hr_admin', 'dept_manager', 'employee', 'intern'] as Code[]) {
    const role = await prisma.role.findUniqueOrThrow({ where: { code } })
    const u = await prisma.user.create({ data: { id: uid('u'), organisationId: o.id, email: `${uid(code)}@x.local`, passwordHash: 'x', roleId: role.id } })
    who[code] = `ao_access=${signToken(u.id)}`
  }
})
afterAll(async () => { await stopServer() })

describe('due-date extensions', () => {
  it('Senior Associate, Associate and Intern cannot add one; nothing is written', async () => {
    for (const code of ['dept_manager', 'employee', 'intern'] as const) {
      expect((await api('/api/compliance/extensions', who[code], { method: 'POST', body: EXT })).status, code).toBe(403)
    }
    expect(await prisma.dueDateExtension.count({ where: { organisationId: o.id } })).toBe(0)
  })

  it('a partner adds one; only a partner deletes it', async () => {
    const r = await api('/api/compliance/extensions', who.md, { method: 'POST', body: EXT })
    expect(r.status).toBe(201)
    const id = r.body.data.id
    for (const code of ['dept_manager', 'employee', 'intern'] as const) {
      expect((await api(`/api/compliance/extensions/${id}`, who[code], { method: 'DELETE' })).status, code).toBe(403)
    }
    expect((await prisma.dueDateExtension.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull()
    expect((await api(`/api/compliance/extensions/${id}`, who.hr_admin, { method: 'DELETE' })).status).toBe(204)
    // Everyone may still read the list.
    expect((await api('/api/compliance/extensions', who.intern)).status).toBe(200)
  })
})

describe('generating items for every client, and the catalogue', () => {
  it('generate (current or a past FY) is refused below partner, and creates nothing', async () => {
    const before = await prisma.complianceItem.count({ where: { organisationId: o.id } })
    for (const code of ['dept_manager', 'employee', 'intern'] as const) {
      expect((await api('/api/compliance/generate', who[code], { method: 'POST', body: { financial_year: '2020-21' } })).status, code).toBe(403)
      expect((await api('/api/compliance/generate', who[code], { method: 'POST', body: {} })).status, code).toBe(403)
    }
    expect(await prisma.complianceItem.count({ where: { organisationId: o.id } })).toBe(before)
    expect((await api('/api/compliance/generate', who.md, { method: 'POST', body: { financial_year: '2025-26' } })).status).toBe(200)
  })

  it('the statutory catalogue is edited by a partner only', async () => {
    const before = await prisma.complianceForm.findUniqueOrThrow({ where: { code: 'GSTR9' } })
    const r = await api('/api/compliance/forms/GSTR9', who.dept_manager, { method: 'PATCH', body: { offset_days: 3 } })
    expect(r.status).toBe(403)
    expect(await prisma.complianceForm.findUniqueOrThrow({ where: { code: 'GSTR9' } })).toEqual(before)
  })
})
