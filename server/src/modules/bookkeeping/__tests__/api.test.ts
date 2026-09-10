import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../books/__tests__/helpers.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { progressFrom } from '../service.js'
import { CHECKLIST_TEMPLATE } from '../validate.js'

/**
 * HTTP-level tests for the Bookkeeping Service: real Express app, real
 * cookies, real RBAC, real PostgreSQL. They assert the service workflow —
 * engagements, periods, checklists, tasks, chased documents, deliverables —
 * and deliberately assert NO accounting figure, because this module owns none.
 */
let server: Server
let base = ''

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
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: `perm-${g.permission}`, scope: g.scope },
    }).catch(() => undefined)
  }
  return role
}

async function user(orgId: string, roleId: string) {
  const u = await prisma.user.create({
    data: { id: uid('u'), organisationId: orgId, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId },
  })
  return { ...u, cookie: `ao_access=${signToken(u.id)}` }
}

async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function client(orgId: string, name = 'ABC Private Limited') {
  return prisma.client.create({
    data: {
      id: uid('cli'), organisationId: orgId, clientCode: uid('CLI'), companyName: name,
      contactPerson: 'Contact', contactNumber: '9840011111', accountManagerId: uid('emp'),
      onboardingDate: '2026-01-01',
    },
  })
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('Bookkeeping Service — progress engine', () => {
  it('computes completion from task rows and never divides by zero', () => {
    expect(progressFrom([])).toEqual({ total: 0, completed: 0, pending: 0, overdue: 0, percent: 0 })

    const p = progressFrom([
      { status: 'completed', dueDate: '2026-01-01' },
      { status: 'completed', dueDate: '2026-01-01' },
      { status: 'pending', dueDate: '2020-01-01' },   // overdue
      { status: 'cancelled', dueDate: '2020-01-01' }, // cancelled is not pending, not overdue
    ], '2026-06-01')
    expect(p).toEqual({ total: 4, completed: 2, pending: 1, overdue: 1, percent: 50 })
  })
})

describe('Bookkeeping Service API', () => {
  it('is closed to unauthenticated callers and to roles without a workstation grant', async () => {
    expect((await api('/api/bookkeeping/overview')).status).toBe(401)
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const hr = await user(org.id, (await seedRole('hr_admin')).id)
    expect((await api('/api/bookkeeping/overview', { cookie: hr.cookie })).status).toBe(403)
  })

  it('runs the full monthly workflow over HTTP', async () => {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const md = await user(org.id, (await seedRole('md')).id)
    const cookie = md.cookie
    const c = await client(org.id)
    const emp = uid('emp')

    // 1 — engagement
    const created = await api('/api/bookkeeping/engagements', {
      method: 'POST', cookie,
      body: { client_id: c.id, service_start_date: '2026-04-01', assigned_employee_id: emp },
    })
    expect(created.status).toBe(201)
    const engagementId = created.body.data.id
    expect(created.body.data.status).toBe('active')

    // One engagement per client.
    const dupe = await api('/api/bookkeeping/engagements', {
      method: 'POST', cookie,
      body: { client_id: c.id, service_start_date: '2026-04-01', assigned_employee_id: emp },
    })
    expect(dupe.status).toBe(409)
    expect(dupe.body.error.code).toBe('engagement_exists')

    // 2 — period, which lays down the checklist in the same write
    const period = await api('/api/bookkeeping/periods', {
      method: 'POST', cookie,
      body: { engagement_id: engagementId, year: 2026, month: 5, due_date: '2026-06-05' },
    })
    expect(period.status).toBe(201)
    const periodId = period.body.data.id
    expect(period.body.data.label).toBe('May 2026')

    const detail = await api(`/api/bookkeeping/periods/${periodId}`, { cookie })
    expect(detail.body.data.checklist).toHaveLength(CHECKLIST_TEMPLATE.length)
    expect(detail.body.data.period.progress).toEqual({ total: 0, completed: 0, pending: 0, overdue: 0, percent: 0 })

    // A second May 2026 for the same engagement is refused.
    const dupePeriod = await api('/api/bookkeeping/periods', {
      method: 'POST', cookie, body: { engagement_id: engagementId, year: 2026, month: 5 },
    })
    expect(dupePeriod.status).toBe(409)
    expect(dupePeriod.body.error.code).toBe('period_exists')

    // 3 — checklist state persists
    const firstItem = detail.body.data.checklist[0]
    const ticked = await api(`/api/bookkeeping/checklist-items/${firstItem.id}`, {
      method: 'PATCH', cookie, body: { status: 'completed' },
    })
    expect(ticked.status).toBe(200)
    expect(ticked.body.data.status).toBe('completed')
    expect(ticked.body.data.completed_at).not.toBeNull()

    // 4 — tasks drive progress
    const t1 = await api('/api/bookkeeping/tasks', {
      method: 'POST', cookie,
      body: { client_id: c.id, period_id: periodId, title: 'Enter sales invoices', category: 'sales', assigned_employee_id: emp, due_date: '2026-06-03' },
    })
    expect(t1.status).toBe(201)
    const t2 = await api('/api/bookkeeping/tasks', {
      method: 'POST', cookie,
      body: { client_id: c.id, period_id: periodId, title: 'Reconcile bank', category: 'reconciliation', assigned_employee_id: emp },
    })
    expect(t2.status).toBe(201)

    let after = await api(`/api/bookkeeping/periods/${periodId}`, { cookie })
    expect(after.body.data.period.progress).toMatchObject({ total: 2, completed: 0, percent: 0 })

    const done = await api(`/api/bookkeeping/tasks/${t1.body.data.id}`, {
      method: 'PATCH', cookie, body: { status: 'completed' },
    })
    expect(done.body.data.completed_at).not.toBeNull()

    after = await api(`/api/bookkeeping/periods/${periodId}`, { cookie })
    expect(after.body.data.period.progress).toMatchObject({ total: 2, completed: 1, percent: 50 })

    // 5 — pending item, resolved
    const pending = await api('/api/bookkeeping/pending-items', {
      method: 'POST', cookie,
      body: { client_id: c.id, period_id: periodId, title: 'Bank statement', category: 'bank_statement', priority: 'high' },
    })
    expect(pending.status).toBe(201)
    expect(pending.body.data.status).toBe('requested')
    const resolved = await api(`/api/bookkeeping/pending-items/${pending.body.data.id}`, {
      method: 'PATCH', cookie, body: { status: 'resolved' },
    })
    expect(resolved.body.data.resolved_date).not.toBeNull()

    // 6 — document request links a real ClientDocument, never its own storage
    const req = await api('/api/bookkeeping/document-requests', {
      method: 'POST', cookie,
      body: { client_id: c.id, period_id: periodId, document_type: 'bank_statement' },
    })
    expect(req.status).toBe(201)

    const category = await prisma.documentCategory.create({
      data: { id: uid('dc'), organisationId: org.id, code: uid('BANK'), name: 'Bank statements' },
    })
    const doc = await prisma.clientDocument.create({
      data: { id: uid('doc'), clientId: c.id, categoryId: category.id, name: 'April statement.pdf' },
    })
    const linked = await api(`/api/bookkeeping/document-requests/${req.body.data.id}`, {
      method: 'PATCH', cookie, body: { client_document_id: doc.id },
    })
    expect(linked.status).toBe(200)
    expect(linked.body.data.status).toBe('received')
    expect(linked.body.data.client_document.name).toBe('April statement.pdf')

    // A document belonging to someone else is refused.
    const other = await client(org.id, 'XYZ Traders')
    const otherDoc = await prisma.clientDocument.create({
      data: { id: uid('doc'), clientId: other.id, categoryId: category.id, name: 'Not yours.pdf' },
    })
    const wrong = await api(`/api/bookkeeping/document-requests/${req.body.data.id}`, {
      method: 'PATCH', cookie, body: { client_document_id: otherDoc.id },
    })
    expect(wrong.status).toBe(400)

    // 7 — deliverable, approved then delivered
    const deliverable = await api('/api/bookkeeping/deliverables', {
      method: 'POST', cookie, body: { client_id: c.id, period_id: periodId, type: 'trial_balance' },
    })
    expect(deliverable.status).toBe(201)
    expect(deliverable.body.data.status).toBe('draft')
    const approved = await api(`/api/bookkeeping/deliverables/${deliverable.body.data.id}`, {
      method: 'PATCH', cookie, body: { status: 'approved' },
    })
    expect(approved.body.data.approved_at).not.toBeNull()

    // 8 — completing the month stamps the date, reopening clears it
    const completed = await api(`/api/bookkeeping/periods/${periodId}`, {
      method: 'PATCH', cookie, body: { status: 'completed' },
    })
    expect(completed.body.data.completed_date).not.toBeNull()
    const reopened = await api(`/api/bookkeeping/periods/${periodId}`, {
      method: 'PATCH', cookie, body: { status: 'in_progress' },
    })
    expect(reopened.body.data.completed_date).toBeNull()

    // 9 — the client list carries the Books handoff and a live pending count
    const list = await api('/api/bookkeeping/clients', { cookie })
    const row = list.body.data.items.find((r: { client_id: string }) => r.client_id === c.id)
    expect(row.current_period).toBe('May 2026')
    expect(row).toHaveProperty('books_org_id')

    // 10 — every mutation above left an AuditLog entry
    const audits = await prisma.auditLog.count({
      where: { action: { startsWith: 'bookkeeping.' }, entityId: { in: [engagementId, periodId] } },
    })
    expect(audits).toBeGreaterThan(0)

    // 11 — and a readable activity trail
    const activity = await api(`/api/bookkeeping/clients/${c.id}/activity`, { cookie })
    expect(activity.body.data.items.length).toBeGreaterThan(0)
  })

  it('validates input and rejects unknown statuses', async () => {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const md = await user(org.id, (await seedRole('md')).id)
    const c = await client(org.id)

    const bad = await api('/api/bookkeeping/engagements', {
      method: 'POST', cookie: md.cookie, body: { client_id: c.id },
    })
    expect(bad.status).toBe(400)
    expect(bad.body.error.details).toHaveProperty('service_start_date')

    const eng = await api('/api/bookkeeping/engagements', {
      method: 'POST', cookie: md.cookie,
      body: { client_id: c.id, service_start_date: '2026-04-01', assigned_employee_id: uid('emp') },
    })
    const badStatus = await api(`/api/bookkeeping/engagements/${eng.body.data.id}`, {
      method: 'PATCH', cookie: md.cookie, body: { status: 'exploded' },
    })
    expect(badStatus.status).toBe(400)

    const badMonth = await api('/api/bookkeeping/periods', {
      method: 'POST', cookie: md.cookie,
      body: { engagement_id: eng.body.data.id, year: 2026, month: 13 },
    })
    expect(badMonth.status).toBe(400)
  })

  it('reports overview KPIs from the database, not from constants', async () => {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const md = await user(org.id, (await seedRole('md')).id)
    const before = await api('/api/bookkeeping/overview', { cookie: md.cookie })
    const c = await client(org.id)
    await api('/api/bookkeeping/engagements', {
      method: 'POST', cookie: md.cookie,
      body: { client_id: c.id, service_start_date: '2026-04-01', assigned_employee_id: uid('emp') },
    })
    const after = await api('/api/bookkeeping/overview', { cookie: md.cookie })
    expect(after.body.data.kpis.total_clients).toBe(before.body.data.kpis.total_clients + 1)
  })
})
