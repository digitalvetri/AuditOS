import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'

vi.hoisted(() => {
  process.env.CLIENT_DOC_STORAGE_ROOT = `${process.env.TMPDIR ?? '/tmp'}/auditos-test-portal-docs-${process.pid}`
})

import crypto from 'node:crypto'
import { createApp } from '../../../app.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { addDays, istToday } from '../../../lib/dates.js'

/**
 * Client portal: pending document requests and the client's upload against
 * one (new version from 'portal', sniffed, audited, account manager told),
 * and the read-only job status (services, compliance, audit files).
 */

let server: Server
let base = ''
let orgId = ''
let clientId = ''
let managerId = ''
let managerUserId = ''
let token = ''
let linkId = ''
let requested = ''
let rejected = ''
let verified = ''

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n')

async function get(p: string) {
  const res = await fetch(`${base}${p}`)
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any }
}

async function upload(p: string, bytes: Buffer, name: string, fields: Record<string, string> = {}) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  form.append('file', new Blob([bytes]), name)
  const res = await fetch(`${base}${p}`, { method: 'POST', body: form })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any }
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  const wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  const role = await prisma.role.findFirst() ?? await prisma.role.create({ data: { code: uid('r'), name: 'R' } })
  const mgr = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('PM'), firstName: 'M', lastName: 'G', fullName: 'Manager G', email: `${uid('m')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId } })
  managerId = mgr.id
  managerUserId = (await prisma.user.create({ data: { organisationId: orgId, email: mgr.email, passwordHash: 'x', roleId: role.id, employeeId: mgr.id } })).id
  clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Portal Co', contactPerson: 'P', contactNumber: '9876543210', accountManagerId: managerId, onboardingDate: '2026-01-01' } })).id
  const cat = await prisma.documentCategory.create({ data: { organisationId: orgId, code: uid('cat'), name: 'Bank statements' } })
  const doc = (name: string, status: string, extra: Record<string, unknown> = {}) =>
    prisma.clientDocument.create({ data: { clientId, categoryId: cat.id, name, status, requestedAt: new Date(), ...extra } })
  requested = (await doc('Bank statement FY 2025-26', 'requested')).id
  rejected = (await doc('PAN card', 'rejected', { rejectionReason: 'Image is blurred', currentVersion: 1 })).id
  await prisma.clientDocumentVersion.create({ data: { documentId: rejected, version: 1, fileKey: 'x/old.pdf', uploadedBy: managerId, reviewStatus: 'rejected' } })
  verified = (await doc('GST certificate', 'verified')).id
  token = crypto.randomBytes(32).toString('base64url')
  linkId = (await prisma.clientDocumentShareLink.create({ data: { clientId, token, createdBy: 'test' } })).id

  // Job status fixtures.
  const svc = await prisma.service.create({ data: { organisationId: orgId, code: uid('SVC'), name: 'GST returns' } })
  await prisma.clientService.create({ data: { clientId, serviceId: svc.id, assignedEmployeeId: managerId, status: 'in_progress', dueDate: addDays(istToday(), 10), notes: 'INTERNAL: chase the CFO' } })
  await prisma.clientService.create({ data: { clientId, serviceId: svc.id, assignedEmployeeId: managerId, status: 'completed' } })
  await prisma.complianceItem.createMany({
    data: [
      { organisationId: orgId, clientId, formCode: uid('GSTR3B'), periodKey: 'p1', periodLabel: 'Sep 2026', dueDate: addDays(istToday(), 5), notes: 'INTERNAL' },
      { organisationId: orgId, clientId, formCode: uid('FILED'), periodKey: 'p2', periodLabel: 'Aug 2026', dueDate: addDays(istToday(), 5), status: 'filed' },
      { organisationId: orgId, clientId, formCode: uid('FAR'), periodKey: 'p3', periodLabel: 'FY', dueDate: addDays(istToday(), 90) },
      // Long past and never marked filed: history, not shown to the client.
      { organisationId: orgId, clientId, formCode: uid('OLD'), periodKey: 'p4', periodLabel: 'FY 2024-25', dueDate: addDays(istToday(), -365) },
    ],
  })
  await prisma.auditEngagement.create({ data: { organisationId: orgId, auditCode: uid('AUD'), clientId, financialYear: '2025-26', auditType: 'statutory', title: 'Statutory audit 2025-26', status: 'fieldwork', plannedReportDate: addDays(istToday(), 30) } })
})
afterAll(async () => { server.close() })

describe('portal document requests', () => {
  it('lists requested and rejected documents only, with the reason', async () => {
    const r = await get(`/api/client-portal/${token}/requests`)
    expect(r.status).toBe(200)
    const ids = r.body.data.items.map((i: any) => i.id)
    expect(ids).toEqual(expect.arrayContaining([requested, rejected]))
    expect(ids).not.toContain(verified)
    expect(r.body.data.items.find((i: any) => i.id === rejected).reason).toBe('Image is blurred')
  })

  it('stores the upload as a new portal version, audits it and tells the account manager', async () => {
    const r = await upload(`/api/client-portal/${token}/requests/${rejected}/upload`, PDF, 'pan.pdf', { note: 'clearer scan' })
    expect(r.status).toBe(201)
    expect(r.body.data.version).toBe(2)
    const doc = await prisma.clientDocument.findUniqueOrThrow({ where: { id: rejected }, include: { versions: { orderBy: { version: 'asc' } } } })
    expect(doc.status).toBe('uploaded')
    expect(doc.currentVersion).toBe(2)
    const v2 = doc.versions[1]
    expect(v2).toMatchObject({ uploadedBy: 'portal', reviewStatus: 'uploaded', mimeType: 'application/pdf', notes: 'clearer scan', previousVersionId: doc.versions[0].id })
    const audit = await prisma.auditLog.findFirst({ where: { action: 'client_document.portal_upload', entityId: rejected } })
    expect(audit?.afterJson ?? JSON.stringify(audit)).toContain(linkId)
    const n = await prisma.notification.findFirst({ where: { userId: managerUserId, type: 'client_document.portal_upload', entityId: rejected } })
    expect(n).not.toBeNull()
    // No longer pending.
    const list = await get(`/api/client-portal/${token}/requests`)
    expect(list.body.data.items.map((i: any) => i.id)).not.toContain(rejected)
  })

  it('refuses a file whose bytes do not match its extension', async () => {
    const r = await upload(`/api/client-portal/${token}/requests/${requested}/upload`, Buffer.from('<html><script>x</script></html>'), 'statement.pdf')
    expect(r.status).toBe(422)
    expect(r.body.error?.code ?? r.body.code).toBe('file_content')
  })

  it('refuses a document that is not an open request, and another client\'s document', async () => {
    expect((await upload(`/api/client-portal/${token}/requests/${verified}/upload`, PDF, 'gst.pdf')).status).toBe(409)
    const other = await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Other', contactPerson: 'P', contactNumber: '9876543210', accountManagerId: managerId, onboardingDate: '2026-01-01' } })
    const cat = await prisma.documentCategory.findFirstOrThrow({ where: { name: 'Bank statements' } })
    const foreign = await prisma.clientDocument.create({ data: { clientId: other.id, categoryId: cat.id, name: 'X', status: 'requested' } })
    expect((await upload(`/api/client-portal/${token}/requests/${foreign.id}/upload`, PDF, 'x.pdf')).status).toBe(404)
  })

  it('stops working when the link is paused or revoked', async () => {
    await prisma.clientDocumentShareLink.update({ where: { id: linkId }, data: { pausedAt: new Date() } })
    expect((await upload(`/api/client-portal/${token}/requests/${requested}/upload`, PDF, 'b.pdf')).status).toBe(410)
    expect((await get(`/api/client-portal/${token}/requests`)).status).toBe(410)
    expect((await get(`/api/client-portal/${token}/status`)).status).toBe(410)
    await prisma.clientDocumentShareLink.update({ where: { id: linkId }, data: { pausedAt: null } })
  })

  it('rate-limits uploads per link', async () => {
    let last = 0
    for (let i = 0; i < 25 && last !== 429; i++) {
      last = (await upload(`/api/client-portal/${token}/requests/${requested}/upload`, Buffer.from('nope'), 'x.exe')).status
    }
    expect(last).toBe(429)
  })
})

describe('portal job status', () => {
  it('shows active services, unfiled compliance in the next 60 days and audit files — no internal notes', async () => {
    const r = await get(`/api/client-portal/${token}/status`)
    expect(r.status).toBe(200)
    const d = r.body.data
    expect(d.services).toHaveLength(1)
    expect(d.services[0]).toMatchObject({ name: 'GST returns', status: 'in_progress' })
    expect(d.compliance).toHaveLength(1)
    expect(d.compliance[0]).toMatchObject({ period: 'Sep 2026', status: 'not_started' })
    expect(d.audits).toHaveLength(1)
    expect(d.audits[0]).toMatchObject({ status: 'fieldwork', title: 'Statutory audit 2025-26' })
    expect(JSON.stringify(d)).not.toContain('INTERNAL')
  })
})
