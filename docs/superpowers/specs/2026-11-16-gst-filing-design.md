# GST Filing (Workstation → Services → GST Filing): design

Approved in conversation on 2026-11-16. It builds on the existing GST engine (approach A).

## Problem
The GST engine (GstProfile → GstCompliancePeriod → GstFiling, the GSTR-1/2B/3B stages, reminders) can never hold clients. No production code creates a `GstProfile`, so the GST dashboard always shows 0. Meanwhile "GST Filing" exists only as a one-off ClientService with a fixed due date.

## Decisions (user)
- **Who appears:** only clients with the **GST Filing** service.
- **Data received:** staff tick it by hand, or a client portal upload sets it automatically.
- **Jobs:** a separate **GSTR-1** job and **GSTR-3B** job per client per month.
- **Tasks module:** not linked. Everything is tracked on the GST page.
- **Review step:** none. Start → Finish by the same person, and the audit log records who filed.

## 1. Enrolment
- When a ClientService for the "GST Filing" service is created or reactivated:
  - Upsert `GstProfile` for the client: `gstin` = client GSTIN, `assignedEmployeeId` = the service assignee, `filingFrequency` = monthly unless already set, `active` = true.
  - If the client has no GSTIN, don't create a profile. The client is listed under **Needs setup**, and the profile is created once a GSTIN is saved.
- When the service is ended or deleted, set `GstProfile.active = false`. Past periods are kept.
- A boot-time, idempotent backfill enrols existing GST Filing clients.

## 2. Monthly generation
- Add a step to the existing daily compliance job. For each active profile, ensure the period for the **previous month** exists, using `kindsOwed()`. Quarterly filers get it only in quarter-end months.
  - Upsert `GstCompliancePeriod` and the `GstFiling` rows for GSTR-1 and GSTR-3B (status `not_started`).
  - Due dates come from `createRuleResolver`/`dueForProfile`.
- It is idempotent through the existing unique keys. If the server is down on the 1st, the next day's run catches up.

## 3. Data received
- New columns on `GstCompliancePeriod`:
  - `dataStatus` (`pending | received`, default `pending`)
  - `dataReceivedAt`
  - `dataReceivedBy` (user id, or `portal`)
  - `dataRequestDocId`
- Generation also creates a portal document request (`ClientDocument`, status `requested`), named "GST data — <Mon YYYY>", and stores its id.
- A portal upload to that request sets `dataStatus = received`, `dataReceivedBy = portal`.
- Endpoints:
  - `POST /api/gst/periods/:id/data` with `{ received: boolean }` (staff tick or untick)
  - `POST /api/gst/periods/data/remind` with `{ period_ids[] }`. It reuses the existing GST email and WhatsApp reminder sending.
- **This is a schema change.** Rehearse safe-push on a copy of the production backup before deploying.

## 4. Page: `/workstation/services/gst-filing`
- Sidebar: under Services, next to TDS, Books and Tally Export.
- The month picker defaults to the previous month.
- Tiles: Clients · Data pending · GSTR-1 filed · GSTR-3B filed · Overdue.
- **Tabs**
  - **Data pending:** Mark received, Send reminder, and bulk reminder.
  - **GSTR-1:** status, due date, days left, assignee, ARN.
  - **GSTR-3B:** the same, plus net payable and challan.
- A **Needs setup** strip for clients with no GSTIN.
- **Job actions**
  - **Start** sets `in_preparation` and records `preparedAt`. If data is still pending, it shows a warning but does not block.
  - **Finish** is a form:
    - GSTR-1: ARN and filed date (required); taxable value and tax (optional).
    - GSTR-3B: ARN and filed date; liability, ITC and net payable; payment date and challan, or nil.
    - Saving sets `filed` and fires the existing GSTR*_FILED audit entry and notification.
  - **Reopen** goes through the existing rework transition and is audited.
- Overdue shows in red once the due date has passed and the job isn't filed.
- The old Registration → GST tabs for GSTR-1/2B/3B link to this page. GST registration cases stay where they are.

## 5. Engine change for Start → Finish
- Relax `assertGstr1Transition` and `assertGstr3bTransition` so that `in_preparation` → `filed` is allowed. The ARN and filed date are still mandatory (`assertFilingRecord`).
- The `under_review` path stays available but is optional.

## 6. Access
- Reading uses the existing `workstation.gst.read`; writing uses `workstation.gst.manage`.
- Client visibility goes through `assignedClientIds`. An Associate sees the clients they are the GST assignee for.

## 7. Tests
Vitest, backend:
- enrolment on service add, removal and missing GSTIN
- monthly generation: idempotent, quarterly months
- data tick and portal-upload auto-receive
- Start → Finish without review, ARN required
- the reminder endpoint, and the scope (assigned versus all clients)

Frontend: build and type check, and a crawl of the new page.

## Out of scope
- Tasks module links.
- Filing to GSTN: a filing is recorded, never transmitted.
- GSTR-9 and GSTR-4.
