import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import type { Session } from '../auth.js'
import type { Scope } from '../rbac/matrix.js'
import { assertCanSeeClient, assignedClientIds } from './scope.js'

/**
 * ORGANIZATION CLIENTS.
 *
 * An organization is a Client (isOrganization) that other ordinary clients
 * sit under (Client.parentClientId). One level only. Every child is still a
 * full client: its own workspace, services and documents, visible across
 * the CRM through the same scope rules as any other client.
 *
 * Aggregates never widen access. An organization view counts only the
 * children the caller could open on their own, so being assigned to the
 * organization does not reveal its clients.
 */

/** "ABC Business Solutions" → "ABC"; "Greenleaf Organics LLP" → "GOL". */
export function deriveShortName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'ORG'
  if (words.length === 1 || words[0].length <= 5) return words[0].replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase() || 'ORG'
  return words.slice(0, 4).map((w) => w[0]).join('').toUpperCase()
}

/** The default name for the next client under an organization: "ABC DV Client 3". */
export async function suggestChildName(org: { id: string; shortName: string | null; companyName: string }): Promise<string> {
  const count = await prisma.client.count({ where: { parentClientId: org.id } })
  return `${org.shortName || deriveShortName(org.companyName)} DV Client ${count + 1}`
}

/** The organization behind `id`, after the caller's normal client check. 404 if it is not one. */
export async function loadOrganization(session: Session, scope: Scope, id: string) {
  await assertCanSeeClient(session, scope, id)
  const org = await prisma.client.findFirst({ where: { id, deletedAt: null } })
  if (!org) throw ApiError.notFound('Client not found.')
  if (!org.isOrganization) throw ApiError.unprocessable('not_organization', 'This client is not an organization.')
  return org
}

/** The organization's children this caller may see — never more. */
export async function visibleChildren(session: Session, scope: Scope, orgId: string) {
  const ids = await assignedClientIds(session, scope)
  return prisma.client.findMany({
    where: {
      parentClientId: orgId, deletedAt: null,
      ...(ids === 'ALL' ? {} : { id: { in: ids } }),
    },
    orderBy: { clientCode: 'asc' },
  })
}

/**
 * Checks before a client is placed under an organization (create or link).
 * Organizations stay one level deep and a client belongs to one organization.
 */
export async function assertCanJoinOrganization(
  session: Session, scope: Scope, orgId: string, child?: { id: string; isOrganization: boolean; parentClientId: string | null },
) {
  const org = await loadOrganization(session, scope, orgId)
  if (child) {
    if (child.id === org.id) throw ApiError.unprocessable('self_parent', 'An organization cannot contain itself.')
    if (child.isOrganization) {
      throw ApiError.unprocessable('nested_organization', 'An organization cannot be added under another organization.')
    }
    if (child.parentClientId && child.parentClientId !== org.id) {
      throw ApiError.conflict('has_organization', 'This client already belongs to another organization. Remove it from there first.')
    }
  }
  return org
}

/**
 * Quotations and engagement letters are agreed with the ORGANIZATION, not
 * with each of its clients (invoices still go to each client). Refuses a
 * client that sits under an organization, naming where to raise it instead.
 */
export async function assertNotOrganizationMember(clientId: string, what: 'Quotations' | 'Engagement letters') {
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: { companyName: true, parentClient: { select: { id: true, companyName: true } } },
  })
  if (c?.parentClient) {
    throw ApiError.unprocessable(
      'organization_member',
      `${what} for ${c.companyName} are made on its organization, ${c.parentClient.companyName}.`,
      { organization_id: c.parentClient.id },
    )
  }
}

/**
 * Load a follow-up's client with its organization: a follow-up about an
 * organization's client is sent to the organization's contact.
 */
export const FOLLOW_UP_CLIENT = { include: { parentClient: true } } as const

/** A client id, widened to the organization's own clients when it is an organization. */
export async function clientAndMembers(clientId: string): Promise<string[]> {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { isOrganization: true } })
  if (!c?.isOrganization) return [clientId]
  const kids = await prisma.client.findMany({ where: { parentClientId: clientId, deletedAt: null }, select: { id: true } })
  return [clientId, ...kids.map((k) => k.id)]
}
