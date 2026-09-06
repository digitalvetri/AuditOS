```text
Document: AUDIT_OS_HRMS.md
Scope:   Part 1 + Part 2, integrated
```

# AUDIT OS · HRMS — Project Spec

This is the project's living spec. It began Part-1-scoped (the shared platform
foundation and the core-HR modules) and now covers the **integrated**
application: Part 1's React frontend and platform, plus Part 2's Express
backend and its Payroll, Expenses, Accounts, Payments, Messages and Reports
modules, against one unified data model.

See `README.md` for how to run it. This file records deliverables, decisions
and the reasoning behind them.

## Source of truth

The two build prompts are the canonical spec:

- `HRMSPart1.md` — shared foundation + core-HR (this session's scope)
- `HRMSPart2.md` — finance + communication (not yet delivered)

This file is the working project document that references them, tracks
deliverables, and records decisions taken during implementation.

## Deliverables — status (this session: scaffold + shell + auth)

| # | Deliverable | Owner | Status |
|---|---|---|---|
| 1 | This spec document (Part-1-scoped; Part 2 sections deferred) | Part 1 | ✓ done |
| 2 | Application shell + four-item nav | Part 1 | ✓ done |
| 3 | Data layer — models + minimum seed (Part 1 tables) | Part 1 | ✓ done (seed intentionally minimal — 5 users/employees, one per role. Full 28-employee mix + 90-day attendance + statutory rates land with their modules.) |
| 4 | Auth + RBAC enforced by mock service layer | Part 1 | ✓ done |
| 5 | Modules (Attendance → Leave → Employees → …) | Part 1 | ✓ done |
| 6 | Demo walkthrough (§12) | split | ✓ covered by the seeded dataset |
| 7 | Express + Prisma backend behind the Part 1 API contract | integration | ✓ done |
| 8 | Unified Prisma schema (Part 1 core-HR + Part 2 modules) | integration | ✓ done |
| 9 | Payroll, Expenses, Accounts, Payments on the real backend | integration | ✓ done |
| 10 | Messages integrated into the Part 1 shell | integration | ✓ done |
| 11 | Reports integrated into the Part 1 shell | integration | ✓ done |

## Mermaid flows

Only one core flow is defined in Part 1: **Attendance check-in / check-out**
(see `HRMSPart1.md` §8.2). The other five flows are defined in Part 2 and will
be added when Part 2 arrives. Do not invent them here.

## Architectural commitments taken this session

1. **Swappable adapter via MSW.** All calling code uses `fetch('/api/...')`.
   The mock backend is MSW (Mock Service Worker) intercepting at the network
   layer. Disabling MSW routes the same code to a real Express backend without
   changing a single call site. This upholds §2's "swap one adapter and nothing
   else" rule.
2. **Design system enforced by construction.** `tailwind.config.ts` **replaces**
   (not extends) `colors`, `borderRadius`, and `boxShadow` so that
   `purple-500`, `rounded-xl`, `shadow-lg`, etc. are not emitted classes. The
   §14 grep test passes by omission.
3. **`tabular-nums` on `body`.** All figures inherit tabular numerals; no
   per-component wiring.
4. **User ↔ Employee is nullable both ways.** Deactivated employees keep the
   record and lose the login; automation users may have no employee.
5. **MSW middleware mirrors Express.** Handlers compose
   `withAuth(withScope(permission, scope)(handler))`, mirroring the
   `authenticate → authorize → validate → handle → audit` chain in §4.3. When
   we swap to Express, middleware names carry over.
6. **Route-based login.** `/login` public, `/` protected. Refreshing preserves
   state (session in `sessionStorage`, sidebar collapse in `localStorage`).


---

## Part 2 integration (this session)

Part 1 and Part 2 were built independently and described several of the same
entities. The integration resolved that into one model and one server rather
than running two of anything.

### What won, and why

| Area | Decision | Reason |
|---|---|---|
| Frontend shell | **Part 1** | It is the shipped application: routing, design system, RBAC-driven navigation, widget registry. Part 2's `web/` was treated as a source of functionality, not an app. |
| Domain model | **Part 1's** `src/data/models.ts` | Richer and already consumed by working components. Part 2's Prisma models for the same entities were stubs written to let Part 2 run. |
| Payroll model | **Part 1's** (stage machine, statutory snapshot, earnings/deductions breakdown) | It matches the frontend and captures immutability properly. Part 2's gratuity accrual, payslip PDF and "show the working" were folded in. |
| Expenses / Accounts | **Part 1's** stage names and ledger shape | Already rendered by the Expenses and Accounts pages. Part 2's monotonic ledger `sequence`, `transactionRef` and contra-entry discipline were adopted wholesale — they are stronger. |
| Messages | **Frontend from `main`, backend rewritten to serve it** | `main` shipped a complete MSW-backed Messages UI while this integration was in flight. Its UI and contract won; the Express implementation was rewritten to match it exactly (per-message read receipts, DM idempotency, MD read-only override). |
| Reports | **Frontend from `main`, backend rewritten to serve it** | Same story. `main`'s four typed aggregate reports replaced the generic definition-driven engine, and the backend now serves that contract against Prisma. |
| API envelope | **Part 1's** `{ data }` / `{ error }` | The frontend adapter already assumes it. Part 2's `{ ok, data }` was converted rather than teaching 40 components a second format. |
| Auth | **Part 2's JWT**, delivered in an httpOnly cookie | Real authentication, but shaped so `credentials: 'include'` keeps working and no token sits in `localStorage`. |
| RBAC | **Part 1's matrix**, enforced server-side | Part 2's role matrix was a stub. Part 1's is the spec §5 matrix; it now lives in `server/src/platform/rbac/matrix.ts` and is seeded into the database. |

### Duplicates removed

- One `User`, one `Employee`, one `Role`, one `ExpenseCategory`, one payroll model.
- Part 2's separate `web/` React app is not used; its `App.tsx`, router and
  design were not merged into the root frontend.
- `ModulePlaceholder.tsx` deleted — every HRMS route now has a real page.
- Part 2's stub `platform/permissions.ts`, `platform/rbac.ts`,
  `platform/dashboard.ts` and `platform/routes.ts` were replaced by the
  integrated platform layer.

### Naming boundary

Prisma columns are camelCase, the HTTP API is snake_case. Rather than renaming
one side to match the other, the two vocabularies stay separate and meet in
exactly one file, `server/src/api/serialize.ts`. No route handler builds a
response by hand; no React component knows a column name. The same file holds
the Finance six-field projection (§5‡) and the department-scope projection, so
those rules are enforced in one readable place rather than scattered.

### Calendar dates vs timestamps

Attendance is keyed `(employee_id, date)` where `date` is an **IST calendar
day**. Storing that as a timestamp is what makes a 00:30 IST check-in land on
the previous day and either collide or split. So calendar-date columns
(attendance date, leave range, effective-from, expiry) are `YYYY-MM-DD`
strings, and only points in time are `DateTime`.

### Signed URLs are self-authorizing

`/api/documents/:id/download` and `/api/payroll/payslips/:id/pdf` are the only
routes under `/api` that do not sit behind `authenticate`. That is deliberate:
the HMAC in the query string binds the resource, the requesting user and an
expiry, which is what lets a plain browser navigation fetch the file. Issuing a
link still requires the authenticated `…/download-url` endpoint.

### Reconciling with `main`

While this integration was being built, `main` advanced with **"Ship Part 2
modules"** — a parallel implementation of Payroll, Expenses, Accounts,
Messages and Reports as MSW mock handlers plus frontend pages, with no
backend. The two efforts overlapped in nine files.

This branch was rebased onto that commit rather than merged over it, and the
overlap was resolved by role:

- **Frontend belongs to `main`.** Its `Messages.tsx`, `Reports.tsx`, module
  API clients, chat mock handlers, chat seed, `models.ts` chat types and the
  TopBar unread badge are kept verbatim. The duplicate files this branch had
  written for the same purpose were deleted.
- **Backend belongs to this branch**, rewritten to serve `main`'s contract:
  `/api/chats*` and `/api/reports/:type` with `main`'s exact request and
  response shapes, against the unified Prisma schema. The chat tables were
  reshaped to `main`'s model (lowercase `group`/`dm`, soft-leave membership,
  `parent_id` replies, per-message read receipts, `last_message_at`).

The result is one contract with two implementations — MSW and Express — which
is what makes `VITE_MOCK_MODE` a single switch rather than two codebases.

### Mock mode kept

MSW was not removed. `src/data/mock/` implements the same contract as the
server — including the new Messages and Reports modules — so the frontend can
be developed with no backend, and the two implementations are a check on each
other. `VITE_MOCK_MODE` is the only switch.

## Decisions taken (§16 open items)

Only decisions needed for Part 1 modules are taken here. Payroll-dependent
decisions (PF ceiling, PT slabs, ESI applicability) are deferred to when Part 2
starts.

| Decision | Value | Notes |
|---|---|---|
| Head-office coordinates | **13.0827, 80.2707** (Chennai, TN) | placeholder; §13 marks as `[DECIDE]`. Change in the seed. |
| Headcount (seed) | **8** (one per role, plus articled, probation and an exited employee) | Enough to exercise every scope rule and the no-login case. |
| Probation duration | **6 months** | §3 default. |
| PF basis under LOP | **Full Basic, not pro-rated** | The spec is silent and both readings are defensible; documented in `server/src/domain/payroll/calc.ts` so it can be changed in one place. |
| PF wage ceiling | **Applied** (`restrict_to_ceiling` behaviour) | Rate rows carry the ceiling; the engine reads it rather than inlining a number. |
| Professional Tax realisation | **August and February payrolls** | TN charges half-yearly; realising it in the two months it is due matches practice better than accruing a sixth monthly. |
| Gratuity | **Accrued and shown, never paid through payroll** | 15/26 of monthly basic per year, surfaced so Finance sees the liability building. |
| Development database | **SQLite** | Zero-setup local development. PostgreSQL is a two-line change (`provider` + `DATABASE_URL`). |
| Session transport | **JWT in an httpOnly cookie** | Keeps `credentials: 'include'` working unchanged and keeps the token out of reach of injected scripts. |
| Dev secrets | **Random per process, with a warning** | No well-known default secret exists in the codebase; production aborts on a missing secret. |

## Local development

```powershell
npm install
npm run dev            # Vite dev server, MSW in mock mode
npm run build          # type-check + production build
```

Demo credentials appear on the login screen only when `VITE_MOCK_MODE=true`
(the default in `.env`). Any non-mock build must set it to `false`.

## Repository layout

```
/                       root
  AUDIT_OS_HRMS.md      this file
  HRMSPart1.md          Part 1 spec (source)
  package.json          scripts + deps
  tailwind.config.ts    design tokens per §7 (constrained)
  vite.config.ts        dev server config
  index.html            single-page entry
  public/
    mockServiceWorker.js  MSW runtime (generated by `npx msw init`)
  src/
    main.tsx            entry; boots MSW in mock mode before rendering
    App.tsx             router + providers
    design/
      globals.css       tokens, base type/rhythm, tabular-nums on body
    shell/              AppShell, Sidebar, TopBar, Breadcrumb
    pages/
      Login.tsx
      Dashboard.tsx     widget-registry consumer
      reserved/         Workstation, Tools
    platform/
      auth/             AuthProvider, useAuth, ProtectedRoute
      rbac/             permission matrix + can()
      dashboard/        widgetRegistry
    data/
      models.ts         §10 Part-1 entity types
      seed/             minimum seed for the session
      mock/             MSW handlers + middleware
    services/api.ts     thin fetch wrapper (the swap point)
    components/         Button, Table, StatusRow, Toast, …
    lib/                format helpers (INR, IST, DD MMM YYYY, hh:mm A)
```
