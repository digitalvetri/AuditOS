import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'

vi.hoisted(() => {
  const tmp = `${process.env.TMPDIR ?? '/tmp'}/auditos-test-dp-${process.pid}`
  process.env.CLIENT_DOC_STORAGE_ROOT = `${tmp}/client-docs`
  process.env.GST_NOTICE_STORAGE_ROOT = `${tmp}/gst-notices`
  process.env.CLIENT_NOTICE_STORAGE_ROOT = `${tmp}/client-notices`
  process.env.AUDIT_FILES_STORAGE_ROOT = `${tmp}/audit-files`
})

import JSZip from 'jszip'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { clientDocumentStorage } from '../../workstation/client-folders.routes.js'
import { auditStorage } from '../../audit/service.js'
import { complete } from '../../notices/groq.js'
import { recordsDueForDeletion, retentionEndDate } from '../retention.js'
import { runAuditChainCheck } from '../chain-check.js'

/**
 * Data protection: the AI switch, retention settings, records due for
 * deletion, the Admin purge (typed confirmation, statutory records kept),
 * the DPDP export, client exit date, and the daily audit-chain alert.
 */

let server: Server
let base = ''
let orgId = ''
let adminCookie = ''
let adminUserId = ''
let staffCookie = ''
let managerEmpId = ''

async function api(p: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${p}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body: body as any, res }
}

async function user(code: string) {
  const role = await prisma.role.findUniqueOrThrow({ where: { code } })
  const ws = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AO'), firstName: 'D', lastName: code, fullName: `D ${code} ${uid('n')}`, email: `${uid('dp')}@x.local`, joiningDate: '2020-01-01', workScheduleId: ws } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  return { u, emp, cookie: `ao_access=${signToken(u.id)}` }
}

async function newClient(extra: Record<string, unknown> = {}) {
  return prisma.client.create({
    data: {
      organisationId: orgId, clientCode: uid('CLI'), companyName: `Former ${uid('c')}`, contactPerson: 'Ravi',
      contactNumber: '9876543210', email: 'ravi@former.in', address: '1 MG Road', accountManagerId: managerEmpId,
      onboardingDate: '2005-01-01', ...extra,
    },
  })
}

/** A client with one of everything a purge removes, plus an invoice and payment it must keep. */
async function fullyLoadedClient(exitDate: string) {
  const c = await newClient({ status: 'inactive', exitDate })
  const cat = await prisma.documentCategory.create({ data: { organisationId: orgId, code: uid('cat'), name: 'KYC' } })
  const doc = await prisma.clientDocument.create({ data: { clientId: c.id, categoryId: cat.id, name: 'PAN card' } })
  const docKey = `${c.id}/${doc.id}/pan.pdf`
  await clientDocumentStorage.put(docKey, Buffer.from('%PDF-1.4 pan'))
  await prisma.clientDocumentVersion.create({ data: { documentId: doc.id, version: 1, fileKey: docKey, uploadedBy: adminUserId, originalName: 'pan.pdf' } })
  await prisma.clientDocumentShareLink.create({ data: { clientId: c.id, token: uid('tok'), createdBy: adminUserId } }).catch(() => undefined)
  await prisma.clientContact.create({ data: { clientId: c.id, name: 'Accountant', phone: '9123456789' } })
  await prisma.registrationCredential.create({ data: { clientId: c.id, typeCode: 'gst', passwordCiphertext: 'secret-cipher' } })
  await prisma.gstNotice.create({ data: { organisationId: orgId, clientId: c.id, kind: 'DRC01' } })
  await prisma.clientNotice.create({ data: { organisationId: orgId, clientId: c.id, authority: 'income_tax', section: '143(1)', noticeDate: '2010-01-01' } })
  const eng = await prisma.auditEngagement.create({ data: { organisationId: orgId, auditCode: uid('AUD'), clientId: c.id, financialYear: '2009-10', auditType: 'statutory', title: 'Statutory audit' } })
  const wp = await prisma.auditWorkingPaper.create({ data: { engagementId: eng.id, ref: 'A1', section: 'planning', title: 'Engagement letter' } })
  const wpKey = `${eng.id}/${wp.id}/letter.pdf`
  await auditStorage.put(wpKey, Buffer.from('%PDF-1.4 letter'))
  await prisma.auditWorkingPaperFile.create({ data: { workingPaperId: wp.id, fileKey: wpKey, originalName: 'letter.pdf', uploadedBy: adminUserId, sha256: 'x' } })
  const inv = await prisma.invoice.create({ data: { organisationId: orgId, invoiceNumber: uid('INV'), clientId: c.id, invoiceDate: '2009-05-01', dueDate: '2009-05-15', status: 'paid', totalPaise: 1000_00, balanceDuePaise: 0, billingName: c.companyName } })
  await prisma.invoicePayment.create({ data: { organisationId: orgId, invoiceId: inv.id, clientId: c.id, amountPaise: 1000_00, paidOn: '2009-05-10' } })
  return { c, doc, docKey, wpKey, eng, inv }
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'DP Firm' } })).id
  await setupRoles(prisma, { force: true })
  const admin = await user('md')
  adminCookie = admin.cookie
  adminUserId = admin.u.id
  managerEmpId = admin.emp.id
  staffCookie = (await user('employee')).cookie
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('retention period arithmetic', () => {
  it('adds whole years; 29 Feb lands on 28 Feb in a common year', () => {
    expect(retentionEndDate('2018-04-01', 8)).toBe('2026-04-01')
    expect(retentionEndDate('2020-02-29', 7)).toBe('2027-02-28')
    expect(retentionEndDate('2020-02-29', 8)).toBe('2028-02-29')
  })
})

describe('data-protection settings', () => {
  it('any signed-in user reads them; only an Admin changes them; retention is at least 7 years', async () => {
    const r = await api('/api/data-protection/settings', { cookie: staffCookie })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ ai_external_processing: true, data_retention_years: 8, min_retention_years: 7 })

    expect((await api('/api/data-protection/settings', { method: 'PATCH', cookie: staffCookie, body: { data_retention_years: 9 } })).status).toBe(403)
    expect((await api('/api/data-protection/settings', { method: 'PATCH', cookie: adminCookie, body: { data_retention_years: 6 } })).status).toBe(400)
    expect((await api('/api/data-protection/settings', { method: 'PATCH', cookie: adminCookie, body: { data_retention_years: 7.5 } })).status).toBe(400)

    const ok = await api('/api/data-protection/settings', { method: 'PATCH', cookie: adminCookie, body: { data_retention_years: 10 } })
    expect(ok.status).toBe(200)
    expect(ok.body.data.data_retention_years).toBe(10)
    const row = await prisma.auditLog.findFirst({ where: { action: 'organisation.data_protection_updated', entityId: orgId }, orderBy: { seq: 'desc' } })
    expect(row?.afterJson).toContain('"dataRetentionYears":10')
    await prisma.organisation.update({ where: { id: orgId }, data: { dataRetentionYears: 8 } })
  })
})

describe('AI processing switch', () => {
  it('when off, drafting is refused with 409 before anything is sent', async () => {
    await prisma.organisation.update({ where: { id: orgId }, data: { aiExternalProcessing: false } })
    try {
      await expect(complete({ organisationId: orgId, system: 's', user: 'u' })).rejects.toMatchObject({ status: 409, code: 'ai_disabled', message: 'AI drafting is switched off for this firm.' })

      const c = await newClient()
      const n = await prisma.gstNotice.create({ data: { organisationId: orgId, clientId: c.id, kind: 'DRC01', extractedText: 'Notice to PAN ABCDE1234F' } })
      const gen = await api(`/api/notices/${n.id}/generate`, { method: 'POST', cookie: adminCookie, body: { reply_inputs: { grounds: 'g', facts: 'f' } } })
      expect(gen.status).toBe(409)
      expect(gen.body.error).toMatchObject({ code: 'ai_disabled', message: 'AI drafting is switched off for this firm.' })
      const letter = await api(`/api/notices/${n.id}/client-letter`, { method: 'POST', cookie: adminCookie })
      expect(letter.status).toBe(409)

      const s = await api('/api/data-protection/settings', { cookie: staffCookie })
      expect(s.body.data.ai_external_processing).toBe(false)
    } finally {
      await prisma.organisation.update({ where: { id: orgId }, data: { aiExternalProcessing: true } })
    }
  })
})

describe('client exit date', () => {
  it('is set with the status Inactive, and refused on an active client', async () => {
    const c = await newClient({ status: 'active' })
    const bad = await api(`/api/clients/${c.id}`, { method: 'PATCH', cookie: adminCookie, body: { exit_date: '2026-03-31' } })
    expect(bad.status).toBe(400)
    expect(bad.body.error.details).toHaveProperty('exit_date')

    const good = await api(`/api/clients/${c.id}`, { method: 'PATCH', cookie: adminCookie, body: { status: 'inactive', exit_date: '2026-03-31' } })
    expect(good.status).toBe(200)
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).exitDate).toBe('2026-03-31')
    expect(JSON.stringify(good.body)).toContain('"exit_date":"2026-03-31"')

    const cleared = await api(`/api/clients/${c.id}`, { method: 'PATCH', cookie: adminCookie, body: { status: 'active', exit_date: null } })
    expect(cleared.status).toBe(200)
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).exitDate).toBeNull()
  })
})

describe('records due for deletion, export and purge', () => {
  it('lists only inactive clients whose exit date + retention years has passed, with counts', async () => {
    const old = await fullyLoadedClient('2010-04-01')
    const recent = await newClient({ status: 'inactive', exitDate: '2024-04-01' })
    const activeWithDate = await newClient({ status: 'active', exitDate: '2010-04-01' })

    expect((await api('/api/data-protection/retention/due', { cookie: staffCookie })).status).toBe(403)
    const r = await api('/api/data-protection/retention/due', { cookie: adminCookie })
    expect(r.status).toBe(200)
    const ids = r.body.data.items.map((i: { client_id: string }) => i.client_id)
    expect(ids).toContain(old.c.id)
    expect(ids).not.toContain(recent.id)
    expect(ids).not.toContain(activeWithDate.id)
    const row = r.body.data.items.find((i: { client_id: string }) => i.client_id === old.c.id)
    expect(row).toMatchObject({
      retention_ends: '2018-04-01', due: true,
      remove: { documents: 1, files: 2, audit_files: 1, gst_notices: 1, client_notices: 1, contacts: 1, credentials: 1 },
      retained: { invoices: 1, payments: 1, credit_notes: 0 },
    })

    // A longer retention period takes the client off the list.
    await prisma.organisation.update({ where: { id: orgId }, data: { dataRetentionYears: 20 } })
    expect((await recordsDueForDeletion(orgId)).map((p) => p.client_id)).not.toContain(old.c.id)
    await prisma.organisation.update({ where: { id: orgId }, data: { dataRetentionYears: 8 } })
  })

  it('exports the client as a zip of JSON and files, without credential secrets, and logs it', async () => {
    const { c } = await fullyLoadedClient('2011-04-01')
    expect((await api(`/api/data-protection/clients/${c.id}/export`, { cookie: staffCookie })).status).toBe(403)
    const res = await fetch(`${base}/api/data-protection/clients/${c.id}/export`, { headers: { Cookie: adminCookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment')
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()))
    const names = Object.keys(zip.files)
    expect(names).toEqual(expect.arrayContaining(['client.json', 'invoices.json', 'payments.json', 'documents.json', 'manifest.json', 'credentials.json']))
    expect(names.filter((n) => n.startsWith('files/') && !n.endsWith('/'))).toHaveLength(2)
    const client = JSON.parse(await zip.file('client.json')!.async('string'))
    expect(client.id).toBe(c.id)
    const creds = await zip.file('credentials.json')!.async('string')
    expect(creds).toContain('gst')
    expect(creds).not.toContain('secret-cipher')
    expect(creds).not.toContain('passwordCiphertext')
    const log = await prisma.auditLog.findFirst({ where: { action: 'client.data_exported', entityId: c.id } })
    expect(log?.actorUserId).toBe(adminUserId)
  })

  it('purges only with the typed client code; keeps invoices and payments; removes files; audit-logged', async () => {
    const { c, doc, docKey, wpKey, eng, inv } = await fullyLoadedClient('2012-04-01')
    const notDue = await newClient({ status: 'inactive', exitDate: '2025-01-01' })

    expect((await api(`/api/data-protection/retention/clients/${c.id}/purge`, { method: 'POST', cookie: staffCookie, body: { confirm: c.clientCode } })).status).toBe(403)
    expect((await api(`/api/data-protection/retention/clients/${c.id}/purge`, { method: 'POST', cookie: adminCookie, body: { confirm: 'wrong' } })).status).toBe(400)
    expect((await api(`/api/data-protection/retention/clients/${notDue.id}/purge`, { method: 'POST', cookie: adminCookie, body: { confirm: notDue.clientCode } })).status).toBe(409)
    expect(await clientDocumentStorage.exists(docKey)).toBe(true)

    const r = await api(`/api/data-protection/retention/clients/${c.id}/purge`, { method: 'POST', cookie: adminCookie, body: { confirm: c.clientCode } })
    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({ files_removed: 2, files_failed: [] })

    // Files gone from storage.
    expect(await clientDocumentStorage.exists(docKey)).toBe(false)
    expect(await auditStorage.exists(wpKey)).toBe(false)
    // Removed records.
    expect(await prisma.clientDocumentVersion.count({ where: { documentId: doc.id } })).toBe(0)
    expect((await prisma.clientDocument.findUniqueOrThrow({ where: { id: doc.id } })).deletedAt).not.toBeNull()
    expect(await prisma.auditEngagement.count({ where: { id: eng.id } })).toBe(0)
    expect(await prisma.gstNotice.count({ where: { clientId: c.id } })).toBe(0)
    expect(await prisma.clientNotice.count({ where: { clientId: c.id } })).toBe(0)
    expect(await prisma.clientContact.count({ where: { clientId: c.id } })).toBe(0)
    expect(await prisma.registrationCredential.count({ where: { clientId: c.id } })).toBe(0)
    // Statutory records retained.
    expect(await prisma.invoice.count({ where: { id: inv.id } })).toBe(1)
    expect(await prisma.invoicePayment.count({ where: { clientId: c.id } })).toBe(1)
    const master = await prisma.client.findUniqueOrThrow({ where: { id: c.id } })
    expect(master.deletedAt).not.toBeNull()
    expect(master).toMatchObject({ companyName: c.companyName, email: null, address: null, contactNumber: '' })

    const log = await prisma.auditLog.findFirst({ where: { action: 'client.records_purged', entityId: c.id } })
    expect(log?.actorUserId).toBe(adminUserId)
    expect(log?.afterJson).toContain('"invoices":1')

    // Gone from the list; a second purge finds nothing.
    expect((await recordsDueForDeletion(orgId)).map((p) => p.client_id)).not.toContain(c.id)
    expect((await api(`/api/data-protection/retention/clients/${c.id}/purge`, { method: 'POST', cookie: adminCookie, body: { confirm: c.clientCode } })).status).toBe(404)
  })
})

describe('daily audit-chain check', () => {
  it('notifies every Admin once a day when the chain is broken, and nobody when intact', async () => {
    const intact = await runAuditChainCheck(prisma, { verify: async () => ({ ok: true, checked: 3, pre_chain: 0, first_broken: null }) })
    expect(intact.notified).toBe(0)

    const seq = 900_000_000 + Math.floor(Math.random() * 1000)
    const broken = async () => ({ ok: false, checked: 2, pre_chain: 0, first_broken: { seq, id: 'x', reason: 'hash_mismatch' as const, created_at: new Date().toISOString() } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = await runAuditChainCheck(prisma, { verify: broken, today: '2099-01-01' })
    expect(first.notified).toBeGreaterThan(0)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('AUDIT LOG CHAIN BROKEN'))
    const mine = await prisma.notification.findFirst({ where: { userId: adminUserId, type: 'audit_chain_broken', entityId: `audit_chain:${seq}:2099-01-01` } })
    expect(mine?.module).toBe('system')
    // Same break, same day: no second round of notifications.
    expect((await runAuditChainCheck(prisma, { verify: broken, today: '2099-01-01' })).notified).toBe(0)
    spy.mockRestore()
  })
})
