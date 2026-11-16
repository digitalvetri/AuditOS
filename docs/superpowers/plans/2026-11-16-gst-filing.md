# GST Filing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Workstation → Services → **GST Filing** page that automatically lists every client with the GST Filing service each month. It tracks whether their data has arrived, and lets staff Start and Finish a separate GSTR-1 job and GSTR-3B job for each client.

**Architecture:** This reuses the existing GST engine (`GstProfile` → `GstCompliancePeriod` → `GstFiling`), which today never receives clients because nothing creates a `GstProfile`.
- A new module, `backend/src/modules/gst/filing.ts`, enrols clients from their "GST Filing" ClientService (service code `GST_FILING`), generates last month's jobs, and tracks data received.
- It runs from three places: the existing daily compliance job, the client/service write routes, and portal uploads.
- New endpoints are added to `backend/src/modules/gst/routes.ts`.
- One new React page sits under `frontend/src/pages/workstation/services/gst-filing/`.

**Tech Stack:** Express, Prisma/Postgres, vitest (backend). React, react-query, react-router, Tailwind (frontend).

## Global Constraints
- Who appears: only clients with a live **GST Filing** ClientService (`Service.code = 'GST_FILING'`, `deletedAt = null`, status not `on_hold`), where the client is not deleted and not `inactive`.
- A client with no GSTIN is never enrolled. It is listed as **Needs setup**.
- On any day in month M, jobs exist for period **M−1** (`YYYY-MM`): a GSTR-1 and a GSTR-3B. Quarterly filers get them only when M−1 is a quarter-end month (`kindsOwed`). Composition dealers get none.
- Data status per client-month is `pending | received`. It is set by a staff tick, or automatically by a client portal upload to that month's request document.
- Start → Finish with **no review step**: GSTR-1 `in_preparation → filed` and GSTR-3B `preparation → filed` are allowed. An ARN and filed date are always required (`assertFilingRecord`).
- No Tasks-module links. Filing is **recorded, never transmitted** (`filedManually = true`).
- Permissions: read with `workstation.gst.read | workstation.gst.manage`, write with `workstation.gst.manage`. Client scope comes from `assignedClientIds`.
- All dates use IST (`istToday()` from `backend/src/lib/dates.ts`). Money is integer paise (`BigInt` on GstFiling).
- Tests:
  - Backend: `cd backend && TEST_DATABASE_URL='postgresql://selva@localhost:5432/auditos_test?schema=public' npx vitest run <path>`
  - Frontend: `cd frontend && npx tsc -b && npx vite build`
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push; the user pushes.
- Before deploying, rehearse the schema change on a copy of the production backup (see `auditos-deploy-flow` memory).

## File Structure
| File | Responsibility |
|---|---|
| `backend/prisma/schema.prisma` (modify `GstCompliancePeriod`) | 4 data-received columns |
| `backend/src/modules/gst/filing.ts` (create) | enrolment sync, monthly job generation, data received, portal hook |
| `backend/src/modules/gst/__tests__/filing.test.ts` (create) | tests for filing.ts and the new endpoints |
| `backend/src/modules/gst/validate.ts` (modify) | allow Start → Finish without review |
| `backend/src/modules/gst/routes.ts` (modify) | `GET /filing-board`, `POST /periods/:id/data`, `POST /filing/remind` |
| `backend/src/modules/compliance/scheduler.ts` (modify) | daily `gst.filing_jobs` step |
| `backend/src/modules/workstation/clients.routes.ts`, `services.routes.ts` (modify) | re-sync a client after service or GSTIN changes |
| `backend/src/modules/workstation/client-portal.routes.ts` (modify) | a portal upload marks data received |
| `frontend/src/modules/workstation/gst/api.ts` (modify) | board / data / remind client calls and types |
| `frontend/src/pages/workstation/services/gst-filing/GstFilingPage.tsx` (create) | the page |
| `frontend/src/pages/workstation/services/gst-filing/FinishModal.tsx` (create) | the Finish form |
| `frontend/src/App.tsx`, `frontend/src/shell/v2/Sidebar.tsx` (modify) | route and menu entry |
| `frontend/src/pages/workstation/registration/gst/GstShell.tsx` (modify) | link the old return tabs to the new page |

---

### Task 1: Schema — data-received columns

**Files:**
- Modify: `backend/prisma/schema.prisma` (model `GstCompliancePeriod`, after `nextDueDate String?`)

- [ ] **Step 1: Add the columns**

```prisma
  /// GST Filing: has the client sent this month's sales/purchase data?
  /// pending | received. Set by a staff tick or a client portal upload.
  dataStatus       String    @default("pending")
  dataReceivedAt   DateTime?
  /// User id of the staff member who ticked it, or 'portal'.
  dataReceivedBy   String?
  /// The ClientDocument request ("GST data — Oct 2026") shown in the client portal.
  dataRequestDocId String?
```

- [ ] **Step 2: Push to the local and test databases**

```bash
cd backend
DATABASE_URL='postgresql://selva@localhost:5432/auditos_local?schema=public' npx prisma db push --skip-generate
DATABASE_URL='postgresql://selva@localhost:5432/auditos_test?schema=public' npx prisma db push --skip-generate
npx prisma generate
npx tsc --noEmit -p .
```
Expected: "Your database is now in sync" twice, and tsc exits 0. All changes are additive (new nullable or defaulted columns), so safe-push accepts them.

- [ ] **Step 3: Commit**

```bash
git add backend/prisma/schema.prisma
git commit -m "Schema: GST compliance period carries data-received status"
```

---

### Task 2: Enrolment sync and monthly job generation

**Files:**
- Create: `backend/src/modules/gst/filing.ts`
- Test: `backend/src/modules/gst/__tests__/filing.test.ts`

**Interfaces:**
- Produces:
  - `GST_FILING_SERVICE_CODE = 'GST_FILING'`
  - `previousPeriod(today: string): string`
  - `syncGstEnrolment(db: PrismaClient, opts?: { clientId?: string; userId?: string | null }): Promise<{ enrolled: number; deactivated: number }>`
  - `ensurePeriodJobs(db: PrismaClient, gstProfileId: string, period: string, userId?: string | null): Promise<{ periodId: string | null; created: number }>`
  - `generateGstFilingJobs(db: PrismaClient, today?: string): Promise<{ enrolled: number; deactivated: number; periods: number; filings: number }>`
  - `refreshClientGst(db: PrismaClient, clientId: string, userId: string | null): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `backend/src/modules/gst/__tests__/filing.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { ensurePeriodJobs, generateGstFilingJobs, previousPeriod, syncGstEnrolment } from '../filing.js'

let orgId = ''
let serviceId = ''
let empId = ''

beforeAll(async () => {
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id
    ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'GST filing firm' } })).id
  serviceId = (await prisma.service.findFirst({ where: { code: 'GST_FILING' } }))?.id
    ?? (await prisma.service.create({ data: { organisationId: orgId, code: 'GST_FILING', name: 'GST Filing' } })).id
  const ws = (await prisma.workSchedule.findFirst())?.id
    ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  empId = (await prisma.employee.create({
    data: { organisationId: orgId, employeeCode: uid('E'), firstName: 'Gst', lastName: 'Staff', fullName: uid('Gst Staff'), email: `${uid('g')}@x.local`, joiningDate: '2026-01-01', workScheduleId: ws },
  })).id
  if (!await prisma.documentCategory.findFirst({ where: { code: 'gst' } })) {
    await prisma.documentCategory.create({ data: { organisationId: orgId, code: 'gst', name: 'GST' } })
  }
})

/** A client, optionally with the GST Filing service. */
export async function gstClient(opts: { gstin?: string | null; withService?: boolean; serviceStatus?: string; frequency?: 'monthly' | 'quarterly' } = {}) {
  const code = uid('GF')
  const client = await prisma.client.create({
    data: {
      organisationId: orgId, clientCode: code, companyName: code, contactPerson: 'C', contactNumber: '9999999999',
      email: `${code.toLowerCase()}@client.test`, accountManagerId: empId, status: 'active', onboardingDate: '2026-01-01',
      gstin: opts.gstin === undefined ? '27AAPFU0939F1ZV' : opts.gstin,
    },
  })
  if (opts.withService !== false) {
    await prisma.clientService.create({
      data: { clientId: client.id, serviceId, assignedEmployeeId: empId, status: opts.serviceStatus ?? 'not_started' },
    })
  }
  if (opts.frequency === 'quarterly') {
    await syncGstEnrolment(prisma, { clientId: client.id })
    await prisma.gstProfile.update({ where: { clientId: client.id }, data: { filingFrequency: 'quarterly' } })
  }
  return client
}

describe('previousPeriod', () => {
  it('is the month before, across a year boundary', () => {
    expect(previousPeriod('2026-11-16')).toBe('2026-10')
    expect(previousPeriod('2027-01-01')).toBe('2026-12')
  })
})

describe('syncGstEnrolment', () => {
  it('enrols a GST Filing client with a GSTIN, assigned to the service staff', async () => {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    expect(p).toMatchObject({ gstin: '27AAPFU0939F1ZV', assignedEmployeeId: empId, active: true, filingFrequency: 'monthly' })
  })
  it('does not enrol without a GSTIN, without the service, or when on hold', async () => {
    const a = await gstClient({ gstin: null })
    const b = await gstClient({ withService: false })
    const h = await gstClient({ serviceStatus: 'on_hold' })
    for (const c of [a, b, h]) await syncGstEnrolment(prisma, { clientId: c.id })
    expect(await prisma.gstProfile.count({ where: { clientId: { in: [a.id, b.id, h.id] } } })).toBe(0)
  })
  it('deactivates the profile when the service is removed, and keeps past periods', async () => {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    await ensurePeriodJobs(prisma, p.id, '2026-09')
    await prisma.clientService.updateMany({ where: { clientId: c.id }, data: { deletedAt: new Date() } })
    await syncGstEnrolment(prisma, { clientId: c.id })
    expect((await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })).active).toBe(false)
    expect(await prisma.gstCompliancePeriod.count({ where: { gstProfileId: p.id } })).toBe(1)
  })
})

describe('ensurePeriodJobs / generateGstFilingJobs', () => {
  it('creates one GSTR-1 and one GSTR-3B with due dates, a data request, and is idempotent', async () => {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    const first = await ensurePeriodJobs(prisma, p.id, '2026-10')
    const again = await ensurePeriodJobs(prisma, p.id, '2026-10')
    expect(first.created).toBe(2)
    expect(again.created).toBe(0)
    const filings = await prisma.gstFiling.findMany({ where: { gstProfileId: p.id, period: '2026-10' }, orderBy: { returnType: 'asc' } })
    expect(filings.map((f) => [f.returnType, f.status])).toEqual([['GSTR-1', 'pending'], ['GSTR-3B', 'pending']])
    expect(filings.every((f) => f.dueDate?.startsWith('2026-11-'))).toBe(true)
    const period = await prisma.gstCompliancePeriod.findUniqueOrThrow({ where: { id: first.periodId! } })
    expect(period.dataStatus).toBe('pending')
    const doc = await prisma.clientDocument.findUniqueOrThrow({ where: { id: period.dataRequestDocId! } })
    expect(doc).toMatchObject({ clientId: c.id, status: 'requested', name: 'GST data — Oct 2026' })
  })
  it('gives a quarterly filer jobs only for a quarter-end month', async () => {
    const c = await gstClient({ frequency: 'quarterly' })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    expect((await ensurePeriodJobs(prisma, p.id, '2026-10')).created).toBe(0)
    expect((await ensurePeriodJobs(prisma, p.id, '2026-09')).created).toBe(2)
  })
  it('the daily run enrols and generates last month for every GST Filing client', async () => {
    const c = await gstClient()
    const r = await generateGstFilingJobs(prisma, '2026-11-01')
    expect(r.filings).toBeGreaterThanOrEqual(2)
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    expect(await prisma.gstFiling.count({ where: { gstProfileId: p.id, period: '2026-10' } })).toBe(2)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && TEST_DATABASE_URL='postgresql://selva@localhost:5432/auditos_test?schema=public' npx vitest run src/modules/gst/__tests__/filing.test.ts`
Expected: FAIL — `Cannot find module '../filing.js'`.

- [ ] **Step 3: Implement `backend/src/modules/gst/filing.ts`**

```ts
/**
 * GST FILING — Workstation → Services → GST Filing.
 *
 * Feeds the GST engine (GstProfile → GstCompliancePeriod → GstFiling) from
 * the "GST Filing" client service, which nothing else does:
 *   - syncGstEnrolment: a client with a live GST Filing service and a GSTIN
 *     has an active GstProfile; anyone else's profile is deactivated (past
 *     periods are kept).
 *   - ensurePeriodJobs: one GSTR-1 and one GSTR-3B per owed period, with
 *     due dates from the CBIC rule engine, plus a portal data request.
 *   - generateGstFilingJobs: the daily run — sync, then last month for all.
 * Every function is idempotent: the unique keys on period and filing make a
 * second run a no-op, so the scheduler can tick as often as it likes.
 */
import type { PrismaClient } from '@prisma/client'
import { istToday } from '../../lib/dates.js'
import { createRuleResolver, dueForProfile, kindsOwed } from './dueDate.js'
import { financialYearOf } from './service.js'

export const GST_FILING_SERVICE_CODE = 'GST_FILING'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const periodName = (period: string) => `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`

/** `YYYY-MM` of the month before the IST date `today` (YYYY-MM-DD). */
export function previousPeriod(today: string): string {
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7))
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

/** Clients that should be enrolled, keyed by client id → the service row that enrols them. */
async function liveGstServices(db: PrismaClient, clientId?: string) {
  const svc = await db.service.findFirst({ where: { code: GST_FILING_SERVICE_CODE, deletedAt: null } })
  const live = new Map<string, { assignedEmployeeId: string; gstin: string | null }>()
  if (!svc) return { live, serviceId: null as string | null }
  const rows = await db.clientService.findMany({
    where: { serviceId: svc.id, deletedAt: null, ...(clientId ? { clientId } : {}) },
    include: { client: { select: { id: true, gstin: true, status: true, deletedAt: true } } },
    orderBy: { createdAt: 'asc' },
  })
  for (const r of rows) {
    if (r.status === 'on_hold' || r.client.deletedAt || r.client.status === 'inactive') continue
    if (!live.has(r.clientId)) live.set(r.clientId, { assignedEmployeeId: r.assignedEmployeeId, gstin: r.client.gstin })
  }
  return { live, serviceId: svc.id }
}

export async function syncGstEnrolment(
  db: PrismaClient, opts: { clientId?: string; userId?: string | null } = {},
): Promise<{ enrolled: number; deactivated: number }> {
  const { live } = await liveGstServices(db, opts.clientId)
  let enrolled = 0
  let deactivated = 0
  for (const [clientId, s] of live) {
    const gstin = s.gstin?.trim().toUpperCase() || null
    if (!gstin) continue // Needs setup: listed on the board, never enrolled
    const existing = await db.gstProfile.findUnique({ where: { clientId } })
    if (!existing) {
      await db.gstProfile.create({
        data: {
          clientId, gstin, assignedEmployeeId: s.assignedEmployeeId, filingFrequency: 'monthly',
          active: true, createdBy: opts.userId ?? null, updatedBy: opts.userId ?? null,
        },
      })
      enrolled++
    } else if (!existing.active || existing.deletedAt || existing.gstin !== gstin) {
      await db.gstProfile.update({
        where: { id: existing.id },
        data: { active: true, deletedAt: null, gstin, updatedBy: opts.userId ?? null },
      })
      enrolled++
    }
  }
  // Anyone enrolled but no longer live (service removed / on hold / client inactive or GSTIN cleared).
  const stale = await db.gstProfile.findMany({
    where: { active: true, deletedAt: null, ...(opts.clientId ? { clientId: opts.clientId } : {}) },
    select: { id: true, clientId: true },
  })
  for (const p of stale) {
    const s = live.get(p.clientId)
    if (s && s.gstin?.trim()) continue
    await db.gstProfile.update({ where: { id: p.id }, data: { active: false, updatedBy: opts.userId ?? null } })
    deactivated++
  }
  return { enrolled, deactivated }
}

export async function ensurePeriodJobs(
  db: PrismaClient, gstProfileId: string, period: string, userId: string | null = null,
): Promise<{ periodId: string | null; created: number }> {
  const profile = await db.gstProfile.findUnique({ where: { id: gstProfileId } })
  if (!profile || !profile.active || profile.deletedAt) return { periodId: null, created: 0 }
  const owed = kindsOwed(profile, period)
  const wanted = (['GSTR1', 'GSTR3B'] as const).filter((k) => owed.includes(k))
  if (wanted.length === 0) return { periodId: null, created: 0 }

  const financialYear = financialYearOf(period)
  const periodType = profile.filingFrequency === 'quarterly' ? 'quarterly' : 'monthly'
  const row = await db.gstCompliancePeriod.upsert({
    where: { gstProfileId_financialYear_period: { gstProfileId, financialYear, period } },
    create: {
      gstProfileId, financialYear, period, periodType,
      assignedEmployeeId: profile.assignedEmployeeId, reviewerEmployeeId: profile.reviewerEmployeeId,
      createdBy: userId, updatedBy: userId,
    },
    update: {},
  })

  const resolver = await createRuleResolver(db)
  let created = 0
  for (const kind of wanted) {
    const returnType = kind === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'
    const existing = await db.gstFiling.findUnique({
      where: { gstProfileId_period_returnType: { gstProfileId, period, returnType } },
    })
    if (existing) {
      if (!existing.compliancePeriodId) {
        await db.gstFiling.update({ where: { id: existing.id }, data: { compliancePeriodId: row.id, financialYear } })
      }
      continue
    }
    await db.gstFiling.create({
      data: {
        gstProfileId, period, returnType, status: 'pending', financialYear, compliancePeriodId: row.id,
        dueDate: dueForProfile(resolver, profile, period, returnType, periodType),
        assignedEmployeeId: profile.assignedEmployeeId, reviewerEmployeeId: profile.reviewerEmployeeId,
        createdBy: userId, updatedBy: userId,
      },
    })
    created++
  }

  if (!row.dataRequestDocId) {
    const category = await db.documentCategory.findFirst({ where: { code: 'gst', deletedAt: null } })
    if (category) {
      const doc = await db.clientDocument.create({
        data: {
          clientId: profile.clientId, categoryId: category.id, name: `GST data — ${periodName(period)}`,
          financialYear, status: 'requested', requestedAt: new Date(), createdBy: userId, updatedBy: userId,
        },
      })
      await db.gstCompliancePeriod.update({ where: { id: row.id }, data: { dataRequestDocId: doc.id } })
    }
  }
  return { periodId: row.id, created }
}

export async function generateGstFilingJobs(db: PrismaClient, today = istToday()) {
  const sync = await syncGstEnrolment(db)
  const period = previousPeriod(today)
  const profiles = await db.gstProfile.findMany({ where: { active: true, deletedAt: null }, select: { id: true } })
  let periods = 0
  let filings = 0
  for (const p of profiles) {
    const r = await ensurePeriodJobs(db, p.id, period)
    if (r.periodId) periods++
    filings += r.created
  }
  return { ...sync, periods, filings }
}

/** After a client's service or GSTIN changed: re-sync and make sure last month exists. Best effort. */
export async function refreshClientGst(db: PrismaClient, clientId: string, userId: string | null): Promise<void> {
  try {
    await syncGstEnrolment(db, { clientId, userId })
    const p = await db.gstProfile.findUnique({ where: { clientId } })
    if (p?.active && !p.deletedAt) await ensurePeriodJobs(db, p.id, previousPeriod(istToday()), userId)
  } catch (e) {
    console.error('[gst-filing] refresh failed', clientId, e instanceof Error ? e.message : e)
  }
}
```

If `prisma.service` has no `deletedAt` column, drop `deletedAt: null` from the `service.findFirst` where (check `model Service` in schema.prisma). The same applies to `documentCategory`.

- [ ] **Step 4: Run the tests**

Run: the same command as Step 2.
Expected: PASS (8 tests). If the GSTR-1/3B due dates are null in the test DB, `GstDueDateRule` is not seeded there. In that case, in `beforeAll`, create the monthly rules (`kind: 'GSTR1', filingFrequency: 'monthly', stateGroup: null, effectiveFrom: null, dueDay: 11` and `kind: 'GSTR3B', … dueDay: 20`) when missing, following `gst-fixes.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/gst/filing.ts backend/src/modules/gst/__tests__/filing.test.ts
git commit -m "GST Filing: enrol clients from the GST Filing service and generate last month's GSTR-1 / GSTR-3B jobs"
```

---

### Task 3: Wire generation into the daily job and the write routes

**Files:**
- Modify: `backend/src/modules/compliance/scheduler.ts` (`ComplianceJobReport` and `runComplianceJobs`)
- Modify: `backend/src/modules/workstation/clients.routes.ts` (`POST /:id/services` after the create, `PATCH /:id` after a GSTIN or status update)
- Modify: `backend/src/modules/workstation/services.routes.ts` (`PATCH /:id` after the transaction)

**Interfaces:**
- Consumes: `generateGstFilingJobs` and `refreshClientGst` from Task 2.

- [ ] **Step 1: Add the scheduler step**

In `scheduler.ts`, add `import { generateGstFilingJobs } from '../gst/filing.js'`, add the field `gst_filing_jobs: Awaited<ReturnType<typeof generateGstFilingJobs>> | null` to `ComplianceJobReport`, and add this as the first entry in the returned object:

```ts
    // GST Filing: enrol GST Filing clients and open last month's returns.
    gst_filing_jobs: await step('gst.filing_jobs', () => generateGstFilingJobs(prisma, today)),
```

- [ ] **Step 2: Re-sync a client after service and client writes**

In `clients.routes.ts`:
- Add `import { refreshClientGst } from '../gst/filing.js'`.
- In `POST /:id/services`, right after `const row = await prisma.clientService.create(...)`:

```ts
  if (service!.code === 'GST_FILING') await refreshClientGst(prisma, req.params.id, session.userId)
```

- In `PATCH /:id`, after the client update succeeds and before `ok(res, …)`:

```ts
  if ('gstin' in b || 'status' in b) await refreshClientGst(prisma, req.params.id, session.userId)
```

In `services.routes.ts`, add the same import. After the `$transaction` in `PATCH /:id`, add:

```ts
  if (before.service.code === 'GST_FILING') await refreshClientGst(prisma, before.clientId, session.userId)
```

- [ ] **Step 3: Add a route-level test**

Append to `filing.test.ts`. This also gives the later tasks a server and cookie: add these imports at the top, then the block.

```ts
import type { Server } from 'node:http'
import { afterAll } from 'vitest'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'

let server: Server
let base = ''
let cookie = ''
export async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const r = await fetch(`${base}${path}`, { method: opts.method ?? 'GET', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined })
  const t = await r.text()
  const j = t ? JSON.parse(t) : null
  return { status: r.status, body: j && typeof j === 'object' && 'data' in j ? j.data : j }
}
beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const a = server.address()
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
  await setupRoles(prisma, { force: true })
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'md' } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: `${uid('md')}@x.local`, passwordHash: 'x', roleId: role.id, employeeId: empId } })
  cookie = `ao_access=${signToken(u.id)}`
})
afterAll(() => server?.close())

describe('adding the GST Filing service through the API', () => {
  it('enrols the client and opens last month at once', async () => {
    const c = await gstClient({ withService: false })
    const r = await api(`/api/clients/${c.id}/services`, { method: 'POST', body: { service_id: serviceId, assigned_employee_id: empId } })
    expect(r.status).toBe(201)
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    expect(await prisma.gstFiling.count({ where: { gstProfileId: p.id } })).toBe(2)
  })
})
```

Check the status the services POST returns (`ok(res, …, 201)` or `200`) and match it.

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx tsc --noEmit -p . && TEST_DATABASE_URL='postgresql://selva@localhost:5432/auditos_test?schema=public' npx vitest run src/modules/gst src/modules/compliance src/modules/workstation`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/compliance/scheduler.ts backend/src/modules/workstation/clients.routes.ts backend/src/modules/workstation/services.routes.ts backend/src/modules/gst/__tests__/filing.test.ts
git commit -m "GST Filing: daily job and client/service changes keep enrolment and last month's jobs current"
```

---

### Task 4: Start → Finish without a review step

**Files:**
- Modify: `backend/src/modules/gst/validate.ts` (`assertGstr1Transition`, `assertGstr3bTransition`)
- Test: `backend/src/modules/gst/__tests__/filing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { assertGstr1Transition, assertGstr3bTransition } from '../validate.js'

describe('Start → Finish', () => {
  it('records a return as filed straight from preparation', () => {
    expect(() => assertGstr1Transition('in_preparation', 'filed')).not.toThrow()
    expect(() => assertGstr3bTransition('preparation', 'filed')).not.toThrow()
  })
  it('still refuses filing a return nobody started', () => {
    expect(() => assertGstr1Transition('pending', 'filed')).toThrow()
    expect(() => assertGstr3bTransition('pending', 'filed')).toThrow()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL — "A return must be reviewed and ready before it can be recorded as filed."

- [ ] **Step 3: Implement**

In `assertGstr1Transition`, replace `['under_review', 'ready_to_file', 'filed']` with `['in_preparation', 'under_review', 'ready_to_file', 'filed']`. In `assertGstr3bTransition`, replace the same list with `['preparation', 'under_review', 'ready_to_file', 'filed']`. Change both error messages to `'Start the return before recording it as filed.'`, and update the comment above `GSTR1_AFTER_FILED` to say that review is optional (GST Filing is Start → Finish).

- [ ] **Step 4: Update older expectations and run**

Run: `grep -rn "reviewed and ready" backend/src`. Update any test that expected the old refusal for `in_preparation`/`preparation` → `filed`, so it now expects success. Then run `src/modules/gst`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/gst/validate.ts backend/src/modules/gst/__tests__
git commit -m "GST: a started return can be recorded as filed without a review step (ARN and date still required)"
```

---

### Task 5: Data received — staff tick, portal upload, reminders

**Files:**
- Modify: `backend/src/modules/gst/filing.ts` (add `setDataStatus`, `markDataFromPortal`, `dataReminderBody`)
- Modify: `backend/src/modules/gst/routes.ts` (add `POST /periods/:id/data`, `POST /filing/remind`)
- Modify: `backend/src/modules/workstation/client-portal.routes.ts` (after the upload transaction)
- Test: `backend/src/modules/gst/__tests__/filing.test.ts`

**Interfaces:**
- Produces:
  - `setDataStatus(db, periodId: string, received: boolean, by: string): Promise<void>` (`by` is a user id or `'portal'`)
  - `markDataFromPortal(db, clientDocumentId: string): Promise<boolean>`
  - `POST /api/gst/periods/:id/data` with `{ received: boolean }` → `{ ok: true }`
  - `POST /api/gst/filing/remind` with `{ period_ids: string[] }` → `{ sent: number; failed: { period_id: string; reason: string }[] }`

- [ ] **Step 1: Write the failing tests**

```ts
import { markDataFromPortal } from '../filing.js'

describe('data received', () => {
  async function openPeriod() {
    const c = await gstClient()
    await syncGstEnrolment(prisma, { clientId: c.id })
    const p = await prisma.gstProfile.findUniqueOrThrow({ where: { clientId: c.id } })
    const { periodId } = await ensurePeriodJobs(prisma, p.id, '2026-10')
    return prisma.gstCompliancePeriod.findUniqueOrThrow({ where: { id: periodId! } })
  }
  it('staff tick and untick', async () => {
    const period = await openPeriod()
    expect((await api(`/api/gst/periods/${period.id}/data`, { method: 'POST', body: { received: true } })).status).toBe(200)
    expect(await prisma.gstCompliancePeriod.findUniqueOrThrow({ where: { id: period.id } })).toMatchObject({ dataStatus: 'received' })
    await api(`/api/gst/periods/${period.id}/data`, { method: 'POST', body: { received: false } })
    expect(await prisma.gstCompliancePeriod.findUniqueOrThrow({ where: { id: period.id } })).toMatchObject({ dataStatus: 'pending', dataReceivedAt: null })
  })
  it('a portal upload to the request marks it received', async () => {
    const period = await openPeriod()
    expect(await markDataFromPortal(prisma, period.dataRequestDocId!)).toBe(true)
    expect(await prisma.gstCompliancePeriod.findUniqueOrThrow({ where: { id: period.id } })).toMatchObject({ dataStatus: 'received', dataReceivedBy: 'portal' })
    expect(await markDataFromPortal(prisma, 'not-a-gst-request')).toBe(false)
  })
  it('remind refuses an empty list', async () => {
    expect((await api('/api/gst/filing/remind', { method: 'POST', body: { period_ids: [] } })).status).toBe(400)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Expected: FAIL (route 404 and missing export).

- [ ] **Step 3: Implement in `filing.ts`**

```ts
import { writeGstAudit } from './service.js'

export async function setDataStatus(db: PrismaClient, periodId: string, received: boolean, by: string): Promise<void> {
  const before = await db.gstCompliancePeriod.findUniqueOrThrow({ where: { id: periodId } })
  await db.gstCompliancePeriod.update({
    where: { id: periodId },
    data: received
      ? { dataStatus: 'received', dataReceivedAt: new Date(), dataReceivedBy: by }
      : { dataStatus: 'pending', dataReceivedAt: null, dataReceivedBy: null },
  })
  await writeGstAudit({
    compliancePeriodId: periodId, action: received ? 'GST_DATA_RECEIVED' : 'GST_DATA_PENDING',
    userId: by === 'portal' ? null : by, oldValue: before.dataStatus, newValue: received ? 'received' : 'pending',
    meta: by === 'portal' ? { via: 'client_portal' } : undefined,
  })
}

/** Called after any portal upload: true when it answered a GST data request. */
export async function markDataFromPortal(db: PrismaClient, clientDocumentId: string): Promise<boolean> {
  const period = await db.gstCompliancePeriod.findFirst({ where: { dataRequestDocId: clientDocumentId, deletedAt: null } })
  if (!period || period.dataStatus === 'received') return false
  await setDataStatus(db, period.id, true, 'portal')
  return true
}

export function dataReminderBody(clientName: string, period: string, gstr1Due: string | null, portalUrl: string | null): { subject: string; body: string } {
  const month = periodName(period)
  return {
    subject: `GST data for ${month} — ${clientName}`,
    body: [
      'Dear Sir/Madam,',
      '',
      `Please send your sales and purchase details for ${month} so that we can file your GST returns${gstr1Due ? ` (GSTR-1 is due on ${gstr1Due})` : ''}.`,
      portalUrl ? `You can upload them here: ${portalUrl}` : 'You can reply to this email with the files.',
      '',
      'Thank you.',
    ].join('\n'),
  }
}
```

(Merge the `writeGstAudit` import into the existing `./service.js` import line.)

- [ ] **Step 4: Implement the routes in `gst/routes.ts`**

Add `setDataStatus, dataReminderBody, previousPeriod` to an import from `./filing.js`, and `env` from `../../lib/env.js` if it is not imported yet. Then add, after the `/periods/:id/payment` route:

```ts
/** POST /api/gst/periods/:id/data — GST Filing: data received from the client (tick) or not. */
gstRouter.post('/periods/:id/data', handler(async (req, res) => {
  const { session, row } = await periodForWrite(req, req.params.id)
  const received = req.body?.received
  if (typeof received !== 'boolean') throw ApiError.badRequest('received must be true or false.')
  await setDataStatus(prisma, row.id, received, session.userId)
  ok(res, { ok: true })
}))

/** POST /api/gst/filing/remind — email each pending client asking for the month's data. */
gstRouter.post('/filing/remind', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.gst.manage')
  const ids = Array.isArray(req.body?.period_ids) ? (req.body.period_ids as unknown[]).filter((x): x is string => typeof x === 'string') : []
  if (ids.length === 0 || ids.length > 200) throw ApiError.badRequest('Choose between 1 and 200 clients to remind.')
  const rows = await prisma.gstCompliancePeriod.findMany({
    where: { ...alive, id: { in: ids }, ...(await periodScopeWhere(session, scope)) },
    include: { gstProfile: { select: { clientId: true, client: { select: { companyName: true } } } }, filings: { where: alive } },
  })
  let sent = 0
  const failed: { period_id: string; reason: string }[] = []
  for (const r of rows) {
    if (r.dataStatus === 'received') { failed.push({ period_id: r.id, reason: 'Data already received.' }); continue }
    const gstr1 = r.filings.find((f) => f.returnType === 'GSTR-1') ?? r.filings[0]
    const link = await prisma.clientDocumentShareLink.findFirst({ where: { clientId: r.gstProfile.clientId, revokedAt: null, pausedAt: null }, orderBy: { createdAt: 'desc' } })
    const url = link ? `${env.publicAppUrl ?? ''}/portal/documents/${link.token}` : null
    const msg = dataReminderBody(r.gstProfile.client.companyName, r.period, gstr1?.dueDate ?? null, url)
    try {
      await sendClientReminder(prisma, {
        caseId: null, clientId: r.gstProfile.clientId, kind: 'GSTR1', period: r.period,
        dueDate: gstr1?.dueDate ?? istDateOf(new Date()), subject: msg.subject, body: msg.body, to: '',
      }, session.userId)
      sent++
    } catch (e) {
      failed.push({ period_id: r.id, reason: e instanceof Error ? e.message : 'Could not send.' })
    }
  }
  await writeAudit({ actorUserId: session.userId, action: 'gst.filing.data_reminder', entityType: 'GstCompliancePeriod', entityId: ids.join(','), after: { sent, failed: failed.length }, req })
  ok(res, { sent, failed })
}))
```

Before writing this, read `SendClientReminderInput` in `reminders.ts`. If `to: ''` is not accepted, pass the primary address from `clientAddresses(prisma, clientId)` (already imported in routes.ts) as `to`. Also check that `periodScopeWhere(session, scope)` is the helper used by `periodForWrite`, and reuse it.

- [ ] **Step 5: Hook the portal upload**

In `client-portal.routes.ts`, add `import { markDataFromPortal } from '../gst/filing.js'`. Right after the `writeAudit({... 'client_document.portal_upload' ...})` call in the upload route:

```ts
  // A GST data request answered through the portal marks that month received.
  await markDataFromPortal(prisma, doc.id).catch((e) => console.error('[gst-filing] portal mark', e))
```

- [ ] **Step 6: Run the tests**

Run: `cd backend && npx tsc --noEmit -p . && TEST_DATABASE_URL=… npx vitest run src/modules/gst src/modules/workstation`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/gst backend/src/modules/workstation/client-portal.routes.ts
git commit -m "GST Filing: data received by staff tick or client portal upload; bulk data reminders"
```

---

### Task 6: Filing board endpoint

**Files:**
- Modify: `backend/src/modules/gst/routes.ts` (add `GET /filing-board`)
- Test: `backend/src/modules/gst/__tests__/filing.test.ts`

**Interfaces:**
- Produces `GET /api/gst/filing-board?period=YYYY-MM` (defaults to the previous month), returning:

```ts
{
  period: string
  tiles: { clients: number; data_pending: number; gstr1_filed: number; gstr3b_filed: number; overdue: number }
  rows: {
    period_id: string; client_id: string; client_name: string; gstin: string; frequency: 'monthly' | 'quarterly'
    assigned: { id: string; name: string } | null
    data_status: 'pending' | 'received'; data_received_at: string | null; data_received_by: string | null
    gstr1: FilingCell | null; gstr3b: FilingCell | null
  }[]
  needs_setup: { client_id: string; client_name: string }[]
}
// FilingCell = { status: string; due_date: string | null; days_left: number | null; overdue: boolean; arn: string | null;
//   filed_at: string | null; net_payable_paise: number | null; challan_ref: string | null; payment_status: string }
```

- [ ] **Step 1: Write the failing test**

```ts
describe('GET /api/gst/filing-board', () => {
  it('lists enrolled clients with their two jobs and Needs setup clients', async () => {
    const c = await gstClient()
    const bare = await gstClient({ gstin: null })
    await generateGstFilingJobs(prisma, '2026-11-05')
    const r = await api('/api/gst/filing-board?period=2026-10')
    expect(r.status).toBe(200)
    const row = r.body.rows.find((x: any) => x.client_id === c.id)
    expect(row).toMatchObject({ data_status: 'pending', gstr1: { status: 'pending' }, gstr3b: { status: 'pending' } })
    expect(r.body.needs_setup.some((x: any) => x.client_id === bare.id)).toBe(true)
    expect(r.body.tiles.clients).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails** (404).

- [ ] **Step 3: Implement**

Add to `gst/routes.ts` (with `previousPeriod` imported from `./filing.js`):

```ts
/** GET /api/gst/filing-board?period=YYYY-MM — Services → GST Filing. */
gstRouter.get('/filing-board', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const q = typeof req.query.period === 'string' ? req.query.period : ''
  const period = /^\d{4}-\d{2}$/.test(q) ? q : previousPeriod(today())
  const t = today()
  const ids = await assignedClientIds(session, scope)
  const clientWhere = ids === 'ALL' ? {} : { clientId: { in: ids } }

  const periods = await prisma.gstCompliancePeriod.findMany({
    where: { ...alive, period, gstProfile: { ...clientWhere, deletedAt: null } },
    include: { gstProfile: { include: { client: { select: { id: true, companyName: true } } } }, filings: { where: alive } },
    orderBy: { gstProfile: { client: { companyName: 'asc' } } },
  })
  const emp = await employeeMap(periods.map((p) => p.assignedEmployeeId).filter((x): x is string => !!x))
  const cell = (f: (typeof periods)[number]['filings'][number] | undefined) => {
    if (!f) return null
    const status = normaliseFilingStatus(f.status, f.returnType)
    const done = ['filed', 'payment_pending', 'completed'].includes(status)
    const days = daysRemaining(f.dueDate, t)
    return {
      status, due_date: f.dueDate, days_left: days, overdue: !done && days !== null && days < 0,
      arn: f.arn, filed_at: f.filedAt ? istDateOf(f.filedAt) : null,
      net_payable_paise: f.netPayable === null ? null : Number(f.netPayable),
      challan_ref: f.challanRef, payment_status: f.paymentStatus,
    }
  }
  const rows = periods.map((p) => {
    const g1 = cell(p.filings.find((f) => f.returnType === 'GSTR-1'))
    const g3 = cell(p.filings.find((f) => f.returnType === 'GSTR-3B'))
    const a = p.assignedEmployeeId ? emp.get(p.assignedEmployeeId) : null
    return {
      period_id: p.id, client_id: p.gstProfile.client.id, client_name: p.gstProfile.client.companyName,
      gstin: p.gstProfile.gstin, frequency: p.periodType === 'quarterly' ? 'quarterly' : 'monthly',
      assigned: a ? { id: p.assignedEmployeeId!, name: a.full_name } : null,
      data_status: p.dataStatus === 'received' ? 'received' : 'pending',
      data_received_at: p.dataReceivedAt?.toISOString() ?? null, data_received_by: p.dataReceivedBy,
      gstr1: g1, gstr3b: g3,
    }
  })
  const isFiled = (c: ReturnType<typeof cell>) => !!c && ['filed', 'payment_pending', 'completed'].includes(c.status)

  // Needs setup: live GST Filing service, no GSTIN on the client.
  const svc = await prisma.service.findFirst({ where: { code: 'GST_FILING' } })
  const bare = svc ? await prisma.clientService.findMany({
    where: { serviceId: svc.id, deletedAt: null, status: { not: 'on_hold' }, client: { deletedAt: null, status: { not: 'inactive' }, gstin: null, ...(ids === 'ALL' ? {} : { id: { in: ids } }) } },
    select: { client: { select: { id: true, companyName: true } } }, distinct: ['clientId'],
  }) : []

  ok(res, {
    period,
    tiles: {
      clients: rows.length,
      data_pending: rows.filter((r) => r.data_status === 'pending').length,
      gstr1_filed: rows.filter((r) => isFiled(r.gstr1)).length,
      gstr3b_filed: rows.filter((r) => isFiled(r.gstr3b)).length,
      overdue: rows.filter((r) => r.gstr1?.overdue || r.gstr3b?.overdue).length,
    },
    rows,
    needs_setup: bare.map((b) => ({ client_id: b.client.id, client_name: b.client.companyName })),
  })
}))
```

Check `employeeMap`'s return shape in `api/workstation.serialize.ts` and adjust `a.full_name` to its real field. If the client GSTIN can be an empty string as well as null, add `OR: [{ gstin: null }, { gstin: '' }]`.

- [ ] **Step 4: Run the tests** — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/gst
git commit -m "GST Filing: board endpoint (tiles, per-client GSTR-1 / GSTR-3B, Needs setup)"
```

---

### Task 7: Frontend — API client, page, route, sidebar

**Files:**
- Modify: `frontend/src/modules/workstation/gst/api.ts`
- Create: `frontend/src/pages/workstation/services/gst-filing/GstFilingPage.tsx`
- Create: `frontend/src/pages/workstation/services/gst-filing/FinishModal.tsx`
- Modify: `frontend/src/App.tsx` (lazy import and a route before the `workstation/services/:category` catch-all)
- Modify: `frontend/src/shell/v2/Sidebar.tsx` (Services children: add `{ to: '/workstation/services/gst-filing', label: 'GST Filing' }` first)

- [ ] **Step 1: API client** — append to `api.ts`:

```ts
export interface FilingCell {
  status: string; due_date: string | null; days_left: number | null; overdue: boolean; arn: string | null;
  filed_at: string | null; net_payable_paise: number | null; challan_ref: string | null; payment_status: string;
}
export interface FilingBoardRow {
  period_id: string; client_id: string; client_name: string; gstin: string; frequency: 'monthly' | 'quarterly';
  assigned: { id: string; name: string } | null;
  data_status: 'pending' | 'received'; data_received_at: string | null; data_received_by: string | null;
  gstr1: FilingCell | null; gstr3b: FilingCell | null;
}
export interface FilingBoard {
  period: string;
  tiles: { clients: number; data_pending: number; gstr1_filed: number; gstr3b_filed: number; overdue: number };
  rows: FilingBoardRow[];
  needs_setup: { client_id: string; client_name: string }[];
}
export const gstFilingApi = {
  board: (period?: string) => api.get<FilingBoard>(`/api/gst/filing-board${period ? `?period=${encodeURIComponent(period)}` : ''}`),
  setData: (periodId: string, received: boolean) => api.post<{ ok: true }>(`/api/gst/periods/${periodId}/data`, { received }),
  remind: (periodIds: string[]) => api.post<{ sent: number; failed: { period_id: string; reason: string }[] }>('/api/gst/filing/remind', { period_ids: periodIds }),
  /** Start = in_preparation (GSTR-1) / preparation (GSTR-3B); Finish = filed with ARN + date (+ 3B money). */
  stage: (periodId: string, stage: 'gstr1' | 'gstr3b', body: Record<string, unknown>) => api.post<{ ok: true }>(`/api/gst/periods/${periodId}/stages/${stage}`, body),
};
```

- [ ] **Step 2: `FinishModal.tsx`**

```tsx
import { useState } from 'react';
import { Modal, Field, inputClass } from '@/modules/workstation/components';
import { Button } from '@/components/Button';

export interface FinishValues {
  arn: string; filed_date: string;
  taxable_value?: string; tax_amount?: string;
  tax_liability?: string; eligible_itc?: string; net_payable?: string; payment_date?: string; challan_ref?: string;
}

/** Finish a GSTR-1 or GSTR-3B: ARN + filed date are required; amounts are rupees. */
export function FinishModal({ kind, clientName, period, busy, error, onClose, onSave }: {
  kind: 'gstr1' | 'gstr3b'; clientName: string; period: string; busy: boolean; error: string | null;
  onClose: () => void; onSave: (v: FinishValues) => void;
}) {
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const [v, setV] = useState<FinishValues>({ arn: '', filed_date: today });
  const set = (k: keyof FinishValues) => (e: React.ChangeEvent<HTMLInputElement>) => setV((x) => ({ ...x, [k]: e.target.value }));
  const title = `${kind === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'} filed — ${clientName} · ${period}`;
  return (
    <Modal open title={title} onClose={onClose} footer={<>
      <Button size="sm" onClick={onClose}>Cancel</Button>
      <Button size="sm" variant="primary" disabled={busy || !v.arn.trim() || !v.filed_date} onClick={() => onSave(v)}>Save as filed</Button>
    </>}>
      <div className="space-y-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="ARN"><input className={inputClass + ' font-mono'} value={v.arn} onChange={set('arn')} placeholder="AA3310260012345" /></Field>
          <Field label="Filed on"><input type="date" className={inputClass} value={v.filed_date} max={today} onChange={set('filed_date')} /></Field>
        </div>
        {kind === 'gstr1' ? (
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Taxable value (₹)" hint="Optional"><input inputMode="decimal" className={inputClass} value={v.taxable_value ?? ''} onChange={set('taxable_value')} /></Field>
            <Field label="Tax (₹)" hint="Optional"><input inputMode="decimal" className={inputClass} value={v.tax_amount ?? ''} onChange={set('tax_amount')} /></Field>
          </div>
        ) : (
          <>
            <div className="grid sm:grid-cols-3 gap-3">
              <Field label="Tax liability (₹)"><input inputMode="decimal" className={inputClass} value={v.tax_liability ?? ''} onChange={set('tax_liability')} /></Field>
              <Field label="ITC claimed (₹)"><input inputMode="decimal" className={inputClass} value={v.eligible_itc ?? ''} onChange={set('eligible_itc')} /></Field>
              <Field label="Net payable (₹)"><input inputMode="decimal" className={inputClass} value={v.net_payable ?? ''} onChange={set('net_payable')} /></Field>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Tax paid on" hint="Leave empty if nil"><input type="date" className={inputClass} value={v.payment_date ?? ''} max={today} onChange={set('payment_date')} /></Field>
              <Field label="Challan (CPIN / CIN)"><input className={inputClass + ' font-mono'} value={v.challan_ref ?? ''} onChange={set('challan_ref')} /></Field>
            </div>
          </>
        )}
        {error ? <p className="text-13 text-red-700">{error}</p> : null}
        <p className="text-12 text-neutral-500">Recorded here after you file on the GST portal — Audit OS does not submit returns.</p>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 3: `GstFilingPage.tsx`**

```tsx
/**
 * Workstation → Services → GST Filing. Every GST Filing client for the
 * month (last month by default): who has sent their data, and a GSTR-1 and a
 * GSTR-3B job each, started and finished here.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Card, PageHeader, QueryState, Table, Row, Cell, FilterBar, SearchInput } from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { gstFilingApi, periodLabel, recentPeriods, type FilingBoardRow, type FilingCell } from '@/modules/workstation/gst/api';
import { FinishModal, type FinishValues } from './FinishModal';

type Tab = 'data' | 'gstr1' | 'gstr3b';
const STARTED: Record<'gstr1' | 'gstr3b', string> = { gstr1: 'in_preparation', gstr3b: 'preparation' };
const FILED = ['filed', 'payment_pending', 'completed'];
const LABEL: Record<string, string> = {
  pending: 'Not started', data_collection: 'Not started', in_preparation: 'In progress', preparation: 'In progress',
  under_review: 'In progress', ready_to_file: 'In progress', filed: 'Filed', payment_pending: 'Filed · payment due',
  completed: 'Filed', rework_required: 'Reopened',
};
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

function previousMonth(): string {
  const d = new Date(Date.now() + 5.5 * 3600e3);
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

export function GstFilingPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [period, setPeriod] = useState(previousMonth());
  const [tab, setTab] = useState<Tab>('data');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [finish, setFinish] = useState<{ row: FilingBoardRow; kind: 'gstr1' | 'gstr3b' } | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);

  const board = useQuery({ queryKey: ['gst-filing', period], queryFn: () => gstFilingApi.board(period) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['gst-filing'] });

  const data = useMutation({
    mutationFn: (v: { id: string; received: boolean }) => gstFilingApi.setData(v.id, v.received),
    onSuccess: refresh, onError: (e) => toast.push('error', errText(e)),
  });
  const remind = useMutation({
    mutationFn: (ids: string[]) => gstFilingApi.remind(ids),
    onSuccess: (r) => {
      setPicked(new Set());
      toast.push(r.failed.length ? 'error' : 'success', `${r.sent} reminder(s) sent${r.failed.length ? ` · ${r.failed.length} not sent: ${r.failed[0].reason}` : ''}.`);
    },
    onError: (e) => toast.push('error', errText(e)),
  });
  const start = useMutation({
    mutationFn: (v: { row: FilingBoardRow; kind: 'gstr1' | 'gstr3b' }) => gstFilingApi.stage(v.row.period_id, v.kind, { status: STARTED[v.kind] }),
    onSuccess: refresh, onError: (e) => toast.push('error', errText(e)),
  });
  const save = useMutation({
    mutationFn: (v: { row: FilingBoardRow; kind: 'gstr1' | 'gstr3b'; values: FinishValues }) => {
      const { values } = v;
      const body: Record<string, unknown> = { status: 'filed', arn: values.arn.trim(), filed_date: values.filed_date };
      for (const k of ['taxable_value', 'tax_amount', 'tax_liability', 'eligible_itc', 'net_payable'] as const) {
        if (values[k]?.trim()) body[k] = values[k]!.trim();
      }
      if (v.kind === 'gstr3b') {
        body.payment_status = values.payment_date ? 'completed' : 'not_applicable';
        if (values.payment_date) body.payment_date = values.payment_date;
        if (values.challan_ref?.trim()) body.challan_ref = values.challan_ref.trim();
      }
      return gstFilingApi.stage(v.row.period_id, v.kind, body);
    },
    onSuccess: () => { setFinish(null); refresh(); toast.push('success', 'Recorded as filed.'); },
    onError: (e) => setFinishError(errText(e)),
  });

  const rows = useMemo(() => {
    const all = board.data?.rows ?? [];
    const s = q.trim().toLowerCase();
    const hit = s ? all.filter((r) => r.client_name.toLowerCase().includes(s) || r.gstin.toLowerCase().includes(s)) : all;
    if (tab === 'data') return hit.filter((r) => r.data_status === 'pending');
    return hit.filter((r) => (tab === 'gstr1' ? r.gstr1 : r.gstr3b) !== null);
  }, [board.data, q, tab]);

  const jobCell = (row: FilingBoardRow, kind: 'gstr1' | 'gstr3b', c: FilingCell | null) => {
    if (!c) return <span className="text-neutral-400">—</span>;
    const filed = FILED.includes(c.status);
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className={'inline-flex h-6 px-2 items-center rounded-md text-11 font-medium ' +
          (filed ? 'bg-emerald-50 text-emerald-700' : c.overdue ? 'bg-red-50 text-red-700' : 'bg-neutral-100 text-neutral-700')}>
          {c.overdue && !filed ? 'Overdue' : LABEL[c.status] ?? c.status}
        </span>
        {filed ? <span className="text-12 font-mono text-neutral-600">{c.arn}</span> : (
          c.status === 'pending' || c.status === 'data_collection' || c.status === 'rework_required'
            ? <Button size="sm" disabled={start.isPending} onClick={() => {
                if (row.data_status === 'pending' && !window.confirm('Data is not marked received yet. Start anyway?')) return;
                start.mutate({ row, kind });
              }}>Start</Button>
            : <Button size="sm" variant="primary" onClick={() => { setFinishError(null); setFinish({ row, kind }); }}>Finish</Button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4" data-testid="gst-filing">
      <PageHeader
        title="GST Filing"
        subtitle="Every GST Filing client for the month: data received, GSTR-1 and GSTR-3B — started and finished here."
        action={
          <select className="h-9 px-3 rounded-md border border-neutral-200 bg-white text-13" value={period} onChange={(e) => { setPeriod(e.target.value); setPicked(new Set()); }} aria-label="Return period">
            {recentPeriods(12).map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        }
      />
      <QueryState query={board}>
        {(b) => (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {([['Clients', b.tiles.clients], ['Data pending', b.tiles.data_pending], ['GSTR-1 filed', b.tiles.gstr1_filed], ['GSTR-3B filed', b.tiles.gstr3b_filed], ['Overdue', b.tiles.overdue]] as const).map(([k, n]) => (
                <div key={k} className="bg-white border border-neutral-200 rounded-lg px-4 py-3">
                  <div className="text-12 text-neutral-500">{k}</div>
                  <div className={'text-22 font-semibold ' + (k === 'Overdue' && n > 0 ? 'text-red-700' : 'text-neutral-900')}>{n}</div>
                </div>
              ))}
            </div>
            {b.needs_setup.length ? (
              <div className="border-l-2 border-amber pl-3 text-13">
                <span className="font-medium text-neutral-900">Needs setup — add a GSTIN: </span>
                {b.needs_setup.map((c, i) => <span key={c.client_id}>{i ? ', ' : ''}<Link className="text-primary underline" to={`/workstation/clients/${c.client_id}`}>{c.client_name}</Link></span>)}
              </div>
            ) : null}
            <Card>
              <FilterBar>
                <SearchInput value={q} onChange={setQ} placeholder="Client or GSTIN" />
                {(['data', 'gstr1', 'gstr3b'] as const).map((t) => (
                  <button key={t} type="button" onClick={() => setTab(t)}
                    className={'h-8 px-3 rounded-full border text-13 ' + (tab === t ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white border-neutral-200 text-neutral-700')}>
                    {t === 'data' ? `Data pending (${b.tiles.data_pending})` : t === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'}
                  </button>
                ))}
                <div className="flex-1" />
                {tab === 'data' && picked.size ? <Button size="sm" variant="primary" disabled={remind.isPending} onClick={() => remind.mutate([...picked])}>Send reminder ({picked.size})</Button> : null}
              </FilterBar>
              {rows.length === 0 ? (
                <p className="px-5 py-6 text-13 text-neutral-500">{tab === 'data' ? `Everyone has sent their ${periodLabel(period)} data.` : 'No clients owe this return for the month.'}</p>
              ) : tab === 'data' ? (
                <Table head={['', 'Client', 'GSTIN', 'Assigned', 'GSTR-1 due', '']}>
                  {rows.map((r) => (
                    <Row key={r.period_id}>
                      <Cell><input type="checkbox" aria-label={`Select ${r.client_name}`} checked={picked.has(r.period_id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(r.period_id); else n.delete(r.period_id); return n; })} /></Cell>
                      <Cell><Link className="font-medium text-neutral-900 hover:underline" to={`/workstation/clients/${r.client_id}`}>{r.client_name}</Link></Cell>
                      <Cell className="font-mono" muted>{r.gstin}</Cell>
                      <Cell muted>{r.assigned?.name ?? '—'}</Cell>
                      <Cell muted>{r.gstr1?.due_date ?? '—'}</Cell>
                      <Cell>
                        <div className="flex gap-2 justify-end">
                          <Button size="sm" disabled={data.isPending} onClick={() => data.mutate({ id: r.period_id, received: true })}>Mark received</Button>
                          <Button size="sm" disabled={remind.isPending} onClick={() => remind.mutate([r.period_id])}>Remind</Button>
                        </div>
                      </Cell>
                    </Row>
                  ))}
                </Table>
              ) : (
                <Table head={['Client', 'Data', 'Due', 'Assigned', tab === 'gstr1' ? 'GSTR-1' : 'GSTR-3B']}>
                  {rows.map((r) => {
                    const c = tab === 'gstr1' ? r.gstr1 : r.gstr3b;
                    return (
                      <Row key={r.period_id}>
                        <Cell><Link className="font-medium text-neutral-900 hover:underline" to={`/workstation/clients/${r.client_id}`}>{r.client_name}</Link><div className="text-11 font-mono text-neutral-500">{r.gstin}</div></Cell>
                        <Cell>{r.data_status === 'received'
                          ? <button type="button" className="text-12 text-emerald-700" title="Mark as not received" onClick={() => data.mutate({ id: r.period_id, received: false })}>Received ✓</button>
                          : <button type="button" className="text-12 text-amber-700 underline" onClick={() => data.mutate({ id: r.period_id, received: true })}>Pending — mark received</button>}</Cell>
                        <Cell muted>{c?.due_date ?? '—'}{c && c.days_left !== null && !FILED.includes(c.status) ? ` · ${c.days_left < 0 ? `${-c.days_left}d late` : `${c.days_left}d left`}` : ''}</Cell>
                        <Cell muted>{r.assigned?.name ?? '—'}</Cell>
                        <Cell>{jobCell(r, tab === 'gstr1' ? 'gstr1' : 'gstr3b', c)}</Cell>
                      </Row>
                    );
                  })}
                </Table>
              )}
            </Card>
          </>
        )}
      </QueryState>
      {finish ? (
        <FinishModal kind={finish.kind} clientName={finish.row.client_name} period={periodLabel(period)} busy={save.isPending} error={finishError}
          onClose={() => setFinish(null)} onSave={(values) => save.mutate({ row: finish.row, kind: finish.kind, values })} />
      ) : null}
    </div>
  );
}
```

Two adjustments to make while writing this page:
- The app replaced browser pop-ups with in-app confirm dialogs (commit `b6ed55c`). Swap `window.confirm` for that confirm hook: `grep -rn "useConfirm\|ConfirmDialog" frontend/src | head`.
- Match `SearchInput`'s and `useToast`'s real props (`grep -n "export function SearchInput" -A6`), and check that `recentPeriods`/`periodLabel` exist in `gst/api.ts`; they are used by GstDashboard. Use only Tailwind classes already present in the codebase (the scale is closed: `text-11/12/13/14/22`, `text-amber-700`, and so on). If a class doesn't exist, use the nearest one GstDashboard uses.

- [ ] **Step 4: Route and sidebar**

In `App.tsx`, next to the TallyExport lazy import:

```tsx
const GstFilingPage = lazy(() => import('@/pages/workstation/services/gst-filing/GstFilingPage').then((m) => ({ default: m.GstFilingPage })));
```

Then, next to the tally-export route (before `workstation/services/:category`):

```tsx
              <Route path="workstation/services/gst-filing" element={<Lazy><GstFilingPage /></Lazy>} />
```

Wrap it in `<Lazy>` only if the tally-export route does; match that line exactly. In `Sidebar.tsx`, make the first Services child `{ to: '/workstation/services/gst-filing', label: 'GST Filing' },`.

- [ ] **Step 5: Build**

Run: `cd frontend && npx tsc -b && npx vite build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src
git commit -m "GST Filing page: data pending with reminders, GSTR-1 / GSTR-3B Start and Finish"
```

---

### Task 8: Old GST tabs → new page; end-to-end check

**Files:**
- Modify: `frontend/src/pages/workstation/registration/gst/GstShell.tsx`

- [ ] **Step 1: Link the old return tabs**

In `GstShell.tsx`, find the tab entries for GSTR-1, GSTR-2B and GSTR-3B (`grep -n "gstr1\|GSTR-1" GstShell.tsx`). Change the GSTR-1 and GSTR-3B tab targets to `/workstation/services/gst-filing`. Keep Dashboard, GSTR-2B, Clients, Registration and Checklist Template unchanged.

- [ ] **Step 2: Full verification**

```bash
cd backend && npx tsc --noEmit -p . && TEST_DATABASE_URL='postgresql://selva@localhost:5432/auditos_test?schema=public' npx vitest run
cd ../frontend && npx tsc -b && npx vite build && npx vitest run
```
Expected: all green (backend ≥ 876 + new tests).

- [ ] **Step 3: Live check on the local stack**

With the API (port 4011) and Vite (5173) running:
1. Run the compliance daily job once against `auditos_local`:
   ```bash
   cd backend && DATABASE_URL='postgresql://selva@localhost:5432/auditos_local?schema=public' npx tsx -e "import('./src/modules/gst/filing.ts').then(async m=>{const {prisma}=await import('./src/lib/prisma.ts');console.log(await m.generateGstFilingJobs(prisma));process.exit(0)})"
   ```
   Expected: `enrolled ≥ 2`, `filings ≥ 4` (two local clients have GST Filing).
2. Re-run the Playwright crawler (`scratchpad/crawl/crawl.mjs`) as Super Admin. Expected: `/workstation/services/gst-filing` has no issues.
3. Screenshot the page (`scratchpad/crawl/shot.mjs … /workstation/services/gst-filing`), then go through Mark received → Start → Finish (ARN `AA331026001234Z`, today) for one client and confirm the tiles update.

- [ ] **Step 4: Rehearse the schema change** on a copy of the latest production backup (see `auditos-deploy-flow` memory). Restore it to a scratch database and run the migrate step's safe-push against it. Expected: only the 4 new columns are added, and no data is dropped.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/workstation/registration/gst/GstShell.tsx
git commit -m "GST: return tabs open Services → GST Filing"
```
