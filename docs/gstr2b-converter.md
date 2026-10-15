# GSTR-2B JSON ⇄ Excel converter

AuditOS → Tools → **GSTR-2B JSON ⇄ Excel**. Code: `backend/src/modules/tools/services/tools/gstr2b.ts`.
Tests and sample files: `backend/src/modules/tools/__tests__/gstr2b.test.ts`, `…/__tests__/fixtures/gstr2b/`.

> Check the ITC Summary against the portal's own GSTR-2B summary before relying on it for GSTR-3B.

## What it guarantees

- **Lossless.** JSON → Excel → JSON gives back the same JSON, key for key and value for value (key order and whitespace aside). Every JSON → Excel conversion re-reads its own workbook and reports **PASS**, or the paths that differ.
- **Codes, not labels.** Excel holds the portal's codes (`R`, `Y`/`N`, `C`, `33`). Labels typed by a person ("Regular", "Yes", "33-Tamil Nadu", "Credit Note") are read back as codes, with a warning for each.
- **Text stays text.** GSTINs, periods (`092026`), document numbers, port codes, BoE numbers and dd-mm-yyyy dates are written as text cells, so Excel never reformats them or drops leading zeros.
- **The portal's itcsumm is never changed.** It converts back exactly as downloaded. AuditOS's own totals are shown beside it (Portal vs Computed), and a gap is a flag. Anything typed into the ITC Summary sheet is ignored.
- **Portal data is never refused.** Data problems in a GSTR-2B are what suppliers filed — they are flags on the Flags sheet, not errors. Only a workbook going back to JSON refuses a malformed GSTIN or date.
- **Split downloads merge.** Upload all JSON parts of one GSTR-2B together (same GSTIN and period); they become one workbook.

## Workbook layout

| Sheet | Contents |
|---|---|
| Info | GSTIN → `gstin`, Return Period → `rtnprd`, Version → `version`, Generated On → `gendt` |
| ITC Summary | GSTR-3B Table 4 as live SUMIFS: 4A(1) imports, 4A(3) reverse charge, 4A(4) ISD, 4A(5) all other ITC, total; then ITC not available. Recalculates on open and when rows change |
| Portal vs Computed | Every itcsumm figure AuditOS can compute: portal, computed from documents, difference (red when non-zero) |
| Supplier Summary | Per section and supplier: documents, taxable value, taxes (credit notes negative), reverse-charge and ITC-not-available counts |
| Flags | Every check that did not stop the conversion |
| B2B, B2BA | One row per invoice **item** (a multi-rate invoice spans several rows) |
| CDNR, CDNRA | One row per credit / debit note item |
| ISD, ISDA | One row per ISD document |
| IMPG | One row per bill of entry |
| IMPGSEZ | One row per bill of entry, with the SEZ supplier |
| ECO, ECOA | Supplies through an e-commerce operator (section 9(5)), laid out like B2B |
| _raw *(hidden)* | Unknown sections, unknown top-level keys (cpsumm, hash…), wrapper keys (chksum), the original itcsumm shape |

Each data sheet has a **Sort Date** column (the document date as a real Excel date, for sorting and filters; not read back) and two hidden columns: `_fields` records which keys each level had (so absent, empty and zero stay different), and `_extra` holds keys the layout has no column for (e.g. `imsStatus`).

## Field mapping

| Excel column | JSON key | Level | Notes |
|---|---|---|---|
| Supplier GSTIN | `ctin` | supplier | 15 chars, validated |
| Supplier Name | `trdnm` | supplier | |
| Supplier Period | `supprd` | supplier | MMYYYY, text |
| Supplier Filing Date | `supfildt` | supplier | dd-mm-yyyy, text |
| Invoice No / Note No | `inum` / `ntnum` | document | text |
| Original Invoice No / Date | `oinum` / `oidt` | document | B2BA |
| Original Note Type / No / Date | `onttyp` / `ontnum` / `ontdt` | document | CDNRA |
| Invoice Type | `typ` | document | `R`, `SEWP`, `SEWOP`, `DE`, `CBW` ("Regular" → `R`) |
| Note Type | `typ` | document | `C` credit, `D` debit |
| Supply Type | `suptyp` | document | CDNR |
| Invoice / Note Date | `dt` | document | dd-mm-yyyy |
| Invoice / Note Value | `val` | document | |
| Place of Supply | `pos` | document | 2-digit state code ("33-Tamil Nadu" → `33`) |
| Reverse Charge | `rev` | document | `Y`/`N` |
| Diff Percent | `diffprcnt` | document | |
| Item No | `items[].num` | item | |
| Rate | `items[].rt` | item | |
| Taxable Value, IGST, CGST, SGST, Cess | `items[].txval/igst/cgst/sgst/cess` | item | Document totals = sum of its items; a document without items keeps its own totals |
| ITC Available | `itcavl` | document | `Y`/`N` |
| Reason Code | `rsn` | document | Portal code; "Blocked credit (Sec 17(5))" → `C` |
| IRN, IRN Date, Source | `irn`, `irngendate`, `srctyp` | document | |
| Port Code, BoE No, BoE Date, Reference Date, Amended | `portcode`, `boenum`, `boedt`, `refdt`, `isamd` | IMPG | |
| ISD: Document Type / No / Date, ITC Eligible | `doctyp`, `docnum`, `docdt`, `itcelg` | ISD | |

The GST portal's own Excel header names (e.g. "GSTIN of Supplier", "Invoice Number", "GSTR-1/5 Period", "Bill of Entry Number", "Integrated Tax") are accepted on import.

## itcsumm

Each document lands in one group, the same rule for the JS totals and the sheet formulas:

| Group (GSTR-3B) | Documents |
|---|---|
| `imports` — 4A(1) | IMPG, IMPGSEZ |
| `revsup` — 4A(3) | B2B, B2BA, CDNR, CDNRA, ECO, ECOA with `rev = Y` |
| `isdsup` — 4A(4) | ISD, ISDA (`ISDC…` credit notes negative) |
| `nonrevsup` — 4A(5) | B2B, B2BA, CDNR, CDNRA, ECO, ECOA with `rev ≠ Y` |

Credit notes (`typ = C`) are negative. `itcavl` / `itcelg = N` goes to `itcunavl` instead of `itcavl`. The portal's itcsumm is kept as it is; for a hand-made workbook with none, one is built in this shape.

Not yet confirmed against a real download: whether the portal's B2BA / CDNRA summary carries the amended document's full value (as computed here) or only the difference from the original. Portal vs Computed shows it either way.

## Checks

**Flags (never stop a conversion):** invalid supplier GSTIN, invalid date, document dated after the return period, possible duplicate (same GSTIN, note type and number), value ≠ taxable + taxes by more than ₹1 (a reverse-charge invoice whose value is the taxable value is fine), tax ≠ taxable × rate × `diffprcnt` (the 65% rate), IGST and CGST/SGST on one line, IGST intra-state or CGST/SGST inter-state (SEZ and bonded-warehouse types exempt), a portal itcsumm figure that differs from the documents, labels mapped to codes, an unknown section kept in `_raw`, a column empty in every row.

**Errors (Excel → JSON only):** a malformed GSTIN, return period or date, a missing required column, a number that is not a number. The built-in self-test of a portal file re-reads leniently.

## Sample files

| File | Contents | Expected |
|---|---|---|
| `gstr2b-sample.json` | 10 invoices (one reverse charge), 2 credit notes, 1 import | Identical round trip; 4A total IGST 179976 = imports 81000 + reverse charge 2844 + all other 96132 |
| `gstr2b-multirate.json` | One invoice with 12 % and 5 % items | One invoice with 2 items after the round trip |
| `gstr2b-gstin-typo.json` | A 14-character supplier GSTIN | Converts; flagged "Supplier GSTIN … is not a valid GSTIN" |
