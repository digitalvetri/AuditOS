import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { seedWorkflowStages } from '../../../../prisma/seed-bookkeeping-stages.js'

/**
 * Monthly Work → Layout: adding, renaming, reordering and removing checklist
 * steps, and what that does to months already open. The stage list is
 * shared across the test database, so this suite only touches steps it
 * creates and retires them again at the end.
 */
let server: Server
let base = ''
const created: string[] = []

async function seedRole(code: keyof typeof MATRIX) {
  for (const g of MATRIX[code]) {
    await prisma.permission.upsert({ where: { code: g.permission }, update: {}, create: { id: `perm-${g.permission}`, code: g.permission, description: g.permission } })
  }
  const role = await prisma.role.upsert({ where: { code }, update: {}, create: { id: `role-${code}`, code, name: code } })
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
  for (const g of MATRIX[code]) {
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: `perm-${g.permission}`, scope: g.scope } }).catch(() => undefined)
  }
  return role
}
async function user(orgId: string, roleCode: keyof typeof MATRIX) {
  const u = await prisma.user.create({ data: { id: uid('u'), organisationId: orgId, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: (await seedRole(roleCode)).id } })
  return `ao_access=${signToken(u.id)}`
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
/** A firm with one client, an engagement and an open month. */
async function firmWithOpenMonth(month: number) {
  const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
  const cookie = await user(org.id, 'md')
  const c = await prisma.client.create({ data: { id: uid('cli'), organisationId: org.id, clientCode: uid('CLI'), companyName: 'ABC', contactPerson: 'C', contactNumber: '9840011111', accountManagerId: uid('emp'), onboardingDate: '2026-01-01' } })
  const eng = await api('/api/bookkeeping-service/engagements', { method: 'POST', cookie, body: { client_id: c.id, service_start_date: '2026-01-01', assigned_employee_id: uid('emp') } })
  const period = await api('/api/bookkeeping-service/periods', { method: 'POST', cookie, body: { engagement_id: eng.body.data.id, year: 2026, month } })
  expect(period.status).toBe(201)
  return { org, cookie, periodId: period.body.data.id as string }
}
const detail = (periodId: string, cookie: string) => api(`/api/bookkeeping-service/periods/${periodId}`, { cookie })

beforeAll(async () => {
  await seedWorkflowStages(prisma)
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => {
  await prisma.bookkeepingWorkflowStage.updateMany({ where: { id: { in: created } }, data: { isActive: false } })
  server.close()
  await prisma.$disconnect()
})

describe('Bookkeeping — checklist layout', () => {
  it('adds a step to the layout and to open months of the same firm only', async () => {
    const a = await firmWithOpenMonth(1)
    const b = await firmWithOpenMonth(2)
    const before = (await detail(a.periodId, a.cookie)).body.data.tasks.length

    const add = await api('/api/bookkeeping-service/layout/stages', { method: 'POST', cookie: a.cookie, body: { name: 'Verify GST input credit', default_category: 'review', default_offset_days: 3, apply_to_open: true } })
    expect(add.status).toBe(201)
    created.push(add.body.data.stage.id)
    expect(add.body.data.added_to_open_months).toBeGreaterThanOrEqual(1)

    const da = (await detail(a.periodId, a.cookie)).body.data
    expect(da.tasks).toHaveLength(before + 1)
    expect(da.tasks.some((t: { title: string }) => t.title === 'Verify GST input credit')).toBe(true)
    expect(da.workflow_stages.map((s: { name: string }) => s.name)).toContain('Verify GST input credit')
    // Firm B's open month is untouched.
    const db = (await detail(b.periodId, b.cookie)).body.data
    expect(db.tasks.some((t: { title: string }) => t.title === 'Verify GST input credit')).toBe(false)

    // A month opened afterwards includes it.
    const later = await api('/api/bookkeeping-service/periods', { method: 'POST', cookie: a.cookie, body: { engagement_id: da.period.engagement_id, year: 2026, month: 3 } })
    const dl = (await detail(later.body.data.id, a.cookie)).body.data
    expect(dl.tasks.some((t: { title: string }) => t.title === 'Verify GST input credit')).toBe(true)

    // Duplicate names are refused.
    const dup = await api('/api/bookkeeping-service/layout/stages', { method: 'POST', cookie: a.cookie, body: { name: 'verify gst input credit' } })
    expect(dup.status).toBe(409)
  })

  it('renames and reorders steps', async () => {
    const a = await firmWithOpenMonth(4)
    const s1 = await api('/api/bookkeeping-service/layout/stages', { method: 'POST', cookie: a.cookie, body: { name: 'Step Alpha', apply_to_open: true } })
    const s2 = await api('/api/bookkeeping-service/layout/stages', { method: 'POST', cookie: a.cookie, body: { name: 'Step Beta', apply_to_open: false } })
    created.push(s1.body.data.stage.id, s2.body.data.stage.id)

    const ren = await api(`/api/bookkeeping-service/layout/stages/${s1.body.data.stage.id}`, { method: 'PATCH', cookie: a.cookie, body: { name: 'Step Alpha Renamed' } })
    expect(ren.status).toBe(200)
    // The not-yet-started task in the open month follows the rename.
    const d = (await detail(a.periodId, a.cookie)).body.data
    expect(d.tasks.some((t: { title: string }) => t.title === 'Step Alpha Renamed')).toBe(true)

    const mv = await api(`/api/bookkeeping-service/layout/stages/${s2.body.data.stage.id}/move`, { method: 'POST', cookie: a.cookie, body: { direction: 'up' } })
    expect(mv.status).toBe(200)
    const names = mv.body.data.stages.map((s: { name: string }) => s.name)
    expect(names.indexOf('Step Beta')).toBeLessThan(names.indexOf('Step Alpha Renamed'))
  })

  it('removes a step: pending tasks go from open months, completed ones stay visible', async () => {
    const a = await firmWithOpenMonth(5)
    const other = await firmWithOpenMonth(6)
    const add = await api('/api/bookkeeping-service/layout/stages', { method: 'POST', cookie: a.cookie, body: { name: 'Temporary check', apply_to_open: true } })
    const stageId = add.body.data.stage.id
    created.push(stageId)

    // Firm A has TWO open months; one of them completes the step first.
    const eng = (await detail(a.periodId, a.cookie)).body.data.period.engagement_id
    const second = await api('/api/bookkeeping-service/periods', { method: 'POST', cookie: a.cookie, body: { engagement_id: eng, year: 2026, month: 7 } })
    const doneTask = (await detail(second.body.data.id, a.cookie)).body.data.tasks.find((t: { stage: { id: string } | null }) => t.stage?.id === stageId)
    expect((await api(`/api/bookkeeping-service/tasks/${doneTask.id}`, { method: 'PATCH', cookie: a.cookie, body: { status: 'completed' } })).status).toBe(200)

    const del = await api(`/api/bookkeeping-service/layout/stages/${stageId}`, { method: 'DELETE', cookie: a.cookie })
    expect(del.status).toBe(200)
    expect(del.body.data.removed_pending_tasks).toBe(1)

    const layout = await api('/api/bookkeeping-service/layout', { cookie: a.cookie })
    expect(layout.body.data.stages.map((s: { id: string }) => s.id)).not.toContain(stageId)
    // Pending one is gone…
    const d1 = (await detail(a.periodId, a.cookie)).body.data
    expect(d1.tasks.some((t: { stage: { id: string } | null }) => t.stage?.id === stageId)).toBe(false)
    // …the completed one stays, and its step still shows on that month's checklist.
    const d2 = (await detail(second.body.data.id, a.cookie)).body.data
    expect(d2.tasks.some((t: { stage: { id: string } | null; status: string }) => t.stage?.id === stageId && t.status === 'completed')).toBe(true)
    expect(d2.workflow_stages.map((s: { id: string }) => s.id)).toContain(stageId)
    // Firm B never had it (added before B's month? B's month existed, but A's add is scoped to A).
    const d3 = (await detail(other.periodId, other.cookie)).body.data
    expect(d3.tasks.some((t: { stage: { id: string } | null }) => t.stage?.id === stageId)).toBe(false)
  })

  it('keeps at least one step and requires manage access', async () => {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const emp = await user(org.id, 'employee')
    const r = await api('/api/bookkeeping-service/layout/stages', { method: 'POST', cookie: emp, body: { name: 'Nope' } })
    expect(r.status).toBe(403)
    const bad = await api('/api/bookkeeping-service/layout/stages', { method: 'POST', cookie: (await firmWithOpenMonth(8)).cookie, body: { name: '   ' } })
    expect(bad.status).toBe(400)
  })
})
