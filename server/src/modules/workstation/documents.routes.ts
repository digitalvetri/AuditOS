import { Router } from 'express'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { writeActivity } from '../../platform/workstation/activity.js'
import { signedLink, verifyResourceToken } from '../../platform/signedUrl.js'
import {
  assertCanSeeClient, clientScopeWhere, requireWorkstation,
} from '../../platform/workstation/scope.js'
import {
  clientDocumentToApi, documentCategoryToApi, documentVersionToApi, employeeMap,
} from '../../api/workstation.serialize.js'
import { body, DOCUMENT_STATUSES, FieldErrors } from './validate.js'

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
 * There is no real file storage in this build (the same as HRMS documents
 * today): a version records its metadata and a `fileKey`, and the download
 * route serves a derived payload through a signed URL.
 */
documentsRouter.post('/:id/versions', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.manage')
  const b = body(req)

  const doc = await prisma.clientDocument.findFirst({ where: { id: req.params.id, ...alive }, include })
  if (!doc) throw ApiError.notFound('Document not found.')
  await assertCanSeeClient(session, scope, doc.clientId)

  const v = new FieldErrors()
  const notes = v.str('notes', b.notes, { required: false, max: 500 })
  const sizeBytes = typeof b.size_bytes === 'number' && b.size_bytes > 0 ? Math.round(b.size_bytes) : 52_000
  v.throwIfAny()

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.clientDocument.findUniqueOrThrow({ where: { id: doc.id } })
    const nextVersion = current.currentVersion + 1
    const previous = await tx.clientDocumentVersion.findFirst({
      where: { documentId: doc.id }, orderBy: { version: 'desc' }, select: { id: true },
    })
    await tx.clientDocumentVersion.create({
      data: {
        documentId: doc.id,
        version: nextVersion,
        fileKey: `workstation/${doc.clientId}/${doc.id}/v${nextVersion}`,
        uploadedBy: session.employeeId ?? session.userId,
        sizeBytes,
        notes: notes ?? null,
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

  const m = await employeeMap([
    updated.requestedByEmployeeId, updated.verifiedByEmployeeId, ...updated.versions.map((x) => x.uploadedBy),
  ])
  ok(res, clientDocumentToApi(updated, m), 201)
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

  const doc = await prisma.clientDocument.update({
    where: { id: before.id },
    data: {
      status: approve ? 'verified' : 'rejected',
      verifiedByEmployeeId: approve ? session.employeeId : null,
      verifiedAt: approve ? new Date() : null,
      rejectionReason: approve ? null : rejectionReason ?? null,
      updatedBy: session.userId,
    },
    include,
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
  verifyResourceToken(resource, typeof req.query.t === 'string' ? req.query.t : undefined)

  const version = await prisma.clientDocumentVersion.findFirst({
    where: { id: req.params.versionId },
    include: { document: { include: { client: true, category: true } } },
  })
  if (!version) throw ApiError.notFound('Version not found.')

  // No real object store in this build; the payload is derived from metadata
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
