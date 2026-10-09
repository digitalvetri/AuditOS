import crypto from 'node:crypto'
import { Router } from 'express'
import multer from 'multer'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { writeActivity } from '../../platform/workstation/activity.js'
import { notifyEmployees } from '../../platform/notify.js'
import { isSoleActiveEmployee } from '../../platform/makerChecker.js'
import { signedLink, verifyResourceToken } from '../../platform/signedUrl.js'
import { mailConfigured, MailError, sendMail } from '../../lib/mailer.js'
import {
  assertCanSeeClient, clientScopeWhere, requireWorkstation,
} from '../../platform/workstation/scope.js'
import {
  clientDocumentToApi, documentCategoryToApi, documentVersionToApi, employeeMap,
} from '../../api/workstation.serialize.js'
import { body, DOCUMENT_STATUSES, FieldErrors } from './validate.js'
import {
  CLIENT_DOC_MAX_MB, CLIENT_DOC_MIME, clientDocumentStorage, readVersionBytes, sendFile,
} from './client-folders.routes.js'
import { scanUploads } from '../../platform/virusScan.js'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: CLIENT_DOC_MAX_MB * 1024 * 1024, files: 1 } })

/**
 * DOCUMENTS (AUDIT_OS_WORKSTATION.md §7.6).
 *
 * Client-centric: a document always belongs to a client, and `clientServiceId`
 * is a tag rather than an owner (§3). Creation lives on
 * `POST /api/clients/:id/documents` because that is where the client id comes
 * from; everything after creation lives here.
 *
 * Versions are append-only — v1 → v2 → v3, never an overwrite (§10.6).
 */
export const documentsRouter = Router()
export const documentCategoriesRouter = Router()

const include = { category: true, client: true, versions: { orderBy: { version: 'asc' as const } } }

// GET /api/document-categories
documentCategoriesRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.access')
  const rows = await prisma.documentCategory.findMany({ where: alive, orderBy: { sortOrder: 'asc' } })
  ok(res, { items: rows.map(documentCategoryToApi), count: rows.length })
}))

// GET /api/documents — cross-client list, scoped
documentsRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.read', 'workstation.document.manage')

  const categoryId = typeof req.query.category_id === 'string' ? req.query.category_id : null
  const status = typeof req.query.status === 'string' ? req.query.status : null
  const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : null
  const fy = typeof req.query.financial_year === 'string' ? req.query.financial_year : null

  const rows = await prisma.clientDocument.findMany({
    where: {
      ...alive,
      ...(await clientScopeWhere(session, scope)),
      ...(categoryId ? { categoryId } : {}),
      ...(status ? { status } : {}),
      ...(clientId ? { clientId } : {}),
      ...(fy ? { financialYear: fy } : {}),
    },
    include,
    orderBy: [{ clientId: 'asc' }, { categoryId: 'asc' }, { name: 'asc' }],
  })

  const m = await employeeMap([
    ...rows.map((r) => r.requestedByEmployeeId),
    ...rows.map((r) => r.verifiedByEmployeeId),
    ...rows.flatMap((r) => r.versions.map((v) => v.uploadedBy)),
  ])
  ok(res, { items: rows.map((r) => clientDocumentToApi(r, m)), count: rows.length, scope })
}))

// GET /api/documents/:id
documentsRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.read', 'workstation.document.manage')
  const doc = await prisma.clientDocument.findFirst({ where: { id: req.params.id, ...alive }, include })
  if (!doc) throw ApiError.notFound('Document not found.')
  await assertCanSeeClient(session, scope, doc.clientId)

  const m = await employeeMap([
    doc.requestedByEmployeeId, doc.verifiedByEmployeeId, ...doc.versions.map((v) => v.uploadedBy),
  ])
  ok(res, clientDocumentToApi(doc, m))
}))

// PATCH /api/documents/:id
documentsRouter.patch('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.manage')
  const b = body(req)

  const before = await prisma.clientDocument.findFirst({ where: { id: req.params.id, ...alive }, include })
  if (!before) throw ApiError.notFound('Document not found.')
  await assertCanSeeClient(session, scope, before.clientId)

  const v = new FieldErrors()
  const data: Record<string, unknown> = {}
  if ('name' in b) data.name = v.str('name', b.name, { max: 200 })
  if ('category_id' in b) data.categoryId = v.str('category_id', b.category_id)
  if ('financial_year' in b) data.financialYear = v.str('financial_year', b.financial_year, { required: false, max: 12 }) ?? null
  if ('client_service_id' in b) data.clientServiceId = v.str('client_service_id', b.client_service_id, { required: false }) ?? null
  if ('status' in b) {
    const s = v.oneOf('status', b.status, DOCUMENT_STATUSES)
    // Verifying and rejecting are supervisory acts with their own permission
    // (§6) and their own endpoint — they are not reachable through a PATCH.
    if (s === 'verified' || s === 'rejected') {
      v.add('status', 'Use the verify action to verify or reject a document.')
    } else {
      data.status = s
    }
  }
  v.throwIfAny()
  data.updatedBy = session.userId

  const doc = await prisma.clientDocument.update({ where: { id: before.id }, data, include })
  await writeActivity({
    session, subjectType: 'client', subjectId: doc.clientId,
    action: 'document.updated', description: `${doc.name} updated.`,
    entityType: 'ClientDocument', entityId: doc.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'client_document.update',
    entityType: 'ClientDocument', entityId: doc.id, before, after: doc, req,
  })

  const m = await employeeMap([doc.requestedByEmployeeId, doc.verifiedByEmployeeId, ...doc.versions.map((x) => x.uploadedBy)])
  ok(res, clientDocumentToApi(doc, m))
}))

/**
 * POST /api/documents/:id/versions — a new version, never an overwrite.
 *
 * Multipart only: the version carries the real file (422 without one). The
 * uploader is always the signed-in employee and the time the server's.
 */
documentsRouter.post('/:id/versions', (req, res, next) => {
  // Multipart carries the file; a JSON body is refused below (no file).
  if (!req.is('multipart/form-data')) return next()
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return scanUploads(req, res, next)
    if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
      return next(ApiError.unprocessable('too_large', `File is larger than the ${CLIENT_DOC_MAX_MB} MB limit.`))
    }
    next(ApiError.badRequest('Upload could not be read.'))
  })
}, handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.manage')
  // Multipart text fields (or an empty JSON body) — the file check below
  // decides, not the body's shape.
  const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>

  const doc = await prisma.clientDocument.findFirst({ where: { id: req.params.id, ...alive }, include })
  if (!doc) throw ApiError.notFound('Document not found.')
  await assertCanSeeClient(session, scope, doc.clientId)

  // A version IS a file. A metadata-only version (the old JSON path) proved
  // nothing was ever received, so it is no longer accepted. Older
  // metadata-only versions already on record still read and download.
  if (!req.file) throw ApiError.unprocessable('file_required', 'Attach the file.', { file: 'Attach the file.' })

  const v = new FieldErrors()
  const notes = v.str('notes', b.notes, { required: false, max: 500 })

  // The version number may be given (e.g. a re-issued certificate filed as
  // v3). Who uploaded it and when are NOT taken from the browser — they are
  // the signed-in employee and the server clock, so evidence cannot be
  // backdated or attributed to someone else. A date the user enters is the
  // date printed on the document, kept separately as `documentDate`.
  let requestedVersion: number | null = null
  if (b.version !== undefined && b.version !== null && b.version !== '') {
    const n = Number(b.version)
    if (!Number.isInteger(n) || n < 1 || n > 999) v.add('version', 'Version must be a whole number from 1 to 999.')
    else if (n <= doc.currentVersion) v.add('version', `This document is already at v${doc.currentVersion}; the new version must be higher.`)
    else requestedVersion = n
  }
  let documentDate: string | null = null
  if (b.document_date !== undefined && b.document_date !== null && b.document_date !== '') {
    const wellFormed = typeof b.document_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.document_date)
    const d = wellFormed ? new Date(`${b.document_date}T00:00:00Z`) : null
    if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== b.document_date) v.add('document_date', 'Enter a valid date.')
    else if (d.getTime() > Date.now() + 24 * 3600 * 1000) v.add('document_date', 'The document date cannot be in the future.')
    else documentDate = b.document_date as string
  }
  v.throwIfAny()

  // The original file — stored before the version row so a failed write never
  // leaves a version pointing at nothing.
  const ext = (req.file.originalname.split('.').pop() ?? '').toLowerCase()
  const mimeType = CLIENT_DOC_MIME[ext]
  if (!mimeType) {
    throw ApiError.unprocessable('file_type', `Allowed types: ${Object.keys(CLIENT_DOC_MIME).join(', ').toUpperCase()}.`)
  }
  const safe = req.file.originalname.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120)
  const key = `${doc.clientId}/${doc.id}/${crypto.randomUUID()}-${safe}`
  await clientDocumentStorage.put(key, req.file.buffer)
  const stored = { key, originalName: req.file.originalname, mimeType, size: req.file.size }

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.clientDocument.findUniqueOrThrow({ where: { id: doc.id } })
    const nextVersion = requestedVersion ?? current.currentVersion + 1
    const previous = await tx.clientDocumentVersion.findFirst({
      where: { documentId: doc.id }, orderBy: { version: 'desc' }, select: { id: true },
    })
    await tx.clientDocumentVersion.create({
      data: {
        documentId: doc.id,
        version: nextVersion,
        fileKey: stored.key,
        originalName: stored.originalName,
        mimeType: stored.mimeType,
        uploadedBy: session.employeeId ?? session.userId,
        sizeBytes: stored.size,
        notes: notes ?? null,
        documentDate,
        reviewStatus: 'uploaded',
        previousVersionId: previous?.id ?? null,
      },
    })
    return tx.clientDocument.update({
      where: { id: doc.id },
      // A newly uploaded version resets the document to "uploaded" — a
      // previously verified document is no longer verified once it changes.
      data: { currentVersion: nextVersion, status: 'uploaded', verifiedByEmployeeId: null, verifiedAt: null, updatedBy: session.userId },
      include,
    })
  })

  await writeActivity({
    session, subjectType: 'client', subjectId: updated.clientId,
    action: 'document.uploaded',
    description: `${updated.name} uploaded (v${updated.currentVersion}).`,
    entityType: 'ClientDocument', entityId: updated.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'client_document.version',
    entityType: 'ClientDocument', entityId: updated.id, after: { version: updated.currentVersion }, req,
  })
  // Only when it answers an open request (or replaces a rejected file) —
  // not on every routine version an employee files themselves.
  if (doc.status === 'requested' || doc.status === 'rejected') {
    await notifyEmployees([updated.requestedByEmployeeId, updated.client.accountManagerId], {
      type: 'document.uploaded', module: 'document',
      title: `Document uploaded — ${updated.name}`,
      body: `${updated.client.companyName} · v${updated.currentVersion} ready to verify`,
      entityType: 'ClientDocument', entityId: updated.id,
      actionUrl: `/workstation/clients/${updated.clientId}/documents`,
    }, session)
  }

  const m = await employeeMap([
    updated.requestedByEmployeeId, updated.verifiedByEmployeeId, ...updated.versions.map((x) => x.uploadedBy),
  ])
  ok(res, clientDocumentToApi(updated, m), 201)
}))

/**
 * POST /api/client-documents/:id/send-request — ask the client for this
 * document by email or WhatsApp.
 *
 *   { channel: 'email', to: [..], subject, message } → sent by the server (SMTP)
 *   { channel: 'whatsapp', to, message }             → logged only; the browser
 *     opens WhatsApp with the message typed in, since a free-form WhatsApp
 *     message cannot be sent server-side without the Business API.
 *
 * Either way the request lands in the client's activity trail.
 */
documentsRouter.post('/:id/send-request', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.manage')
  const b = body(req)

  const doc = await prisma.clientDocument.findFirst({ where: { id: req.params.id, ...alive }, include: { client: true } })
  if (!doc) throw ApiError.notFound('Document not found.')
  await assertCanSeeClient(session, scope, doc.clientId)

  const channel = b.channel === 'email' || b.channel === 'whatsapp' ? b.channel : null
  if (!channel) throw ApiError.badRequest('Choose email or WhatsApp.')
  const message = typeof b.message === 'string' ? b.message.slice(0, 5000) : ''
  if (!message.trim()) throw ApiError.badRequest('Write the message to send.', { message: 'Write the message to send.' })

  let to: string[]
  if (channel === 'email') {
    to = (Array.isArray(b.to) ? b.to : [b.to]).filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
    if (to.length === 0 || to.some((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))) {
      throw ApiError.badRequest('Enter a valid email address.', { to: 'Enter a valid email address.' })
    }
    const subject = typeof b.subject === 'string' && b.subject.trim() ? b.subject.trim().slice(0, 250) : `Document required: ${doc.name}`
    if (b.via !== 'mail_app') {
      if (!mailConfigured()) {
        throw new ApiError(503, 'mail_not_configured', 'Email is not configured on the server. Add SMTP_HOST, SMTP_USER and SMTP_PASS to backend/.env.')
      }
      try {
        await sendMail({ to, replyTo: session.email, subject, text: message })
      } catch (e) {
        if (e instanceof MailError) throw new ApiError(502, 'mail_failed', e.message)
        throw e
      }
    }
  } else {
    to = [typeof b.to === 'string' ? b.to.trim().slice(0, 30) : '']
  }

  // A request that goes out moves a not-yet-asked document to "requested".
  if (doc.status === 'pending') {
    await prisma.clientDocument.update({
      where: { id: doc.id },
      data: { status: 'requested', requestedAt: new Date(), requestedByEmployeeId: session.employeeId ?? null, updatedBy: session.userId },
    })
  }

  const via = channel === 'email' ? (b.via === 'mail_app' ? 'email (mail app)' : 'email') : 'WhatsApp'
  await writeActivity({
    session, subjectType: 'client', subjectId: doc.clientId,
    action: 'document.request_sent',
    description: `Requested ${doc.name} from the client by ${via} (${to.join(', ')}).`,
    entityType: 'ClientDocument', entityId: doc.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'client_document.request_sent',
    entityType: 'ClientDocument', entityId: doc.id, after: { channel, via, to }, req,
  })
  ok(res, { sent: channel === 'email' && b.via !== 'mail_app', logged: true, channel, to })
}))

// POST /api/documents/:id/verify — verify or reject (supervisory, §6)
documentsRouter.post('/:id/verify', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.verify')
  const b = body(req)

  const before = await prisma.clientDocument.findFirst({ where: { id: req.params.id, ...alive }, include })
  if (!before) throw ApiError.notFound('Document not found.')
  await assertCanSeeClient(session, scope, before.clientId)

  const v = new FieldErrors()
  const approve = b.approve !== false
  const rejectionReason = approve ? undefined : v.str('rejection_reason', b.rejection_reason, { max: 500 })
  v.throwIfAny()

  if (before.currentVersion === 0) {
    throw ApiError.unprocessable(
      'nothing_to_verify',
      'This document has no uploaded version yet, so there is nothing to verify.',
    )
  }

  const current = before.versions.find((x) => x.version === before.currentVersion)
  // Maker-checker: whoever filed this version does not also sign it off —
  // unless they are the only active employee, with nobody else to ask.
  // (Older versions recorded the user id when the uploader had no employee.)
  if (approve && current && current.uploadedBy !== 'portal'
    && (current.uploadedBy === session.employeeId || current.uploadedBy === session.userId)
    && !(await isSoleActiveEmployee(session.userId))) {
    throw ApiError.forbidden('You uploaded this version, so someone else must verify it.')
  }

  const now = new Date()
  const doc = await prisma.$transaction(async (tx) => {
    if (current) {
      await tx.clientDocumentVersion.update({
        where: { id: current.id },
        data: {
          reviewStatus: approve ? 'verified' : 'rejected',
          reviewedByEmployeeId: session.employeeId ?? null,
          reviewedAt: now,
          reviewNote: approve ? null : rejectionReason ?? null,
        },
      })
    }
    return tx.clientDocument.update({
      where: { id: before.id },
      data: {
        status: approve ? 'verified' : 'rejected',
        verifiedByEmployeeId: approve ? session.employeeId : null,
        verifiedAt: approve ? now : null,
        rejectionReason: approve ? null : rejectionReason ?? null,
        updatedBy: session.userId,
      },
      include,
    })
  })

  await writeActivity({
    session, subjectType: 'client', subjectId: doc.clientId,
    action: approve ? 'document.verified' : 'document.rejected',
    description: approve ? `${doc.name} verified.` : `${doc.name} rejected — ${doc.rejectionReason ?? ''}`.trim(),
    entityType: 'ClientDocument', entityId: doc.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: approve ? 'client_document.verify' : 'client_document.reject',
    entityType: 'ClientDocument', entityId: doc.id, before, after: doc, req,
  })
  const latest = doc.versions.find((x) => x.version === doc.currentVersion)
  await notifyEmployees([doc.requestedByEmployeeId, doc.client.accountManagerId, latest?.uploadedBy], {
    type: approve ? 'document.verified' : 'document.rejected', module: 'document',
    title: approve ? `Document verified — ${doc.name}` : `Document rejected — ${doc.name}`,
    body: approve
      ? doc.client.companyName
      : `${doc.client.companyName} · needs a re-upload${doc.rejectionReason ? `. Reason: ${doc.rejectionReason}` : ''}`,
    entityType: 'ClientDocument', entityId: doc.id,
    actionUrl: `/workstation/clients/${doc.clientId}/documents`,
  }, session)

  const m = await employeeMap([doc.requestedByEmployeeId, doc.verifiedByEmployeeId, ...doc.versions.map((x) => x.uploadedBy)])
  ok(res, clientDocumentToApi(doc, m))
}))

/**
 * GET /api/documents/:id/versions/:version/link — mint a short-lived link.
 * The HMAC binds resource + user + expiry (§9); the download route below
 * verifies it, which is what lets a plain browser navigation fetch the file.
 */
documentsRouter.get('/:id/versions/:version/link', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.read', 'workstation.document.manage')

  const doc = await prisma.clientDocument.findFirst({ where: { id: req.params.id, ...alive } })
  if (!doc) throw ApiError.notFound('Document not found.')
  await assertCanSeeClient(session, scope, doc.clientId)

  const version = await prisma.clientDocumentVersion.findFirst({
    where: { documentId: doc.id, version: Number(req.params.version) },
  })
  if (!version) throw ApiError.notFound('Version not found.')

  const resource = `workstation-document:${version.id}`
  await writeAudit({
    actorUserId: session.userId, action: 'link.issue', entityType: 'ClientDocument', entityId: doc.id,
    after: { version_id: version.id, version: version.version }, req,
  })
  ok(res, {
    ...signedLink(`/api/workstation-documents/${version.id}/download`, resource, session.userId),
    version: documentVersionToApi(version, await employeeMap([version.uploadedBy])),
  })
}))

/**
 * Public (signed) download. Mounted before `authenticate` in app.ts — the
 * HMAC in the query string IS the authorization, exactly as the payslip and
 * HRMS-document downloads already work.
 */
export const workstationSignedRouter = Router()

workstationSignedRouter.get('/workstation-documents/:versionId/download', handler(async (req, res) => {
  const resource = `workstation-document:${req.params.versionId}`
  const subject = verifyResourceToken(resource, typeof req.query.t === 'string' ? req.query.t : undefined)
  await writeAudit({
    actorUserId: subject, action: 'document.download', entityType: 'ClientDocumentVersion', entityId: req.params.versionId,
    after: { via: 'signed_link' }, req,
  })

  const version = await prisma.clientDocumentVersion.findFirst({
    where: { id: req.params.versionId },
    include: { document: { include: { client: true, category: true } } },
  })
  if (!version) throw ApiError.notFound('Version not found.')

  // Versions uploaded with real bytes (TDS receipts, partnership filings…)
  // are served as-is — inline, so they open in the browser, unless ?download=1.
  if (version.mimeType) {
    const bytes = await readVersionBytes(version.fileKey)
    if (bytes) {
      sendFile(res, bytes, version.originalName ?? `${version.document.name}.v${version.version}`,
        version.mimeType, req.query.download === '1')
      return
    }
  }

  // Metadata-only versions have no bytes; the payload is derived from metadata
  // so the demo produces a genuine download rather than a fake button.
  const doc = version.document
  const payload = [
    'AUDIT OS · WORKSTATION — CLIENT DOCUMENT',
    '',
    `Client:      ${doc.client.clientCode} · ${doc.client.companyName}`,
    `Category:    ${doc.category.name}`,
    `Document:    ${doc.name}`,
    `Version:     v${version.version}`,
    `Uploaded by: ${version.uploadedBy === 'portal' ? 'Client Portal' : version.uploadedBy}`,
    `Uploaded at: ${version.uploadedAt.toISOString()}`,
    `File key:    ${version.fileKey}`,
    '',
    'This is a generated placeholder. No document storage is configured in',
    'this build — the metadata, versioning and signed-URL path are real.',
  ].join('\n')

  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${doc.name.replace(/[^\w.\-]/g, '_')}.v${version.version}.txt"`)
  res.send(payload)
}))
