# Sidebar blocks and per-employee page access: design

Approved in conversation on 2026-11-23. The user chose every recommended option.

## Decisions
- **Blocks.** The sidebar's module cards change from HRMS / Workstation / Tools / Integrations to six blocks:
  - **Lead & Client:** Clients, Leads, Follow-ups, Documents, Calendar.
  - **Office Files:** Quotations, Engagement letters, Invoices, Recurring invoices, Credit notes, Receivables.
  - **Official Docs:** Sales register, Payroll & expenses, Finance MIS (the Reports page), Employee records, Attendance, Audit trail (the Audit log).
  - **Workstation:** Overview, Tasks, Registration, GST filing, TDS filing, IT filing, MCA filing, Other work, Bookkeeping and Audit section. The groups hold:
    - **IT filing:** IT returns, 26AS reconciliation, AIS reconciliation.
    - **MCA filing:** LLP forms, Pvt Ltd / Section 8 forms.
    - **Other work:** E-way bill, Notice reply, DSC register, Compliance calendar, Document formats.
    - **Bookkeeping:** Data entry, Tally export, Zoho Books.
    - **Audit section:** Audit files, with Internal, Tax and Statutory audit and the UDIN register.
  - **HR & Admin:** Employees, Leave, Messages, Articleship, Settings.
  - **Tools:** Tools, Repotic, Integrations.
- **Page access, per employee.** Each page gets its own tick, grouped by block, on the employee's **Page access** tab. Only Admins use it, and never on their own login; only the Super Admin can set it on the Super Admin's login.
  - The role gives the starting set.
  - Unticking a page the role gives switches it off.
  - Ticking a page beyond the role switches it on for that person.
  - Settings comes with the role only. Review/approval and partner sign-off powers are never handed out this way. Zoho Books can be added as view only.
- **Phases:**
  - Round 1 is this document.
  - Round 2 auto-generates filings:
    - TDS, quarterly.
    - IT, yearly, by 1 May.
    - MCA forms:
      - Form 11: generated 1 Apr, due 31 May.
      - Form 8: generated 1 Sep, due 31 Oct.
      - ADT-1: generated 1 Aug, due 31 Oct.
      - MGT-7: generated 1 Aug, due 30 Nov.
      - AOC-4: generated 1 Aug, due 31 Oct.
  - Round 3 builds AIS reconciliation with PDF → Excel, the Sales register and Finance MIS work, Data entry, and the Audit section split.

## Mechanism
- `User.hiddenPages` and `User.extraPages`, both `String[] @default([])`. These are added columns, and safe-push applies them. The rehearsal on the 2026-11-23 prod backup applied exactly this one ALTER.
- Switching a page on adds the page's `grant` codes (by default, its `perms` families). They are added at the scope the role would hold them (`scopeFor`). Codes in the approvals, partner and books_edit modules, and `settings.manage`, are never added.
- `backend/src/platform/pages.ts` is the page catalogue. Every page has a key, and some pages also list:
  - `perms`: the permission families the page owns. When the page is switched off, they are removed from the login's grants (session, `/api/auth/me`), so every existing `can()` check refuses it, on the API and in the UI.
  - `api`: the path prefixes only this page uses. `pageGate` returns 403 `page_switched_off` for them.
  - Pages with neither share their API with other screens or with self-service. For these, only the menu row and the page are hidden. They are: Clients, Calendar, Invoices, Sales register, Employee records, Attendance, Overview, IT returns, AIS, the MCA forms, Employees and Leave.
- **Frontend:**
  - Every `buildNav` row has a `page` key.
  - Switched-off rows are dropped.
  - `PageGuard` shows "This page is switched off for you" on the page's URL.
  - The client workspace hides the Invoices, Follow-ups and Tasks tabs when those pages are off.
- A test asserts that the sidebar's keys match the catalogue.
- The Sales register, IT returns and AIS reconciliation pages are "Coming soon" placeholders until their round.
