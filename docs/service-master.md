# Service master (JNS scope of work)

Source: `JNS_Service_Master_Scope_of_Work.docx` (15 services, 257 activities).

## What it does

The document asked for five things. Each is listed with where it lives in AuditOS.

1. **Each main service is a selectable item, with its sub-service and billing frequency.**
   - Open it from Engagement letters → **Service master** (`/workstation/engagement/service-master`).
   - Services are grouped by main service: GST, TDS / TCS, Incorporation, Registration, Accounting, Internal audit & review.
   - Each has a billing frequency, and optionally the Workstation service it covers.
2. **Every activity is its own selectable scope item.**
   - Each line of the document is one row, kept under its heading: Scope of services, Typical deliverables, Client responsibilities, Exclusions, Important note.
   - A partner can edit, reorder, add or remove lines, and choose whether each one starts ticked.
3. **The standard scope is the starting point; untick what isn't in the package.**
   - In an engagement letter, click **Add services**, pick the services and untick activities.
   - Each service is written into the letter as an ordinary section, so it can still be edited on the page. Its fee line is also added.
4. **Client-specific fees, timelines, information requirements, deliverables and exclusions.**
   - The same dialog has fields for the fee, frequency, timeline, information required, extra deliverables and extra exclusions.
5. **Get written acceptance before starting.**
   - A letter already moves draft → sent → accepted.
   - Each service on a client's Services tab now shows a chip: *Engagement accepted* / *Letter sent · awaiting acceptance* / *Letter in draft* / *No engagement letter*.
   - The chip is a warning only; it does not block work. Automatic filings and tasks keep running.

## Data

- `ServiceMaster` and `ServiceMasterItem` are new tables. `EngagementLetter.serviceScopes` (JSON) records the services picked and the activities kept.
- They are seeded from `backend/prisma/data-jns-service-master.ts` by `prisma/seed.ts` on every deploy.
  - The seed is **create-only by code**, so the firm's later edits are never overwritten.
  - A Workstation service link is set only when that service code exists.
- Editing the master affects letters written afterwards. A letter keeps its own words.

## Access

- **Read:** anyone who can read engagement letters.
- **Edit:** organisation-wide engagement manage (partners).
- Switching off the *Engagement letters* page for an employee also removes the service master.

## Defaults to confirm

The document gives no billing frequencies or main-service groups. These were set from the service names and can be changed in the Service master:

| Billing frequency | Services |
|---|---|
| Monthly | GST returns, GST advisory, TDS advisory, Bookkeeping, MIS, Monthly internal audit |
| Quarterly | TDS returns, TCS returns, Quarterly internal audit |
| Yearly | GST annual return |
| One-time | Pvt Ltd incorporation, LLP incorporation, GST registration, GST amendment/cancellation, Business health check |
