# Books — open questions and deliberately deferred items

Things that are genuinely ambiguous, or knowingly simplified. Nothing here
was guessed silently; each item says what the code does today.

## Needs a decision from the firm

1. **TDS section codes are the pre-2026 ones.** The seeded rates (194C,
   194H, 194I, 194J, 194Q, 206C(1H), and the flat 20 % without PAN) follow
   the Income-tax Act 1961 as it stands before the Income-tax Act 2025 takes
   effect. They are ordinary editable rows, so updating them is a settings
   change, not a code change — but somebody has to confirm the new codes and
   thresholds when they are notified.

2. **TDS thresholds are not enforced.** Section limits (for example ₹30,000
   a single payment or ₹1,00,000 a year under 194J) are not checked; TDS
   applies from the first rupee once a section is set on the vendor. Whether
   the module should track year-to-date payments per vendor per section and
   start deducting only past the threshold is a real design question with a
   real answer — it needs the firm's practice, not a guess.

3. **Reverse-charge GST (RCM) is not implemented.** A bill from an
   unregistered vendor does not raise the self-invoice liability. The GST
   treatment field distinguishes the cases, so the rule can be added to the
   bill posting path; the accounting treatment the firm wants should be
   confirmed first.

4. **Composition scheme, exports under LUT and SEZ supplies** are treated as
   ordinary exempt or inter-state supplies. Overseas contacts are GST-exempt
   and produce no IGST. If any client is under composition or files LUT
   exports, those need their own handling.

5. **Retained earnings are computed, not closed.** The balance sheet shows
   accumulated profit rather than a year-end closing entry moving P&L to
   Retained Earnings. That keeps every figure derived from journals and is
   how Zoho Books behaves; a firm that wants a formal year-end close needs a
   closing routine.

6. **Who may create a set of books.** Today `books.manage` is granted to
   department managers, MD and finance admins. Whether an operations manager
   should be able to open books for a new client, or only a partner, is a
   policy call.

## Deliberately deferred (out of scope for this build)

7. **Payment gateway** — no gateway call anywhere. `BooksPayment.mode` is a
   label only.

8. **Tally XML import/export** — not built. Every group and ledger already
   carries its `tallyGroup`, which is the expensive half of the work.

9. **Bank statement ingestion / OCR** — not built. Statement lines are typed
   in through `BooksBankStatementLine`, which is where an importer will
   write when that module is scoped.

10. **GST portal submission** — GSTR-1 and GSTR-3B are computed and exported
    as structured JSON or CSV. Nothing is transmitted to any portal, and no
    code claims otherwise.

## Simplifications worth knowing about

11. **Exchange rates are floats; amounts never are.** SQLite has no decimal
    type. A rate is applied once at entry and the resulting base-currency
    minor-unit amount is stored as an integer, so no rounding accumulates.

12. **Recurring profiles run on demand.** `POST …/recurring/run` creates
    every document that has fallen due. There is no scheduler; wiring it to
    a cron job is a small, separate piece of work.

13. **Monthly recurrence rolls the way JavaScript rolls.** A profile
    starting 31 January produces the next document on 3 March, because
    31 February does not exist. Zoho behaves the same way. If the firm wants
    "last day of month" semantics, that is a rule to add.

14. **Inventory is not tracked.** `BooksItem` carries an item type including
    `inventory`, but there is no stock quantity, valuation or COGS
    calculation on sale. Goods invoices post to income like any other line.

15. **One line, one ledger.** A document line posts to a single income or
    expense ledger. Splitting one line across several accounts needs a
    manual journal.

16. **PostgreSQL triggers are written but not exercised.** The development
    database is SQLite. `books-invariants.postgresql.sql` mirrors every rule
    and is applied automatically when `DATABASE_URL` is not a `file:` URL,
    but the test suite runs against SQLite, so treat the PostgreSQL file as
    reviewed rather than proven until it runs in a staging environment.

17. **Number sequences are per set of books and not user-configurable in the
    UI.** Prefixes can be changed through `PATCH /api/books/:orgId` with a
    `prefixes` object; there is no settings screen for it yet.

## Agreed for a later phase (2026-09-09)

The firm has these on the roadmap; they are not gaps in this build's scope.

18. **Per-party ledgers for Tally.** Books posts to one Accounts Receivable /
    Accounts Payable control account and tracks each customer or vendor as a
    bill-wise open item. Tally expects a ledger per party under Sundry
    Debtors / Sundry Creditors. `BooksContact.receivableLedgerId` and
    `payableLedgerId` exist for this and are unused. The Tally export team
    can either synthesise a party ledger per contact at export time (no
    change here) or Books can create real per-party ledgers (cleaner export,
    changes posting). **Decide before the exporter is written.**

19. **Period lock.** Nothing prevents a back-dated entry into a month whose
    GST return is already filed. The most important missing control.

20. **Invoice PDF and email delivery.** No template, no rendering, no send.

21. **Attachments on transactions.** No way to keep a vendor's bill copy
    against the bill it supports.

22. **Opening balance import.** Per-ledger opening balances post correctly,
    but there is no bulk import of contacts, items and outstanding invoices
    for onboarding a client mid-year.

23. **GSTR-2B reconciliation.** GSTR-1 and 3B are computed; purchase input
    tax credit is not matched against 2B.

24. **TDS beyond deduction.** No thresholds, no challan or payment tracking
    for 26Q preparation. (See item 2.)

### Contracts for the neighbouring modules

- **Payments** must create receipts through the Books posting API. A direct
  write to the ledger tables is refused by the database triggers.
- **Bank statement / OCR ingestion** should write into
  `BooksBankStatementLine`; reconciliation and matching already sit on top.
- **Tally export** should read posted journals plus their bill allocations,
  not documents, so a voided entry and its reversal stay consistent.
