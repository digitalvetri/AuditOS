import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { setupRoles } from '../../../prisma/setup-roles.js'

/**
 * Audit Automation jobs (bank statements, GST reconciliations) as a deployed
 * firm has them (roles from setupRoles):
 *  - Associate and Intern see the jobs they created and the jobs of the
 *    clients assigned to them — nothing else of the firm's.
 *  - Super Admin, Admin and Senior Associate see every job.
 */

type Code = 'md' | 'hr_admin' | 'dept_manager' | 'employee' | 'intern'
let server: Server
let base = ''
let orgId = ''
let wsId = ''

async function api(path: string, cookie: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  return { status: res.status, text: await res.text() }
}

async function staff(code: Code) {
  const r = await prisma.role.findUniqueOrThrow({ where: { code } })
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AJ'), firstName: 'S', lastName: code, fullName: `S ${code}`, email: `${uid('s')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: r.id, employeeId: emp.id } })
  return { id: u.id, emp, cookie: `ao_access=${signToken(u.id)}` }
}
type Staff = Awaited<ReturnType<typeof staff>>

async function client(name: string, accountManagerId: string, secondaryManagerId: string | null = null) {
  return (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: name, contactPerson: 'P', contactNumber: '9876543210', accountManagerId, secondaryManagerId, onboardingDate: '2026-01-01' } })).id
}

const BANK_ID = 'test-aa-job-scope-bank'
async function bankJob(clientId: string, createdByUserId: string) {
  await prisma.aaBank.upsert({ where: { id: BANK_ID }, update: {}, create: { id: BANK_ID, key: BANK_ID, name: 'Test Bank', order: 99 } })
  const acct = await prisma.aaBankAccount.create({ data: { organisationId: orgId, clientId, bankId: BANK_ID, accountNumberMasked: 'XXXX1234' } })
  const doc = await prisma.aaSourceDocument.create({ data: { organisationId: orgId, clientId, uploadedByUserId: createdByUserId, bankId: BANK_ID, bankAccountId: acct.id, originalFilename: 'stmt.pdf', mimeType: 'application/pdf', fileSize: 10, fileSha256: uid('sha'), extractionPath: `test/${uid('x')}`, pageCount: 1, textLayerBytes: 10 } })
  return (await prisma.aaJob.create({ data: { sourceDocumentId: doc.id, organisationId: orgId, clientId, createdByUserId, status: 'completed', progress: 100 } })).id
}

async function reconJob(clientId: string, createdByUserId: string) {
  const f = await prisma.aaGstFiling2B.create({ data: { organisationId: orgId, clientId, uploadedByUserId: createdByUserId, periodMonth: 6, periodYear: 2025, sourceFormat: 'json', originalFilename: '2b.json', fileSize: 1, fileSha256: uid('sha'), storagePath: `test/${uid('x')}` } })
  const p = await prisma.aaPurchaseRegister.create({ data: { organisationId: orgId, clientId, uploadedByUserId: createdByUserId, periodMonth: 6, periodYear: 2025, sourceFormat: 'xlsx', originalFilename: 'pr.xlsx', fileSize: 1, fileSha256: uid('sha'), storagePath: `test/${uid('x')}` } })
  const job = await prisma.aaGstReconJob.create({ data: { organisationId: orgId, clientId, createdByUserId, filing2BId: f.id, purchaseRegisterId: p.id, status: 'completed', progress: 100 } })
  const row = await prisma.aaGstReconRow.create({ data: { jobId: job.id, matchStatus: 'only_2b' } })
  return { id: job.id, rowId: row.id }
}

const bankReads = (id: string) => [`/api/audit-automation/jobs/${id}`, `/api/audit-automation/jobs/${id}/rows`]
const reconReads = (id: string) => [`/api/audit-automation/gst/recon/${id}`, `/api/audit-automation/gst/recon/${id}/rows`, `/api/audit-automation/gst/recon/${id}/export.csv`]

let assignedEmp: Staff, assignedIntern: Staff, otherEmp: Staff, otherIntern: Staff
let admins: Staff[]
let assignedClient = '', otherClient = ''
let colleagueBank = '', colleagueRecon = { id: '', rowId: '' }
let ownBank = '', ownRecon = { id: '', rowId: '' }

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  assignedEmp = await staff('employee')
  assignedIntern = await staff('intern')
  otherEmp = await staff('employee')
  otherIntern = await staff('intern')
  admins = [await staff('md'), await staff('hr_admin'), await staff('dept_manager')]
  assignedClient = await client('Assigned Co', assignedEmp.emp.id, assignedIntern.emp.id)
  // A client none of the Associates/Interns is assigned to.
  otherClient = await client('Other Co', admins[1].emp.id)
  // A colleague (an Admin) ran these for the assigned client.
  colleagueBank = await bankJob(assignedClient, admins[1].id)
  colleagueRecon = await reconJob(assignedClient, admins[1].id)
  // otherEmp ran these on a client they are not (or no longer) assigned to.
  ownBank = await bankJob(otherClient, otherEmp.id)
  ownRecon = await reconJob(otherClient, otherEmp.id)
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('Audit Automation jobs: who sees what', () => {
  it('the assigned Associate and Intern open a colleague’s jobs for their client', async () => {
    for (const s of [assignedEmp, assignedIntern]) {
      for (const p of [...bankReads(colleagueBank), ...reconReads(colleagueRecon.id)]) {
        expect((await api(p, s.cookie)).status, p).toBe(200)
      }
    }
  })

  it('an unassigned Associate or Intern cannot read, edit or delete them', async () => {
    for (const s of [otherEmp, otherIntern]) {
      for (const p of [...bankReads(colleagueBank), ...reconReads(colleagueRecon.id)]) {
        expect([403, 404], `${p}`).toContain((await api(p, s.cookie)).status)
      }
      expect([403, 404]).toContain((await api(`/api/audit-automation/gst/recon/rows/${colleagueRecon.rowId}`, s.cookie, { method: 'PATCH', body: { auditor_note: 'x' } })).status)
      expect([403, 404]).toContain((await api(`/api/audit-automation/gst/recon/${colleagueRecon.id}`, s.cookie, { method: 'DELETE' })).status)
      expect([403, 404]).toContain((await api(`/api/audit-automation/jobs/${colleagueBank}`, s.cookie, { method: 'DELETE' })).status)
    }
    expect(await prisma.aaGstReconJob.count({ where: { id: colleagueRecon.id } })).toBe(1)
    expect((await prisma.aaGstReconRow.findUniqueOrThrow({ where: { id: colleagueRecon.rowId } })).auditorNote).toBeNull()
    expect((await prisma.aaSourceDocument.findFirstOrThrow({ where: { jobs: { some: { id: colleagueBank } } } })).deletedAt).toBeNull()
  })

  it('the creator opens their own jobs even on a client not assigned to them', async () => {
    for (const p of [...bankReads(ownBank), ...reconReads(ownRecon.id)]) {
      expect((await api(p, otherEmp.cookie)).status, p).toBe(200)
    }
    expect((await api(`/api/audit-automation/gst/recon/rows/${ownRecon.rowId}`, otherEmp.cookie, { method: 'PATCH', body: { auditor_note: 'mine' } })).status).toBe(200)
  })

  it('nobody else unassigned reaches those own jobs', async () => {
    for (const s of [assignedEmp, assignedIntern, otherIntern]) {
      for (const p of [...bankReads(ownBank), ...reconReads(ownRecon.id)]) {
        expect([403, 404], p).toContain((await api(p, s.cookie)).status)
      }
    }
  })

  it('Super Admin, Admin and Senior Associate open every job', async () => {
    for (const s of admins) {
      for (const p of [...bankReads(colleagueBank), ...reconReads(colleagueRecon.id), ...bankReads(ownBank), ...reconReads(ownRecon.id)]) {
        expect((await api(p, s.cookie)).status, `${p}`).toBe(200)
      }
    }
  })
})
