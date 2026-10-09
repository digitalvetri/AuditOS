import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'

// Uploaded test files land in a temp folder, not the repo's uploads/.
vi.hoisted(() => {
  process.env.CLIENT_DOC_STORAGE_ROOT = `${process.env.TMPDIR ?? '/tmp'}/auditos-test-docs-${process.pid}`
})

import { createApp } from '../../app.js'
import { signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { setupRoles } from '../../../prisma/setup-roles.js'

/**
 * Evidence integrity: who uploaded a document version and when comes from
 * the session and the server clock; a version needs a file; verification is
 * maker-checker; approved bank statements stay; engagement letters and GST
 * notices leave an audit trail.
 */

let server: Server
let base = ''
let orgId = ''
let wsId = ''

async function api(p: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${p}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body: body as any }
}

async function upload(p: string, cookie: string, fields: Record<string, string> = {}, withFile = true) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  if (withFile) form.append('file', new Blob([Buffer.from('%PDF-1.4\n% test\n')], { type: 'application/pdf' }), 'x.pdf')
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { Cookie: cookie }, body: form })
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body: body as any }
}

async function staff(code: string, org = orgId) {
  const r = await prisma.role.findUniqueOrThrow({ where: { code } })
  const emp = await prisma.employee.create({ data: { organisationId: org, employeeCode: uid('AO'), firstName: 'S', lastName: code, fullName: `S ${code}`, email: `${uid('s')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: org, email: emp.email, passwordHash: 'x', roleId: r.id, employeeId: emp.id } })
  return { emp, user: u, cookie: `ao_access=${signToken(u.id)}` }
}

const audits = (entityId: string) => prisma.auditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } }).then((r) => r.map((x) => x.action))

let maker: Awaited<ReturnType<typeof staff>>
let checker: Awaited<ReturnType<typeof staff>>
let clientId = ''
let categoryId = ''

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  maker = await staff('md')
  checker = await staff('md')
  clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Evidence Co', contactPerson: 'P', contactNumber: '9876543210', accountManagerId: maker.emp.id, onboardingDate: '2026-01-01' } })).id
  categoryId = (await prisma.documentCategory.create({ data: { organisationId: orgId, code: uid('cat'), name: 'Other' } })).id
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

async function newDoc(client = clientId, cat = categoryId) {
  return (await prisma.clientDocument.create({ data: { clientId: client, categoryId: cat, name: uid('Doc'), status: 'requested' } })).id
}

describe('document versions', () => {
  it('a version without a file is refused with 422 "Attach the file"', async () => {
    const id = await newDoc()
    const json = await api(`/api/client-documents/${id}/versions`, { method: 'POST', cookie: maker.cookie, body: { notes: 'no file' } })
    expect(json.status).toBe(422)
    expect(json.body.error?.message ?? JSON.stringify(json.body)).toContain('Attach the file')
    const multipartNoFile = await upload(`/api/client-documents/${id}/versions`, maker.cookie, { notes: 'x' }, false)
    expect(multipartNoFile.status).toBe(422)
    expect(await prisma.clientDocumentVersion.count({ where: { documentId: id } })).toBe(0)
  })

  it('uploader and time come from the session; a sent date becomes the document date', async () => {
    const id = await newDoc()
    const before = Date.now()
    const r = await upload(`/api/client-documents/${id}/versions`, maker.cookie, {
      uploaded_by_employee_id: checker.emp.id,
      uploaded_at: '2020-01-01',
      document_date: '2026-03-31',
    })
    expect(r.status).toBe(201)
    const v = await prisma.clientDocumentVersion.findFirstOrThrow({ where: { documentId: id } })
    expect(v.uploadedBy).toBe(maker.emp.id)
    expect(v.uploadedAt.getTime()).toBeGreaterThanOrEqual(before - 5000)
    expect(v.documentDate).toBe('2026-03-31')
    expect(v.mimeType).toBe('application/pdf')
    expect(v.reviewStatus).toBe('uploaded')
  })

  it('rejects a future document date', async () => {
    const id = await newDoc()
    const r = await upload(`/api/client-documents/${id}/versions`, maker.cookie, { document_date: '2999-01-01' })
    expect(r.status).toBe(400)
  })

  it('legacy metadata-only versions still download', async () => {
    const id = await newDoc()
    const v = await prisma.clientDocumentVersion.create({ data: { documentId: id, version: 1, fileKey: 'legacy/key', uploadedBy: maker.emp.id } })
    await prisma.clientDocument.update({ where: { id }, data: { currentVersion: 1, status: 'uploaded' } })
    const link = await api(`/api/client-documents/${id}/versions/1/link`, { cookie: checker.cookie })
    expect(link.status).toBe(200)
    const dl = await fetch(`${base}${link.body.data?.url ?? link.body.url}`)
    expect(dl.status).toBe(200)
    void v
  })
})

describe('document verification', () => {
  it('the uploader cannot verify their own version (403); another employee can, and the version records it', async () => {
    const id = await newDoc()
    expect((await upload(`/api/client-documents/${id}/versions`, maker.cookie)).status).toBe(201)
    const own = await api(`/api/client-documents/${id}/verify`, { method: 'POST', cookie: maker.cookie, body: { approve: true } })
    expect(own.status).toBe(403)
    expect(JSON.stringify(own.body)).toContain('someone else must verify')

    const ok = await api(`/api/client-documents/${id}/verify`, { method: 'POST', cookie: checker.cookie, body: { approve: true } })
    expect(ok.status).toBe(200)
    const v = await prisma.clientDocumentVersion.findFirstOrThrow({ where: { documentId: id } })
    expect(v.reviewStatus).toBe('verified')
    expect(v.reviewedByEmployeeId).toBe(checker.emp.id)
    expect(v.reviewedAt).not.toBeNull()
  })

  it('a rejection marks the version rejected with the reason', async () => {
    const id = await newDoc()
    await upload(`/api/client-documents/${id}/versions`, maker.cookie)
    const r = await api(`/api/client-documents/${id}/verify`, { method: 'POST', cookie: checker.cookie, body: { approve: false, rejection_reason: 'Blurred scan' } })
    expect(r.status).toBe(200)
    const v = await prisma.clientDocumentVersion.findFirstOrThrow({ where: { documentId: id } })
    expect(v.reviewStatus).toBe('rejected')
    expect(v.reviewNote).toBe('Blurred scan')
  })

  it('the uploader may still reject their own version (maker-checker guards approval only)', async () => {
    const id = await newDoc()
    await upload(`/api/client-documents/${id}/versions`, maker.cookie)
    const r = await api(`/api/client-documents/${id}/verify`, { method: 'POST', cookie: maker.cookie, body: { approve: false, rejection_reason: 'Wrong file' } })
    expect(r.status).toBe(200)
  })

  it('a sole active employee may verify their own upload', async () => {
    const soloOrg = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Solo Firm' } })).id
    const solo = await staff('md', soloOrg)
    const soloClient = (await prisma.client.create({ data: { organisationId: soloOrg, clientCode: uid('CLI'), companyName: 'Solo Co', contactPerson: 'P', contactNumber: '9876543210', accountManagerId: solo.emp.id, onboardingDate: '2026-01-01' } })).id
    const id = await newDoc(soloClient)
    expect((await upload(`/api/client-documents/${id}/versions`, solo.cookie)).status).toBe(201)
    const r = await api(`/api/client-documents/${id}/verify`, { method: 'POST', cookie: solo.cookie, body: { approve: true } })
    expect(r.status).toBe(200)
  })
})

describe('audit automation jobs', () => {
  async function job(createdBy: string, extra: Record<string, unknown> = {}) {
    const bank = await prisma.aaBank.upsert({ where: { key: 'testbank' }, update: {}, create: { id: 'bank-test', key: 'testbank', name: 'Test Bank', order: 99 } })
    const acct = await prisma.aaBankAccount.create({ data: { organisationId: orgId, clientId, bankId: bank.id, accountNumberMasked: 'XX1234' } })
    const doc = await prisma.aaSourceDocument.create({ data: { organisationId: orgId, clientId, uploadedByUserId: createdBy, bankId: bank.id, bankAccountId: acct.id, originalFilename: 's.pdf', mimeType: 'application/pdf', fileSize: 1, fileSha256: uid('sha'), extractionPath: uid('x'), pageCount: 1, textLayerBytes: 1 } })
    return prisma.aaJob.create({ data: { sourceDocumentId: doc.id, organisationId: orgId, clientId, createdByUserId: createdBy, status: 'extracted', bankLedgerName: 'HDFC Bank', ...extra } })
  }

  it('the uploader cannot approve their own statement; another employee can', async () => {
    const j = await job(maker.user.id)
    const own = await api(`/api/audit-automation/jobs/${j.id}/approve`, { method: 'POST', cookie: maker.cookie })
    expect(own.status).toBe(403)
    const other = await api(`/api/audit-automation/jobs/${j.id}/approve`, { method: 'POST', cookie: checker.cookie })
    expect(other.status).toBe(200)
  })

  it('an approved statement cannot be deleted (409)', async () => {
    const j = await job(maker.user.id, { reviewStatus: 'approved', approvedByUserId: checker.user.id, approvedAt: new Date() })
    const r = await api(`/api/audit-automation/jobs/${j.id}`, { method: 'DELETE', cookie: maker.cookie })
    expect(r.status).toBe(409)
  })

  it('an exported statement cannot be deleted even after reopening (409)', async () => {
    const j = await job(maker.user.id)
    await prisma.aaExport.create({ data: { organisationId: orgId, clientId, jobId: j.id, kind: 'tally_xml', rowCount: 0, totalDebitPaise: 0n, totalCreditPaise: 0n, sha256: 'x', createdByUserId: checker.user.id } })
    const r = await api(`/api/audit-automation/jobs/${j.id}`, { method: 'DELETE', cookie: maker.cookie })
    expect(r.status).toBe(409)
  })

  it('a pending, never-exported statement can be deleted', async () => {
    const j = await job(maker.user.id)
    const r = await api(`/api/audit-automation/jobs/${j.id}`, { method: 'DELETE', cookie: maker.cookie })
    expect(r.status).toBe(200)
  })
})

describe('engagement letters', () => {
  const letter = { client_id: '', subject: 'Statutory audit FY 2026-27', letter_date: '2026-10-01', fee_items: [] }

  it('every lifecycle step is audited, and an accepted letter cannot be deleted', async () => {
    const created = await api('/api/engagement-letters', { method: 'POST', cookie: maker.cookie, body: { ...letter, client_id: clientId } })
    expect(created.status).toBe(201)
    const id = created.body.data?.id ?? created.body.id
    expect((await api(`/api/engagement-letters/${id}`, { method: 'PUT', cookie: maker.cookie, body: { ...letter, client_id: clientId, subject: 'Audit — revised' } })).status).toBe(200)
    expect((await api(`/api/engagement-letters/${id}/send`, { method: 'POST', cookie: maker.cookie })).status).toBe(200)
    expect((await api(`/api/engagement-letters/${id}/accept`, { method: 'POST', cookie: maker.cookie })).status).toBe(200)

    const del = await api(`/api/engagement-letters/${id}`, { method: 'DELETE', cookie: maker.cookie })
    expect(del.status).toBe(409)
    expect(JSON.stringify(del.body)).toContain('archive it instead')

    expect((await api(`/api/engagement-letters/${id}/archive`, { method: 'POST', cookie: maker.cookie })).status).toBe(200)
    // Archived after acceptance: still the record of agreed terms.
    expect((await api(`/api/engagement-letters/${id}`, { method: 'DELETE', cookie: maker.cookie })).status).toBe(409)

    const dup = await api(`/api/engagement-letters/${id}/duplicate`, { method: 'POST', cookie: maker.cookie })
    expect(dup.status).toBe(201)
    const dupId = dup.body.data?.id ?? dup.body.id
    expect((await api(`/api/engagement-letters/${dupId}`, { method: 'DELETE', cookie: maker.cookie })).status).toBe(204)

    expect(await audits(id)).toEqual(expect.arrayContaining([
      'engagement_letter.create', 'engagement_letter.update', 'engagement_letter.send',
      'engagement_letter.accept', 'engagement_letter.archive',
    ]))
    expect(await audits(dupId)).toEqual(expect.arrayContaining(['engagement_letter.duplicate', 'engagement_letter.delete']))
  })
})

describe('GST notices', () => {
  async function notice(status = 'review') {
    return prisma.gstNotice.create({ data: { organisationId: orgId, clientId, kind: 'ASMT10', status, draftContent: 'Original reply' } })
  }

  it('updates are audited and updatedBy is the user id', async () => {
    const n = await notice()
    const r = await api(`/api/notices/${n.id}`, { method: 'PATCH', cookie: maker.cookie, body: { section: '61', status: 'sent' } })
    expect(r.status).toBe(200)
    const row = await prisma.gstNotice.findUniqueOrThrow({ where: { id: n.id } })
    expect(row.updatedBy).toBe(maker.user.id)
    expect(await audits(n.id)).toEqual(expect.arrayContaining(['gst_notice.update', 'gst_notice.status']))
  })

  it('once sent, the reply text is frozen and the status cannot go back', async () => {
    const n = await notice('sent')
    expect((await api(`/api/notices/${n.id}`, { method: 'PATCH', cookie: maker.cookie, body: { draft_content: 'Rewritten' } })).status).toBe(409)
    expect((await api(`/api/notices/${n.id}`, { method: 'PATCH', cookie: maker.cookie, body: { status: 'draft', draft_content: 'Rewritten' } })).status).toBe(409)
    expect((await api(`/api/notices/${n.id}/generate`, { method: 'POST', cookie: maker.cookie, body: { reply_inputs: { grounds: 'x', facts: 'y' } } })).status).toBe(409)
    expect((await api(`/api/notices/${n.id}`, { method: 'PATCH', cookie: maker.cookie, body: { status: 'closed' } })).status).toBe(200)
    expect((await api(`/api/notices/${n.id}`, { method: 'PATCH', cookie: maker.cookie, body: { status: 'draft' } })).status).toBe(409)
    expect((await prisma.gstNotice.findUniqueOrThrow({ where: { id: n.id } })).draftContent).toBe('Original reply')
  })

  it('a draft reply can still be edited, and deletion is audited', async () => {
    const n = await notice('draft')
    expect((await api(`/api/notices/${n.id}`, { method: 'PATCH', cookie: maker.cookie, body: { draft_content: 'Edited' } })).status).toBe(200)
    expect((await api(`/api/notices/${n.id}`, { method: 'DELETE', cookie: maker.cookie })).status).toBe(204)
    expect(await audits(n.id)).toEqual(expect.arrayContaining(['gst_notice.update', 'gst_notice.delete']))
  })
})
