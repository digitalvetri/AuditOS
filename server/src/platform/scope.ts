import { prisma } from '../lib/prisma.js'
import { ApiError } from '../lib/http.js'
import { can, type Session } from './auth.js'
import type { PermissionCode, Scope } from './rbac/matrix.js'

/**
 * SCOPE RESOLUTION — the "which rows may this caller see" half of RBAC.
 *
 * Every list endpoint resolves the caller's widest scope for the relevant
 * permission and folds it into the Prisma `where`, so a Department Manager's
 * query cannot return another department's rows. Nothing is filtered after
 * the fact in memory.
 */

/** Widest scope the session holds for any of the given permissions. */
export function widestScope(session: Session, ...permissions: PermissionCode[]): Scope | null {
  let best: Scope | null = null
  for (const p of permissions) {
    for (const g of session.grants) {
      if (g.permission !== p) continue
      if (g.scope === 'organisation') return 'organisation'
      if (g.scope === 'department') best = 'department'
      else if (best === null) best = 'self'
    }
  }
  return best
}

/** Employee ids the caller may see at `scope`. 'ALL' avoids an IN list. */
export async function employeeIdsInScope(session: Session, scope: Scope): Promise<string[] | 'ALL'> {
  if (scope === 'organisation') return 'ALL'
  if (scope === 'self') return session.employeeId ? [session.employeeId] : []
  if (!session.departmentId) return []
  const rows = await prisma.employee.findMany({
    where: { departmentId: session.departmentId },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

/** A Prisma `where` fragment on employeeId for the caller's scope. */
export async function employeeScopeWhere(session: Session, scope: Scope) {
  const ids = await employeeIdsInScope(session, scope)
  return ids === 'ALL' ? {} : { employeeId: { in: ids } }
}

export async function assertCanSeeEmployee(session: Session, scope: Scope, employeeId: string) {
  if (scope === 'organisation') return
  const ids = await employeeIdsInScope(session, scope)
  if (ids !== 'ALL' && !ids.includes(employeeId)) throw ApiError.forbidden()
}

export { can }
