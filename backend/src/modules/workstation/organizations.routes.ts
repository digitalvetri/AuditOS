import crypto from 'node:crypto'
import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { writeActivity } from '../../platform/workstation/activity.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'
import {
  loadOrganization, suggestChildName, visibleChildren,
} from '../../platform/workstation/organization.js'
import { activityToApi, clientToApi, employeeMap } from '../../api/workstation.serialize.js'
import {
  buildClientFolders, CLIENT_DOC_MAX_MB, CLIENT_DOC_MIME, clientDocContentMatches, clientDocumentStorage, ensureCategory, has,
} from './client-folders.routes.js'
import { mergeDocuments, sendMergedPdf } from './client-merge.routes.js'
import { scanUploads } from '../../platform/virusScan.js'

/**
 * ORGANIZATION VIEWS (on /api/clients, next to the client routes).
 *
 * An organization is a client; its own records stay on its own workspace.
 * These routes add what only makes sense across its clients:
 *
 *   GET  /:id/organization                      overview, aggregated live
 *   GET  /:id/organization/documents?type=      every document, org + clients
 *   POST /:id/organization/documents/merge      merge across clients
 *   POST /:id/organization/requests/:docId/receive
 *        a file received against an organization request, stored for the
 *        organization or one of its clients
 *
 * Nothing is copied up: every figure is computed from the child clients'
 * own records, and only from the children this caller may open.
 */
export const organizationsRouter = Router()

/** The document type filters, from folder keys (see client-folders.routes). */
export const ORG_DOC_TYPES = [
  { key: 'gst', label: 'GST' },
  { key: 'eway', label: 'E-Way Bill' },
  { key: 'einvoice', label: 'E-Invoice' },
  { key: 'tds', label: 'TDS' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'returns', label: 'Returns' },
  { key: 'other', label: 'Other' },
] as const
type DocType = (typeof ORG_DOC_TYPES)[number]['key']

function typesOf(folderKey: string): DocType[] {
  switch (folderKey) {
    case 'eway': return ['eway']
    case 'einvoice': return ['einvoice']
    case 'gst_returns': return ['gst', 'returns']
    case 'gstr2b': case 'purchase_registers': case 'uploads:gst': return ['gst']
    case 'tds_26as': case 'tds_books': case 'uploads:tds': return ['tds']
    case 'invoices': return ['invoices']
    default: return ['other']
  }
}

/** Where a new upload of each type lands in a client's folders. */
export const UPLOAD_FOLDER_FOR_TYPE: Record<DocType, string> = {
  gst: 'uploads:gst', eway: 'eway', einvoice: 'einvoice', tds: 'uploads:tds',
  invoices: 'invoices', returns: 'gst_returns', other: 'uploads:other',
}

const ACTIVE_SERVICE = ['documents_pending', 'in_progress', 'under_review', 'ready', 'submitted']

// GET /api/clients/:id/organization
organizationsRouter.get('/:id/organization', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.client.read', 'workstation.client.manage')
  const org = await loadOrganization(session, scope, req.params.id)
  const children = await visibleChildren(session, scope, org.id)
  const childIds = children.map((c) => c.id)
  const familyIds = [org.id, ...childIds]

  const canDocs = has(session, 'workstation.document.read', 'workstation.document.manage')
  const [services, docCounts, activities] = await Promise.all([
    prisma.clientService.findMany({
      where: { clientId: { in: childIds }, ...alive },
      select: { clientId: true, status: true, service: { select: { id: true, name: true } } },
    }),
    canDocs
      ? prisma.clientDocument.groupBy({ by: ['clientId'], where: { clientId: { in: familyIds }, ...alive }, _count: { _all: true } })
      : Promise.resolve([] as { clientId: string; _count: { _all: number } }[]),
    prisma.activity.findMany({
      where: { subjectType: 'client', subjectId: { in: familyIds } },
      orderBy: { createdAt: 'desc' }, take: 25,
    }),
  ])

  const docsBy = new Map(docCounts.map((d) => [d.clientId, d._count._all]))
  const nameOf = new Map([[org.id, org.companyName], ...children.map((c) => [c.id, c.companyName] as const)])

  // Per service: which clients take it. The service records are not merged.
  const byService = new Map<string, { service_id: string; name: string; client_ids: Set<string>; active: number; completed: number }>()
  for (const s of services) {
    const row = byService.get(s.service.id) ?? { service_id: s.service.id, name: s.service.name, client_ids: new Set<string>(), active: 0, completed: 0 }
    row.client_ids.add(s.clientId)
    if (s.status === 'completed') row.completed++
    else if (ACTIVE_SERVICE.includes(s.status)) row.active++
    byService.set(s.service.id, row)
  }

  const m = await employeeMap([org.accountManagerId, org.secondaryManagerId, ...children.flatMap((c) => [c.accountManagerId, c.secondaryManagerId]), ...activities.map((a) => a.actorEmployeeId)])
  const cards = children.map((c) => {
    const mine = services.filter((s) => s.clientId === c.id)
    return {
      ...clientToApi(c, m),
      service_names: [...new Set(mine.map((s) => s.service.name))],
      active_service_count: mine.filter((s) => ACTIVE_SERVICE.includes(s.status)).length,
      completed_service_count: mine.filter((s) => s.status === 'completed').length,
      service_count: mine.length,
      document_count: docsBy.get(c.id) ?? 0,
    }
  })

  ok(res, {
    organization: clientToApi(org, m),
    stats: {
      clients: children.length,
      active_clients: children.filter((c) => c.status !== 'inactive').length,
      inactive_clients: children.filter((c) => c.status === 'inactive').length,
      services: services.length,
      services_in_progress: services.filter((s) => ACTIVE_SERVICE.includes(s.status)).length,
      services_not_started: services.filter((s) => s.status === 'not_started').length,
      services_completed: services.filter((s) => s.status === 'completed').length,
      // null when the caller cannot read documents at all.
      documents: canDocs ? [...docsBy.values()].reduce((a, b) => a + b, 0) : null,
      organization_documents: canDocs ? (docsBy.get(org.id) ?? 0) : null,
    },
    services_by_type: [...byService.values()]
      .map((r) => ({
        service_id: r.service_id, name: r.name,
        client_count: r.client_ids.size, active: r.active, completed: r.completed,
        clients: [...r.client_ids].map((id) => ({ id, name: nameOf.get(id) ?? '' })),
      }))
      .sort((a, b) => b.client_count - a.client_count || a.name.localeCompare(b.name)),
    clients: cards,
    recent_activity: activities.map((a) => ({
      ...activityToApi(a, m),
      client_id: a.subjectId,
      client_name: nameOf.get(a.subjectId) ?? null,
      is_organization_level: a.subjectId === org.id,
    })),
    next_client_name: await suggestChildName(org),
  })
}))

// GET /api/clients/:id/organization/documents?type=eway
organizationsRouter.get('/:id/organization/documents', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.read', 'workstation.document.manage')
  const org = await loadOrganization(session, scope, req.params.id)
  const children = await visibleChildren(session, scope, org.id)
  const type = typeof req.query.type === 'string' && req.query.type !== 'all' ? req.query.type : null

  const family = [org, ...children]
  const perClient = await Promise.all(family.map(async (c) => ({ c, folders: await buildClientFolders(session, c) })))

  const rows = perClient.flatMap(({ c, folders }) => folders.flatMap((f) => f.items.map((it) => ({
    ...it,
    // The owner is never lost: every row names the client it belongs to.
    client_id: c.id,
    client_name: c.companyName,
    client_code: c.clientCode,
    is_organization_level: c.id === org.id,
    folder_key: f.key,
    folder_label: f.label,
    types: typesOf(f.key),
  }))))

  const counts: Record<string, number> = { all: rows.length }
  for (const t of ORG_DOC_TYPES) counts[t.key] = rows.filter((r) => r.types.includes(t.key)).length

  const shown = (type ? rows.filter((r) => r.types.includes(type as DocType)) : rows)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  const m = await employeeMap(shown.map((r) => r.uploaded_by_id ?? null))

  ok(res, {
    organization: { id: org.id, name: org.companyName, client_id: org.clientCode },
    clients: family.map((c) => ({ id: c.id, name: c.companyName, client_id: c.clientCode, is_organization: c.id === org.id })),
    types: ORG_DOC_TYPES,
    counts,
    items: shown.map((r) => ({ ...r, uploaded_by: r.uploaded_by_id ? (m.get(r.uploaded_by_id)?.full_name ?? null) : null })),
    can_upload: has(session, 'workstation.document.manage'),
  })
}))

const MergeBody = z.object({
  items: z.array(z.object({
    client_id: z.string().min(1).max(100), source: z.string().min(1).max(40), ref: z.string().min(1).max(100),
  })).min(2, 'Choose at least two documents to merge.').max(50, 'Merge at most 50 documents at a time.'),
  title: z.string().trim().max(200).optional(),
  /** true → save into Organization Documents (and return it); false → download. */
  store: z.boolean().optional(),
})

// POST /api/clients/:id/organization/documents/merge
organizationsRouter.post('/:id/organization/documents/merge', handler(async (req, res) => {
  const session = requireSession(req)
  const parsed = MergeBody.safeParse(req.body)
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid request.')
  const store = parsed.data.store === true
  const scope = store
    ? requireWorkstation(session, 'workstation.document.manage')
    : requireWorkstation(session, 'workstation.document.read', 'workstation.document.manage')
  const org = await loadOrganization(session, scope, req.params.id)
  const children = await visibleChildren(session, scope, org.id)

  // Each item must belong to this organization or a client the caller can open.
  const family = new Map([[org.id, org], ...children.map((c) => [c.id, c] as const)])
  for (const it of parsed.data.items) {
    if (!family.has(it.client_id)) throw ApiError.forbidden('One of the documents is not in this organization.')
  }

  const title = parsed.data.title || 'Consolidated documents'
  const fullTitle = `${org.companyName} - ${title}`
  const { bytes, pageCount, skipped } = await mergeDocuments(
    session, parsed.data.items.map((it) => ({ clientId: it.client_id, source: it.source, ref: it.ref })), fullTitle,
  )
  const sourceClients = [...new Set(parsed.data.items.map((it) => it.client_id))].map((id) => family.get(id)!.companyName)
  const audit = { items: parsed.data.items, pages: pageCount, skipped, stored: store }

  if (!store) {
    await writeAudit({ actorUserId: session.userId, action: 'organization.documents_merged', entityType: 'Client', entityId: org.id, after: audit, req })
    return sendMergedPdf(res, bytes, `${fileSafe(fullTitle)}.pdf`, skipped)
  }

  // Saved as a NEW document on the organization; the originals are untouched.
  const category = await ensureCategory(org.organisationId, 'consolidated')
  if (!category) throw new ApiError(500, 'category_missing', 'Could not prepare the Consolidated folder.')
  const docId = crypto.randomUUID()
  const fileName = `${fileSafe(fullTitle)}.pdf`
  // Storage keys take no spaces; the readable name stays on the version.
  const key = `${org.id}/${docId}/${crypto.randomUUID()}-${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}`
  await clientDocumentStorage.put(key, bytes)
  const notes = `Merged from ${parsed.data.items.length} documents: ${sourceClients.join(', ')}.`
  const [doc] = await prisma.$transaction([
    prisma.clientDocument.create({
      data: { id: docId, clientId: org.id, categoryId: category.id, name: fullTitle, status: 'uploaded', currentVersion: 1, createdBy: session.userId },
    }),
    prisma.clientDocumentVersion.create({
      data: {
        documentId: docId, version: 1, fileKey: key, originalName: fileName, mimeType: 'application/pdf',
        sizeBytes: bytes.length, uploadedBy: session.employeeId ?? session.userId, reviewStatus: 'uploaded', notes,
      },
    }),
  ])
  await writeActivity({
    session, subjectType: 'client', subjectId: org.id, action: 'organization.documents_merged',
    description: `${title} saved to Organization Documents — ${notes}`,
    entityType: 'ClientDocument', entityId: doc.id, meta: { sources: parsed.data.items, pages: pageCount, skipped },
  })
  await writeAudit({ actorUserId: session.userId, action: 'organization.documents_merged', entityType: 'ClientDocument', entityId: doc.id, after: audit, req })
  ok(res, { document_id: doc.id, name: doc.name, pages: pageCount, skipped, source_clients: sourceClients }, 201)
}))

const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150) || 'documents'

const receiveUpload = () => multer({ storage: multer.memoryStorage(), limits: { fileSize: CLIENT_DOC_MAX_MB * 1024 * 1024, files: 1 } })

/**
 * POST /api/clients/:id/organization/requests/:docId/receive
 * multipart: file, client_id (the organization itself, or one of its clients)
 *
 * The request stays on the organization. Stored for the organization, the
 * file becomes the request's next version. Stored for a client, it becomes
 * that client's own document (linked back by sourceRequestId) and the
 * request is marked received — the file is never kept in both places.
 */
organizationsRouter.post('/:id/organization/requests/:docId/receive', (req, res, next) => {
  receiveUpload().single('file')(req, res, (err: unknown) => {
    if (!err) return scanUploads(req, res, next)
    if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
      return next(ApiError.unprocessable('too_large', `File is larger than the ${CLIENT_DOC_MAX_MB} MB limit.`))
    }
    next(ApiError.badRequest('Upload could not be read.'))
  })
}, handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.manage')
  const org = await loadOrganization(session, scope, req.params.id)

  const request = await prisma.clientDocument.findFirst({ where: { id: req.params.docId, clientId: org.id, ...alive }, include: { category: true } })
  if (!request) throw ApiError.notFound('Request not found on this organization.')

  const file = req.file
  if (!file) throw ApiError.badRequest('Choose a file to upload.', { file: 'Choose a file to upload.' })
  const ext = (file.originalname.split('.').pop() ?? '').toLowerCase()
  const mimeType = CLIENT_DOC_MIME[ext]
  if (!mimeType) throw ApiError.unprocessable('file_type', `Allowed types: ${Object.keys(CLIENT_DOC_MIME).join(', ').toUpperCase()}.`)
  // The extension is only a claim: the bytes must agree with it (same check as client-folders).
  if (!clientDocContentMatches(file.buffer, ext)) {
    throw ApiError.unprocessable('file_content', `This file's content does not match its .${ext} extension. Re-save it in its real format and upload again.`)
  }

  const targetId = typeof req.body?.client_id === 'string' && req.body.client_id ? req.body.client_id : org.id
  let target = org
  if (targetId !== org.id) {
    const child = (await visibleChildren(session, scope, org.id)).find((c) => c.id === targetId)
    if (!child) throw ApiError.forbidden('That client is not in this organization.')
    target = child
  }

  const safe = file.originalname.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120)
  const uploader = session.employeeId ?? session.userId

  if (target.id === org.id) {
    const version = request.currentVersion + 1
    const key = `${org.id}/${request.id}/${crypto.randomUUID()}-${safe}`
    await clientDocumentStorage.put(key, file.buffer)
    await prisma.$transaction([
      prisma.clientDocumentVersion.create({
        data: { documentId: request.id, version, fileKey: key, originalName: file.originalname, mimeType, sizeBytes: file.size, uploadedBy: uploader, reviewStatus: 'uploaded' },
      }),
      prisma.clientDocument.update({ where: { id: request.id }, data: { currentVersion: version, status: 'uploaded', updatedBy: session.userId } }),
    ])
    await writeActivity({
      session, subjectType: 'client', subjectId: org.id, action: 'document.uploaded',
      description: `${request.name} received and stored in Organization Documents (v${version}).`,
      entityType: 'ClientDocument', entityId: request.id,
    })
    return ok(res, { document_id: request.id, stored_for: { client_id: org.id, client_name: org.companyName } }, 201)
  }

  const docId = crypto.randomUUID()
  const key = `${target.id}/${docId}/${crypto.randomUUID()}-${safe}`
  await clientDocumentStorage.put(key, file.buffer)
  await prisma.$transaction([
    prisma.clientDocument.create({
      data: {
        id: docId, clientId: target.id, categoryId: request.categoryId, name: request.name,
        financialYear: request.financialYear, status: 'uploaded', currentVersion: 1,
        sourceRequestId: request.id, createdBy: session.userId,
      },
    }),
    prisma.clientDocumentVersion.create({
      data: {
        documentId: docId, version: 1, fileKey: key, originalName: file.originalname, mimeType, sizeBytes: file.size,
        uploadedBy: uploader, reviewStatus: 'uploaded', notes: `Received against ${org.companyName}'s request "${request.name}".`,
      },
    }),
    prisma.clientDocument.update({ where: { id: request.id }, data: { status: 'uploaded', updatedBy: session.userId } }),
  ])
  await writeActivity({
    session, subjectType: 'client', subjectId: org.id, action: 'organization.request_received',
    description: `${request.name} received — stored under ${target.companyName}.`,
    entityType: 'ClientDocument', entityId: docId,
  })
  await writeActivity({
    session, subjectType: 'client', subjectId: target.id, action: 'document.uploaded',
    description: `${request.name} received through ${org.companyName}'s request.`,
    entityType: 'ClientDocument', entityId: docId,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'organization.request_received', entityType: 'ClientDocument', entityId: docId,
    after: { requestId: request.id, organizationId: org.id, clientId: target.id, originalName: file.originalname, sizeBytes: file.size }, req,
  })
  ok(res, { document_id: docId, stored_for: { client_id: target.id, client_name: target.companyName } }, 201)
}))
