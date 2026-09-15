/**
 * HTTP surface for composed GST returns.
 *
 * Mounted at `/api/gst` in app.ts. Every route follows the platform
 * envelope ({ data } / { error }) and uses `okB` so paise-as-BigInt
 * survives JSON serialisation.
 *
 * The compose flow:
 *   1. Caller posts `{ client_id, period, return_type }`.
 *   2. We resolve the client's BooksOrganisation and its GstProfile.
 *   3. We upsert the GstFiling parent for (period, return_type).
 *   4. The composer reads BooksDocument for the period and produces the
 *      draft; the persistence layer saves it in a transaction.
 *
 * The other routes are read-side: list, get, validation, and the
 * `mark-ready` transition that gates PR 4's submission step.
 */
import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { prisma } from '../../lib/prisma.js'
import { okB } from '../books/serialize.js'
import { writeAudit } from '../../platform/audit.js'
import {
  composeAndSaveGstr1,
  composeAndSaveGstr3b,
  ensureGstFiling,
  findGstProfile,
  getReturnDraft,
  listReturnDrafts,
  markReturnReady,
  validateStoredDraft,
} from './services/GstReturnPersistence.js'
import { searchHsn } from './services/HsnSearchService.js'
import { createGstnClient } from './services/gstn/index.js'
import { refreshSubmissionStatus, submitReturn, SubmissionError } from './services/GstReturnSubmission.js'

export const gstReturnsRouter = Router()

// ── Permission helpers ────────────────────────────────────────────────

function requireGstRead(session: Session): void {
  if (!can(session, 'workstation.gst.read', 'self')) {
    throw ApiError.forbidden('You do not have permission to view GST returns.')
  }
}
function requireGstManage(session: Session): void {
  if (!can(session, 'workstation.gst.manage', 'self')) {
    throw ApiError.forbidden('You do not have permission to compose or file GST returns.')
  }
}

// ── Small shape validators reused across routes ───────────────────────

const periodSchema = z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM')
const returnTypeSchema = z.enum(['GSTR-1', 'GSTR-3B', 'GSTR-9'])

/**
 * Resolve a Workstation clientId to its BooksOrganisation. Errors are
 * specific so the UI can give an actionable message rather than a
 * generic 404.
 */
async function resolveBooksOrg(clientId: string) {
  const booksOrg = await prisma.booksOrganisation.findFirst({ where: { clientId, deletedAt: null } })
  if (!booksOrg) {
    throw ApiError.notFound(
      `Client ${clientId} has no set of books yet — open Books and create one before composing a return.`,
    )
  }
  return booksOrg
}

// ── POST /api/gst/returns/compose ─────────────────────────────────────
// Runs the composer for a (client, period, return_type) and saves the
// result. GSTR-3B optionally accepts a reconciliation job id whose
// totalsJson supplies ITC input.

gstReturnsRouter.post('/returns/compose', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstManage(session)

  const body = z.object({
    client_id:      z.string().min(1),
    period:         periodSchema,
    return_type:    returnTypeSchema,
    /** Optional: which recon job to source ITC from for GSTR-3B. */
    recon_job_id:   z.string().min(1).optional(),
    /** Optional: link a 3B to a previously composed 1. */
    gstr1_draft_id: z.string().min(1).optional(),
  }).safeParse(req.body ?? {})
  if (!body.success) {
    throw ApiError.badRequest('client_id, period (YYYY-MM), return_type are required.', body.error.flatten().fieldErrors)
  }
  const { client_id, period, return_type, recon_job_id, gstr1_draft_id } = body.data

  const profile = await findGstProfile(prisma, client_id)
  if (!profile) {
    throw ApiError.notFound(
      `Client ${client_id} has no GST profile — set the client's GSTIN in Workstation before composing a return.`,
    )
  }
  const booksOrg = await resolveBooksOrg(client_id)

  const filing = await ensureGstFiling(prisma, {
    gstProfileId:       profile.id,
    period,
    returnType:         return_type,
    assignedEmployeeId: session.userId,
  })

  // GSTR-9 (annual) is out of scope for PR 3 — schema accepts it,
  // composer doesn't emit one yet. Turn it away with a clear message.
  if (return_type === 'GSTR-9') {
    throw ApiError.unprocessable('unsupported_return_type', 'GSTR-9 composition is not yet implemented.')
  }

  let result: Awaited<ReturnType<typeof composeAndSaveGstr1 | typeof composeAndSaveGstr3b>>
  if (return_type === 'GSTR-1') {
    result = await composeAndSaveGstr1(prisma, {
      booksOrgId:  booksOrg.id,
      gstFilingId: filing.id,
      period,
      userId:      session.userId,
    })
  } else {
    let reconTotalsJson: string | null = null
    if (recon_job_id) {
      const job = await prisma.aaGstReconJob.findUnique({ where: { id: recon_job_id } })
      if (!job) throw ApiError.notFound(`Recon job ${recon_job_id} not found.`)
      reconTotalsJson = job.totalsJson
    }
    result = await composeAndSaveGstr3b(prisma, {
      booksOrgId:  booksOrg.id,
      gstFilingId: filing.id,
      period,
      userId:      session.userId,
      reconTotalsJson,
      gstr1DraftId: gstr1_draft_id ?? null,
    })
  }

  await writeAudit({
    actorUserId: session.userId,
    action:      'gst.return.composed',
    entityType:  'GstReturnDraft',
    entityId:    result.saved.id,
    after:       { client_id, period, return_type },
    req,
  })

  okB(res, {
    id: result.saved.id,
    filing_id: filing.id,
    period,
    return_type,
    totals: {
      taxable_value: result.saved.totalTaxableValue,
      cgst:          result.saved.totalCgst,
      sgst:          result.saved.totalSgst,
      igst:          result.saved.totalIgst,
      cess:          result.saved.totalCess,
      invoice_count: result.saved.invoiceCount,
    },
    section_count: result.draft.returnType === 'GSTR-1' ? result.draft.sections.length : 0,
  }, 201)
}))

// ── GET /api/gst/returns ──────────────────────────────────────────────

gstReturnsRouter.get('/returns', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstRead(session)

  const q = z.object({
    client_id:     z.string().optional(),
    period_from:   periodSchema.optional(),
    period_to:     periodSchema.optional(),
    return_type:   returnTypeSchema.optional(),
    status:        z.enum(['draft', 'ready_to_file', 'submitted', 'filed', 'rejected', 'superseded']).optional(),
  }).safeParse(req.query)
  if (!q.success) throw ApiError.badRequest('Bad query.', q.error.flatten().fieldErrors)

  const { items } = await listReturnDrafts(prisma, {
    clientId:   q.data.client_id,
    periodFrom: q.data.period_from,
    periodTo:   q.data.period_to,
    returnType: q.data.return_type,
    status:     q.data.status,
  })
  okB(res, { items })
}))

// ── GET /api/gst/returns/:id ──────────────────────────────────────────

gstReturnsRouter.get('/returns/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstRead(session)

  const draft = await getReturnDraft(prisma, req.params.id)
  if (!draft) throw ApiError.notFound('Return draft not found.')
  okB(res, draft)
}))

// ── GET /api/gst/returns/:id/validation ───────────────────────────────

gstReturnsRouter.get('/returns/:id/validation', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstRead(session)

  const draft = await getReturnDraft(prisma, req.params.id)
  if (!draft) throw ApiError.notFound('Return draft not found.')
  const findings = await validateStoredDraft(prisma, draft.id)
  okB(res, {
    id: draft.id,
    status: draft.status,
    findings,
    error_count:   findings.filter((f) => f.severity === 'error').length,
    warning_count: findings.filter((f) => f.severity === 'warning').length,
  })
}))

// ── POST /api/gst/returns/:id/mark-ready ──────────────────────────────

gstReturnsRouter.post('/returns/:id/mark-ready', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstManage(session)

  // Refuse to mark ready when the validator has open errors — a
  // filed-with-errors return will bounce from GSTN and cost the firm a
  // late fee. Warnings do not block.
  const findings = await validateStoredDraft(prisma, req.params.id)
  const errors = findings.filter((f) => f.severity === 'error')
  if (errors.length) {
    throw ApiError.unprocessable('validation_errors', 'Return has validation errors. Fix them before marking ready.', { errors })
  }

  let updated
  try {
    updated = await markReturnReady(prisma, req.params.id, session.userId)
  } catch (e) {
    throw ApiError.unprocessable('bad_transition', (e as Error).message)
  }
  if (!updated) throw ApiError.notFound('Return draft not found.')

  await writeAudit({
    actorUserId: session.userId,
    action:      'gst.return.ready_to_file',
    entityType:  'GstReturnDraft',
    entityId:    updated.id,
    req,
  })

  okB(res, { id: updated.id, status: updated.status })
}))

// ── POST /api/gst/returns/:id/submit ──────────────────────────────────
// Submits a ready_to_file draft to the GSTN client resolved by the
// GSTN_MODE env flag (fake by default). The route is mode-agnostic —
// it never checks whether the client is fake or live.

gstReturnsRouter.post('/returns/:id/submit', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstManage(session)

  const client = createGstnClient()
  let updated
  try {
    updated = await submitReturn(prisma, { draftId: req.params.id, userId: session.userId, client })
  } catch (e) {
    if (e instanceof SubmissionError) {
      if (e.code === 'not_found')       throw ApiError.notFound(e.message)
      if (e.code === 'bad_transition')  throw ApiError.unprocessable('bad_transition', e.message)
      if (e.code === 'missing_gstin')   throw ApiError.unprocessable('missing_gstin', e.message)
      if (e.code === 'portal_rejected') throw ApiError.unprocessable('portal_rejected', e.message, e.detail)
    }
    throw e
  }

  await writeAudit({
    actorUserId: session.userId,
    action:      'gst.return.submitted',
    entityType:  'GstReturnDraft',
    entityId:    updated.id,
    after:       { arn: updated.arn, mode: updated.gstnMode, status: updated.status },
    req,
  })

  okB(res, {
    id:            updated.id,
    status:        updated.status,
    arn:           updated.arn,
    gstn_mode:     updated.gstnMode,
    submitted_at:  updated.submittedAt,
    filed_at:      updated.filedAt,
  })
}))

// ── POST /api/gst/returns/:id/refresh-status ──────────────────────────
// Polls the portal for the current state of a submitted return's ARN.
// A no-op on the fake client (its status is decided at submit time),
// necessary on the live client after the operator completes DSC/EVC
// out-of-band.

gstReturnsRouter.post('/returns/:id/refresh-status', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstManage(session)

  const client = createGstnClient()
  try {
    const result = await refreshSubmissionStatus(prisma, { draftId: req.params.id, userId: session.userId, client })
    okB(res, {
      id:           req.params.id,
      draft_status: result.draftStatus,
      portal:       result.portal,
    })
  } catch (e) {
    if (e instanceof SubmissionError && e.code === 'not_found') throw ApiError.notFound(e.message)
    throw e
  }
}))

// ── GET /api/gst/hsn/search ───────────────────────────────────────────

gstReturnsRouter.get('/hsn/search', handler(async (req, res) => {
  const session = requireSession(req)
  requireGstRead(session)

  const q = z.object({
    q:     z.string().optional(),
    kind:  z.enum(['goods', 'services']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }).safeParse(req.query)
  if (!q.success) throw ApiError.badRequest('Bad query.', q.error.flatten().fieldErrors)

  const items = await searchHsn(prisma, q.data)
  okB(res, { items })
}))
