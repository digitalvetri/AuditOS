# Real logins, user management and password reset — design

Date: 2026-10-09 · Status: approved

## Goal

Ship AuditOS with no demo data and real accounts only. Two owner accounts are
created by a setup command; every other login is created by Admin or Super
Admin from inside the app. Admins can reset any (visible) user's password, and
every user can change their own.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Demo data | Full clean start: base reference data only; no fake employees, clients, invoices, payroll. MSW mock mode and the "Demo logins" panel are removed. |
| Owner accounts | `info@digitalvetri.com` = Super Admin (role `md`), `jnsacctax@gmail.com` = Admin (role `hr_admin`). Both are login-only (no Employee record → no attendance, leave, payroll). |
| Owner passwords | Read from `backend/.env` (`OWNER_SUPERADMIN_EMAIL/PASSWORD`, `OWNER_ADMIN_EMAIL/PASSWORD`; in Docker, `docker/.env.docker`), never committed. Not forced to change. |
| Forgot password | No email. Login page "Forgot password?" explains: ask your Admin to reset it. |
| Admin reset / new user | Admin sets a temporary password (or generates one). The user must set their own password on next sign-in before using the app. |
| Self-service | Every user has "Change password" (current + new + confirm) in the profile menu. |
| Super Admin visibility | Invisible to every non-Super-Admin, Admin included: not listed, not editable, not resettable, and the Super Admin role is not offered to them. |
| New user | One "Add user" form creates the Employee record and the login together. Existing employees without a login get "Create login". |

## Backend

### Schema (`User`)
- `mustChangePassword Boolean @default(false)` — set on create and admin reset; cleared when the user sets their own password.
- `sessionVersion Int @default(0)` — embedded in the session JWT as `v`; bumped on every password change, admin reset and deactivation. A token carrying an older version is rejected, so the account is signed out everywhere else. (A counter rather than a timestamp: JWT `iat` has one-second resolution, which would also reject the fresh cookie issued in the same second.)

Additive columns; applied with `prisma/safe-push.ts`.

### Auth (`platform/auth.ts`, `modules/auth.routes.ts`)
- `authenticate` (and the Socket.IO handshake) rejects a token whose `v` differs from `sessionVersion` (401 "Your session has ended. Sign in again.").
- Session payload (`/login`, `/me`) gains `must_change_password`.
- While `mustChangePassword` is true, every API call except `/auth/me`, `/auth/logout` and `/auth/change-password` returns 403 `password_change_required`.
- `POST /api/auth/change-password { current_password, new_password }` — verifies current, applies the password policy, refuses reuse of the current password, clears the flag, bumps `sessionVersion`, re-issues the cookie for this browser, writes audit `auth.password_changed`. Rate limited.

### Password policy (`platform/password.ts`)
At least 8 characters, at least one letter and one digit, at most 128. One
function used by every endpoint; mirrored on the client for instant feedback.
The "Generate" button creates a 12-character password in the browser (no look-alike characters); the server only validates.

### Users API (`modules/users.routes.ts`, mounted at `/api/users`)
Allowed for roles `md` and `hr_admin` only (checked by role, as these are
account-administration actions rather than module grants).

- `GET /api/users` — `{ items, employees_without_login }`: users with name, email, role, active, last login, employee id; plus active employees that have no login. Users holding role `md` are omitted unless the caller is `md`.
- `POST /api/users` — `{ first_name, last_name, email, phone?, joining_date?, role_id, temp_password }` → creates Employee + User in one transaction, `mustChangePassword = true`. Email must be unique across User and Employee.
- `POST /api/users/from-employee/:employeeId` — `{ role_id, temp_password }` → login for an existing employee.
- `PATCH /api/users/:id` — `{ role_id?, is_active? }`.
- `GET /api/users/roles` — roles the caller may assign (Super Admin only for Super Admin).
- `POST /api/users/:id/reset-password` — `{ temp_password }` → new hash, `mustChangePassword = true`, `sessionVersion + 1`.

Guards on every write: target with role `md` is 404 to a non-`md` caller;
role `md` cannot be assigned by a non-`md` caller; a caller cannot change their
own role, deactivate themselves, or use admin-reset on themselves (they use
change-password). Deactivating also bumps `sessionVersion` so open sessions
end. Every action writes an audit row (`user.created`, `user.role_changed`,
`user.activated`/`user.deactivated`, `user.password_reset`); passwords never
appear in audit payloads.

### Hiding Super Admin elsewhere
Super Admin has no Employee record, so employee-based lists and pickers
(employees, attendance, leave, payroll, assignees, Messages contacts) already
exclude it. Where an endpoint labels a *user* to the client — dashboard
activity, the audit log, document uploaders, expense approvers, bookkeeping
and TDS audit trails — a Super Admin actor is labelled "System administrator"
instead of showing the email (for every viewer — simpler, and Super Admin
knows who they are). A shared helper `userLabel(user)` with a matching
`USER_LABEL_SELECT` does this so each endpoint makes one call.
Notification recipient lookups (`notify.ts`) are internal and unchanged.

### Seed split
- `prisma/seed.ts` keeps only reference data: organisation, permissions and the
  five roles, leave types, expense categories, work schedule, statutory rates,
  tools / GST / registration / partnership templates. All demo employees,
  users, clients, attendance, leave, payroll, invoices, workstation and
  bookkeeping rows are removed from it.
- `prisma/setup-owners.ts` (`npm run setup:owners`) upserts the two owner
  logins from env. Idempotent; existing passwords are left alone unless
  `--reset-passwords` is passed.
- Local database is reset (`db:reset` → seed → setup:owners). Production is
  reset only by the operator.

## Frontend

- Remove `src/data/mock`, `src/data/seed`, MSW startup in `main.tsx`, the
  `msw` dependency, `VITE_MOCK_MODE` / `VITE_SHOW_DEMO_LOGINS`, and the Demo
  logins panel. `modules/employees/api.ts` stops importing seed data.
- **Login page**: "Forgot password?" opens a small panel: "Ask your Admin to
  reset your password." No other change to the layout.
- **Set new password screen** (`/set-password`): shown after login, and
  enforced by `ProtectedRoute`, whenever `must_change_password` is true.
  Fields: new password, confirm; the current (temporary) password is entered
  too. On success, continue to the app.
- **Change password**: profile menu item opening a modal (current, new, confirm).
- **Settings → Users** (new section under "Access", visible to Super Admin and
  Admin): table (name, email, role, status, last sign-in), "Add user" modal,
  row actions: change role, reset password (shows the temporary password once
  with a Copy button), deactivate / reactivate. Employees without a login are
  listed below with "Create login".
- Role choices come from `VISIBLE_ROLES`; "Super Admin" is shown only to Super
  Admin.

## Error handling

Validation errors come back as 400 with field errors and are shown inline.
Duplicate email → 409 "A user with this email already exists." Forbidden or
hidden targets → 403 / 404 with no detail. Rate limit on change-password and
reset-password (10/min per user).

## Testing

Backend (Vitest + test database, existing pattern in `src/__tests__`):
create user (employee + login, flag set), duplicate email, admin reset sets
flag and invalidates old token, forced-change gate blocks other APIs,
change-password (wrong current, weak, success clears flag + new cookie works),
Admin cannot list / edit / reset / assign Super Admin, self-protection rules,
setup-owners idempotency.

Frontend: typecheck + build, then a browser run-through of: owner login,
add user, sign in as that user → forced set-password, admin reset, change
password from profile, Super Admin hidden when signed in as Admin.

## Out of scope

Email-based self reset, 2FA, password expiry, account lockout beyond the
existing IP rate limit.
