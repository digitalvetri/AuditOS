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
                          PostgreSQL 16 (Docker in dev, hosted in prod)
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
cp .env.docker.example .env.docker    # dev credentials for the DB container
docker compose up -d                  # Postgres 16 on :55432, Adminer on :58080
npm run setup                         # installs both projects, pushes schema, seeds
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

> `db:reset` drops and rebuilds the Postgres schema (`prisma db push
> --force-reset`) then re-runs the seed. The running API auto-reconnects.

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
| `DATABASE_URL` | yes | `postgresql://…` — points at the Docker Postgres (default `localhost:55432`). See `.env.example`. |
| `TEST_DATABASE_URL` | yes for tests | Separate Postgres DB used by `npm test` (default `auditos_test` on the same container). |
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
| **Messages** | `/hrms/messages` | `/api/chats` | Group chats and DMs, reply-to, per-message read receipts, unread badge, Socket.IO |
| **Reports** | `/hrms/reports` | `/api/reports/:type` | Attendance, leave, payroll and expense reports, query-level scoping, CSV export |
| **Documents** | `/hrms/documents` | `/api/documents` | Signed-URL downloads, expiry derivation |
| **Notifications** | `/notifications` | `/api/notifications` | Platform primitive every module emits into |
| **Settings** | `/hrms/settings` | `/api/settings` | Departments, designations, locations, holidays, leave types, expense categories, statutory rates, role matrix |
| **Tools** | `/tools` | `/api/tools`, `/api/tool-jobs`, `/api/tool-documents` | Registry-driven converters (12 live, 6 compliance cards "coming soon"), one shared workspace, every output saved to `/tools/documents` with an audit trail |
| **Books** | `/books` | `/api/books` | Native bookkeeping, one set of books per client: double-entry ledger with database-enforced invariants, sales and purchase chains, GST/TDS, multi-currency, reports |

### Books (accounting)

Our own equivalent of Zoho Books, built into the platform — no Zoho API, no
SDK, no dependency on their service. One `BooksOrganisation` per end client,
firm staff assigned per set of books, and hard separation between them.

Every financial record is a journal; invoices, bills, payments and credits
are wrappers over one posting function. The balance invariant, the
immutability of posted entries and the append-only audit trail are enforced
by **database triggers**, not only by service code
(`server/prisma/sql/books-invariants.*.sql`).

```bash
npm --prefix server run seed:books    # demo books for two clients
npm --prefix server run books:reset   # wipe and re-seed (development only)
npm --prefix server test              # 41 unit, golden-dataset and API tests
node scripts/verify-books.mjs         # browser verification
```

Full documentation: `docs/accounting-module/README.md`, with the stack
decision and the list of open questions beside it.

### Tools (Converters & Utilities)

The Tools page, its search, the `/tools/:toolId` workspace routes and the
permission checks all render from one registry
(`src/modules/tools/registry.ts`, mirrored for enforcement in
`server/src/modules/tools/registry.ts`). Turning a compliance converter on
later is `status: 'active'` in both files plus its implementation in
`server/src/modules/tools/runner.ts`.

Conversions run on the server and lean on three system tools that must be
on `PATH`: **LibreOffice** (`soffice` — Excel/Word ⇄ PDF), **Ghostscript**
(`gs` — compress, decrypt) and **poppler** (`pdftoppm` — thumbnails, OCR
rasters). OCR uses tesseract.js; English language data is downloaded once
and cached under `server/uploads/ocr-cache/`. Files live under
`server/uploads/tools/` through `StorageAdapter` (swap in S3/Supabase there).

```bash
npm --prefix server run seed:tools   # sync the tool catalogue tables from the registry
node scripts/verify-tools.mjs        # headless end-to-end run of all 12 tools + Documents
npx tsx server/src/modules/tools/__tests__/smoke.ts   # service-level checks on the fixtures
```

Notes for the firm: **e-Sign PDF** applies a visible approval mark and is
not a DSC signature (a `SignatureProvider` seam exists for a real provider);
**Unlock PDF** only removes a password the user supplies and records the
user's authorisation confirmation in the audit log.

### Messages

Membership is the authorization boundary for both reads and writes. `chat.manage`
(MD) overrides it for **reads only** — writing as a non-member would fake group
presence, so the override deliberately stops at GET. A DM is idempotent per pair:
asking for one twice returns the same thread. Read state is one row per
(message, employee), which is what lets the UI answer "have I read *this*
message" rather than only tracking a per-chat high-water mark.

### Reports

Four report types — attendance, leave, payroll, expenses — scoped **at query
level**, not by filtering the response:

| Report | Employee | Dept Manager | HR | Finance | MD |
|---|---|---|---|---|---|
| attendance, leave | self | department | organisation | denied | organisation |
| payroll, expenses | own rows | own rows | denied | organisation | organisation |

A Dept Manager's attendance query cannot return another department's rows
because those employee ids never enter the `where` clause.

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

The active provider is **PostgreSQL 16** in both development and production;
locally it runs in Docker (see `docker-compose.yml` and the Docker section
below). The Books invariants layer (`server/src/modules/books/db/invariants.ts`)
dispatches to the matching SQL file, so schema-level rules stay in one place.

### Docker

One Compose file at the repo root brings up Postgres and Adminer:

| Service | Host port | Container port | Notes |
|---|---|---|---|
| `postgres` | `55432` | `5432` | Postgres 16. Volume `auditos-pg-data` survives `down`; wipe with `docker compose down -v`. |
| `adminer` | `58080` | `8080` | Browser SQL client at `http://localhost:58080` — server `postgres`, user/password from `.env.docker`. |

Ports are 55432 / 58080 rather than 5432 / 8080 to avoid clashing with a
native Postgres install or an existing Adminer. Override with e.g.
`POSTGRES_HOST_PORT=5432 docker compose up -d`.

Two databases are created on first start: `auditos` (dev) and `auditos_test`
(vitest). The test suite requires the container to be up.

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
node scripts/verify-tools.mjs         # all 12 tools, search, Documents, scope
node scripts/verify-books.mjs         # Books: posting, reports, scoping
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
