# Accounting module (Books)

A native, self-contained bookkeeping module inside AUDIT OS. It is our own
equivalent of Zoho Books, not an integration: there is no Zoho API call, no
Zoho SDK, and no dependency on any Zoho service anywhere in the code.

The firm keeps books for many clients, so the module is multi-tenant by
design: **one `BooksOrganisation` (a "set of books") per end client**, staff
assigned to specific sets, and no code path that can read across them.

- Stack decision: [stack-decision.md](./stack-decision.md)
- Open questions and deferred items: [open-questions.md](./open-questions.md)

---

## 1. The rules this module is built on

**Everything is a journal.** Invoices, bills, payments, credit notes,
retainers, transfers and revaluations are convenience wrappers that produce
`BooksJournal` + `BooksJournalLine` rows. There is exactly one function that
writes ledger state — `postJournal()` in
`server/src/modules/books/engine/posting.ts` — and every wrapper calls it.
Nothing else in the codebase writes `BooksJournal`, `BooksJournalLine`,
`BooksBill` or `BooksBillAllocation`.

**The balance invariant lives in the database.** A journal is inserted as a
draft and becomes posted by an update; a `BEFORE UPDATE` trigger re-checks
that debits equal credits, that there are at least two lines, and that every
line belongs to the same set of books. Service-layer checks exist too, but
they are the courteous error message — the trigger is the guarantee. The
tests prove it by writing an unbalanced journal with raw Prisma calls that
skip the service entirely, and watching the database refuse it.

**Nothing posted is ever deleted or edited.** Triggers freeze a posted
journal's financial columns, forbid inserting, changing or deleting its
lines, allow only `posted → void`, and refuse a delete. Voiding posts a
dated reversing journal and links the two. Even a maintenance script cannot
delete posted history without first dropping the triggers, which is exactly
what `npm run books:reset` has to do (and it refuses to run in production).

**The audit trail cannot be switched off.** Every create, edit, post, void
and application writes a `BooksAuditEvent` inside the same transaction as
the change, so a change without its audit row cannot commit. Triggers make
the table append-only: no update, no delete, no exceptions, no setting.

**The chart of accounts is Tally-shaped from day one.** Every group and
ledger carries a fixed `rootCategory` (asset | liability | equity | income |
expense) and a `tallyGroup` naming Tally's primary group (Sundry Debtors,
Bank Accounts, Duties & Taxes, Indirect Expenses …). Nothing reads
`tallyGroup` yet — Tally export is a separate module — but adding the field
now is free and retrofitting it later would not be.

**Receivables and payables are tracked bill by bill.** Every invoice and
bill opens a `BooksBill` (an open item). Every payment, credit note and
retainer application must name the open items it settles and by how much:
partial payments, one payment across several invoices, and unallocated money
held as an advance. There is no running net anywhere.

**India first.** GST is computed per line and split CGST + SGST or IGST from
place of supply against the organisation's state; TDS is deducted on bills
by section, at the higher rate when the vendor has no PAN; multi-currency
stores both the transaction and the base amount, realises the difference on
settlement and revalues what is still open.

---

## 2. Data model

23 tables, all prefixed `Books`, in `server/prisma/schema.prisma`. Money is
`BigInt` minor units (paise) everywhere. Nothing here changes an existing
HRMS or Workstation table; `Organisation` and `User` gain two relation
lists and no columns.

```
BooksOrganisation      one per client: name, GSTIN, PAN, state, base currency, FY start
  BooksMembership      firm staff assigned to it (admin | staff | viewer)

BooksAccountGroup      rootCategory + tallyGroup + parent
BooksLedger            the account: group, systemKey, opening balance, bill-wise flag,
                       GSTIN/state, TDS section, bank details, currency

BooksJournal           THE financial record: date, number, voucherType, source,
                       status (draft|posted|void), reverses/voidedBy, totals
BooksJournalLine       ledger, side, base amount, fx amount + rate, party, tax,
                       bank-reconciliation columns
BooksBill              an open item on a bill-wise ledger, with its balance
BooksBillAllocation    a journal's effect on one open item

BooksContact           customer | vendor | both, GST treatment, PAN, terms, credit limit
BooksContactPerson · BooksAddress
BooksItem              rate, purchase rate, SKU, unit, type, GST rate, HSN/SAC
BooksTaxRate           gst | tds | tcs, basis points, no-PAN rate, section

BooksDocument          estimate · sales order · invoice · retainer invoice · credit note ·
BooksDocumentLine      purchase order · bill · vendor credit — one table, one arithmetic
BooksPayment           received | made
BooksRecurringProfile  invoice/bill template + schedule
BooksBankTransfer · BooksBankStatementLine
BooksExchangeRate · BooksRevaluation
BooksNumberSequence    per-kind prefix and counter
BooksAuditEvent        append-only
```

### Why BigInt rather than Int

The firm's own internal ledger uses `Int` paise, which caps at ₹2.14 crore.
A client's books can exceed that, so every Books amount is `BigInt` and is
serialised to a plain integer for the API (safe to ₹90,000 crore).

---

## 3. Posting rules implemented

Base currency amounts shown; a foreign-currency document stores both.

| Event | Journal |
|---|---|
| **Invoice** | Dr Accounts Receivable (total) · Cr income per line · Cr CGST/SGST or IGST Output · Round Off. Opens an AR item for the total. |
| **Retainer invoice** | Dr Accounts Receivable · **Cr Unearned Revenue** (never income) · Cr GST Output. |
| **Retainer applied** | Dr Unearned Revenue · Cr Accounts Receivable, allocated to the chosen invoices. Revenue is recognised only here, and only after the retainer is paid. |
| **Credit note** | Dr income per line · Dr GST Output · Cr Accounts Receivable. Opens a credit item; the user picks which invoices to apply it to and how much — never FIFO, never automatic. |
| **Customer payment** | Dr bank/cash (amount − charges) · Dr Bank Charges · Dr TDS Receivable (TDS the customer deducted) · Cr Accounts Receivable (amount + TDS). Unallocated money becomes an advance item. |
| **Bill** | Dr expense/asset per line · Dr GST Input · Cr Accounts Payable (net of TDS) · **Cr TDS Payable** · Round Off. |
| **Vendor credit** | Dr Accounts Payable · Cr expense per line · Cr GST Input, applied manually like a credit note. |
| **Vendor payment** | Dr Accounts Payable · Cr bank/cash · Dr Bank Charges. |
| **Bank transfer** | Dr destination · Cr source. |
| **Opening balance** | Dr/Cr the ledger · the opposite side to Opening Balance Equity, as a dated `opening` journal — so reports stay derived from journals. |
| **FX revaluation** | Restates each open foreign item at the new rate; the delta hits the control ledger and Exchange Gain / Loss (unrealised). Settlement books the remaining difference as realised. |
| **Manual journal** | Whatever the accountant enters, under the same invariant. |

**Rounding.** Amounts round half-up. An INR document rounds to the nearest
rupee and the difference posts to a dedicated **Round Off** ledger under
Indirect Expenses — never absorbed into an income or expense line. A
document-level discount is distributed across lines by largest remainder, so
the parts always add to the whole.

**GST.** Per line, from the line's rate or its item's. Inclusive pricing is
divided out before tax. Intra-state splits CGST and SGST (the odd paisa goes
to SGST); inter-state is IGST. An overseas contact, or an organisation with
no GSTIN, is exempt.

**TDS.** From the vendor's section (or an explicit rate on the bill),
applied to the taxable total. Without a PAN on file the higher rate applies
automatically. The bill's payable to the vendor is the total less TDS.

---

## 4. Multi-tenancy and permissions

`server/src/modules/books/scope.ts` is the only way a route obtains a
`BooksContext`. It resolves the caller's firm, the set of books and the
caller's membership role, and refuses otherwise:

- another firm's books → **404** (its existence is not disclosed)
- own firm, not a member, no firm-wide grant → **403**
- no `books.access` at all → **403**

New permission codes (`books.access`, `books.manage`, `books.settings`,
`books.reports`, `books.accountant`) are granted in the existing role matrix
alongside every other module. Employees hold them at `self` scope (only
books they are assigned to); department managers, MD and finance admins hold
them at `organisation` scope (every client's books).

Inside a set of books the membership role narrows further:

| Role | Can |
|---|---|
| admin | everything, including Settings, Reports, Journals and revaluation |
| staff | day-to-day documents, contacts, payments and banking |
| viewer | read only |

---

## 5. HTTP surface

Everything under `/api/books`, in the platform's `{ data }` / `{ error }`
envelope, with `authenticate` mounted once as for every other module.

```
GET/POST  /api/books                          list / create a set of books
GET/PATCH /api/books/:orgId                   profile, my role, counts
GET       /api/books/:orgId/dashboard
          …/members · contacts · items · tax-rates · chart/groups · chart/ledgers
          …/documents/:kind[/:id][/post|void|status|convert|apply-credit|apply-retainer]
          …/open-items · payments/:kind · journals · audit
          …/banking/{accounts,transfers,:ledgerId/reconciliation,match,unmatch}
          …/fx/{rates,exposure,revalue,revaluations} · recurring
GET       /api/books/:orgId/reports/:name     trial-balance · profit-and-loss ·
                                              balance-sheet · cash-flow · general-ledger ·
                                              ar-ageing · ap-ageing · gstr-1 · gstr-3b · tds
```

Reports are queries over posted journals. There is no summary table to drift
out of sync, and GSTR-1 / GSTR-3B are computed from the vouchers themselves
rather than a parallel GST ledger. They are returned as structured data and
exported as CSV or JSON; nothing is submitted anywhere.

---

## 6. Screens

`/books` lists the sets of books the caller may open. `/books/:orgId` opens
one, with tabs the role allows: Overview, Sales, Purchases, Contacts,
Banking, and for admins Journals, Reports and Settings. The document editor
mirrors the server's arithmetic so the totals update as the user types, and
the server recomputes on save — its numbers are the ones stored.

---

## 7. Tests

`npm --prefix server test` — 41 tests, all green.

| File | Covers |
|---|---|
| `phase1-ledger.test.ts` | the chart seed, the balance invariant at both layers, direct-post refusal, immutability of posted journals and lines, void-by-reversal, bill-wise allocation and over-allocation, opening balances, money arithmetic |
| `phase2-4-documents.test.ts` | masters and validation, GST splits, inclusive tax, discounts, round-off, invoice/credit-note/retainer posting rules, partial and multi-invoice payments, advances, TDS with and without PAN, purchase chain, conversions |
| `phase5-9.test.ts` | manual journals, bank transfers and reconciliation, multi-currency with realised and unrealised FX, recurring profiles, GSTR-1 and GSTR-3B, the **golden-dataset regression** (a fixed set of transactions whose Trial Balance, P&L, Balance Sheet, Cash Flow, GL and ageing are asserted to exact values), and multi-tenant isolation through every service |
| `api.test.ts` | the real Express app over HTTP: a full cycle end to end, and scoping — another firm 404s, a non-member 403s, a staff member has no Settings/Reports/Journals, a viewer cannot write |

`node scripts/verify-books.mjs` drives Chrome against the dev server and
checks the module in the browser: 30 assertions covering the list, overview,
sales and purchases, posting and voiding from the drawer, the unbalanced
journal being refused, banking, reconciliation, five reports, the chart of
accounts, and staff scoping. It also confirms Dashboard, HRMS, Workstation
and Tools still render.

---

## 8. Running it

```bash
npm --prefix server run prisma:push    # create the tables
npm --prefix server run seed           # everything, including two demo sets of books
npm --prefix server run seed:books     # Books demo only
npm --prefix server run books:reset    # wipe and re-seed Books (development only)
npm --prefix server test               # the suite above
node scripts/verify-books.mjs          # browser verification
```

The invariant triggers are applied at API start-up, by the seed and by the
test harness, so they exist wherever the tables do.

### The default chart of accounts

Seeded into every new set of books: 22 groups and 40 ledgers, Indian
convention throughout. Accounts the engine posts to are identified by a
`systemKey`, never by their editable name — Accounts Receivable, Accounts
Payable, Cash, Undeposited Funds, CGST/SGST/IGST Output and Input, TDS
Payable, TDS Receivable, TCS Payable, Unearned Revenue, Advance from
Customers, Advance to Vendors, Opening Balance Equity, Owner's Capital,
Retained Earnings, Sales, Purchases, COGS, General Expenses, Bank Charges,
Discount Allowed, Other Income, Exchange Gain / Loss and Round Off. Default
tax rates cover GST 0/5/12/18/28 % and the common TDS and TCS sections.

---

## 9. Scope

Built: phases 1–9 of the brief — core ledger, masters, sales chain,
purchase chain, manual journals and banking, multi-currency, GST/TDS,
reports, roles and permissions.

Deliberately **not** built, as the brief instructs: payment-gateway
integration, Tally XML import/export, and bank-statement or OCR ingestion.
The chart of accounts is already Tally-shaped for the first of those, and
`BooksBankStatementLine` is where the third will land, but neither has any
code here.
