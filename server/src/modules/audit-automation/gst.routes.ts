import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { prisma } from '../../lib/prisma.js'
import { sanitizeFilename } from '../tools/lib/files.js'
import { Gstr2BService } from './services/Gstr2BService.js'
import { PurchaseRegisterService } from './services/PurchaseRegisterService.js'
import { GstReconJobService } from './services/GstReconJobService.js'
import { GstReconExportService } from './services/GstReconExportService.js'
import type { PurchaseRegisterColumnMap } from './parsers/types.js'
import { writeAudit } from '../../platform/audit.js'

/**
 * GST reconciliation HTTP surface.
 *
 * All routes mounted at /api/audit-automation/gst/* via app.ts.
 */
export const gstRouter = Router()

const MAX_MB = 25
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
})

function requireGstUpload(session: Session) {
  if (!can(session, 'tools.audit_automation.gst.upload', 'self')) {
    throw ApiError.forbidden('You do not have permission to upload GST files.')
  }
}
function requireGstView(session: Session) {
  if (!can(session, 'tools.audit_automation.gst.view', 'self')) {
    throw ApiError.forbidden('You do not have permission to view GST reconciliations.')
  }
}
async function orgIdOf(userId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { organisationId: true } })
  return u.organisationId
}

// ── GSTR-2B upload ───────────────────────────────────────────────────────
gstRouter.post('/2b/uploads', (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next()
    const code = (err as { code?: string }).code
    if (code === 'LIMIT_FILE_SIZE') return next(ApiError.unprocessable('too_large', `File is larger than ${MAX_MB} MB.`))
    next(ApiError.badRequest('Upload could not be read.'))
  })
}, handler(async (req, res) => {
  const session = requireSession(req)
  requireGstUpload(session)

  const body = z.object({
    client_id: z.string().min(1),
    period_month: z.coerce.number().int().min(1).max(12),
    period_year: z.coerce.number().int().min(2017).max(2100),
  }).safeParse(req.body)
  if (!body.success) throw ApiError.badRequest('client_id, period_month, period_year are required.')

  const file = req.file
  if (!file || file.size === 0) throw ApiError.unprocessable('empty', 'Choose a file to upload.')
  const filename = sanitizeFilename(Buffer.from(file.originalname, 'latin1').toString('utf8'))
  const organisationId = await orgIdOf(session.userId)

  const result = await Gstr2BService.upload({
    session, organisationId,
    clientId: body.data.client_id,
    periodMonth: body.data.period_month,
    periodYear: body.data.period_year,
    originalFilename: filename,
    bytes: file.buffer,
    req,
  })
  ok(res, result, 201)
}))

gstRouter.get('/2b', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstView(session)
  const q = z.object({ client_id: z.string().min(1) }).safeParse(req.query)
  if (!q.success) throw ApiError.badRequest('client_id is required.')
  const organisationId = await orgIdOf(session.userId)
  ok(res, { items: await Gstr2BService.listForClient(q.data.client_id, organisationId) })
}))

// ── Purchase Register upload (2-step for Excel) ──────────────────────────
gstRouter.post('/purchase-registers/uploads', (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next()
    const code = (err as { code?: string }).code
    if (code === 'LIMIT_FILE_SIZE') return next(ApiError.unprocessable('too_large', `File is larger than ${MAX_MB} MB.`))
    next(ApiError.badRequest('Upload could not be read.'))
  })
}, handler(async (req, res) => {
  const session = requireSession(req)
  requireGstUpload(session)

  const body = z.object({
    client_id: z.string().min(1),
    period_month: z.coerce.number().int().min(1).max(12),
    period_year: z.coerce.number().int().min(2017).max(2100),
    /** Excel step 2 — JSON string of PurchaseRegisterColumnMap. */
    column_map: z.string().optional(),
  }).safeParse(req.body)
  if (!body.success) throw ApiError.badRequest('client_id, period_month, period_year are required.')

  let columnMap: PurchaseRegisterColumnMap | undefined
  if (body.data.column_map) {
    try { columnMap = JSON.parse(body.data.column_map) as PurchaseRegisterColumnMap }
    catch { throw ApiError.badRequest('column_map is not valid JSON.') }
  }

  const file = req.file
  if (!file || file.size === 0) throw ApiError.unprocessable('empty', 'Choose a file to upload.')
  const filename = sanitizeFilename(Buffer.from(file.originalname, 'latin1').toString('utf8'))
  const organisationId = await orgIdOf(session.userId)

  const result = await PurchaseRegisterService.upload({
    session, organisationId,
    clientId: body.data.client_id,
    periodMonth: body.data.period_month,
    periodYear: body.data.period_year,
    originalFilename: filename,
    bytes: file.buffer,
    columnMap,
    req,
  })
  // If we only produced a preview (Excel step 1), respond 200; otherwise 201.
  ok(res, result, result.register_id ? 201 : 200)
}))

gstRouter.get('/purchase-registers', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstView(session)
  const q = z.object({ client_id: z.string().min(1) }).safeParse(req.query)
  if (!q.success) throw ApiError.badRequest('client_id is required.')
  const organisationId = await orgIdOf(session.userId)
  ok(res, { items: await PurchaseRegisterService.listForClient(q.data.client_id, organisationId) })
}))

// ── Recon job create + read ──────────────────────────────────────────────
gstRouter.post('/recon', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstUpload(session)
  const b = z.object({
    client_id: z.string().min(1),
    filing_2b_id: z.string().min(1),
    purchase_register_id: z.string().min(1),
  }).safeParse(req.body)
  if (!b.success) throw ApiError.badRequest('client_id, filing_2b_id, purchase_register_id required.')
  const organisationId = await orgIdOf(session.userId)
  const job = await GstReconJobService.createAndRun({
    session, organisationId,
    clientId: b.data.client_id,
    filing2BId: b.data.filing_2b_id,
    purchaseRegisterId: b.data.purchase_register_id,
    req,
  })
  ok(res, job, 202)
}))

gstRouter.get('/recon', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstView(session)
  const q = z.object({ client_id: z.string().min(1) }).safeParse(req.query)
  if (!q.success) throw ApiError.badRequest('client_id is required.')
  ok(res, { items: await GstReconJobService.listForClient(session, q.data.client_id) })
}))

gstRouter.get('/recon/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstView(session)
  ok(res, await GstReconJobService.get(session, req.params.id))
}))

gstRouter.get('/recon/:id/rows', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstView(session)
  const q = z.object({
    status: z.enum(['matched', 'partial', 'only_2b', 'only_pr']).optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }).safeParse(req.query)
  if (!q.success) throw ApiError.badRequest('Invalid filter.')
  ok(res, await GstReconJobService.getRows(session, req.params.id, q.data))
}))

gstRouter.patch('/recon/rows/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstUpload(session)
  const b = z.object({
    itc_classification: z.enum(['eligible', 'ineligible', 'reversal', 'blocked']).optional(),
    auditor_note: z.string().max(2000).nullable().optional(),
  }).safeParse(req.body)
  if (!b.success) throw ApiError.badRequest('Invalid patch.')
  ok(res, await GstReconJobService.updateRow(session, req.params.id, { ...b.data, req }))
}))

gstRouter.get('/recon/:id/export.xlsx', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstView(session)
  const bytes = await GstReconExportService.workbook(session, req.params.id)
  await writeAudit({
    actorUserId: session.userId,
    action: 'aa.gst.exported',
    entityType: 'AaGstReconJob',
    entityId: req.params.id,
    after: { size: bytes.length },
    req,
  })
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="gst-recon-${req.params.id}.xlsx"`)
  res.send(bytes)
}))
