import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { prisma } from '../../lib/prisma.js'
import { sanitizeFilename } from '../tools/lib/files.js'
import { Tds26ASService } from './services/Tds26ASService.js'
import { TdsBooksService } from './services/TdsBooksService.js'
import { TdsReconJobService } from './services/TdsReconJobService.js'
import { TdsReconExportService } from './services/TdsReconExportService.js'
import type { TdsBooksColumnMap } from './parsers/tdsTypes.js'
import { writeAudit } from '../../platform/audit.js'

export const tdsRouter = Router()

const MAX_MB = 25
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
})

function requireTdsUpload(session: Session) {
  if (!can(session, 'tools.audit_automation.tds.upload', 'self')) {
    throw ApiError.forbidden('You do not have permission to upload TDS files.')
  }
}
function requireTdsView(session: Session) {
  if (!can(session, 'tools.audit_automation.tds.view', 'self')) {
    throw ApiError.forbidden('You do not have permission to view TDS reconciliations.')
  }
}
async function orgIdOf(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { organisationId: true } })
  return u.organisationId
}

// ── 26AS upload ─────────────────────────────────────────────────────────
tdsRouter.post('/26as/uploads', (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next()
    const code = (err as { code?: string }).code
    if (code === 'LIMIT_FILE_SIZE') return next(ApiError.unprocessable('too_large', `File is larger than ${MAX_MB} MB.`))
    next(ApiError.badRequest('Upload could not be read.'))
  })
}, handler(async (req, res) => {
  const session = requireSession(req)
  requireTdsUpload(session)
  const body = z.object({
    client_id: z.string().min(1),
    assessment_year: z.coerce.number().int().min(2000).max(2100),
  }).safeParse(req.body)
  if (!body.success) throw ApiError.badRequest('client_id and assessment_year are required.')

  const file = req.file
  if (!file || file.size === 0) throw ApiError.unprocessable('empty', 'Choose a file to upload.')
  const filename = sanitizeFilename(Buffer.from(file.originalname, 'latin1').toString('utf8'))
  const organisationId = await orgIdOf(session.userId)
  const result = await Tds26ASService.upload({
    session, organisationId,
    clientId: body.data.client_id,
    assessmentYear: body.data.assessment_year,
    originalFilename: filename, bytes: file.buffer, req,
  })
  ok(res, result, 201)
}))

tdsRouter.get('/26as', handler(async (req, res) => {
  const session = requireSession(req)
  requireTdsView(session)
  const q = z.object({ client_id: z.string().min(1) }).safeParse(req.query)
  if (!q.success) throw ApiError.badRequest('client_id is required.')
  const organisationId = await orgIdOf(session.userId)
  ok(res, { items: await Tds26ASService.listForClient(q.data.client_id, organisationId) })
}))

// ── Books upload (2-step for Excel) ─────────────────────────────────────
tdsRouter.post('/books/uploads', (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next()
    const code = (err as { code?: string }).code
    if (code === 'LIMIT_FILE_SIZE') return next(ApiError.unprocessable('too_large', `File is larger than ${MAX_MB} MB.`))
    next(ApiError.badRequest('Upload could not be read.'))
  })
}, handler(async (req, res) => {
  const session = requireSession(req)
  requireTdsUpload(session)
  const body = z.object({
    client_id: z.string().min(1),
    assessment_year: z.coerce.number().int().min(2000).max(2100),
    column_map: z.string().optional(),
  }).safeParse(req.body)
  if (!body.success) throw ApiError.badRequest('client_id and assessment_year are required.')

  let columnMap: TdsBooksColumnMap | undefined
  if (body.data.column_map) {
    try { columnMap = JSON.parse(body.data.column_map) as TdsBooksColumnMap }
    catch { throw ApiError.badRequest('column_map is not valid JSON.') }
  }
  const file = req.file
  if (!file || file.size === 0) throw ApiError.unprocessable('empty', 'Choose a file to upload.')
  const filename = sanitizeFilename(Buffer.from(file.originalname, 'latin1').toString('utf8'))
  const organisationId = await orgIdOf(session.userId)
  const result = await TdsBooksService.upload({
    session, organisationId,
    clientId: body.data.client_id,
    assessmentYear: body.data.assessment_year,
    originalFilename: filename, bytes: file.buffer, columnMap, req,
  })
  ok(res, result, result.books_id ? 201 : 200)
}))

tdsRouter.get('/books', handler(async (req, res) => {
  const session = requireSession(req)
  requireTdsView(session)
  const q = z.object({ client_id: z.string().min(1) }).safeParse(req.query)
  if (!q.success) throw ApiError.badRequest('client_id is required.')
  const organisationId = await orgIdOf(session.userId)
  ok(res, { items: await TdsBooksService.listForClient(q.data.client_id, organisationId) })
}))

// ── Recon ───────────────────────────────────────────────────────────────
tdsRouter.post('/recon', handler(async (req, res) => {
  const session = requireSession(req)
  requireTdsUpload(session)
  const b = z.object({
    client_id: z.string().min(1),
    filing_26as_id: z.string().min(1),
    books_id: z.string().min(1),
  }).safeParse(req.body)
  if (!b.success) throw ApiError.badRequest('client_id, filing_26as_id, books_id required.')
  const organisationId = await orgIdOf(session.userId)
  const job = await TdsReconJobService.createAndRun({
    session, organisationId,
    clientId: b.data.client_id,
    filing26ASId: b.data.filing_26as_id,
    booksId: b.data.books_id,
    req,
  })
  ok(res, job, 202)
}))

tdsRouter.get('/recon', handler(async (req, res) => {
  const session = requireSession(req)
  requireTdsView(session)
  const q = z.object({ client_id: z.string().min(1) }).safeParse(req.query)
  if (!q.success) throw ApiError.badRequest('client_id is required.')
  ok(res, { items: await TdsReconJobService.listForClient(session, q.data.client_id) })
}))

tdsRouter.get('/recon/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireTdsView(session)
  ok(res, await TdsReconJobService.get(session, req.params.id))
}))

tdsRouter.get('/recon/:id/rows', handler(async (req, res) => {
  const session = requireSession(req)
  requireTdsView(session)
  const q = z.object({
    status: z.enum(['verified', 'variance', 'only_26as', 'only_books']).optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }).safeParse(req.query)
  if (!q.success) throw ApiError.badRequest('Invalid filter.')
  ok(res, await TdsReconJobService.getRows(session, req.params.id, q.data))
}))

tdsRouter.patch('/recon/rows/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireTdsUpload(session)
  const b = z.object({
    action_status: z.enum(['no_action', 'chase_deductor', 'revise_book', 'credit_claimed', 'written_off']).optional(),
    auditor_note: z.string().max(2000).nullable().optional(),
  }).safeParse(req.body)
  if (!b.success) throw ApiError.badRequest('Invalid patch.')
  ok(res, await TdsReconJobService.updateRow(session, req.params.id, { ...b.data, req }))
}))

tdsRouter.get('/recon/:id/export.xlsx', handler(async (req, res) => {
  const session = requireSession(req)
  requireTdsView(session)
  const bytes = await TdsReconExportService.workbook(session, req.params.id)
  await writeAudit({
    actorUserId: session.userId,
    action: 'aa.tds.exported',
    entityType: 'AaTdsReconJob',
    entityId: req.params.id,
    after: { size: bytes.length },
    req,
  })
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="tds-recon-${req.params.id}.xlsx"`)
  res.send(bytes)
}))
