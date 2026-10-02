# frontend/ — the AUDIT OS web app

The browser application: every screen people use (HRMS, Workstation, Tools,
Books, Messages, dashboards). React 18 + Vite + TypeScript, styled with
Tailwind, data fetched with TanStack Query.

## Why it is its own folder

- **Separate package.** It has its own `package.json`, its own dependencies
  and its own build, so frontend work never needs the backend's packages
  installed (and the other way round).
- **Separate deploy.** It builds to static files served by nginx — its own
  Docker image, independent of the API image.
- **One contract with the backend.** The only thing it knows about the server
  is the `/api/*` HTTP interface. All calls go through one adapter,
  `src/services/api.ts`.

## What is inside

| Path | What it holds |
|---|---|
| `src/main.tsx`, `src/App.tsx` | App entry and the route table |
| `src/pages/` | One file (or folder) per screen — `hrms/`, `workstation/`, `tools/`, `books/`, the dashboard |
| `src/modules/` | Feature code shared by pages: API clients, tables, cards, forms per module (attendance, payroll, workstation, books, messages, …) |
| `src/shell/v2/` | The app frame: sidebar (with its animated backdrop), top bar, global search, notifications |
| `src/components/` | Small shared UI pieces (toast, status chips, …) |
| `src/design/` | `globals.css` (CRM-wide look: floating rows, navy header strips, cards, dropdowns) and `chat.css` |
| `src/platform/` | Cross-cutting app services: auth session, role-based access (rbac), theme, notifications |
| `src/services/api.ts` | The single fetch adapter for `/api/*` |
| `src/data/` | Shared TypeScript models, plus the MSW mock backend and its seed data (mock mode) |
| `src/lib/` | Formatting, dates, hooks |
| `public/` | Static files served as-is (fonts used by the engagement-letter templates, icons) |
| `package.json` | Frontend dependencies and scripts (`dev`, `dev:api`, `dev:full`, `build`, `type-check`) |
| `.gitignore` | What git skips here: `node_modules`, `dist`, `.env`, screenshot output |
| `nginx/default.conf` | nginx config for the Docker image — serves the bundle and proxies `/api` and `/socket.io` to the API |
| `Dockerfile` | Builds the bundle, then serves it from nginx |
| `scripts/` | Headless-Chrome verification scripts (screenshots, smoke checks) |
| `.env` / `.env.example` | Vite settings: `VITE_MOCK_MODE`, `VITE_API_PROXY_TARGET`, `VITE_SHOW_DEMO_LOGINS` |

## Running it

```bash
cd frontend
npm install
npm run dev:full      # web on http://localhost:5173 + the backend API
npm run dev           # Vite dev server only
npm run build         # type-check + production bundle in dist/
npm run type-check
```

With `VITE_MOCK_MODE=true` in `.env`, the app runs without a backend (MSW
serves seeded data in the browser) — useful for HRMS/Tools screens only.
With `false`, `/api` is proxied to the backend at `VITE_API_PROXY_TARGET`.
