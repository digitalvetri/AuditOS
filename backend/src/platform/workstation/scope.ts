import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import { can, type Session } from '../auth.js'
import type { PermissionCode, Scope } from '../rbac/matrix.js'

/**
 * WORKSTATION SCOPE RESOLUTION (AUDIT_OS_WORKSTATION.md §6.1).
 *
 * HRMS reads `self` as "my own row". Workstation reads it as "rows ASSIGNED
 * to me", because a GST executive is defined by their assignments, not by a
 * role code (§0.2 D1). Everything here returns a Prisma `where` fragment that
 * is folded into the query — never a filter applied after the rows come back,
 * which is the difference between a control and a decoration.
 *
 * Out of scope is always 403. Never a 200 with an empty array (that leaks
 * "you may ask"), never a 404 (that leaks "this id does not exist").
 */

/** Widest scope the caller holds for any of the given permissions. */
export function workstationScope(session: Session, ...permissions: PermissionCode[]): Scope | null {
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

/**
 * Require a permission and return the caller's scope for it.
 * Throws 403 rather than returning null, so a handler cannot forget to check.
 */
export function requireWorkstation(session: Session, ...permissions: PermissionCode[]): Scope {
  const scope = workstationScope(session, ...permissions)
  if (!scope) throw ApiError.forbidden()
  return scope
}

/**
 * The client ids a caller may see at `self` scope.
 *
 *   accountManagerId = me
 * ∪ ClientService.assignedEmployeeId = me
 * ∪ ClientService.managerId = me
 * ∪ GstProfile.assignedEmployeeId = me
 *
 * 'ALL' short-circuits the IN list for organisation scope.
 */
export async function assignedClientIds(session: Session, scope: Scope): Promise<string[] | 'ALL'> {
  if (scope === 'organisation' || scope === 'department') return 'ALL'
  const me = session.employeeId
  if (!me) return []

  const [owned, viaService, viaGst] = await Promise.all([
    prisma.client.findMany({ where: { accountManagerId: me, deletedAt: null }, select: { id: true } }),
    prisma.clientService.findMany({
      where: { deletedAt: null, OR: [{ assignedEmployeeId: me }, { managerId: me }] },
      select: { clientId: true },
    }),
    prisma.gstProfile.findMany({ where: { assignedEmployeeId: me, deletedAt: null }, select: { clientId: true } }),
  ])

  return Array.from(new Set([
    ...owned.map((r) => r.id),
    ...viaService.map((r) => r.clientId),
    ...viaGst.map((r) => r.clientId),
  ]))
}

/** A `where` fragment on `clientId` for anything hanging off a client. */
export async function clientScopeWhere(session: Session, scope: Scope) {
  const ids = await assignedClientIds(session, scope)
  return ids === 'ALL' ? {} : { clientId: { in: ids } }
}

/** A `where` fragment on `id` for the Client table itself. */
export async function clientIdWhere(session: Session, scope: Scope) {
  const ids = await assignedClientIds(session, scope)
  return ids === 'ALL' ? {} : { id: { in: ids } }
}

/** 403 unless the caller may see this client. Used by every detail route. */
export async function assertCanSeeClient(session: Session, scope: Scope, clientId: string): Promise<void> {
  const ids = await assignedClientIds(session, scope)
  if (ids === 'ALL') return
  if (!ids.includes(clientId)) throw ApiError.forbidden()
}

/** Lead ids assigned to the caller — leads have no client yet. */
export async function leadScopeWhere(session: Session, scope: Scope) {
  if (scope === 'organisation' || scope === 'department') return {}
  return { assignedEmployeeId: session.employeeId ?? '__none__' }
}

export async function assertCanSeeLead(session: Session, scope: Scope, leadId: string): Promise<void> {
  if (scope === 'organisation' || scope === 'department') return
  const lead = await prisma.lead.findFirst({ where: { id: leadId, deletedAt: null }, select: { assignedEmployeeId: true } })
  // A lead that does not exist and a lead you may not see are answered
  // identically on purpose — the caller learns nothing either way.
  if (!lead || lead.assignedEmployeeId !== session.employeeId) throw ApiError.forbidden()
}

/**
 * Follow-ups are the one entity spanning both sides, so their predicate is a
 * union: mine, or on a client I am assigned to, or on a lead I own.
 */
export async function followUpScopeWhere(session: Session, scope: Scope) {
  if (scope === 'organisation' || scope === 'department') return {}
  const me = session.employeeId ?? '__none__'
  const ids = await assignedClientIds(session, scope)
  const clientIds = ids === 'ALL' ? [] : ids
  return {
    OR: [
      { assignedEmployeeId: me },
      { clientId: { in: clientIds } },
      { lead: { assignedEmployeeId: me } },
    ],
  }
}

export { can }
