# Repotic — audit automation

Three tools under **Tools → Repotic** (`/audit-automation`). Server code:
`backend/src/modules/audit-automation/`. Money is always paise.

## 1. Bank statements → Tally

Upload (PDF, XLSX or CSV) → read → review → approve → Tally XML.

- **Upload** (`POST /api/audit-automation/uploads`): client, bank, account, FY.
  Password-protected PDFs need the password and an "I am authorised"
  confirmation. The password is used in memory only; the audit log records
  `aa.unlock_authorised`, never the password. The same file twice returns
  409. Scans with no text are refused.
- **Read** (`AaExtractService`): the bank is recognised from the letterhead
  (10 banks). A statement for a different bank is rejected
  (`adapter_mismatch`). Rows are checked against the running balance, and
  newest-first statements are reversed. Each row can be flagged:
  - `BALANCE_BREAK`
  - `DATE_ORDER`
  - `OUT_OF_PERIOD`
  - `DUPLICATE`: the same transaction in another statement of this client
- **Review** (`/jobs/:id/rows`, `PATCH /rows/:id`): edit fields; exclude,
  include, accept or un-accept a flagged row; set a ledger and voucher type.
  Ledger rules (`/rules`) match on text (contains, exact, regex) and
  direction, per client or firm-wide.
- **Approve** (`/jobs/:id/approve`): blocked while any flag is open, a
  ledger is missing, or there is no bank ledger.
- **Export**: `export/tally.xml` (Payment, Receipt, Contra) and `export.xlsx`.

## 2. GST — GSTR-2B vs purchase register

- **GSTR-2B inputs**: JSON or the portal's Excel. JSON covers:
  - B2B and B2BA
  - CDNR/CDNRA (credit notes negative)
  - IMPG (bills of entry)
  - ISD
- **Purchase register inputs**: Excel (column map) or Tally XML. From Tally,
  the supplier's REFERENCE is used, the taxable value is the sum of the
  goods ledgers, and a Debit Note counts as a return.
- **Categories**:
  - matched
  - partial (invoice number/date differ)
  - variance (taxable or tax differs)
  - missing in books
  - missing in 2B
  - duplicate
- **Matching passes**: exact → invoice → loose invoice → amount + date
  (±7 days). Amendments replace their originals.
- **ITC class, with a reason on every row**:
  - eligible
  - ineligible (2B says not available; not in 2B s.16(2)(aa); time-barred s.16(4))
  - blocked (s.17(5), read from the books ledger)
  - reversal (credit note)
  - rcm
- **Review**: status tabs, search, ITC filter, paging, ITC override with
  reason, notes, manual pair/unpair, and delete. Earlier uploads can be
  reused.
- **Export**: 7-sheet workbook and CSV.

## 3. TDS — Form 26AS vs books

- **26AS inputs**: the TRACES text download (`^`), the TRACES PDF
  (password = DOB/incorporation date DDMMYYYY, with consent), or Excel.
  - Parts read (tax credits of the assessee): I, II, III, IV, V, VI (TCS).
  - Parts skipped: VII, VIII (assessee as deductor), IX, X.
  - Older Part A/A1/A2/B layouts are mapped.
  - The TAN comes from the deductor summary row.
  - Also kept: booking status (F/P/U/O/Z), booking date, deposited amount.
  - The AY in the file must equal the AY chosen (`ay_mismatch`).
- **Books inputs**: the client's **TDS receivable**. From Tally XML these
  are debits to a TDS/receivable ledger in receipts or journals; TDS
  payable and purchases are skipped. Excel uses a column map, needing a TAN
  or name, the amount and a date. A GSTIN is never taken for a TAN.
- **Deductor identity**: the TAN, or a name match to a 26AS deductor
  (flagged `tan_from_name`).
- **Section codes** are normalised: 194IA ≠ 194I, 194I(b) → 194I,
  206C(1H) → 206C1H, 206CL kept. A blank section matches any.
- **Matching passes**, within one deductor:
  1. exact
  2. ±45 days (across quarters)
  3. grouped: one entry = the sum of several on the other side
  4. variance: same quarter
  5. the rest → only 26AS / only books
- **Row flags**:
  - `status_u/p/o/z`
  - `short_deposit`
  - `out_of_year`
  - `tan_from_name`
- **Job flags**:
  - `AY_MISMATCH`
  - `BOOKS_OUT_OF_YEAR`
  - `TAN_FROM_NAME`
  - `UNBOOKED_CREDITS`
  - `SHORT_DEPOSITS`
- **Default actions**:
  - only in books, U/O/Z, short deposit → chase deductor
  - only in 26AS → revise books
  - variance → chase if 26AS is lower, else revise books
- **Review**:
  - filters: status, action, warning, deductor, search
  - action and note per row
  - manual pair; unpair (a whole group)
  - match again (keeps reviewed actions and notes on pairs that survive)
  - delete
- **Deductor chase list** (`/recon/:id/deductors`): TDS in 26AS vs books
  and the shortfall per deductor. The follow-up (open, contacted, promised,
  resolved, written off; due date; contact; note) is kept per client + AY +
  deductor, so it survives re-runs. Every change is logged in its history.
  A drafted request letter lists what is open.
- **Export**: workbook (Summary, By deductor, Verified, Variance, Only in
  26AS, Only in books) and CSV.

## Cross-cutting

- **Isolation and access**: every read and write is scoped to the user's
  organisation. Without `…view` at organisation scope, a user sees only
  the jobs they created. Row edits go through the same check as reading
  the job.
- **Uploads**:
  - Bad or unreadable files return 4xx with a clear code; parser crashes
    are logged and never leak.
  - 25 MB limit; `.xls` is refused with advice.
  - An upload in use by a reconciliation cannot be deleted. Deleting
    removes the stored file and frees its hash for re-upload.
- **Audit log**: every upload, run, review, pair, export, delete and
  follow-up, with before/after where it changes something.
- **Tests**: `cd backend && npm run test:audit-automation`, which runs bank,
  GST, TDS and preflight.

## Known limits

- GST and TDS amounts are `Int` paise, capped at about ₹2.1 crore per line.
  Bank amounts are BigInt.
- The bank reader is generic (header detection + balance chain). Real
  statements from each bank should be tried and any layout quirks fixed.
- 26AS PDFs are read by row shape. The TRACES text download is the most
  reliable input.
- Tally keeps a party's TAN in the ledger master, not the voucher. Without
  it, books entries are matched by deductor name.
- No virus scan or encryption at rest for stored uploads. They sit under
  `backend/uploads/audit-automation` (or `AA_STORAGE_ROOT`).
