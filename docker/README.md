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

Start order is enforced: `postgres` healthy → `migrate` completes → `api` → `web`.

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

**Database only, for native development** (`npm run dev:full` against it):

```bash
cd docker && docker compose up -d postgres adminer
```

`.env.docker` is git-ignored — never commit real secrets. The project name is
fixed (`auditos-new`) and the volumes are explicitly named, so moving this
file did not detach existing containers or data.
