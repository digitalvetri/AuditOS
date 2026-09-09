import type { Request } from 'express'
import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import type { BooksContext, MembershipRole } from './engine/context.js'

/**
 * MULTI-TENANT SCOPE for Books.
 *
 * A caller reaches a set of books only through /api/books/:orgId/…, and this
 * resolver is the sole way a route obtains a BooksContext. It refuses with
 * 403 unless the caller either holds `books.access` at organisation scope
 * (the firm's partners, ops managers and accountants) or is a member of that
 * specific set of books. Every query downstream carries ctx.booksOrgId.
 */
export async function resolveBooksContext(req: Request, orgId: string): Promise<BooksContext> {
  const session = requireSession(req)
  return contextFor(session, orgId, req.ip ?? null)
}

export async function contextFor(session: Session, orgId: string, ip: string | null = null): Promise<BooksContext> {
  if (!can(session, 'books.access', 'self')) throw ApiError.forbidden('You do not have access to Books.')
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { organisationId: true } })
  if (!user) throw ApiError.unauthorized()
  const org = await prisma.booksOrganisation.findFirst({ where: { id: orgId, organisationId: user.organisationId, deletedAt: null } })
  if (!org) throw ApiError.notFound('Set of books not found.')

  let role: MembershipRole
  if (can(session, 'books.access', 'organisation')) {
    role = 'admin'
  } else {
    const m = await prisma.booksMembership.findUnique({ where: { booksOrgId_userId: { booksOrgId: org.id, userId: session.userId } } })
    if (!m) throw ApiError.forbidden('You are not assigned to this set of books.')
    role = m.role as MembershipRole
  }
  return {
    booksOrgId: org.id, organisationId: org.organisationId, userId: session.userId, role,
    baseCurrency: org.baseCurrency, stateCode: org.stateCode, tdsEnabled: org.tdsEnabled, ip,
  }
}

/** The sets of books this caller may open. */
export async function listBooksForSession(session: Session) {
  if (!can(session, 'books.access', 'self')) throw ApiError.forbidden('You do not have access to Books.')
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { organisationId: true } })
  if (!user) throw ApiError.unauthorized()
  const where = can(session, 'books.access', 'organisation')
    ? { organisationId: user.organisationId, deletedAt: null }
    : { organisationId: user.organisationId, deletedAt: null, memberships: { some: { userId: session.userId } } }
  return prisma.booksOrganisation.findMany({ where, include: { memberships: true }, orderBy: { name: 'asc' } })
}

export type Area = 'settings' | 'reports' | 'accountant'

/** Settings / Reports / Accountant tools: admins only (staff never, viewers never). */
export function requireArea(ctx: BooksContext, session: Session, area: Area): void {
  const code = area === 'settings' ? 'books.settings' : area === 'reports' ? 'books.reports' : 'books.accountant'
  if (ctx.role !== 'admin' || !can(session, code, 'self')) {
    throw ApiError.forbidden(`Only an admin of this set of books can use ${area}.`)
  }
}

/** Anything that creates or changes a financial record. */
export function requireWrite(ctx: BooksContext): void {
  if (ctx.role === 'viewer') throw ApiError.forbidden('You have read-only access to this set of books.')
}
