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
import { assertClientVisible } from '../../platform/workstation/scope.js'
import { scanUploads } from '../../platform/virusScan.js'

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

// Client assignment: Associates and Interns only reach their own clients'
// returns, registers and reconciliations (see assertClientVisible).
const jobClient = async (id: string) => (await prisma.aaGstReconJob.findUnique({ where: { id }, select: { clientId: true } }))?.clientId
const rowClient = async (id: string) => (await prisma.aaGstReconRow.findUnique({ where: { id }, select: { job: { select: { clientId: true } } } }))?.job.clientId
/** For an :id that does not exist, let the service answer 404 as before. */
async function guard(session: Session, clientId: string | undefined) {
  if (clientId !== undefined) await assertClientVisible(session, clientId)
}

// ── GSTR-2B upload ───────────────────────────────────────────────────────
gstRouter.post('/2b/uploads', (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return scanUploads(req, res, next)
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
  await assertClientVisible(session, body.data.client_id)

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
  await assertClientVisible(session, q.data.client_id)
  const organisationId = await orgIdOf(session.userId)
  ok(res, { items: await Gstr2BService.listForClient(q.data.client_id, organisationId) })
}))

// ── Purchase Register upload (2-step for Excel) ──────────────────────────
gstRouter.post('/purchase-registers/uploads', (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return scanUploads(req, res, next)
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
  await assertClientVisible(session, body.data.client_id)

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
  await assertClientVisible(session, q.data.client_id)
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
  // The service also requires the 2B and the register to belong to this client.
  await assertClientVisible(session, b.data.client_id)
  const organisationId = await orgIdOf(session.userId)
  const job = await GstReconJobService.createAndRun({
    session, organisationId,
    clientId: b.data.client_id,
    filing2BId: b.data.filing_2b_id,
    purchaseRegisterId: b.data.purchase_register_id,
    req,
  })
  // The run completes inside the request, so the answer is the finished job.
  ok(res, job, job.status === 'failed' ? 422 : 201)
}))

gstRouter.get('/recon', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstView(session)
  const q = z.object({ client_id: z.string().min(1) }).safeParse(req.query)
  if (!q.success) throw ApiError.badRequest('client_id is required.')
  await assertClientVisible(session, q.data.client_id)
  ok(res, { items: await GstReconJobService.listForClient(session, q.data.client_id) })
}))

gstRouter.get('/recon/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstView(session)
  await guard(session, await jobClient(req.params.id))
  ok(res, await GstReconJobService.get(session, req.params.id))
}))

gstRouter.get('/recon/:id/rows', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstView(session)
  const q = z.object({
    status: z.enum(['all', 'matched', 'partial', 'variance', 'only_2b', 'only_pr', 'duplicate']).optional(),
    itc: z.enum(['eligible', 'ineligible', 'blocked', 'reversal', 'rcm']).optional(),
    search: z.string().max(100).optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }).safeParse(req.query)
  if (!q.success) throw ApiError.badRequest('Invalid filter.')
  await guard(session, await jobClient(req.params.id))
  ok(res, await GstReconJobService.getRows(session, req.params.id, q.data))
}))

gstRouter.patch('/recon/rows/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstUpload(session)
  const b = z.object({
    itc_classification: z.enum(['eligible', 'ineligible', 'reversal', 'blocked', 'rcm']).optional(),
    itc_reason: z.string().max(500).nullable().optional(),
    auditor_note: z.string().max(2000).nullable().optional(),
  }).safeParse(req.body)
  if (!b.success) throw ApiError.badRequest('Invalid patch.')
  await guard(session, await rowClient(req.params.id))
  ok(res, await GstReconJobService.updateRow(session, req.params.id, { ...b.data, req }))
}))

gstRouter.get('/recon/:id/export.xlsx', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstView(session)
  await guard(session, await jobClient(req.params.id))
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

gstRouter.get('/recon/:id/export.csv', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstView(session)
  await guard(session, await jobClient(req.params.id))
  const text = await GstReconExportService.csv(session, req.params.id)
  await writeAudit({ actorUserId: session.userId, action: 'aa.gst.exported', entityType: 'AaGstReconJob', entityId: req.params.id, after: { kind: 'csv' }, req })
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="gst-recon-${req.params.id}.csv"`)
  res.send(text)
}))

// Manual pairing: a 2B-only row and a books-only row the matcher could not connect.
gstRouter.post('/recon/:id/pair', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstUpload(session)
  const b = z.object({ two_b_row_id: z.string().min(1), pr_row_id: z.string().min(1) }).safeParse(req.body)
  if (!b.success) throw ApiError.badRequest('two_b_row_id and pr_row_id are required.')
  await guard(session, await jobClient(req.params.id))
  ok(res, await GstReconJobService.pair(session, req.params.id, b.data.two_b_row_id, b.data.pr_row_id, req))
}))

gstRouter.post('/recon/rows/:id/unpair', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstUpload(session)
  await guard(session, await rowClient(req.params.id))
  ok(res, await GstReconJobService.unpair(session, req.params.id, req))
}))

gstRouter.delete('/recon/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstUpload(session)
  await guard(session, await jobClient(req.params.id))
  await GstReconJobService.remove(session, req.params.id, req)
  ok(res, { deleted: true })
}))

gstRouter.delete('/2b/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstUpload(session)
  await guard(session, (await prisma.aaGstFiling2B.findUnique({ where: { id: req.params.id }, select: { clientId: true } }))?.clientId)
  await Gstr2BService.remove(session, await orgIdOf(session.userId), req.params.id, req)
  ok(res, { deleted: true })
}))

gstRouter.delete('/purchase-registers/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstUpload(session)
  await guard(session, (await prisma.aaPurchaseRegister.findUnique({ where: { id: req.params.id }, select: { clientId: true } }))?.clientId)
  await PurchaseRegisterService.remove(session, await orgIdOf(session.userId), req.params.id, req)
  ok(res, { deleted: true })
}))
