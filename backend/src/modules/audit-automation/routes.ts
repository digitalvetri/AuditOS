import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { prisma } from '../../lib/prisma.js'
import { sanitizeFilename, sniffMime, extensionOf } from '../tools/lib/files.js'
import { AaBankService } from './services/AaBankService.js'
import { AaAccountService } from './services/AaAccountService.js'
import { AaUploadService } from './services/AaUploadService.js'
import { AaJobService } from './services/AaJobService.js'
import { AaTxnService } from './services/AaTxnService.js'
import { AaRuleService } from './services/AaRuleService.js'
import { writeAudit } from '../../platform/audit.js'
import { readStatementTable } from './lib/tableFile.js'
import { assertClientVisible, assignedClientIds, seesAllClients } from '../../platform/workstation/scope.js'
import { scanUploads } from '../../platform/virusScan.js'

/**
 * AUDIT AUTOMATION HTTP SURFACE.
 *
 *   GET  /api/audit-automation/banks                    — bank picker
 *   GET  /api/audit-automation/accounts?client_id=…     — accounts for a client
 *   POST /api/audit-automation/accounts                 — add account
 *   POST /api/audit-automation/uploads                  — the wireframe submit
 *   GET  /api/audit-automation/jobs?client_id=…         — jobs for a client
 *   GET  /api/audit-automation/jobs/:id                 — one job
 *   GET  /api/audit-automation/jobs/:id/rows            — transactions (filter, search, page)
 *   PATCH /api/audit-automation/rows/:id                — edit / exclude / accept a transaction
 *   PATCH /api/audit-automation/jobs/:id                — bank ledger name, FY
 *   POST /api/audit-automation/jobs/:id/apply-rules     — re-apply ledger rules
 *   POST /api/audit-automation/jobs/:id/approve|reopen  — review sign-off
 *   GET  /api/audit-automation/jobs/:id/export/tally.xml — Tally vouchers (approved only)
 *   GET  /api/audit-automation/jobs/:id/export.xlsx     — reviewed transactions workbook
 *   POST /api/audit-automation/jobs/:id/reprocess       — read the statement again
 *   DELETE /api/audit-automation/jobs/:id               — delete the statement
 *   GET/POST/PATCH/DELETE /api/audit-automation/rules   — narration → ledger rules
 *
 * Pipeline per request: authenticate (mounted in app.ts) → authorize
 * (checked inside each handler with can(...) / require*) → validate
 * (Zod) → handle → audit (inside services). Errors surface through
 * the platform's ApiError so the shared error middleware serialises
 * them uniformly.
 */
export const auditAutomationRouter = Router()

const MAX_MB = 25
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
})

function requireAaAccess(session: Session) {
  if (!can(session, 'tools.audit_automation.access', 'self')) {
    throw ApiError.forbidden('You do not have access to Audit Automation.')
  }
}
function requireAaUpload(session: Session) {
  if (!can(session, 'tools.audit_automation.bank.upload', 'self')) {
    throw ApiError.forbidden('You do not have permission to upload bank statements.')
  }
}
function requireAaView(session: Session) {
  if (!can(session, 'tools.audit_automation.bank.view', 'self')) {
    throw ApiError.forbidden('You do not have permission to view Audit Automation jobs.')
  }
}
async function orgIdOf(userId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { organisationId: true } })
  return u.organisationId
}

// ── Banks ────────────────────────────────────────────────────────────────
auditAutomationRouter.get('/banks', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaAccess(session)
  const banks = await AaBankService.listActive()
  ok(res, { items: banks, count: banks.length })
}))

// ── Accounts ─────────────────────────────────────────────────────────────
auditAutomationRouter.get('/accounts', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaAccess(session)
  const q = z.object({
    client_id: z.string().min(1),
    bank_id: z.string().optional(),
  }).safeParse(req.query)
  if (!q.success) throw ApiError.badRequest('client_id is required.')
  await assertClientVisible(session, q.data.client_id)
  const items = await AaAccountService.listForClient(session, q.data.client_id, q.data.bank_id)
  ok(res, { items, count: items.length })
}))

auditAutomationRouter.post('/accounts', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  const b = z.object({
    client_id: z.string().min(1),
    bank_id: z.string().min(1),
    account_number_masked: z.string().min(1),
    label: z.string().optional().nullable(),
    currency: z.string().length(3).optional(),
  }).safeParse(req.body)
  if (!b.success) throw ApiError.badRequest('client_id, bank_id and account_number_masked are required.')
  await assertClientVisible(session, b.data.client_id)
  const account = await AaAccountService.create(session, {
    clientId: b.data.client_id,
    bankId: b.data.bank_id,
    accountNumberMasked: b.data.account_number_masked,
    label: b.data.label ?? null,
    currency: b.data.currency,
  })
  ok(res, account, 201)
}))

// ── Uploads (the §3 wireframe target) ────────────────────────────────────
auditAutomationRouter.post('/uploads', (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return scanUploads(req, res, next)
    const code = (err as { code?: string }).code
    if (code === 'LIMIT_FILE_SIZE') return next(ApiError.unprocessable('too_large', `File is larger than the ${MAX_MB} MB limit.`))
    next(ApiError.badRequest('Upload could not be read.'))
  })
}, handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)

  const body = z.object({
    client_id: z.string().min(1),
    bank_key: z.string().min(1),
    bank_account_id: z.string().min(1),
    // Optional password — never persisted (see AaUploadService).
    password: z.string().max(256).optional(),
    authorised: z.string().optional(),
    fy: z.string().optional(),
    override_adapter_mismatch: z.string().optional(),
  }).safeParse(req.body)
  if (!body.success) throw ApiError.badRequest('client_id, bank_key and bank_account_id are required.')
  await assertClientVisible(session, body.data.client_id)

  const file = req.file
  if (!file) throw ApiError.unprocessable('empty', 'Choose a file to upload.')
  if (file.size === 0) throw ApiError.unprocessable('empty', 'The uploaded file is empty.')

  // (a) File type — magic-byte sniff. PDF, or the bank's Excel / CSV download.
  const filename = sanitizeFilename(Buffer.from(file.originalname, 'latin1').toString('utf8'))
  const ext = extensionOf(filename)
  const sniffed = await sniffMime(file.buffer, ext)
  let format: 'pdf' | 'xlsx' | 'csv'
  if (sniffed === 'application/pdf') format = 'pdf'
  else if (ext === 'xlsx' || file.buffer.subarray(0, 2).toString('latin1') === 'PK') format = 'xlsx'
  else if (ext === 'csv' || ext === 'txt') format = 'csv'
  else throw ApiError.unprocessable('unsupported_type', 'Bank statements must be a PDF, Excel (.xlsx) or CSV file.')
  const table = format === 'pdf' ? undefined : await readStatementTable(file.buffer, format)

  const organisationId = await orgIdOf(session.userId)
  const result = await AaUploadService.process({
    session,
    organisationId,
    clientId: body.data.client_id,
    bankKey: body.data.bank_key,
    bankAccountId: body.data.bank_account_id,
    originalFilename: filename,
    mimeType: sniffed ?? (format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv'),
    bytes: file.buffer,
    format,
    table,
    fy: body.data.fy || null,
    authorised: body.data.authorised === '1' || body.data.authorised === 'true',
    password: body.data.password || undefined,
    overrideAdapterMismatch: body.data.override_adapter_mismatch === '1' || body.data.override_adapter_mismatch === 'true',
    req,
  })

  ok(res, {
    job: result.job,
    source_document_id: result.source_document_id,
    detection: result.detection,
    page_count: result.page_count,
    declared_page_count: result.declared_page_count,
    flags: result.flags,
  }, 201)
}))

// ── Jobs ─────────────────────────────────────────────────────────────────
auditAutomationRouter.get('/jobs', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaView(session)
  const q = z.object({ client_id: z.string().min(1) }).safeParse(req.query)
  if (!q.success) throw ApiError.badRequest('client_id is required.')
  await assertClientVisible(session, q.data.client_id)
  const items = await AaJobService.listForClient(session, q.data.client_id)
  ok(res, { items, count: items.length })
}))

auditAutomationRouter.get('/jobs/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaView(session)
  const job = await AaJobService.get(session, req.params.id)
  // Include source-document facts so the detail page can render without a second call.
  const doc = await prisma.aaSourceDocument.findFirst({
    where: { id: job.source_document_id, deletedAt: null },
    include: { bank: true, bankAccount: true, uploadedBy: { include: { employee: true } } },
  })
  // Earlier Tally exports, so the page can warn before a second import.
  const exportsDone = await prisma.aaExport.findMany({ where: { jobId: job.id, kind: 'tally_xml' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, rowCount: true } })
  ok(res, {
    job,
    tally_exports: exportsDone.map((e) => ({ at: e.createdAt.toISOString(), rows: e.rowCount })),
    source_document: doc ? {
      id: doc.id,
      original_filename: doc.originalFilename,
      file_size: doc.fileSize,
      page_count: doc.pageCount,
      declared_page_count: doc.declaredPageCount,
      encrypted: doc.encrypted,
      source_format: doc.sourceFormat,
      bank: { id: doc.bank.id, key: doc.bank.key, name: doc.bank.name },
      bank_account: { id: doc.bankAccount.id, account_number_masked: doc.bankAccount.accountNumberMasked, label: doc.bankAccount.label },
      uploaded_by: { id: doc.uploadedBy.id, label: doc.uploadedBy.employee?.fullName ?? doc.uploadedBy.email },
      uploaded_at: doc.createdAt.toISOString(),
    } : null,
  })
}))

// ── Transactions: review, edit, approve, export ─────────────────────────
auditAutomationRouter.get('/jobs/:id/rows', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaView(session)
  const q = z.object({ status: z.string().optional(), search: z.string().max(100).optional(), limit: z.coerce.number().optional(), offset: z.coerce.number().optional() }).parse(req.query)
  ok(res, await AaTxnService.list(session, req.params.id, q))
}))

auditAutomationRouter.patch('/rows/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  ok(res, await AaTxnService.update(session, req.params.id, (req.body ?? {}) as Record<string, unknown>, req))
}))

auditAutomationRouter.patch('/jobs/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  const b = z.object({ bank_ledger_name: z.string().max(120).optional(), fy: z.string().max(7).optional() }).parse(req.body ?? {})
  await AaTxnService.setJob(session, req.params.id, b, req)
  ok(res, await AaJobService.get(session, req.params.id))
}))

auditAutomationRouter.post('/jobs/:id/apply-rules', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  ok(res, await AaTxnService.applyRules(session, req.params.id))
}))

auditAutomationRouter.post('/jobs/:id/approve', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  await AaTxnService.approve(session, req.params.id, true, req)
  ok(res, await AaJobService.get(session, req.params.id))
}))

auditAutomationRouter.post('/jobs/:id/reopen', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  await AaTxnService.approve(session, req.params.id, false, req)
  ok(res, await AaJobService.get(session, req.params.id))
}))

auditAutomationRouter.get('/jobs/:id/export/tally.xml', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaView(session)
  const confirm = String(req.query.confirm ?? '') === '1'
  const { xml, filename } = await AaTxnService.tallyXml(session, req.params.id, req, { confirm })
  res.setHeader('Content-Type', 'application/xml; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`)
  res.send(xml)
}))

auditAutomationRouter.get('/jobs/:id/export.xlsx', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaView(session)
  // ?draft=1 is the Firm-Manager escape hatch for exporting unapproved
  // rows for internal review. Default behaviour (no ?draft=1) gates the
  // export on approval, matching the Tally XML endpoint — REPOTIC §1.
  const includeUnreviewed = String(req.query.draft ?? '') === '1'
  const { bytes, filename } = await AaTxnService.workbook(session, req.params.id, req, { includeUnreviewed })
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`)
  res.send(bytes)
}))

auditAutomationRouter.post('/jobs/:id/reprocess', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  await AaJobService.reprocess(session, req.params.id, req)
  ok(res, await AaJobService.get(session, req.params.id), 202)
}))

auditAutomationRouter.delete('/jobs/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  await AaJobService.remove(session, req.params.id, req)
  ok(res, { deleted: true })
}))

/**
 * GET /api/audit-automation/clients/:clientId/ledger-master
 *
 * Returns the client's known ledgers (REPOTIC-MODULE.md §1 fix 2): every
 * distinct `ledger_name` from the client's rules AND from rows in
 * previously-approved jobs. The UI uses this to drive an autocomplete,
 * and to decide when the typed value is NEW (so operators get an
 * explicit "Create new ledger" confirmation instead of saving typos).
 *
 * `ownBankCashLedgers` is the subset used by Contra detection (fix 4):
 * `bankLedgerName` set on every approved job for the client.
 */
auditAutomationRouter.get('/clients/:clientId/ledger-master', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaView(session)
  const organisationId = await orgIdOf(session.userId)
  const clientId = req.params.clientId
  await assertClientVisible(session, clientId)
  const [rules, approvedRows, approvedJobs] = await Promise.all([
    prisma.aaLedgerRule.findMany({
      where: { organisationId, deletedAt: null, OR: [{ clientId }, { clientId: null }] },
      select: { ledgerName: true },
    }),
    prisma.aaBankTxn.findMany({
      where: {
        organisationId,
        clientId,
        job: { reviewStatus: 'approved' },
        ledgerName: { not: null },
      },
      select: { ledgerName: true },
      take: 1000,
      distinct: ['ledgerName'],
    }),
    prisma.aaJob.findMany({
      where: { organisationId, clientId, reviewStatus: 'approved', bankLedgerName: { not: null } },
      select: { bankLedgerName: true },
    }),
  ])
  const ledgers = [...new Set([
    ...rules.map((r) => r.ledgerName.trim()).filter(Boolean),
    ...approvedRows.map((r) => (r.ledgerName ?? '').trim()).filter(Boolean),
  ])].sort((a, b) => a.localeCompare(b))
  const ownBankCashLedgers = [...new Set(approvedJobs.map((j) => (j.bankLedgerName ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  ok(res, { ledgers, own_bank_cash_ledgers: ownBankCashLedgers })
}))

// ── Ledger rules (narration → Tally ledger) ─────────────────────────────
auditAutomationRouter.get('/rules', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaView(session)
  const q = z.object({ client_id: z.string().optional() }).parse(req.query)
  if (q.client_id) await assertClientVisible(session, q.client_id)
  const organisationId = await orgIdOf(session.userId)
  // Firm-wide rules plus the rules of clients the caller may see.
  const visible = seesAllClients(session) ? null : await assignedClientIds(session, 'self')
  const rows = await prisma.aaLedgerRule.findMany({
    where: {
      organisationId, deletedAt: null,
      ...(q.client_id ? { OR: [{ clientId: q.client_id }, { clientId: null }] } : {}),
      ...(visible && visible !== 'ALL' ? { AND: [{ OR: [{ clientId: null }, { clientId: { in: visible } }] }] } : {}),
    },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  })
  ok(res, { items: rows.map((r) => ({ id: r.id, client_id: r.clientId, match_type: r.matchType, pattern: r.pattern, direction: r.direction, ledger_name: r.ledgerName, voucher_type: r.voucherType, priority: r.priority })) })
}))

auditAutomationRouter.post('/rules', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  const b = (req.body ?? {}) as Record<string, string | null | undefined>
  const v = AaRuleService.validate({ match_type: b.match_type ?? undefined, pattern: b.pattern ?? undefined, direction: b.direction ?? undefined, ledger_name: b.ledger_name ?? undefined, voucher_type: b.voucher_type ?? null })
  // A client's rule: that client must be visible. A firm-wide rule (no client)
  // changes every client's statements: staff who see every client only.
  await assertClientVisible(session, b.client_id || null)
  const organisationId = await orgIdOf(session.userId)
  if (b.client_id) {
    const c = await prisma.client.findFirst({ where: { id: b.client_id, organisationId, deletedAt: null }, select: { id: true } })
    if (!c) throw ApiError.notFound('No such client.')
  }
  const rule = await prisma.aaLedgerRule.create({ data: { organisationId, clientId: b.client_id || null, ...v, priority: Number(b.priority ?? 100) || 100, createdByUserId: session.userId } })
  await writeAudit({ actorUserId: session.userId, action: 'aa.rule_created', entityType: 'AaLedgerRule', entityId: rule.id, after: { ...v, client_id: rule.clientId }, req })
  ok(res, { id: rule.id }, 201)
}))

auditAutomationRouter.patch('/rules/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  const organisationId = await orgIdOf(session.userId)
  const rule = await prisma.aaLedgerRule.findFirst({ where: { id: req.params.id, organisationId, deletedAt: null } })
  if (!rule) throw ApiError.notFound('No such rule.')
  await assertClientVisible(session, rule.clientId)
  const b = (req.body ?? {}) as Record<string, string | null | undefined>
  const v = AaRuleService.validate({
    match_type: b.match_type ?? rule.matchType, pattern: b.pattern ?? rule.pattern, direction: b.direction ?? rule.direction,
    ledger_name: b.ledger_name ?? rule.ledgerName, voucher_type: b.voucher_type === undefined ? rule.voucherType : b.voucher_type,
  })
  await prisma.aaLedgerRule.update({ where: { id: rule.id }, data: { ...v, ...(b.priority !== undefined ? { priority: Number(b.priority) || 100 } : {}) } })
  await writeAudit({ actorUserId: session.userId, action: 'aa.rule_updated', entityType: 'AaLedgerRule', entityId: rule.id, before: rule, after: v, req })
  ok(res, { id: rule.id })
}))

/**
 * POST /api/audit-automation/invoices/extract (POST-DELIVERY-CHANGES §F1)
 *
 * Extract the standard tax-invoice fields from an uploaded PDF. PURE
 * READ — nothing is persisted. The response carries each field with a
 * confidence hint so the follow-up review UI can light the uncertain
 * ones for the auditor to correct or confirm, which is the whole point
 * of the doc's "human confirms every figure" rule. A persisted,
 * exported-to-Excel flow is the next PR in Group F.
 *
 * Permissions: same gate as the bank-statement upload
 * (tools.audit_automation.bank.upload). Firms that can bring in bank
 * statements can bring in invoices; nothing new to grant.
 */
auditAutomationRouter.post('/invoices/extract', (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof Error && err.message.includes('File too large')) {
      return next(ApiError.unprocessable('too_large', `The PDF is over ${MAX_MB} MB.`))
    }
    if (err) return next(err)
    scanUploads(req, res, next)
  })
}, handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  const file = req.file
  if (!file) throw ApiError.unprocessable('empty', 'Choose an invoice PDF to upload.')
  if (file.size === 0) throw ApiError.unprocessable('empty', 'The uploaded file is empty.')
  const mime = await sniffMime(file.buffer, file.originalname)
  const ext = extensionOf(file.originalname)
  if (mime !== 'application/pdf' && ext !== 'pdf') {
    throw ApiError.unprocessable('not_pdf', 'Upload the invoice as a PDF — Excel / image support lands in a follow-up.')
  }
  // Lazy imports so pdfjs is not loaded on module boot. Matches the pattern
  // the bank-statement path uses (routes don't pull pdfInspect at the top).
  const { inspectPdf, PasswordRequiredError, WrongPasswordError, UnreadablePdfError } = await import('./lib/pdfInspect.js')
  const { extractInvoice } = await import('./parsers/invoicePdf.js')
  try {
    const inspected = await inspectPdf(file.buffer)
    const extracted = extractInvoice(inspected.pages)
    ok(res, {
      filename: sanitizeFilename(file.originalname),
      page_count: inspected.pageCount,
      // The reviewer wants fields in snake_case, matching the rest of the API.
      supplier_gstin: extracted.supplierGstin,
      recipient_gstin: extracted.recipientGstin,
      supplier_name: extracted.supplierName,
      invoice_number: extracted.invoiceNumber,
      invoice_date: extracted.invoiceDate,
      total_paise: extracted.totalPaise,
      taxable_paise: extracted.taxablePaise,
      cgst_paise: extracted.cgstPaise,
      sgst_paise: extracted.sgstPaise,
      igst_paise: extracted.igstPaise,
      hsn_candidates: extracted.hsnCandidates,
      date_candidates: extracted.dateCandidates,
      raw_text: extracted.rawText,
    })
  } catch (e) {
    if (e instanceof PasswordRequiredError) throw ApiError.unprocessable('password_required', 'This invoice PDF is password-protected.')
    if (e instanceof WrongPasswordError) throw ApiError.unprocessable('wrong_password', 'The password did not open the PDF.')
    if (e instanceof UnreadablePdfError) throw ApiError.unprocessable('unreadable', 'Could not read this PDF — try a different export or a scan + OCR.')
    throw e
  }
}))

// ── INVOICE EXTRACTION · persist + review + export ────────────────────────
//
// POST-DELIVERY-CHANGES §F1 part 2. The /extract endpoint above is pure
// (stateless, no persistence). These endpoints wrap the review-and-save
// half: the UI calls /extract first for the preview, the reviewer edits
// the fields, then POST /invoices persists the corrected shape; PATCH
// updates it; GET /:id/export.xlsx produces the Excel.

interface InvoicePayload {
  client_id?: unknown
  pdf_sha256?: unknown
  filename?: unknown
  page_count?: unknown
  supplier_gstin?: unknown; supplier_gstin_confidence?: unknown
  recipient_gstin?: unknown; recipient_gstin_confidence?: unknown
  supplier_name?: unknown; supplier_name_confidence?: unknown
  invoice_number?: unknown; invoice_number_confidence?: unknown
  invoice_date?: unknown; invoice_date_confidence?: unknown
  total_paise?: unknown; total_confidence?: unknown
  taxable_paise?: unknown; taxable_confidence?: unknown
  cgst_paise?: unknown; cgst_confidence?: unknown
  sgst_paise?: unknown; sgst_confidence?: unknown
  igst_paise?: unknown; igst_confidence?: unknown
  hsn_candidates?: unknown
  line_items?: unknown
  status?: unknown
  notes?: unknown
}

const CONFIDENCES = new Set(['high', 'medium', 'low'])
const STATUSES = new Set(['extracted', 'confirmed', 'exported'])

function strOrNull(v: unknown, max: number): string | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length === 0 ? null : t.slice(0, max)
}
function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && Number.isInteger(n) ? n : null
}
function confOrDefault(v: unknown, fallback = 'low'): string {
  if (typeof v === 'string' && CONFIDENCES.has(v)) return v
  return fallback
}
function isoDateOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string') return null
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

function serializeExtraction(r: {
  id: string; clientId: string; filename: string; pdfSha256: string; pageCount: number
  supplierGstin: string | null; supplierGstinConfidence: string
  recipientGstin: string | null; recipientGstinConfidence: string
  supplierName: string | null; supplierNameConfidence: string
  invoiceNumber: string | null; invoiceNumberConfidence: string
  invoiceDate: string | null; invoiceDateConfidence: string
  totalPaise: number | null; totalConfidence: string
  taxablePaise: number | null; taxableConfidence: string
  cgstPaise: number | null; cgstConfidence: string
  sgstPaise: number | null; sgstConfidence: string
  igstPaise: number | null; igstConfidence: string
  hsnCandidatesJson: string | null; lineItemsJson: string | null
  status: string; reviewedByEmployeeId: string | null; reviewedAt: Date | null; notes: string | null
  createdAt: Date; updatedAt: Date
}) {
  const safeJson = (s: string | null): unknown => {
    if (!s) return null
    try { return JSON.parse(s) as unknown } catch { return null }
  }
  return {
    id: r.id,
    client_id: r.clientId,
    filename: r.filename,
    pdf_sha256: r.pdfSha256,
    page_count: r.pageCount,
    supplier_gstin: r.supplierGstin, supplier_gstin_confidence: r.supplierGstinConfidence,
    recipient_gstin: r.recipientGstin, recipient_gstin_confidence: r.recipientGstinConfidence,
    supplier_name: r.supplierName, supplier_name_confidence: r.supplierNameConfidence,
    invoice_number: r.invoiceNumber, invoice_number_confidence: r.invoiceNumberConfidence,
    invoice_date: r.invoiceDate, invoice_date_confidence: r.invoiceDateConfidence,
    total_paise: r.totalPaise, total_confidence: r.totalConfidence,
    taxable_paise: r.taxablePaise, taxable_confidence: r.taxableConfidence,
    cgst_paise: r.cgstPaise, cgst_confidence: r.cgstConfidence,
    sgst_paise: r.sgstPaise, sgst_confidence: r.sgstConfidence,
    igst_paise: r.igstPaise, igst_confidence: r.igstConfidence,
    hsn_candidates: (safeJson(r.hsnCandidatesJson) as string[] | null) ?? [],
    line_items: (safeJson(r.lineItemsJson) as unknown[] | null) ?? [],
    status: r.status,
    reviewed_by_employee_id: r.reviewedByEmployeeId,
    reviewed_at: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    notes: r.notes,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }
}

/**
 * POST /api/audit-automation/invoices
 * Persist the reviewed shape. client_id is REQUIRED (unlike /extract,
 * which is stateless and may run before the reviewer picks a client).
 * The row lands in status 'extracted' unless the body explicitly says
 * 'confirmed'.
 */
auditAutomationRouter.post('/invoices', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  const organisationId = await orgIdOf(session.userId)
  const b = (req.body ?? {}) as InvoicePayload

  const clientId = strOrNull(b.client_id, 64)
  if (!clientId) throw ApiError.unprocessable('client_required', 'Pick a client before saving.')
  await assertClientVisible(session, clientId)

  const pdfSha256 = strOrNull(b.pdf_sha256, 64)
  if (!pdfSha256) throw ApiError.unprocessable('pdf_sha256_required', 'pdf_sha256 is required (returned by /extract).')

  const status = typeof b.status === 'string' && STATUSES.has(b.status) ? b.status : 'extracted'
  const reviewed = status === 'confirmed'

  const row = await prisma.aaInvoiceExtraction.create({
    data: {
      organisationId, clientId,
      filename: strOrNull(b.filename, 200) ?? 'invoice.pdf',
      pdfSha256,
      pageCount: intOrNull(b.page_count) ?? 1,
      supplierGstin: strOrNull(b.supplier_gstin, 20)?.toUpperCase() ?? null,
      supplierGstinConfidence: confOrDefault(b.supplier_gstin_confidence),
      recipientGstin: strOrNull(b.recipient_gstin, 20)?.toUpperCase() ?? null,
      recipientGstinConfidence: confOrDefault(b.recipient_gstin_confidence),
      supplierName: strOrNull(b.supplier_name, 200),
      supplierNameConfidence: confOrDefault(b.supplier_name_confidence),
      invoiceNumber: strOrNull(b.invoice_number, 50),
      invoiceNumberConfidence: confOrDefault(b.invoice_number_confidence),
      invoiceDate: isoDateOrNull(b.invoice_date),
      invoiceDateConfidence: confOrDefault(b.invoice_date_confidence),
      totalPaise: intOrNull(b.total_paise), totalConfidence: confOrDefault(b.total_confidence),
      taxablePaise: intOrNull(b.taxable_paise), taxableConfidence: confOrDefault(b.taxable_confidence),
      cgstPaise: intOrNull(b.cgst_paise), cgstConfidence: confOrDefault(b.cgst_confidence),
      sgstPaise: intOrNull(b.sgst_paise), sgstConfidence: confOrDefault(b.sgst_confidence),
      igstPaise: intOrNull(b.igst_paise), igstConfidence: confOrDefault(b.igst_confidence),
      hsnCandidatesJson: Array.isArray(b.hsn_candidates) ? JSON.stringify(b.hsn_candidates) : null,
      lineItemsJson: Array.isArray(b.line_items) ? JSON.stringify(b.line_items) : null,
      status,
      reviewedByEmployeeId: reviewed ? (session.employeeId ?? null) : null,
      reviewedAt: reviewed ? new Date() : null,
      notes: strOrNull(b.notes, 2000),
      createdBy: session.userId, updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'aa.invoice_extracted',
    entityType: 'AaInvoiceExtraction', entityId: row.id,
    after: { client_id: clientId, status, pdf_sha256: pdfSha256 }, req,
  })
  ok(res, serializeExtraction(row), 201)
}))

/**
 * GET /api/audit-automation/invoices/:id — single extraction for the review UI.
 */
auditAutomationRouter.get('/invoices/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaView(session)
  const organisationId = await orgIdOf(session.userId)
  const row = await prisma.aaInvoiceExtraction.findFirst({
    where: { id: req.params.id, organisationId, deletedAt: null },
  })
  if (!row) throw ApiError.notFound('Invoice extraction not found.')
  await assertClientVisible(session, row.clientId)
  ok(res, serializeExtraction(row))
}))

/**
 * PATCH /api/audit-automation/invoices/:id — the human-correction step.
 * Only the fields present in the body are touched. Setting status=
 * 'confirmed' stamps reviewedAt + reviewedByEmployeeId; moving away from
 * confirmed clears them (a reopened row is no longer "reviewed").
 */
auditAutomationRouter.patch('/invoices/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  const organisationId = await orgIdOf(session.userId)
  const before = await prisma.aaInvoiceExtraction.findFirst({
    where: { id: req.params.id, organisationId, deletedAt: null },
  })
  if (!before) throw ApiError.notFound('Invoice extraction not found.')
  await assertClientVisible(session, before.clientId)

  const b = (req.body ?? {}) as InvoicePayload
  const has = (k: keyof InvoicePayload): boolean => k in b
  const data: Record<string, unknown> = { updatedBy: session.userId }

  // Correction fields — each pair (value, confidence) moves together.
  // When the reviewer corrects a field, its confidence becomes 'high'
  // unless they explicitly set a different level.
  const correct = <V>(valueKey: keyof InvoicePayload, confKey: keyof InvoicePayload, dataField: string, confField: string, parse: (v: unknown) => V) => {
    if (!has(valueKey)) return
    data[dataField] = parse(b[valueKey])
    data[confField] = confOrDefault(b[confKey], 'high')
  }
  correct('supplier_gstin', 'supplier_gstin_confidence', 'supplierGstin', 'supplierGstinConfidence', (v) => strOrNull(v, 20)?.toUpperCase() ?? null)
  correct('recipient_gstin', 'recipient_gstin_confidence', 'recipientGstin', 'recipientGstinConfidence', (v) => strOrNull(v, 20)?.toUpperCase() ?? null)
  correct('supplier_name', 'supplier_name_confidence', 'supplierName', 'supplierNameConfidence', (v) => strOrNull(v, 200))
  correct('invoice_number', 'invoice_number_confidence', 'invoiceNumber', 'invoiceNumberConfidence', (v) => strOrNull(v, 50))
  correct('invoice_date', 'invoice_date_confidence', 'invoiceDate', 'invoiceDateConfidence', (v) => isoDateOrNull(v))
  correct('total_paise', 'total_confidence', 'totalPaise', 'totalConfidence', intOrNull)
  correct('taxable_paise', 'taxable_confidence', 'taxablePaise', 'taxableConfidence', intOrNull)
  correct('cgst_paise', 'cgst_confidence', 'cgstPaise', 'cgstConfidence', intOrNull)
  correct('sgst_paise', 'sgst_confidence', 'sgstPaise', 'sgstConfidence', intOrNull)
  correct('igst_paise', 'igst_confidence', 'igstPaise', 'igstConfidence', intOrNull)

  if (has('hsn_candidates')) {
    data.hsnCandidatesJson = Array.isArray(b.hsn_candidates) ? JSON.stringify(b.hsn_candidates) : null
  }
  if (has('line_items')) {
    data.lineItemsJson = Array.isArray(b.line_items) ? JSON.stringify(b.line_items) : null
  }
  if (has('notes')) data.notes = strOrNull(b.notes, 2000)

  if (has('status')) {
    const status = typeof b.status === 'string' && STATUSES.has(b.status) ? b.status : before.status
    data.status = status
    if (status === 'confirmed' && before.status !== 'confirmed') {
      data.reviewedByEmployeeId = session.employeeId ?? null
      data.reviewedAt = new Date()
    } else if (status !== 'confirmed' && before.status === 'confirmed') {
      data.reviewedByEmployeeId = null
      data.reviewedAt = null
    }
  }

  const after = await prisma.aaInvoiceExtraction.update({ where: { id: before.id }, data })
  await writeAudit({
    actorUserId: session.userId, action: 'aa.invoice_updated',
    entityType: 'AaInvoiceExtraction', entityId: after.id,
    before: { status: before.status, totalPaise: before.totalPaise },
    after: { status: after.status, totalPaise: after.totalPaise },
    req,
  })
  ok(res, serializeExtraction(after))
}))

/**
 * GET /api/audit-automation/invoices/:id/export.xlsx — the confirmed shape
 * as an Excel workbook. Two sheets: Header (one row of the top-level
 * fields) and Line Items (one row per typed line). Opening and downloading
 * does NOT change status on its own — call PATCH with status='exported'
 * if the firm wants to mark it so. Re-export is allowed.
 */
auditAutomationRouter.get('/invoices/:id/export.xlsx', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaView(session)
  const organisationId = await orgIdOf(session.userId)
  const row = await prisma.aaInvoiceExtraction.findFirst({
    where: { id: req.params.id, organisationId, deletedAt: null },
  })
  if (!row) throw ApiError.notFound('Invoice extraction not found.')
  await assertClientVisible(session, row.clientId)

  // Lazy-load exceljs — matches the pattern other export routes use so
  // the ~3 MB lib isn't in the hot-boot path.
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  const header = wb.addWorksheet('Invoice')
  header.columns = [
    { header: 'Field', key: 'field', width: 32 },
    { header: 'Value', key: 'value', width: 60 },
    { header: 'Confidence', key: 'conf', width: 14 },
  ]
  const asRupees = (p: number | null) => p === null ? '' : (p / 100).toFixed(2)
  const rows: Array<[string, string, string]> = [
    ['Filename', row.filename, ''],
    ['Supplier GSTIN', row.supplierGstin ?? '', row.supplierGstinConfidence],
    ['Supplier name', row.supplierName ?? '', row.supplierNameConfidence],
    ['Recipient GSTIN', row.recipientGstin ?? '', row.recipientGstinConfidence],
    ['Invoice number', row.invoiceNumber ?? '', row.invoiceNumberConfidence],
    ['Invoice date', row.invoiceDate ?? '', row.invoiceDateConfidence],
    ['Taxable (₹)', asRupees(row.taxablePaise), row.taxableConfidence],
    ['CGST (₹)', asRupees(row.cgstPaise), row.cgstConfidence],
    ['SGST (₹)', asRupees(row.sgstPaise), row.sgstConfidence],
    ['IGST (₹)', asRupees(row.igstPaise), row.igstConfidence],
    ['Total (₹)', asRupees(row.totalPaise), row.totalConfidence],
    ['Status', row.status, ''],
    ['Notes', row.notes ?? '', ''],
  ]
  for (const [field, value, conf] of rows) header.addRow({ field, value, conf })
  header.getRow(1).font = { bold: true }

  const items = wb.addWorksheet('Line Items')
  items.columns = [
    { header: 'Description', key: 'description', width: 42 },
    { header: 'HSN/SAC', key: 'hsn', width: 12 },
    { header: 'Qty', key: 'quantity', width: 8 },
    { header: 'Rate (₹)', key: 'rate', width: 12 },
    { header: 'Taxable (₹)', key: 'taxable', width: 14 },
    { header: 'CGST (₹)', key: 'cgst', width: 12 },
    { header: 'SGST (₹)', key: 'sgst', width: 12 },
    { header: 'IGST (₹)', key: 'igst', width: 12 },
  ]
  const lineItems = row.lineItemsJson ? (JSON.parse(row.lineItemsJson) as Array<Record<string, unknown>>) : []
  for (const li of lineItems) {
    items.addRow({
      description: String(li.description ?? ''),
      hsn: String(li.hsn ?? ''),
      quantity: typeof li.quantity_centi === 'number' ? Number(li.quantity_centi) / 100 : '',
      rate: typeof li.unit_rate_paise === 'number' ? Number(li.unit_rate_paise) / 100 : '',
      taxable: typeof li.taxable_paise === 'number' ? Number(li.taxable_paise) / 100 : '',
      cgst: typeof li.cgst_paise === 'number' ? Number(li.cgst_paise) / 100 : '',
      sgst: typeof li.sgst_paise === 'number' ? Number(li.sgst_paise) / 100 : '',
      igst: typeof li.igst_paise === 'number' ? Number(li.igst_paise) / 100 : '',
    })
  }
  items.getRow(1).font = { bold: true }

  const buffer = await wb.xlsx.writeBuffer()
  const safeName = (row.invoiceNumber || row.id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${safeName}.xlsx"`)
  res.end(Buffer.from(buffer))
}))

// ── TRANSIT (LR / delivery challan) EXTRACTION ──────────────────────────
//
// POST-DELIVERY-CHANGES §F2. Same upload -> extract -> confirm -> export
// pipeline as the invoice flow. /transit/extract is pure; /transit (POST)
// persists the reviewed shape; GET / PATCH / export.xlsx are the review
// surface. Authorization reuses the audit-automation gates — firms that
// can upload bank statements can upload transit docs; no new permission.

interface TransitPayload {
  client_id?: unknown
  pdf_sha256?: unknown
  filename?: unknown
  page_count?: unknown
  doc_type?: unknown
  doc_number?: unknown; doc_number_confidence?: unknown
  doc_date?: unknown; doc_date_confidence?: unknown
  consignor?: unknown; consignor_confidence?: unknown
  consignor_gstin?: unknown; consignor_gstin_confidence?: unknown
  consignee?: unknown; consignee_confidence?: unknown
  consignee_gstin?: unknown; consignee_gstin_confidence?: unknown
  vehicle_number?: unknown; vehicle_number_confidence?: unknown
  from_place?: unknown; from_place_confidence?: unknown
  to_place?: unknown; to_place_confidence?: unknown
  goods_description?: unknown; goods_description_confidence?: unknown
  quantity?: unknown; quantity_confidence?: unknown
  value_paise?: unknown; value_confidence?: unknown
  status?: unknown
  notes?: unknown
}

const TRANSIT_CONFIDENCES = new Set(['high', 'medium', 'low'])
const TRANSIT_STATUSES = new Set(['extracted', 'confirmed', 'exported'])
const TRANSIT_DOC_TYPES = new Set(['lorry_receipt', 'delivery_challan', 'unknown'])

function tStr(v: unknown, max: number): string | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length === 0 ? null : t.slice(0, max)
}
function tInt(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && Number.isInteger(n) ? n : null
}
function tConf(v: unknown, fallback = 'low'): string {
  if (typeof v === 'string' && TRANSIT_CONFIDENCES.has(v)) return v
  return fallback
}
function tIsoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string') return null
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}
function tDocType(v: unknown): string {
  if (typeof v === 'string' && TRANSIT_DOC_TYPES.has(v)) return v
  return 'unknown'
}

function serializeTransit(r: {
  id: string; clientId: string; filename: string; pdfSha256: string; pageCount: number
  docType: string
  docNumber: string | null; docNumberConfidence: string
  docDate: string | null; docDateConfidence: string
  consignor: string | null; consignorConfidence: string
  consignorGstin: string | null; consignorGstinConfidence: string
  consignee: string | null; consigneeConfidence: string
  consigneeGstin: string | null; consigneeGstinConfidence: string
  vehicleNumber: string | null; vehicleNumberConfidence: string
  fromPlace: string | null; fromPlaceConfidence: string
  toPlace: string | null; toPlaceConfidence: string
  goodsDescription: string | null; goodsDescriptionConfidence: string
  quantity: string | null; quantityConfidence: string
  valuePaise: number | null; valueConfidence: string
  status: string; reviewedByEmployeeId: string | null; reviewedAt: Date | null; notes: string | null
  createdAt: Date; updatedAt: Date
}) {
  return {
    id: r.id,
    client_id: r.clientId,
    filename: r.filename,
    pdf_sha256: r.pdfSha256,
    page_count: r.pageCount,
    doc_type: r.docType,
    doc_number: r.docNumber, doc_number_confidence: r.docNumberConfidence,
    doc_date: r.docDate, doc_date_confidence: r.docDateConfidence,
    consignor: r.consignor, consignor_confidence: r.consignorConfidence,
    consignor_gstin: r.consignorGstin, consignor_gstin_confidence: r.consignorGstinConfidence,
    consignee: r.consignee, consignee_confidence: r.consigneeConfidence,
    consignee_gstin: r.consigneeGstin, consignee_gstin_confidence: r.consigneeGstinConfidence,
    vehicle_number: r.vehicleNumber, vehicle_number_confidence: r.vehicleNumberConfidence,
    from_place: r.fromPlace, from_place_confidence: r.fromPlaceConfidence,
    to_place: r.toPlace, to_place_confidence: r.toPlaceConfidence,
    goods_description: r.goodsDescription, goods_description_confidence: r.goodsDescriptionConfidence,
    quantity: r.quantity, quantity_confidence: r.quantityConfidence,
    value_paise: r.valuePaise, value_confidence: r.valueConfidence,
    status: r.status,
    reviewed_by_employee_id: r.reviewedByEmployeeId,
    reviewed_at: r.reviewedAt ? r.reviewedAt.toISOString() : null,
    notes: r.notes,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }
}

/**
 * POST /api/audit-automation/transit/extract — pure PDF read.
 * Mirrors /invoices/extract: no persistence, no client binding required.
 */
auditAutomationRouter.post('/transit/extract', (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof Error && err.message.includes('File too large')) {
      return next(ApiError.unprocessable('too_large', `The PDF is over ${MAX_MB} MB.`))
    }
    if (err) return next(err)
    scanUploads(req, res, next)
  })
}, handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  const file = req.file
  if (!file) throw ApiError.unprocessable('empty', 'Choose a transit document PDF to upload.')
  if (file.size === 0) throw ApiError.unprocessable('empty', 'The uploaded file is empty.')
  const mime = await sniffMime(file.buffer, file.originalname)
  const ext = extensionOf(file.originalname)
  if (mime !== 'application/pdf' && ext !== 'pdf') {
    throw ApiError.unprocessable('not_pdf', 'Upload the transit document as a PDF — image + OCR support lands in a follow-up.')
  }
  const { inspectPdf, PasswordRequiredError, WrongPasswordError, UnreadablePdfError } = await import('./lib/pdfInspect.js')
  const { extractTransit } = await import('./parsers/transitPdf.js')
  try {
    const inspected = await inspectPdf(file.buffer)
    const extracted = extractTransit(inspected.pages)
    ok(res, {
      filename: sanitizeFilename(file.originalname),
      page_count: inspected.pageCount,
      doc_type: extracted.docType,
      doc_number: extracted.docNumber,
      doc_date: extracted.docDate,
      consignor: extracted.consignor,
      consignor_gstin: extracted.consignorGstin,
      consignee: extracted.consignee,
      consignee_gstin: extracted.consigneeGstin,
      vehicle_number: extracted.vehicleNumber,
      from_place: extracted.fromPlace,
      to_place: extracted.toPlace,
      goods_description: extracted.goodsDescription,
      quantity: extracted.quantity,
      value_paise: extracted.valuePaise,
      date_candidates: extracted.dateCandidates,
      raw_text: extracted.rawText,
    })
  } catch (e) {
    if (e instanceof PasswordRequiredError) throw ApiError.unprocessable('password_required', 'This transit PDF is password-protected.')
    if (e instanceof WrongPasswordError) throw ApiError.unprocessable('wrong_password', 'The password did not open the PDF.')
    if (e instanceof UnreadablePdfError) throw ApiError.unprocessable('unreadable', 'Could not read this PDF — try a different export or a scan + OCR.')
    throw e
  }
}))

/** POST /api/audit-automation/transit — persist the reviewed shape. */
auditAutomationRouter.post('/transit', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  const organisationId = await orgIdOf(session.userId)
  const b = (req.body ?? {}) as TransitPayload

  const clientId = tStr(b.client_id, 64)
  if (!clientId) throw ApiError.unprocessable('client_required', 'Pick a client before saving.')
  await assertClientVisible(session, clientId)
  const pdfSha256 = tStr(b.pdf_sha256, 64)
  if (!pdfSha256) throw ApiError.unprocessable('pdf_sha256_required', 'pdf_sha256 is required (returned by /transit/extract).')

  const status = typeof b.status === 'string' && TRANSIT_STATUSES.has(b.status) ? b.status : 'extracted'
  const reviewed = status === 'confirmed'

  const row = await prisma.aaTransitExtraction.create({
    data: {
      organisationId, clientId,
      filename: tStr(b.filename, 200) ?? 'transit.pdf',
      pdfSha256,
      pageCount: tInt(b.page_count) ?? 1,
      docType: tDocType(b.doc_type),
      docNumber: tStr(b.doc_number, 50), docNumberConfidence: tConf(b.doc_number_confidence),
      docDate: tIsoDate(b.doc_date), docDateConfidence: tConf(b.doc_date_confidence),
      consignor: tStr(b.consignor, 200), consignorConfidence: tConf(b.consignor_confidence),
      consignorGstin: tStr(b.consignor_gstin, 20)?.toUpperCase() ?? null,
      consignorGstinConfidence: tConf(b.consignor_gstin_confidence),
      consignee: tStr(b.consignee, 200), consigneeConfidence: tConf(b.consignee_confidence),
      consigneeGstin: tStr(b.consignee_gstin, 20)?.toUpperCase() ?? null,
      consigneeGstinConfidence: tConf(b.consignee_gstin_confidence),
      vehicleNumber: tStr(b.vehicle_number, 20)?.toUpperCase() ?? null,
      vehicleNumberConfidence: tConf(b.vehicle_number_confidence),
      fromPlace: tStr(b.from_place, 60), fromPlaceConfidence: tConf(b.from_place_confidence),
      toPlace: tStr(b.to_place, 60), toPlaceConfidence: tConf(b.to_place_confidence),
      goodsDescription: tStr(b.goods_description, 200), goodsDescriptionConfidence: tConf(b.goods_description_confidence),
      quantity: tStr(b.quantity, 60), quantityConfidence: tConf(b.quantity_confidence),
      valuePaise: tInt(b.value_paise), valueConfidence: tConf(b.value_confidence),
      status,
      reviewedByEmployeeId: reviewed ? (session.employeeId ?? null) : null,
      reviewedAt: reviewed ? new Date() : null,
      notes: tStr(b.notes, 2000),
      createdBy: session.userId, updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'aa.transit_extracted',
    entityType: 'AaTransitExtraction', entityId: row.id,
    after: { client_id: clientId, status, doc_type: row.docType, pdf_sha256: pdfSha256 }, req,
  })
  ok(res, serializeTransit(row), 201)
}))

/** GET /api/audit-automation/transit/:id */
auditAutomationRouter.get('/transit/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaView(session)
  const organisationId = await orgIdOf(session.userId)
  const row = await prisma.aaTransitExtraction.findFirst({
    where: { id: req.params.id, organisationId, deletedAt: null },
  })
  if (!row) throw ApiError.notFound('Transit extraction not found.')
  await assertClientVisible(session, row.clientId)
  ok(res, serializeTransit(row))
}))

/** PATCH /api/audit-automation/transit/:id — reviewer corrections. */
auditAutomationRouter.patch('/transit/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  const organisationId = await orgIdOf(session.userId)
  const before = await prisma.aaTransitExtraction.findFirst({
    where: { id: req.params.id, organisationId, deletedAt: null },
  })
  if (!before) throw ApiError.notFound('Transit extraction not found.')
  await assertClientVisible(session, before.clientId)

  const b = (req.body ?? {}) as TransitPayload
  const has = (k: keyof TransitPayload): boolean => k in b
  const data: Record<string, unknown> = { updatedBy: session.userId }

  const correct = <V>(
    valueKey: keyof TransitPayload, confKey: keyof TransitPayload | null,
    dataField: string, confField: string | null,
    parse: (v: unknown) => V,
  ) => {
    if (!has(valueKey)) return
    data[dataField] = parse(b[valueKey])
    if (confField) data[confField] = tConf(confKey ? b[confKey] : undefined, 'high')
  }

  if (has('doc_type')) data.docType = tDocType(b.doc_type)
  correct('doc_number', 'doc_number_confidence', 'docNumber', 'docNumberConfidence', (v) => tStr(v, 50))
  correct('doc_date', 'doc_date_confidence', 'docDate', 'docDateConfidence', (v) => tIsoDate(v))
  correct('consignor', 'consignor_confidence', 'consignor', 'consignorConfidence', (v) => tStr(v, 200))
  correct('consignor_gstin', 'consignor_gstin_confidence', 'consignorGstin', 'consignorGstinConfidence', (v) => tStr(v, 20)?.toUpperCase() ?? null)
  correct('consignee', 'consignee_confidence', 'consignee', 'consigneeConfidence', (v) => tStr(v, 200))
  correct('consignee_gstin', 'consignee_gstin_confidence', 'consigneeGstin', 'consigneeGstinConfidence', (v) => tStr(v, 20)?.toUpperCase() ?? null)
  correct('vehicle_number', 'vehicle_number_confidence', 'vehicleNumber', 'vehicleNumberConfidence', (v) => tStr(v, 20)?.toUpperCase() ?? null)
  correct('from_place', 'from_place_confidence', 'fromPlace', 'fromPlaceConfidence', (v) => tStr(v, 60))
  correct('to_place', 'to_place_confidence', 'toPlace', 'toPlaceConfidence', (v) => tStr(v, 60))
  correct('goods_description', 'goods_description_confidence', 'goodsDescription', 'goodsDescriptionConfidence', (v) => tStr(v, 200))
  correct('quantity', 'quantity_confidence', 'quantity', 'quantityConfidence', (v) => tStr(v, 60))
  correct('value_paise', 'value_confidence', 'valuePaise', 'valueConfidence', tInt)

  if (has('notes')) data.notes = tStr(b.notes, 2000)

  if (has('status')) {
    const status = typeof b.status === 'string' && TRANSIT_STATUSES.has(b.status) ? b.status : before.status
    data.status = status
    if (status === 'confirmed' && before.status !== 'confirmed') {
      data.reviewedByEmployeeId = session.employeeId ?? null
      data.reviewedAt = new Date()
    } else if (status !== 'confirmed' && before.status === 'confirmed') {
      data.reviewedByEmployeeId = null
      data.reviewedAt = null
    }
  }

  const after = await prisma.aaTransitExtraction.update({ where: { id: before.id }, data })
  await writeAudit({
    actorUserId: session.userId, action: 'aa.transit_updated',
    entityType: 'AaTransitExtraction', entityId: after.id,
    before: { status: before.status, docType: before.docType, vehicleNumber: before.vehicleNumber },
    after: { status: after.status, docType: after.docType, vehicleNumber: after.vehicleNumber },
    req,
  })
  ok(res, serializeTransit(after))
}))

/** GET /api/audit-automation/transit/:id/export.xlsx */
auditAutomationRouter.get('/transit/:id/export.xlsx', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaView(session)
  const organisationId = await orgIdOf(session.userId)
  const row = await prisma.aaTransitExtraction.findFirst({
    where: { id: req.params.id, organisationId, deletedAt: null },
  })
  if (!row) throw ApiError.notFound('Transit extraction not found.')
  await assertClientVisible(session, row.clientId)

  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  const sheet = wb.addWorksheet('Transit')
  sheet.columns = [
    { header: 'Field', key: 'field', width: 28 },
    { header: 'Value', key: 'value', width: 60 },
    { header: 'Confidence', key: 'conf', width: 14 },
  ]
  const asRupees = (p: number | null) => p === null ? '' : (p / 100).toFixed(2)
  const docTypeLabel = row.docType === 'lorry_receipt' ? 'Lorry Receipt' : row.docType === 'delivery_challan' ? 'Delivery Challan' : 'Transit document'
  const rows: Array<[string, string, string]> = [
    ['Document type', docTypeLabel, ''],
    ['Document number', row.docNumber ?? '', row.docNumberConfidence],
    ['Date', row.docDate ?? '', row.docDateConfidence],
    ['Consignor', row.consignor ?? '', row.consignorConfidence],
    ['Consignor GSTIN', row.consignorGstin ?? '', row.consignorGstinConfidence],
    ['Consignee', row.consignee ?? '', row.consigneeConfidence],
    ['Consignee GSTIN', row.consigneeGstin ?? '', row.consigneeGstinConfidence],
    ['Vehicle number', row.vehicleNumber ?? '', row.vehicleNumberConfidence],
    ['From', row.fromPlace ?? '', row.fromPlaceConfidence],
    ['To', row.toPlace ?? '', row.toPlaceConfidence],
    ['Goods', row.goodsDescription ?? '', row.goodsDescriptionConfidence],
    ['Quantity', row.quantity ?? '', row.quantityConfidence],
    ['Value (₹)', asRupees(row.valuePaise), row.valueConfidence],
    ['Status', row.status, ''],
    ['Notes', row.notes ?? '', ''],
    ['Filename', row.filename, ''],
  ]
  for (const [field, value, conf] of rows) sheet.addRow({ field, value, conf })
  sheet.getRow(1).font = { bold: true }

  const buffer = await wb.xlsx.writeBuffer()
  const safeName = (row.docNumber || row.id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="transit-${safeName}.xlsx"`)
  res.end(Buffer.from(buffer))
}))

auditAutomationRouter.delete('/rules/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  const organisationId = await orgIdOf(session.userId)
  const rule = await prisma.aaLedgerRule.findFirst({ where: { id: req.params.id, organisationId, deletedAt: null } })
  if (!rule) throw ApiError.notFound('No such rule.')
  await assertClientVisible(session, rule.clientId)
  await prisma.aaLedgerRule.update({ where: { id: rule.id }, data: { deletedAt: new Date() } })
  await writeAudit({ actorUserId: session.userId, action: 'aa.rule_deleted', entityType: 'AaLedgerRule', entityId: rule.id, req })
  ok(res, { deleted: true })
}))
