# TALLY EXPORT — bank statement → Tally

**Date:** 26 September 2026
**Scope:** turn bank statement rows into a file the client imports into TallyPrime.
**Deliberately narrow.** No agent, no port 9000, no live connection. This is a file generator.

> **This document replaces TALLY-XML-EXPORT.md.** The client's own sample file
> changes the recommended output format from XML to Excel. Section 1 explains why.
> The XML route is kept in Appendix A for the automation phase.

---

## 1. Format decision — Excel, not XML

The client supplied `sample-sheet-bulk-client.xlsx`. It is **TallyPrime's own
official import template** — an `Accounting Voucher` sheet plus an
`Accounting Voucher (Read Me)` sheet listing all 470 importable fields with the
mandatory ones in bold.

TallyPrime imports this sheet directly. That changes three things, and all three
favour Excel.

### 1.1 The sign-ambiguity problem disappears

The XML route's one dangerous unknown was the amount sign convention. Tally's
documentation contradicts itself twice over:

| Source | Says |
|---|---|
| Sample XML page, prose | Negative = credit, positive = debit |
| Sample XML page, the sample directly below it | `ISDEEMEDPOSITIVE=Yes` (a debit) paired with a **negative** amount |
| Import Data FAQ, on Excel | "Negative values are treated as debits; positive as credits" |

Three statements, no two agreeing. Coding from any of them is a coin flip, and
getting it backwards produces books that import cleanly and are exactly inverted.

The Excel template has a column named **`Ledger Amount Dr/Cr`**. You write the
literal string `Dr` or `Cr`. The amount stays positive always. There is nothing
to infer and nothing to get backwards.

**This alone justifies the format change.**

### 1.2 Bad rows become exceptions, not a rejected file

XML import is all-or-nothing: one ledger name that does not exist in the company
and Tally refuses the entire file. Excel import runs through an
**Exceptions Report** — Tally lists the rows it could not process, the operator
fixes them, and the rest go in.

The failure mode changes from "nothing imported, no clear reason" to "397 of 412
imported, here are the 15 and why."

### 1.3 The accountant can read it

A junior can open the sheet, spot that `Kovai Printers` should have been
`Kovai Printers & Stationers`, fix the cell, and import. Nobody at the firm is
going to read XML, and nobody should have to.

### 1.4 Only four fields are mandatory

From the Read Me's bold markings, across all 470 fields:

```
  Voucher Type Name        ← mandatory
  Voucher Date             ← mandatory
  Ledger Name              ← mandatory
  Ledger Amount            ← mandatory
```

Everything else is optional. The export is a seven-column sheet, not a
470-column one.

---

## 2. The sheet we generate

### 2.1 Columns

The Read Me says, verbatim:

> *"Delete unwanted columns. However, do not delete columns that represent
> mandatory fields for vouchers."*
> *"Add new columns, if needed. Ensure to enter Column Headers exactly as
> mentioned under the List of Fields of the Read Me worksheet."*

So: keep the four mandatory, add three that earn their place, delete the rest.

| Column header — copy **verbatim** | Why |
|---|---|
| `Voucher Date` | mandatory |
| `Voucher Type Name` | mandatory — `Payment` / `Receipt` / `Contra` |
| `Voucher Number` | groups the two lines into one voucher; duplicate guard (§7) |
| `Voucher Narration` | the bank's original description, kept for audit trail |
| `Ledger Name` | mandatory |
| `Ledger Amount` | mandatory — always positive |
| `Ledger Amount Dr/Cr` | the literal `Dr` or `Cr`. **Removes all sign ambiguity** |

Deleted from the client's sample: `Buyer/Supplier - Address`,
`Buyer/Supplier - Pincode`, `Item Name`, `Billed Quantity`, `Item Rate`,
`Item Rate per`, `Item Amount`, `Change Mode`. Bank entries have no stock items
and no party addresses.

> **Header strings must be byte-identical to the Read Me list.** Copy them from
> the client's file into a constant in code. Do not retype them — the sample's
> own `Change Mode ` carries a trailing space, which is the kind of thing that
> silently breaks a mapping.

### 2.2 What a voucher looks like

One bank statement row becomes **two sheet rows** — the debit line and the
credit line.

```
Statement row
   15 Sep 2026 │ NEFT DR-SRI VARI TRADERS │ Withdrawal ₹1,24,000
```

```
┌────────────┬───────────────────┬──────────────────────┬──────────────────────────┬──────────────────┬───────────────┬─────────────────────┐
│Voucher Date│Voucher Type Name  │Voucher Number        │Voucher Narration         │Ledger Name       │Ledger Amount  │Ledger Amount Dr/Cr  │
├────────────┼───────────────────┼──────────────────────┼──────────────────────────┼──────────────────┼───────────────┼─────────────────────┤
│15-Sep-2026 │Payment            │AOS/HDFC/2609/0042    │NEFT DR-SRI VARI TRADERS  │Sri Vari Traders  │     124000.00 │Dr                   │
│15-Sep-2026 │Payment            │AOS/HDFC/2609/0042    │NEFT DR-SRI VARI TRADERS  │HDFC Bank         │     124000.00 │Cr                   │
└────────────┴───────────────────┴──────────────────────┴──────────────────────────┴──────────────────┴───────────────┴─────────────────────┘
```

Amounts are **always positive**. The `Dr`/`Cr` column carries the direction.
Dr total must equal Cr total per voucher, exactly.

---

## 3. Two things to verify before writing the generator

Both are cheap. Both are settled by the same action.

> **Create one Payment voucher by hand in the client's Tally company, then
> export that voucher to Excel.** Open the exported file. It answers both
> questions in thirty seconds and becomes the committed test fixture.

### 3.1 How continuation rows are written

Tally groups consecutive rows into one voucher, but the public documentation
does not state whether the voucher-level cells (`Voucher Date`,
`Voucher Type Name`, `Voucher Number`, `Voucher Narration`) must be **repeated**
on the second row or left **blank**.

Build it configurable — one boolean, `repeatVoucherHeaderOnEachRow` — default
to repeating, and confirm against the exported fixture.

**This is a safe unknown.** Getting it wrong produces a visible import failure
or obviously split vouchers, not silently wrong books. That is the whole reason
Excel is a better first target than XML.

### 3.2 The date format the client's Tally accepts

Depends on the company's date configuration. `15-Sep-2026` and `15/09/2026` are
both plausible. The exported fixture shows which one their installation uses.

Keep the format in config, not hard-coded.

---

## 4. The split — the core of the build

A bank statement has **Withdrawal** and **Deposit** columns. Tally needs
**Debit** and **Credit** lines. This conversion is the manual work being removed.

```
   WITHDRAWAL                          money leaves the bank
   ─────────────────────────────────────────────────────────
   Voucher Type Name   Payment
   Counter ledger      Dr        (expense incurred / party paid)
   Bank ledger         Cr        (bank balance decreases)


   DEPOSIT                             money enters the bank
   ─────────────────────────────────────────────────────────
   Voucher Type Name   Receipt
   Bank ledger         Dr        (bank balance increases)
   Counter ledger      Cr        (income earned / received from)
```

**Worked example — deposit:**

```
   18 Sep 2026 │ NEFT CR-MEENAKSHI AGENCIES │ Deposit ₹88,500

   Receipt, AOS/HDFC/2609/0051
      HDFC Bank             88500.00   Dr
      Meenakshi Agencies    88500.00   Cr
```

### 4.1 Contra — the case that is not income or expense

A transfer between two of the client's **own** accounts is neither.

```
   Current account → Savings account      Contra, not Payment
   Cash withdrawn from bank               Contra, not Payment
   Sweep to / from OD account             Contra, not Payment
```

Detect it: **if the counter ledger is itself a bank or cash ledger of the same
client, `Voucher Type Name` is `Contra`.**

Miss this and every internal transfer inflates both sides of the P&L. A client
moving ₹5L a month between two accounts shows ₹60L of phantom expenditure and
₹60L of phantom receipts across the year.

### 4.2 Voucher type table

| Withdrawal / Deposit | Counter ledger is own bank or cash | `Voucher Type Name` |
|---|---|---|
| Withdrawal | yes | `Contra` |
| Withdrawal | no | `Payment` |
| Deposit | yes | `Contra` |
| Deposit | no | `Receipt` |

Keep it a config table. Firms occasionally want `Journal` for specific patterns.

---

## 5. Ledger mapping

Every row needs a counter ledger. This is where the time goes, and where the
compounding saving is.

```
  tally_ledger_rule
    client_id
    match_type     contains | regex | exact
    pattern        "SRI VARI TRADERS"
    ledger_name    "Sri Vari Traders"
    voucher_type   Payment | Receipt | Contra | Journal   (optional override)
    priority
    hit_count
    created_by · created_at
```

**Resolution order:** client rules by priority, then global rules. No match →
the row is **unmapped** and blocks export.

### 5.1 The two actions that make this fast

**"Apply to all similar in this statement"** — map one row and every row whose
description matches the same pattern maps at once. A month of salary payments is
one click, not thirty.

**"Save as a rule for this client"** — next month that description maps itself.

**Month one is slow. Month twelve is nearly automatic.** That compounding is the
actual product here, not the file generation.

---

## 6. Pre-flight

Excel import gives an Exceptions Report rather than rejecting the file, so this
screen is about **saving a round trip**, not preventing disaster. It still earns
its place: a mismatched ledger name costs a re-import and a phone call.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  PRE-FLIGHT · Kovai Textiles · HDFC ••••4471 · Sep 2026                      │
│                                                                              │
│  ✓ All 412 rows mapped to a ledger                                           │
│  ✓ Every voucher balances — Dr total = Cr total                              │
│  ✓ All dates within the statement period                                     │
│  ✓ No voucher number collides with a previous export                         │
│  ⚠ 3 ledger names are new to this client                                     │
│                                                                              │
│  LEDGERS IN THIS EXPORT                            confirm these exist       │
│  ────────────────────────────────────────────────────────────────────────    │
│    HDFC Bank                       312 vouchers    ✓ used before             │
│    Sri Vari Traders                 28 vouchers    ✓ used before             │
│    Salaries                         14 vouchers    ✓ used before             │
│  ▍ Kovai Printers                    4 vouchers    ⚠ new                     │
│  ▍ Professional Fees                 2 vouchers    ⚠ new                     │
│  ▍ Bank Charges                     52 vouchers    ⚠ new                     │
│                                                                              │
│  [ Download ledger master sheet ]        creates the 3 new ledgers in Tally  │
│  [ I have confirmed these exist ]  ──►   [ Generate voucher sheet ]          │
└──────────────────────────────────────────────────────────────────────────────┘
```

**The ledger master sheet** is a second, smaller file using Tally's
`Ledger` sample template — mandatory columns `Name` and `Group Name` — that
creates the missing ledgers. Import it first, then the vouchers. Turns one
half-failed import into two clean ones.

Export is **blocked** while any row is unmapped.

---

## 7. Duplicate guard

Nothing in Tally stops the same statement being imported twice. It will happily
create 412 more vouchers and the books will be double-counted, which is tedious
to unwind and easy to do — two staff, one shared folder, one unclear filename.

Two mechanisms, both cheap:

**Deterministic voucher numbers.**

```
  AOS/<bank code>/<YYMM>/<sequence>
  AOS/HDFC/2609/0042
```

Derived from client, bank account, period and row order. The same statement
always produces the same numbers, so a second import collides visibly rather
than silently duplicating.

**An export ledger in AuditOS.**

```
  tally_export
    client_id · bank_account_id · period_from · period_to
    kind          vouchers | ledger_master
    row_count · voucher_count
    file_id · checksum
    generated_by · generated_at
    scope_json                     ← exactly which statement rows went in
```

Before generating, check whether these rows have been exported before and warn.
When a client asks in March what was sent to Tally in October, the answer is a
row, not a memory.

---

## 8. Screens

### 8.1 Mapping review

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Tally Export · Kovai Textiles · HDFC ••••4471 · Sep 2026                     │
│                                                                              │
│  412 rows   ·   398 mapped   ·   14 unmapped   ·   0 errors                  │
│  ────────────────────────────────────────────────────────────────────────    │
│  [ All ]  [ Unmapped 14 ]  [ Contra 6 ]  [ New ledgers 3 ]                   │
├──────────────────────────────────────────────────────────────────────────────┤
│    DATE      DESCRIPTION               WITHDRAWAL   DEPOSIT   LEDGER    TYPE │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▍  04 Sep   NEFT DR-KOVAI PRINTERS      12,400              — unmapped       │
│             [ Choose ledger ▾ ]  [ Apply to all similar (4) ]                │
├──────────────────────────────────────────────────────────────────────────────┤
│    07 Sep   UPI/P2M/HOTEL SARAVANA       1,450        Travel      Payment    │
├──────────────────────────────────────────────────────────────────────────────┤
│    09 Sep   SALARY SEPT 2026           2,10,000       Salaries    Payment    │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▍  11 Sep   TRF TO SAVINGS A/C          50,000    HDFC Savings    Contra     │
│             Both sides are your own accounts — recorded as Contra            │
├──────────────────────────────────────────────────────────────────────────────┤
│    18 Sep   NEFT CR-MEENAKSHI AGY                  88,500   Sales   Receipt  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 8.2 Import instructions, shown on download

The person downloading is not necessarily the person importing. Put the steps
on the screen, not in a separate note:

```
  1.  Open the client's company in TallyPrime
  2.  Gateway of Tally → Import → Vouchers
  3.  Choose this file · file type Excel
  4.  Review the mapping screen, then accept
  5.  Read the Exceptions Report before closing
```

---

## 9. Build prompt

```
Build the Tally export. Narrow scope: bank statement rows in, an Excel file
the client imports into TallyPrime out. NO agent, NO port 9000, NO live
connection to Tally. This is a file generator.

Reuse existing components. Introduce no new design tokens.

═══════════════════════════════════════════════════════════════
0. FORMAT — Excel, using the client's own TallyPrime template
═══════════════════════════════════════════════════════════════

The client supplied TallyPrime's official import template
(sample-sheet-bulk-client.xlsx). TallyPrime imports this sheet directly.

Generate .xlsx, NOT XML. Three reasons, all decisive:

  - The template has an explicit "Ledger Amount Dr/Cr" column. Write the
    literal string Dr or Cr; amounts stay positive. Tally's own docs
    contradict themselves three ways on XML amount signs, so XML makes the
    debit/credit direction a coin flip. Excel makes it explicit.
  - Excel import produces an EXCEPTIONS REPORT. Bad rows are listed and the
    rest import. XML rejects the entire file if one ledger name is missing.
  - An accountant can open the sheet and fix a cell. Nobody reads XML.

COLUMNS — exactly these seven, headers copied VERBATIM from the client's
Read Me sheet into a constant. Do not retype them.

  Voucher Date            (mandatory)
  Voucher Type Name       (mandatory)  Payment | Receipt | Contra
  Voucher Number                       grouping + duplicate guard
  Voucher Narration                    the bank's original description
  Ledger Name             (mandatory)
  Ledger Amount           (mandatory)  ALWAYS POSITIVE
  Ledger Amount Dr/Cr                  literal "Dr" or "Cr"

One statement row becomes TWO sheet rows — the Dr line and the Cr line.

═══════════════════════════════════════════════════════════════
1. BEFORE WRITING THE GENERATOR — verify two things
═══════════════════════════════════════════════════════════════

Obtain one real voucher exported from the client's Tally to Excel:
create a Payment voucher by hand in their company, export it, open it.

REPORT, before writing generator code:
  a) Are voucher-level cells (Date, Voucher Type Name, Voucher Number,
     Voucher Narration) REPEATED on the second row of a two-line voucher,
     or left BLANK? The public documentation does not say.
  b) What DATE FORMAT does their installation use — 15-Sep-2026,
     15/09/2026, or something else?

Build both configurable:
     repeatVoucherHeaderOnEachRow : boolean   (default true)
     dateFormat                   : string    (from config, never hard-coded)

Commit the exported file as a TEST FIXTURE and assert generated output
against it.

Both unknowns fail VISIBLY — a bad import or obviously split vouchers, not
silently wrong books. Do not let that make you skip the check.

═══════════════════════════════════════════════════════════════
2. THE SPLIT — core logic
═══════════════════════════════════════════════════════════════

  WITHDRAWAL  → Voucher Type Name = Payment
                counter ledger   Dr
                bank ledger      Cr

  DEPOSIT     → Voucher Type Name = Receipt
                bank ledger      Dr
                counter ledger   Cr

CONTRA — do not miss this:
  If the counter ledger is itself a bank or cash ledger belonging to the
  SAME client, Voucher Type Name is Contra, not Payment or Receipt.
  Transfers between the client's own accounts are neither income nor
  expense. Missing it inflates both sides of the P&L.

Voucher type selection is a CONFIG TABLE:
  withdrawal + counter is own bank/cash  → Contra
  withdrawal + anything else             → Payment
  deposit    + counter is own bank/cash  → Contra
  deposit    + anything else             → Receipt

Per voucher, Dr total MUST equal Cr total exactly. Assert before writing
the rows. A voucher that does not balance is a generator bug, not an
import error to discover later.

MONEY IS INTEGER PAISE internally. Format to two decimals only at the
sheet-writing boundary. No float arithmetic anywhere — grep must prove it.

═══════════════════════════════════════════════════════════════
3. LEDGER MAPPING
═══════════════════════════════════════════════════════════════

  tally_ledger_rule
    client_id · match_type (contains | regex | exact) · pattern
    ledger_name · voucher_type (optional override) · priority
    hit_count · created_by · created_at

Resolution: client rules by priority, then global. No match → row is
UNMAPPED and blocks export.

TWO ACTIONS THAT MAKE THIS FAST — both required:

  "Apply to all similar in this statement"
     map one row, every row matching the same pattern maps at once.
     A month of salary payments is one click, not thirty.

  "Save as a rule for this client"
     next month that description maps itself.

Month one is slow, month twelve is nearly automatic. That compounding is
the value — not the file generation.

═══════════════════════════════════════════════════════════════
4. PRE-FLIGHT
═══════════════════════════════════════════════════════════════

Before generating, show:
  ✓ every row mapped
  ✓ every voucher balances
  ✓ every date inside the statement period
  ✓ no voucher number collides with a previous export
  ⚠ ledger names not previously seen for this client

Then list EVERY DISTINCT LEDGER NAME in the export with its voucher count,
marking which are new, and require explicit confirmation.

Also generate a LEDGER MASTER SHEET using Tally's Ledger template
(mandatory columns: Name, Group Name) creating the missing ledgers.
Import that first, then the vouchers.

Export is BLOCKED while any row is unmapped.

═══════════════════════════════════════════════════════════════
5. DUPLICATE GUARD
═══════════════════════════════════════════════════════════════

Tally does not stop the same statement importing twice. Two mechanisms:

  Deterministic voucher numbers:  AOS/<bank code>/<YYMM>/<sequence>
  e.g. AOS/HDFC/2609/0042
  Same statement → same numbers → a second import collides visibly.

  tally_export row per generated file:
    client_id · bank_account_id · period_from · period_to
    kind (vouchers | ledger_master) · row_count · voucher_count
    file_id · checksum · generated_by · generated_at
    scope_json   ← exactly which statement rows went in

  Before generating, warn if these rows were exported before.
  Every export re-downloadable from history.

═══════════════════════════════════════════════════════════════
6. SCREENS
═══════════════════════════════════════════════════════════════

MAPPING REVIEW
  Counts: rows, mapped, unmapped, errors.
  Tabs: All · Unmapped · Contra · New ledgers.
  Table: date, description, withdrawal, deposit, ledger, voucher type.
  Unmapped rows carry a ledger picker plus "Apply to all similar (n)".
  Contra rows show why: "Both sides are your own accounts".

PRE-FLIGHT
  Per section 4. Generate disabled until confirmed.

DOWNLOAD
  Show the five import steps on screen — the person downloading is often
  not the person importing:
    1. Open the client's company in TallyPrime
    2. Gateway of Tally → Import → Vouchers
    3. Choose this file, file type Excel
    4. Review the mapping screen, accept
    5. Read the Exceptions Report before closing

═══════════════════════════════════════════════════════════════
7. ACCEPTANCE — paste evidence for each
═══════════════════════════════════════════════════════════════

  □ Section 1 findings reported BEFORE generator code, with the real
    exported voucher committed as a fixture
  □ Column headers byte-identical to the client's Read Me list — show the
    constant and a diff against the sample file
  □ A withdrawal produces Payment: counter Dr, bank Cr
  □ A deposit produces Receipt: bank Dr, counter Cr
  □ A transfer between the client's own accounts produces Contra
  □ Every Ledger Amount is POSITIVE — no negative value anywhere in the
    generated sheet
  □ Every voucher balances, Dr total = Cr total. Asserted in code
  □ THE GENERATED FILE IMPORTS INTO A REAL TALLY COMPANY — screenshot of
    the import result AND of the Exceptions Report (even if empty)
  □ Imported amounts and Dr/Cr sides match the source statement — check
    five rows by hand in Tally and paste them
  □ Re-importing the same file is detected, not silently duplicated
  □ Export blocked while any row is unmapped
  □ Pre-flight lists every distinct ledger with count, flags new ones
  □ Ledger master sheet creates the missing ledgers in Tally
  □ "Apply to all similar" maps every matching row in one action
  □ "Save as a rule" makes the same description map automatically on a
    second statement
  □ All amounts integer paise internally — grep for parseFloat, Number(),
    toFixed outside the sheet-writing boundary returns nothing
  □ Every export writes a tally_export row and is re-downloadable
  □ Zero new design tokens
```

---

## 10. Order of work

| # | Step | Days |
|---|---|---|
| 0 | Export one voucher from their Tally; settle row grouping + date format | 0.25 |
| 1 | Split logic + voucher type + balance assertion | 1 |
| 2 | Ledger mapping rules + apply-to-similar + save-as-rule | 1 |
| 3 | Pre-flight + ledger master sheet | 0.5 |
| 4 | XLSX generator | 0.5 |
| 5 | Review screen + export record + duplicate guard | 1 |

**Four days.** Down from five — the XLSX writer is simpler than an XML
generator with escaping, and step 0 shrank from half a day to an hour once the
sign convention stopped being a question.

---

## 11. Confirm before starting

**Export one voucher from their Tally to Excel.** Step 0 needs it. A Payment
voucher with two ledger lines, nothing else.

**Which bank accounts, and their exact Tally ledger names?** `HDFC Bank` and
`HDFC Bank Ltd` are different ledgers. The second one lands in the Exceptions
Report.

**Which TallyPrime version are they on?** Direct Excel import is a TallyPrime
feature, not Tally.ERP 9. If any client is still on ERP 9, that client needs the
XML route in Appendix A.

**Do they want Contra detection?** It requires knowing which ledgers are the
client's own bank and cash accounts. If they would rather review those manually,
the rule is simpler — but internal transfers land as expenses until someone
catches them.

**Where do the statement rows come from?** If bank statement parsing already
exists in the bookkeeping module, this reads from it. If not, a CSV or XLSX
upload is the input and that is a small addition to step 1.

---

## Appendix A — the XML route

Keep this for later. It becomes the right choice when the firm wants imports to
happen without a person clicking through Tally's import screen — XML can be
POSTed to Tally's local HTTP listener on port 9000 by an on-premise agent.
Excel cannot.

Not now. It carries the sign-convention risk, the all-or-nothing rejection, and
a file nobody at the firm can read.

**Envelope:**

```xml
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Import</TALLYREQUEST>
    <TYPE>Data</TYPE>
    <ID>Vouchers</ID>
  </HEADER>
  <BODY>
    <DESC></DESC>
    <DATA>
      <TALLYMESSAGE>
        <VOUCHER VCHTYPE="Payment" ACTION="Create">
          <DATE>20260915</DATE>
          <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
          <NARRATION>NEFT DR-SRI VARI TRADERS</NARRATION>
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>Sri Vari Traders</LEDGERNAME>
            <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
            <AMOUNT>-124000.00</AMOUNT>
          </ALLLEDGERENTRIES.LIST>
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>HDFC Bank</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>124000.00</AMOUNT>
          </ALLLEDGERENTRIES.LIST>
        </VOUCHER>
      </TALLYMESSAGE>
    </DATA>
  </BODY>
</ENVELOPE>
```

**If the XML route is ever taken, these hold:**

- Date format `YYYYMMDD`, no separators
- `ISDEEMEDPOSITIVE`: `Yes` = debit, `No` = credit
- **The amount sign must be verified against a real exported voucher.** Do not
  code it from documentation — see §1.1 for why.
- Tally rejects the **entire file** if one ledger name does not exist, so the
  pre-flight and ledger-master file become mandatory rather than convenient
- Escape XML properly. Indian bank narrations routinely contain `&`. Test with
  a narration containing `& < > " '`
- The company name cannot be read back from Tally, so the operator must confirm
  the correct company is open before importing

---

**Sources:**

- Client-supplied `sample-sheet-bulk-client.xlsx` — TallyPrime official import template, `Accounting Voucher` and `Accounting Voucher (Read Me)` sheets
- [How to Import Data into TallyPrime — TallyHelp](https://help.tallysolutions.com/import-data-in-tally/)
- [Import Data FAQ — TallyHelp](https://help.tallysolutions.com/import-data-faq/)
- [How to Map Data from Multiple Rows & Columns — TallyHelp](https://help.tallysolutions.com/map-data-from-multiple-rows-columns/)
- [Download Sample Excel Files with Data for Import — TallyHelp](https://help.tallysolutions.com/download-sample-excel-files-with-data-for-import/)
- [Sample XML — TallyHelp](https://help.tallysolutions.com/sample-xml/)
