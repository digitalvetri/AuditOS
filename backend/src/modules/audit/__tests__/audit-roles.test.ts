import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { seedAudit } from '../../../../prisma/seed-audit.js'

/**
 * Audit-file roles (roles from setupRoles):
 *  - only a partner-role employee (one whose role holds workstation.audit.sign)
 *    may be named signing partner, or added to the team as "partner";
 *  - approving client acceptance and signing are a partner's;
 *  - reviewing working papers takes a Senior Associate or above.
 */

type Code = 'md' | 'hr_admin' | 'dept_manager' | 'employee' | 'intern'
let server: Server
let base = ''
let orgId = ''
let wsId = ''
let clientId = ''
const p: Record<Code, { emp: { id: string }; cookie: string }> = {} as never

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
      organisationId: orgId, employeeCode: uid('AR'), firstName: 'A', lastName: code, fullName: uid(`A ${code}`),
      email: `${uid('ar')}@x.local`, joiningDate: '2025-01-01', status: 'active', workScheduleId: wsId,
    },
  })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  return { emp, cookie: `ao_access=${signToken(u.id)}` }
}

let fy = 1990
const nextFy = () => { fy += 1; return `${fy}-${String((fy + 1) % 100).padStart(2, '0')}` }

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.create({ data: { id: uid('ws'), organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  await seedAudit(prisma)
  for (const c of ['md', 'hr_admin', 'dept_manager', 'employee', 'intern'] as Code[]) p[c] = await staff(c)
  clientId = (await prisma.client.create({
    data: {
      organisationId: orgId, clientCode: uid('CLI'), companyName: 'Audit Roles Pvt Ltd', contactPerson: 'P', contactNumber: '9876543210',
      onboardingDate: '2026-01-01', accountManagerId: p.employee.emp.id, secondaryManagerId: p.intern.emp.id,
    },
  })).id
})
afterAll(() => server?.close())

describe('signing partner must be a partner', () => {
  it('an Intern cannot name themself, and an Associate cannot name a Senior Associate; nothing is created', async () => {
    const before = await prisma.auditEngagement.count({ where: { clientId } })
    const self = await api('/api/audits', p.intern.cookie, { method: 'POST', body: { client_id: clientId, financial_year: nextFy(), audit_type: 'statutory', signing_partner_id: p.intern.emp.id, partner_membership_no: '234567' } })
    expect(self.status).toBe(400)
    const senior = await api('/api/audits', p.employee.cookie, { method: 'POST', body: { client_id: clientId, financial_year: nextFy(), audit_type: 'statutory', signing_partner_id: p.dept_manager.emp.id } })
    expect(senior.status).toBe(400)
    expect(await prisma.auditEngagement.count({ where: { clientId } })).toBe(before)
  })

  it('an Associate opens a file with a partner as signing partner, and cannot swap in a non-partner', async () => {
    const r = await api('/api/audits', p.employee.cookie, { method: 'POST', body: { client_id: clientId, financial_year: nextFy(), audit_type: 'statutory', signing_partner_id: p.hr_admin.emp.id } })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const id = r.body.id
    const swap = await api(`/api/audits/${id}`, p.employee.cookie, { method: 'PATCH', body: { signing_partner_id: p.employee.emp.id } })
    expect(swap.status).toBe(400)
    expect((await prisma.auditEngagement.findUniqueOrThrow({ where: { id } })).signingPartnerId).toBe(p.hr_admin.emp.id)
    // Nor slip a non-partner onto the team as "partner".
    const team = await api(`/api/audits/${id}/team`, p.employee.cookie, { method: 'POST', body: { employee_id: p.intern.emp.id, role: 'partner' } })
    expect(team.status).toBe(400)
    expect(await prisma.auditTeamMember.count({ where: { engagementId: id, employeeId: p.intern.emp.id } })).toBe(0)
    // As an assistant is fine.
    expect((await api(`/api/audits/${id}/team`, p.employee.cookie, { method: 'POST', body: { employee_id: p.intern.emp.id, role: 'assistant' } })).status).toBe(201)
  })
})

describe('acceptance approval and sign-off are a partner\'s; review is Senior Associate+', () => {
  /** A file set up before this rule: a Senior Associate as signing partner and team partner. */
  async function legacyFile() {
    const e = await prisma.auditEngagement.create({
      data: {
        organisationId: orgId, auditCode: uid('AUD'), clientId, financialYear: nextFy(), auditType: 'statutory', title: 'Legacy',
        signingPartnerId: p.dept_manager.emp.id, partnerMembershipNo: '212345',
      },
    })
    await prisma.auditTeamMember.create({ data: { engagementId: e.id, employeeId: p.dept_manager.emp.id, role: 'partner' } })
    return e
  }

  it('a Senior Associate on an old file as "partner" cannot approve acceptance or sign', async () => {
    const e = await legacyFile()
    expect((await api(`/api/audits/${e.id}/acceptance/approve`, p.dept_manager.cookie, { method: 'POST', body: {} })).status).toBe(403)
    const sign = await api(`/api/audits/${e.id}/sign`, p.dept_manager.cookie, { method: 'POST', body: { report_date: '2026-09-01', opinion_type: 'unmodified', report_place: 'Chennai' } })
    expect(sign.status).toBe(403)
    const row = await prisma.auditEngagement.findUniqueOrThrow({ where: { id: e.id } })
    expect(row.acceptanceApprovedAt).toBeNull()
    expect(row.status).not.toBe('signed')
  })

  it('an Associate cannot review a working paper; a Senior Associate can reach review', async () => {
    const r = await api('/api/audits', p.md.cookie, { method: 'POST', body: { client_id: clientId, financial_year: nextFy(), audit_type: 'statutory', signing_partner_id: p.md.emp.id } })
    expect(r.status).toBe(201)
    const wp = await prisma.auditWorkingPaper.findFirst({ where: { engagementId: r.body.id } })
    if (!wp) throw new Error('the audit seed should create working papers for a new file')
    expect((await api(`/api/audits/${r.body.id}/working-papers/${wp.id}/review`, p.employee.cookie, { method: 'POST', body: {} })).status).toBe(403)
    expect((await prisma.auditWorkingPaper.findUniqueOrThrow({ where: { id: wp.id } })).reviewedAt).toBeNull()
    const s = await api(`/api/audits/${r.body.id}/working-papers/${wp.id}/review`, p.dept_manager.cookie, { method: 'POST', body: {} })
    expect(s.status).not.toBe(403)
  })
})
