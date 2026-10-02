import type { Request } from 'express'
import { prisma } from '../../../lib/prisma.js'
import { writeAudit } from '../../../platform/audit.js'
import type { Session } from '../../../platform/auth.js'

/**
 * Tools audit trail — a thin, typed layer over the platform's append-only
 * AuditLog primitive (§12). Every action is namespaced `tools.<event>` and
 * anchored on the ToolDocument it concerns, so the Documents detail drawer
 * can read one document's whole history with a single indexed query.
 *
 * The extra facts the spec asks for (tool, status, metadata) travel in
 * afterJson; the existing table already carries actor, ip, user-agent and
 * timestamp. No new table, no new column on a table another module owns.
 */
export type ToolAuditAction =
  | 'upload'
  | 'conversion_started'
  | 'conversion_completed'
  | 'conversion_failed'
  | 'download'
  | 'preview'
  | 'delete'
  | 'unlock_authorised'
  | 'esign_applied'

export type ToolAuditStatus = 'success' | 'failed' | 'info'

export interface ToolAuditEntry {
  id: string
  action: string
  status: ToolAuditStatus
  tool_id: string | null
  document_id: string | null
  actor: { id: string; label: string } | null
  meta: Record<string, unknown>
  created_at: string
}

export const AuditLogService = {
  async log(input: {
    session: Pick<Session, 'userId'>
    action: ToolAuditAction
    toolId?: string | null
    documentId?: string | null
    jobId?: string | null
    status: ToolAuditStatus
    meta?: Record<string, unknown>
    req?: Request
  }): Promise<void> {
    await writeAudit({
      actorUserId: input.session.userId,
      action: `tools.${input.action}`,
      entityType: 'ToolDocument',
      entityId: input.documentId ?? input.jobId ?? 'none',
      after: {
        tool_id: input.toolId ?? null,
        document_id: input.documentId ?? null,
        job_id: input.jobId ?? null,
        status: input.status,
        ...(input.meta ?? {}),
      },
      req: input.req,
    })
  },

  /** Every entry anchored on this document, oldest first. */
  async forDocument(documentIds: string[]): Promise<ToolAuditEntry[]> {
    if (documentIds.length === 0) return []
    const rows = await prisma.auditLog.findMany({
      where: { entityType: 'ToolDocument', entityId: { in: documentIds } },
      include: { actor: { include: { employee: true } } },
      orderBy: { createdAt: 'asc' },
    })
    return rows.map((r) => {
      let after: Record<string, unknown> = {}
      try { after = r.afterJson ? (JSON.parse(r.afterJson) as Record<string, unknown>) : {} } catch { /* keep {} */ }
      const { tool_id, document_id, status, job_id: _job, ...meta } = after
      return {
        id: r.id,
        action: r.action,
        status: (status as ToolAuditStatus) ?? 'info',
        tool_id: (tool_id as string | null) ?? null,
        document_id: (document_id as string | null) ?? r.entityId,
        actor: r.actor ? { id: r.actor.id, label: r.actor.employee?.fullName ?? r.actor.email } : null,
        meta,
        created_at: r.createdAt.toISOString(),
      }
    })
  },
}
