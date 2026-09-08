# Accounting module — stack decision

The repository already has an established stack, so no new language or
framework is introduced. The Books module uses exactly what the rest of
AUDIT OS uses:

| Concern | Existing choice, reused |
|---|---|
| Backend | Express 4 + TypeScript (ESM), `handler()` / `ok()` envelope from `server/src/lib/http.ts` |
| Database | Prisma 5 on SQLite for development; PostgreSQL is a provider switch |
| Auth | JWT in an httpOnly cookie, `authenticate` mounted once in `app.ts` |
| Authorization | `can(session, code, scope)` against the role matrix; new `books.*` codes |
| Money | Integer minor units (paise). Books uses `BigInt` columns because a client's ledger can exceed the 32-bit `Int` limit (₹21.47 crore) that the firm's own internal ledger tolerates |
| Frontend | React 18 + Vite + TanStack Query, Workstation UI kit, design tokens |
| Tests | None existed beyond tsx scripts. **Vitest** is added to `server/` (dev dependency) because the brief requires unit, golden-dataset and isolation tests that run on every build |

## Why a relational store is right here

Double-entry needs hard invariants: a journal whose debits and credits
differ must be impossible to persist, posted records must be immutable, and
the audit trail must be append-only. These are enforced with **database
triggers** (`server/prisma/sql/books-invariants.sqlite.sql`, with a
PostgreSQL twin) that are applied idempotently at API start-up and by the
seed — not only by service code that a future change could skip.

## SQLite in development, PostgreSQL in production

Prisma abstracts the SQL, and the trigger files exist for both providers.
The only provider-specific piece is the trigger DDL; everything else
(services, reports, tests) is provider-neutral.

## Deliberate simplifications

- Exchange rates are stored as `Float` (SQLite has no `Decimal`); amounts are
  never floats — the rate is applied once at entry and the base-currency
  minor-unit result is stored.
- Migrations follow the repo convention (`prisma db push` from the single
  schema file) rather than a migrations directory, because that is how every
  other module in this codebase ships schema changes.
