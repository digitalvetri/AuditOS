import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { sendTdsReminders } from '../reminders.js'

/**
 * The TDS completeness work over HTTP: date rules, duplicate notices,
 * required deductor type, 26QB/QC/QD, the firm-wide board, the deductee
 * register (calculator, short deduction, 15G, lower certificate, export)
 * and the reminder job.
 */
let server: Server
let base = ''

async function seedRole(code: string, grants: { permission: string; scope: string }[]) {
  for (const g of grants) {
    await prisma.permission.upsert({ where: { code: g.permission }, update: {}, create: { id: `perm-${g.permission}`, code: g.permission, description: g.permission } })
  }
  const role = await prisma.role.upsert({ where: { code }, update: {}, create: { id: `role-${code}`, code, name: code } })
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
  for (const g of grants) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: `perm-${g.permission}`, scope: g.scope } }).catch(() => undefined)
  }
  return role
}

async function api(p: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${p}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let parsed: unknown = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
  return { status: res.status, body: parsed as any, raw: text }
}

/** An account manager with a login, so reminders have someone to reach. */
async function manager(orgId: string, roleId: string) {
  const [des, dep, loc, sch] = await Promise.all([
    prisma.designation.create({ data: { id: uid('des'), organisationId: orgId, name: 'Manager' } }),
    prisma.department.create({ data: { id: uid('dep'), organisationId: orgId, name: 'Tax', code: uid('D') } }),
    prisma.workLocation.create({ data: { id: uid('loc'), organisationId: orgId, name: 'Office', latitude: 11, longitude: 77 } }),
    prisma.workSchedule.create({ data: { id: uid('sch'), organisationId: orgId, name: 'Day', standardStart: '09:30', standardEnd: '18:30' } }),
  ])
  const emp = await prisma.employee.create({
    data: {
      id: uid('emp'), organisationId: orgId, employeeCode: uid('E'), firstName: 'Anu', lastName: 'M', fullName: 'Anu M',
      designationId: des.id, departmentId: dep.id, workLocationId: loc.id, workScheduleId: sch.id,
      email: `${uid('m')}@x.local`, joiningDate: '2024-01-01',
    },
  })
  const u = await prisma.user.create({ data: { id: uid('u'), organisationId: orgId, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId, employeeId: emp.id } })
  return { emp, user: u, cookie: `ao_access=${signToken(u.id)}` }
}

async function newClient(orgId: string, name: string, accountManagerId: string, tan: string | null = null) {
  return prisma.client.create({
    data: {
      id: uid('cli'), organisationId: orgId, clientCode: uid('CLI'), companyName: name, tan,
      contactPerson: 'Contact', contactNumber: '9840011111', accountManagerId, onboardingDate: '2026-01-01',
    },
  })
}

let cookie = ''
let orgId = ''
let mgr: Awaited<ReturnType<typeof manager>>

beforeAll(async () => {
  process.env.TDS_STORAGE_ROOT = mkdtempSync(path.join(tmpdir(), 'auditos-test-tds-'))
  process.env.PORTAL_ACCESS_ENC_KEY ??= randomBytes(32).toString('base64')
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
  orgId = org.id
  const role = await seedRole('md', MATRIX.md)
  mgr = await manager(org.id, role.id)
  cookie = mgr.cookie
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

const rec = (id: string, body: unknown) => api(`/api/tds/${id}/records`, { method: 'POST', cookie, body })

describe('TDS — data rules', () => {
  it('rejects future dates and dates that do not fit the period', async () => {
    const c = await newClient(orgId, 'Dates Ltd', mgr.emp.id, 'CHEA11111A')
    const future = await rec(c.id, { kind: 'challan', fy: '2026-27', period: '2026-04', bsr_code: '0510308', reference: '1', event_date: '2099-01-07', amount_tax: 100 })
    expect(future.status).toBe(400)
    expect(future.body.error.details.event_date).toMatch(/future/)
    // Deposit before the deduction month
    const early = await rec(c.id, { kind: 'challan', fy: '2026-27', period: '2026-05', bsr_code: '0510308', reference: '2', event_date: '2026-04-20', amount_tax: 100 })
    expect(early.body.error.details.event_date).toMatch(/before the deduction month/)
    // Month outside the FY
    expect((await rec(c.id, { kind: 'challan', fy: '2026-27', period: '2025-05', bsr_code: '0510308', reference: '3', event_date: '2025-06-07', amount_tax: 100 })).body.error.details.period).toMatch(/not a month/)
    // Return filed before its quarter ended
    const ret = await rec(c.id, { kind: 'return', fy: '2026-27', period: 'Q1', form_type: '26Q', reference: '123456789012345', event_date: '2026-06-20' })
    expect(ret.body.error.details.event_date).toMatch(/after the quarter ends/)
    // Valid ones go through
    expect((await rec(c.id, { kind: 'challan', fy: '2026-27', period: '2026-04', bsr_code: '0510308', reference: '4', event_date: '2026-05-07', amount_tax: 100 })).status).toBe(201)
    const ok = await rec(c.id, { kind: 'return', fy: '2026-27', period: 'Q1', form_type: '26Q', reference: '123456789012345', event_date: '2026-07-31' })
    expect(ok.status).toBe(201)
    // Correction can't predate the original
    const corr = await rec(c.id, { kind: 'correction', original_id: ok.body.data.record.id, reference: '999999999999999', event_date: '2026-07-30' })
    expect(corr.body.error.details.event_date).toMatch(/before the original/)
    // Editing can't sneak a future date in either
    const patch = await api(`/api/tds/${c.id}/records/${ok.body.data.record.id}`, { method: 'PATCH', cookie, body: { event_date: '2099-01-01' } })
    expect(patch.status).toBe(400)
  })

  it('keeps one record per notice — the same reference is refused', async () => {
    const c = await newClient(orgId, 'Notice Ltd', mgr.emp.id, 'CHEA22222A')
    const first = await rec(c.id, { kind: 'notice', reference: 'DEF/2026-27/Q1/001', status: 'pending', event_date: '2026-09-01' })
    expect(first.status).toBe(201)
    const dup = await rec(c.id, { kind: 'notice', reference: 'def/2026-27/q1/001', status: 'done', event_date: '2026-09-02' })
    expect(dup.status).toBe(409)
    expect(dup.body.error.message).toMatch(/edit it/)
    // Closing it is an edit of the same record
    expect((await api(`/api/tds/${c.id}/records/${first.body.data.record.id}`, { method: 'PATCH', cookie, body: { status: 'done' } })).status).toBe(200)
  })

  it('requires the deductor type on the profile', async () => {
    const c = await newClient(orgId, 'Profile Ltd', mgr.emp.id, 'CHEA33333A')
    const put = (body: unknown) => api(`/api/tds/${c.id}/profile`, { method: 'PUT', cookie, body })
    expect((await put({ return_forms: ['26Q'] })).body.error.details.deductor_type).toMatch(/Choose/)
    expect((await put({ return_forms: ['26Q'], deductor_type: 'company' })).status).toBe(200)
    expect((await put({ return_forms: ['24Q', '26Q'] })).status).toBe(200) // already set
    expect((await put({ deductor_type: null })).status).toBe(400)
  })
})

describe('TDS — 26QB / 26QC / 26QD', () => {
  it('records a statement without a TAN, owes Form 16B, and refuses a duplicate acknowledgement', async () => {
    const c = await newClient(orgId, 'Buyer (no TAN)', mgr.emp.id, null)
    const s = { kind: 'challan_statement', form_type: '26QB', period: '2026-07', reference: 'AB1234567', party_name: 'Seller', party_pan: 'abcde1234f', gross_amount: 6000000, amount_tax: 60000, event_date: '2026-07-20' }
    const made = await rec(c.id, s)
    expect(made.status).toBe(201)
    expect(made.body.data.record).toMatchObject({ fy: '2026-27', party_pan: 'ABCDE1234F', form_type: '26QB' })
    expect((await rec(c.id, s)).status).toBe(409)
    expect((await rec(c.id, { ...s, reference: 'ZZ999', cert_issued_on: '2026-07-01' })).body.error.details.cert_issued_on).toMatch(/after the statement/)
  })
})

describe('TDS — firm-wide board and reminders', () => {
  it('lists every client TAN with what is overdue, worst first, and reminds the account manager once', async () => {
    const late = await newClient(orgId, 'Late Payer Ltd', mgr.emp.id, 'CHEA44444A')
    const clean = await newClient(orgId, 'Clean Ltd', mgr.emp.id, 'CHEA55555A')
    await prisma.tdsProfile.create({ data: { clientId: late.id, returnForms: '26Q', deductorType: 'company' } })
    await prisma.tdsProfile.create({ data: { clientId: clean.id, returnForms: '26Q', deductorType: 'company' } })
    const board = await api('/api/tds/overview?fy=2026-27', { cookie })
    expect(board.status).toBe(200)
    const rows = board.body.data.rows as { client_id: string; standing: string; overdue: number; open_items: { label: string }[] }[]
    const lateRow = rows.find((r) => r.client_id === late.id)!
    expect(lateRow.standing).toBe('overdue')
    expect(lateRow.overdue).toBeGreaterThan(0)
    expect(lateRow.open_items[0].label).toMatch(/Challan|return/)
    // Worst first
    expect(rows.findIndex((r) => r.client_id === late.id)).toBeLessThan(rows.length)

    const sent = await sendTdsReminders(prisma, '2026-09-29')
    expect(sent).toBeGreaterThan(0)
    const mine = await prisma.notification.count({ where: { userId: mgr.user.id, type: 'tds_reminder' } })
    expect(mine).toBeGreaterThan(0)
    // Running again sends nothing new
    expect(await sendTdsReminders(prisma, '2026-09-29')).toBe(0)
    expect(await prisma.notification.count({ where: { userId: mgr.user.id, type: 'tds_reminder' } })).toBe(mine)
  })
})

describe('TDS — deductee register', () => {
  it('computes TDS, flags short deduction, honours 15G and certificates, and exports the quarter', async () => {
    const c = await newClient(orgId, 'Register Ltd', mgr.emp.id, 'CHEA66666A')
    const post = (p: string, body: unknown) => api(`/api/tds/${c.id}/${p}`, { method: 'POST', cookie, body })
    const contractor = (await post('deductees', { name: 'Ravi Contractors', pan: 'AAAPR1234C', category: 'individual_huf' })).body.data.deductee
    const firm = (await post('deductees', { name: 'Kaveri Consultants LLP', pan: 'AAAFK1234K', category: 'other' })).body.data.deductee
    const saver = (await post('deductees', { name: 'Senior Depositor', pan: 'AAAPS1234S', category: 'individual_huf' })).body.data.deductee
    const noPan = (await post('deductees', { name: 'Unknown Vendor', category: 'other' })).body.data.deductee
    expect((await post('deductees', { name: 'Dup', pan: 'AAAPR1234C', category: 'other' })).status).toBe(409)

    // Preview: 194C individual at 1%
    const pv = await post('deductions/preview', { deductee_id: contractor.id, section: '194C', deduction_date: '2026-05-10', amount_paid: 50000 })
    expect(pv.body.data).toMatchObject({ expected_tds: 500, rate: 1, basis: 'normal', return_form: '26Q' })

    // Short deduction is kept and flagged
    const short = await post('deductions', { deductee_id: firm.id, section: '194J(b)', payment_date: '2026-05-12', deduction_date: '2026-05-12', amount_paid: 100000, tds_amount: 5000 })
    expect(short.status).toBe(201)
    expect(short.body.data.deduction).toMatchObject({ expected_tds: 10000, tds_amount: 5000, shortfall: 5000 })

    // No TDS given → the proposed figure is used
    const normal = await post('deductions', { deductee_id: contractor.id, section: '194C', payment_date: '2026-05-10', deduction_date: '2026-05-10', amount_paid: 50000 })
    expect(normal.body.data.deduction).toMatchObject({ tds_amount: 500, basis: 'normal', shortfall: 0 })

    // 15G → no deduction on interest
    await post('declarations', { deductee_id: saver.id, fy: '2026-27', form: '15G', received_on: '2026-04-05' })
    expect((await post('declarations', { deductee_id: saver.id, fy: '2026-27', form: '15H', received_on: '2026-04-06' })).status).toBe(400)
    const interest = await post('deductions', { deductee_id: saver.id, section: '194A', payment_date: '2026-06-30', deduction_date: '2026-06-30', amount_paid: 40000 })
    expect(interest.body.data.deduction).toMatchObject({ tds_amount: 0, basis: 'declaration' })

    // Lower-deduction certificate at 2%
    await post('lower-certificates', { deductee_id: firm.id, certificate_no: 'LDC123', section: '194J(b)', rate: 2, valid_from: '2026-06-01', valid_to: '2027-03-31' })
    const lower = await post('deductions', { deductee_id: firm.id, section: '194J(b)', payment_date: '2026-06-15', deduction_date: '2026-06-15', amount_paid: 50000 })
    expect(lower.body.data.deduction).toMatchObject({ tds_amount: 1000, basis: 'lower_certificate' })

    // No PAN → 20%
    const np = await post('deductions', { deductee_id: noPan.id, section: '194C', payment_date: '2026-06-20', deduction_date: '2026-06-20', amount_paid: 40000 })
    expect(np.body.data.deduction).toMatchObject({ tds_amount: 8000, basis: 'no_pan' })

    // Future dates refused; TDS above the payment refused
    expect((await post('deductions', { deductee_id: firm.id, section: '194C', payment_date: '2099-01-01', deduction_date: '2099-01-01', amount_paid: 100 })).status).toBe(400)
    expect((await post('deductions', { deductee_id: firm.id, section: '194C', payment_date: '2026-06-01', deduction_date: '2026-06-01', amount_paid: 100, tds_amount: 500 })).status).toBe(400)

    // Month totals line up with the recorded challan
    await rec(c.id, { kind: 'challan', fy: '2026-27', period: '2026-05', bsr_code: '0510308', reference: '11', event_date: '2026-06-07', amount_tax: 5500 })
    const reg = await api(`/api/tds/${c.id}/register?fy=2026-27`, { cookie })
    const may = reg.body.data.months.find((m: { month: string }) => m.month === '2026-05')
    expect(may).toMatchObject({ entries: 2, deducted: 5500, expected: 10500, deposited: 5500, difference: 0 })

    // Quarter export for 26Q: all Q1 rows, remark codes, challan matched by month
    const csv = await api(`/api/tds/${c.id}/deductions/export?fy=2026-27&quarter=Q1&form=26Q`, { cookie })
    expect(csv.status).toBe(200)
    const lines = csv.raw.replace(/^﻿/, '').trim().split('\r\n')
    expect(lines).toHaveLength(1 + 5)
    expect(csv.raw).toContain('"PANNOTAVBL"')
    expect(csv.raw).toMatch(/"LDC123"/)
    expect(csv.raw).toMatch(/"B"/) // 15G remark
    expect(csv.raw).toContain('"0510308"')

    // A deductee with deductions can't be deleted
    expect((await api(`/api/tds/${c.id}/deductees/${contractor.id}`, { method: 'DELETE', cookie })).status).toBe(409)
  })
})
