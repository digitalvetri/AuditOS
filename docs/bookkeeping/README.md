# Books (Bookkeeping) — how it works

AuditOS has **two** things named "Books". This doc is about the native one.

| Where in the UI | What it is |
|---|---|
| **Tools → Books** | Zoho Books **integration**. Pulls data from a Zoho Books account the firm has connected. Not covered here. |
| **Workstation → Services → Books** | AuditOS's own **double-entry accounting engine**. Pure in-house. **This doc is about this one.** |

Route in the browser: `/workstation/services/bookkeeping`. The engine is tagged "Preview" because it's a native rebuild in progress — companies, groups, ledgers, vouchers (sales + purchase imports), reports, GST are live; receipts/payments import and inventory/payroll are being built out.

---

## The mental model (classical accounting, mapped to this app)

```
Organisation (your firm)
└── Company (ONE PER CLIENT whose books you keep)
    ├── Financial Year  (e.g. 2025-26 = Apr 1 2025 → Mar 31 2026)
    ├── Groups   (tree)   ─ Sundry Debtors, Direct Expenses, Bank Accounts, …
    │   └── Ledgers       ─ Alexandra, Loopet, HDFC Current A/c, Travel, …
    ├── Vouchers          ─ every business event is one voucher
    │   ├── Sales         ─ Dr customer, Cr sales, Cr GST
    │   ├── Purchase      ─ Dr expense, Dr GST, Cr supplier
    │   ├── Receipt       ─ Dr bank,  Cr customer      (settles a sale)
    │   ├── Payment       ─ Dr supplier, Cr bank        (settles a purchase)
    │   ├── Contra        ─ bank-to-bank transfer
    │   └── Journal       ─ any other adjustment
    ├── Inventory         ─ stock items + units (for traders / manufacturers)
    └── Reports           ─ trial balance, P&L, balance sheet, day book
```

Every voucher has **entries**. Entries always balance — total debit = total credit, in paise. That is "double entry". If a row's debits don't equal its credits, the system flags it `unbalanced` and refuses to post.

---

## The pages, and what each is for

Open `/workstation/services/bookkeeping` and switch between:

| Page | File | What you do here |
|---|---|---|
| **Home** | `BookkeepingHome.tsx` | Pick a company, or create your first one |
| **Companies** | `BookkeepingCompanies.tsx` | List, create, FY settings |
| **Groups** | `BookkeepingGroups.tsx` | The chart-of-accounts tree |
| **Ledgers** | `BookkeepingLedgers.tsx` | Every ledger in the company |
| **Vouchers** | `BookkeepingVouchers.tsx` | Every posted voucher |
| **Voucher editor** | `BookkeepingVoucherEditor.tsx` | Create/edit any voucher by hand |
| **Import** | `BookkeepingImport.tsx` | **Upload an Excel register and post vouchers from it** |
| **Reports** | `BookkeepingReports.tsx` | Trial balance, P&L, balance sheet, day book |
| **Banking** | `BookkeepingBanking.tsx` | Bank statement reconciliation |
| **GST** | `BookkeepingGst.tsx` | GSTR-1 / 3B outputs from the posted vouchers |
| **Inventory** | `BookkeepingInventory.tsx` | Stock items + units |
| **Trade** | `BookkeepingTrade.tsx` | Inter-company trade between sister concerns |
| **Audit** | `BookkeepingAudit.tsx` | Audit of posted vouchers |
| **Utilities / Settings** | `BookkeepingUtilities.tsx`, `BookkeepingSettings.tsx` | Config |
| **Client dashboard** | `BookkeepingClientDashboard.tsx` | What the client sees in their portal |

---

## The import pipeline (the main thing to test)

This is **the** reason the module exists today — you upload the client's sales / purchase register as an Excel sheet, and the engine turns every row into a posted voucher.

```
┌──────────┐    ┌─────────┐    ┌─────────┐    ┌────────┐    ┌────────┐
│ Preview  │ →  │   Map   │ →  │ Derive  │ →  │ Review │ →  │ Commit │
└──────────┘    └─────────┘    └─────────┘    └────────┘    └────────┘
   upload       column →        rows →         fix flags +    vouchers
   .xlsx        field map       vouchers       party match    hit ledger
```

1. **Preview** (`POST /companies/:id/imports/preview`) — upload a workbook. The server returns each sheet with column letters (A, B, C…) and 10 sample rows. You pick the correct sheet and header row on the wizard.
2. **Map** — for each column letter, pick a target field: `date`, `invoice_no`, `bill_no`, `customer`, `supplier`, `description`, `currency`, `foreign_amount`, `amount_inr`, `exchange_rate`, `taxable_value`, `cgst`, `sgst`, `igst`, `cess`, `total`, `gstin`, `hsn`, or `ignore`. The map is saved per `(company, target)`, so next month's file reuses it automatically.
3. **Derive** — the engine reads every row via the saved map and builds proposed vouchers in memory. Nothing posted yet.
4. **Review** — the wizard shows derived vouchers, any flagged rows (`missing_date`, `missing_amount`, `unbalanced`, `foreign_vs_base`…), and **party decisions** — every customer/supplier name seen that doesn't match an existing ledger. For each you choose: create a new ledger, link to an existing one, or ignore.
5. **Commit** — vouchers hit the ledger. The commit is **idempotent**: the server computes a SHA-256 of each row, so uploading the same file twice posts zero duplicates. Perfect for monthly reruns.

Currently derived end-to-end: **sales_register** and **purchase_register**. Receipts and payments imports are stubbed in the engine; use the manual Voucher editor for those for now.

---

## Sample files (in this folder)

Two files that match the mappable-fields contract exactly:

| File | Sheet | Target | What it contains |
|---|---|---|---|
| `sample-sales.xlsx` | `Sales` | `sales_register` | 10 FY 2025-26 export invoices with foreign currency (SGD) and INR equivalent |
| `sample-purchases.xlsx` | `Purchases` | `purchase_register` | 5 FY 2025-26 purchase bills — some intra-state (CGST+SGST), some inter-state (IGST), GSTIN + HSN included |
| `sample-sales-domestic-gst.xlsx` | `Sales` | `sales_register` | 5 FY 2025-26 domestic B2B sales — 3 intra-state (CGST+SGST), 2 inter-state (IGST), GSTIN + HSN. Reuses 3 of the customer names from `sample-sales.xlsx` so you can see party-matching dedupe on top of a committed batch. |

Both follow the convention: **row 1** is the FY label, **row 2** is the header, **rows 3+** are data. The import wizard asks for the header row — point it at row 2.

### Column mapping for `sample-sales.xlsx`

| Column | Field |
|---|---|
| A | `date` |
| B | `invoice_no` |
| C | ignore |
| D | `customer` |
| E | `description` |
| F | `currency` |
| G | ignore |
| H | `foreign_amount` |
| I | ignore |
| J | `amount_inr` |
| K | `exchange_rate` |

### Column mapping for `sample-sales-domestic-gst.xlsx`

| Column | Field |
|---|---|
| A | `date` |
| B | `invoice_no` |
| C | ignore |
| D | `customer` |
| E | `description` |
| F | ignore |
| G | `taxable_value` |
| H | `cgst` |
| I | `sgst` |
| J | `igst` |
| K | `total` |
| L | `gstin` |
| M | `hsn` |

### Column mapping for `sample-purchases.xlsx`

| Column | Field |
|---|---|
| A | `date` |
| B | `bill_no` |
| C | ignore |
| D | `supplier` |
| E | `description` |
| F | `taxable_value` |
| G | `cgst` |
| H | `sgst` |
| I | `igst` |
| J | `total` |
| K | `gstin` |
| L | `hsn` |

---

## Test flow, end to end

1. Sign in as a user with `tools.audit_automation.bookkeeping.master.manage` (seeded accounts: `ravi@auditos.local` / `md`, or `priya@auditos.local` / `hr`).
2. **Workstation → Services → Books**. If no company exists, click **Create company**: pick a client, name it, set FY to **2025-26**.
3. Open the company → go to **Groups**. The engine seeds the standard tree (Sundry Debtors, Direct Expenses, Bank Accounts, …). Add any client-specific group if needed.
4. Go to **Ledgers**. Add at least one **Sales** ledger ("Sales — Services", group = Sales Accounts) and one **Bank** ledger ("HDFC Current A/c", group = Bank Accounts). The import can create party ledgers (customers / suppliers) for you from the review step; it will NOT auto-create a Sales or Expense ledger — pick those in Settings → Import defaults.
5. Open **Import**:
   - Upload `docs/bookkeeping/sample-sales.xlsx`. Preview opens.
   - Pick sheet `Sales`, header row **2**, target **Sales register**.
   - Apply the column map from the table above. Save the mapping (so next month's file maps itself).
   - Click **Derive**. 5 vouchers propose; party proposals list `Alexandra`, `Loopet`, etc.
   - **Review**: for each party, choose *Create new ledger under Sundry Debtors*. Pick the default Sales ledger. Fix any flagged rows.
   - **Commit**. Vouchers post. The import summary shows `5 derived, 5 committed, 0 duplicates`.
6. Repeat with `sample-purchases.xlsx`, target **Purchase register**. The purchase mapping has CGST/SGST/IGST columns — the engine splits the tax into the right output ledgers on commit.
7. Open **Vouchers** — your 10 vouchers are listed, each links to the derived row and the source file.
8. Open **Reports → Trial Balance** — sales ledgers (Cr), expense ledgers (Dr), party ledgers (Dr for customers, Cr for suppliers), and the GST liability ledgers all appear with balances.
9. **Idempotency test**: re-upload the same `sample-sales.xlsx`. The summary shows `5 derived, 0 committed, 5 duplicates`. Nothing double-posts.

---

## Pointers to the code

- **Backend**:
  - `backend/src/modules/bookkeeping/routes.ts` — the main router (companies, groups, ledgers, vouchers, reports).
  - `backend/src/modules/bookkeeping/routes.imports.ts` — the five-step import routes (preview, map, derive, review, commit).
  - `backend/src/modules/bookkeeping/engine/` — the double-entry engine:
    - `posting.ts` — balanced-entry rules.
    - `deriveVouchers.ts` — row → voucher derivation.
    - `partyMatch.ts` — fuzzy customer/supplier matching.
    - `gst.ts` — tax-ledger splits.
    - `balances.ts` — ledger balance aggregation (trial balance etc.).
  - `backend/src/modules/bookkeeping/services/` — service layer per feature (CompanyService, LedgerService, GroupService, ImportService, ImportCommitService, …).
- **Frontend**:
  - `frontend/src/pages/workstation/services/bookkeeping/*.tsx` — one page per screen listed in the table above.
  - `frontend/src/modules/tools/audit-automation/bookkeeping.ts` — the typed API client.

If you want a concrete walkthrough of a single piece (say, how the derive step decides which Dr/Cr entries to emit for a GST-charged sale), say which part and I'll trace it.
