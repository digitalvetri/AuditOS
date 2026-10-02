import type { Request } from 'express'
import { prisma } from '../lib/prisma.js'

/**
 * AuditLog primitive (§8.9 / §10). Append-only: there is no update and no
 * delete path to this table anywhere in the application.
 *
 * A failed write must never take down the operation that was being audited,
 * so this swallows its own errors after logging them.
 */
export async function writeAudit(input: {
  actorUserId: string | null
  action: string
  entityType: string
  entityId: string
  before?: unknown
  after?: unknown
  req?: Request
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        beforeJson: input.before === undefined ? null : JSON.stringify(input.before),
        afterJson: input.after === undefined ? null : JSON.stringify(input.after),
        ip: input.req?.ip ?? null,
        userAgent: input.req?.headers['user-agent'] ?? null,
      },
    })
  } catch (err) {
    console.error('[audit] failed to write entry', err instanceof Error ? err.message : err)
  }
}
