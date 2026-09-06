# Audit OS · HRMS

Demo-ready HRMS for **Audit OS**, an Indian audit / tax / compliance firm.
Built against the split specs `HRMSPart1.md` and the pre-split master
`AUDIT_OS_HRMS_PROMPT_v2.md` (see `AUDIT_OS_HRMS.md` for the working project
document, module statuses, and architectural decisions).

## Quick start

```powershell
cp .env.example .env
npm install
npm run dev            # Vite on http://localhost:5173, MSW in mock mode
```

Demo credentials appear on the login screen when `VITE_MOCK_MODE=true`:

| Role | Email | Password |
|---|---|---|
| MD / Super Admin | ravi@auditos.local | md |
| HR Admin | priya@auditos.local | hr |
| Finance Admin | anitha@auditos.local | fin |
| Dept Manager | vikram@auditos.local | mgr |
| Employee | meera@auditos.local | emp |
| Articled Assistant | karthik@auditos.local | art |

## Scripts

```powershell
npm run dev            # dev server (mock mode)
npm run build          # tsc -b && vite build
npm run type-check     # tsc -p tsconfig.json --noEmit
npm run preview        # preview the built bundle
```

## Verify (end-to-end regression sweep)

Each module has a Puppeteer-driven verify script that logs in, exercises the
happy path, and probes RBAC / immutability / server-side rules. They drive
the installed Chrome (`C:/Program Files/Google/Chrome/Application/chrome.exe`)
via `puppeteer-core` — install `puppeteer-core@23` if not already present.

Dev server must be running.

```powershell
node scripts/verify.mjs               # scaffold: shell, nav, auth
node scripts/verify-attendance.mjs    # §8.2 check-in/out, corrections
node scripts/verify-leave.mjs         # §8.3 apply, approval chain
node scripts/verify-employees.mjs     # §8.1 list, profile, RBAC probes
node scripts/verify-dashboard.mjs     # §6.2 widget registry + §8.9 notifications
node scripts/verify-documents.mjs     # §8.8 upload, signed-URL download
node scripts/verify-settings.mjs      # §8.11 CRUD, statutory supersede
node scripts/verify-payroll.mjs       # §8.4 stage machine, snapshot, immutability
node scripts/verify-expenses.mjs      # §8.5 Draft→Paid, contra-ledger
node scripts/verify-accounts.mjs      # §8.6 append-only ledger, reverse
```

Screenshots land in `scripts/shots/` (git-ignored).

## Layout

```
src/
  design/          §7 tokens + globals
  shell/           AppShell, Sidebar, TopBar
  pages/           routes
  platform/        cross-module primitives — auth, RBAC, dashboard registry, notifications
  modules/         one folder per HRMS module (attendance, leave, employees, …)
  data/            models + mock DB + MSW handlers + seed
  lib/             pure helpers (dates, geo, payroll calc, INR words)
  services/api.ts  the one swappable adapter (§2)
```

## Architecture commitments

Documented in full in `AUDIT_OS_HRMS.md`. Highlights:

- **Swappable adapter via MSW.** All calling code uses `fetch('/api/...')`. Disabling MSW (`VITE_MOCK_MODE=false`) routes the same code to a real backend — no call-site changes.
- **Design system enforced by construction.** `tailwind.config.ts` **replaces** (not extends) colors / borderRadius / boxShadow so `bg-purple-500`, `rounded-xl`, `shadow-lg` etc. don't exist as classes. §14 grep passes by omission.
- **RBAC server-side.** UI hiding is derived from the matrix (`src/platform/rbac/matrix.ts`); the API decides. Non-privileged calls receive 403 with a JSON error envelope, never empty 200 or 404.
- **Append-only where it matters.** AuditLog, LedgerTransaction, StatutoryRate (superseded not edited), PayrollRun (immutable once Processed) all follow the pattern.
- **User ↔ Employee nullable both ways.** Deactivated employees keep the record and lose the login; automation users may have no employee.
