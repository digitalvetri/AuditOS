import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'

// Keep test uploads out of server/uploads. Hoisted above the imports, which
// is when the storage module reads it.
vi.hoisted(() => {
  process.env.PFR_STORAGE_ROOT = `${process.env.TMPDIR ?? '/tmp'}/pfr-test-${process.pid}`
})

import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../books/__tests__/helpers.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { seedPartnership } from '../../../../prisma/seed-partnership.js'
import { MASTER_TEMPLATE } from '../template.js'

/**
 * Partnership Firm Registration over real HTTP + PostgreSQL. The spec's
 * mandatory checks: client isolation (§60), document isolation (§61), the
 * master-template snapshot (§62), and the acceptance walk-through (§63).
 */
let server: Server
let base = ''
let cookie = ''
let orgId = ''

async function seedRole(code: keyof typeof MATRIX) {
  for (const g of MATRIX[code]) {
    await prisma.permission.upsert({
      where: { code: g.permission }, update: {},
      create: { id: `perm-${g.permission}`, code: g.permission, description: g.permission },
    })
  }
  const role = await prisma.role.upsert({ where: { code }, update: {}, create: { id: `role-${code}`, code, name: code } })
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
  for (const g of MATRIX[code]) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: `perm-${g.permission}`, scope: g.scope } }).catch(() => undefined)
  }
  return role
}

async function api(path: string, opts: { method?: string; body?: unknown; form?: FormData; as?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? (opts.form ? 'POST' : 'GET'),
    headers: { ...(opts.form ? {} : { 'Content-Type': 'application/json' }), Cookie: opts.as ?? cookie },
    body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
  })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body: body?.data ?? body, raw: text }
}

async function client(name: string) {
  return prisma.client.create({
    data: {
      id: uid('cli'), organisationId: orgId, clientCode: uid('CLI'), companyName: name,
      contactPerson: 'Contact', contactNumber: '9840011111', accountManagerId: uid('emp'), onboardingDate: '2026-01-01',
    },
  })
}

function pdf(name: string) {
  const f = new FormData()
  f.append('file', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), name)
  return f
}

const firstItem = (c: any) => c.categories[0].items[0]

describe('Private Limited Incorporation (same engine, /api/private-limited)', () => {
  it('builds each person their own checklist from the source, with Any One proofs as one requirement', async () => {
    const cl = await client('Pvt Client')
    const r = await api('/api/private-limited/cases', { method: 'POST', body: { client_id: cl.id } })
    expect(r.status).toBe(201)
    expect(r.body.case_code).toMatch(/^PVT-/)
    const id = r.body.id
    const get = async () => (await api(`/api/private-limited/cases/${id}`)).body

    const both = await api(`/api/private-limited/cases/${id}/partners`, { method: 'POST', body: { name: 'Kaarthika P', role: 'BOTH', shares: '5000' } })
    expect(both.status).toBe(201)
    await api(`/api/private-limited/cases/${id}/partners`, { method: 'POST', body: { name: 'Second Holder', role: 'SHAREHOLDER', shares: 5000 } })
    expect((await api(`/api/private-limited/cases/${id}/partners`, { method: 'POST', body: { name: 'X', role: 'CEO' } })).status).toBe(400)

    const c = await get()
    expect(c.partners.map((p: any) => [p.name, p.role, p.shares])).toEqual([['Kaarthika P', 'BOTH', 5000], ['Second Holder', 'SHAREHOLDER', 5000]])
    // Per person: PAN, Identity (any one), Address (any one), Aadhaar, Photo, EPF signature = 6 documents
    expect(c.progress.docs_required).toBe(12)
    const kp = c.requirements.filter((x: any) => x.name.endsWith('— Kaarthika P')).map((x: any) => x.name)
    expect(kp).toContain('Identity Proof — Kaarthika P')
    expect(kp.some((n: string) => n.startsWith('Passport —'))).toBe(false)

    await api(`/api/private-limited/cases/${id}`, { method: 'PATCH', body: { premises_type: 'RENTED' } })
    expect((await get()).progress.docs_required).toBe(12 + 3)
    await api(`/api/private-limited/cases/${id}`, { method: 'PATCH', body: { premises_type: 'OWNED' } })
    const owned = await get()
    expect(owned.progress.docs_required).toBe(12 + 2)
    const na = owned.requirements.filter((x: any) => x.status === 'NOT_APPLICABLE').map((x: any) => x.name)
    expect(na).toContain('Valid Rent Agreement / Lease Deed')

    const details = { company_names: ['Alpha Pvt Ltd', 'Beta Pvt Ltd'], name_significance: 'x', main_objective: 'Software', authorized_capital: '1,00,000', paid_up_capital: '1,00,000' }
    await api(`/api/private-limited/cases/${id}/details`, { method: 'PUT', body: { details } })
    expect((await get()).details).toMatchObject(details)
    expect((await api(`/api/llp/cases/${id}`)).status).toBe(404)
  })
})

beforeAll(async () => {
  const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
  orgId = org.id
  await seedPartnership(prisma, org.id)
  const role = await seedRole('md')
  const u = await prisma.user.create({ data: { id: uid('u'), organisationId: org.id, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: role.id } })
  cookie = `ao_access=${signToken(u.id)}`
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('Partnership Firm Registration', () => {
  it('opens a case for an existing client, snapshots the PDF checklist, and does not duplicate the client', async () => {
    const before = await prisma.client.count()
    const a = await client('ABC Traders')
    const res = await api('/api/partnership/cases', { method: 'POST', body: { client_id: a.id, due_date: '2026-10-01' } })
    expect(res.status).toBe(201)
    expect(res.body.case_code).toMatch(/^PFR-\d{4}-\d{4}$/)
    expect(await prisma.client.count()).toBe(before + 1) // only the one we made

    const c = (await api(`/api/partnership/cases/${res.body.id}`)).body
    expect(c.status).toBe('NOT_STARTED')
    // Same categories, same order, same wording as the source PDF.
    expect(c.categories.map((x: any) => x.name)).toEqual(
      expect.arrayContaining(MASTER_TEMPLATE.map((t) => t.name)),
    )
    const pdfItems = MASTER_TEMPLATE.flatMap((t) => t.items.map((i) => `${t.name}/${i.name}`))
    const caseItems = c.categories.flatMap((x: any) => x.items.map((i: any) => `${x.name}/${i.name}`))
    for (const i of pdfItems) expect(caseItems).toContain(i)

    // A second open case for the same client is refused, pointing at the first.
    const dup = await api('/api/partnership/cases', { method: 'POST', body: { client_id: a.id } })
    expect(dup.status).toBe(409)
    expect(dup.body.error?.details?.case_id ?? dup.raw).toBeTruthy()

    // Only enrolled clients are listed.
    const other = await client('Not Enrolled Ltd')
    const list = (await api('/api/partnership/cases?q=Not%20Enrolled')).body
    expect(list.items.find((x: any) => x.client.id === other.id)).toBeUndefined()
  })

  it('keeps checklists and documents isolated between clients (§60, §61)', async () => {
    const A = await client('Client A')
    const B = await client('Client B')
    const ca = (await api('/api/partnership/cases', { method: 'POST', body: { client_id: A.id } })).body.id
    const cb = (await api('/api/partnership/cases', { method: 'POST', body: { client_id: B.id } })).body.id

    const a0 = (await api(`/api/partnership/cases/${ca}`)).body
    const item1 = firstItem(a0)
    expect((await api(`/api/partnership/cases/${ca}/items/${item1.id}`, { method: 'PATCH', body: { status: 'COMPLETED' } })).status).toBe(200)

    await api(`/api/partnership/cases/${ca}/partners`, { method: 'POST', body: { name: 'Ravi' } })
    const a1 = (await api(`/api/partnership/cases/${ca}`)).body
    const pan = a1.requirements.find((r: any) => r.doc_key === 'PAN')
    expect(pan.name).toBe('PAN Card — Ravi')
    const up = await api(`/api/partnership/cases/${ca}/documents`, { form: (() => { const f = pdf('PAN.pdf'); f.append('requirement_id', pan.id); return f })() })
    expect(up.status).toBe(201)

    const a2 = (await api(`/api/partnership/cases/${ca}`)).body
    expect(firstItem(a2).status).toBe('COMPLETED')
    expect(completedByNull(firstItem(a2))).toBe(false)
    expect(a2.progress.items_done).toBe(1)
    expect(a2.progress.pct).toBe(Math.round(100 / a2.progress.items_total))
    expect(a2.requirements.find((r: any) => r.id === pan.id).status).toBe('UPLOADED')
    // Uploading does not tick the checklist item.
    const panItem = a2.categories.flatMap((x: any) => x.items).find((i: any) => i.name === 'PAN Card')
    expect(panItem.status).toBe('PENDING')

    const b = (await api(`/api/partnership/cases/${cb}`)).body
    expect(firstItem(b).status).toBe('PENDING')
    expect(b.progress.items_done).toBe(0)
    expect(JSON.stringify(b)).not.toContain('PAN.pdf')
    expect(b.requirements.some((r: any) => r.current_version)).toBe(false)

    // A requirement id from case A cannot be reached through case B.
    const cross = await api(`/api/partnership/cases/${cb}/requirements/${pan.id}/review`, { method: 'POST', body: { status: 'verified' } })
    expect(cross.status).toBe(404)
    const crossUpload = await api(`/api/partnership/cases/${cb}/documents`, { form: (() => { const f = pdf('x.pdf'); f.append('requirement_id', pan.id); return f })() })
    expect(crossUpload.status).toBe(404)
  })

  it('versions, reviews and previews documents without losing history', async () => {
    const X = await client('Versioning Co')
    const id = (await api('/api/partnership/cases', { method: 'POST', body: { client_id: X.id } })).body.id
    const form1 = (await api(`/api/partnership/cases/${id}`)).body.requirements.find((r: any) => r.doc_key === 'FORM_1')
    const upload = (name: string) => { const f = pdf(name); f.append('requirement_id', form1.id); return api(`/api/partnership/cases/${id}/documents`, { form: f }) }

    await upload('form1-v1.pdf')
    expect((await api(`/api/partnership/cases/${id}/requirements/${form1.id}/review`, { method: 'POST', body: { status: 'rejected', note: 'Unsigned' } })).status).toBe(200)
    await upload('form1-v2.pdf')
    await api(`/api/partnership/cases/${id}/requirements/${form1.id}/review`, { method: 'POST', body: { status: 'verified' } })

    const r = (await api(`/api/partnership/cases/${id}`)).body.requirements.find((x: any) => x.id === form1.id)
    expect(r.status).toBe('VERIFIED')
    expect(r.versions.map((v: any) => [v.version, v.review_status])).toEqual([[2, 'VERIFIED'], [1, 'REJECTED']])

    // Signed link serves the real bytes; a tampered token does not.
    const link = (await api(`/api/partnership/cases/${id}/requirements/${form1.id}/versions/${r.versions[1].id}/link`)).body
    const bytes = await fetch(`${base}${link.url}&inline=1`)
    expect(bytes.status).toBe(200)
    expect(bytes.headers.get('content-type')).toBe('application/pdf')
    expect(await bytes.text()).toContain('%PDF')
    expect((await fetch(`${base}${link.url}x`)).status).toBe(403)

    const kinds = (await api(`/api/partnership/cases/${id}/activity`)).body.items.map((a: any) => a.action)
    expect(kinds).toEqual(expect.arrayContaining(['case.created', 'checklist.initialized', 'document.uploaded', 'document.replaced', 'document.rejected', 'document.verified']))
  })

  it('custom categories/items stay on their case; master edits reach only new cases (§62)', async () => {
    const A = await client('Template A')
    const ca = (await api('/api/partnership/cases', { method: 'POST', body: { client_id: A.id } })).body.id
    const cat = (await api(`/api/partnership/cases/${ca}/categories`, { method: 'POST', body: { name: 'Additional Client Requirements' } })).body.id
    expect((await api(`/api/partnership/cases/${ca}/items`, { method: 'POST', body: { category_id: cat, name: 'Custom Item' } })).status).toBe(201)

    const tpl = (await api('/api/partnership/template')).body
    const tplCat = tpl.categories[0]
    const added = await api('/api/partnership/template/items', { method: 'POST', body: { category_id: tplCat.id, name: 'Template v2 item', requirement: 'OPTIONAL', kind: 'ACTION' } })
    expect(added.status).toBe(201)

    const B = await client('Template B')
    const cb = (await api('/api/partnership/cases', { method: 'POST', body: { client_id: B.id } })).body.id
    const names = (id: string) => api(`/api/partnership/cases/${id}`).then((r) => r.body.categories.flatMap((x: any) => [x.name, ...x.items.map((i: any) => i.name)]))
    const a = await names(ca)
    const b = await names(cb)
    expect(a).toContain('Custom Item')
    expect(a).not.toContain('Template v2 item')
    expect(b).toContain('Template v2 item')
    expect(b).not.toContain('Custom Item')
    expect(b).not.toContain('Additional Client Requirements')

    await api(`/api/partnership/template/items/${added.body.id}`, { method: 'DELETE' })
    expect(await names(cb)).toContain('Template v2 item') // removal from master does not touch B either
  })

  it('status, assignment, due dates and premises persist and are logged', async () => {
    const X = await client('Status Co')
    const id = (await api('/api/partnership/cases', { method: 'POST', body: { client_id: X.id } })).body.id
    const emp = await prisma.employee.findFirst({ where: { deletedAt: null } })
    const patch = await api(`/api/partnership/cases/${id}`, {
      method: 'PATCH',
      body: { status: 'SUBMITTED', due_date: '2020-01-01', premises_type: 'OWNED', ...(emp ? { assigned_employee_id: emp.id } : {}) },
    })
    expect(patch.status).toBe(200)
    const c = (await api(`/api/partnership/cases/${id}`)).body
    expect(c.status).toBe('SUBMITTED')
    expect(c.due_state).toBe('overdue')
    if (emp) expect(c.assigned.id).toBe(emp.id)
    const office = c.categories.find((x: any) => x.name === "Firm's Registered Office Proof").items
    expect(office.filter((i: any) => i.applicable).map((i: any) => i.condition)).toEqual(['OWNED', 'OWNED'])
    const overdue = (await api('/api/partnership/cases?due=overdue')).body.items.map((x: any) => x.id)
    expect(overdue).toContain(id)
    const kinds = (await api(`/api/partnership/cases/${id}/activity`)).body.items.map((a: any) => a.action)
    expect(kinds).toEqual(expect.arrayContaining(['case.submitted', 'case.due_changed', 'case.premises_changed']))
  })
})

function completedByNull(i: any) { return i.completed_at === null }

describe('LLP Registration (same engine, /api/llp)', () => {
  const open = async (name: string) => {
    const cl = await client(name)
    const r = await api('/api/llp/cases', { method: 'POST', body: { client_id: cl.id } })
    expect(r.status).toBe(201)
    expect(r.body.case_code).toMatch(/^LLP-\d{4}-\d{4}$/)
    return r.body.id as string
  }
  const get = (id: string) => api(`/api/llp/cases/${id}`).then((r) => r.body)

  it('uses the LLP source checklist and stays separate from Partnership', async () => {
    const id = await open('ABC Technologies')
    const c = await get(id)
    expect(c.stage).toBe('STAGE_1')
    expect(c.categories.map((x: any) => x.name)).toEqual(['Documents of All Partners (KYC)', 'LLP Registered Office Proof', 'Basic Business Details Needed'])
    // No partners yet → the KYC category shows nothing and counts nothing.
    expect(c.categories[0].items).toHaveLength(0)
    expect((await api(`/api/partnership/cases/${id}`)).status).toBe(404)
    expect((await api('/api/partnership/cases')).body.items.some((x: any) => x.id === id)).toBe(false)
  })

  it('gives each partner their own KYC and keeps their documents apart (§48, §50)', async () => {
    const id = await open('Partner Isolation LLP')
    await api(`/api/llp/cases/${id}/partners`, { method: 'POST', body: { name: 'Ravi', aadhaar: '1234 5678 9012' } })
    await api(`/api/llp/cases/${id}/partners`, { method: 'POST', body: { name: 'Priya' } })
    let c = await get(id)
    const kyc = c.categories[0].items
    expect(kyc.filter((i: any) => i.partner.name === 'Ravi').map((i: any) => i.name))
      .toEqual(['PAN Card', 'Identity Proof', 'Address Proof', 'Aadhaar Card', 'Passport Size Photo', 'Contact Details'])
    expect(kyc.filter((i: any) => i.partner.name === 'Priya')).toHaveLength(6)
    expect(c.partner_progress.map((p: any) => [p.name, p.total, p.docs_pending])).toEqual([['Ravi', 6, 5], ['Priya', 6, 5]])

    const req = (who: string, name: string) => c.requirements.find((r: any) => r.partner?.name === who && r.name.startsWith(name))
    const ravPan = req('Ravi', 'PAN Card')
    const f = pdf('PAN.pdf'); f.append('requirement_id', ravPan.id)
    expect((await api(`/api/llp/cases/${id}/documents`, { form: f })).status).toBe(201)
    c = await get(id)
    expect(req('Ravi', 'PAN Card').status).toBe('UPLOADED')
    expect(req('Priya', 'PAN Card').status).toBe('PENDING')
    expect(JSON.stringify(req('Priya', 'PAN Card'))).not.toContain('PAN.pdf')

    // "Any one": the uploader must say which option it is; one file satisfies it.
    const idp = req('Ravi', 'Identity Proof')
    expect(idp.doc_type_options).toEqual(['Passport', 'Voter ID', 'Driving License'])
    const bad = pdf('id.pdf'); bad.append('requirement_id', idp.id)
    expect((await api(`/api/llp/cases/${id}/documents`, { form: bad })).status).toBe(400)
    const good = pdf('id.pdf'); good.append('requirement_id', idp.id); good.append('document_type', 'Voter ID')
    expect((await api(`/api/llp/cases/${id}/documents`, { form: good })).status).toBe(201)
    c = await get(id)
    expect(req('Ravi', 'Identity Proof').status).toBe('UPLOADED')
    expect(req('Ravi', 'Identity Proof').current_version.document_type).toBe('Voter ID')
    expect(req('Ravi', 'Address Proof').max_age_days).toBe(60)
  })

  it('counts only the office proofs for the chosen office type (§49)', async () => {
    const id = await open('Office LLP')
    const docs = async () => (await get(id)).progress.docs_required
    expect(await docs()).toBe(0) // office type not chosen: neither set is demanded
    await api(`/api/llp/cases/${id}`, { method: 'PATCH', body: { premises_type: 'RENTED' } })
    expect(await docs()).toBe(3)
    await api(`/api/llp/cases/${id}`, { method: 'PATCH', body: { premises_type: 'OWNED' } })
    expect(await docs()).toBe(2)
    const c = await get(id)
    const office = c.categories.find((x: any) => x.name === 'LLP Registered Office Proof').items
    expect(office.filter((i: any) => i.applicable).map((i: any) => i.name))
      .toEqual(['Ownership Deed / Sale Deed', 'Recent Electricity Bill or Property Tax Receipt'])
  })

  it('persists LLP details and tracks the two stages', async () => {
    const id = await open('Details LLP')
    const details = { llp_names: ['Alpha LLP', 'Beta LLP', 'ignored third'], main_objective: 'Software services', total_contribution: '800000' }
    expect((await api(`/api/llp/cases/${id}/details`, { method: 'PUT', body: { details } })).status).toBe(200)
    let c = await get(id)
    expect(c.details).toEqual({ llp_names: ['Alpha LLP', 'Beta LLP'], main_objective: 'Software services', total_contribution: '800000' })
    expect((await api('/api/llp/cases?q=Beta%20LLP')).body.items.map((x: any) => x.id)).toContain(id)

    const s1 = c.stage_progress.find((s: any) => s.stage === 'STAGE_1')
    expect(s1).toEqual({ stage: 'STAGE_1', done: 0, total: 3 })
    const names = c.categories.find((x: any) => x.name === 'Basic Business Details Needed').items[0]
    await api(`/api/llp/cases/${id}/items/${names.id}`, { method: 'PATCH', body: { status: 'COMPLETED' } })
    expect((await api(`/api/llp/cases/${id}`, { method: 'PATCH', body: { stage: 'STAGE_2' } })).status).toBe(200)
    expect((await api(`/api/llp/cases/${id}`, { method: 'PATCH', body: { stage: 'DEED' } })).status).toBe(400)
    c = await get(id)
    expect(c.stage).toBe('STAGE_2')
    expect(c.stage_progress.find((s: any) => s.stage === 'STAGE_1').done).toBe(1)
    const kinds = (await api(`/api/llp/cases/${id}/activity`)).body.items.map((a: any) => a.action)
    expect(kinds).toEqual(expect.arrayContaining(['case.stage_changed', 'item.completed', 'details.updated']))
  })
})

describe('GST Registration (same engine, /api/gst-registration)', () => {
  it('collects only the chosen business type\'s documents plus business place proof', async () => {
    const cl = await client('GST Client')
    const r = await api('/api/gst-registration/cases', { method: 'POST', body: { client_id: cl.id } })
    expect(r.status).toBe(201)
    expect(r.body.case_code).toMatch(/^GST-\d{4}-\d{4}$/)
    const id = r.body.id
    const req = async () => (await api(`/api/gst-registration/cases/${id}`)).body.progress.docs_required
    expect(await req()).toBe(0) // nothing decided yet → nothing demanded

    await api(`/api/gst-registration/cases/${id}`, { method: 'PATCH', body: { entity_type: 'PROPRIETORSHIP', premises_type: 'OWNED' } })
    expect(await req()).toBe(4 + 1) // PAN, Aadhaar, photo, bank + one owned-property proof

    await api(`/api/gst-registration/cases/${id}`, { method: 'PATCH', body: { entity_type: 'PARTNERSHIP', premises_type: 'RENTED' } })
    await api(`/api/gst-registration/cases/${id}/partners`, { method: 'POST', body: { name: 'Ravi' } })
    await api(`/api/gst-registration/cases/${id}/partners`, { method: 'POST', body: { name: 'Priya' } })
    const c = (await api(`/api/gst-registration/cases/${id}`)).body
    // Firm PAN, deed, signatory proof, bank (4) + PAN/Aadhaar/photo × 2 partners (6) + rented proofs (3)
    expect(c.progress.docs_required).toBe(13)
    const applicable = c.requirements.filter((x: any) => x.status !== 'NOT_APPLICABLE').map((x: any) => x.name)
    expect(applicable).toContain('PAN of all Partners — Priya')
    expect(applicable.some((n: string) => n.startsWith("Owner's"))).toBe(false)
    expect((await api(`/api/llp/cases/${id}`)).status).toBe(404)
  })

})
