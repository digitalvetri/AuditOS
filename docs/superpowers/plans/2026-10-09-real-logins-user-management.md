# Real Logins, User Management & Password Reset — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship AuditOS with no demo data, two owner accounts from env, an in-app Users page where Admin/Super Admin create logins and reset passwords, a forced "set your password" step after any admin-issued password, and self-service "Change password".

**Architecture:** Two new `User` columns (`mustChangePassword`, `sessionVersion`). The session JWT carries `v = sessionVersion`; `authenticate` rejects stale versions and blocks every API except a small allow-list while `mustChangePassword` is set. A new `/api/users` router (role-gated to `md` / `hr_admin`) hides `md` users from non-`md` callers. The seed keeps reference data only; a separate idempotent `setup-owners` script creates the two owners. Frontend drops MSW/mock data, adds `/set-password`, a Change-password modal and Settings → Users.

**Tech Stack:** Express + Prisma 5 (Postgres) + zod + bcryptjs + jsonwebtoken + Vitest (backend); React 18 + react-router 6 + TanStack Query + Tailwind (frontend).

**Spec:** `docs/superpowers/specs/2026-10-09-real-logins-user-management-design.md`

## Global Constraints

- Role codes: Super Admin = `md`, Admin = `hr_admin` (`backend/src/platform/rbac/modules.ts` `VISIBLE_ROLES`).
- Password policy: 8–128 characters, at least one letter and one digit. Server message strings exactly as in `passwordProblem()` (Task 1).
- Owner credentials are never committed. They live in `backend/.env` (gitignored) / `docker/.env.docker`.
- Super Admin user rows are never returned to, editable by, or assignable by a non-`md` caller; a hidden target answers 404.
- No passwords or hashes in audit payloads, logs or API responses.
- UI: Pastel Bento styling, closed Tailwind scale — reuse existing `Button`, `Input`, `SectionShell`, `dash-card`, `useToast`. Do not touch print documents.
- API envelope: success `{ data }`, error `{ error: { code, message, details } }` via `ApiError` / `ok()`.
- Test DB: Docker Postgres is currently broken on this machine. Run backend tests against the native Postgres:
  `createdb auditos_test 2>/dev/null; export TEST_DATABASE_URL='postgresql://selva@localhost:5432/auditos_test?schema=public'` before `npm test`.

---

### Task 1: Schema columns + password policy

**Files:**
- Modify: `backend/prisma/schema.prisma` (model `User`, after `lastLoginAt`)
- Create: `backend/src/platform/password.ts`
- Test: `backend/src/platform/__tests__/password.test.ts`

**Interfaces:**
- Produces: `passwordProblem(pw: string): string | null`; Prisma fields `User.mustChangePassword: boolean`, `User.sessionVersion: number`.

- [ ] **Step 1: Write the failing test** — `backend/src/platform/__tests__/password.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { passwordProblem } from '../password.js'

describe('passwordProblem', () => {
  it('accepts 8+ chars with a letter and a digit', () => {
    expect(passwordProblem('Jns@2026')).toBeNull()
    expect(passwordProblem('abcdefg1')).toBeNull()
  })
  it('rejects short passwords', () => {
    expect(passwordProblem('a1b2c3')).toBe('Password must be at least 8 characters.')
  })
  it('rejects passwords without a letter or without a digit', () => {
    expect(passwordProblem('12345678')).toBe('Password must contain letters and numbers.')
    expect(passwordProblem('abcdefgh')).toBe('Password must contain letters and numbers.')
  })
  it('rejects absurdly long passwords', () => {
    expect(passwordProblem('a1'.repeat(65))).toBe('Password must be at most 128 characters.')
  })
})
```

- [ ] **Step 2: Run it — expect FAIL (module not found)**

Run: `cd backend && npx vitest run src/platform/__tests__/password.test.ts`

- [ ] **Step 3: Implement** — `backend/src/platform/password.ts`

```ts
/**
 * The one password rule, used by every endpoint that sets a password
 * (change-password, admin create / reset, setup-owners). The frontend mirrors
 * it for instant feedback; this is the control.
 */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return 'Password must be at least 8 characters.'
  if (pw.length > 128) return 'Password must be at most 128 characters.'
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers.'
  return null
}
```

- [ ] **Step 4: Add the schema columns** — in `model User`, after `lastLoginAt    DateTime?`:

```prisma
  // Set when an Admin creates this login or resets its password: the user
  // must choose their own password before the API will serve anything else.
  mustChangePassword Boolean @default(false)
  // Carried in the session JWT as `v`. Bumped on every password change,
  // admin reset and deactivation, so older sessions stop working everywhere.
  sessionVersion     Int     @default(0)
```

Run: `cd backend && npx prisma generate`

- [ ] **Step 5: Run the test — expect PASS**, then `npx tsc -p tsconfig.json --noEmit` — expect no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/prisma/schema.prisma backend/src/platform/password.ts backend/src/platform/__tests__/password.test.ts
git commit -m "Add password policy and User session columns"
```

---

### Task 2: Session versioning, forced password change, change-password endpoint

**Files:**
- Modify: `backend/src/platform/auth.ts` (`Session`, `signToken`, `loadSession`, `authenticate`, new `passwordMatches`)
- Modify: `backend/src/modules/auth.routes.ts` (login token, `sessionPayload`, new `POST /change-password`)
- Modify: `backend/src/modules/messages/realtime.ts:55` (pass token version)
- Test: `backend/src/modules/__tests__/auth-password.test.ts`

**Interfaces:**
- Consumes: `passwordProblem` (Task 1).
- Produces: `signToken(userId: string, version?: number): string`; `loadSession(userId: string, tokenVersion?: number)`; `passwordMatches(hash: string, plain: string): boolean`; `Session.mustChangePassword: boolean`; session payload field `must_change_password: boolean`; error code `password_change_required` (403).

- [ ] **Step 1: Write the failing test** — `backend/src/modules/__tests__/auth-password.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { hashPassword } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'

let server: Server
let base = ''

async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  const setCookie = res.headers.get('set-cookie')
  const cookie = setCookie ? setCookie.split(';')[0] : null
  return { status: res.status, body: text ? JSON.parse(text) : null, cookie }
}

async function makeUser(password: string, mustChange: boolean) {
  const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
  const role = await prisma.role.upsert({
    where: { code: 'employee' }, update: {}, create: { id: 'role-employee', code: 'employee', name: 'Associate' },
  })
  const email = `${uid('e')}@x.local`
  await prisma.user.create({
    data: { id: uid('u'), organisationId: org.id, email, passwordHash: hashPassword(password), roleId: role.id, mustChangePassword: mustChange },
  })
  return email
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('forced password change', () => {
  it('reports must_change_password and blocks other APIs until changed', async () => {
    const email = await makeUser('Temp1234', true)
    const login = await api('/api/auth/login', { method: 'POST', body: { email, password: 'Temp1234' } })
    expect(login.status).toBe(200)
    expect(login.body.data.must_change_password).toBe(true)

    const me = await api('/api/auth/me', { cookie: login.cookie! })
    expect(me.status).toBe(200)
    const blocked = await api('/api/notifications', { cookie: login.cookie! })
    expect(blocked.status).toBe(403)
    expect(blocked.body.error.code).toBe('password_change_required')
  })
})

describe('POST /api/auth/change-password', () => {
  it('rejects a wrong current password', async () => {
    const email = await makeUser('Start1234', false)
    const login = await api('/api/auth/login', { method: 'POST', body: { email, password: 'Start1234' } })
    const r = await api('/api/auth/change-password', {
      method: 'POST', cookie: login.cookie!, body: { current_password: 'nope', new_password: 'Better1234' },
    })
    expect(r.status).toBe(400)
    expect(r.body.error.message).toBe('Your current password is incorrect.')
  })

  it('rejects a weak or unchanged new password', async () => {
    const email = await makeUser('Start1234', false)
    const login = await api('/api/auth/login', { method: 'POST', body: { email, password: 'Start1234' } })
    const weak = await api('/api/auth/change-password', {
      method: 'POST', cookie: login.cookie!, body: { current_password: 'Start1234', new_password: 'short' },
    })
    expect(weak.status).toBe(400)
    const same = await api('/api/auth/change-password', {
      method: 'POST', cookie: login.cookie!, body: { current_password: 'Start1234', new_password: 'Start1234' },
    })
    expect(same.status).toBe(400)
  })

  it('changes the password, clears the flag, re-issues this cookie and ends older sessions', async () => {
    const email = await makeUser('Temp1234', true)
    const first = await api('/api/auth/login', { method: 'POST', body: { email, password: 'Temp1234' } })
    const second = await api('/api/auth/login', { method: 'POST', body: { email, password: 'Temp1234' } })

    const r = await api('/api/auth/change-password', {
      method: 'POST', cookie: first.cookie!, body: { current_password: 'Temp1234', new_password: 'Mine12345' },
    })
    expect(r.status).toBe(200)
    expect(r.body.data.must_change_password).toBe(false)
    expect(r.cookie).toBeTruthy()

    expect((await api('/api/notifications', { cookie: r.cookie! })).status).toBe(200)
    expect((await api('/api/auth/me', { cookie: second.cookie! })).status).toBe(401)
    const relogin = await api('/api/auth/login', { method: 'POST', body: { email, password: 'Mine12345' } })
    expect(relogin.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`must_change_password` undefined / 404 on change-password)

Run: `cd backend && npx vitest run src/modules/__tests__/auth-password.test.ts`

- [ ] **Step 3: Implement `backend/src/platform/auth.ts` changes**

Add to `interface Session` (after `employeeFullName`):

```ts
  /** An Admin-issued password is still in use: only the change-password flow may run. */
  mustChangePassword: boolean
```

Replace `signToken`:

```ts
/** `v` is the user's sessionVersion; bumping it ends every older session. */
export function signToken(userId: string, version = 0): string {
  return jwt.sign({ sub: userId, v: version }, env.jwtSecret, { expiresIn: env.sessionTtlSeconds })
}
```

Add after `hashPassword`:

```ts
export function passwordMatches(hash: string, plain: string): boolean {
  return bcrypt.compareSync(plain, hash)
}
```

and make `verifyCredentials` use it: `return passwordMatches(user.passwordHash, password) ? user : null`.

Change `loadSession` signature and add the version check right after `if (!user) return null`:

```ts
export async function loadSession(userId: string, tokenVersion?: number): Promise<Session | null> {
  // ...existing findFirst...
  if (!user) return null
  // A password change, admin reset or deactivation bumps sessionVersion:
  // tokens minted before it no longer resume a session.
  if (tokenVersion !== undefined && tokenVersion !== user.sessionVersion) return null
```

and add `mustChangePassword: user.mustChangePassword,` to the returned object.

Above `authenticate` add:

```ts
/** The only API calls allowed while an Admin-issued password is still in use. */
const PASSWORD_CHANGE_PATHS = new Set(['/api/auth/me', '/api/auth/logout', '/api/auth/change-password'])
```

In `authenticate`, replace the `loadSession` call and add the gate:

```ts
    const version = typeof payload.v === 'number' ? payload.v : 0
    const session = await loadSession(String(payload.sub), version)
    if (!session) throw ApiError.unauthorized('Your session has ended. Sign in again.')
    if (session.mustChangePassword && !PASSWORD_CHANGE_PATHS.has(req.originalUrl.split('?')[0])) {
      throw new ApiError(403, 'password_change_required', 'Set a new password to continue.')
    }
```

- [ ] **Step 4: `backend/src/modules/messages/realtime.ts:55`** — replace
`const session = await loadSession(String(payload.sub))` with
`const session = await loadSession(String(payload.sub), typeof payload.v === 'number' ? payload.v : 0)`.

- [ ] **Step 5: Implement `backend/src/modules/auth.routes.ts` changes**

Imports: add `hashPassword, passwordMatches` to the `../platform/auth.js` import and `import { passwordProblem } from '../platform/password.js'`. Update the header comment to list `POST /api/auth/change-password`.

In `sessionPayload`'s returned object add `must_change_password: user.mustChangePassword,` after `user: {...}`.

In `/login`, change `signToken(user.id)` to `signToken(user.id, user.sessionVersion)`.

Append:

```ts
const changeSchema = z.object({
  current_password: z.string().min(1, 'Enter your current password.'),
  new_password: z.string().min(1, 'Enter a new password.'),
})

// POST /api/auth/change-password — every user, including the forced first change.
authRouter.post('/change-password', authenticate, handler(async (req, res) => {
  const session = requireSession(req)
  if (!rateLimit(`pwchange:${session.userId}`, 10, 60_000)) throw ApiError.tooMany()
  const parsed = changeSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    throw ApiError.badRequest('Enter your current and new password.', parsed.error.flatten().fieldErrors)
  }
  const { current_password: current, new_password: next } = parsed.data
  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } })
  if (!passwordMatches(user.passwordHash, current)) {
    const m = 'Your current password is incorrect.'
    throw ApiError.badRequest(m, { current_password: [m] })
  }
  const problem = passwordProblem(next)
  if (problem) throw ApiError.badRequest(problem, { new_password: [problem] })
  if (next === current) {
    const m = 'Choose a password different from your current one.'
    throw ApiError.badRequest(m, { new_password: [m] })
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: hashPassword(next), mustChangePassword: false,
      sessionVersion: { increment: 1 }, updatedBy: user.id,
    },
  })
  // This browser stays signed in; every other session ends with the old version.
  const [name, value, options] = sessionCookie(signToken(updated.id, updated.sessionVersion))
  res.cookie(name, value, options)
  await writeAudit({
    actorUserId: user.id, action: 'auth.password_changed', entityType: 'User', entityId: user.id, req,
  })
  ok(res, await sessionPayload(user.id))
}))
```

- [ ] **Step 6: Run the new test and the whole suite — expect PASS**

Run: `cd backend && npx vitest run` and `npx tsc -p tsconfig.json --noEmit`

- [ ] **Step 7: Commit**

```bash
git add backend/src/platform/auth.ts backend/src/modules/auth.routes.ts backend/src/modules/messages/realtime.ts backend/src/modules/__tests__/auth-password.test.ts
git commit -m "Session versioning, forced password change and change-password endpoint"
```

---

### Task 3: Users API + hide Super Admin in user labels

**Files:**
- Create: `backend/src/modules/users.routes.ts`
- Create: `backend/src/platform/userLabel.ts`
- Modify: `backend/src/app.ts` (mount `/api/users` next to `/api/employees`)
- Modify: `backend/src/modules/platform.routes.ts:289-292`, `backend/src/modules/documents.routes.ts:90-95`, `backend/src/modules/bookkeeping/services/BookkeepingAuditService.ts:39-43,132-134`, `backend/src/modules/audit-automation/services/TdsReconJobService.ts:470-471`
- Test: `backend/src/modules/__tests__/users.test.ts`

**Interfaces:**
- Consumes: `passwordProblem` (Task 1); `hashPassword`, `requireSession`, `Session` (Task 2); `VISIBLE_ROLES`, `VISIBLE_ROLE_CODES`.
- Produces: REST endpoints below; `userLabel(u)`, `USER_LABEL_SELECT`. User JSON shape (`UserRow`):
  `{ id, email, full_name: string | null, role: { id, code, name }, is_active, last_login_at: string | null, employee_id: string | null, must_change_password }`.

Endpoints (all behind global `authenticate`; caller must be `md` or `hr_admin`, else 403):
- `GET /api/users` → `{ items: UserRow[], employees_without_login: { id, full_name, email }[] }`
- `GET /api/users/roles` → `{ items: { id, code, name }[] }`
- `POST /api/users` `{ first_name, last_name, email, phone?, joining_date?, role_id, temp_password }` → 201 `{ user }`
- `POST /api/users/from-employee/:employeeId` `{ role_id, temp_password }` → 201 `{ user }`
- `PATCH /api/users/:id` `{ role_id?, is_active? }` → `{ user }`
- `POST /api/users/:id/reset-password` `{ temp_password }` → `{ user }`

- [ ] **Step 1: Write the failing test** — `backend/src/modules/__tests__/users.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../app.js'
import { hashPassword, signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'

let server: Server
let base = ''
let orgId = ''
const roleId: Record<string, string> = {}

async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function login(code: 'md' | 'hr_admin' | 'employee') {
  const u = await prisma.user.create({
    data: { id: uid('u'), organisationId: orgId, email: `${uid(code)}@x.local`, passwordHash: hashPassword('Pass1234'), roleId: roleId[code] },
  })
  return { ...u, cookie: `ao_access=${signToken(u.id)}` }
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  await prisma.workSchedule.create({
    data: { id: uid('ws'), organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' },
  })
  for (const [code, name] of [['md', 'Super Admin'], ['hr_admin', 'Admin'], ['employee', 'Associate']] as const) {
    roleId[code] = (await prisma.role.upsert({ where: { code }, update: {}, create: { id: `role-${code}`, code, name } })).id
  }
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('/api/users access', () => {
  it('is closed to non-admins', async () => {
    const emp = await login('employee')
    expect((await api('/api/users', { cookie: emp.cookie })).status).toBe(403)
  })
})

describe('create + reset', () => {
  it('creates an employee and a login that must change its password', async () => {
    const admin = await login('hr_admin')
    const email = `${uid('new')}@x.local`
    const r = await api('/api/users', {
      method: 'POST', cookie: admin.cookie,
      body: { first_name: 'Asha', last_name: 'K', email, role_id: roleId.employee, temp_password: 'Temp1234' },
    })
    expect(r.status).toBe(201)
    expect(r.body.data.user.must_change_password).toBe(true)
    expect(r.body.data.user.employee_id).toBeTruthy()
    const dup = await api('/api/users', {
      method: 'POST', cookie: admin.cookie,
      body: { first_name: 'A', last_name: 'B', email, role_id: roleId.employee, temp_password: 'Temp1234' },
    })
    expect(dup.status).toBe(409)
  })

  it('rejects a weak temporary password', async () => {
    const admin = await login('hr_admin')
    const r = await api('/api/users', {
      method: 'POST', cookie: admin.cookie,
      body: { first_name: 'A', last_name: 'B', email: `${uid('w')}@x.local`, role_id: roleId.employee, temp_password: 'abc' },
    })
    expect(r.status).toBe(400)
  })

  it('admin reset sets the flag and ends the target’s sessions', async () => {
    const admin = await login('hr_admin')
    const target = await login('employee')
    expect((await api('/api/auth/me', { cookie: target.cookie })).status).toBe(200)
    const r = await api(`/api/users/${target.id}/reset-password`, {
      method: 'POST', cookie: admin.cookie, body: { temp_password: 'Reset1234' },
    })
    expect(r.status).toBe(200)
    expect(r.body.data.user.must_change_password).toBe(true)
    expect((await api('/api/auth/me', { cookie: target.cookie })).status).toBe(401)
  })
})

describe('Super Admin is invisible to Admin', () => {
  it('is not listed, not editable, not resettable, and not assignable', async () => {
    const admin = await login('hr_admin')
    const owner = await login('md')
    const list = await api('/api/users', { cookie: admin.cookie })
    expect(list.body.data.items.some((u: { id: string }) => u.id === owner.id)).toBe(false)
    expect((await api(`/api/users/${owner.id}`, { method: 'PATCH', cookie: admin.cookie, body: { is_active: false } })).status).toBe(404)
    expect((await api(`/api/users/${owner.id}/reset-password`, { method: 'POST', cookie: admin.cookie, body: { temp_password: 'Reset1234' } })).status).toBe(404)
    const roles = await api('/api/users/roles', { cookie: admin.cookie })
    expect(roles.body.data.items.some((r: { code: string }) => r.code === 'md')).toBe(false)
    const target = await login('employee')
    expect((await api(`/api/users/${target.id}`, { method: 'PATCH', cookie: admin.cookie, body: { role_id: roleId.md } })).status).toBe(400)
  })

  it('is visible to Super Admin', async () => {
    const owner = await login('md')
    const list = await api('/api/users', { cookie: owner.cookie })
    expect(list.body.data.items.some((u: { id: string }) => u.id === owner.id)).toBe(true)
  })
})

describe('self-protection', () => {
  it('cannot change own role, deactivate self or admin-reset self', async () => {
    const admin = await login('hr_admin')
    expect((await api(`/api/users/${admin.id}`, { method: 'PATCH', cookie: admin.cookie, body: { is_active: false } })).status).toBe(409)
    expect((await api(`/api/users/${admin.id}`, { method: 'PATCH', cookie: admin.cookie, body: { role_id: roleId.employee } })).status).toBe(409)
    expect((await api(`/api/users/${admin.id}/reset-password`, { method: 'POST', cookie: admin.cookie, body: { temp_password: 'Reset1234' } })).status).toBe(409)
  })

  it('deactivation ends the target’s sessions', async () => {
    const admin = await login('hr_admin')
    const target = await login('employee')
    const r = await api(`/api/users/${target.id}`, { method: 'PATCH', cookie: admin.cookie, body: { is_active: false } })
    expect(r.status).toBe(200)
    expect((await api('/api/auth/me', { cookie: target.cookie })).status).toBe(401)
  })
})
```

- [ ] **Step 2: Run — expect FAIL (404s)**

Run: `cd backend && npx vitest run src/modules/__tests__/users.test.ts`

- [ ] **Step 3: Implement `backend/src/platform/userLabel.ts`**

```ts
/**
 * How a user is named to other people. The Super Admin (DigitalVetri) is a
 * system account: it is never shown by email or name, only as "System
 * administrator". Every endpoint that labels a user selects USER_LABEL_SELECT
 * and calls userLabel(), so this rule lives in one place.
 */
export const USER_LABEL_SELECT = {
  id: true,
  email: true,
  role: { select: { code: true } },
  employee: { select: { fullName: true } },
} as const

export function userLabel(u: { email: string; role: { code: string }; employee: { fullName: string } | null }): string {
  if (u.role.code === 'md') return 'System administrator'
  return u.employee?.fullName ?? u.email
}
```

- [ ] **Step 4: Implement `backend/src/modules/users.routes.ts`**

```ts
import { Router, type Request } from 'express'
import type { Employee, Role, User } from '@prisma/client'
import { z } from 'zod'
import { istToday } from '../lib/dates.js'
import { ApiError, handler, ok } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { rateLimit } from '../lib/rateLimit.js'
import { hashPassword, requireSession, type Session } from '../platform/auth.js'
import { writeAudit } from '../platform/audit.js'
import { passwordProblem } from '../platform/password.js'
import { VISIBLE_ROLES, VISIBLE_ROLE_CODES } from '../platform/rbac/modules.js'
import type { RoleCode } from '../platform/rbac/matrix.js'

/**
 * USERS — logins, managed by Admin and Super Admin (Settings → Users).
 *   GET   /api/users                          users + employees without a login
 *   GET   /api/users/roles                    roles the caller may assign
 *   POST  /api/users                          new employee + login
 *   POST  /api/users/from-employee/:id        login for an existing employee
 *   PATCH /api/users/:id                      role / active
 *   POST  /api/users/:id/reset-password       temporary password
 *
 * The Super Admin is invisible to everyone else: never listed, a 404 as a
 * target, and its role is never offered.
 */
export const usersRouter = Router()

const SUPER_ADMIN: RoleCode = 'md'
const ADMIN_ROLES: RoleCode[] = ['md', 'hr_admin']

function requireAdmin(req: Request): Session {
  const s = requireSession(req)
  if (!ADMIN_ROLES.includes(s.roleCode)) throw ApiError.forbidden('Only Admin or Super Admin can manage users.')
  return s
}

const isSuper = (s: Session) => s.roleCode === SUPER_ADMIN

type UserWithRole = User & { role: Role; employee: Employee | null }

function userToApi(u: UserWithRole) {
  return {
    id: u.id,
    email: u.email,
    full_name: u.employee?.fullName ?? null,
    role: { id: u.role.id, code: u.role.code, name: u.role.name },
    is_active: u.isActive,
    last_login_at: u.lastLoginAt?.toISOString() ?? null,
    employee_id: u.employeeId,
    must_change_password: u.mustChangePassword,
  }
}

function checkTempPassword(pw: string) {
  const p = passwordProblem(pw)
  if (p) throw ApiError.badRequest(p, { temp_password: [p] })
}

async function assignableRole(s: Session, roleId: string): Promise<Role> {
  const role = await prisma.role.findUnique({ where: { id: roleId } })
  const allowed = role && !role.deletedAt && VISIBLE_ROLE_CODES.includes(role.code as RoleCode)
    && (role.code !== SUPER_ADMIN || isSuper(s))
  if (!allowed) throw ApiError.badRequest('Choose a valid role.', { role_id: ['Choose a valid role.'] })
  return role
}

async function visibleTarget(s: Session, id: string): Promise<UserWithRole> {
  const u = await prisma.user.findFirst({ where: { id, deletedAt: null }, include: { role: true, employee: true } })
  if (!u || (u.role.code === SUPER_ADMIN && !isSuper(s))) throw ApiError.notFound('User not found.')
  return u
}

async function assertEmailFree(email: string, exceptEmployeeId?: string) {
  const [user, employee] = await Promise.all([
    prisma.user.findFirst({ where: { email } }),
    prisma.employee.findFirst({ where: { email, ...(exceptEmployeeId ? { id: { not: exceptEmployeeId } } : {}) } }),
  ])
  if (user || employee) throw ApiError.conflict('email_taken', 'A user with this email already exists.')
}

async function nextEmployeeCode(): Promise<string> {
  let n = (await prisma.employee.count()) + 1
  for (;;) {
    const code = `AO-${String(n).padStart(4, '0')}`
    if (!(await prisma.employee.findUnique({ where: { employeeCode: code } }))) return code
    n += 1
  }
}

usersRouter.get('/', handler(async (req, res) => {
  const s = requireAdmin(req)
  const users = await prisma.user.findMany({
    where: { deletedAt: null, ...(isSuper(s) ? {} : { role: { code: { not: SUPER_ADMIN } } }) },
    include: { role: true, employee: true },
    orderBy: { createdAt: 'asc' },
  })
  const withoutLogin = await prisma.employee.findMany({
    where: { deletedAt: null, status: { not: 'inactive' }, user: { is: null } },
    orderBy: { fullName: 'asc' },
    select: { id: true, fullName: true, email: true },
  })
  ok(res, {
    items: users.map(userToApi),
    employees_without_login: withoutLogin.map((e) => ({ id: e.id, full_name: e.fullName, email: e.email })),
  })
}))

usersRouter.get('/roles', handler(async (req, res) => {
  const s = requireAdmin(req)
  const codes = VISIBLE_ROLES.map((r) => r.code).filter((c) => c !== SUPER_ADMIN || isSuper(s))
  const rows = await prisma.role.findMany({ where: { code: { in: codes }, deletedAt: null } })
  const order = new Map(codes.map((c, i) => [c, i]))
  rows.sort((a, b) => (order.get(a.code as RoleCode) ?? 0) - (order.get(b.code as RoleCode) ?? 0))
  ok(res, { items: rows.map((r) => ({ id: r.id, code: r.code, name: r.name })) })
}))

const createSchema = z.object({
  first_name: z.string().trim().min(1, 'Enter a first name.'),
  last_name: z.string().trim().min(1, 'Enter a last name.'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  phone: z.string().trim().optional(),
  joining_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').optional(),
  role_id: z.string().min(1, 'Choose a role.'),
  temp_password: z.string(),
})

usersRouter.post('/', handler(async (req, res) => {
  const s = requireAdmin(req)
  const parsed = createSchema.safeParse(req.body ?? {})
  if (!parsed.success) throw ApiError.badRequest('Check the highlighted fields.', parsed.error.flatten().fieldErrors)
  const b = parsed.data
  checkTempPassword(b.temp_password)
  const role = await assignableRole(s, b.role_id)
  await assertEmailFree(b.email)

  const org = await prisma.organisation.findFirstOrThrow({ where: { deletedAt: null } })
  const schedule = await prisma.workSchedule.findFirst({ where: { deletedAt: null } })
  if (!schedule) throw ApiError.unprocessable('no_work_schedule', 'Set up a work schedule before adding users.')
  const employeeCode = await nextEmployeeCode()

  const user = await prisma.$transaction(async (tx) => {
    const employee = await tx.employee.create({
      data: {
        organisationId: org.id, employeeCode,
        firstName: b.first_name, lastName: b.last_name, fullName: `${b.first_name} ${b.last_name}`,
        status: 'active', workScheduleId: schedule.id, email: b.email, phone: b.phone ?? '',
        joiningDate: b.joining_date ?? istToday(), weeklyCapacityHours: 40,
        createdBy: s.userId, updatedBy: s.userId,
      },
    })
    return tx.user.create({
      data: {
        organisationId: org.id, email: b.email, passwordHash: hashPassword(b.temp_password),
        roleId: role.id, employeeId: employee.id, mustChangePassword: true,
        createdBy: s.userId, updatedBy: s.userId,
      },
      include: { role: true, employee: true },
    })
  })
  await writeAudit({
    actorUserId: s.userId, action: 'user.created', entityType: 'User', entityId: user.id,
    after: { email: user.email, role: role.code, employee_id: user.employeeId }, req,
  })
  ok(res, { user: userToApi(user) }, 201)
}))

const loginSchema = z.object({ role_id: z.string().min(1, 'Choose a role.'), temp_password: z.string() })

usersRouter.post('/from-employee/:employeeId', handler(async (req, res) => {
  const s = requireAdmin(req)
  const parsed = loginSchema.safeParse(req.body ?? {})
  if (!parsed.success) throw ApiError.badRequest('Check the highlighted fields.', parsed.error.flatten().fieldErrors)
  checkTempPassword(parsed.data.temp_password)
  const role = await assignableRole(s, parsed.data.role_id)
  const employee = await prisma.employee.findFirst({
    where: { id: req.params.employeeId, deletedAt: null }, include: { user: true },
  })
  if (!employee) throw ApiError.notFound('Employee not found.')
  if (employee.user) throw ApiError.conflict('has_login', 'This employee already has a login.')
  const email = employee.email.trim().toLowerCase()
  await assertEmailFree(email, employee.id)

  const user = await prisma.user.create({
    data: {
      organisationId: employee.organisationId, email, passwordHash: hashPassword(parsed.data.temp_password),
      roleId: role.id, employeeId: employee.id, mustChangePassword: true,
      createdBy: s.userId, updatedBy: s.userId,
    },
    include: { role: true, employee: true },
  })
  await writeAudit({
    actorUserId: s.userId, action: 'user.created', entityType: 'User', entityId: user.id,
    after: { email, role: role.code, employee_id: employee.id }, req,
  })
  ok(res, { user: userToApi(user) }, 201)
}))

const patchSchema = z.object({ role_id: z.string().min(1).optional(), is_active: z.boolean().optional() })

usersRouter.patch('/:id', handler(async (req, res) => {
  const s = requireAdmin(req)
  const parsed = patchSchema.safeParse(req.body ?? {})
  if (!parsed.success) throw ApiError.badRequest('Check the highlighted fields.', parsed.error.flatten().fieldErrors)
  const target = await visibleTarget(s, req.params.id)
  if (target.id === s.userId) {
    throw ApiError.conflict('self', 'You cannot change your own role or deactivate yourself.')
  }

  const data: { roleId?: string; isActive?: boolean; sessionVersion?: { increment: number }; updatedBy: string } = { updatedBy: s.userId }
  let newRole: Role | null = null
  if (parsed.data.role_id && parsed.data.role_id !== target.roleId) {
    newRole = await assignableRole(s, parsed.data.role_id)
    data.roleId = newRole.id
  }
  if (parsed.data.is_active !== undefined && parsed.data.is_active !== target.isActive) {
    data.isActive = parsed.data.is_active
    // Deactivating ends every open session at once.
    if (!parsed.data.is_active) data.sessionVersion = { increment: 1 }
  }

  const user = await prisma.user.update({ where: { id: target.id }, data, include: { role: true, employee: true } })
  if (newRole) {
    await writeAudit({
      actorUserId: s.userId, action: 'user.role_changed', entityType: 'User', entityId: user.id,
      before: { role: target.role.code }, after: { role: newRole.code }, req,
    })
  }
  if (data.isActive !== undefined) {
    await writeAudit({
      actorUserId: s.userId, action: data.isActive ? 'user.activated' : 'user.deactivated',
      entityType: 'User', entityId: user.id, req,
    })
  }
  ok(res, { user: userToApi(user) })
}))

const resetSchema = z.object({ temp_password: z.string() })

usersRouter.post('/:id/reset-password', handler(async (req, res) => {
  const s = requireAdmin(req)
  if (!rateLimit(`pwreset:${s.userId}`, 10, 60_000)) throw ApiError.tooMany()
  const parsed = resetSchema.safeParse(req.body ?? {})
  if (!parsed.success) throw ApiError.badRequest('Enter a temporary password.', parsed.error.flatten().fieldErrors)
  checkTempPassword(parsed.data.temp_password)
  const target = await visibleTarget(s, req.params.id)
  if (target.id === s.userId) {
    throw ApiError.conflict('self_reset', 'Use Change password to change your own password.')
  }
  const user = await prisma.user.update({
    where: { id: target.id },
    data: {
      passwordHash: hashPassword(parsed.data.temp_password), mustChangePassword: true,
      sessionVersion: { increment: 1 }, updatedBy: s.userId,
    },
    include: { role: true, employee: true },
  })
  await writeAudit({
    actorUserId: s.userId, action: 'user.password_reset', entityType: 'User', entityId: user.id, req,
  })
  ok(res, { user: userToApi(user) })
}))
```

- [ ] **Step 5: Mount it** — in `backend/src/app.ts` add `import { usersRouter } from './modules/users.routes.js'` beside the other module imports and `app.use('/api/users', usersRouter)` directly after `app.use('/api/employees', employeesRouter)`.

- [ ] **Step 6: Apply `userLabel` at the five labelling sites**

`backend/src/modules/platform.routes.ts` (dashboard activity), replace the `actors` query + `label` map with:

```ts
  const actors = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: USER_LABEL_SELECT })
  const label = new Map(actors.map((a) => [a.id, userLabel(a)]))
```

`backend/src/modules/documents.routes.ts` (uploaders):

```ts
  const uploaders = await prisma.user.findMany({ where: { id: { in: uploaderIds } }, select: USER_LABEL_SELECT })
  const uploaderLabel = new Map(uploaders.map((u) => [u.id, userLabel(u)]))
```

`backend/src/modules/bookkeeping/services/BookkeepingAuditService.ts` — both actor lookups: change `select: { id: true, email: true }` to `select: USER_LABEL_SELECT` and the maps to `new Map(actors.map((a) => [a.id, userLabel(a)]))`.

`backend/src/modules/audit-automation/services/TdsReconJobService.ts:470-471`:

```ts
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(f.events.map((e) => e.userId))] } }, select: USER_LABEL_SELECT })
    const who = new Map(users.map((u) => [u.id, userLabel(u)]))
```

Each file imports `import { USER_LABEL_SELECT, userLabel } from '<relative>/platform/userLabel.js'`.

- [ ] **Step 7: Run tests + typecheck — expect PASS**

Run: `cd backend && npx vitest run && npx tsc -p tsconfig.json --noEmit`

- [ ] **Step 8: Commit**

```bash
git add backend/src/modules/users.routes.ts backend/src/platform/userLabel.ts backend/src/app.ts backend/src/modules/platform.routes.ts backend/src/modules/documents.routes.ts backend/src/modules/bookkeeping/services/BookkeepingAuditService.ts backend/src/modules/audit-automation/services/TdsReconJobService.ts backend/src/modules/__tests__/users.test.ts
git commit -m "Users API for Admin/Super Admin; hide Super Admin in user labels"
```

---

### Task 4: Clean seed + owner accounts setup

**Files:**
- Modify: `backend/prisma/seed.ts` (delete demo sections), `backend/prisma/seed-workstation.ts` (keep service catalog + document categories only)
- Create: `backend/prisma/setup-owners.ts`, `backend/prisma/owners.ts`
- Modify: `backend/package.json` (script `setup:owners`), `backend/.env.example`, `backend/Dockerfile:45` (run owners after seed), `README.md` + `docker/README.md` (remove demo logins, document owners)
- Test: `backend/src/modules/__tests__/owners.test.ts`

**Interfaces:**
- Produces: `ensureOwners(prisma: PrismaClient, owners: OwnerSpec[], opts: { resetPasswords: boolean }): Promise<{ email: string; action: 'created' | 'updated' | 'unchanged' }[]>` with `OwnerSpec = { email: string; password: string; roleCode: 'md' | 'hr_admin' }`.

- [ ] **Step 1: Write the failing test** — `backend/src/modules/__tests__/owners.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureOwners } from '../../../prisma/owners.js'
import { passwordMatches } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'

const email = `${uid('owner')}@x.local`

beforeAll(async () => {
  await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
  await prisma.role.upsert({ where: { code: 'md' }, update: {}, create: { id: 'role-md', code: 'md', name: 'Super Admin' } })
})
afterAll(async () => { await prisma.$disconnect() })

describe('ensureOwners', () => {
  it('creates once, then leaves the password alone unless asked', async () => {
    const spec = [{ email, password: 'First1234', roleCode: 'md' as const }]
    expect((await ensureOwners(prisma, spec, { resetPasswords: false }))[0].action).toBe('created')
    const again = await ensureOwners(prisma, [{ ...spec[0], password: 'Other1234' }], { resetPasswords: false })
    expect(again[0].action).toBe('unchanged')
    let u = await prisma.user.findUniqueOrThrow({ where: { email } })
    expect(passwordMatches(u.passwordHash, 'First1234')).toBe(true)
    expect(u.employeeId).toBeNull()
    expect(u.mustChangePassword).toBe(false)

    await ensureOwners(prisma, [{ ...spec[0], password: 'Other1234' }], { resetPasswords: true })
    u = await prisma.user.findUniqueOrThrow({ where: { email } })
    expect(passwordMatches(u.passwordHash, 'Other1234')).toBe(true)
  })

  it('refuses a weak owner password', async () => {
    await expect(ensureOwners(prisma, [{ email: `${uid('o')}@x.local`, password: 'weak', roleCode: 'md' }], { resetPasswords: false }))
      .rejects.toThrow(/at least 8/)
  })
})
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

- [ ] **Step 3: Implement `backend/prisma/owners.ts`**

```ts
import type { PrismaClient } from '@prisma/client'
import { hashPassword } from '../src/platform/auth.js'
import { passwordProblem } from '../src/platform/password.js'

export interface OwnerSpec { email: string; password: string; roleCode: 'md' | 'hr_admin' }

/**
 * The firm's two owner logins (Super Admin, Admin). Login-only — no Employee
 * record, so they never appear in attendance, leave or payroll. Idempotent:
 * an existing owner keeps its password unless resetPasswords is set.
 */
export async function ensureOwners(prisma: PrismaClient, owners: OwnerSpec[], opts: { resetPasswords: boolean }) {
  const org = await prisma.organisation.findFirstOrThrow({ where: { deletedAt: null } })
  const results: { email: string; action: 'created' | 'updated' | 'unchanged' }[] = []
  for (const o of owners) {
    const email = o.email.trim().toLowerCase()
    const problem = passwordProblem(o.password)
    if (problem) throw new Error(`${email}: ${problem}`)
    const role = await prisma.role.findUniqueOrThrow({ where: { code: o.roleCode } })
    const existing = await prisma.user.findUnique({ where: { email } })
    if (!existing) {
      await prisma.user.create({
        data: { organisationId: org.id, email, passwordHash: hashPassword(o.password), roleId: role.id },
      })
      results.push({ email, action: 'created' })
      continue
    }
    const data: Record<string, unknown> = {}
    if (existing.roleId !== role.id) data.roleId = role.id
    if (!existing.isActive || existing.deletedAt) { data.isActive = true; data.deletedAt = null }
    if (opts.resetPasswords) {
      data.passwordHash = hashPassword(o.password)
      data.mustChangePassword = false
      data.sessionVersion = { increment: 1 }
    }
    if (Object.keys(data).length === 0) { results.push({ email, action: 'unchanged' }); continue }
    await prisma.user.update({ where: { id: existing.id }, data })
    results.push({ email, action: 'updated' })
  }
  return results
}
```

- [ ] **Step 4: Implement `backend/prisma/setup-owners.ts`**

```ts
/**
 * npm run setup:owners [-- --reset-passwords]
 *
 * Creates the Super Admin and Admin logins from env (backend/.env locally,
 * docker/.env.docker in Docker). Passwords never live in the repository.
 */
// Loads backend/.env (real env vars win), same loader the server uses.
import '../src/lib/env.js'
import { PrismaClient } from '@prisma/client'
import { ensureOwners, type OwnerSpec } from './owners.js'

const prisma = new PrismaClient()

function owner(prefix: string, roleCode: OwnerSpec['roleCode']): OwnerSpec | null {
  const email = process.env[`${prefix}_EMAIL`]
  const password = process.env[`${prefix}_PASSWORD`]
  if (!email && !password) return null
  if (!email || !password) throw new Error(`Set both ${prefix}_EMAIL and ${prefix}_PASSWORD.`)
  return { email, password, roleCode }
}

async function main() {
  const owners = [owner('OWNER_SUPERADMIN', 'md'), owner('OWNER_ADMIN', 'hr_admin')].filter((o): o is OwnerSpec => !!o)
  if (owners.length === 0) {
    console.log('[setup-owners] No OWNER_* variables set — nothing to do.')
    return
  }
  const results = await ensureOwners(prisma, owners, { resetPasswords: process.argv.includes('--reset-passwords') })
  for (const r of results) console.log(`[setup-owners] ${r.email}: ${r.action}`)
}

main()
  .catch((e) => { console.error('[setup-owners]', e instanceof Error ? e.message : e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
```

`backend/package.json` scripts: `"setup:owners": "tsx prisma/setup-owners.ts"`.

`backend/.env.example` — append:

```
## Owner logins, created by `npm run setup:owners` (never commit real values).
## Super Admin is hidden from every other user; Admin manages users in-app.
OWNER_SUPERADMIN_EMAIL=
OWNER_SUPERADMIN_PASSWORD=
OWNER_ADMIN_EMAIL=
OWNER_ADMIN_PASSWORD=
```

`backend/Dockerfile:45` — append `&& npx tsx prisma/setup-owners.ts` to the toolchain CMD.

- [ ] **Step 5: Strip demo data from `backend/prisma/seed.ts`**

Keep: organisation, permissions + `setupRoles` + legacy role grants, work schedule, leave types, holidays, statutory rates, E-Invoice/EWB config rows, expense categories, `backfillPeriods()`, `seedTools`, `seedAuditAutomation`, `seedRegistration`, `seedPartnership`, `migrateGstReturnCases`, `seedGst`.

Delete these sections (by their `// ──` headers): "Employees + logins" (employees, demo users, articled training), leave **balances** and the two pending leave requests (keep the leave-type and holiday loops of that section), "Documents", "Attendance", "Salary structures", "Payroll", "Expenses across every stage", "Messages". Delete helper functions that become unused (`mulberry32`, `istInstant`, `isWorkingDay`, `lastDayOfMonth`, `seedPayrollJournal`) — `npx tsc --noEmit` / eslint `no-unused-vars` will list them. Replace the closing log block with:

```ts
  console.log('Seed complete (reference data only):', {
    roles: await prisma.role.count(),
    leaveTypes: await prisma.leaveType.count(),
    services: await prisma.service.count(),
  })
  console.log('Workstation:', workstation)
  console.log('GST periods:', gstPeriods)
  console.log('Registration:', registration)
  console.log('GST return cases:', returnCases)
  console.log('GST reference:', gst)
  console.log('Next: npm run setup:owners')
```

In `backend/prisma/seed-workstation.ts` keep only the "Service catalog" and "Document categories" blocks; delete Clients, Leads, Client services, Follow-ups, GST profiles + filings, E-way bills (both), E-Invoice profile, IRNs, Pull runs, Documents, Activity timelines, and return `{ services, categories }` counts.

Check the other demo-only scripts are not called from `seed.ts` (`seed-documents.ts`, `seed-tasks.ts`, `seed-gst-compliance.ts` stay as opt-in dev scripts; do not delete).

- [ ] **Step 6: Run tests + typecheck — expect PASS**

Run: `cd backend && npx vitest run && npx tsc -p tsconfig.json --noEmit`

- [ ] **Step 7: Smoke-run the seed against a scratch DB**

```bash
createdb auditos_seedcheck 2>/dev/null
cd backend && DATABASE_URL='postgresql://selva@localhost:5432/auditos_seedcheck?schema=public' sh -c 'npx prisma db push --force-reset --accept-data-loss --skip-generate >/dev/null && npx tsx prisma/seed.ts && npx tsx prisma/seed.ts && OWNER_SUPERADMIN_EMAIL=a@x.local OWNER_SUPERADMIN_PASSWORD=Check1234 npx tsx prisma/setup-owners.ts'
psql -d auditos_seedcheck -tAc 'select count(*) from "Employee"; select count(*) from "Client"; select email from "User";'
dropdb auditos_seedcheck
```

Expected: seed completes twice (idempotent), 0 employees, 0 clients, one user `a@x.local`.

- [ ] **Step 8: Update docs** — in `README.md` and `docker/README.md` replace every demo-login table/line (`*@auditos.local`) with: "There are no demo accounts. Set `OWNER_*` in `backend/.env` (or `docker/.env.docker`) and run `npm run setup:owners`; the Admin creates everyone else in Settings → Users."

- [ ] **Step 9: Commit**

```bash
git add backend/prisma backend/package.json backend/.env.example backend/Dockerfile README.md docker/README.md backend/src/modules/__tests__/owners.test.ts
git commit -m "Seed reference data only; owner logins from env via setup:owners"
```

---

### Task 5: Frontend — remove mock mode and demo logins; Forgot-password hint

**Files:**
- Delete: `frontend/src/data/mock/`, `frontend/src/data/seed/`, `frontend/public/mockServiceWorker.js`
- Modify: `frontend/src/main.tsx`, `frontend/src/vite-env.d.ts`, `frontend/src/platform/realtime/RealtimeProvider.tsx:23,77`, `frontend/src/platform/pwa/PwaProvider.tsx:33,56`, `frontend/vite.config.ts:28`, `frontend/.env.example`, `frontend/.env`, `frontend/package.json` (remove `msw` dep + `"msw"` block), `frontend/src/modules/employees/api.ts:9-11`, `frontend/src/services/api.ts` (network error text), `frontend/src/pages/Login.tsx`

- [ ] **Step 1: Move `FinanceProjection` into the employees API** — in `frontend/src/modules/employees/api.ts` replace the import on line 9 with the interface itself:

```ts
/** The reduced employee row a finance-only viewer receives. */
export interface FinanceProjection {
  id: string;
  employee_code: string;
  full_name: string;
  department_id: string | null;
  designation_id: string | null;
  bank_account_masked: string | null;
  status: Employee['status'];
}
```

- [ ] **Step 2: Remove MSW boot** — `frontend/src/main.tsx`: delete the `MOCK_MODE` const and the `if (MOCK_MODE) {...}` block; `boot()` keeps `installDocumentPrint(); installPhoneTables(); createRoot(...)`. Make `boot` a plain (non-async) function.

- [ ] **Step 3: Remove the remaining flags** — delete `MOCK_MODE` consts and their guards in `RealtimeProvider.tsx` (`if (MOCK_MODE) return;` line removed) and `PwaProvider.tsx` (condition becomes `if (!('serviceWorker' in navigator)) return;`); `vite.config.ts:28` → `devOptions: { enabled: true, type: 'module', navigateFallback: 'index.html' }`; remove `VITE_MOCK_MODE` from `vite-env.d.ts`; remove `VITE_MOCK_MODE` / `VITE_SHOW_DEMO_LOGINS` and their comments from `.env.example` and `.env`. In `services/api.ts` the network error becomes `` `Could not reach the API (${path}). Is the backend running?` ``.

- [ ] **Step 4: Delete mock data + dependency**

```bash
cd frontend && git rm -r -q src/data/mock src/data/seed public/mockServiceWorker.js && npm uninstall msw
```

Remove the `"msw": { ... }` block from `package.json` if `npm uninstall` left it.

- [ ] **Step 5: Login page** — `frontend/src/pages/Login.tsx`: delete the `demoCredentials` import, `MOCK_MODE`, `SHOW_DEMO_LOGINS`, the `{SHOW_DEMO_LOGINS ? ... : null}` block and the `DemoCredentials` component. Add state `const [forgotOpen, setForgotOpen] = useState(false);`, make the "Forgot password?" link `onClick={(e) => { e.preventDefault(); setForgotOpen((v) => !v); }}` with `aria-expanded={forgotOpen}`, and render directly under that row:

```tsx
            {forgotOpen ? (
              <div role="note" className="text-13 text-neutral-700 bg-[#f5f1ff] border border-[#e4dcff] rounded-[10px] px-3 py-2">
                Ask your Admin to reset your password. You’ll sign in with the temporary password they give you and then choose a new one.
              </div>
            ) : null}
```

- [ ] **Step 6: Verify** — `cd frontend && grep -rn "data/mock\|data/seed\|MOCK_MODE\|msw" src vite.config.ts` → no output; `npx tsc -b && npm run build` → success.

- [ ] **Step 7: Commit**

```bash
git add -A frontend
git commit -m "Remove mock mode and demo logins; forgot-password hint on sign-in"
```

---

### Task 6: Frontend — forced set-password screen + Change password

**Files:**
- Modify: `frontend/src/platform/auth/AuthContext.tsx` (session field + `changePassword`)
- Modify: `frontend/src/platform/auth/ProtectedRoute.tsx` (redirect while flag set)
- Create: `frontend/src/platform/auth/password.ts` (client mirror of the rule + generator)
- Create: `frontend/src/pages/SetPassword.tsx`
- Create: `frontend/src/platform/auth/ChangePasswordModal.tsx`
- Modify: `frontend/src/App.tsx` (route `/set-password`), `frontend/src/pages/Login.tsx` (navigate to `/set-password` when flagged), `frontend/src/shell/v2/RightPanel.tsx` (Change password button)

**Interfaces:**
- Consumes: `POST /api/auth/change-password`, `must_change_password` (Task 2).
- Produces: `useAuth().changePassword(current: string, next: string): Promise<void>`; `passwordProblem(pw: string): string | null`; `generatePassword(): string`.

- [ ] **Step 1: `frontend/src/platform/auth/password.ts`**

```ts
/** Mirrors backend/src/platform/password.ts — the server is the control. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 128) return 'Password must be at most 128 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}

// No look-alikes (0/O, 1/l/I): an Admin may read this out to a colleague.
const LETTERS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';

/** 12 characters: 8 letters + 4 digits, shuffled, from crypto randomness. */
export function generatePassword(): string {
  const rand = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  const chars = [
    ...Array.from({ length: 8 }, () => LETTERS[rand(LETTERS.length)]),
    ...Array.from({ length: 4 }, () => DIGITS[rand(DIGITS.length)]),
  ];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
```

- [ ] **Step 2: AuthContext** — add `must_change_password?: boolean;` to `interface Session`; add `changePassword: (current: string, next: string) => Promise<void>;` to `AuthState`; implement:

```ts
  const changePassword = useCallback(async (current: string, next: string) => {
    const s = await api.post<Session>('/api/auth/change-password', {
      current_password: current, new_password: next,
    });
    setSession(s);
  }, [setSession]);
```

and include `changePassword` in the `useMemo` value and deps.

- [ ] **Step 3: ProtectedRoute** — before the final `return`, add:

```tsx
  if (session.must_change_password) {
    return <Navigate to="/set-password" replace />;
  }
```

- [ ] **Step 4: `frontend/src/pages/SetPassword.tsx`**

```tsx
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/platform/auth/AuthContext';
import { passwordProblem } from '@/platform/auth/password';
import { BrandLogo } from '@/components/BrandLogo';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';
import type { ApiError } from '@/services/api';

/**
 * Shown after signing in with a password an Admin issued. The API refuses
 * everything else until this succeeds, so this is the only screen that works.
 */
export function SetPasswordPage() {
  const { session, loading, changePassword, logout } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (loading) return null;
  if (!session) return <Navigate to="/login" replace />;
  if (!session.must_change_password) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(next) ?? (next !== confirm ? 'The two new passwords do not match.' : null);
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    try {
      await changePassword(current, next);
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-canvas p-4">
      <form onSubmit={onSubmit} className="dash-card w-full max-w-[420px] p-6 space-y-4" data-testid="set-password">
        <BrandLogo />
        <div>
          <h1 className="text-[22px] font-extrabold text-ink">Set your new password</h1>
          <p className="text-13 text-inkMuted mt-1">
            You signed in with a temporary password. Choose your own to continue — at least 8 characters, with letters and numbers.
          </p>
        </div>
        <Input label="Temporary password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        <Input label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        <Input label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        {error ? <div className="text-12 text-red border-l-2 border-red pl-2">{error}</div> : null}
        <Button variant="primary" type="submit" disabled={saving} className="w-full">{saving ? 'Saving…' : 'Save and continue'}</Button>
        <button type="button" onClick={async () => { await logout(); navigate('/login', { replace: true }); }} className="w-full text-13 text-inkMuted hover:text-ink">
          Sign out
        </button>
      </form>
    </div>
  );
}
```

(Check `BrandLogo`'s props in `components/BrandLogo.tsx` and pass what the Login page passes.)

- [ ] **Step 5: Route + login redirect** — in `App.tsx` add `import { SetPasswordPage } from '@/pages/SetPassword';` and `<Route path="/set-password" element={<SetPasswordPage />} />` next to `/login`. In `Login.tsx` the `if (session)` redirect becomes `return <Navigate to={session.must_change_password ? '/set-password' : '/'} replace />;` (the post-login `navigate('/')` is then caught by ProtectedRoute).

- [ ] **Step 6: `frontend/src/platform/auth/ChangePasswordModal.tsx`**

```tsx
import { useState, type FormEvent } from 'react';
import { useAuth } from './AuthContext';
import { passwordProblem } from './password';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import type { ApiError } from '@/services/api';

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { changePassword } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(next) ?? (next !== confirm ? 'The two new passwords do not match.' : null);
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    try {
      await changePassword(current, next);
      toast.push('success', 'Password changed. Other devices have been signed out.');
      onClose();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="Change password">
      <form onSubmit={onSubmit} className="dash-card bg-surface w-full max-w-[400px] p-5 space-y-4">
        <h2 className="text-[18px] font-bold text-ink">Change password</h2>
        <Input label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        <Input label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        <Input label="Confirm new password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        <p className="text-12 text-inkMuted">At least 8 characters, with letters and numbers.</p>
        {error ? <div className="text-12 text-red border-l-2 border-red pl-2">{error}</div> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Change password'}</Button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 7: RightPanel entry point** — in `shell/v2/RightPanel.tsx` add `import { useState } from 'react'` (merge with the existing react import), `import { KeyRound } from 'lucide-react'` (merge), `import { ChangePasswordModal } from '@/platform/auth/ChangePasswordModal';`, state `const [changing, setChanging] = useState(false);` (declared before the `if (!open) return null`), and a button above "Log out":

```tsx
          <button
            type="button"
            onClick={() => setChanging(true)}
            className="w-full flex items-center justify-center gap-2 h-10 text-13 font-medium text-ink border border-border rounded-[12px] hover:bg-canvas"
          >
            <KeyRound size={16} strokeWidth={1.75} /> Change password
          </button>
```

and render `{changing ? <ChangePasswordModal onClose={() => setChanging(false)} /> : null}` inside the fragment, after `</aside>`. Note: the panel's `useEffect` closes on route change only; the modal is rendered by the panel, so keep the panel open while it shows (no change needed).

- [ ] **Step 8: Verify** — `cd frontend && npx tsc -b && npm run build` → success.

- [ ] **Step 9: Commit**

```bash
git add frontend/src
git commit -m "Forced set-password screen and Change password"
```

---

### Task 7: Frontend — Settings → Users

**Files:**
- Create: `frontend/src/modules/users/api.ts`
- Create: `frontend/src/modules/settings/UsersSection.tsx`
- Modify: `frontend/src/pages/hrms/Settings.tsx` (section `users`, shown to `md` / `hr_admin` only)

**Interfaces:**
- Consumes: `/api/users*` (Task 3), `generatePassword`, `passwordProblem` (Task 6).

- [ ] **Step 1: `frontend/src/modules/users/api.ts`**

```ts
import { api } from '@/services/api';

export interface UserRow {
  id: string;
  email: string;
  full_name: string | null;
  role: { id: string; code: string; name: string };
  is_active: boolean;
  last_login_at: string | null;
  employee_id: string | null;
  must_change_password: boolean;
}
export interface EmployeeWithoutLogin { id: string; full_name: string; email: string }
export interface RoleOption { id: string; code: string; name: string }

export interface NewUser {
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  joining_date?: string;
  role_id: string;
  temp_password: string;
}

export const usersApi = {
  list: () => api.get<{ items: UserRow[]; employees_without_login: EmployeeWithoutLogin[] }>('/api/users'),
  roles: () => api.get<{ items: RoleOption[] }>('/api/users/roles'),
  create: (body: NewUser) => api.post<{ user: UserRow }>('/api/users', body),
  createFromEmployee: (employeeId: string, body: { role_id: string; temp_password: string }) =>
    api.post<{ user: UserRow }>(`/api/users/from-employee/${employeeId}`, body),
  patch: (id: string, body: { role_id?: string; is_active?: boolean }) =>
    api.patch<{ user: UserRow }>(`/api/users/${id}`, body),
  resetPassword: (id: string, temp_password: string) =>
    api.post<{ user: UserRow }>(`/api/users/${id}/reset-password`, { temp_password }),
};
```

- [ ] **Step 2: `frontend/src/modules/settings/UsersSection.tsx`**

```tsx
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionShell } from './SectionShell';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/platform/auth/AuthContext';
import { generatePassword, passwordProblem } from '@/platform/auth/password';
import { usersApi, type RoleOption, type UserRow } from '@/modules/users/api';

const KEY = ['settings', 'users'];

function fmt(iso: string | null) {
  return iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'Never';
}

/** Temporary password field with a Generate button. */
function TempPassword({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-end gap-2">
      <Input label="Temporary password" value={value} onChange={(e) => onChange(e.target.value)} required autoComplete="off" />
      <Button type="button" variant="ghost" onClick={() => onChange(generatePassword())}>Generate</Button>
    </div>
  );
}

function RoleSelect({ roles, value, onChange }: { roles: RoleOption[]; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="block text-11 uppercase tracking-[0.06em] text-inkFaint mb-1">Role</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} required
        className="h-9 px-3 text-13 bg-white text-neutral-900 border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60">
        <option value="" disabled>Choose…</option>
        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
    </label>
  );
}

/** Shows a just-issued temporary password once, with Copy. */
function IssuedPassword({ email, password, onDone }: { email: string; password: string; onDone: () => void }) {
  const toast = useToast();
  return (
    <div className="dash-card p-4 space-y-2" role="status">
      <div className="text-13 text-ink">Temporary password for <b>{email}</b> — share it privately. They will choose their own at first sign-in.</div>
      <div className="flex items-center gap-2">
        <code className="px-3 py-1.5 rounded-lg bg-canvas text-14 font-mono text-ink select-all">{password}</code>
        <Button type="button" variant="ghost" onClick={async () => {
          try { await navigator.clipboard.writeText(password); toast.push('success', 'Copied.'); } catch { toast.push('error', 'Copy failed — select and copy it manually.'); }
        }}>Copy</Button>
        <Button type="button" variant="ghost" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

export function UsersSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const list = useQuery({ queryKey: KEY, queryFn: usersApi.list });
  const roles = useQuery({ queryKey: [...KEY, 'roles'], queryFn: usersApi.roles });
  const roleOptions = roles.data?.items ?? [];

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', joining_date: '', role_id: '', temp_password: '' });
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);
  const [resetFor, setResetFor] = useState<UserRow | null>(null);
  const [resetPw, setResetPw] = useState('');
  const [loginFor, setLoginFor] = useState<{ id: string; email: string } | null>(null);
  const [loginRole, setLoginRole] = useState('');
  const [loginPw, setLoginPw] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: KEY });
  const fail = (e: Error) => toast.push('error', e.message);
  const checkPw = (pw: string) => { const p = passwordProblem(pw); if (p) { toast.push('error', p); return false; } return true; };

  const create = useMutation({
    mutationFn: () => usersApi.create({
      ...form, phone: form.phone || undefined, joining_date: form.joining_date || undefined,
    }),
    onSuccess: (r) => {
      setIssued({ email: r.user.email, password: form.temp_password });
      setAdding(false);
      setForm({ first_name: '', last_name: '', email: '', phone: '', joining_date: '', role_id: '', temp_password: '' });
      refresh();
    },
    onError: fail,
  });
  const fromEmployee = useMutation({
    mutationFn: () => usersApi.createFromEmployee(loginFor!.id, { role_id: loginRole, temp_password: loginPw }),
    onSuccess: (r) => { setIssued({ email: r.user.email, password: loginPw }); setLoginFor(null); setLoginPw(''); setLoginRole(''); refresh(); },
    onError: fail,
  });
  const reset = useMutation({
    mutationFn: () => usersApi.resetPassword(resetFor!.id, resetPw),
    onSuccess: (r) => { setIssued({ email: r.user.email, password: resetPw }); setResetFor(null); setResetPw(''); refresh(); },
    onError: fail,
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { role_id?: string; is_active?: boolean } }) => usersApi.patch(id, body),
    onSuccess: () => { toast.push('success', 'User updated.'); refresh(); },
    onError: fail,
  });

  const users = list.data?.items ?? [];
  const noLogin = list.data?.employees_without_login ?? [];

  return (
    <SectionShell
      title="Users"
      description="Everyone who can sign in. Add a user to create their employee record and login together; they choose their own password at first sign-in."
      addLabel={adding ? undefined : 'Add user'}
      onAdd={adding ? undefined : () => { setAdding(true); setForm((f) => ({ ...f, temp_password: generatePassword() })); }}
    >
      {issued ? <IssuedPassword email={issued.email} password={issued.password} onDone={() => setIssued(null)} /> : null}

      {adding ? (
        <form
          onSubmit={(e: FormEvent) => { e.preventDefault(); if (checkPw(form.temp_password)) create.mutate(); }}
          className="dash-card p-4 grid grid-cols-1 md:grid-cols-2 gap-3"
          data-testid="add-user-form"
        >
          <Input label="First name" value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} required />
          <Input label="Last name" value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} required />
          <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          <Input label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <Input label="Joining date" type="date" value={form.joining_date} onChange={(e) => setForm({ ...form, joining_date: e.target.value })} />
          <RoleSelect roles={roleOptions} value={form.role_id} onChange={(v) => setForm({ ...form, role_id: v })} />
          <TempPassword value={form.temp_password} onChange={(v) => setForm({ ...form, temp_password: v })} />
          <div className="flex items-end gap-2 md:col-span-2">
            <Button variant="primary" type="submit" disabled={create.isPending}>{create.isPending ? 'Adding…' : 'Add user'}</Button>
            <Button variant="ghost" type="button" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </form>
      ) : null}

      {resetFor ? (
        <form
          onSubmit={(e: FormEvent) => { e.preventDefault(); if (checkPw(resetPw)) reset.mutate(); }}
          className="dash-card p-4 flex items-end gap-3 flex-wrap"
        >
          <div className="text-13 text-ink w-full">Reset password for <b>{resetFor.full_name ?? resetFor.email}</b>. They’ll be signed out everywhere and must choose a new password.</div>
          <TempPassword value={resetPw} onChange={setResetPw} />
          <Button variant="primary" type="submit" disabled={reset.isPending}>Reset password</Button>
          <Button variant="ghost" type="button" onClick={() => setResetFor(null)}>Cancel</Button>
        </form>
      ) : null}

      <div className="bg-white border border-neutral-200 rounded overflow-x-auto">
        <table className="hr-float w-full border-collapse" data-testid="users-table">
          <thead>
            <tr>
              {['Name', 'Email', 'Role', 'Status', 'Last sign-in', 'Actions'].map((c) => (
                <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const self = u.id === session?.user.id;
              return (
                <tr key={u.id} className="border-b border-neutral-200">
                  <td className="px-3 py-2 text-13 text-neutral-900">{u.full_name ?? '—'}{u.must_change_password ? <span className="ml-2 text-11 text-[#b45309]">temporary password</span> : null}</td>
                  <td className="px-3 py-2 text-13 text-neutral-700">{u.email}</td>
                  <td className="px-3 py-2 text-13">
                    {self ? u.role.name : (
                      <select value={u.role.id} onChange={(e) => patch.mutate({ id: u.id, body: { role_id: e.target.value } })}
                        aria-label={`Role for ${u.email}`}
                        className="h-8 px-2 text-13 bg-white border border-neutral-200 rounded-lg">
                        {roleOptions.some((r) => r.id === u.role.id) ? null : <option value={u.role.id}>{u.role.name}</option>}
                        {roleOptions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="px-3 py-2 text-13">{u.is_active ? 'Active' : <span className="text-neutral-500">Inactive</span>}</td>
                  <td className="px-3 py-2 text-13 text-neutral-500">{fmt(u.last_login_at)}</td>
                  <td className="px-3 py-2 text-13">
                    {self ? <span className="text-neutral-400">You</span> : (
                      <div className="flex gap-2">
                        <Button size="sm" variant="ghost" onClick={() => { setResetFor(u); setResetPw(generatePassword()); }}>Reset password</Button>
                        <Button size="sm" variant="ghost" onClick={() => patch.mutate({ id: u.id, body: { is_active: !u.is_active } })}>
                          {u.is_active ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {noLogin.length > 0 ? (
        <div className="dash-card p-4 space-y-2">
          <h3 className="text-13 font-semibold text-ink">Employees without a login</h3>
          {noLogin.map((e) => (
            <div key={e.id} className="flex items-center justify-between gap-2 flex-wrap text-13">
              <span>{e.full_name} <span className="text-neutral-500">· {e.email}</span></span>
              {loginFor?.id === e.id ? (
                <form className="flex items-end gap-2 flex-wrap"
                  onSubmit={(ev: FormEvent) => { ev.preventDefault(); if (checkPw(loginPw)) fromEmployee.mutate(); }}>
                  <RoleSelect roles={roleOptions} value={loginRole} onChange={setLoginRole} />
                  <TempPassword value={loginPw} onChange={setLoginPw} />
                  <Button variant="primary" type="submit" disabled={fromEmployee.isPending}>Create login</Button>
                  <Button variant="ghost" type="button" onClick={() => setLoginFor(null)}>Cancel</Button>
                </form>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => { setLoginFor({ id: e.id, email: e.email }); setLoginPw(generatePassword()); }}>Create login</Button>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </SectionShell>
  );
}
```

(Check `Button`'s `Size` union includes `'sm'` in `components/Button.tsx`; if not, use the default size.)

- [ ] **Step 3: Wire into Settings** — `frontend/src/pages/hrms/Settings.tsx`:
  - import `Users` from `lucide-react` and `UsersSection` from `@/modules/settings/UsersSection`;
  - add `| 'users'` to `Section`;
  - add `{ id: 'users', label: 'Users', group: 'Access', icon: Users }` before the `roles` entry in `SECTIONS`;
  - inside `SettingsPage`, compute `const isAdmin = session?.role.code === 'md' || session?.role.code === 'hr_admin';` and `const sections = SECTIONS.filter((s) => s.id !== 'users' || isAdmin);`, and use `sections` instead of `SECTIONS` in both navs and `groups`;
  - render `{section === 'users' && isAdmin ? <UsersSection /> : null}`.

- [ ] **Step 4: Verify** — `cd frontend && npx tsc -b && npm run build` → success.

- [ ] **Step 5: Commit**

```bash
git add frontend/src
git commit -m "Settings → Users: add user, create login, role, reset password, deactivate"
```

---

### Task 8: Reset local data, create owners, end-to-end check

Needs a working database. Prefer Docker (`auditos-postgres` on 55432) once Docker Desktop is healthy; until then use a native DB without touching `backend/.env`:

```bash
createdb auditos_local 2>/dev/null
export DATABASE_URL='postgresql://selva@localhost:5432/auditos_local?schema=public'
```

- [ ] **Step 1: Owner env** — add the four `OWNER_*` lines to `backend/.env` (values from the user; gitignored). Confirm `git check-ignore backend/.env`.
- [ ] **Step 2: Reset + seed + owners** — `cd backend && npm run db:reset && npm run setup:owners` → "created" for both owners.
- [ ] **Step 3: Start** — `cd frontend && npm run dev:full` (with `DATABASE_URL` exported when on the native DB).
- [ ] **Step 4: Drive it in the browser (localhost:5173):**
  1. Sign-in page shows no demo list; "Forgot password?" shows the ask-your-Admin note.
  2. Sign in as `jnsacctax@gmail.com` → dashboard; Settings → Users lists only the Admin (Super Admin absent); role dropdown has no "Super Admin".
  3. Add user (Associate) with a generated password → temporary password shown once.
  4. Sign out; sign in as the new user → lands on "Set your new password"; any other URL redirects back; set a new password → app opens.
  5. As Admin: reset that user's password → their open session ends (reload → login).
  6. Profile panel → Change password works and keeps you signed in.
  7. Sign in as `info@digitalvetri.com` → Settings → Users shows both owners.
- [ ] **Step 5: Full test + build** — `cd backend && npx vitest run && npx tsc -p tsconfig.json --noEmit`; `cd frontend && npm run build`.
- [ ] **Step 6: Commit** anything outstanding; the user pushes (`! git push origin main`).
