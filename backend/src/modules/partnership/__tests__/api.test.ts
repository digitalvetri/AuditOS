import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'

// Keep test uploads out of server/uploads. Hoisted above the imports, which
// is when the storage module reads it.
vi.hoisted(() => {
  process.env.PFR_STORAGE_ROOT = `${process.env.TMPDIR ?? '/tmp'}/pfr-test-${process.pid}`
})

import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
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

describe('Private Limited — post-registration compliance (INC-20A, ADTC)', () => {
  it('completing the registration creates INC-20A (+180 days from incorporation) and ADTC once; status and days remaining are computed', async () => {
    const cl = await client('Comply Pvt Ltd')
    const id = (await api('/api/private-limited/cases', { method: 'POST', body: { client_id: cl.id } })).body.id
    const list = async (q = '') => (await api(`/api/post-registration-compliance?case_id=${id}${q}`)).body

    expect((await list()).items).toEqual([]) // nothing before completion
    expect((await api(`/api/private-limited/cases/${id}`, { method: 'PATCH', body: { status: 'COMPLETED', incorporation_date: '2999-01-01' } })).status).toBe(400)
    expect((await api(`/api/private-limited/cases/${id}`, { method: 'PATCH', body: { status: 'COMPLETED', incorporation_date: '2026-10-01' } })).status).toBe(200)
    let l = await list()
    expect(l.items.map((x: any) => x.code).sort()).toEqual(['ADTC', 'INC_20A'])
    const inc = l.items.find((x: any) => x.code === 'INC_20A')
    expect(inc).toMatchObject({ trigger_date: '2026-10-01', trigger_label: 'Date of Incorporation', offset_days: 180, due_date: '2027-03-30', client: { name: 'Comply Pvt Ltd' } })
    const adtc = l.items.find((x: any) => x.code === 'ADTC')
    // ADTC starts from the Date of Incorporation too; due = +30.
    expect(adtc).toMatchObject({ trigger_date: '2026-10-01', due_date: '2026-10-31', offset_days: 30, trigger_editable_label: true })

    // Status flips again: still exactly two rows.
    await api(`/api/private-limited/cases/${id}`, { method: 'PATCH', body: { status: 'SUBMITTED' } })
    await api(`/api/private-limited/cases/${id}`, { method: 'PATCH', body: { status: 'COMPLETED' } })
    expect((await list()).items).toHaveLength(2)

    // ADTC: the trigger date is correctable; due = trigger + 30.
    expect((await api(`/api/post-registration-compliance/${adtc.id}`, { method: 'PATCH', body: { trigger_date: '2026-10-15' } })).body.item.due_date).toBe('2026-11-14')
    const relabel = await api(`/api/post-registration-compliance/${adtc.id}`, { method: 'PATCH', body: { trigger_label: 'Date of bank account opening', offset_days: 45 } })
    expect(relabel.body.item).toMatchObject({ trigger_label: 'Date of bank account opening', offset_days: 45, due_date: '2026-11-29' })
    expect((await api(`/api/post-registration-compliance/${inc.id}`, { method: 'PATCH', body: { trigger_label: 'x' } })).status).toBe(400)

    // Complete with a date; future dates refused; reopen keeps the row.
    expect((await api(`/api/post-registration-compliance/${inc.id}/complete`, { method: 'POST', body: { completed_on: '2999-01-01' } })).status).toBe(400)
    const done = await api(`/api/post-registration-compliance/${inc.id}/complete`, { method: 'POST', body: { completed_on: '2026-10-03' } })
    expect(done.body.item).toMatchObject({ status: 'COMPLETED', completed_on: '2026-10-03', days_remaining: null })
    l = await list()
    expect(l.summary.completed).toBe(1)
    expect((await list('&status=COMPLETED')).items.map((x: any) => x.code)).toEqual(['INC_20A'])
    expect((await api(`/api/post-registration-compliance/${inc.id}/reopen`, { method: 'POST' })).body.item.completed_on).toBeNull()

    const acts = (await api(`/api/private-limited/cases/${id}/activity`)).body.items.map((a: any) => a.action)
    expect(acts).toEqual(expect.arrayContaining(['compliance.created', 'compliance.trigger_changed', 'compliance.completed', 'compliance.reopened']))
  })

  it('reminds the case team every 20 days (INC-20A) / 7 days (ADTC), once per period, and stops when completed', async () => {
    const { sendPostRegistrationReminders } = await import('../postRegReminders.js')
    const { nextReminder } = await import('../compliance.js')
    // One employee with a login, assigned to the case.
    const dept = await prisma.department.create({ data: { id: uid('dep'), organisationId: orgId, code: uid('D'), name: 'General' } })
    const desg = await prisma.designation.create({ data: { id: uid('desg'), organisationId: orgId, name: 'Ex' } })
    const loc = await prisma.workLocation.create({ data: { id: uid('loc'), organisationId: orgId, name: 'HQ', latitude: 13, longitude: 80 } })
    const sched = await prisma.workSchedule.create({ data: { id: uid('sch'), organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })
    const emp = await prisma.employee.create({
      data: {
        id: uid('emp'), organisationId: orgId, employeeCode: uid('EC'), firstName: 'A', lastName: 'B', fullName: 'A B',
        type: 'executive', status: 'active', designationId: desg.id, departmentId: dept.id, workLocationId: loc.id, workScheduleId: sched.id,
        email: `${uid('e')}@x.local`, joiningDate: '2026-01-01',
      },
    })
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'md' } })
    const u = await prisma.user.create({ data: { id: uid('u'), organisationId: orgId, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })

    const cl = await client('Remind Pvt Ltd')
    const id = (await api('/api/private-limited/cases', { method: 'POST', body: { client_id: cl.id, assigned_employee_id: emp.id } })).body.id
    await api(`/api/private-limited/cases/${id}`, { method: 'PATCH', body: { status: 'COMPLETED', incorporation_date: '2026-09-01' } })
    const mine = () => prisma.notification.findMany({ where: { userId: u.id, type: 'post_registration_reminder' }, orderBy: { createdAt: 'asc' } })

    // Day 10: ADTC period 1 (7 days) only — INC-20A's first is day 20.
    expect(await sendPostRegistrationReminders(prisma, '2026-09-11')).toBeGreaterThanOrEqual(1)
    expect((await mine()).map((n) => n.title)).toEqual(['ADTC reminder — Remind Pvt Ltd'])
    // Same day again: nothing new.
    await sendPostRegistrationReminders(prisma, '2026-09-11')
    expect(await mine()).toHaveLength(1)
    // Day 21: INC-20A period 1 and ADTC period 3 — one each, not a backlog.
    await sendPostRegistrationReminders(prisma, '2026-09-22')
    expect((await mine()).map((n) => n.title).slice(1).sort()).toEqual(['ADTC reminder — Remind Pvt Ltd', 'INC-20A reminder — Remind Pvt Ltd'])
    // ADTC due date (+30) and then overdue.
    await sendPostRegistrationReminders(prisma, '2026-10-01')
    expect((await mine()).at(-1)?.title).toBe('ADTC due today — Remind Pvt Ltd')
    await sendPostRegistrationReminders(prisma, '2026-10-06')
    expect((await mine()).at(-1)?.title).toBe('ADTC overdue — Remind Pvt Ltd')

    // Next reminder: next multiple of the interval, or the due date if sooner.
    expect(nextReminder({ code: 'INC_20A', triggerDate: '2026-09-01', dueDate: '2027-02-28', completedOn: null }, '2026-09-22')).toBe('2026-10-11')
    expect(nextReminder({ code: 'ADTC', triggerDate: '2026-09-01', dueDate: '2026-10-01', completedOn: null }, '2026-09-29')).toBe('2026-10-01')
    expect(nextReminder({ code: 'ADTC', triggerDate: '2026-09-01', dueDate: '2026-10-01', completedOn: '2026-09-20' }, '2026-09-29')).toBeNull()

    // Completed → no more reminders for it.
    const adtc = (await api(`/api/post-registration-compliance?case_id=${id}`)).body.items.find((x: any) => x.code === 'ADTC')
    await api(`/api/post-registration-compliance/${adtc.id}/complete`, { method: 'POST', body: { completed_on: '2026-10-03' } })
    const before = (await mine()).length
    await sendPostRegistrationReminders(prisma, '2026-10-13')
    expect((await mine()).slice(before).map((n) => n.title)).toEqual(['INC-20A reminder — Remind Pvt Ltd'])
  })

  it('works out the status from the due date and today', async () => {
    const { complianceState } = await import('../compliance.js')
    const now = '2026-10-04'
    expect(complianceState({ code: 'INC_20A', dueDate: '2027-03-30', completedOn: null }, now)).toEqual({ status: 'UPCOMING', daysRemaining: 177 })
    expect(complianceState({ code: 'INC_20A', dueDate: '2026-11-01', completedOn: null }, now)).toEqual({ status: 'DUE_SOON', daysRemaining: 28 })
    expect(complianceState({ code: 'ADTC', dueDate: '2026-10-20', completedOn: null }, now)).toEqual({ status: 'UPCOMING', daysRemaining: 16 })
    expect(complianceState({ code: 'ADTC', dueDate: '2026-10-04', completedOn: null }, now)).toEqual({ status: 'DUE_TODAY', daysRemaining: 0 })
    expect(complianceState({ code: 'ADTC', dueDate: '2026-09-29', completedOn: null }, now)).toEqual({ status: 'OVERDUE', daysRemaining: -5 })
    expect(complianceState({ code: 'ADTC', dueDate: null, completedOn: null }, now)).toEqual({ status: 'NOT_STARTED', daysRemaining: null })
    expect(complianceState({ code: 'ADTC', dueDate: '2026-09-29', completedOn: '2026-09-28' }, now)).toEqual({ status: 'COMPLETED', daysRemaining: null })
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
  it('lists every section\'s documents whatever the business type (spreadsheet template)', async () => {
    const cl = await client('GST Client')
    const r = await api('/api/gst-registration/cases', { method: 'POST', body: { client_id: cl.id } })
    expect(r.status).toBe(201)
    expect(r.body.case_code).toMatch(/^GST-\d{4}-\d{4}$/)
    const id = r.body.id
    const req = async () => (await api(`/api/gst-registration/cases/${id}`)).body.progress.docs_required
    // Entity-agnostic since cc3e74e: Proprietorship check (4) + Partnership /
    // Corporate check (6) + Business place proof (3). The section titles say
    // when each applies; the operator skips what doesn't.
    expect(await req()).toBe(13)

    await api(`/api/gst-registration/cases/${id}`, { method: 'PATCH', body: { entity_type: 'PROPRIETORSHIP', premises_type: 'OWNED' } })
    expect(await req()).toBe(13)

    await api(`/api/gst-registration/cases/${id}`, { method: 'PATCH', body: { entity_type: 'PARTNERSHIP', premises_type: 'RENTED' } })
    await api(`/api/gst-registration/cases/${id}/partners`, { method: 'POST', body: { name: 'Ravi' } })
    await api(`/api/gst-registration/cases/${id}/partners`, { method: 'POST', body: { name: 'Priya' } })
    const c = (await api(`/api/gst-registration/cases/${id}`)).body
    expect(c.progress.docs_required).toBe(13)
    const applicable = c.requirements.filter((x: any) => x.status !== 'NOT_APPLICABLE').map((x: any) => x.name)
    expect(applicable).toEqual(expect.arrayContaining(['Owner PAN', 'Entity PAN', 'Partner/Director PAN & Aadhaar', 'NOC from Property Owner']))
    expect((await api(`/api/llp/cases/${id}`)).status).toBe(404)
  })
})
