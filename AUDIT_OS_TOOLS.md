```text
Document: AUDIT_OS_TOOLS.md
Scope:    Tools module — Converters & Utilities (Phase 1)
Status:   BUILT · committed on branch tools-module · pull request to main pending
```

# AUDIT OS · TOOLS — Module Spec

Tools is the third primary destination of AUDIT OS, a sibling of Dashboard and
Workstation. It gives the firm the everyday file conversions and PDF utilities
it currently pays third-party sites for — PDF to Excel, merge, split, unlock,
OCR and the rest — inside the platform, behind the platform's login, with every
output saved, permission-checked and audited.

`AUDIT_OS_HRMS.md` is the platform spec and `AUDIT_OS_WORKSTATION.md` the
operational workspace. This document does not restate either; it records what
Tools adds, the decisions taken where the build brief met the shipped code, and
how a future tool is dropped in without touching the page.

---

## 0. Build contract

### 0.1 What this module does NOT touch

| Untouched | Why |
|---|---|
| HRMS modules and pages (`src/modules/*` except tools, `src/pages/hrms/*`) | Scope lock |
| Workstation modules, routes and API | Tools is a sibling, not a child |
| The Dashboard, TopBar, auth, theme system, `tailwind.config.ts` | Reuse, never redefine |
| `Employee`, `Organisation`, `Role`, `Permission`, `AuditLog` table shapes | One central record each; Tools adds rows and new tables only |
| Existing permission codes | Tools gets its own `tools.*` namespace |
| Existing routes | `/tools` already existed as a top-level route; it now renders the module |

### 0.2 Decisions taken during the build

**D1 · The Tools page did not exist.** The build brief described an existing
18-card page (header, search, three section labels) to refactor "pixel for
pixel". The repository's `/tools` route rendered a reserved placeholder screen,
and no branch held a card page. The page was therefore **built from the brief's
own specification** (§2 of the brief); the pixel-identical refactor step had no
baseline and does not apply.

**D2 · Two card descriptions were changed, as the brief required.** Both
overstated what the tool does, which is a compliance risk for an audit firm:

| Card | Was | Now | Why |
|---|---|---|---|
| e-Sign PDF | Apply DSC / digital signature | **Signature workflow for approvals** | The tool applies a visible mark; it is not a DSC signature under the IT Act |
| Unlock PDF | Remove password from statements | **Remove a known password from a PDF** | The tool decrypts with a password the user supplies; it never guesses or bypasses one |

Nothing else on the 18 cards changed.

**D3 · Audit trail reuses the platform `AuditLog`.** The brief listed a
dedicated `audit_logs` table with `tool_id`, `document_id`, `status` and
`metadata` columns. Adding columns to a table HRMS owns was rejected; Tools
writes through the existing append-only `writeAudit()` with `entityType =
ToolDocument`, and carries tool, document, status and metadata in `afterJson`.
`AuditLogService.forDocument()` reads it back for the Documents drawer.

**D4 · Company = Organisation.** The brief's `company_id` maps to the
platform's existing `organisationId`; no `companies` table was added.

**D5 · Roles.** `tools.*` grants go to exactly the roles that already saw the
Tools menu: `employee` (own documents), `dept_manager` and `md` (firm-wide).
`hr_admin` and `finance_admin` receive no grant and get **403** on every
`/api/tools*` route.

**D6 · One registry, two copies.** The registry lives in code, not the
database. The client copy drives the page; the server copy carries the
enforcement-relevant subset. The three catalogue tables (`ToolCategory`,
`ToolGroup`, `Tool`) are **synced from the server registry by the seed**, so a
`ToolJob` always joins to a stable tool id. This follows the precedent set by
the RBAC matrix, which the platform already mirrors client and server.

**D7 · Tools is a top-level module.** A follow-up request moved the Tools nav
row out of the WORKSTATION sidebar group into its own label-less row after it,
gated by `tools.access`. Routes did not change.

**D8 · Dependencies.** No conversion capability existed in the project. Eight
server packages were added (§10) and three system binaries are required
(§10.1). No frontend package was added.

### 0.3 How changes were applied

Every change was built on the `tools-module` branch, run against the dev
servers, previewed (screenshots plus the live app in the user's browser) and
approved before being committed. Two commits resulted:

```
13e35a7  Tools module: 12 converters, registry, workspace, Documents, audit
1b83611  Sidebar: make Tools a top-level module beside Workstation
```

---

## 1. Deliverables

| # | Deliverable | Definition of done | Status |
|---|---|---|---|
| 1 | Tool registry | 18 entries; page, search, routes and permissions derive from it; no tool referenced by string in the UI | ✓ |
| 2 | Tools page | Header, search, three group labels, 18 cards, Documents entry point; 3 / 2 / 1 column grid | ✓ |
| 3 | Workspace framework | One `/tools/:toolId` page; dropzone, file list, processing, result, error, coming-soon | ✓ |
| 4 | 12 working tools | Document conversion (6) + PDF utilities (6), real output files | ✓ |
| 5 | Compliance converters | 6 cards render unchanged; `Open →` lands on Coming soon; no parser, no model | ✓ |
| 6 | Data model + storage | Catalogue, job and document tables; `StorageAdapter` with a local implementation | ✓ |
| 7 | Documents view | Search, filters, preview, download, delete, detail drawer with audit trail; card list on mobile | ✓ |
| 8 | Security | Per-tool permission, owner/firm scoping, MIME + magic bytes, size limits, signed downloads | ✓ |
| 9 | Audit log | Upload, start, complete, fail, download, preview, delete, unlock authorisation, e-sign applied | ✓ |
| 10 | Tests | Fixture files + expected JSON, service smoke run, headless browser run of all 12 tools | ✓ |
| 11 | Top-level navigation | Tools is a sibling of Dashboard and Workstation | ✓ |

---

## 2. Platform reuse — the inheritance list

Nothing below is re-implemented. Tools consumes it as-is.

| Concern | Reused primitive |
|---|---|
| Response envelope | `{ data }` / `{ error }` — `src/services/api.ts`, `server/src/lib/http.ts` |
| Auth | JWT cookie; `authenticate` mounted once in `app.ts` |
| Authorize | `can(session, code, scope)` — `server/src/platform/auth.ts` |
| Audit | `writeAudit()` — append-only `AuditLog` |
| Signed files | `signResource()` / `verifyResourceToken()` / `signedLink()` — HMAC bound to resource, user and expiry |
| Soft delete | `deletedAt` + the `alive` where-fragment |
| Serialization | camelCase DB ↔ snake_case API in one file, `server/src/modules/tools/serialize.ts` |
| UI kit | `Button`, `Toast`, `StatusLabel`, Workstation `Table / Row / Cell / FilterBar / Select / Modal / QueryState / Card` |
| Dates | `fmtDate` / `fmtTime` / `fmtDateTime`, IST |
| Design tokens | `tailwind.config.ts` — neutrals + gold, 4px radius, 40px rows, 2px left-border status |
| Mock mode | MSW handler registry — Tools endpoints answer 503 with a clear message |

### 2.1 Design rules restated as build constraints

- Badge tints (green / blue / indigo / amber / rose) are **inline hex values**
  on the badge component only. The Tailwind palette is deliberately locked to
  neutrals and gold, so no `bg-green-*` utility exists and none was added.
- Section labels are small, muted, letter-spaced, sentence case — exactly the
  brief's wording, not the platform's uppercase section style.
- One gold element per screen: the action button in a workspace, the
  `Open →` links on the page, the Download button on a result.
- Status is a 2px left border plus text weight. Failed rows in Documents carry
  the red border; never a filled pill.
- No spinner, no shimmer: a static bar that fills (determinate) or sweeps
  (indeterminate).

---

## 3. Information architecture

Categories and groups are registry concepts. The page renders only the three
group labels; category headings are never shown.

```
TOOLS
│
├── Converters & Utilities ............................ category · active
│   ├── Document conversion ........................... group · 6 tools
│   │     PDF to Excel · Excel to PDF · PDF to Word
│   │     Word to PDF · Image to PDF · CSV to Excel
│   └── PDF utilities ................................. group · 6 tools
│         Merge PDF · Split PDF · Compress PDF
│         Unlock PDF · e-Sign PDF · OCR Scan
│
├── Finance & Compliance .............................. category · coming_soon
│   └── Compliance converters ......................... group · 6 cards
│         GST JSON ⇄ Excel · Bank Statement to Excel
│         Form 26AS to Excel · Excel to Tally XML
│         TDS Text/FVU Generator · Invoice to e-Invoice JSON
│
└── Documents ......................................... storage & history
      /tools/documents — search · filter · preview · download · delete
```

### 3.1 Routes

```
/tools                    Tools & Converters page
/tools/documents          Documents (generated files)
/tools/:toolId            one shared workspace for every registry id
```

`/tools/documents` is declared before `/tools/:toolId`. Every route sits under
the existing `ProtectedRoute` + `AppShell`.

### 3.2 Navigation

```
AUDIT OS
├── Dashboard
├── AUDIT          (HRMS section)
├── WORKSTATION    Overview · Leads · Clients · Follow-ups · Services · Documents
└── Tools          top-level row, gated by tools.access
```

Tools is a label-less nav group like Dashboard: it is never inside the
WORKSTATION fold state, it highlights on `/tools/*`, and it is present in the
collapsed rail and the mobile drawer.

---

## 4. The registry

`src/modules/tools/registry.ts` (client) and
`server/src/modules/tools/registry.ts` (server, enforcement subset).

```ts
type ToolCategory = { id; label; order; status: 'active' | 'coming_soon' }
type ToolGroup    = { id; label; categoryId; order }
type ToolDefinition = {
  id            'pdf-to-excel'
  name          exact card title
  description   exact card description
  badge         { text?: 'PDF→XLS'; icon?: LucideIcon; tint: green|blue|indigo|amber|rose }
  groupId       'document-conversion' | 'pdf-utilities' | 'compliance-converters'
  route         '/tools/pdf-to-excel'
  accepts       MIME types the dropzone and the upload route accept
  extensions    lower-case extensions for the picker and the "Supported" line
  maxFileSizeMB per-file limit, enforced client- and server-side
  multiple      one file or many
  outputType    pdf | xlsx | docx | csv | txt | zip | json | xml
  keywords      search terms beyond name / description / group label
  permission    'tools.pdf_to_excel'
  status        'active' | 'coming_soon'
}
```

### 4.1 The 18 entries

| Group | Tool | Badge · tint | In | Out | Status |
|---|---|---|---|---|---|
| Document conversion | PDF to Excel | `PDF→XLS` green | PDF | XLSX | active |
| | Excel to PDF | `XLS→PDF` green | XLSX, XLS | PDF | active |
| | PDF to Word | `PDF→DOC` blue | PDF | DOCX | active |
| | Word to PDF | `DOC→PDF` blue | DOCX | PDF | active |
| | Image to PDF | `IMG→PDF` indigo | JPG, PNG, WEBP (multi) | PDF | active |
| | CSV to Excel | `CSV→XLS` green | CSV, TSV, TXT | XLSX | active |
| PDF utilities | Merge PDF | `MERGE` amber | PDF (multi) | PDF | active |
| | Split PDF | `SPLIT` amber | PDF | PDF or ZIP | active |
| | Compress PDF | `ZIP` amber | PDF (50 MB) | PDF | active |
| | Unlock PDF | lock glyph rose | PDF | PDF | active |
| | e-Sign PDF | pen glyph rose | PDF | PDF | active |
| | OCR Scan | `OCR` indigo | PDF, JPG, PNG, WEBP | PDF + TXT | active |
| Compliance converters | GST JSON ⇄ Excel | `JSON` blue | JSON, XLSX | XLSX | coming_soon |
| | Bank Statement to Excel | `BANK` green | PDF | XLSX | coming_soon |
| | Form 26AS to Excel | `26AS` indigo | PDF, TXT | XLSX | coming_soon |
| | Excel to Tally XML | `TALLY` amber | XLSX | XML | coming_soon |
| | TDS Text/FVU Generator | `FVU` rose | XLSX | TXT | coming_soon |
| | Invoice to e-Invoice JSON | `IFF` blue | XLSX | JSON | coming_soon |

Default per-file limit is 25 MB; Image to PDF is 20 MB per image, Compress PDF
is 50 MB. The upload route has a hard ceiling of 50 MB regardless.

### 4.2 Turning a compliance converter on later

1. `status: 'active'` in both registry files.
2. Add its implementation to `IMPLEMENTATIONS` in
   `server/src/modules/tools/runner.ts`.
3. Add its option form (if any) to `TOOL_UI` in `src/modules/tools/tools/`.
4. `npm --prefix server run seed:tools`.

Nothing on the page, in the workspace framework, the storage layer, the
Documents view or the permission matrix moves. The permission code already
exists for all six.

### 4.3 Search

Filters the registry by name, description, group label and keywords; every
term must match. Groups with no remaining cards disappear; no match shows an
empty state with suggested terms, never a blank grid.

| Query | Matches |
|---|---|
| `pdf` | 12 — every PDF tool, e-Sign, OCR, Bank Statement ("Parse PDF statements") |
| `excel` | 8 — PDF/CSV/Excel converters, GST, Bank, 26AS, Tally |
| `tally` | 1 — Excel to Tally XML |

---

## 5. Data model

Five new tables. Prisma model names follow the schema's PascalCase convention;
the API speaks snake_case through `serialize.ts`.

```
ToolCategory        id · key · label · order · status
ToolGroup           id · key · label · categoryId · order
Tool                id · key · name · description · groupId · outputType
                    permissionKey · status

ToolDocument        id · organisationId · userId · kind (input|output)
                    originalFilename · storedFilename · mimeType · fileSize
                    storagePath · sourceTool · parentDocumentId
                    status (processing|completed|failed) · errorMessage
                    metaJson · createdAt · updatedAt · deletedAt
ToolDocumentVersion id · documentId · version · storagePath · fileSize

ToolJob             id · toolId · userId · organisationId
                    inputDocumentId · outputDocumentId
                    status (queued|processing|completed|failed) · progress
                    errorMessage · metaJson · startedAt · completedAt
```

One document model for all tools — no per-tool table. An uploaded input is a
`ToolDocument` of kind `input`; every run produces a kind `output` record, even
when it fails (status `failed`, `errorMessage` set, no bytes). A job's
`metaJson` holds the options it ran with (passwords and drawn signature bitmaps
are stripped before persistence), the input ids, warnings and any companion
outputs (OCR's `.txt`).

`Organisation` and `User` gain `toolDocuments` and `toolJobs` relations; no
existing column changed.

### 5.1 Storage

```
server/src/modules/tools/storage/
  StorageAdapter.ts        put · get · exists · localPath · delete · getSignedUrl
  LocalStorageAdapter.ts   server/uploads/tools/<org>/<doc>/<random>-<name>
  index.ts                 the one instance the module uses
```

Keys are generated server-side and validated against traversal before they
touch the disk. Nothing is persisted only in the browser. Swapping to S3 or
Supabase is one adapter and one line in `index.ts`; routes and services do not
change.

---

## 6. Permissions

New codes, `tools.*` namespace, in both matrix files:

```
tools.access                  open the module (sidebar, every route)
tools.documents.read          Documents view; organisation scope = whole firm
tools.documents.manage        delete; self = own documents, organisation = any
tools.<tool_key>              one per tool, e.g. tools.pdf_to_excel, tools.esign_pdf
```

| Role | Grants | Scope |
|---|---|---|
| `employee` | all `tools.*` | `self` — own documents only |
| `dept_manager` | all `tools.*` | `organisation` |
| `md` | all `tools.*` | `organisation` |
| `hr_admin`, `finance_admin` | none | 403 on every Tools route; no nav entry |

The client `can()` decides only what to render; the API is the control.
A card whose permission the caller lacks still renders (the page is complete)
with its `Open →` muted; the workspace behind it shows a permission notice and
the API returns 403.

### 6.1 Scope

`DocumentService.documentScope()` folds scope into every Prisma `where`:
organisation-level readers see the firm's documents; everyone else sees rows
where `userId` is their own. There is no post-fetch filtering and no path to
another organisation's document. Job inputs are always resolved with
`getOwnedDocuments()` — a job can only consume files its caller uploaded.

---

## 7. Screens

### 7.1 Tools & Converters (`/tools`)

Header: title, subtitle, search on the same line (below the title on mobile),
`Documents` button beside the search. Body: one section per group, cards in a
3 / 2 / 1 column grid. Card anatomy is badge · title · description · `Open →`.

### 7.2 Workspace (`/tools/:toolId`)

One page for all twelve tools. The registry names the tool, `TOOL_UI` supplies
its option form and button labels, `useToolWorkspace` runs the state machine:

```
idle → validating → ready → processing → success
                  ↘ invalid           ↘ failed
```

Files are validated in the browser (type, size, count) and uploaded as soon as
they are added, so the server has already inspected them (page count,
encryption, image size, CSV detection) by the time the user clicks the action.
The action creates a job and polls it; progress is determinate where the
service reports it. A failed run keeps the inputs on screen so an option can
be fixed and the action pressed again.

Shared pieces: `ToolWorkspaceLayout`, `FileDropzone`, `FileList` (reorderable
for Merge and Image to PDF), `ProcessingState`, `ResultPanel` (Preview ·
Download · Open in Documents · Convert another), `ToolErrorState` (message,
Try again, Start over, and a link to the tool that fixes the problem),
`ComingSoonState`.

Per-tool options:

| Tool | Options | Result note |
|---|---|---|
| PDF to Excel | — | tables extracted; pages with no table listed on a Summary sheet, never dropped |
| Excel to PDF | fit sheets to page width (default on) | page count |
| PDF to Word | — (refuses scans, points to OCR) | paragraphs, tables, pages |
| Word to PDF | — | page count |
| Image to PDF | page size A4 / Letter / Fit, orientation, margin; reorder | page count |
| CSV to Excel | delimiter, encoding, header row (auto-detected, overridable); per-column "keep as text"; sample rows | rows × columns, detection |
| Merge PDF | reorder; page count per file | files, pages |
| Split PDF | ranges (`1-3, 7, 10-12`) with clickable page thumbnails, or every N pages | files produced, ZIP when many |
| Compress PDF | Low / Recommended / High | before → after, reduction %, warning when negligible; never returns a larger file |
| Unlock PDF | password (required), "I am authorised" confirmation (required, audited) | pages, unencrypted |
| e-Sign PDF | signer name, designation, date, reason, placement, page (thumbnails), optional drawn signature | signer, page, date, "Not a DSC signature" |
| OCR Scan | outputs: searchable PDF and/or `.txt` | confidence overall and per page, extracted text with Copy |

### 7.3 Documents (`/tools/documents`)

Filters in the URL: search (filename, tool, type), Type, Tool, Status, Created
by (organisation scope only), From, To, and Show (generated files · uploaded
sources · everything). The CRM table on desktop; a card list on mobile.
Actions per row: Preview (PDF, image, Excel, CSV, text), Download. Row click
opens the detail drawer: status and reason, tool, type, size, created, by,
note; source file; job timing; audit trail; a two-step inline Delete when
permitted. Preview is a modal: PDF in an iframe on a signed inline URL,
images inline, spreadsheets as rows per sheet, text as-is; Word and ZIP say
so and offer Download.

---

## 8. Services

No conversion logic in a route or a component. Services never import React or
Express; Buffers in, Buffers out.

```
server/src/modules/tools/
  registry.ts                       enforcement subset of the registry
  routes.ts                         HTTP surface (§9)
  runner.ts                         IMPLEMENTATIONS map + job execution
  serialize.ts                      rows → snake_case API shapes
  lib/files.ts                      magic-byte sniffing, filename sanitising
  lib/exec.ts                       external processes, temp dirs, LibreOffice queue
  storage/                          §5.1
  services/
    DocumentService.ts              create · saveGenerated · saveFailed · list · get · link · delete
    ToolJobService.ts               createJob · updateStatus · progress · completeJob · failJob
    AuditLogService.ts              log(action, tool, document, status, meta) · forDocument
    errors.ts                       ToolError codes → user messages
    tools/PDFService.ts             pdfjs text with coordinates, table detection, merge, split,
                                    compress (gs), unlock (gs), thumbnails and rasters (pdftoppm)
    tools/ExcelService.ts           excelToPdf (LibreOffice), pdfToExcel, csvToExcel, preview
    tools/WordService.ts            wordToPdf (LibreOffice), pdfToWord (docx)
    tools/CSVService.ts             encoding + delimiter detection, RFC 4180 parse, typing
    tools/ImageService.ts           sharp normalise, imagesToPdf
    tools/OCRService.ts             OCREngine seam; TesseractEngine; searchable PDF
    tools/SignatureProvider.ts      SignatureProvider seam; VisibleMarkProvider
```

### 8.1 Accuracy rules that matter to an audit firm

- **CSV → Excel** never mangles identifiers: a value with a leading zero
  (`0001`, `000123`, a GSTIN, a TAN) stays text; dates stay the text the file
  carried; only unambiguous numbers become numeric cells, including Indian
  grouping (`1,25,000.00`), Western grouping, `₹`/`Rs` prefixes and `(9,800)`
  accounting negatives. Any column can be forced to text.
- **PDF → Excel** detects tables from text coordinates. Column spans come from
  the rows with the most cells, so a merged header cannot swallow the columns
  beneath it; right-aligned numbers land under their heading; a single-cell
  line inside a table is a multi-line cell continuation, appended not dropped.
  Pages without a table are named on the Summary sheet.
- **PDF → Word** keeps headings (by font size and weight), bullet lists (bullet
  glyphs are list markers, not table columns), tables and page breaks. It
  refuses a PDF without a text layer and points to OCR Scan.
- **Compress** never returns a file larger than the input; when Ghostscript's
  output grows, the original is kept and the user is told.
- **Unlock** reads Ghostscript's transcript (it exits 0 on a wrong password),
  verifies the output is decrypted and has the same page count, and otherwise
  reports "Incorrect password." It never retries or guesses.
- **e-Sign** is a workflow aid. The mark, the UI, the result note and the
  stored metadata all say it is not a DSC. A DSC/ASP provider plugs into
  `SignatureProvider.apply()` and returns `kind: 'dsc'`.
- **OCR** reports a confidence per page and flags pages below 60%.

### 8.2 The runner

`enqueue()` runs a job on one of two slots. The implementation receives the
inputs (bytes loaded), validated options and a progress callback, and returns
the output bytes plus facts worth keeping and an honest `warning` for partial
results. Around it, uniformly: job status, the output document record (or the
failed record), companion outputs, and audit entries. A thrown `ToolError`
reaches the user verbatim; anything else becomes "Conversion failed. Please
try again." and the stack goes to the server log only.

---

## 9. API contract

Every route: `authenticate → requireTools / requireTool(permission) → validate
→ handle → audit`. Same envelope and codes as the platform.

```
REGISTRY
GET    /api/tools                                   18 tools with permitted / implemented flags

UPLOAD
POST   /api/tools/uploads?tool_id=…                 multipart "files"; validates count,
                                                    size, MIME and magic bytes; inspects
                                                    PDFs, images and CSVs; → input documents

JOBS
POST   /api/tools/:toolId/jobs                      { input_document_ids, options } → 202 job
GET    /api/tool-jobs/:id                           status, progress, output document

DOCUMENTS
GET    /api/tool-documents                          scoped list; q · kind · file_type · tool ·
                                                    status · user_id · from · to
GET    /api/tool-documents/:id                      document, source, jobs, audit, can_delete
GET    /api/tool-documents/:id/link[?inline=1]      signed URL (audited as download / preview)
GET    /api/tool-documents/:id/preview              sheets · text · pdf/image link · none
GET    /api/tool-documents/:id/pages                page count + signed thumbnail links
DELETE /api/tool-documents/:id                      soft delete + bytes removed

SIGNED (mounted before authenticate; the HMAC is the authorization)
GET    /api/tool-documents/:id/download?t=…[&inline=1]
GET    /api/tool-documents/:id/thumbs/:page?t=…
```

Error codes a client can rely on: `unsupported_type · too_large · empty ·
single_only · coming_soon · not_found · forbidden · no_file`; and inside a
failed job: `unreadable · encrypted · not_encrypted · wrong_password ·
no_tables · no_text_layer · invalid_range · invalid_options · not_authorised
· engine_unavailable · failed`.

---

## 10. Dependencies

Added to `server/package.json` (pinned exactly, like the rest of the file):

| Package | Used for |
|---|---|
| `multer` | multipart uploads in memory |
| `pdf-lib` | merge, split, page count, drawing the signature mark, OCR text layer, Image to PDF |
| `pdfjs-dist` | text extraction with coordinates (PDF to Excel / Word, text-layer gate) |
| `exceljs` | reading and writing `.xlsx` |
| `docx` | building `.docx` |
| `jszip` | ZIP output for Split, OOXML sniffing |
| `tesseract.js` | OCR (WASM; English data downloaded once, cached) |
| `sharp` | image normalisation (EXIF, WEBP, colour space), OCR input |

No frontend package was added.

### 10.1 System binaries

| Binary | Package | Used for |
|---|---|---|
| `soffice` | LibreOffice | Excel → PDF, Word → PDF |
| `gs` | Ghostscript | Compress, Unlock |
| `pdftoppm` | poppler-utils | page thumbnails, OCR rasters |

All three must be on `PATH` of the API process. LibreOffice runs one
conversion at a time with a throwaway profile directory per call.

### 10.2 Environment

| Variable | Default | Purpose |
|---|---|---|
| `TOOLS_STORAGE_ROOT` | `server/uploads/tools` | local storage root |
| `TOOLS_OCR_CACHE` | `server/uploads/ocr-cache` | tesseract language data |
| `WEB_ORIGIN` | `http://localhost:5173` | must include every origin the app is opened from |

---

## 11. Security

- Every Tools route is behind `authenticate`; every tool behind its own
  permission code; Documents behind `tools.documents.read`; delete behind
  `tools.documents.manage` at the right scope.
- Uploads are validated by count, size, declared MIME **and** magic bytes. A
  CSV renamed `.pdf` is refused; an OOXML zip is told apart as `.xlsx` or
  `.docx` by its entries. The hard upload ceiling is 50 MB.
- Filenames are sanitised for display and headers; storage keys are generated
  server-side and traversal-checked in the adapter.
- Files are never publicly reachable. Downloads and thumbnails use the
  platform's short-lived HMAC links; a missing or expired token is 403.
- Job inputs must be the caller's own uploads. Passwords and drawn signatures
  are used once and never persisted in job metadata.
- Unlock requires an explicit authorisation confirmation, recorded in the audit
  log with the user and time before decryption starts.
- Raw errors never reach the client; only `ToolError` messages do.

---

## 12. Audit log

Every entry is `tools.<action>` on `entityType = ToolDocument`:

```
upload · conversion_started · conversion_completed · conversion_failed
download · preview · delete · unlock_authorised · esign_applied
```

Actor, ip, user-agent and timestamp come from the platform primitive; tool,
document, job, status and per-action facts (from → to, size, code, message,
signer) ride in `afterJson`. The Documents drawer renders the merged trail of
an output and its source, newest first:

```
Ravi Krishnan · Converted with CSV to Excel · ledger.csv → ledger.xlsx
08 Sept 2026 · 11:14 AM · Success
```

---

## 13. Seed and scripts

```bash
npm --prefix server run prisma:push     # creates the five tables
npm --prefix server run seed            # full seed (permissions, roles, catalogue …)
npm --prefix server run seed:tools      # catalogue only, from the registry

npx tsx server/src/modules/tools/__tests__/make-fixtures.ts   # regenerate sample inputs
npx tsx server/src/modules/tools/__tests__/smoke.ts           # every service on the fixtures
node scripts/verify-tools.mjs                                 # all 12 tools in a headless browser
node scripts/verify-nav-tools.mjs                             # sidebar hierarchy and active states
```

Fixtures live in `server/src/modules/tools/__tests__/fixtures/`: an invoice
workbook, an engagement letter, a ledger CSV with leading zeros, Indian
grouping and an accounting negative, and a synthetic scan as PNG / JPG / WEBP.
`fixtures/expected/*.json` holds the ground truth the smoke run diffs against
(cell by cell, typed) for PDF to Excel and CSV to Excel; drop the firm's
paid-tool exports into the same shape to compare against those instead.
Generated outputs land in `fixtures/out/` (git-ignored).

---

## 14. File plan

```
server/prisma/schema.prisma                    MODIFIED  +5 models, 2 relations added
server/prisma/seed.ts                          MODIFIED  + seedTools()
server/prisma/seed-tools.ts                    new
server/package.json / package-lock.json        MODIFIED  +8 dependencies, seed:tools script
server/src/app.ts                              MODIFIED  +4 router mounts
server/src/platform/rbac/matrix.ts             MODIFIED  +21 codes, grants, descriptions
server/src/modules/tools/**                    new       §8

src/platform/rbac/matrix.ts                    MODIFIED  +21 codes, grants
src/App.tsx                                    MODIFIED  Tools page swap, +2 routes
src/shell/v2/Sidebar.tsx                       MODIFIED  Tools moved to a top-level row
src/data/mock/handlers/index.ts                MODIFIED  + toolsHandlers
src/data/mock/handlers/tools.ts                new       503 in mock mode
src/modules/tools/registry.ts                  new       the registry
src/modules/tools/{types,api,format}.ts        new
src/modules/tools/ToolBadge.tsx                new
src/modules/tools/workspace/*                  new       framework + state machine
src/modules/tools/tools/*                      new       per-tool option forms
src/modules/tools/documents/*                  new       table, drawer, preview
src/pages/tools/{Tools,ToolWorkspace,ToolDocuments}.tsx   new
src/pages/reserved/Tools.tsx                   UNCHANGED no longer routed; safe to delete later

scripts/verify-tools.mjs                       new
scripts/verify-nav-tools.mjs                   new
README.md                                      MODIFIED  Tools section, verify script
.gitignore                                     MODIFIED  fixtures/out
```

---

## 15. Acceptance criteria

Automated by `scripts/verify-tools.mjs` (35 checks) and
`scripts/verify-nav-tools.mjs` (18 checks); both pass with zero console
errors on the committed branch.

**Registry & page**
- [x] Page renders from the registry; 18 cards; names, descriptions, badges and tints as specified
- [x] Search filters live by name, description, group label and keywords; empty groups hidden; no-match state
- [x] Documents entry point on the page
- [x] Six compliance cards route to Coming soon; no parser, model or service exists for them

**Tools**
- [x] Twelve tools produce real output files that open in their application
- [x] Upload, validation, processing, success and error states all exercised
- [x] Partial results are reported, never presented as clean success
- [x] A failed run creates a `failed` document record with its reason
- [x] PDF to Excel and CSV to Excel match expected results cell by cell, including numeric precision, leading zeros and dates as text

**Documents**
- [x] Every output appears in Documents automatically
- [x] Search, filters, preview, download, delete and the detail drawer work
- [x] Card list on mobile; table on desktop

**Security / RBAC**
- [x] `hr_admin` / `finance_admin` get 403 on `/api/tools` and Documents
- [x] An `employee` sees only their own documents; another user's document is 404
- [x] A renamed CSV is refused as a PDF; a download without a token is 403
- [x] Unlock refuses a wrong password and records the authorisation confirmation

**Navigation**
- [x] Dashboard, Workstation and Tools are sibling top-level entries
- [x] Workstation contains only its six modules; folding it does not hide Tools
- [x] Tools highlights on `/tools/*`; only the Workstation child highlights on `/workstation/*`
- [x] Refresh works on `/tools` and Workstation routes; collapsed rail and mobile drawer include Tools

**Platform**
- [x] Dashboard, HRMS and Workstation still render; no console errors
- [x] `tsc` clean in both projects; `vite build` passes

---

## 16. Open items

| # | Item | Status |
|---|---|---|
| 1 | Compliance converters (GST, bank statement, 26AS, Tally, FVU, e-Invoice) | Cards only; implementation per §4.2 when specified |
| 2 | DSC / ASP signing provider | **[DECIDE]** which provider; seam exists in `SignatureProvider` |
| 3 | Production object storage (S3 / Supabase) | One adapter in `storage/`; not wired |
| 4 | Paid-tool comparison files | **[VERIFY]** drop the firm's current exports into `fixtures/expected/` |
| 5 | OCR languages beyond English | tesseract.js supports more; UI fixed to `eng` |
| 6 | `hr_admin` / `finance_admin` access to Tools | **[DECIDE]** no grant now; the sidebar hides Tools for them |
| 7 | `src/pages/reserved/Tools.tsx` | Unrouted; delete in a later cleanup commit |
| 8 | Bundle size warning (recharts + tools > 500 kB) | Pre-existing; route-level code splitting is a separate task |
