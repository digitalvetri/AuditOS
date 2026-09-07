import { prisma } from '../../lib/prisma.js'
import type { Session } from '../auth.js'

/**
 * THE ACTIVITY TIMELINE (AUDIT_OS_WORKSTATION.md §11).
 *
 * Distinct from AuditLog on purpose: AuditLog is the security trail (who
 * touched what, with before/after), Activity is the story a colleague reads
 * on a lead or client. An action usually writes BOTH.
 *
 * This lives in the service layer rather than in handlers so "every important
 * action appends to the timeline" is structural instead of remembered. Like
 * writeAudit, a failure here must never take down the operation it describes.
 */
export type ActivitySubject = 'lead' | 'client'

export interface ActivityInput {
  session: Session
  subjectType: ActivitySubject
  subjectId: string
  action: string
  description: string
  entityType?: string
  entityId?: string
  meta?: unknown
}

export async function writeActivity(input: ActivityInput): Promise<void> {
  try {
    await prisma.activity.create({
      data: {
        organisationId: 'org-audit-os',
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        action: input.action,
        description: input.description,
        actorUserId: input.session.userId,
        actorEmployeeId: input.session.employeeId,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        metaJson: input.meta === undefined ? null : JSON.stringify(input.meta),
      },
    })
  } catch (err) {
    console.error('[activity] failed to write entry', err instanceof Error ? err.message : err)
  }
}

/** Several entries in one call, in order, for a multi-step action like conversion. */
export async function writeActivities(entries: ActivityInput[]): Promise<void> {
  for (const e of entries) await writeActivity(e)
}
