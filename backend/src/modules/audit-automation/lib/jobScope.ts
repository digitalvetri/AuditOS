import { prisma } from '../../../lib/prisma.js'
import { can, type Session } from '../../../platform/auth.js'
import type { PermissionCode } from '../../../platform/rbac/matrix.js'
import { assertClientVisible, assignedClientIds, seesAllClients } from '../../../platform/workstation/scope.js'

/**
 * WHO SEES WHICH AUDIT AUTOMATION JOB (bank statements, GST reconciliations).
 *
 * Admin, Super Admin and Senior Associate (an organisation grant plus
 * `clients.view_all`) see every job of the firm. Everyone else — Associates
 * and Interns — sees the jobs they created and the jobs of the clients
 * assigned to them, whatever scope their grant carries. The filter is folded
 * into the query, so an out-of-scope id answers 404 like a missing one.
 */
export async function jobVisibility(session: Session, permission: PermissionCode): Promise<{ organisationId: string; AND?: object[] }> {
  const { organisationId } = await prisma.user.findUniqueOrThrow({ where: { id: session.userId }, select: { organisationId: true } })
  if (can(session, permission, 'organisation') && seesAllClients(session)) return { organisationId }
  const ids = await assignedClientIds(session, 'self')
  return {
    organisationId,
    AND: [{ OR: [{ createdByUserId: session.userId }, { clientId: { in: ids === 'ALL' ? [] : ids } }] }],
  }
}

/**
 * The route-level client check for a job id: the creator always reaches
 * their own job; anyone else needs the client to be visible to them. An id
 * that does not exist (`job` undefined) is left to the service's 404.
 */
export async function assertJobVisible(session: Session, job: { clientId: string; createdByUserId: string } | null | undefined): Promise<void> {
  if (!job || job.createdByUserId === session.userId) return
  await assertClientVisible(session, job.clientId)
}
