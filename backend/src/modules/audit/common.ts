import type { Request } from 'express'
import { z } from 'zod'
import { ApiError } from '../../lib/http.js'
import { requireSession, type Session } from '../../platform/auth.js'
import type { PermissionCode, Scope } from '../../platform/rbac/matrix.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'
import { writeAudit } from '../../platform/audit.js'
import { loadFile } from './service.js'
import type { AuditEngagement } from '@prisma/client'

export const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
export const FY = z.string().regex(/^\d{4}-\d{2}$/, "Use a financial year like '2025-26'.")
  .refine((s) => (Number(s.slice(0, 4)) + 1) % 100 === Number(s.slice(5)), 'The second year must follow the first.')

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, message: string): z.infer<T> {
  const r = schema.safeParse(data ?? {})
  if (!r.success) {
    throw ApiError.badRequest(message, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
  }
  return r.data
}

export type Perm = 'read' | 'manage' | 'review' | 'sign'
const CODE: Record<Perm, PermissionCode> = {
  read: 'workstation.audit.read',
  manage: 'workstation.audit.manage',
  review: 'workstation.audit.review',
  sign: 'workstation.audit.sign',
}

export function access(req: Request, perm: Perm): { session: Session; scope: Scope } {
  const session = requireSession(req)
  // Seeing the file needs read as well as the action's own permission.
  if (perm !== 'read') requireWorkstation(session, CODE.read)
  return { session, scope: requireWorkstation(session, CODE[perm]) }
}

/** Session, scope and the file — permission, existence and client visibility checked. */
export async function fileAccess(req: Request, perm: Perm): Promise<{ session: Session; scope: Scope; e: AuditEngagement }> {
  const { session, scope } = access(req, perm)
  const e = await loadFile(session, scope, req.params.id)
  return { session, scope, e }
}

export function audit(req: Request, session: Session, action: string, entityType: string, entityId: string, before?: unknown, after?: unknown) {
  return writeAudit({ actorUserId: session.userId, action: `audit_file.${action}`, entityType, entityId, before, after, req })
}

/** Unique-constraint violation from Prisma. */
export const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === 'P2002'
