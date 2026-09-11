# GST Module — Frontend Overview

**Companion to:** [`README.md`](./README.md) (the product spec)

This document describes what has actually been built on the frontend and where each piece lives. Read this after the spec if you want to know how the pieces map to code — read this instead of the spec if you just want a walkthrough of the UI.

---

## Important framing first

We did **not** build a replacement for the government's GST portal (`gst.gov.in`). We built a **wrapper inside JNS Accounting Solutions** that guides an operator through the work they still have to do on the external portal, tracks what's outstanding, and captures what came back. The portal itself stays where it is — the government owns it.

## What "handoff" means

The GST portal is session-based and login-gated. A deep link into an internal page bounces to the login screen and loses the destination. So we can't just link a client's "Return Filing" case to an external URL — it won't land where the operator needs to go.

The **handoff** is the pattern that solves this. When an operator opens a service, we show them a guided 4-step flow:

1. **Open the portal** — with the correct URL for that service, and (for post-login pages) reveal the client's credentials from a vault
2. **Follow the click-path** — after login, they have to click through a specific menu path inside the portal. We render that path as a visual breadcrumb they can just eyeball.
3. **Copy-ready field sheet** — the values they'll type into the portal form, laid out with per-row and Copy-all-at-once buttons
4. **Capture the output** — the ARN / TRN / acknowledgement they'll paste back into JNS after filing

Some services are pre-login (new Registration, e-invoice portal) and get a direct deep link. Everything else opens the portal home and relies on the click-path.

Every service in the module uses this pattern. It lives in `src/pages/workstation/gst/GstServiceHandoff.tsx`.

---

## Pages and features

### 1. Landing — `/workstation/services/gst`

`src/pages/workstation/gst/GstServicesLanding.tsx`

The entry point when you click **Workstation → Services → GST** in the sidebar. Four things live here:

- **"At a glance" summary strip** — four clickable tiles at the top: overdue obligations, open obligations, open cases, notice checks due. Counts aggregate across every service so an operator sees the total GST workload without clicking around.
- **"Weekly notice check" shortcut card** — flagged as the *highest-value single feature* per spec §8. One click lands on the discovery workflow.
- **12 service cards** — 3-column responsive grid. Each card shows an icon, form number (REG-01, GSTR-1/3B, etc.), a shape chip (Recurring / Project / Externally triggered / Retainer), a two-line summary, the portal destination, and two actions: a big **Open guided handoff** button + a small external-link icon that jumps straight to the portal.
- **Workspace-shapes legend** at the bottom explaining what "recurring / project / externally triggered / retainer" mean.

The 12 services are the 8 from spec §2 plus the 4 additions from spec §6:

| # | Service | Form | Shape |
|---|---|---|---|
| 1 | Registration | REG-01 | Project |
| 2 | Return Filing | GSTR-1 / 3B / CMP-08 | Recurring |
| 3 | Annual Return Filing | GSTR-9 / 9C | Recurring |
| 4 | Notice Reply | varies | Externally triggered |
| 5 | Amendment | REG-14 | Project |
| 6 | Cancellation | REG-16 | Project |
| 7 | LUT Filing | RFD-11 | Recurring |
| 8 | E-Invoicing Support | — | Retainer |
| 9 | Refund | RFD-01 | Project |
| 10 | Appeal | APL-01 | Externally triggered |
| 11 | Composition scheme opt-in | CMP-02 | Recurring |
| 12 | Composition scheme opt-out | CMP-04 | Recurring |

Data source: `src/pages/workstation/gst/services.ts`

### 2. Per-service handoff page — `/workstation/services/gst/:slug`

`src/pages/workstation/gst/GstServiceHandoff.tsx`

Where the guided flow actually plays out. Top to bottom:

- **Header** — service name, form number, shape chip, one-line summary
- **Client picker** — a dropdown of every workstation client (real API data via `workstationApi.listClients()`). Selection persists in the URL as `?client=<id>`, so the URL is shareable and refresh-safe.
- **Workspace shortcut** — "Open period board" (recurring) or "Open case pipeline" (project / externally-triggered). Hidden for retainers.
- **"What the firm actually does"** panel — operational detail from the spec, framed as guidance to whoever's doing the work
- **Step 1 — Open the portal + credential vault** (see §3 below)
- **Step 2 — Click-path breadcrumb** — the exact menu clicks rendered as visual chips, e.g. `Services › Returns › Returns Dashboard`
- **Step 3 — Copy-ready field sheet** with a **Copy full sheet** button in the header that dumps every field as a labeled block to the clipboard, ready to paste into a note next to the browser
- **Step 4 — Capture the output** — a list of fields the operator will record back (ARN, TRN, acknowledgement PDF)

### 3. Credential vault UI

`src/pages/workstation/gst/CredentialVault.tsx`

Renders inside Step 1 for post-login services:

- **Masked by default** — username shows last-2 chars, password shows dots
- **Reveal button** — disabled until a client is picked; on click, values appear and the button flips to **Mask (30s)** with a live countdown
- **Auto re-mask after 30 seconds** so a left-open tab doesn't leak credentials
- **Auto re-mask on client switch** — picking a different client wipes any active reveal
- **Copy button per row** — only enabled while revealed
- **Audit-log notice** in the footer — "Every reveal is audit-logged with the operator, timestamp and service."

For pre-login services (Registration, E-Invoicing) we render `CredentialsNotNeededNote` instead: "This destination is pre-login — no client credentials required."

> **Honest caveat:** the placeholder credentials are derived from the client name via a hash — they are NOT real portal logins, and nothing is encrypted. The real encrypted vault + RBAC + persisted audit log is the deferred security PR (task #5). See the "What's real vs placeholder" table below.

### 4. Shape-based workspaces — `/workstation/services/gst/:slug/workspace`

`src/pages/workstation/gst/GstWorkspace.tsx` (dispatcher)

A single URL that dispatches to one of three UIs based on the service's shape.

**Recurring** (Return Filing, Annual Return, LUT, Composition opt-in / opt-out) → **Period board**
`src/pages/workstation/gst/RecurringWorkspace.tsx`

- Prev / next / current-period selector
- Six-cell status summary (Total, Not started, In progress, Ready to file, Filed, Overdue) — clickable filters
- Per-client row: name, GSTIN, assignee (real account manager), due date (red if past), status pill, ARN (if filed), and "Open handoff →" link that carries `?client=<id>` through

**Project + Externally triggered** (Registration, Amendment, Cancellation, Refund, Notice Reply, Appeal) → **Case pipeline**
`src/pages/workstation/gst/ProjectWorkspace.tsx`

- Eight-cell stage summary (Not started / Documents pending / In progress / Under review / Submitted / Officer query / Completed / Failed)
- Per-case row: case ID, client, reference (PAN for Registration, GSTIN for others), assignee, opened date, **days-in-stage** (red if > 3), stage pill
- **New case** button on regular project services; hidden on externally-triggered ones (Notice Reply / Appeal) because those cases arrive from discovery, not operator action
- Externally-triggered variant gets an extra "Notice" column showing the notice reference

**Retainer** (E-Invoicing) → redirects back to the handoff page — retainers have no periodic obligations or discrete cases.

### 5. Weekly notice-check discovery — `/workstation/services/gst/notice-check`

`src/pages/workstation/gst/NoticeCheck.tsx`

The feature the spec calls out as highest-value in the whole module. The reason: the portal doesn't push notifications reliably, and a missed ASMT-10 becomes a DRC-01 becomes a demand order. A weekly per-client sweep of the notices tab catches this cheaply.

- **Four summary tiles** — Due this week / Coming up / Recently checked / Open cases. First three are clickable priority filters.
- **Client table** sorted by "days since last checked", worst first
- **Per-row action column** with three buttons:
  - **Check now** — opens `gst.gov.in` in a new tab with a tooltip showing the click-path
  - **No notices** — logs the row as clear
  - **Found notice** — flags that a Notice Reply case should be queued (would create it via the engine)
- **After marking**, the row shows the outcome badge (green "No notices — logged" or red "Case queued") with a small "Change to …" link if the operator got it wrong
- **localStorage persistence** — outcomes survive refresh, hard reload, closing and reopening the tab. Stored under `audit-os:gst-notice-check`.
- **"days since" recalculates from the real timestamp** on every render, so a client marked today shows "today", tomorrow shows "1d ago", and eventually flips back to "Due this week"
- **Reset log** button in the header once at least one client is logged

Storage layer: `src/pages/workstation/gst/noticeCheckStore.ts` — kept behind a small interface so when the real backend lands, only that one file changes.

---

## Shared internals

| File | Purpose |
|---|---|
| `src/pages/workstation/gst/services.ts` | The 12-service catalogue — names, forms, shapes, portal URLs, click-paths, field sheets, capture fields |
| `src/pages/workstation/gst/placeholder.ts` | Deterministic hash-based generators so landing counts, workspace counts and notice-check counts all agree on the same numbers |
| `src/pages/workstation/gst/noticeCheckStore.ts` | localStorage read/write layer for the notice-check outcomes |
| `docs/gst-services/README.md` | The product spec (companion to this doc) |

---

## What's real vs placeholder

| | Real | Placeholder |
|---|---|---|
| Service catalogue (names, forms, click-paths, portal URLs) | ✅ | |
| Client list in dropdown / workspaces / notice-check | ✅ (from `workstationApi.listClients()`) | |
| Account manager on each row | ✅ | |
| Selected-client GSTIN / PAN / company name in the field sheet | ✅ | |
| Obligation status / ARN / due date | | Hash-derived per client |
| Case ID / stage / days-in-stage | | Hash-derived per (client, service) |
| Notice-check timestamps | ✅ once marked (localStorage) | Hash-derived until the operator marks it |
| Credential vault values | | Hash-derived from client name |
| Credential encryption / RBAC / audit log persistence | | Deferred — needs the security PR |
| Portal URLs | ✅ | |
| Backend endpoints for obligations / cases / vault | | Deferred — tasks #4 + #5 |

Anything hash-derived stays stable across renders — the same client always shows the same status until real backend replaces the generator.

---

## Where this fits in the bigger picture

This PR delivers a **working front-end shape** that maps 1:1 to the spec, so any next session (real backend, real vault) can slot into it without rework. The interfaces the frontend consumes are narrow:

- `workstationApi.listClients()` — already real
- `noticeCheckStore.ts` — swappable to API without touching UI
- Placeholder generators in `placeholder.ts` — swappable to `useQuery` calls one file at a time

That's why the deferred backend PR is small in scope even though it looks big — the surface it has to hit is already carved out.
