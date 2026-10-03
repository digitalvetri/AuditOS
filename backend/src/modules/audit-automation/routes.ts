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
    if (!err) return next()
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
  ok(res, {
    job,
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
  const { xml, filename } = await AaTxnService.tallyXml(session, req.params.id, req)
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
  const organisationId = await orgIdOf(session.userId)
  const rows = await prisma.aaLedgerRule.findMany({
    where: { organisationId, deletedAt: null, ...(q.client_id ? { OR: [{ clientId: q.client_id }, { clientId: null }] } : {}) },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  })
  ok(res, { items: rows.map((r) => ({ id: r.id, client_id: r.clientId, match_type: r.matchType, pattern: r.pattern, direction: r.direction, ledger_name: r.ledgerName, voucher_type: r.voucherType, priority: r.priority })) })
}))

auditAutomationRouter.post('/rules', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  const b = (req.body ?? {}) as Record<string, string | null | undefined>
  const v = AaRuleService.validate({ match_type: b.match_type ?? undefined, pattern: b.pattern ?? undefined, direction: b.direction ?? undefined, ledger_name: b.ledger_name ?? undefined, voucher_type: b.voucher_type ?? null })
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
  const b = (req.body ?? {}) as Record<string, string | null | undefined>
  const v = AaRuleService.validate({
    match_type: b.match_type ?? rule.matchType, pattern: b.pattern ?? rule.pattern, direction: b.direction ?? rule.direction,
    ledger_name: b.ledger_name ?? rule.ledgerName, voucher_type: b.voucher_type === undefined ? rule.voucherType : b.voucher_type,
  })
  await prisma.aaLedgerRule.update({ where: { id: rule.id }, data: { ...v, ...(b.priority !== undefined ? { priority: Number(b.priority) || 100 } : {}) } })
  await writeAudit({ actorUserId: session.userId, action: 'aa.rule_updated', entityType: 'AaLedgerRule', entityId: rule.id, before: rule, after: v, req })
  ok(res, { id: rule.id })
}))

auditAutomationRouter.delete('/rules/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireAaUpload(session)
  const organisationId = await orgIdOf(session.userId)
  const rule = await prisma.aaLedgerRule.findFirst({ where: { id: req.params.id, organisationId, deletedAt: null } })
  if (!rule) throw ApiError.notFound('No such rule.')
  await prisma.aaLedgerRule.update({ where: { id: rule.id }, data: { deletedAt: new Date() } })
  await writeAudit({ actorUserId: session.userId, action: 'aa.rule_deleted', entityType: 'AaLedgerRule', entityId: rule.id, req })
  ok(res, { deleted: true })
}))
