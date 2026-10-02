import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { verifyResourceToken } from '../../platform/signedUrl.js'
import { getTool, TOOLS, TOOL_CATEGORIES, TOOL_GROUPS, type ToolDef } from './registry.js'
import { extensionOf, headerFilename, sanitizeFilename, sniffMime } from './lib/files.js'
import { DocumentService } from './services/DocumentService.js'
import { ToolJobService } from './services/ToolJobService.js'
import { AuditLogService } from './services/AuditLogService.js'
import { PDFService } from './services/tools/PDFService.js'
import { ExcelService } from './services/tools/ExcelService.js'
import { ImageService } from './services/tools/ImageService.js'
import { CSVService } from './services/tools/CSVService.js'
import { enqueue, isImplemented } from './runner.js'
import { toolDocumentToApi, toolJobToApi } from './serialize.js'
import { prisma } from '../../lib/prisma.js'

/**
 * TOOLS HTTP SURFACE.
 *
 *   GET  /api/tools                          registry + what this caller may use
 *   POST /api/tools/uploads?tool_id=…        multipart; validates type, magic bytes, size, count
 *   POST /api/tools/:toolId/jobs             { input_document_ids, options } → 202 job
 *   GET  /api/tool-jobs/:id                  poll
 *   GET  /api/tool-documents                 list (scoped) + filters
 *   GET  /api/tool-documents/:id             detail: source, jobs, audit trail
 *   GET  /api/tool-documents/:id/link        signed download / inline link (audited)
 *   GET  /api/tool-documents/:id/preview     xlsx rows / text / csv detection
 *   GET  /api/tool-documents/:id/pages       page count + thumbnail links (PDF)
 *   DELETE /api/tool-documents/:id
 *
 * Signed (mounted before `authenticate`, the HMAC is the authorization):
 *   GET  /api/tool-documents/:id/download?t=…[&inline=1]
 *   GET  /api/tool-documents/:id/thumbs/:page?t=…
 */
export const toolsRouter = Router()
export const toolJobsRouter = Router()
export const toolDocumentsRouter = Router()
export const toolsSignedRouter = Router()

const HARD_MAX_MB = 50
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: HARD_MAX_MB * 1024 * 1024, files: 40 },
})

function requireTools(session: Session) {
  if (!can(session, 'tools.access', 'self')) throw ApiError.forbidden('You do not have access to Tools.')
}

function requireTool(session: Session, toolId: string): ToolDef {
  requireTools(session)
  const tool = getTool(toolId)
  if (!tool) throw ApiError.notFound('No such tool.')
  if (!can(session, tool.permission, 'self')) throw ApiError.forbidden(`You do not have permission to use ${tool.name}.`)
  return tool
}

// ── Registry ─────────────────────────────────────────────────────────────
toolsRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  requireTools(session)
  ok(res, {
    categories: TOOL_CATEGORIES,
    groups: TOOL_GROUPS,
    tools: TOOLS.map((t) => ({
      id: t.id, status: t.status, permitted: can(session, t.permission, 'self'), implemented: isImplemented(t.id),
      accepts: t.accepts, extensions: t.extensions, max_file_size_mb: t.maxFileSizeMB, multiple: t.multiple, output_type: t.outputType,
    })),
  })
}))

// ── Upload ───────────────────────────────────────────────────────────────
toolsRouter.post('/uploads', (req, res, next) => {
  upload.array('files', 40)(req, res, (err: unknown) => {
    if (!err) return next()
    const code = (err as { code?: string }).code
    if (code === 'LIMIT_FILE_SIZE') return next(ApiError.unprocessable('too_large', `File is larger than the ${HARD_MAX_MB} MB limit.`))
    if (code === 'LIMIT_FILE_COUNT') return next(ApiError.unprocessable('too_many', 'Too many files in one upload.'))
    next(ApiError.badRequest('Upload could not be read.'))
  })
}, handler(async (req, res) => {
  const session = requireSession(req)
  const toolId = typeof req.query.tool_id === 'string' ? req.query.tool_id : String(req.body?.tool_id ?? '')
  const tool = requireTool(session, toolId)
  if (tool.status !== 'active') throw ApiError.unprocessable('coming_soon', `${tool.name} is coming soon.`)

  const files = (req.files as Express.Multer.File[] | undefined) ?? []
  if (files.length === 0) throw ApiError.unprocessable('empty', 'Choose a file to upload.')
  if (!tool.multiple && files.length > 1) throw ApiError.unprocessable('single_only', `${tool.name} takes one file at a time.`)

  const limit = tool.maxFileSizeMB * 1024 * 1024
  const created = []
  for (const f of files) {
    const name = sanitizeFilename(Buffer.from(f.originalname, 'latin1').toString('utf8'))
    if (f.size === 0) throw ApiError.unprocessable('empty', `${name} is empty.`)
    if (f.size > limit) throw ApiError.unprocessable('too_large', `File is larger than the ${tool.maxFileSizeMB} MB limit.`)
    const ext = extensionOf(name)
    const sniffed = await sniffMime(f.buffer, ext)
    const accepted = sniffed !== null && tool.accepts.includes(sniffed) && (tool.extensions.length === 0 || tool.extensions.includes(ext) || sniffed !== 'text/plain')
    if (!accepted) {
      const label = tool.extensions.map((e) => e.toUpperCase()).join(', ')
      throw ApiError.unprocessable('unsupported_type', `This file type isn't supported. Upload a ${label} file.`)
    }
    const meta = await inspect(f.buffer, sniffed, name)
    const doc = await DocumentService.createDocument({ session, originalFilename: name, mimeType: sniffed, bytes: f.buffer, sourceTool: tool.id, meta })
    await AuditLogService.log({ session, action: 'upload', toolId: tool.id, documentId: doc.id, status: 'success', meta: { filename: name, size: f.size, mime: sniffed }, req })
    created.push(toolDocumentToApi(doc))
  }
  ok(res, { items: created, count: created.length }, 201)
}))

/** Cheap facts about an input worth showing before the user clicks Convert. */
async function inspect(bytes: Buffer, mime: string, name: string): Promise<Record<string, unknown>> {
  try {
    if (mime === 'application/pdf') {
      const doc = await PDFService.load(bytes)
      return { page_count: doc.getPageCount(), encrypted: doc.isEncrypted }
    }
    if (mime.startsWith('image/')) {
      const info = await ImageService.info(bytes)
      return { width: info.width, height: info.height }
    }
    if (mime === 'text/csv' || mime === 'text/tab-separated-values' || mime === 'text/plain') {
      const parsed = CSVService.parse(bytes)
      return {
        encoding: parsed.detection.encoding,
        delimiter: parsed.detection.delimiter === '\t' ? 'tab' : parsed.detection.delimiter,
        has_header: parsed.detection.hasHeader,
        rows: parsed.rows.length,
        columns: parsed.columns.length,
        column_types: parsed.columns,
        column_names: parsed.columnNames,
        sample: parsed.rows.slice(0, 6),
      }
    }
  } catch (err) {
    return { inspect_error: err instanceof Error ? err.message : `Could not inspect ${name}` }
  }
  return {}
}

// ── Jobs ─────────────────────────────────────────────────────────────────
toolsRouter.post('/:toolId/jobs', handler(async (req, res) => {
  const session = requireSession(req)
  const tool = requireTool(session, req.params.toolId)
  if (tool.status !== 'active' || !isImplemented(tool.id)) throw ApiError.unprocessable('coming_soon', `${tool.name} is coming soon.`)
  const b = z.object({
    input_document_ids: z.array(z.string().min(1)).min(1).max(40),
    options: z.record(z.unknown()).optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('input_document_ids is required.')
  if (!tool.multiple && b.data.input_document_ids.length > 1) throw ApiError.unprocessable('single_only', `${tool.name} takes one file at a time.`)

  const inputs = await DocumentService.getOwnedDocuments(session, b.data.input_document_ids)
  for (const d of inputs) {
    if (d.kind !== 'input' && d.mimeType !== 'application/pdf') throw ApiError.unprocessable('invalid_input', 'Only uploaded files can be converted.')
    if (!tool.accepts.includes(d.mimeType)) throw ApiError.unprocessable('unsupported_type', `${d.originalFilename} isn't a file ${tool.name} accepts.`)
  }
  const organisationId = await DocumentService.organisationIdOf(session)
  const options = b.data.options ?? {}
  // Never persist a password or a drawn signature bitmap in the job record.
  const { password: _pw, signature_png: _sig, ...storable } = options
  const job = await ToolJobService.createJob({
    session, organisationId, toolId: tool.id, inputDocumentId: inputs[0]?.id ?? null,
    meta: { options: storable, input_document_ids: inputs.map((d) => d.id) },
  })
  enqueue(session, organisationId, job.id, tool, inputs, options)
  ok(res, toolJobToApi(job), 202)
}))

toolJobsRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireTools(session)
  const job = await ToolJobService.getJob(session, req.params.id)
  const output = job.outputDocument ? await DocumentService.getDocument(session, job.outputDocument.id).catch(() => null) : null
  ok(res, { ...toolJobToApi(job), output: output ? toolDocumentToApi(output) : null })
}))

// ── Documents ────────────────────────────────────────────────────────────
toolDocumentsRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  requireTools(session)
  const q = z.object({
    q: z.string().optional(),
    kind: z.enum(['input', 'output', 'all']).optional(),
    file_type: z.enum(['pdf', 'excel', 'word', 'csv', 'image', 'text', 'other', '']).optional(),
    tool: z.string().optional(),
    status: z.enum(['processing', 'completed', 'failed', '']).optional(),
    user_id: z.string().optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
  }).safeParse(req.query)
  if (!q.success) throw ApiError.badRequest('Invalid filter.')
  const { items, scope } = await DocumentService.getDocuments(session, q.data)
  // Distinct creators in scope, for the "Created by" filter.
  const creators = [...new Map(items.map((d) => [d.user.id, d.user.employee?.fullName ?? d.user.email])).entries()]
    .map(([id, label]) => ({ id, label }))
  ok(res, { items: items.map(toolDocumentToApi), count: items.length, scope, creators })
}))

toolDocumentsRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireTools(session)
  const doc = await DocumentService.getDocument(session, req.params.id)
  const parent = doc.parentDocumentId ? await DocumentService.getDocument(session, doc.parentDocumentId).catch(() => null) : null
  const jobs = await ToolJobService.jobsForDocument(doc.id)
  const trail = await AuditLogService.forDocument([doc.id, ...(parent ? [parent.id] : [])])
  ok(res, {
    document: toolDocumentToApi(doc),
    source: parent ? toolDocumentToApi(parent) : null,
    jobs: jobs.map(toolJobToApi),
    audit: trail,
    can_delete: doc.userId === session.userId ? can(session, 'tools.documents.manage', 'self') : can(session, 'tools.documents.manage', 'organisation'),
  })
}))

toolDocumentsRouter.get('/:id/link', handler(async (req, res) => {
  const session = requireSession(req)
  requireTools(session)
  const doc = await DocumentService.getDocument(session, req.params.id)
  if (doc.status !== 'completed' || !doc.storagePath) throw ApiError.unprocessable('no_file', 'This document has no file to download.')
  const inline = req.query.inline === '1'
  await AuditLogService.log({ session, action: inline ? 'preview' : 'download', toolId: doc.sourceTool, documentId: doc.id, status: 'success', meta: { filename: doc.originalFilename }, req })
  ok(res, DocumentService.downloadLink(session, doc, inline))
}))

toolDocumentsRouter.get('/:id/preview', handler(async (req, res) => {
  const session = requireSession(req)
  requireTools(session)
  const doc = await DocumentService.getDocument(session, req.params.id)
  if (doc.status !== 'completed' || !doc.storagePath) throw ApiError.unprocessable('no_file', 'This document has no file to preview.')
  const bytes = await DocumentService.readBytes(doc)
  if (doc.mimeType.includes('spreadsheetml')) {
    const p = await ExcelService.preview(bytes, 200)
    return ok(res, { kind: 'sheets', ...p })
  }
  if (doc.mimeType === 'text/plain') {
    return ok(res, { kind: 'text', text: bytes.subarray(0, 400_000).toString('utf8'), truncated: bytes.length > 400_000 })
  }
  if (doc.mimeType === 'text/csv' || doc.mimeType === 'text/tab-separated-values') {
    const parsed = CSVService.parse(bytes)
    return ok(res, { kind: 'sheets', sheets: [{ name: doc.originalFilename, rows: parsed.rows.slice(0, 200), truncated: parsed.rows.length > 200 }] })
  }
  if (doc.mimeType === 'application/pdf' || doc.mimeType.startsWith('image/')) {
    await AuditLogService.log({ session, action: 'preview', toolId: doc.sourceTool, documentId: doc.id, status: 'success', meta: { filename: doc.originalFilename }, req })
    return ok(res, { kind: doc.mimeType === 'application/pdf' ? 'pdf' : 'image', ...DocumentService.downloadLink(session, doc, true) })
  }
  ok(res, { kind: 'none' })
}))

/** Page count and thumbnail links for a PDF input (Split PDF, e-Sign page picker). */
toolDocumentsRouter.get('/:id/pages', handler(async (req, res) => {
  const session = requireSession(req)
  requireTools(session)
  const doc = await DocumentService.getDocument(session, req.params.id)
  if (doc.mimeType !== 'application/pdf') throw ApiError.unprocessable('not_pdf', 'Thumbnails are only available for PDFs.')
  const bytes = await DocumentService.readBytes(doc)
  const pdf = await PDFService.load(bytes)
  if (pdf.isEncrypted) return ok(res, { page_count: pdf.getPageCount(), encrypted: true, thumbs: [] })
  const count = pdf.getPageCount()
  const max = Math.min(count, 120)
  let cached = await DocumentService.getDerived(doc, 'thumb-1.png')
  if (!cached) {
    const thumbs = await PDFService.thumbnails(bytes, 220, max)
    await Promise.all(thumbs.map((t, i) => DocumentService.putDerived(doc, `thumb-${i + 1}.png`, t)))
    cached = thumbs[0] ?? null
  }
  const links = Array.from({ length: max }, (_, i) => {
    const page = i + 1
    const { url } = { url: `/api/tool-documents/${doc.id}/thumbs/${page}` }
    const { token } = signThumb(doc.id, page, session.userId)
    return { page, url: `${url}?t=${encodeURIComponent(token)}` }
  })
  ok(res, { page_count: count, encrypted: false, thumbs: links, truncated: count > max })
}))

toolDocumentsRouter.delete('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireTools(session)
  const doc = await DocumentService.deleteDocument(session, req.params.id)
  await AuditLogService.log({ session, action: 'delete', toolId: doc.sourceTool, documentId: doc.id, status: 'success', meta: { filename: doc.originalFilename }, req })
  res.status(204).end()
}))

// ── Signed byte routes ───────────────────────────────────────────────────
import { signResource } from '../../platform/signedUrl.js'
function signThumb(docId: string, page: number, userId: string) {
  return signResource(`tool-thumb:${docId}:${page}`, userId)
}

toolsSignedRouter.get('/tool-documents/:id/download', handler(async (req, res) => {
  const id = req.params.id
  verifyResourceToken(`tool-document:${id}`, typeof req.query.t === 'string' ? req.query.t : undefined)
  const doc = await prisma.toolDocument.findFirst({ where: { id, deletedAt: null } })
  if (!doc || !doc.storagePath) throw ApiError.notFound('Document not found.')
  const bytes = await DocumentService.readBytes(doc)
  const inline = req.query.inline === '1'
  res.setHeader('Content-Type', doc.mimeType)
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${headerFilename(doc.originalFilename)}"; filename*=UTF-8''${encodeURIComponent(doc.originalFilename)}`)
  res.send(bytes)
}))

toolsSignedRouter.get('/tool-documents/:id/thumbs/:page', handler(async (req, res) => {
  const id = req.params.id
  const page = Number(req.params.page)
  verifyResourceToken(`tool-thumb:${id}:${page}`, typeof req.query.t === 'string' ? req.query.t : undefined)
  const doc = await prisma.toolDocument.findFirst({ where: { id, deletedAt: null } })
  if (!doc) throw ApiError.notFound('Document not found.')
  const png = await DocumentService.getDerived(doc, `thumb-${page}.png`)
  if (!png) throw ApiError.notFound('Thumbnail not found.')
  res.setHeader('Content-Type', 'image/png')
  res.setHeader('Cache-Control', 'private, max-age=300')
  res.send(png)
}))
