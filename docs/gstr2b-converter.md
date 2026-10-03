# GSTR-2B JSON ⇄ Excel converter

AuditOS → Tools → **GSTR-2B JSON ⇄ Excel**. Code: `backend/src/modules/tools/services/tools/gstr2b.ts`.
Tests and sample files: `backend/src/modules/tools/__tests__/gstr2b.test.ts`, `…/__tests__/fixtures/gstr2b/`.

> Sample/test tool. Verify output against a real GST portal download before filing or importing.

## What it guarantees

- **Lossless.** JSON → Excel → JSON gives back the same JSON, key for key and value for value (key order and whitespace aside). Every JSON → Excel conversion re-reads its own workbook and reports **PASS**, or the paths that differ.
- **Codes, not labels.** Excel holds the portal's codes (`R`, `Y`/`N`, `C`, `33`). Labels typed by a person ("Regular", "Yes", "33-Tamil Nadu", "Credit Note") are read back as codes, with a warning for each.
- **Text stays text.** GSTINs, periods (`092026`), document numbers, port codes, BoE numbers and dd-mm-yyyy dates are written as text cells, so Excel never reformats them or drops leading zeros.
- **itcsumm is rebuilt** from the rows on Excel → JSON. Anything typed into the ITC Summary sheet is ignored.

## Workbook layout

| Sheet | Contents |
|---|---|
| Info | GSTIN → `gstin`, Return Period → `rtnprd`, Version → `version`, Generated On → `gendt` |
| B2B, B2BA | One row per invoice **item** (a multi-rate invoice spans several rows) |
| CDNR, CDNRA | One row per credit / debit note item |
| ISD, ISDA | One row per ISD document |
| IMPG | One row per bill of entry |
| IMPGSEZ | One row per bill of entry, with the SEZ supplier |
| ITC Summary | Live formulas: Part A available, credit notes (negative), imports, Net ITC, Part B not available |
| _raw *(hidden)* | Unknown sections, unknown top-level keys (cpsumm, hash…), wrapper keys (chksum), the original itcsumm shape |

Each data sheet also has two hidden columns: `_fields` records which keys each level had (so absent, empty and zero stay different), and `_extra` holds keys the layout has no column for (e.g. `imsStatus`).

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

`itcavl.nonrevsup.{b2b, b2ba, impg, impgsez, isd}` adds documents with ITC available = Y. `cdnr` / `cdnra` are debit notes minus credit notes. `itcunavl.nonrevsup.b2b` is invoices with ITC available = N. When the original JSON had an itcsumm, its shape is kept: every figure that can be computed is recomputed from the rows (any difference is reported), and portal-only figures are carried over.

## Validation

Errors block the conversion: a GSTIN or return period in the wrong format, an invalid dd-mm-yyyy date, a document dated **after** the return period, a duplicate (GSTIN, document number), a value ≠ taxable + taxes (±1), a tax ≠ taxable × rate (±1), IGST and CGST/SGST on the same line, IGST on an intra-state supply or CGST/SGST on an inter-state one (SEZ and bonded-warehouse types are exempt), and a missing required column.

Warnings never block: a label mapped to a code, an unknown section kept in `_raw`, a column empty in every row, a document dated **before** the return period (normal for a supplier's late filing), and an itcsumm figure that differed from the original.

## Sample files

| File | Contents | Expected |
|---|---|---|
| `gstr2b-sample.json` | 10 invoices, 2 credit notes, 1 import | Identical round trip; Net ITC IGST 179976, CGST 20962.5, SGST 20962.5 |
| `gstr2b-multirate.json` | One invoice with 12 % and 5 % items | One invoice with 2 items after the round trip |
| `gstr2b-gstin-typo.json` | A 14-character supplier GSTIN | Blocked: "Supplier GSTIN … is not a valid GSTIN" |
