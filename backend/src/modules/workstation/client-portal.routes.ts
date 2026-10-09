import crypto from 'node:crypto'
import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { scanUploads } from '../../platform/virusScan.js'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { env } from '../../lib/env.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { writeActivity } from '../../platform/workstation/activity.js'
import { assertCanSeeClient, requireWorkstation } from '../../platform/workstation/scope.js'
import JSZip from 'jszip'
import { renderPdf } from '../../platform/pdfBuffer.js'
import { streamInvoicePdf, INVOICE_PDF_INCLUDE } from '../invoice/pdf.js'
import { streamQuotationPdf, QUOTATION_PDF_INCLUDE } from '../quotation/pdf.js'
import { streamEngagementPdf } from '../engagement/pdf.js'
import { INCLUDE as ENGAGEMENT_INCLUDE } from '../engagement/service.js'
import { streamDocPdf } from '../docs/pdf.js'
import { INCLUDE as DOC_INCLUDE } from '../docs/service.js'
import { streamEInvoicePdf, streamEwayBillPdf, streamGstFilingPdf } from './record-pdf.js'
import {
  buildClientFolders, CLIENT_VIEW, readVersionBytes, sendFile,
  CLIENT_DOC_MAX_MB, CLIENT_DOC_MIME, clientDocContentMatches, clientDocumentStorage,
} from './client-folders.routes.js'
import { rateLimit } from '../../lib/rateLimit.js'
import { lockSequence } from '../../lib/sequence.js'
import { addDays, istToday } from '../../lib/dates.js'
import { notifyEmployee } from '../../platform/notify.js'
import { buildContext, itemToApi } from '../compliance/service.js'

/**
 * CLIENT DOCUMENT LINK — the client's own live view of their Documents tab.
 *
 * Staff (authenticated, mounted under /api/clients):
 *   GET    /api/clients/:id/share-link          the current link (on or off), or null
 *   POST   /api/clients/:id/share-link          create — or regenerate, which revokes the old one for good
 *   DELETE /api/clients/:id/share-link          turn off: the URL stops working at once
 *   POST   /api/clients/:id/share-link/resume   turn the SAME link back on
 *
 * Client (public, mounted before `authenticate`):
 *   GET /api/client-portal/:token                    folders, built fresh on every call
 *   GET /api/client-portal/:token/open?source&ref[&download=1]   the file — inline, or as a download
 *   GET /api/client-portal/:token/zip[?folder=key]               every available file, zipped
 *   GET  /api/client-portal/:token/requests                       documents the firm is waiting for
 *   POST /api/client-portal/:token/requests/:docId/upload         the client sends one (multipart `file`)
 *   GET  /api/client-portal/:token/status                         job status: services, compliance, audits
 *
 * Unlike the 100-year PDF links in share/routes.ts, this token lives in the
 * database so it can be revoked, and it carries no snapshot: every request
 * re-reads the client's documents, so the page is always current.
 */
export const clientShareLinkRouter = Router()
export const clientPortalPublicRouter = Router()

const portalUrl = (token: string) => `${env.publicAppUrl ?? ''}/portal/documents/${token}`

function linkToApi(l: { id: string; token: string; createdAt: Date; pausedAt: Date | null; lastViewedAt: Date | null; viewCount: number }) {
  return {
    id: l.id,
    active: l.pausedAt === null,
    paused_at: l.pausedAt?.toISOString() ?? null,
    url: portalUrl(l.token),
    // Relative when PUBLIC_APP_URL is unset — the UI prefixes its own origin.
    absolute: env.publicAppUrl !== null,
    created_at: l.createdAt.toISOString(),
    last_viewed_at: l.lastViewedAt?.toISOString() ?? null,
    view_count: l.viewCount,
  }
}

const activeLink = (clientId: string) =>
  prisma.clientDocumentShareLink.findFirst({ where: { clientId, revokedAt: null }, orderBy: { createdAt: 'desc' } })

// GET /api/clients/:id/share-link
clientShareLinkRouter.get('/:id/share-link', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.read', 'workstation.document.manage')
  await assertCanSeeClient(session, scope, req.params.id)
  const l = await activeLink(req.params.id)
  ok(res, l ? linkToApi(l) : null)
}))

// POST /api/clients/:id/share-link — a fresh token; any earlier link is revoked.
clientShareLinkRouter.post('/:id/share-link', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.manage')
  const clientId = req.params.id
  await assertCanSeeClient(session, scope, clientId)
  const client = await prisma.client.findFirst({ where: { id: clientId, ...alive }, select: { id: true, companyName: true } })
  if (!client) throw ApiError.notFound('Client not found.')

  const now = new Date()
  const [revoked, link] = await prisma.$transaction([
    prisma.clientDocumentShareLink.updateMany({
      where: { clientId, revokedAt: null }, data: { revokedAt: now, revokedBy: session.userId },
    }),
    prisma.clientDocumentShareLink.create({
      data: { clientId, token: crypto.randomBytes(32).toString('base64url'), createdBy: session.userId },
    }),
  ])

  const regenerated = revoked.count > 0
  await writeActivity({
    session, subjectType: 'client', subjectId: clientId,
    action: regenerated ? 'document_link.regenerated' : 'document_link.created',
    description: regenerated
      ? 'Client document link regenerated — the previous link no longer works.'
      : 'Client document link created.',
    entityType: 'ClientDocumentShareLink', entityId: link.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: regenerated ? 'client_document_link.regenerate' : 'client_document_link.create',
    entityType: 'ClientDocumentShareLink', entityId: link.id, after: { clientId }, req,
  })
  ok(res, linkToApi(link), 201)
}))

// DELETE /api/clients/:id/share-link — turn off (reversible: see /resume).
clientShareLinkRouter.delete('/:id/share-link', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.manage')
  const clientId = req.params.id
  await assertCanSeeClient(session, scope, clientId)

  const l = await activeLink(clientId)
  if (!l) throw ApiError.notFound('This client has no document link.')
  if (l.pausedAt) return ok(res, linkToApi(l))
  const updated = await prisma.clientDocumentShareLink.update({
    where: { id: l.id }, data: { pausedAt: new Date(), pausedBy: session.userId },
  })
  await writeActivity({
    session, subjectType: 'client', subjectId: clientId,
    action: 'document_link.paused', description: 'Client document link turned off.',
    entityType: 'ClientDocumentShareLink', entityId: l.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'client_document_link.pause',
    entityType: 'ClientDocumentShareLink', entityId: l.id, after: { clientId }, req,
  })
  ok(res, linkToApi(updated))
}))

// POST /api/clients/:id/share-link/resume — the same URL works again.
clientShareLinkRouter.post('/:id/share-link/resume', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.manage')
  const clientId = req.params.id
  await assertCanSeeClient(session, scope, clientId)

  const l = await activeLink(clientId)
  if (!l) throw ApiError.notFound('This client has no document link.')
  if (!l.pausedAt) return ok(res, linkToApi(l))
  const updated = await prisma.clientDocumentShareLink.update({
    where: { id: l.id }, data: { pausedAt: null, pausedBy: null },
  })
  await writeActivity({
    session, subjectType: 'client', subjectId: clientId,
    action: 'document_link.resumed', description: 'Client document link turned back on.',
    entityType: 'ClientDocumentShareLink', entityId: l.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'client_document_link.resume',
    entityType: 'ClientDocumentShareLink', entityId: l.id, after: { clientId }, req,
  })
  ok(res, linkToApi(updated))
}))

/** The live, non-revoked link for `token`, with its client — or a 404 that says what happened. */
async function resolveToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw ApiError.notFound('This link is not valid.')
  const link = await prisma.clientDocumentShareLink.findUnique({
    where: { token },
    include: { client: { select: { id: true, organisationId: true, companyName: true, clientCode: true, gstin: true, accountManagerId: true, deletedAt: true } } },
  })
  if (!link || link.client.deletedAt) throw ApiError.notFound('This link is not valid.')
  if (link.revokedAt) throw new ApiError(410, 'link_revoked', 'This link has been replaced by a newer one. Ask your accountant for the new link.')
  if (link.pausedAt) throw new ApiError(410, 'link_paused', 'This link is turned off for now. Ask your accountant to turn it back on.')
  return link
}

// GET /api/client-portal/:token[?visit=1]
clientPortalPublicRouter.get('/client-portal/:token', handler(async (req, res) => {
  const link = await resolveToken(req.params.token)
  const { client } = link

  const [folders, firm] = await Promise.all([
    buildClientFolders(CLIENT_VIEW, client),
    prisma.organisation.findUnique({ where: { id: client.organisationId }, select: { name: true } }),
  ])
  // The page polls to stay live; only its first load counts as a visit.
  if (req.query.visit === '1') {
    await prisma.clientDocumentShareLink.update({
      where: { id: link.id }, data: { lastViewedAt: new Date(), viewCount: { increment: 1 } },
    })
  }

  // Only what the client needs: no staff ids, no internal document ids, no
  // empty folders.
  const shown = folders
    .filter((f) => f.items.length > 0)
    .map((f) => ({
      key: f.key, label: f.label, group: f.group, count: f.items.length,
      items: f.items.map((i) => ({
        id: i.id, source: i.source, title: i.title, subtitle: i.subtitle, date: i.date,
        status: i.status, amount_paise: i.amount_paise,
        openable: i.openable === 'missing' ? 'none' : i.openable,
        file_name: i.file_name, mime_type: i.mime_type, fields: i.fields,
      })),
    }))

  res.setHeader('Cache-Control', 'private, no-store')
  ok(res, {
    firm: firm?.name ?? null,
    client: { name: client.companyName, code: client.clientCode, gstin: client.gstin },
    folders: shown,
    total: shown.reduce((n, f) => n + f.count, 0),
    generated_at: new Date().toISOString(),
  })
}))

/**
 * One document's bytes, for the client. Only what CLIENT_VIEW lists: the row
 * must belong to this client and must not be a draft. Null when it does not
 * exist (or is not visible) or has no file.
 */
async function itemFile(clientId: string, source: string, ref: string): Promise<{ name: string; mime: string; bytes: Buffer } | null> {
  const where = { id: ref, clientId, ...alive }
  const issued = { ...where, status: { not: 'draft' } }
  const pdf = async (name: string, write: (res: never) => unknown) =>
    ({ name, mime: 'application/pdf', bytes: await renderPdf(write) })
  switch (source) {
    case 'invoice': {
      const inv = await prisma.invoice.findFirst({ where: issued, include: INVOICE_PDF_INCLUDE })
      return inv ? pdf(`${inv.invoiceNumber ?? 'invoice'}.pdf`, (res) => streamInvoicePdf(res, inv)) : null
    }
    case 'quotation': {
      const q = await prisma.quotation.findFirst({ where: issued, include: QUOTATION_PDF_INCLUDE })
      return q ? pdf(`${q.quotationCode}.pdf`, (res) => streamQuotationPdf(res, q)) : null
    }
    case 'engagement': {
      const l = await prisma.engagementLetter.findFirst({ where: issued, include: ENGAGEMENT_INCLUDE })
      return l ? pdf(`${l.letterCode}.pdf`, (res) => streamEngagementPdf(res, l)) : null
    }
    case 'wsdoc': {
      const d = await prisma.workstationDoc.findFirst({ where: issued, include: DOC_INCLUDE })
      return d ? pdf(`${d.docCode}.pdf`, (res) => streamDocPdf(res, d)) : null
    }
    case 'eway': {
      const e = await prisma.ewayBill.findFirst({ where, include: { client: true } })
      return e ? pdf(`${e.ewbNo}.pdf`, (res) => streamEwayBillPdf(res, e)) : null
    }
    case 'einvoice': {
      const e = await prisma.eInvoiceIrn.findFirst({ where, include: { client: true } })
      return e ? pdf(`e-invoice-${e.documentNo}.pdf`, (res) => streamEInvoicePdf(res, e)) : null
    }
    case 'gst_filing': {
      const g = await prisma.gstFiling.findFirst({
        where: { id: ref, gstProfile: { clientId }, ...alive }, include: { gstProfile: { include: { client: true } } },
      })
      return g ? pdf(`${g.returnType}-${g.period}.pdf`, (res) => streamGstFilingPdf(res, g)) : null
    }
    case 'upload': {
      const v = await prisma.clientDocumentVersion.findFirst({
        where: { id: ref, document: { clientId, ...alive } }, include: { document: true },
      })
      if (!v?.mimeType) return null
      const bytes = await readVersionBytes(v.fileKey)
      return bytes ? { name: v.originalName ?? v.document.name, mime: v.mimeType, bytes } : null
    }
    default:
      return null
  }
}

// GET /api/client-portal/:token/open?source=…&ref=…[&download=1]
clientPortalPublicRouter.get('/client-portal/:token/open', handler(async (req, res) => {
  const link = await resolveToken(req.params.token)
  const source = String(req.query.source ?? '')
  const ref = String(req.query.ref ?? '')
  const f = await itemFile(link.client.id, source, ref)
  if (!f) throw ApiError.notFound('This document is not available.')
  // The client has no login: the share link is the "who".
  await writeAudit({
    actorUserId: null, action: 'document.download', entityType: 'Client', entityId: link.client.id,
    after: { via: 'client_portal', link_id: link.id, source, ref }, req,
  })
  sendFile(res, f.bytes, f.name, f.mime, req.query.download === '1')
}))

const ZIP_MAX_FILES = 300

// GET /api/client-portal/:token/zip[?folder=key] — one folder, or everything.
clientPortalPublicRouter.get('/client-portal/:token/zip', handler(async (req, res) => {
  const link = await resolveToken(req.params.token)
  const { client } = link
  const only = typeof req.query.folder === 'string' && req.query.folder ? req.query.folder : null

  const folders = (await buildClientFolders(CLIENT_VIEW, client)).filter((f) => !only || f.key === only)
  if (only && folders.length === 0) throw ApiError.notFound('Folder not found.')
  const items = folders.flatMap((f) => f.items
    .filter((i) => i.openable === 'pdf' || i.openable === 'file')
    .map((i) => ({ folder: f.label, source: i.source, id: i.id })))
  if (items.length === 0) throw ApiError.notFound('There are no files to download here yet.')
  if (items.length > ZIP_MAX_FILES) {
    throw ApiError.unprocessable('too_many', `That is more than ${ZIP_MAX_FILES} files — download one folder at a time.`)
  }
  await writeAudit({
    actorUserId: null, action: 'document.download', entityType: 'Client', entityId: client.id,
    after: { via: 'client_portal', link_id: link.id, zip: true, folder: only, files: items.length }, req,
  })

  const zip = new JSZip()
  const used = new Set<string>()
  const clean = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'file'
  // A few at a time: PDFs render in memory.
  for (let i = 0; i < items.length; i += 6) {
    const batch = await Promise.all(items.slice(i, i + 6).map(async (it) => ({ it, f: await itemFile(client.id, it.source, it.id).catch(() => null) })))
    for (const { it, f } of batch) {
      if (!f) continue
      const dir = only ? '' : `${clean(it.folder)}/`
      let name = `${dir}${clean(f.name)}`
      for (let n = 2; used.has(name); n++) name = `${dir}${clean(f.name).replace(/(\.[^.]*)?$/, ` (${n})$1`)}`
      used.add(name)
      zip.file(name, f.bytes)
    }
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  const label = only ? folders[0].label : 'All documents'
  sendFile(res, bytes, `${clean(client.companyName)} - ${clean(label)}.zip`, 'application/zip', true)
}))

// ── Document requests: the client uploads what the firm asked for ─────────

/** A request the client can answer: asked for, or sent back. */
const OPEN_REQUEST_STATUSES = ['requested', 'rejected', 'replacement_required']

// GET /api/client-portal/:token/requests
clientPortalPublicRouter.get('/client-portal/:token/requests', handler(async (req, res) => {
  const link = await resolveToken(req.params.token)
  const docs = await prisma.clientDocument.findMany({
    where: { clientId: link.client.id, ...alive, status: { in: OPEN_REQUEST_STATUSES } },
    include: { category: { select: { name: true } } },
    orderBy: [{ requestedAt: 'asc' }, { createdAt: 'asc' }],
  })
  res.setHeader('Cache-Control', 'private, no-store')
  ok(res, {
    items: docs.map((d) => ({
      id: d.id,
      name: d.name,
      category: d.category.name,
      financial_year: d.financialYear,
      status: d.status,
      // Why it came back — written for the client, shown so they can fix it.
      reason: d.status === 'requested' ? null : d.rejectionReason,
      requested_at: d.requestedAt?.toISOString() ?? null,
    })),
    max_mb: CLIENT_DOC_MAX_MB,
    accepted: Object.keys(CLIENT_DOC_MIME),
  })
}))

const portalUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: CLIENT_DOC_MAX_MB * 1024 * 1024, files: 1 } })
const UPLOADS_PER_LINK = 20
const UPLOADS_PER_IP = 40
const UPLOAD_WINDOW_MS = 10 * 60_000

type PortalLink = Awaited<ReturnType<typeof resolveToken>>

/**
 * Token check and rate limit BEFORE multer, so a dead link or a throttled
 * caller is refused without the server buffering the upload first.
 */
function portalUploadGate(req: Request, res: Response, next: NextFunction) {
  resolveToken(req.params.token).then((link) => {
    if (!rateLimit(`portal-upload:link:${link.id}`, UPLOADS_PER_LINK, UPLOAD_WINDOW_MS)
      || !rateLimit(`portal-upload:ip:${req.ip}`, UPLOADS_PER_IP, UPLOAD_WINDOW_MS)) {
      throw ApiError.tooMany('Too many uploads in a short time. Wait a few minutes and try again.')
    }
    res.locals.portalLink = link
    portalUpload.single('file')(req, res, (err: unknown) => {
      if (!err) return scanUploads(req, res, next)
      if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
        return next(ApiError.unprocessable('too_large', `File is larger than the ${CLIENT_DOC_MAX_MB} MB limit.`))
      }
      next(ApiError.badRequest('Upload could not be read.'))
    })
  }).catch(next)
}

// POST /api/client-portal/:token/requests/:docId/upload — multipart `file`, optional `note`.
clientPortalPublicRouter.post('/client-portal/:token/requests/:docId/upload', portalUploadGate, handler(async (req, res) => {
  const link = res.locals.portalLink as PortalLink
  const { client } = link
  const doc = await prisma.clientDocument.findFirst({
    where: { id: req.params.docId, clientId: client.id, ...alive },
  })
  if (!doc) throw ApiError.notFound('This request is not available.')
  if (!OPEN_REQUEST_STATUSES.includes(doc.status)) {
    throw ApiError.conflict('not_requested', 'This document has already been received.')
  }

  const file = req.file
  if (!file) throw ApiError.badRequest('Choose a file to upload.', { file: 'Choose a file to upload.' })
  const ext = (file.originalname.split('.').pop() ?? '').toLowerCase()
  const mimeType = CLIENT_DOC_MIME[ext]
  if (!mimeType) {
    throw ApiError.unprocessable('file_type', `Allowed types: ${Object.keys(CLIENT_DOC_MIME).join(', ').toUpperCase()}.`)
  }
  // The extension is only a claim: the bytes must agree with it.
  if (!clientDocContentMatches(file.buffer, ext)) {
    throw ApiError.unprocessable('file_content', `This file's content does not match its .${ext} extension. Save it in its real format and upload again.`)
  }
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) || null : null

  const safe = file.originalname.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120)
  const key = `${client.id}/${doc.id}/${crypto.randomUUID()}-${safe}`
  await clientDocumentStorage.put(key, file.buffer)

  const version = await prisma.$transaction(async (tx) => {
    // (documentId, version) is unique: serialise uploads to one document.
    await lockSequence(tx, `client-doc-version:${doc.id}`)
    const fresh = await tx.clientDocument.findUniqueOrThrow({ where: { id: doc.id } })
    if (!OPEN_REQUEST_STATUSES.includes(fresh.status)) {
      throw ApiError.conflict('not_requested', 'This document has already been received.')
    }
    const prev = await tx.clientDocumentVersion.findFirst({ where: { documentId: doc.id }, orderBy: { version: 'desc' } })
    const n = Math.max(fresh.currentVersion, prev?.version ?? 0) + 1
    const v = await tx.clientDocumentVersion.create({
      data: {
        documentId: doc.id, version: n, fileKey: key, originalName: file.originalname, mimeType,
        sizeBytes: file.size, uploadedBy: 'portal', reviewStatus: 'uploaded', notes: note,
        previousVersionId: prev?.id ?? null,
      },
    })
    await tx.clientDocument.update({
      where: { id: doc.id }, data: { status: 'uploaded', currentVersion: n, updatedBy: null },
    })
    return v
  })

  // The client has no login: the link is the "who".
  await writeAudit({
    actorUserId: null, action: 'client_document.portal_upload', entityType: 'ClientDocument', entityId: doc.id,
    after: { via: 'client_portal', link_id: link.id, version: version.version, originalName: file.originalname, sizeBytes: file.size }, req,
  })
  try {
    await notifyEmployee(client.accountManagerId, {
      type: 'client_document.portal_upload', module: 'workstation',
      title: `Document received — ${client.companyName}`,
      body: `${doc.name} was uploaded by the client through their document link (v${version.version}). Review it.`,
      entityType: 'ClientDocument', entityId: doc.id, actionUrl: `/workstation/clients/${client.id}/documents`,
    })
  } catch { /* best effort: the upload itself has landed */ }

  ok(res, { id: doc.id, name: doc.name, status: 'uploaded', version: version.version }, 201)
}))

// ── Job status: read-only, client-facing fields only ──────────────────────

const SERVICE_DONE = ['completed', 'failed']
const COMPLIANCE_WINDOW_DAYS = 60
/** Recently missed items stay visible (as overdue) for this long; older ones are history. */
const OVERDUE_LOOKBACK_DAYS = 30

// GET /api/client-portal/:token/status
clientPortalPublicRouter.get('/client-portal/:token/status', handler(async (req, res) => {
  const link = await resolveToken(req.params.token)
  const { client } = link
  const today = istToday()
  const horizon = addDays(today, COMPLIANCE_WINDOW_DAYS)
  const lookback = addDays(today, -OVERDUE_LOOKBACK_DAYS)

  const [services, items, audits] = await Promise.all([
    prisma.clientService.findMany({
      where: { clientId: client.id, ...alive, status: { notIn: SERVICE_DONE } },
      include: { service: { select: { name: true } } },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    }),
    // Statutory due on or before the horizon: an extension only moves a date
    // later, so this catches every item whose effective due date is in range.
    prisma.complianceItem.findMany({
      where: { clientId: client.id, deletedAt: null, status: { notIn: ['filed', 'not_applicable'] }, dueDate: { lte: horizon } },
      orderBy: { dueDate: 'asc' },
    }),
    prisma.auditEngagement.findMany({
      where: { clientId: client.id, ...alive, status: { not: 'archived' } },
      orderBy: { createdAt: 'desc' },
    }),
  ])
  const ctx = await buildContext(prisma, client.organisationId, items, today)
  const compliance = items
    .map((i) => itemToApi(i, ctx))
    .filter((i) => i.due_date <= horizon && i.due_date >= lookback)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))
    .map((i) => ({
      id: i.id, form: i.form_name, form_code: i.form_code, period: i.period_label,
      due_date: i.due_date, status: i.status, overdue: i.overdue, days_left: i.days_left,
    }))

  res.setHeader('Cache-Control', 'private, no-store')
  ok(res, {
    services: services.map((s) => ({ id: s.id, name: s.service.name, status: s.status, due_date: s.dueDate })),
    compliance,
    audits: audits.map((a) => ({
      id: a.id, code: a.auditCode, title: a.title, financial_year: a.financialYear,
      audit_type: a.auditType, status: a.status, planned_report_date: a.plannedReportDate, report_date: a.reportDate,
    })),
    window_days: COMPLIANCE_WINDOW_DAYS,
    generated_at: new Date().toISOString(),
  })
}))
