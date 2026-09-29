import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { MATRIX } from '../../../platform/rbac/matrix.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { applyPayrollInvariants } from '../db/invariants.js'

/**
 * Step 3 — POST /api/payroll/runs. Verifies:
 *   1. Accepts { year, month }; derives (day-1, last-of-month).
 *   2. Rejects a future period (Bug 2).
 *   3. Rejects a non-monthly period_start / period_end pair (Bug 1).
 *   4. DB CHECK constraint refuses a hand-crafted malformed row.
 *   5. applyPayrollInvariants repairs a legacy Draft row in place.
 */

let server: Server
let base = ''

async function seedRole(code: string, grants: { permission: string; scope: string }[]) {
  for (const g of grants) {
    await prisma.permission.upsert({
      where: { code: g.permission }, update: {},
      create: { id: `perm-${g.permission}`, code: g.permission, description: g.permission },
    })
  }
  const role = await prisma.role.upsert({
    where: { code }, update: {},
    create: { id: `role-${code}`, code, name: code },
  })
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } })
  for (const g of grants) {
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: `perm-${g.permission}`, scope: g.scope },
    }).catch(() => undefined)
  }
  return role
}

async function hrUser() {
  const org = await prisma.organisation.upsert({
    where: { id: 'org-test' }, update: {},
    create: { id: 'org-test', name: 'TestFirm' },
  })
  const role = await seedRole('hr_admin', MATRIX.hr_admin)
  const u = await prisma.user.create({
    data: {
      id: uid('u'), organisationId: org.id,
      email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: role.id,
    },
  })
  return { cookie: `ao_access=${signToken(u.id)}`, orgId: org.id }
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

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => { server.close(); await prisma.$disconnect() })
beforeEach(async () => {
  // Drop the constraint if a prior test applied it — we want a clean
  // starting state per test, and some tests deliberately insert
  // malformed rows.
  await prisma.$executeRawUnsafe(`ALTER TABLE "PayrollRun" DROP CONSTRAINT IF EXISTS "payroll_run_period_shape"`)
  await prisma.payrollItem.deleteMany({})
  await prisma.payrollRun.deleteMany({})
})

describe('POST /api/payroll/runs', () => {
  it('derives period from { year, month }', async () => {
    const { cookie } = await hrUser()
    // February in a non-leap year → 28 days.
    const res = await api('/api/payroll/runs', {
      method: 'POST', cookie, body: { year: 2026, month: 2 },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.run.period_start).toBe('2026-02-01')
    expect(res.body.data.run.period_end).toBe('2026-02-28')
  })

  it('rejects a period_start that is not day 1', async () => {
    const { cookie } = await hrUser()
    const res = await api('/api/payroll/runs', {
      method: 'POST', cookie, body: { period_start: '2026-12-30', period_end: '2027-01-30' },
    })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('non_monthly_period')
  })

  it('rejects a future period (Bug 2)', async () => {
    const { cookie } = await hrUser()
    // 2099 is unambiguously in the future.
    const res = await api('/api/payroll/runs', {
      method: 'POST', cookie, body: { year: 2099, month: 12 },
    })
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('future_period')
  })

  it('allows the current calendar month for preview', async () => {
    const { cookie } = await hrUser()
    const now = new Date()
    const res = await api('/api/payroll/runs', {
      method: 'POST', cookie, body: { year: now.getFullYear(), month: now.getMonth() + 1 },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.run.period_start.slice(-2)).toBe('01')
  })

  it('DB CHECK refuses a hand-crafted malformed row', async () => {
    // Apply constraint then try to insert directly.
    await applyPayrollInvariants(prisma)
    await expect(prisma.payrollRun.create({
      data: {
        organisationId: 'org-test',
        periodStart: '2026-12-30',
        periodEnd: '2027-01-30',
        stage: 'draft',
      },
    })).rejects.toThrow()
  })
})

describe('applyPayrollInvariants', () => {
  it('skips repair (with a warning) when the canonical period already exists', async () => {
    await hrUser()
    // The legit November draft.
    await prisma.payrollRun.create({
      data: {
        organisationId: 'org-test',
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
        stage: 'draft',
      },
    })
    // A malformed draft in the same month.
    const bad = await prisma.payrollRun.create({
      data: {
        organisationId: 'org-test',
        periodStart: '2026-11-15',
        periodEnd: '2026-12-15',
        stage: 'draft',
      },
    })
    // Repair must not throw and must not touch the malformed row (the
    // canonical slot is taken). Constraint apply will refuse since the
    // malformed row still violates the shape — that is the correct
    // signal to escalate manually.
    await expect(applyPayrollInvariants(prisma)).rejects.toThrow()
    const untouched = await prisma.payrollRun.findUnique({ where: { id: bad.id } })
    expect(untouched?.periodStart).toBe('2026-11-15')
    expect(untouched?.periodEnd).toBe('2026-12-15')
  })

  it('repairs a legacy Draft row before applying the constraint', async () => {
    await hrUser()
    // Simulate the malformed Dec row that exists in the pre-fix deployed
    // instance. The invariant is not yet applied, so this insert succeeds.
    const bad = await prisma.payrollRun.create({
      data: {
        organisationId: 'org-test',
        periodStart: '2026-12-30',
        periodEnd: '2027-01-30',
        stage: 'draft',
      },
    })
    await applyPayrollInvariants(prisma)
    const repaired = await prisma.payrollRun.findUnique({ where: { id: bad.id } })
    expect(repaired?.periodStart).toBe('2026-12-01')
    expect(repaired?.periodEnd).toBe('2026-12-31')
    expect(repaired?.notes).toMatch(/repaired/i)
  })
})
