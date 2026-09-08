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

/**
 * AUDIT AUTOMATION HTTP SURFACE.
 *
 *   GET  /api/audit-automation/banks                    — bank picker
 *   GET  /api/audit-automation/accounts?client_id=…     — accounts for a client
 *   POST /api/audit-automation/accounts                 — add account
 *   POST /api/audit-automation/uploads                  — the wireframe submit
 *   GET  /api/audit-automation/jobs?client_id=…         — jobs for a client
 *   GET  /api/audit-automation/jobs/:id                 — one job
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
    override_adapter_mismatch: z.string().optional(),
  }).safeParse(req.body)
  if (!body.success) throw ApiError.badRequest('client_id, bank_key and bank_account_id are required.')

  const file = req.file
  if (!file) throw ApiError.unprocessable('empty', 'Choose a file to upload.')
  if (file.size === 0) throw ApiError.unprocessable('empty', 'The uploaded file is empty.')

  // (a) File type — magic-byte sniff. Only PDF is accepted for bank statements.
  const filename = sanitizeFilename(Buffer.from(file.originalname, 'latin1').toString('utf8'))
  const ext = extensionOf(filename)
  const sniffed = await sniffMime(file.buffer, ext)
  if (sniffed !== 'application/pdf') {
    throw ApiError.unprocessable('unsupported_type', 'Bank statements must be a PDF file.')
  }

  const organisationId = await orgIdOf(session.userId)
  const result = await AaUploadService.process({
    session,
    organisationId,
    clientId: body.data.client_id,
    bankKey: body.data.bank_key,
    bankAccountId: body.data.bank_account_id,
    originalFilename: filename,
    mimeType: sniffed,
    bytes: file.buffer,
    password: body.data.password,
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
      bank: { id: doc.bank.id, key: doc.bank.key, name: doc.bank.name },
      bank_account: { id: doc.bankAccount.id, account_number_masked: doc.bankAccount.accountNumberMasked, label: doc.bankAccount.label },
      uploaded_by: { id: doc.uploadedBy.id, label: doc.uploadedBy.employee?.fullName ?? doc.uploadedBy.email },
      uploaded_at: doc.createdAt.toISOString(),
    } : null,
  })
}))
