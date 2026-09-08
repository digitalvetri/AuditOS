import type { BooksContext, Db } from './context.js'

/**
 * Append-only audit trail for Books. Called inside the same transaction as
 * the change it records, so a change without its audit event cannot
 * commit. Database triggers forbid UPDATE / DELETE on the table.
 */
export async function booksAudit(db: Db, ctx: BooksContext, input: {
  entityType: string
  entityId: string
  action: string
  before?: unknown
  after?: unknown
}): Promise<void> {
  await db.booksAuditEvent.create({
    data: {
      booksOrgId: ctx.booksOrgId,
      actorUserId: ctx.userId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      beforeJson: input.before === undefined ? null : JSON.stringify(input.before, bigintReplacer),
      afterJson: input.after === undefined ? null : JSON.stringify(input.after, bigintReplacer),
      ip: ctx.ip ?? null,
    },
  })
}

export function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v
}
