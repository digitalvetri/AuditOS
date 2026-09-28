# Bookkeeping & Tally Export — demo walkthrough

The two modules do **opposite** things. Say that first:

| Module | Direction | Purpose |
|---|---|---|
| **Books** (Services → Books) | Client data → **into** AuditOS books | Keep the client's books here, generate reports and the client dashboard |
| **Tally Export** (Services → Tally Export) | AuditOS data → **out to** TallyPrime XML | Convert bank statement / bookkeeping data to XML for import into external Tally |

Everyone assumes both are "Tally" and gets confused. This confusion is the whole reason for the §7 rename from "Bookkeeping" to "Books".

---

## Prep (five minutes, before anyone is watching)

1. Docker stack up: `docker compose up -d`
2. `http://localhost:8080` → log in.
3. Sidebar → **Services → Books**. Pick or create a company.
4. Have this file open in the browser tab for reference.

Sample data lives next to this doc:
- `docs/bookkeeping/sample-sales.xlsx` — the Excel to import (three tabs: Sales · Purchase · Sheet3, ten sales rows including mixed SGD/USD/INR, one row that fuzzy-matches "Loopet Pte Ltd", one row with a foreign-vs-INR mismatch to trigger the flag).
- `docs/tally-export/sample-bank-statement.csv` — the CSV for the Tally Export demo.

---

## Demo 1: Books (15 min)

### 1. Orient them on the workspace

At the top of the company workspace is the **period bar**: Month · Quarter · Year · Custom chips + a **vs prior** checkbox. Say:

> "One click switches every screen in the workspace to that period. This is the number one thing missing from other bookkeeping tools."

Down the left is the nav grouped as **Masters · Transactions · Statements · Administration**. Every statement is derived from posted vouchers — nothing is stored as a total.

### 2. Import Excel (Administration → Excel import)

1. Click **Choose file** → pick `docs/bookkeeping/sample-sales.xlsx` → click **Read sheets**.
2. Sheet picker shows three tabs (Sales · Purchase · Sheet3) with row counts. Pick **Sales**.
3. Target: **Sales register**.
4. Map the columns:
   - A → Date
   - B → Invoice no
   - D → Customer
   - E → Description
   - F → Currency
   - H → Foreign amount
   - J → Amount (INR)
   - K → Exchange rate
5. Click **Save mapping**. Point out: *"Saved per company + target. Next month, the operator drops the file in and doesn't see this screen unless columns move."*
6. Click **Preview vouchers**.

### 3. Walk them through the preview

Four KPI rows across the top: **New · Unchanged (skip) · Changed (skip) · Unresolved party**. Say:

> "Every row is classified before anything writes. Unchanged and Changed rows are silently skipped by default — a re-import is safe."

Below that:
- **New party ledgers** list — one row per proposed customer.
- **Row flags** — the foreign-vs-INR mismatch row is called out.
- **Derived vouchers** table — every row shows its status, and the balanced tick.

### 4. Commit

Click **Commit N vouchers**. The green result line shows:

> `✓ 10 posted · 6 party ledgers created · 0 skipped`

**Now every downstream statement changes.**

### 5. Trial Balance (Statements → Trial Balance)

Point at:
- The **green banner**: "Debits equal credits. The books balance." — the engine already guarantees this, but the badge is what a CA looks for first.
- Group / Sub-group columns — new in Step 4.
- The customer ledgers you just imported now appear under **Sundry Debtors**.

### 6. Profit & Loss (Statements → Profit & Loss)

- Two panels: Expenses and Income.
- Two KPI cards below: **Gross profit** with margin %, **Net profit** with margin %.
- Now flip **vs prior** in the period bar. A four-KPI comparison strip appears above the panels showing Revenue / Expenses / GP / NP with signed deltas and % change.

Say:

> "This is what makes a report into a conversation with the client."

### 7. Balance Sheet (Statements → Balance Sheet)

Point at the **✓ Balanced** pill in the header. Say:

> "Current period profit is carried into Equity automatically. If the pill ever went red, the trial balance is where you go to find why."

### 8. Receivables (Statements → Receivables)

- **KPI row**: Total outstanding · Customers · Average · Overdue.
- **Ageing bars** — one row per bucket (Under 30 · 31–60 · 61–90 · Over 90). The **Over 90** bucket has the 2px red left border and a red fill.
- Below: per-party panels with bill-wise breakdown and days-overdue.

Say:

> "Ageing is the most-used number in the whole module. This is the top of every collections call."

### 9. Client dashboard (Statements → Client dashboard)

1. Fill **Prepared by** = "JNS Accounting Solutions" (or whatever).
2. Fill **Firm contact** = your email + phone.
3. Click **Generate report**.
4. Click **Download the file just generated →**.
5. Open the downloaded `.html` in a new tab.

Point out on the file itself:
- KPI numbers at 30px (readable on a phone).
- Revenue vs Expenses bar chart — inline SVG, no chart library.
- Ageing bars with the >90 bucket in danger red.
- Top-10 outstanding with a total line.
- Footer: *"Prepared for X. Not for circulation."*

The killer demo move: **turn off Wi-Fi, refresh the page. It still renders.** Say:

> "This is what the firm actually sends the client — via WhatsApp, works offline, no login, forwardable, print-friendly."

---

## Demo 2: Tally Export (5 min)

### 1. Change of direction

> "Books goes IN. Tally Export goes OUT. This module takes an AuditOS bank statement and produces a Tally XML file that the client's accountant imports into their own TallyPrime install."

### 2. Upload

Sidebar → **Services → Tally Export**.

1. Company selector at top → pick a company (or use the seeded one).
2. Upload `docs/tally-export/sample-bank-statement.csv`.

### 3. Ledger rules

Show the rules table. Each row maps a bank-narration pattern to a Tally ledger name. Say:

> "Same compounding pattern as the Books import. Set the rules once per client — one month later, this becomes one click."

Point at **Bulk-import rules from CSV/TSV** if it's visible — that's how a firm brings 200 rules over from a spreadsheet in one paste.

### 4. Preflight

Click **Preflight**. It reports:
- Every transaction matched to a rule.
- Ledgers referenced exist in the target Tally company.
- Dates inside the FY.

If anything fails, the row is called out. Nothing generates until preflight is green.

### 5. Generate XML

Click **Generate XML** → downloads a `.xml` file.

Say:

> "The user opens Tally, Gateway of Tally → Import → Vouchers, points at this file. Every bank line lands as a posted voucher, mapped to the right ledger, in one action."

### 6. History

Point at the history tab — every generation is recorded (who, when, checksum) so a dispute later can prove which XML file was sent.

---

## The 60-second pitch (say this at the end)

> "Books runs the client's whole set of books here, with a real double-entry engine, an Excel import that saves per-client mappings, five statement screens, and a WhatsApp-ready one-page HTML file for every client every month. Tally Export goes the other way — takes an AuditOS bank statement and hands the client's accountant a TallyPrime XML they can import in one click. Both use the same mapping-once, click-forever pattern. Month one is slow. Month twelve is free."

---

## Troubleshooting during the demo

**"No employees / pay-heads / structures yet" panel appears under Payroll.**
That's expected on a fresh company. It's not an error — payroll needs an HR file to be loaded first. Skip Payroll during the demo unless someone asks.

**Client dashboard file has ₹ 0.00 across the KPIs.**
Means no vouchers landed for the selected period. Widen the period (chip → Year) or check that the import commit succeeded.

**Preview is empty on Excel import.**
The sheet picker default is the first sheet in the workbook. Confirm the operator picked **Sales**, not Sheet3.

**vs prior is on but no comparison strip appears on P&L.**
The prior period had no vouchers. Import more data or switch to a period where prior has posts.
