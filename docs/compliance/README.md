# Compliance calendar, notices, DSC register, 26AS

One calendar for every statutory obligation of every client. GST returns
(GSTR-1/2B/3B, in `modules/gst`) and TDS (`modules/tds`) keep their own
modules; the calendar API merges their due items in read-only so a partner
sees one list.

Schema: section "COMPLIANCE CALENDAR" in `backend/prisma/schema.prisma`
(`ComplianceForm`, `ClientObligation`, `ComplianceItem`, `DueDateExtension`,
`ClientNotice`, `DigitalSignature`) plus `GstNotice.responseDueDate` /
`assignedEmployeeId`.

## Due-date rules

`due = anchor + offsetMonths` months, on day `dueDay` (clamped to month end;
31 = last day), then `+ offsetDays`. Anchors:

- `period_end` — last day of the period (month / quarter / half-year)
- `fy_end` — 31 March of the financial year (annual forms)
- `fy_start` — 1 April
- `agm` — the client's AGM date for that FY (`ComplianceItem.anchorDate`);
  until it is entered, assume the last permitted day (30 September) and mark
  the item "AGM date not entered"
- `event` — no automatic due date; created by hand

`months` restricts which period-end months exist (advance tax `6,9,12,3`;
PMT-06 `4,5,7,8,10,11,1,2`; half-yearly `9,3`).

A `DueDateExtension` for (form, period) replaces the due date for every
client (optionally only some entity types). The API always returns
`statutory_due_date`, `due_date` (after extension) and `extension` (reference).

## Seeded catalogue (`backend/prisma/seed-compliance.ts`)

Statutory dates as of October 2026 (Income-tax Act 1961 as amended by the
Finance Act 2026 for FY 2025-26; tax years from 2026-27 fall under the
Income-tax Act 2025 — same calendar dates). Re-check each year and record
changes as extensions or catalogue edits.

| Code | Form | Rule | Entities |
| --- | --- | --- | --- |
| ITR_NON_BUSINESS | ITR (no business income, not audited) | fy_end +4, day 31 → 31 Jul | individual, huf |
| ITR_NON_AUDIT_BUSINESS | ITR (business/profession, not audited) | fy_end +5, day 31 → 31 Aug (Finance Act 2026) | individual, huf, firm, llp, aop |
| TAX_AUDIT_REPORT | Tax audit report (3CA/3CB + 3CD) | fy_end +6, day 30 → 30 Sep | any |
| ITR_AUDIT | ITR (company / audited) | fy_end +7, day 31 → 31 Oct | company, firm, llp, individual, huf, trust |
| FORM_3CEB | Transfer pricing report 3CEB | fy_end +7, day 31 → 31 Oct | company, llp, firm |
| ITR_TP | ITR (transfer pricing cases) | fy_end +8, day 30 → 30 Nov | company, llp, firm |
| ADVANCE_TAX | Advance tax instalment (15/45/75/100%) | monthly, months 6,9,12,3, day 15 | any |
| SFT_61A | Statement of financial transactions | fy_end +2, day 31 → 31 May | any |
| FORM_10B | Audit report of charitable trust | fy_end +6, day 30 → 30 Sep | trust, society |
| GSTR9 | GST annual return | fy_end +9, day 31 → 31 Dec | any |
| GSTR9C | GST reconciliation statement | fy_end +9, day 31 → 31 Dec | any |
| CMP08 | Composition quarterly payment | quarterly, period_end +1, day 18 | any |
| GSTR4 | Composition annual return | fy_end +1, day 30 → 30 Apr | any |
| PMT06 | QRMP monthly tax payment | monthly, months 4,5,7,8,10,11,1,2, period_end +1, day 25 | any |
| AGM | Hold AGM | fy_end +6, day 30 → 30 Sep | company |
| AOC4 | Financial statements to ROC | agm +30 days | company |
| MGT7 | Annual return (MGT-7 / 7A) | agm +60 days | company |
| ADT1 | Auditor appointment | agm +15 days | company |
| DIR3_KYC | Director KYC | fy_start +5, day 30 → 30 Sep | company |
| DPT3 | Return of deposits | fy_end +3, day 30 → 30 Jun | company |
| MSME1 | MSME outstanding dues | half-yearly, months 9,3, period_end +1, day 31 → 31 Oct / 30 Apr | company |
| LLP11 | LLP annual return | fy_end +2, day 30 → 30 May | llp |
| LLP8 | LLP statement of account and solvency | fy_end +7, day 30 → 30 Oct | llp |
| PF_ECR | PF return and payment | monthly, period_end +1, day 15 | any |
| ESI | ESI contribution | monthly, period_end +1, day 15 | any |
| PT_TN | Tamil Nadu professional tax | half-yearly, months 9,3, period_end +0, day 31 → 30 Sep / 31 Mar | any |

## API — `/api/compliance`

Permissions: `workstation.compliance.read`, `workstation.compliance.manage`
(Workstation module). Client visibility as everywhere in Workstation. Every
write → `writeAudit`.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/forms` | Catalogue |
| PATCH | `/forms/:code` | Edit rule / note (manage + settings.manage) |
| GET | `/clients/:clientId/obligations` | Obligations with `suggested` forms for the client's entity type |
| PUT | `/clients/:clientId/obligations` | `{ forms: [{ form_code, assigned_employee_id?, remind_client? }] }` replaces the set (soft-deactivates removed) and generates items |
| POST | `/generate` | `{ financial_year? }` (re)generates items for all active obligations — idempotent; also run daily by the scheduler for the current and next FY |
| GET | `/items` | `from, to, client_id, form_code, authority, status, assigned_to, mine=1, overdue=1, include=gst,tds` → items (+ merged GST/TDS rows marked `source: 'gst'|'tds'`, read-only) with `days_left`, `overdue`, `late_fee_estimate` |
| PATCH | `/items/:id` | `status, assigned_employee_id, filed_on, acknowledgement_no, anchor_date, late_fee_paid_paise, notes` (`filed` requires `filed_on`) |
| POST | `/items/bulk` | `{ ids[], status?, assigned_employee_id?, filed_on? }` or `{ csv: "client_code,form_code,period_key,acknowledgement_no,filed_on" }` → per-row result |
| GET/POST | `/extensions` | POST `form_code, period_key, new_due_date, reference, source_url?, entity_types?` |
| DELETE | `/extensions/:id` | |
| GET | `/summary` | Counts for the dashboard: overdue, due in 7 days, due in 30 days, by authority; mine |

Late-fee estimates (`late_fee_estimate: { amount_paise?, note }`, always
labelled an estimate): GSTR-9 ₹200/day (₹100 CGST + ₹100 SGST, capped
0.5% of turnover where known); CMP-08 interest 18% p.a. note; ITR s.234F
₹5,000 (₹1,000 if income ≤ ₹5 lakh) + s.234A 1%/month note; tax audit
s.271B note; ROC forms ₹100/day additional fee; DIR-3 KYC ₹5,000; PF/ESI
interest notes. Notes only where an amount cannot be computed.

## Notices — `/api/notices-register`

`ClientNotice` CRUD (`GET /`, `POST /` multipart optional file, `PATCH /:id`,
`DELETE /:id` soft, `GET /:id/file`). `GET /` also merges `GstNotice` rows
(authority `gst`) so one list shows every notice with `response_due_date`,
`days_left`, `overdue`. `PATCH /api/notices-register/gst/:id` sets
`responseDueDate` / `assignedEmployeeId` on a GstNotice. Status flow:
received → in_progress → replied → hearing → order_received → appeal →
closed (forward-only except reopen by manager).

## DSC register — `/api/dsc`

`GET /` (`client_id, expiring_within_days`), `POST /`, `PATCH /:id`,
`DELETE /:id` (soft). Alerts: daily scheduler notifies the client's account
manager (and creates a dashboard item) at 30, 15 and 7 days before expiry
(`lastAlertDays` prevents repeats).

## Reminders (scheduler, daily)

- Staff: assignee (else client's account manager) gets an in-app
  notification 7 days and 1 day before each item's due date, and on the day
  after it becomes overdue; notices 7/3/1 days before `responseDueDate`.
- Clients: for obligations with `remindClient`, an email (and WhatsApp when
  configured, using existing `lib/whatsapp.ts`) 7 days before the due date
  listing the item and any `documents_pending` items, to the client's email on
  record only; `lastClientReminderAt` prevents repeats. Off unless SMTP is
  configured.

## 26AS vs books — `/api/tds-recon`

Built on the existing `AaTds26AS`, `AaTdsBooks`, `AaTdsReconJob` tables
(read them first). Upload 26AS (text/PDF/Excel export, reuse the existing
26AS-to-Excel converter in Tools for parsing) and books (Excel/CSV of TDS
receivable: party, TAN, section, amount, TDS) for a client and FY; match by
TAN + section, then amount within tolerance; show matched, in 26AS only, in
books only, amount differences; reviewer notes; export to Excel. Replaces
the "coming soon" cards in Repotic and TDS.
