import crypto from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import { can, type Session } from '../../../platform/auth.js'
import { signedLink, type SignedLink } from '../../../platform/signedUrl.js'
import { storage } from '../storage/index.js'
import { sanitizeFilename } from '../lib/files.js'

/**
 * DocumentService — the one place a ToolDocument row is created, read,
 * downloaded or deleted. Bytes go through the StorageAdapter, never a path.
 *
 * Scope: a caller with `tools.documents.read` at organisation scope sees the
 * whole firm's documents; anyone else sees only their own. Every read path
 * folds that into the Prisma `where`, so there is no post-fetch filtering
 * and no way to reach another organisation's document.
 */

export type DocumentKind = 'input' | 'output'
export type DocumentStatus = 'processing' | 'completed' | 'failed'

export interface DocumentFilters {
  q?: string
  kind?: DocumentKind | 'all'
  file_type?: 'pdf' | 'excel' | 'word' | 'csv' | 'image' | 'text' | 'other' | ''
  tool?: string
  status?: DocumentStatus | ''
  user_id?: string
  from?: string // YYYY-MM-DD (IST calendar date)
  to?: string
  limit?: number
}

const FILE_TYPE_MIMES: Record<string, string[]> = {
  pdf: ['application/pdf'],
  excel: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'],
  word: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  csv: ['text/csv', 'text/tab-separated-values'],
  image: ['image/jpeg', 'image/png', 'image/webp'],
  text: ['text/plain'],
}

export function documentScope(session: Session): 'organisation' | 'self' | 'blocked' {
  if (can(session, 'tools.documents.read', 'organisation')) return 'organisation'
  if (can(session, 'tools.documents.read', 'self')) return 'self'
  return 'blocked'
}

async function organisationIdOf(session: Session): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { organisationId: true } })
  if (!user) throw ApiError.unauthorized()
  return user.organisationId
}

function scopeWhere(session: Session, organisationId: string): Prisma.ToolDocumentWhereInput {
  const scope = documentScope(session)
  if (scope === 'blocked') throw ApiError.forbidden()
  return scope === 'organisation'
    ? { organisationId }
    : { organisationId, userId: session.userId }
}

/** Storage key: <org>/<doc>/<random>-<safe name>. Never derived from client input alone. */
function storageKey(organisationId: string, documentId: string, safeName: string): string {
  return `${organisationId}/${documentId}/${crypto.randomBytes(4).toString('hex')}-${safeName.replace(/\s+/g, '_')}`
}

const include = {
  user: { include: { employee: true } },
  outputJobs: { include: { tool: true }, orderBy: { createdAt: 'desc' as const }, take: 1 },
}
export type ToolDocumentRow = Prisma.ToolDocumentGetPayload<{ include: typeof include }>

export const DocumentService = {
  organisationIdOf,
  documentScope,

  /** Store an uploaded (input) file. */
  async createDocument(input: {
    session: Session
    originalFilename: string
    mimeType: string
    bytes: Buffer
    sourceTool?: string | null
    meta?: Record<string, unknown>
  }): Promise<ToolDocumentRow> {
    const organisationId = await organisationIdOf(input.session)
    const id = crypto.randomUUID()
    const safe = sanitizeFilename(input.originalFilename)
    const key = storageKey(organisationId, id, safe)
    await storage.put(key, input.bytes)
    return prisma.toolDocument.create({
      data: {
        id,
        organisationId,
        userId: input.session.userId,
        kind: 'input',
        originalFilename: safe,
        storedFilename: safe,
        mimeType: input.mimeType,
        fileSize: input.bytes.length,
        storagePath: key,
        sourceTool: input.sourceTool ?? null,
        status: 'completed',
        metaJson: input.meta ? JSON.stringify(input.meta) : null,
        versions: { create: { version: 1, storagePath: key, fileSize: input.bytes.length } },
      },
      include,
    })
  },

  /** Persist a tool's output. Always creates a record — success or not. */
  async saveGeneratedDocument(input: {
    session: Pick<Session, 'userId'>
    organisationId: string
    toolId: string
    filename: string
    mimeType: string
    bytes: Buffer
    parentDocumentId?: string | null
    meta?: Record<string, unknown>
  }): Promise<ToolDocumentRow> {
    const id = crypto.randomUUID()
    const safe = sanitizeFilename(input.filename, 'output')
    const key = storageKey(input.organisationId, id, safe)
    await storage.put(key, input.bytes)
    return prisma.toolDocument.create({
      data: {
        id,
        organisationId: input.organisationId,
        userId: input.session.userId,
        kind: 'output',
        originalFilename: safe,
        storedFilename: safe,
        mimeType: input.mimeType,
        fileSize: input.bytes.length,
        storagePath: key,
        sourceTool: input.toolId,
        parentDocumentId: input.parentDocumentId ?? null,
        status: 'completed',
        metaJson: input.meta ? JSON.stringify(input.meta) : null,
        versions: { create: { version: 1, storagePath: key, fileSize: input.bytes.length } },
      },
      include,
    })
  },

  /** A failed run still leaves a record (§13) — no bytes, a stored reason. */
  async saveFailedDocument(input: {
    session: Pick<Session, 'userId'>
    organisationId: string
    toolId: string
    filename: string
    mimeType: string
    parentDocumentId?: string | null
    errorMessage: string
    meta?: Record<string, unknown>
  }): Promise<ToolDocumentRow> {
    return prisma.toolDocument.create({
      data: {
        organisationId: input.organisationId,
        userId: input.session.userId,
        kind: 'output',
        originalFilename: sanitizeFilename(input.filename, 'output'),
        storedFilename: '',
        mimeType: input.mimeType,
        fileSize: 0,
        storagePath: '',
        sourceTool: input.toolId,
        parentDocumentId: input.parentDocumentId ?? null,
        status: 'failed',
        errorMessage: input.errorMessage,
        metaJson: input.meta ? JSON.stringify(input.meta) : null,
      },
      include,
    })
  },

  async getDocuments(session: Session, f: DocumentFilters): Promise<{ items: ToolDocumentRow[]; scope: 'organisation' | 'self' }> {
    const organisationId = await organisationIdOf(session)
    const where: Prisma.ToolDocumentWhereInput = { ...alive, ...scopeWhere(session, organisationId) }
    const kind = f.kind ?? 'output'
    if (kind !== 'all') where.kind = kind
    if (f.tool) where.sourceTool = f.tool
    if (f.status) where.status = f.status
    if (f.user_id) where.userId = f.user_id
    if (f.file_type) {
      const mimes = FILE_TYPE_MIMES[f.file_type]
      if (mimes) where.mimeType = { in: mimes }
      else if (f.file_type === 'other') where.mimeType = { notIn: Object.values(FILE_TYPE_MIMES).flat() }
    }
    if (f.from || f.to) {
      // Calendar dates are IST; convert the bounds to UTC instants.
      const gte = f.from ? new Date(`${f.from}T00:00:00+05:30`) : undefined
      const lte = f.to ? new Date(`${f.to}T23:59:59.999+05:30`) : undefined
      where.createdAt = { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) }
    }
    if (f.q) {
      const q = f.q.trim()
      if (q) where.OR = [{ originalFilename: { contains: q } }, { sourceTool: { contains: q } }, { mimeType: { contains: q } }]
    }
    const items = await prisma.toolDocument.findMany({
      where, include, orderBy: { createdAt: 'desc' }, take: Math.min(f.limit ?? 200, 500),
    })
    return { items, scope: documentScope(session) as 'organisation' | 'self' }
  },

  async getDocument(session: Session, id: string): Promise<ToolDocumentRow> {
    const organisationId = await organisationIdOf(session)
    const doc = await prisma.toolDocument.findFirst({ where: { id, ...alive, ...scopeWhere(session, organisationId) }, include })
    if (!doc) throw ApiError.notFound('Document not found.')
    return doc
  },

  /** Owner-only variant used when a job needs the input it was given. */
  async getOwnedDocuments(session: Session, ids: string[]): Promise<ToolDocumentRow[]> {
    const organisationId = await organisationIdOf(session)
    const rows = await prisma.toolDocument.findMany({
      where: { id: { in: ids }, ...alive, organisationId, userId: session.userId }, include,
    })
    // Preserve the caller's order — merge order is the user's order.
    const byId = new Map(rows.map((r) => [r.id, r]))
    const ordered = ids.map((id) => byId.get(id)).filter((r): r is ToolDocumentRow => Boolean(r))
    if (ordered.length !== ids.length) throw ApiError.notFound('One of the uploaded files could not be found.')
    return ordered
  },

  async readBytes(doc: Pick<ToolDocumentRow, 'storagePath' | 'status'>): Promise<Buffer> {
    if (!doc.storagePath) throw ApiError.unprocessable('no_file', 'This document has no file — the conversion failed.')
    return storage.get(doc.storagePath)
  },

  async localPath(doc: Pick<ToolDocumentRow, 'storagePath'>): Promise<string | null> {
    if (!doc.storagePath) return null
    return storage.localPath(doc.storagePath)
  },

  downloadLink(session: Session, doc: Pick<ToolDocumentRow, 'id'>, inline = false): SignedLink {
    const link = signedLink(`/api/tool-documents/${doc.id}/download`, `tool-document:${doc.id}`, session.userId)
    return inline ? { ...link, url: `${link.url}&inline=1` } : link
  },

  async deleteDocument(session: Session, id: string): Promise<ToolDocumentRow> {
    const doc = await DocumentService.getDocument(session, id)
    const own = doc.userId === session.userId
    if (!(own ? can(session, 'tools.documents.manage', 'self') : can(session, 'tools.documents.manage', 'organisation'))) {
      throw ApiError.forbidden('You do not have permission to delete this document.')
    }
    await prisma.toolDocument.update({ where: { id: doc.id }, data: { deletedAt: new Date() } })
    if (doc.storagePath) await storage.delete(doc.storagePath).catch(() => undefined)
    // Derived thumbnails, if any were rendered.
    const thumbs = await prisma.toolDocumentVersion.findMany({ where: { documentId: doc.id } })
    await Promise.all(thumbs.map((v) => (v.storagePath === doc.storagePath ? Promise.resolve() : storage.delete(v.storagePath).catch(() => undefined))))
    return doc
  },

  /** Cache a derived artefact (page thumbnail) next to the document. */
  async putDerived(doc: Pick<ToolDocumentRow, 'organisationId' | 'id'>, name: string, bytes: Buffer): Promise<string> {
    const key = `${doc.organisationId}/${doc.id}/derived/${name}`
    await storage.put(key, bytes)
    return key
  },
  async getDerived(doc: Pick<ToolDocumentRow, 'organisationId' | 'id'>, name: string): Promise<Buffer | null> {
    const key = `${doc.organisationId}/${doc.id}/derived/${name}`
    return (await storage.exists(key)) ? storage.get(key) : null
  },
}
