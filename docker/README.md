# docker/ — running AUDIT OS in containers

Everything needed to run the whole stack with Docker: the compose file, the
environment template, and the Postgres init scripts. The images themselves
are defined next to their code (`../frontend/Dockerfile`,
`../backend/Dockerfile`); this folder wires them together.

## Why it is its own folder

- **Deployment, not application code.** Keeping orchestration here means the
  `frontend/` and `backend/` folders stay about their own code, and anyone
  looking for "how do I run/deploy this?" has one place to look.
- **Shared by both sides.** The database container and the web → API proxy
  set-up serve the frontend and backend together, so they belong to neither.

## What is inside

| File | What it does |
|---|---|
| `docker-compose.yml` | The stack: `postgres`, `migrate` (one-shot schema + seed), `api`, `web`, `adminer` |
| `.env.docker.example` | Template for `.env.docker` — DB credentials, session secret, `WEB_ORIGIN`, ports |
| `.gitignore` | Keeps the real `.env.docker` (secrets) out of git |
| `postgres/init/` | Scripts Postgres runs on first start (e.g. creating the test database) |

### The services

| Service | Built from | Port (host) | Role |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` image | `55432` | The database. Data in the named volume `auditos-pg-data` |
| `migrate` | `../backend` (`toolchain` target) | — | Applies the schema non-destructively (`safe-push`) and seeds, then exits |
| `api` | `../backend` (`runtime` target) | internal `4000` | The Express API. Uploads in the volume `auditos-uploads` |
| `web` | `../frontend` | `8080` | nginx serving the app and proxying `/api` + `/socket.io` to `api` (one origin, so the session cookie just works) |
| `adminer` | `adminer:4` image | `58080` | Browser SQL client for the database |
| `extension-build` | `node:20` image, profile `tools` | — | On demand only: builds the portal-autofill Chrome extension into `extension/dist` (`docker compose --profile tools run --rm extension-build`) |

Start order is enforced: `postgres` healthy → `migrate` completes → `api` → `web`.

## Going live — checklist

Do these before real client data goes in. The API refuses to boot in
production with a missing or placeholder secret, so most mistakes fail loudly.

1. **Secrets** — in `.env.docker`, generate every value, each separately:
   `POSTGRES_PASSWORD` (and the same password inside `DATABASE_URL`),
   `JWT_SECRET`, `SIGNED_URL_SECRET`, `PERMANENT_LINK_SECRET`
   (`openssl rand -hex 32`), `PORTAL_ACCESS_ENC_KEY` (`openssl rand -base64 32`).
2. **Owner logins** — `OWNER_SUPERADMIN_*` and `OWNER_ADMIN_*`. Without them a
   fresh database has no login and `migrate` stops with an error.
3. **HTTPS** — point DNS for your domain at the server, set `DOMAIN`,
   `WEB_BIND_ADDRESS=127.0.0.1`, `WEB_ORIGIN=https://DOMAIN`,
   `PUBLIC_APP_URL=https://DOMAIN`, `COOKIE_SECURE=true`, then
   `docker compose --profile https up -d --build`. PWA install, offline mode
   and push notifications only work over HTTPS.
4. **Backups** — the `backup` service writes nightly dumps to `docker/backups/`
   and checks each one. Set, in this order:
   `BACKUP_PASSPHRASE` (encrypts every backup; keep it in your password
   manager), `BACKUP_RCLONE_REMOTE=offsite:<bucket>` plus the
   `RCLONE_CONFIG_OFFSITE_*` keys (copies each backup off the server — S3,
   Backblaze B2, Google Drive…), and `BACKUP_PING_URL` (a healthchecks.io
   check, which emails you when a night's backup fails or never runs). On
   day `BACKUP_RESTORE_TEST_DAY` (default the 1st) the backup is restored into
   a scratch database and checked. Store `.env.docker` — especially
   `PORTAL_ACCESS_ENC_KEY` — in your password manager: a backup cannot be
   decrypted without it.
5. **Firewall** — only 80 and 443 open. Postgres and Adminer are bound to
   127.0.0.1 and must stay that way; never run Adminer on a public server.
6. **Old demo data** — a database that was ever seeded with demo data still
   has the demo logins (e.g. `ravi@auditos.local`). Start production from a
   fresh volume (`docker compose down -v` on that server, then `up`), or
   deactivate every demo login in Settings → Users.

## Security checklist

Short list; the "Going live" steps above come first.

- **No 2FA yet** — logins are password-only. Use long unique passwords, keep
  Admin / Super Admin logins few, and deactivate leavers the same day.
- **Backups off-site** — set `BACKUP_PASSPHRASE`, `BACKUP_RCLONE_REMOTE` +
  `RCLONE_CONFIG_OFFSITE_*`. A backup that lives only on the server dies with it.
- **Health checks** — `BACKUP_PING_URL` (healthchecks.io) for the nightly
  backup, and an uptime check on `https://DOMAIN/api/health`.
- **Error reports** — set `SENTRY_DSN` so crashes reach you, not just the log.
- **Virus scanning (optional)** — see below.
- **Disk encryption** — turn on volume / disk encryption at the provider
  (uploads and the database sit on the server's disk unencrypted otherwise).
- **Rotate keys** — rotate `JWT_SECRET` / `SIGNED_URL_SECRET` /
  `PERMANENT_LINK_SECRET` after any suspected leak or staff departure with
  server access (everyone signs in again; shared links stop working).
  `PORTAL_ACCESS_ENC_KEY` encrypts stored portal passwords — rotating it means
  re-entering them, and old backups need the old key.
- **Audit log** — the API checks the audit log's hash chain daily and alerts
  Admins in the bell if a row was edited or deleted outside the app.
- **AI drafting** — notice text goes to Groq (US) with PAN, GSTIN, Aadhaar,
  phone and email masked. Switch it off in Settings → Data protection if the
  firm's engagement terms do not allow it.

### Virus scanning (ClamAV, optional)

Every upload can be scanned by a ClamAV daemon (`clamd`) before it is stored.
It is **off unless `CLAMAV_HOST` is set**.

| Variable | Default | Meaning |
|---|---|---|
| `CLAMAV_HOST` | empty (off) | clamd host, e.g. `clamav` for the compose service |
| `CLAMAV_PORT` | `3310` | clamd TCP port |
| `CLAMAV_REQUIRED` | `false` | `true` refuses uploads (503) while the scanner is unreachable; otherwise they are allowed and a warning is logged |

An infected file is refused with "This file failed the virus scan" (422).
`docker-compose.coolify.yml` has a commented-out `clamav` service: it needs
about **1 GB of RAM**, so it is left off on the 4 GB server. On a bigger
server, uncomment it (and the `clamav-db` volume), set `CLAMAV_HOST=clamav`,
and redeploy. The first start downloads signatures for a few minutes.
A file larger than clamd's `StreamMaxLength` (default 25 MB in clamd.conf; the
Tools uploads allow more) cannot be scanned: it is allowed unscanned, or refused
with 503 under `CLAMAV_REQUIRED=true`. Raise `StreamMaxLength` to the biggest
upload limit you use.

## Using it

```bash
cd docker
cp .env.docker.example .env.docker     # then set the secrets and WEB_ORIGIN
docker compose up -d --build           # always --build, so migrate matches the schema
# then open http://localhost:8080
```

Day-to-day (run inside `docker/`):

```bash
docker compose logs -f api web                           # follow api + web logs
docker compose down                                      # stop, keep data
docker compose run --rm migrate                          # re-run schema sync + seed
docker compose down -v && docker compose up -d --build   # DESTRUCTIVE — drop volumes and rebuild
```

**Roles.** `migrate` sets up the five roles (Super Admin, Admin, Senior
Associate, Associate, Intern) with their default module access the first time
it runs on a database; after that it keeps whatever Settings → Roles &
permissions holds. To put the defaults back:

```bash
docker compose run --rm migrate npx tsx prisma/setup-roles.ts
```

**Payment summary.** `migrate` creates the `InvoicePayment` table (payment
history / instalments per invoice) like any other additive schema change. On
start the `api` gives every invoice that was paid before history existed one
"recorded before payment history" row, so the totals and the history agree —
nothing to run by hand.

**Registration details + portal autofill.** `migrate` needs nothing extra:
registration details live in the existing `RegistrationCredential` table
(secret fields such as Aadhaar, the security answer or a second login are
encrypted inside it with `PORTAL_ACCESS_ENC_KEY`, so set that key before the
first run and never change it afterwards). Sample Partnership / LLP /
Private Limited cases (`seed-registration-samples.ts`) are no longer part of
the seed — the app starts clean; that script is for development databases
that still hold the old demo staff.
To autofill portal logins and registration forms, build the Chrome extension
and load it unpacked:

```bash
docker compose --profile tools run --rm extension-build   # → extension/dist
# chrome://extensions → Developer mode → Load unpacked → extension/dist
```

It works with the CRM at `http://localhost:8080` or `http://127.0.0.1:8080`
(and the dev server on :5173); it reaches the API through the CRM's own
`/api/` proxy. A CRM on any other address needs adding to
`extension/src/security/context-validator.ts` and the manifest.

**Private Limited post-registration compliance.** `migrate` creates the
`PostRegistrationCompliance` table like any other additive schema change.
Marking a Private Limited case Completed (with its Date of Incorporation)
starts INC-20A (due +180 days) and ADTC (due +30 days); the `api` sends
reminder notifications every 20 / 7 days until each is completed. The
defaults can be changed in `.env.docker` — `ADTC_OFFSET_DAYS`,
`ADTC_TRIGGER_LABEL`, `INC20A_REMINDER_EVERY_DAYS`, `ADTC_REMINDER_EVERY_DAYS`
(see `.env.docker.example`). LLP works the same way: completing an LLP
registration starts **LLP Form 3 – Initial LLP Agreement** (due +30 days; its
"Due Soon" window is `LLP_FORM3_DUE_SOON_DAYS`), shown on the LLP Dashboard and
the case's Post-Registration Compliance tab. `migrate` adds the new columns
(LLPIN/CIN on the case, assignee and completed-by on each compliance).
Nothing to run by hand.

**Organization clients.** `migrate` adds the new columns like any other
additive schema change — `Client.isOrganization`, `shortName` and
`parentClientId`, `Lead.leadType` and `contactPerson`, and
`ClientDocument.sourceRequestId`. Existing leads and clients stay individual
until someone chooses otherwise. Merged files saved to an organization's
documents are written to the `auditos-uploads` volume with every other client
document; the "Consolidated" (and, if missing, "TDS") document category is
created on first use. Nothing to run by hand.

**Client visibility by assigned staff.** `migrate` adds
`Client.secondaryManagerId` (second staff) and the `clients.view_all`
permission. The permission joins the HRMS module, so Admin, Senior Associate
and Super Admin pick it up automatically and keep seeing every client.
Associates and Interns (no HRMS module) then see only the clients they are
assigned to — as account manager, second staff, or on one of the client's
services or its GST profile. Giving a role the HRMS module in Settings →
Roles & permissions also lets it see every client. Nothing to run by hand.

**Accounts.** There are no demo logins. Put `OWNER_SUPERADMIN_EMAIL`,
`OWNER_SUPERADMIN_PASSWORD`, `OWNER_ADMIN_EMAIL` and `OWNER_ADMIN_PASSWORD` in
`docker/.env.docker`; `migrate` creates those two logins after the seed (and
leaves their passwords alone on later runs). The Admin then adds everyone else
in Settings → Users.

**Database only, for native development** (`npm run dev:full` against it):

```bash
cd docker && docker compose up -d postgres adminer
```

`.env.docker` is git-ignored — never commit real secrets. The project name is
fixed (`auditos-new`) and the volumes are explicitly named, so moving this
file did not detach existing containers or data.

**Client document links.** `migrate` creates the `ClientDocumentShareLink`
table. A client's Documents tab → **Share with client** makes a live,
read-only link (`/portal/documents/<token>`) that needs no login; set
`PUBLIC_APP_URL` so the link uses the address clients can reach.
