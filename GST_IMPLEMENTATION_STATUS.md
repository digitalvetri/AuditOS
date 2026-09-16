# GST IMPLEMENTATION STATUS

Centralized GST compliance service.

**Location (fixed):** Audit OS → Workstation → Services → **Registration** →
**GST Registration** — i.e. `/workstation/services/registration/gst`.

Not under Tools. Not under Workstation → Services → GST (the existing
8-service portal-handoff landing there is out of scope and untouched).

---

## Current phase

**Mobile pass — COMPLETE (§45).**

GST does NOT use the shared table-to-card transform on phones. That transform
renders every column as a label/value line — eleven of them for GSTR-3B, 369px
per client, with nothing marking where one client ends and the next begins.

`GstMobileCard.tsx` replaces it below 768px: one bordered card per client with
a 12px gap between, carrying four things only — the client name as the
headline, GSTIN + period muted beneath, the stage status and due date on one
line, and at most three figures that decide what to do next (GSTR-3B shows net
payable, liability, assignee; GSTR-2B shows ITC and reconciliation state). The
desktop tables are rendered inside `hidden md:block` and are untouched.

**369px → 137px per client**, verified at 320 and 390px, no horizontal
overflow, table correctly hidden on mobile and cards correctly hidden above
768px.

Also fixed in this pass: `sm:` breakpoints replaced with `md:` (this project's
mobile layer is `max-width: 767px`, so `sm:` was giving a 700px tablet the
phone layout), and the three dashboard stage cards gained a mobile grid — four
tiles in 350px had been breaking "Reconciled" into "Reconcile d". Touch
targets: of 21 elements under 44px only one was GST's, fixed with a `.m-gst`
scoped rule so other modules' filter bars keep their own metrics.

**Previously: the write layer — COMPLETE.** GST is no longer read-only: every stage can
be advanced, every figure entered, filings and payments recorded, and people
assigned. Covers P11 (assignment) and the workflow halves of P6/P7/P9.

### What became editable

`GstPeriodDetail.tsx` at `periods/:periodId` is the §27 client detail and the
one place work happens — every list row navigates to it. **That route did not
exist before this pass: the tables navigated to it and hit nothing.**

- **Update** on each stage card: status dropdown in workflow order, plus that
  stage's figures (GSTR-1 taxable value/tax; GSTR-3B liability/ITC/net
  payable; GSTR-2B available and download dates, ITC).
- Choosing **Filed** reveals ARN + filing date, above the line *"Audit OS does
  not file returns. File on the GST portal, then record the acknowledgement
  here."* (§42)
- **Record payment** — date and challan reference.
- **Edit assignment** — preparer and reviewer, from the real employee list.
- **Activity** — the §39 audit trail, read-only by construction.

Server (`validate.ts` + write routes on `/api/gst`), all requiring
`workstation.gst.manage` and re-checking client scope from the session rather
than trusting the URL (§41). Verified by API probe:

| Attempt | Result |
|---|---|
| GSTR-1 `pending → filed` | rejected — "must be reviewed and ready" |
| `filed` with no ARN | rejected — "An ARN is required" |
| proper prepare → review → file with ARN | accepted |
| GSTR-2B → `filed` | rejected — "not a GSTR-2B status" (§15) |

Two vocabularies coexist: the 45 pre-existing `GstFiling` rows carry the older
words (`not_started`, `data_preparation`, `failed`), normalised on read;
writes only ever emit the spec's vocabulary. Same approach as the Task module.

Every write appends a `GstAuditLog` row — confirmed in the database after
driving the UI: `GSTR1_UPDATED pending → data_collection`, `GSTR1_FILED
under_review → filed`, `GSTR2B_AVAILABLE`.

### Bug fixed

`GstServicesLanding.tsx` nested the portal `<a>` inside the row `<Link>` —
invalid HTML, and the only console error anywhere in the app. The two are now
siblings, with the row link taking `flex-1` where the old spacer was. All 12
service rows and 12 portal links still render. Pre-existing, unrelated to GST
compliance, fixed because it was the one error present.

**Previously:** Phases 6, 7 and 9 — the GSTR-1 / GSTR-2B / GSTR-3B work sections.

Previously: **Phase 1 (re-run under the revised spec) — old-GST inspection — COMPLETE.**
Next: **Phase 2 — remove/replace the old GST.** BLOCKED pending the user's
decision on the removal list below; nothing has been deleted.

Phase numbering follows the revised spec (§47). Done so far: **P1** inspection,
**P3** database schema, **P4** client + period management, **P5** central
dashboard *(partial — the §8–§10 Today's Work queues are still missing)*,
**P6** GSTR-1, **P7** GSTR-2B, **P9** GSTR-3B.

### P6 / P7 / P9 — the three work sections

`GET /api/gst/stages/:stage` (gstr1 | gstr2b | gstr3b) returns a stage-specific
summary AND the client list, counted over the whole filtered set rather than
the current page. One handler serves all three: they differ only in summary
keys and columns, and three copies would have meant three places to fix a
due-date rule.

`GstStagePage.tsx` renders them. The summary tiles ARE the filter — clicking
"Overdue" narrows the list below instead of opening another screen, so a count
and its names can never disagree (§38 drill-down).

Columns follow the spec exactly: §12 for GSTR-1 (FY, period, due, days, ARN),
§14 for GSTR-2B (available date, ITC, reconciliation status — **no due date
column and no ARN**), §19 for GSTR-3B (liability, eligible ITC, net payable,
payment status).

Verified in a browser: **the string "Filed" appears 0 times on the GSTR-2B
page** (§15), and all three render with live counts and 25 rows each.

Money columns on GSTR-3B currently show "—" because no liability or ITC has
been entered yet. That is honest empty state, not a bug: the columns populate
when Phase 9's data-entry actions are built.

---

## Old GST removed

**NOT YET.** Five distinct GST implementations exist. Inventory:

### A. Workstation → Services → GST — *the old GST* → REMOVE
Frontend only; no server module, no database, no persistence.
- `src/pages/workstation/gst/` — 10 files (landing, handoff, 3 workspaces,
  CredentialVault, NoticeCheck, catalogue, 2 stores)
- `src/App.tsx` — 4 routes (241, 244, 245, 246)
- `src/shell/v2/Sidebar.tsx:111` — the "GST" entry under Services
- `docs/gst-services/` — 2 markdown files
- §52's final structure lists no GST under Services, so this goes.

**Two things are lost with it, and nothing in the new spec replaces them:**
- `NoticeCheck.tsx` (368 lines) — GST notice reply workflow
- `CredentialVault.tsx` (196 lines) — client portal credentials

**One hard blocker:** `src/pages/workstation/tds/TdsServicesLanding.tsx:244`
links to `/workstation/services/gst/notice-check`. Deleting that page breaks
**TDS**, which §4 forbids. NoticeCheck must be relocated or kept, not deleted.

### B. Tools → Audit Automation → GST reconciliation → REMOVE NAV, KEEP ENGINE
- Server: `gst.routes.ts`, `GstMatchingService`, `Gstr2BService`,
  `GstReconJobService`, `GstReconExportService`, `gstr2bExcel`, `gstr2bJson`
- Web: `GstJobsList`, `GstNewRecon`, `GstReconDetail`, `tools/audit-automation/gst.ts`
- Routes: `src/App.tsx` 283–285 · Models: `AaGstReconJob`, `AaGstReconRow`,
  `AaGstFiling2B`, `AaPurchaseRegister`
- Permissions: `tools.audit_automation.gst.upload` / `.view`

§3 says no GST under Tools, but §17 needs reconciliation and §43 says reuse
accounting rather than duplicate. Recommendation: **drop the Tools-side
pages/routes so no GST appears under Tools, keep the matching engine and
GSTR-2B parsers as an internal service the new Reconciliation calls.**
Deleting the engine means rewriting invoice matching and both 2B parsers.

### C. Tools → "GST JSON ⇄ Excel" converter card → DECISION NEEDED
`src/modules/tools/registry.ts:137`, route `/tools/gst-json-excel`,
permission `tools.gst_json_excel`. Named GST and sits under Tools, but it is a
generic file converter, not a GST module.

### D. Tools → Tally → GST tab → KEEP
`TallyGst.tsx`, `TallyGstService.ts`, `engine/gst.ts`. This is GST *inside*
the accounting engine, which §43 says to reuse. Not a GST compliance module.

### E. Shared GST schema models → KEEP
`GstProfile`, `GstFiling`, `GstReturnDraft`, `GstReturnSection`,
`GstLiabilitySnapshot`, `GstRateSlab`, `HsnMaster`.
Read by `workstation/clients.routes.ts` (client detail),
`workstation/einvoice-ewb/routes.ts` (E-Invoice & E-Way Bill) and the new
module. Removing them breaks two unrelated modules and the new GST itself.

### F. The new module (this build) → the single GST going forward
`server/src/modules/gst/`, `src/modules/workstation/gst/`,
`src/pages/workstation/registration/gst/`, mounted at `/api/gst` and
`/workstation/services/registration/gst`.

**Permissions note:** `workstation.gst.read` / `.manage` are currently used by
BOTH the old landing and the new module. They stay; only their consumer
changes.

---

## Completed

### Phase 1 — Inspection (no code)

Existing pieces this module reuses instead of rebuilding:

| Need | Existing |
|---|---|
| Client | `Client` (13 seeded) |
| Employee / User | `Employee`, `User`, cookie-session auth |
| GST client record | `GstProfile` — 1:1 with Client, 9 rows |
| Period + return lifecycle | `GstFiling` — `@@unique([gstProfileId, period, returnType])`, 45 rows |
| Return payload / tax summary | `GstReturnDraft`, `GstReturnSection`, `GstLiabilitySnapshot` (schema only, no code) |
| Invoice matching engine | Tools: `AaGstReconJob`/`AaGstReconRow`, `GstMatchingService`, `Gstr2BService`, 2B Excel+JSON parsers |
| Task + time tracking | `/api/tasks`, engine owns the clock |
| Permissions | `platform/rbac/matrix.ts` (server + web); `workstation.gst.read` / `.manage` already exist |
| Service module template | `server/src/modules/bookkeeping/{routes,service,serialize,validate}.ts` |
| Page-with-tabs template | `BookkeepingShell` / `IncorporationShell` |

Decisions taken from that inspection:

- **No rival GST tree.** The spec's `GSTClient` / `GSTCompliancePeriod` /
  `GSTR1Record` / `GSTR3BRecord` map onto the existing `GstProfile` and
  `GstFiling`. GSTR-1 and GSTR-3B stay `GstFiling` rows keyed by
  `returnType`; only what is genuinely missing was added.
- **Matching is not reimplemented.** `GstReconciliation.reconJobId` points at
  the Tools run. Nothing GST-related is added to Tools (§41).
- **Registration content is kept.** The REG-01 reference page and its run
  panel become the first tab of the new shell, not a deletion.

### Phase 2 — Database schema

Additive only. `prisma db push` reported *in sync* with no data loss;
verified after: Client 13, GstProfile 9, GstFiling 45, Task 3 — unchanged.

**New models (7):**

| Model | Purpose |
|---|---|
| `GstCompliancePeriod` | The spine: profile + financial year + period, `@@unique`. Holds derived `overallStatus` and `nextDueDate`. |
| `GstR2BRecord` | §14 — availability/download/reconciliation vocabulary. **No `filed` state and no ARN**, per §4. |
| `GstReconciliation` | §15/16 summary + link to the Tools recon job. Stored totals so the dashboard aggregates in SQL. |
| `GstReconciliationItem` | Books and 2B side by side, signed `taxDifference`, reviewer decision. |
| `GstException` | §25, optionally pointing at the reconciliation line that raised it (enables §28 drill-down). |
| `GstAssignment` | §21 append-only; preparer / reviewer / approver per stage. |
| `GstAuditLog` | §32 append-only; no update or delete path. |

**Extended (no breaking change — every new column is nullable or defaulted):**

- `GstProfile` += `legalName`, `pan`, `state`, `registrationType`,
  `reviewerEmployeeId`, `contactPerson`, `contactEmail`, `contactPhone`,
  `address`, `active`, `periods[]`
- `GstFiling` += `compliancePeriodId?`, `financialYear?`,
  `reviewerEmployeeId?`, `preparedAt`, `reviewedAt`, `taxableValue`,
  `taxAmount`, `taxLiability`, `eligibleItc`, `netPayable`,
  `filedManually`, `filedByUserId`, `paymentStatus`, `paymentDate`,
  `challanRef`, + indexes on `compliancePeriodId` and `dueDate`

**Conventions followed:** money is `BigInt` paise (matching
`GstLiabilitySnapshot`); employee ids are plain `String` with no relation
(matching `GstFiling`), so `Employee` is untouched.

---

## Remaining

**P2 remove the old GST** (blocked on the user's decision) · **P5 finish** —
the §8–§10 Today's Work queues and today's client list · **P8**
reconciliation · **P10** compliance calendar · **P11** employee/reviewer
assignment · **P12** Task integration · **P13** exceptions · **P14** reports ·
**P15** search/filter refinement · **P16** audit trail · **P17** permissions ·
**P18** testing · **P19** performance + UI polish.

Known performance item for P19: the stage endpoint tallies its summary from a
lean projection of the filtered set rather than SQL aggregates. Correct, and
fine at today's 27 periods, but §46 wants database aggregation at thousands.

## Docker

**No Docker file needed changing, and that was verified rather than assumed.**

The Task module needed care because it reads a `.sql` file at runtime that the
build script has to copy beside the compiled output. **GST has no
`readFileSync` and no SQL file** — it is pure Prisma — so `COPY src ./src` and
`COPY prisma ./prisma` pick it all up, and the compose `migrate` service's
`prisma db push` creates the seven tables. No new permission code was added,
so the existing seed covers RBAC.

One gap WAS found and closed. `seed-workstation.ts` seeds GST profiles and
filings but nothing seeded `GstCompliancePeriod`, so a fresh database — Docker
included — would have come up with 9 GST clients, 45 filings and **zero
periods**, rendering every GST screen empty with no hint why. `seed.ts` now
calls `backfillPeriods()` after `seedWorkstation`, deriving the periods from
the filings rather than adding a second fixture to keep in step.

Proved end to end on an empty database, which is the path compose takes:

    createdb → prisma db push → tsx prisma/seed.ts
    → GST periods: { created: 27, linked: 45 }
    → GstProfile 9 · GstFiling 45 · GstCompliancePeriod 27
    → all 45 filings linked to a period

The scratch database was dropped afterwards and the dev database untouched.
`docker compose up` itself was NOT run — the daemon on this machine is
inactive and needs a sudo password — so this is a verified code path, not a
verified container.

## Database changes

Phase 2 as above. `prisma db push`, additive, no reset. Docker needs no
change — compose `migrate` already runs `prisma db push` then the seed.

## API changes

None yet.

## Frontend changes

None yet.

## Tests

None yet. Planned as tsx scripts under
`server/src/modules/gst/__tests__/`, chained into `test:scripts`, matching
the Tally and Task modules.

## Known issues / watch list

- `/workstation/services/registration/:slug` is a **catch-all**. The GST
  sub-routes must be declared BEFORE it, like the `:category` case already
  flagged in `App.tsx`.
- The sidebar auto-generates Registration children from
  `REGISTRATION_SERVICES`, so the 9 sections go in an in-page tab strip
  rather than a 4th nav level. Sidebar stays untouched.
- `GstFiling.compliancePeriodId` is nullable on purpose: 45 pre-existing
  filings have no period row. Phase 3 backfills on first touch.
- No GSTN connectivity exists. `filedManually` defaults true and every
  filing screen must say "Filed — manually recorded" (§31).

## Next phase

**Phase 3 — GST client + period management:** `server/src/modules/gst/`
(routes, service, validate, serialize) mounted at `/api/gst`, period
creation/backfill from `GstProfile.filingFrequency`, financial-year
derivation, and the shell with the Registration tab preserved.
