# backend/ — the AUDIT OS API

The server behind every screen: authentication, permissions, business rules,
the database, file storage, PDFs and integrations (Zoho Books, Zoho Payments,
WhatsApp, government-portal helpers). Node + Express + TypeScript, with
Prisma over PostgreSQL. Live chat updates use Socket.IO.

## Why it is its own folder

- **Separate package.** Its own `package.json` and dependencies (Prisma,
  pdfkit, multer, …) that the browser app must never ship.
- **Separate deploy.** Its own Docker image (`api`), plus a one-shot
  `migrate` image built from the same folder that applies the schema and
  seeds before the API starts.
- **Owns the data.** Only this folder talks to the database; the frontend
  only sees the `/api/*` interface.

## What is inside

| Path | What it holds |
|---|---|
| `src/index.ts` | Process entry — starts HTTP + Socket.IO and the scheduled jobs |
| `src/app.ts` | Express app: middleware, and every module's router mounted under `/api` |
| `src/modules/` | One folder (or file) per business area — routes + service logic: `auth`, `employees`, `attendance`, `leave`, `payroll`, `accounts`, `expenses`, `messages`, `workstation`, `quotation`, `invoice`, `engagement`, `gst`, `tds`, `registration`, `partnership`, `books`, `zpay`, `tools`, `reports`, `task`, … |
| `src/platform/` | Cross-cutting rules: session auth, role-based permissions (`rbac`), data scoping, audit log, notifications, signed URLs, portal-credential encryption |
| `src/domain/` | Pure business rules with no I/O (payroll statutory maths, leave days, attendance status) |
| `src/api/` | Serializers — database rows → the JSON shapes the frontend reads |
| `src/lib/` | Helpers: env loading, Prisma client, HTTP errors/handler, dates, money, mailer, rate limiting |
| `src/__tests__/`, `src/modules/*/__tests__/` | API and module tests (vitest + scripted checks) |
| `prisma/schema.prisma` | The database schema (single source of truth for tables) |
| `prisma/seed*.ts` | Demo/dev data seeds |
| `prisma/safe-push.ts` | Non-destructive schema sync — what the Docker `migrate` step runs (adds, never drops data) |
| `prisma/sql/` | SQL the app applies on boot (ledger/task invariants) and one-off scripts |
| `assets/` | Fonts used by server-side PDF generation |
| `scripts/` | One-off maintenance/migration scripts |
| `uploads/` | Local file storage in development (git-ignored; a Docker volume in production) |
| `package.json` | Backend dependencies and scripts (dev, build, test, prisma, seeds) |
| `.gitignore` | What git skips here: `node_modules`, `dist`, `.env`, `uploads/` |
| `Dockerfile` | Multi-stage build: `toolchain` (used by `migrate`) and `runtime` (the API) |
| `.env` / `.env.example` | Server settings: `DATABASE_URL`, session secret, CORS origins, integration keys |

## Running it

```bash
cd backend
npm install
npm run prisma:generate
npm run prisma:push:safe   # create / update the tables (never drops data)
npm run seed
npm run dev           # tsx watch src/index.ts
npm run typecheck
npm test
npm run build && npm start
```

The development database runs in Docker — see `../docker/README.md`.

> Schema changes: prefer `npm run prisma:push:safe` over a bare
> `prisma db push`, which can try to drop tables that still hold data.
