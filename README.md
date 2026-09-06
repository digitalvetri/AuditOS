# Audit OS · HRMS

HRMS for **Audit OS**, an Indian audit / tax / compliance firm. React + Vite
frontend, Express + Prisma backend, one unified data model.

This repository is the integration of two independently developed parts:
Part 1 (the React application, its design system, core HR, attendance, leave,
documents and settings) and Part 2 (the Express backend plus payroll,
expenses, accounts, payments, messages and reports). Part 1 remains the
primary application; Part 2's backend is now the authoritative server behind
it, and its Messages and Reports modules live inside the Part 1 shell.

See `AUDIT_OS_HRMS.md` for the working project document and module statuses.

---

## Architecture

```text
React 18 + Vite  (src/ — the primary application)
        │
        │  every call goes through one adapter:
        │  src/services/api.ts  →  fetch('/api/…', { credentials: 'include' })
        │
        ├───────────────► MSW mock backend        VITE_MOCK_MODE=true
        │                 src/data/mock/          (no server needed)
        │
        └───────────────► Express API             VITE_MOCK_MODE=false
                          server/src/
                                │
                          Prisma ORM
                                │
                          SQLite (dev) / PostgreSQL (prod)
```

Both backends answer in the **same envelope** and the **same field casing**, so
switching modes changes one environment variable and nothing else:

```jsonc
// success (2xx)
{ "data": { } }

// error (4xx / 5xx)
{ "error": { "code": "forbidden", "message": "Access denied.", "details": {} } }
```

### The API boundary

Prisma columns are camelCase; the HTTP API is snake_case with `_paise` money
and `YYYY-MM-DD` dates. Every conversion lives in exactly one file —
`server/src/api/serialize.ts`. No route handler builds a response by hand and
no React component knows a database column name:

```text
Prisma Employee ──► employeeToApi() ──► { employee_code, first_name, … }
```

The same file holds the two deliberate projections: the six-field Finance view
of an employee, and the department-scope view that drops bank and next-of-kin
details.

### Request pipeline

Every endpoint runs the same chain, in this order:

```text
authenticate → authorize (explicit permission + scope) → validate (zod) → handle → audit
```

Authorization is always an explicit permission code, never a role-name check.
The permission matrix is server-side canonical in
`server/src/platform/rbac/matrix.ts`; the identical client copy in
`src/platform/rbac/matrix.ts` exists only to decide what to render.

---

## Quick start

```bash
npm run setup          # installs both projects, creates the dev DB, seeds it
```

Then either mode:

```bash
# Mock mode — no backend, MSW serves seeded data in the browser
npm run dev            # http://localhost:5173

# Real backend mode — set VITE_MOCK_MODE=false in .env first
npm run dev:full       # Vite on :5173 and the API on :4000 together
```

`npm run dev:full` runs both processes; `npm run dev` and `npm run dev:api`
run them separately if you prefer two terminals.

### Scripts

| Command | What it does |
|---|---|
| `npm run setup` | Install frontend + backend, generate Prisma client, create and seed the dev database |
| `npm run dev` | Vite dev server (mock or real depending on `VITE_MOCK_MODE`) |
| `npm run dev:api` | Express API with hot reload |
| `npm run dev:full` | Both together |
| `npm run build` | `tsc -b && vite build` |
| `npm run build:api` | Compile the backend to `server/dist` |
| `npm run type-check` / `type-check:api` | TypeScript, no emit |
| `npm run db:setup` | Generate client, push schema, seed |
| `npm run db:reset` | Drop the dev database and rebuild it from the seed |

Backend-only equivalents live in `server/package.json`
(`npm --prefix server run …`).

> Restart the API after `db:reset` — the running process holds an open handle
> to the SQLite file that the reset replaces.

---

## Environment

Two files, both git-ignored, both with a committed `.example`:

| File | Purpose |
|---|---|
| `.env` | Frontend. Copy from `.env.example`. |
| `server/.env` | Backend. Copy from `server/.env.example`. |

### Mock mode

```dotenv
VITE_MOCK_MODE=true
```

MSW intercepts every `/api/*` call inside the browser and serves the seeded
dataset from `src/data/seed/`. No backend, no database. State persists to
`localStorage`, so a refresh keeps your changes. This is the fastest way to
work on the UI and it stays fully supported — the mock handlers implement the
same contract as the server, module for module, including Messages and
Reports.

### Real backend mode

```dotenv
VITE_MOCK_MODE=false
VITE_API_PROXY_TARGET=http://localhost:4000
```

Vite proxies `/api` and `/socket.io` to Express, which keeps the app
same-origin — so the session cookie works with no CORS or SameSite special
cases, and no component changes its URL.

### Backend variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `file:./dev.db` for SQLite. For PostgreSQL also change `provider` in `server/prisma/schema.prisma`. |
| `JWT_SECRET` | in production | Session signing key. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `SIGNED_URL_SECRET` | in production | Signs short-lived document / payslip download links. |
| `SIGNED_URL_TTL_SECONDS` | no | Default 300. |
| `SESSION_TTL_SECONDS` | no | Default 28800 (8 hours). |
| `WEB_ORIGIN` | no | Comma-separated allow-list for credentialed CORS. Never `*`. |
| `PORT` | no | Default 4000. |
| `NODE_ENV` | no | In `production`, a missing secret aborts startup rather than falling back. |

In development a missing secret produces a per-process random value with a
warning — sessions simply do not survive a restart. There is no well-known
default secret anywhere in the codebase.

---

## Demo credentials

Development seed data only. They exist in `server/prisma/seed.ts` and in the
mock seed; never deploy with them.

| Role | Email | Password |
|---|---|---|
| MD / Super Admin | ravi@auditos.local | `md` |
| HR Admin | priya@auditos.local | `hr` |
| Finance Admin | anitha@auditos.local | `fin` |
| Dept Manager | vikram@auditos.local | `mgr` |
| Employee | meera@auditos.local | `emp` |
| Articled Assistant | karthik@auditos.local | `art` |

The login screen lists them when `VITE_MOCK_MODE=true`, or when
`VITE_SHOW_DEMO_LOGINS=true` against the seeded dev backend. A production
build shows nothing.

---

## Modules

| Module | Route | Backend | Notes |
|---|---|---|---|
| **HR / Employees** | `/hrms/employees` | `/api/employees` | Scoped list, Finance six-field projection, self-edit allowlist, deactivation revokes the login |
| **Attendance** | `/hrms/attendance` | `/api/attendance` | Server-side geofence, IST-stable dates, correction request → approval |
| **Leave** | `/hrms/leave` | `/api/leaves` | Sandwich-rule day count, balance checks, manager → HR escalation above 5 days |
| **Payroll** | `/hrms/payroll` | `/api/payroll` | Stage machine, statutory snapshot, LOP, PF/ESI/PT/TDS, gratuity accrual, payslip PDF |
| **Expenses** | `/hrms/expenses` | `/api/expenses` | Draft → manager → finance → paid, with an append-only approval trail |
| **Accounts** | `/hrms/accounts` | `/api/accounts` | Append-only ledger, contra entries, reconciliation check |
| **Payments** | `/hrms/accounts` | `/api/payments` | Simulated disbursement, always paired with a ledger row |
| **Messages** | `/hrms/messages` | `/api/messages` | Groups and DMs, replies, reactions, mentions, unread state, Socket.IO |
| **Reports** | `/hrms/reports` | `/api/reports` | 14 scoped reports, filters, CSV / Excel export |
| **Documents** | `/hrms/documents` | `/api/documents` | Signed-URL downloads, expiry derivation |
| **Notifications** | `/notifications` | `/api/notifications` | Platform primitive every module emits into |
| **Settings** | `/hrms/settings` | `/api/settings` | Departments, designations, locations, holidays, leave types, expense categories, statutory rates, role matrix |

Reserved, deliberately not built: **Workstation** and **Tools**. Their routes,
navigation entries and the nullable columns they will need (`client_id`,
`weekly_capacity_hours`, `Chat.subjectType`) already exist.

### Payroll stage machine

```text
draft ──calculate──► draft ──review──► hr_review ──review──► finance_review
                                                                   │
                                                              approve (Finance)
                                                                   ▼
                                                              approved
                                                                   │
                                                              process (Finance)
                                                                   ▼
                                                              processed  ← immutable
```

Processing writes payments, ledger rows and payslips in one transaction. A
processed run refuses every state-change endpoint, and because Calculate
snapshots the statutory table onto the run, a later rate change cannot alter
its numbers.

### Expense workflow

```text
Employee creates ──► Manager approval ──► Finance approval ──► Payment ──► Ledger entry
                            │                    │
                            └──── rejected ◄─────┘        every step: approval row + audit + notification
```

---

## Database

One unified Prisma schema — `server/prisma/schema.prisma`. There is exactly
one `User`, one `Employee`, one `Role`, one `ExpenseCategory` and one payroll
model. Where Part 1 and Part 2 both described an entity, the Part 1 domain
shape won (it is what the shipped frontend consumes) and Part 2's useful
additions were folded in.

Conventions the schema enforces:

- **Money** is an integer number of paise. No floats touch money.
- **Calendar dates** that must stay IST-stable (attendance date, leave range,
  effective-from, expiry) are `YYYY-MM-DD` strings; points in time are UTC
  `DateTime`. Storing a calendar date as a timestamp is what lands attendance
  on the wrong day across the IST/UTC boundary.
- **Soft delete** on every mutable table; reads filter `deletedAt: null`.
- **Append-only** `AuditLog` and `LedgerTransaction` — no update, no delete
  path anywhere in the application. Ledger corrections are contra entries.
- **Nullable both ways** for User ↔ Employee: automation users have no
  employee, and an exited employee keeps their records without a login.

SQLite is the local development database. Moving to PostgreSQL is a two-line
change: `provider = "postgresql"` and a Postgres `DATABASE_URL`.

---

## Security

- Sessions are JWTs in an **httpOnly** cookie — no token in `localStorage`.
- Passwords are bcrypt-hashed; `passwordHash` has no serializer and cannot
  reach a response.
- Login failures return one message for every cause, so accounts cannot be
  enumerated, and are rate-limited per IP.
- An inactive user or a deactivated employee cannot authenticate, even with a
  cookie that has not expired.
- RBAC is enforced server-side on every route with an explicit permission and
  scope. Client-side `can()` is UX only.
- Document and payslip bytes are served through short-lived HMAC-signed URLs
  bound to the resource, the requesting user and an expiry — never a guessable
  path.
- CORS uses an explicit origin allow-list; credentials are never paired
  with `*`.
- `.env` files, `*.db` and build output are git-ignored.

---

## Verify scripts

Puppeteer-driven regression sweeps for the Part 1 modules. They drive an
installed Chrome via `puppeteer-core` and need the dev server running.

```bash
node scripts/verify.mjs               # shell, nav, auth
node scripts/verify-attendance.mjs    # check-in/out, corrections
node scripts/verify-leave.mjs         # apply, approval chain
node scripts/verify-employees.mjs     # list, profile, RBAC probes
node scripts/verify-dashboard.mjs     # widget registry + notifications
node scripts/verify-documents.mjs     # upload, signed-URL download
node scripts/verify-settings.mjs      # CRUD, statutory supersede
node scripts/verify-payroll.mjs       # stage machine, snapshot, immutability
node scripts/verify-expenses.mjs      # Draft→Paid, contra-ledger
node scripts/verify-accounts.mjs      # append-only ledger, reverse
```

Screenshots land in `scripts/shots/` (git-ignored).

---

## Layout

```text
src/                     Part 1 frontend — the primary application
  App.tsx                routing
  components/            shared primitives (Button, Input, StatusRow, Toast)
  data/
    models.ts            TypeScript domain model (snake_case API shapes)
    mock/                MSW handlers — the full API contract, mocked
    seed/                seeded dataset shared by mock mode
  design/                design tokens and global styles
  lib/                   pure helpers (dates, money formatting, payroll maths)
  modules/               feature modules; each registers its dashboard widgets
  pages/                 route components
  platform/              auth context, RBAC, notifications, widget registry
  services/api.ts        the one swappable API adapter
  shell/                 sidebar, top bar, app shell

server/                  Express + Prisma backend
  prisma/
    schema.prisma        the unified schema
    seed.ts              development seed
  src/
    api/serialize.ts     the single Prisma ⇄ API boundary
    domain/              pure business rules (payroll calc, leave days, status)
    lib/                 env, http envelope, dates, money, geo, rate limit
    modules/             one router per module
    platform/            auth, RBAC matrix, audit, notify, signed URLs, scope
```
