import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'
import { addDays, daysBetween, istToday } from '../lib/dates.js'
import { can, requireSession, type Session } from '../platform/auth.js'
import { writeAudit } from '../platform/audit.js'
import { signedLink } from '../platform/signedUrl.js'
import { documentToApi, employeeRef } from '../api/serialize.js'
import type { Scope } from '../platform/rbac/matrix.js'

/**
 * DOCUMENTS (§8.8 / §9)
 *
 * Download is a two-step signed-URL flow: GET …/download-url returns a
 * short-lived HMAC token bound to the document and the caller, and the bytes
 * endpoint verifies it. There is no guessable public path to a document.
 *
 * Finance has no document grant at all, so it gets a 403 rather than an
 * empty list — the caller learns the truth, not a misleading emptiness.
 */
export const documentsRouter = Router()

function documentScope(session: Session): Scope | 'blocked' {
  if (can(session, 'document.manage', 'organisation')) return 'organisation'
  if (can(session, 'document.read', 'organisation')) return 'organisation'
  if (can(session, 'document.read', 'department')) return 'department'
  if (can(session, 'document.read', 'self')) return 'self'
  return 'blocked'
}

type DocRow = Awaited<ReturnType<typeof prisma.employeeDocument.findMany>>[number]

/** Status is derived from expiry; pending_verification is sticky until HR clears it. */
export function derivedStatus(doc: Pick<DocRow, 'status' | 'expiryDate'>): string {
  if (doc.status === 'pending_verification') return 'pending_verification'
  if (!doc.expiryDate) return 'valid'
  const days = daysBetween(istToday(), doc.expiryDate)
  if (days < 0) return 'expired'
  if (days <= 30) return 'expiring_soon'
  return 'valid'
}

async function assertCanSeeDocument(session: Session, scope: Scope, employeeId: string) {
  if (scope === 'organisation') return
  if (scope === 'self') {
    if (session.employeeId !== employeeId) throw ApiError.forbidden()
    return
  }
  const target = await prisma.employee.findUnique({ where: { id: employeeId } })
  if (!target || target.departmentId !== session.departmentId) throw ApiError.forbidden()
}

// GET /api/documents
documentsRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = documentScope(session)
  if (scope === 'blocked') throw ApiError.forbidden()

  const q = z.object({
    employeeId: z.string().optional(),
    type: z.string().optional(),
    status: z.string().optional(),
    expiringWithinDays: z.coerce.number().int().positive().optional(),
  }).parse(req.query)

  const where: Record<string, unknown> = { deletedAt: null }
  if (scope === 'self') {
    if (!session.employeeId) return ok(res, { items: [], count: 0, scope })
    where.employeeId = session.employeeId
  } else if (scope === 'department') {
    where.employee = { departmentId: session.departmentId ?? '__none__' }
  }
  if (q.employeeId) {
    await assertCanSeeDocument(session, scope, q.employeeId)
    where.employeeId = q.employeeId
  }
  if (q.type) where.type = q.type

  const rows = await prisma.employeeDocument.findMany({
    where, include: { employee: true }, orderBy: { uploadedAt: 'desc' },
  })

  const uploaderIds = [...new Set(rows.map((r) => r.uploadedBy))]
  const uploaders = await prisma.user.findMany({
    where: { id: { in: uploaderIds } }, include: { employee: true },
  })
  const uploaderLabel = new Map(
    uploaders.map((u) => [u.id, u.employee?.fullName ?? u.email]),
  )

  const items = rows
    .map((r) => ({ row: r, status: derivedStatus(r) }))
    .filter(({ status }) => (q.status ? status === q.status : true))
    .filter(({ row }) => {
      if (!q.expiringWithinDays) return true
      if (!row.expiryDate) return false
      const days = daysBetween(istToday(), row.expiryDate)
      return days >= 0 && days <= q.expiringWithinDays
    })
    .map(({ row, status }) => ({
      ...documentToApi(row, status),
      employee: employeeRef(row.employee),
      uploader_label: uploaderLabel.get(row.uploadedBy) ?? 'system',
    }))

  ok(res, { items, count: items.length, scope })
}))

// POST /api/documents
documentsRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  const canManage = can(session, 'document.manage', 'organisation')
  const b = z.object({
    name: z.string().trim().min(1),
    type: z.enum(['employment', 'joining', 'certificate', 'hr', 'tax', 'bank', 'company_issued', 'icai']),
    employee_id: z.string().min(1),
    expiry_date: z.string().nullable().optional(),
    status: z.string().optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('name, type and employee_id are required.')

  if (!canManage && session.employeeId !== b.data.employee_id) {
    throw ApiError.forbidden('You can only upload to your own record.')
  }
  const target = await prisma.employee.findUnique({ where: { id: b.data.employee_id } })
  if (!target || target.deletedAt) {
    throw ApiError.unprocessable('invalid_target', 'Target employee not found or inactive.')
  }

  const row = await prisma.employeeDocument.create({
    data: {
      employeeId: target.id,
      name: b.data.name,
      type: b.data.type,
      fileKey: `uploads/${target.id}/${b.data.name.replace(/\s+/g, '-').toLowerCase()}.pdf`,
      uploadedBy: session.userId,
      expiryDate: b.data.expiry_date ?? null,
      // An employee uploading their own bank details lands in verification.
      status: !canManage && b.data.type === 'bank' ? 'pending_verification' : (b.data.status ?? 'valid'),
      createdBy: session.userId,
      updatedBy: session.userId,
    },
    include: { employee: true },
  })

  await writeAudit({
    actorUserId: session.userId, action: 'document.uploaded',
    entityType: 'EmployeeDocument', entityId: row.id,
    after: { name: row.name, type: row.type, employee_id: row.employeeId }, req,
  })
  ok(res, {
    document: {
      ...documentToApi(row, derivedStatus(row)),
      employee: employeeRef(row.employee),
      uploader_label: session.employeeFullName ?? session.email,
    },
  })
}))

// DELETE /api/documents/:id — HR / MD only
documentsRouter.delete('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'document.manage', 'organisation')) {
    throw ApiError.forbidden('Only HR or MD can delete documents.')
  }
  const doc = await prisma.employeeDocument.findUnique({ where: { id: req.params.id } })
  if (!doc || doc.deletedAt) throw ApiError.notFound('Document not found.')

  await prisma.employeeDocument.update({
    where: { id: doc.id }, data: { deletedAt: new Date(), updatedBy: session.userId },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'document.deleted',
    entityType: 'EmployeeDocument', entityId: doc.id, before: documentToApi(doc), req,
  })
  res.status(204).end()
}))

// GET /api/documents/:id/download-url
documentsRouter.get('/:id/download-url', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = documentScope(session)
  if (scope === 'blocked') throw ApiError.forbidden()
  const doc = await prisma.employeeDocument.findUnique({ where: { id: req.params.id } })
  if (!doc || doc.deletedAt) throw ApiError.notFound('Document not found.')
  await assertCanSeeDocument(session, scope, doc.employeeId)

  ok(res, signedLink(`/api/documents/${doc.id}/download`, `document:${doc.id}`, session.userId))
}))

/** Used by the dashboard queue — documents expiring within N days, in scope. */
export async function expiringDocuments(session: Session, withinDays: number) {
  const scope = documentScope(session)
  if (scope === 'blocked') return []
  const today = istToday()
  const where: Record<string, unknown> = { deletedAt: null, expiryDate: { not: null } }
  if (scope === 'self') {
    if (!session.employeeId) return []
    where.employeeId = session.employeeId
  } else if (scope === 'department') {
    where.employee = { departmentId: session.departmentId ?? '__none__' }
  }
  const rows = await prisma.employeeDocument.findMany({ where, include: { employee: true } })
  const limit = addDays(today, withinDays)
  return rows
    .filter((d) => d.expiryDate! >= today && d.expiryDate! <= limit)
    .map((d) => ({
      id: d.id,
      name: d.name,
      employee_id: d.employeeId,
      employee_name: d.employee.fullName,
      expiry_date: d.expiryDate!,
      days_left: daysBetween(today, d.expiryDate!),
    }))
    .sort((a, b) => a.days_left - b.days_left)
}
