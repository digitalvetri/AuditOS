# GST IMPLEMENTATION STATUS

Centralized GST compliance service.

**Location (fixed):** Audit OS → Workstation → Services → **Registration** →
**GST Registration** — i.e. `/workstation/services/registration/gst`.

Not under Tools. Not under Workstation → Services → GST (the existing
8-service portal-handoff landing there is out of scope and untouched).

---

## Current phase

**Phase 1 (re-run under the revised spec) — old-GST inspection — COMPLETE.**
Next: **Phase 2 — remove/replace the old GST.** BLOCKED pending the user's
decision on the removal list below; nothing has been deleted.

Phase numbering follows the revised spec (§47). Work already finished maps to
it as: **P3 database schema — done**, **P4 client + period management — done**,
**P5 central dashboard — partially done** (summary cards, central table and
drill-down exist; Today's Work queues per §8–§10 are not built yet).

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

Phase 3 client + period management · Phase 4 dashboard · Phase 5 GSTR-1 ·
Phase 6 GSTR-2B · Phase 7 reconciliation · Phase 8 GSTR-3B · Phase 9
calendar/due dates · Phase 10 assignment · Phase 11 Task integration ·
Phase 12 exceptions · Phase 13 reports · Phase 14 audit trail · Phase 15
search/filters/drill-down · Phase 16 testing · Phase 17 UI + performance.

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
