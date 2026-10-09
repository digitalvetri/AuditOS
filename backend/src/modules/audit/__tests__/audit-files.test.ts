import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'

vi.hoisted(() => {
  process.env.AUDIT_FILES_STORAGE_ROOT = `${process.env.TMPDIR ?? '/tmp'}/auditos-test-audit-files-${process.pid}`
})

import JSZip from 'jszip'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { seedAudit } from '../../../../prisma/seed-audit.js'
import { addDays, istToday } from '../../../lib/dates.js'
import { computeMateriality } from '../service.js'

/**
 * Audit files (docs/audit-files/README.md): working-paper index on create,
 * client scoping, maker-checker on working papers and checklists, sign
 * blockers, the lock (423) and its addendum, UDINs, materiality, export.
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

async function upload(p: string, cookie: string, fields: Record<string, string> = {}, bytes = Buffer.from('%PDF-1.4\n% evidence\n'), name = 'bank-confirmation.pdf') {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  form.append('file', new Blob([bytes], { type: 'application/pdf' }), name)
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { Cookie: cookie }, body: form })
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body: body as any }
}

async function staff(code: string) {
  const r = await prisma.role.findUniqueOrThrow({ where: { code } })
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AO'), firstName: 'S', lastName: code, fullName: `S ${code} ${uid('n')}`, email: `${uid('s')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: r.id, employeeId: emp.id } })
  return { emp, cookie: `ao_access=${signToken(u.id)}` }
}

let partner: Awaited<ReturnType<typeof staff>>
let manager: Awaited<ReturnType<typeof staff>>
let senior: Awaited<ReturnType<typeof staff>>
let outsider: Awaited<ReturnType<typeof staff>>
let assigned: Awaited<ReturnType<typeof staff>>
let clientId = ''
const MNO = '212345'

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  await seedAudit(prisma)
  partner = await staff('md')
  manager = await staff('md')
  senior = await staff('dept_manager')
  outsider = await staff('employee')
  assigned = await staff('employee')
  clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Audit Co Pvt Ltd', contactPerson: 'P', contactNumber: '9876543210', accountManagerId: assigned.emp.id, onboardingDate: '2026-01-01' } })).id
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

let fy = 2000
async function newFile(type = 'statutory', extra: Record<string, unknown> = {}) {
  fy += 1
  const r = await api('/api/audits', {
    method: 'POST', cookie: partner.cookie,
    body: { client_id: clientId, financial_year: `${fy}-${String((fy + 1) % 100).padStart(2, '0')}`, audit_type: type, signing_partner_id: partner.emp.id, partner_membership_no: MNO, manager_id: manager.emp.id, ...extra },
  })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.data
}

/** Everything needed to sign: acceptance, independence, every WP and checklist item. */
async function makeSignable(id: string, auditType: string) {
  const f = (await api(`/api/audits/${id}`, { cookie: partner.cookie })).body.data
  const templates = (await api('/api/audits/checklist-templates', { cookie: partner.cookie })).body.data.items as { code: string; applies_to: string }[]
  for (const t of templates.filter((x) => x.applies_to.split(',').includes(auditType))) {
    const items = (await api(`/api/audits/${id}/checklists/${t.code}`, { cookie: partner.cookie })).body.data.items as { clause: string }[]
    for (const it of items) {
      const r = await api(`/api/audits/${id}/checklists/${t.code}/${encodeURIComponent(it.clause)}`, { method: 'PUT', cookie: senior.cookie, body: { answer: 'yes' } })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
    }
  }
  expect((await api(`/api/audits/${id}/acceptance/approve`, { method: 'POST', cookie: partner.cookie })).status).toBe(200)
  for (const who of [partner, manager]) {
    expect((await api(`/api/audits/${id}/team/declare-independence`, { method: 'POST', cookie: who.cookie, body: {} })).status).toBe(200)
  }
  const wps = (await api(`/api/audits/${id}/working-papers`, { cookie: partner.cookie })).body.data.items as { id: string }[]
  for (const wp of wps) {
    await api(`/api/audits/${id}/working-papers/${wp.id}`, { method: 'PATCH', cookie: senior.cookie, body: { conclusion: 'Satisfactory.' } })
    expect((await api(`/api/audits/${id}/working-papers/${wp.id}/prepare`, { method: 'POST', cookie: senior.cookie })).status).toBe(200)
    expect((await api(`/api/audits/${id}/working-papers/${wp.id}/review`, { method: 'POST', cookie: manager.cookie })).status).toBe(200)
  }
  return f
}

describe('create', () => {
  it('allocates AUD-YYYY-NNNN, seeds the statutory working-paper index and the team', async () => {
    const f = await newFile('statutory')
    expect(f.audit_code).toMatch(new RegExp(`^AUD-${istToday().slice(0, 4)}-\\d{4}$`))
    expect(f.status).toBe('planning')
    expect(f.team.map((t: any) => t.role).sort()).toEqual(['manager', 'partner'])
    const wps = (await api(`/api/audits/${f.id}/working-papers`, { cookie: partner.cookie })).body.data.items
    const refs = wps.map((w: any) => w.ref)
    expect(refs).toHaveLength(6 + 1 + 13 + 4 + 3)
    expect(refs.slice(0, 3)).toEqual(['A-1', 'A-2', 'A-3'])
    expect(refs).toContain('C-13')
    expect(refs).toContain('E-3')
  })

  it('a tax audit gets A-1..A-4, T-1..T-6 and E-3', async () => {
    const f = await newFile('tax')
    const refs = (await api(`/api/audits/${f.id}/working-papers`, { cookie: partner.cookie })).body.data.items.map((w: any) => w.ref)
    expect(refs).toEqual(['A-1', 'A-2', 'A-3', 'A-4', 'T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-6', 'E-3'])
  })

  it('refuses a second file for the same client, year and type', async () => {
    const f = await newFile('internal')
    const r = await api('/api/audits', { method: 'POST', cookie: partner.cookie, body: { client_id: clientId, financial_year: f.financial_year, audit_type: 'internal' } })
    expect(r.status).toBe(409)
  })
})

describe('client scoping', () => {
  it('a user not assigned to the client can neither see nor list the file', async () => {
    const f = await newFile('stock')
    expect((await api(`/api/audits/${f.id}`, { cookie: outsider.cookie })).status).toBe(403)
    expect((await api(`/api/audits/${f.id}/working-papers`, { cookie: outsider.cookie })).status).toBe(403)
    const list = await api('/api/audits', { cookie: outsider.cookie })
    expect(list.status).toBe(200)
    expect(JSON.stringify(list.body)).not.toContain(f.id)
    expect((await api('/api/audits', { method: 'POST', cookie: outsider.cookie, body: { client_id: clientId, financial_year: '2090-91', audit_type: 'bank' } })).status).toBe(403)
  })
  it('the assigned associate can', async () => {
    const f = await newFile('bank')
    expect((await api(`/api/audits/${f.id}`, { cookie: assigned.cookie })).status).toBe(200)
    expect(JSON.stringify((await api('/api/audits', { cookie: assigned.cookie })).body)).toContain(f.id)
  })
})

describe('working papers', () => {
  it('prepare needs a conclusion; the preparer cannot review; another person can', async () => {
    const f = await newFile('gst')
    const wp = (await api(`/api/audits/${f.id}/working-papers`, { cookie: partner.cookie })).body.data.items[0]
    expect((await api(`/api/audits/${f.id}/working-papers/${wp.id}/prepare`, { method: 'POST', cookie: senior.cookie })).status).toBe(422)
    await api(`/api/audits/${f.id}/working-papers/${wp.id}`, { method: 'PATCH', cookie: senior.cookie, body: { conclusion: 'Letter on file.' } })
    const prep = await api(`/api/audits/${f.id}/working-papers/${wp.id}/prepare`, { method: 'POST', cookie: senior.cookie })
    expect(prep.status).toBe(200)
    expect(prep.body.data.prepared_by).toBe(senior.emp.id)
    expect((await api(`/api/audits/${f.id}/working-papers/${wp.id}/review`, { method: 'POST', cookie: senior.cookie })).status).toBe(403)
    const rev = await api(`/api/audits/${f.id}/working-papers/${wp.id}/review`, { method: 'POST', cookie: manager.cookie })
    expect(rev.status).toBe(200)
    expect(rev.body.data.status).toBe('reviewed')
    // Reviewed: no edits until reopened.
    expect((await api(`/api/audits/${f.id}/working-papers/${wp.id}`, { method: 'PATCH', cookie: senior.cookie, body: { title: 'X' } })).status).toBe(422)
    expect((await api(`/api/audits/${f.id}/working-papers/${wp.id}/reopen`, { method: 'POST', cookie: manager.cookie, body: {} })).status).toBe(400)
    const re = await api(`/api/audits/${f.id}/working-papers/${wp.id}/reopen`, { method: 'POST', cookie: manager.cookie, body: { reason: 'More work' } })
    expect(re.body.data.status).toBe('prepared')
    expect(re.body.data.reviewed_by).toBeNull()
  })

  it('review is blocked while a note on the paper is not cleared', async () => {
    const f = await newFile('concurrent')
    const wp = (await api(`/api/audits/${f.id}/working-papers`, { cookie: partner.cookie })).body.data.items[1]
    await api(`/api/audits/${f.id}/working-papers/${wp.id}`, { method: 'PATCH', cookie: senior.cookie, body: { conclusion: 'Done.' } })
    await api(`/api/audits/${f.id}/working-papers/${wp.id}/prepare`, { method: 'POST', cookie: senior.cookie })
    const note = await api(`/api/audits/${f.id}/review-notes`, { method: 'POST', cookie: manager.cookie, body: { working_paper_id: wp.id, note: 'Attach the confirmation.' } })
    expect(note.status).toBe(201)
    const blocked = await api(`/api/audits/${f.id}/working-papers/${wp.id}/review`, { method: 'POST', cookie: manager.cookie })
    expect(blocked.status).toBe(422)
    expect(blocked.body.error.code).toBe('review_notes_open')
    expect((await api(`/api/audits/${f.id}/review-notes/${note.body.data.id}/respond`, { method: 'POST', cookie: senior.cookie, body: { response: 'Attached.' } })).body.data.status).toBe('responded')
    // Responded is still not cleared.
    expect((await api(`/api/audits/${f.id}/working-papers/${wp.id}/review`, { method: 'POST', cookie: manager.cookie })).status).toBe(422)
    // Only the raiser, manager or signing partner clears.
    expect((await api(`/api/audits/${f.id}/review-notes/${note.body.data.id}/clear`, { method: 'POST', cookie: senior.cookie })).status).toBe(403)
    expect((await api(`/api/audits/${f.id}/review-notes/${note.body.data.id}/clear`, { method: 'POST', cookie: manager.cookie })).body.data.status).toBe('cleared')
    expect((await api(`/api/audits/${f.id}/working-papers/${wp.id}/review`, { method: 'POST', cookie: manager.cookie })).status).toBe(200)
  })

  it('evidence upload is content-checked and keeps its sha256', async () => {
    const f = await newFile('other')
    const wp = (await api(`/api/audits/${f.id}/working-papers`, { cookie: partner.cookie })).body.data.items[0]
    const bad = await upload(`/api/audits/${f.id}/working-papers/${wp.id}/files`, senior.cookie, {}, Buffer.from('<html>not a pdf</html>'))
    expect(bad.status).toBe(422)
    const good = await upload(`/api/audits/${f.id}/working-papers/${wp.id}/files`, senior.cookie)
    expect(good.status).toBe(201)
    expect(good.body.data.sha256).toMatch(/^[0-9a-f]{64}$/)
    const dl = await fetch(`${base}/api/audits/${f.id}/working-papers/${wp.id}/files/${good.body.data.id}`, { headers: { Cookie: partner.cookie } })
    expect(dl.status).toBe(200)
    expect(Buffer.from(await dl.arrayBuffer()).toString('latin1').startsWith('%PDF')).toBe(true)
  })
})

describe('checklists', () => {
  it('lists the four templates with counts', async () => {
    const t = (await api('/api/audits/checklist-templates', { cookie: partner.cookie })).body.data.items
    expect(t.map((x: any) => x.code)).toEqual(['acceptance', 'caro_2020', 'form_3cd', 'completion'])
    expect(t.find((x: any) => x.code === 'form_3cd').item_count).toBeGreaterThan(80)
    expect(t.find((x: any) => x.code === 'caro_2020').source).toContain('G.S.R. 207(E)')
  })

  it('answer, then review by someone else; a changed answer drops the review', async () => {
    const f = await newFile('statutory')
    const clause = encodeURIComponent('3(i)(a)(A)')
    const a = await api(`/api/audits/${f.id}/checklists/caro_2020/${clause}`, { method: 'PUT', cookie: senior.cookie, body: { answer: 'yes', remarks: 'Fixed asset register maintained.', working_paper_ref: 'C-4' } })
    expect(a.status).toBe(200)
    expect(a.body.data.item.prepared_by).toBe(senior.emp.id)
    expect((await api(`/api/audits/${f.id}/checklists/caro_2020/${clause}/review`, { method: 'POST', cookie: senior.cookie })).status).toBe(403)
    const r = await api(`/api/audits/${f.id}/checklists/caro_2020/${clause}/review`, { method: 'POST', cookie: manager.cookie })
    expect(r.status).toBe(200)
    expect(r.body.data.item.reviewed_by).toBe(manager.emp.id)
    const list = (await api(`/api/audits/${f.id}/checklists/caro_2020`, { cookie: partner.cookie })).body.data
    expect(list.counts.answered).toBe(1)
    expect(list.counts.reviewed).toBe(1)
    expect(list.items[0]).toMatchObject({ clause: '3(i)(a)(A)', answer: 'yes', working_paper_ref: 'C-4' })
    const changed = await api(`/api/audits/${f.id}/checklists/caro_2020/${clause}`, { method: 'PUT', cookie: manager.cookie, body: { answer: 'qualified', remarks: 'Not updated.' } })
    expect(changed.body.data.item.reviewed_by).toBeNull()
    expect(changed.body.data.item.prepared_by).toBe(manager.emp.id)
    expect((await api(`/api/audits/${f.id}/checklists/caro_2020/${encodeURIComponent('99(z)')}`, { method: 'PUT', cookie: senior.cookie, body: { answer: 'yes' } })).status).toBe(404)
  })

  it('acceptance approval needs a partner and a complete acceptance checklist', async () => {
    const f = await newFile('internal')
    const r = await api(`/api/audits/${f.id}/acceptance/approve`, { method: 'POST', cookie: partner.cookie })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('acceptance_incomplete')
    expect((await api(`/api/audits/${f.id}/acceptance/approve`, { method: 'POST', cookie: manager.cookie })).status).toBe(403)
  })

  it('the seed is idempotent and leaves responses alone', async () => {
    const before = [await prisma.auditChecklistTemplate.count(), await prisma.auditChecklistItem.count(), await prisma.auditChecklistResponse.count()]
    await seedAudit(prisma)
    await seedAudit(prisma)
    expect([await prisma.auditChecklistTemplate.count(), await prisma.auditChecklistItem.count(), await prisma.auditChecklistResponse.count()]).toEqual(before)
  })
})

describe('materiality', () => {
  it('computes overall, performance and clearly trivial on the server', async () => {
    const f = await newFile('statutory')
    const r = await api(`/api/audits/${f.id}/materiality`, { method: 'PUT', cookie: senior.cookie, body: { benchmark: 'revenue', base_paise: 1_23_45_678_90, percent: '0.5', rationale: 'Revenue-driven entity.' } })
    expect(r.status).toBe(200)
    // 12,34,56,789.0 paise × 0.5% = 61,72,839.45 → 6,17,284 (half-up to the paisa)
    expect(r.body.data.materiality).toMatchObject({ benchmark: 'revenue', base_paise: 12345678 * 100 + 90, percent: '0.5', overall_paise: 6172839, performance_paise: 4629629, clearly_trivial_paise: 308642, performance_percent: 75, trivial_percent: 5 })
    const g = (await api(`/api/audits/${f.id}`, { cookie: partner.cookie })).body.data.materiality
    expect(g.overall_paise).toBe(6172839)
    expect(computeMateriality(100_000_00n, 5, 75, 5)).toEqual({ overall: 5_000_00n, performance: 3_750_00n, trivial: 250_00n })
  })
})

describe('sign, lock, addendum', () => {
  it('sign is blocked with the list of blockers, and only the signing partner signs', async () => {
    const f = await newFile('statutory')
    expect((await api(`/api/audits/${f.id}/sign`, { method: 'POST', cookie: manager.cookie, body: { report_date: istToday(), opinion_type: 'unmodified', report_place: 'Chennai' } })).status).toBe(403)
    const r = await api(`/api/audits/${f.id}/sign`, { method: 'POST', cookie: partner.cookie, body: { report_date: istToday(), opinion_type: 'unmodified', report_place: 'Chennai' } })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('sign_blocked')
    const codes = r.body.error.details.blocker_details.map((b: any) => b.code)
    expect(r.body.error.details.blockers[0]).toEqual(expect.any(String))
    expect(codes).toEqual(expect.arrayContaining(['acceptance_not_approved', 'working_papers_not_reviewed', 'independence_not_declared', 'checklist_pending']))
    const detail = (await api(`/api/audits/${f.id}`, { cookie: partner.cookie })).body.data
    expect(detail.blocker_details.map((b: any) => b.code)).toEqual(codes)
    expect(detail.blockers).toHaveLength(codes.length)
    expect(detail.signing_partner).toMatchObject({ id: partner.emp.id, employee_code: partner.emp.employeeCode })
    expect(detail.progress.checklist_pending).toBeGreaterThan(40)
  })

  it('signs, sets assembly due +60 days with UDIN; locks; then every write is 423 except an addendum', async () => {
    const f = await newFile('tax')
    await makeSignable(f.id, 'tax')
    // An open note anywhere still blocks.
    const note = await api(`/api/audits/${f.id}/review-notes`, { method: 'POST', cookie: manager.cookie, body: { note: 'General point.' } })
    const blocked = await api(`/api/audits/${f.id}/sign`, { method: 'POST', cookie: partner.cookie, body: { report_date: istToday(), opinion_type: 'unmodified', report_place: 'Chennai' } })
    expect(blocked.status).toBe(422)
    expect(blocked.body.error.details.blocker_details.map((b: any) => b.code)).toEqual(['review_notes_open'])
    await api(`/api/audits/${f.id}/review-notes/${note.body.data.id}/clear`, { method: 'POST', cookie: manager.cookie })

    const reportDate = addDays(istToday(), -3)
    const yy = istToday().slice(2, 4)
    const wrongMember = `${yy}999999ABCDE12345`
    expect((await api(`/api/audits/${f.id}/sign`, { method: 'POST', cookie: partner.cookie, body: { report_date: reportDate, opinion_type: 'qualified', report_place: 'Chennai', udin: wrongMember } })).status).toBe(422)
    const udin = `${yy}${MNO}BGXYZA${uid('').slice(-4).toUpperCase().replace(/[^A-Z0-9]/g, 'Q')}`
    const signed = await api(`/api/audits/${f.id}/sign`, { method: 'POST', cookie: partner.cookie, body: { report_date: reportDate, opinion_type: 'qualified', report_place: 'Chennai', udin } })
    expect(signed.status, JSON.stringify(signed.body)).toBe(200)
    expect(signed.body.data).toMatchObject({ status: 'signed', report_date: reportDate, opinion_type: 'qualified', report_place: 'Chennai', assembly_due_date: addDays(reportDate, 60), locked: false })
    const reg = (await api(`/api/audits/udins?client_id=${clientId}`, { cookie: partner.cookie })).body.data.items
    expect(reg.find((u: any) => u.udin === udin)).toMatchObject({ document_type: 'tax_audit_report', engagement_id: f.id, membership_no: MNO })

    // Lock: not by the senior, yes by the manager.
    expect((await api(`/api/audits/${f.id}/lock`, { method: 'POST', cookie: senior.cookie })).status).toBe(403)
    const locked = await api(`/api/audits/${f.id}/lock`, { method: 'POST', cookie: manager.cookie })
    expect(locked.status).toBe(200)
    expect(locked.body.data.locked).toBe(true)

    const wps = (await api(`/api/audits/${f.id}/working-papers`, { cookie: partner.cookie })).body.data.items
    for (const [path, method, body] of [
      [`/api/audits/${f.id}`, 'PATCH', { title: 'x' }],
      [`/api/audits/${f.id}/working-papers/${wps[0].id}`, 'PATCH', { area: 'x' }],
      [`/api/audits/${f.id}/review-notes`, 'POST', { note: 'late' }],
      [`/api/audits/${f.id}/risks`, 'POST', { area: 'Revenue', description: 'x' }],
      [`/api/audits/${f.id}/materiality`, 'PUT', { benchmark: 'revenue', base_paise: 1, percent: 1 }],
      [`/api/audits/${f.id}/checklists/form_3cd/1`, 'PUT', { answer: 'no' }],
      [`/api/audits/${f.id}/working-papers`, 'POST', { ref: 'Z-1', section: 'completion', title: 'Late' }],
    ] as const) {
      const r = await api(path, { method, cookie: partner.cookie, body })
      expect(r.status, `${method} ${path}`).toBe(423)
      expect(r.body.error.code).toBe('file_locked')
    }
    expect((await upload(`/api/audits/${f.id}/working-papers/${wps[0].id}/files`, partner.cookie)).status).toBe(423)

    // Addendum: not by the senior; needs a reason; partner/manager can.
    expect((await api(`/api/audits/${f.id}/working-papers`, { method: 'POST', cookie: senior.cookie, body: { ref: 'Z-1', section: 'completion', title: 'Late', addendum: true, addendum_reason: 'x' } })).status).toBe(403)
    expect((await api(`/api/audits/${f.id}/working-papers`, { method: 'POST', cookie: partner.cookie, body: { ref: 'Z-1', section: 'completion', title: 'Late', addendum: true } })).status).toBe(400)
    const add = await api(`/api/audits/${f.id}/working-papers`, { method: 'POST', cookie: partner.cookie, body: { ref: 'Z-1', section: 'completion', title: 'Bank confirmation received after assembly', addendum: true, addendum_reason: 'Confirmation arrived late' } })
    expect(add.status).toBe(201)
    expect(add.body.data).toMatchObject({ is_addendum: true, addendum_reason: 'Confirmation arrived late' })
    const addFile = await upload(`/api/audits/${f.id}/working-papers/${add.body.data.id}/files`, manager.cookie, { addendum: 'true', addendum_reason: 'Late confirmation' })
    expect(addFile.status).toBe(201)
    expect(addFile.body.data.is_addendum).toBe(true)
    const logged = await prisma.auditLog.findMany({ where: { entityId: add.body.data.id } })
    expect(logged.map((l) => l.action)).toContain('audit_file.addendum_working_paper')

    // Export works on a locked file and carries the evidence.
    const res = await fetch(`${base}/api/audits/${f.id}/export`, { headers: { Cookie: partner.cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/zip')
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()))
    const index = await zip.file('index.html')!.async('string')
    expect(index).toContain(f.audit_code)
    expect(index).toContain(udin)
    expect(index).toContain('Confirmation arrived late')
    expect(Object.keys(zip.files).some((p) => p.startsWith('working-papers/Z-1/'))).toBe(true)
    expect(await prisma.auditLog.count({ where: { entityId: f.id, action: 'audit_file.export' } })).toBe(1)
  })
})

describe('UDIN register', () => {
  it('checks format and the membership number inside', async () => {
    const yy = istToday().slice(2, 4)
    const body = (udin: string, membership_no = MNO) => ({ client_id: clientId, udin, document_type: 'certificate', document_date: istToday(), membership_no, generated_on: istToday() })
    expect((await api('/api/audits/udins', { method: 'POST', cookie: partner.cookie, body: body('ABC') })).status).toBe(400)
    expect((await api('/api/audits/udins', { method: 'POST', cookie: partner.cookie, body: body(`${yy}${MNO}abcde12345`) })).status).toBe(201) // lower-case is upper-cased
    const mismatch = await api('/api/audits/udins', { method: 'POST', cookie: partner.cookie, body: body(`${yy}123456ABCDE12345`) })
    expect(mismatch.status).toBe(422)
    expect(mismatch.body.error.code).toBe('udin_membership_mismatch')
    const ok = await api('/api/audits/udins', { method: 'POST', cookie: partner.cookie, body: body(`${yy}012345CERT000001`, '12345') })
    expect(ok.status).toBe(201)
    expect(ok.body.data.membership_no).toBe('012345')
    expect((await api('/api/audits/udins', { method: 'POST', cookie: partner.cookie, body: body(`${yy}012345CERT000001`, '12345') })).status).toBe(409)
    const rev = await api(`/api/audits/udins/${ok.body.data.id}/revoke`, { method: 'POST', cookie: partner.cookie, body: { reason: 'Wrong document' } })
    expect(rev.body.data.revoked).toBe(true)
    const list = (await api(`/api/audits/udins?client_id=${clientId}`, { cookie: partner.cookie })).body.data.items
    expect(list.some((u: any) => u.id === ok.body.data.id)).toBe(false)
    const all = (await api(`/api/audits/udins?client_id=${clientId}&include_revoked=1`, { cookie: partner.cookie })).body.data.items
    expect(all.some((u: any) => u.id === ok.body.data.id)).toBe(true)
    expect((await api('/api/audits/udins', { method: 'POST', cookie: outsider.cookie, body: body(`${yy}${MNO}OUTSID0001`) })).status).toBe(403)
  })

  it('lists signed files without a UDIN', async () => {
    const f = await newFile('statutory')
    await prisma.auditEngagement.update({ where: { id: f.id }, data: { status: 'signed', reportDate: istToday() } })
    const missing = (await api('/api/audits/udins/missing', { cookie: partner.cookie })).body.data.items
    expect(missing.some((m: any) => m.id === f.id)).toBe(true)
  })
})
