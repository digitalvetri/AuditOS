# Audit files

One **audit file** per client × financial year × audit type (statutory, tax,
internal, stock, bank, GST, concurrent, other). It holds everything SA 230
asks an audit file to show — who did what, who reviewed it, the evidence, the
conclusions — and is frozen once assembled.

Tables: `AuditEngagement` and its children in `backend/prisma/schema.prisma`
(section "AUDIT FILES"). Money is paise (`BigInt`), sent over the API as
numbers via the existing `toNum` boundary. Dates are `YYYY-MM-DD` strings,
IST.

## Lifecycle

```
planning → fieldwork → review → reporting → signed → archived
```

- **Planning**: client acceptance checklist approved by a partner
  (`acceptanceApprovedAt`), team added, each member declares independence,
  materiality (SA 320) and risks (SA 315) recorded.
- **Fieldwork / review**: working papers prepared and signed off by the
  preparer, then reviewed by a different person. A working paper cannot be
  marked reviewed while any of its review notes is not cleared.
- **Sign**: only the signing partner. Blocked (422 `sign_blocked`, with the
  list of blockers) while any working paper is not reviewed, any review note
  is open, acceptance is not approved, any team member has not declared
  independence, or any applicable checklist item is still `pending`. Sets
  `reportDate`, `opinionType`, `reportPlace`, and `assemblyDueDate =
  reportDate + 60 days`. A UDIN can be recorded with it.
- **Lock** (`lockedAt`): signing partner or manager, any time after signing;
  the app reminds from `assemblyDueDate`. After the lock every write returns
  **423 `file_locked`**, except an **addendum**: body `{ addendum: true,
  addendum_reason }` by the signing partner or manager, which creates
  records marked `isAddendum` (SA 230 para A24) and is audit-logged.

## Permissions (Workstation module)

`workstation.audit.read`, `workstation.audit.manage` (create files, edit,
prepare working papers), `workstation.audit.review` (review sign-off, clear
notes), `workstation.audit.sign` (sign and lock — and only when the caller is
the file's signing partner). Every route also runs the client-visibility
check (`assertCanSeeClient` / scope) like the rest of Workstation. Every
write calls `writeAudit`. Maker-checker: the preparer of a working paper or
checklist item can never review it.

## API — `/api/audits`

| Method | Path | Body / query | Notes |
| --- | --- | --- | --- |
| GET | `/` | `client_id, financial_year, audit_type, status, mine=1, q` | List with `progress` (see below) |
| POST | `/` | `client_id, financial_year, audit_type, title?, engagement_letter_id?, signing_partner_id?, partner_membership_no?, manager_id?, planned_start_date?, planned_report_date?` | Creates code `AUD-YYYY-NNNN`, seeds the default working-paper index for the type, adds signing partner + manager to the team |
| GET | `/:id` | | File with `client`, `team`, `materiality`, `progress`, `blockers` (what still stops signing), `locked` |
| PATCH | `/:id` | any create field, `status` | Status may move forward or back one step before signing |
| POST | `/:id/acceptance/approve` | | Partner only; requires the `acceptance` checklist complete |
| PUT | `/:id/materiality` | `benchmark, base_paise, percent, performance_percent (default 75), trivial_percent (default 5), rationale` | Server computes overall, performance, clearly-trivial |
| POST | `/:id/sign` | `report_date, opinion_type, report_place, udin?` | See Sign above |
| POST | `/:id/lock` | | |
| GET/POST | `/:id/team` | POST `employee_id, role` | |
| DELETE | `/:id/team/:memberId` | | Not the signing partner |
| POST | `/:id/team/declare-independence` | `note?` | The caller's own row |
| GET/POST | `/:id/working-papers` | POST `ref, section, area?, title, objective?, procedure?, assigned_to?` | `ref` unique per file |
| PATCH | `/:id/working-papers/:wpId` | `title, area, objective, procedure, conclusion, assigned_to, section` | Not when `reviewed` (reopen first) |
| POST | `/:id/working-papers/:wpId/prepare` | | Sets prepared by/at, status `prepared`; requires a conclusion |
| POST | `/:id/working-papers/:wpId/review` | | Reviewer ≠ preparer; no uncleared notes |
| POST | `/:id/working-papers/:wpId/reopen` | `reason` | Clears review sign-off |
| POST | `/:id/working-papers/:wpId/files` | multipart `file` | Content-checked, sha256 stored |
| GET | `/:id/working-papers/:wpId/files/:fileId` | | Download; audit-logged |
| DELETE | `/:id/working-papers/:wpId/files/:fileId` | | Soft delete; never after review or lock |
| GET/POST | `/:id/review-notes` | GET `status`; POST `working_paper_id?, note` | |
| POST | `/:id/review-notes/:noteId/respond` | `response` | |
| POST | `/:id/review-notes/:noteId/clear` | | Raiser, manager or signing partner |
| GET/POST | `/:id/risks` | `area, assertion?, description, level, fraud_risk, response?, working_paper_refs?` | |
| PATCH/DELETE | `/:id/risks/:riskId` | | |
| GET/POST | `/:id/observations` | `title, description, area?, severity, kind, amount_paise?, adjusted?, report_impact, owner_id?, due_date?` | `ref` `OBS-01`… assigned by server |
| PATCH | `/:id/observations/:obsId` | any field, `management_response`, `status` | |
| GET | `/checklist-templates` | | Templates with item counts |
| GET | `/:id/checklists/:templateCode` | | Items merged with this file's responses, plus counts |
| PUT | `/:id/checklists/:templateCode/:clause` | `answer, remarks, working_paper_ref` | `clause` URL-encoded |
| POST | `/:id/checklists/:templateCode/:clause/review` | | Reviewer ≠ preparer |
| GET | `/:id/export` | | Zip: `index.html` (file summary, team, materiality, risks, working-paper index with sign-offs, review notes, observations, checklists, UDINs) + `working-papers/<ref>/<file>` — the peer review pack. Audit-logged |
| GET | `/udins` | `from, to, client_id, partner_id, include_revoked` | Firm-wide register |
| POST | `/udins` | `client_id, engagement_id?, udin, document_type, document_description?, document_date, partner_id?, membership_no, generated_on` | UDIN format: 2-digit year + 6-digit membership number + 10 uppercase alphanumerics; the membership number inside must match |
| POST | `/udins/:udinId/revoke` | `reason` | |
| GET | `/udins/missing` | | Signed files with a report date but no UDIN |

`progress` = `{ working_papers: { total, prepared, reviewed }, review_notes_open, observations_open, checklist_pending, team_undeclared }`.

## Checklists

Templates are data (`AuditChecklistTemplate` / `AuditChecklistItem`), seeded
by `backend/prisma/seed-audit.ts` and editable later. Seeded:

- `acceptance` — client acceptance / continuance (SQC 1): integrity of
  management, competence and capacity, independence and conflicts, previous
  auditor communication (s.140 / ICAI Code clause (8)), fee and engagement
  letter, ADT-1 consent and eligibility (s.141).
- `caro_2020` — the Companies (Auditor's Report) Order 2020, para 3 clauses
  (i) to (xxi) with their sub-clauses, as short headings.
- `form_3cd` — Form 3CD under the Income-tax Act, 1961 (clauses 1 to 44),
  for tax audits up to FY 2025-26. Tax years from 2026-27 fall under the
  Income-tax Act, 2025: add its form as a new template rather than editing
  this one.
- `completion` — SA 230 assembly, SA 560 subsequent events, SA 580 written
  representations, SA 450 misstatements evaluated, SA 700/705 opinion, going
  concern (SA 570), related parties (SA 550), EQCR where required.

Headings are short descriptions, not the statutory text; read the Order /
the form for the exact wording.

## Default working-paper index

Seeded on create, by type. Statutory audit:

- A Planning: A-1 Engagement letter and acceptance, A-2 Independence, A-3
  Understanding the entity, A-4 Materiality, A-5 Risk assessment, A-6 Audit
  plan
- B Controls: B-1 Internal control evaluation
- C Execution: C-1 Cash and bank, C-2 Trade receivables, C-3 Inventory, C-4
  Property, plant and equipment, C-5 Investments and loans, C-6 Borrowings,
  C-7 Trade payables, C-8 Revenue, C-9 Purchases and expenses, C-10
  Employee costs, C-11 Taxation, C-12 Equity and reserves, C-13 Related
  parties
- D Completion: D-1 Subsequent events, D-2 Going concern, D-3 Management
  representations, D-4 Summary of misstatements
- E Reporting: E-1 Draft financial statements, E-2 Auditor's report and
  CARO, E-3 Signed report and UDIN

Tax audit: A-1..A-4, then T-1 Books and method of accounting, T-2 Form 3CD
working, T-3 Disallowances (s.40, 40A, 43B), T-4 TDS compliance, T-5
Depreciation, T-6 Loans and deposits (s.269SS/ST/T), E-3 Signed report and
UDIN. Other types get the planning, completion and reporting sections only.
