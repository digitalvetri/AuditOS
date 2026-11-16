import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { setupRoles } from '../../../prisma/setup-roles.js'
import { encryptPortalSecret } from '../../platform/portalCrypto.js'

/**
 * Client portal passwords (roles from setupRoles), on a client every caller
 * is assigned to — so each 403 is the permission:
 *  - Associate and Intern see the masked record only;
 *  - revealing a password, and adding, changing or deleting a login, take a
 *    Senior Associate or above. Nothing is decrypted or written on a refusal.
 */

type Code = 'dept_manager' | 'employee' | 'intern'
let server: Server
let base = ''
let orgId = ''
let wsId = ''
let clientId = ''
let profileId = ''
const who: Record<Code, string> = {} as never

async function api(path: string, cookie: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let j: any = null
  try { j = text ? JSON.parse(text) : null } catch { j = text }
  return { status: res.status, body: j && typeof j === 'object' && 'data' in j ? j.data : j }
}

async function staff(code: Code) {
  const role = await prisma.role.findUniqueOrThrow({ where: { code } })
  const emp = await prisma.employee.create({
    data: {
      organisationId: orgId, employeeCode: uid('SR'), firstName: 'S', lastName: code, fullName: uid(`S ${code}`),
      email: `${uid('sr')}@x.local`, joiningDate: '2025-01-01', status: 'active', workScheduleId: wsId,
    },
  })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  return { emp, cookie: `ao_access=${signToken(u.id)}` }
}

const reveals = () => prisma.auditLog.count({ where: { action: { contains: 'reveal' }, entityId: { not: '' } } })

beforeAll(async () => {
  process.env.PORTAL_ACCESS_ENC_KEY ??= randomBytes(32).toString('base64')
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.create({ data: { id: uid('ws'), organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  const people = { dept_manager: await staff('dept_manager'), employee: await staff('employee'), intern: await staff('intern') }
  for (const k of Object.keys(people) as Code[]) who[k] = people[k].cookie
  clientId = (await prisma.client.create({
    data: {
      organisationId: orgId, clientCode: uid('SC'), companyName: 'Secrets Co', contactPerson: 'P', contactNumber: '9876543210',
      onboardingDate: '2026-01-01', accountManagerId: people.employee.emp.id, secondaryManagerId: people.intern.emp.id,
    },
  })).id
  await prisma.tdsPortalCredential.create({ data: { clientId, userId: 'CHEK09876B', passwordCiphertext: encryptPortalSecret('Secret@123', 'tds_portal_password') } })
  await prisma.registrationCredential.create({ data: { clientId, typeCode: 'pf', fieldsJson: '{}', passwordCiphertext: encryptPortalSecret('Pf@123', 'registration_pf_password') } })
  profileId = (await prisma.gstProfile.create({ data: { clientId, gstin: '33AABCS1429B1Z5', assignedEmployeeId: people.employee.emp.id } })).id
})
afterAll(() => server?.close())

describe('Associate and Intern: masked record only', () => {
  it('they read the record, but cannot reveal, change or delete a TDS / registration / GST login', async () => {
    const tdsBefore = await prisma.tdsPortalCredential.findUniqueOrThrow({ where: { clientId } })
    const regBefore = await prisma.registrationCredential.findFirstOrThrow({ where: { clientId, typeCode: 'pf' } })
    const revealsBefore = await reveals()
    for (const code of ['employee', 'intern'] as const) {
      expect((await api(`/api/tds-portal/${clientId}`, who[code])).status, code).toBe(200)
      expect((await api(`/api/tds-portal/${clientId}/reveal`, who[code], { method: 'POST' })).status, code).toBe(403)
      expect((await api(`/api/tds-portal/${clientId}`, who[code], { method: 'PUT', body: { user_id: 'HIJACK', password: 'x' } })).status, code).toBe(403)
      expect((await api(`/api/tds-portal/${clientId}`, who[code], { method: 'DELETE' })).status, code).toBe(403)

      expect((await api(`/api/registration-credentials/pf/${clientId}`, who[code])).status, code).toBe(200)
      expect((await api(`/api/registration-credentials/pf/${clientId}/reveal`, who[code], { method: 'POST' })).status, code).toBe(403)
      expect((await api(`/api/registration-credentials/pf/${clientId}`, who[code], { method: 'PUT', body: { fields: {}, password: 'x' } })).status, code).toBe(403)
      expect((await api(`/api/registration-credentials/pf/${clientId}`, who[code], { method: 'DELETE' })).status, code).toBe(403)

      expect((await api(`/api/gst-portal/${profileId}`, who[code], { method: 'PUT', body: { username: 'x', password: 'y' } })).status, code).toBe(403)
      expect((await api(`/api/gst-portal/${profileId}/reveal`, who[code], { method: 'POST', body: { field: 'password' } })).status, code).toBe(403)
    }
    expect(await prisma.tdsPortalCredential.findUniqueOrThrow({ where: { clientId } })).toEqual(tdsBefore)
    expect(await prisma.registrationCredential.findFirstOrThrow({ where: { clientId, typeCode: 'pf' } })).toEqual(regBefore)
    expect(await prisma.gstPortalAccess.count({ where: { gstProfileId: profileId } })).toBe(0)
    expect(await reveals()).toBe(revealsBefore)
  })
})

describe('Senior Associate: reveal and manage', () => {
  it('reveals, changes and deletes', async () => {
    const r = await api(`/api/tds-portal/${clientId}/reveal`, who.dept_manager, { method: 'POST' })
    expect(r.status).toBe(200)
    expect(r.body.value).toBe('Secret@123')
    expect((await api(`/api/tds-portal/${clientId}`, who.dept_manager, { method: 'PUT', body: { user_id: 'CHEK09876B', password: 'New@123' } })).status).toBe(200)
    expect((await api(`/api/registration-credentials/pf/${clientId}/reveal`, who.dept_manager, { method: 'POST' })).status).toBe(200)
    expect((await api(`/api/registration-credentials/pf/${clientId}`, who.dept_manager, { method: 'DELETE' })).status).toBe(200)
    expect((await api(`/api/tds-portal/${clientId}`, who.dept_manager, { method: 'DELETE' })).status).toBe(200)
  })
})
