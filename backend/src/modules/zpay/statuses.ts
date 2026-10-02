/**
 * Which Zoho Payments statuses are money received. Zoho's list also returns
 * attempts that never completed (initiated, failed, canceled, incomplete,
 * blocked); those are not collections and must never match an invoice.
 * `captured` is the pre-live fixture's word for succeeded.
 */
export const COLLECTED_PAYMENT_STATUSES = ['succeeded', 'refunded', 'partially_refunded', 'disputed', 'captured'] as const

/** A refund counts once it has gone through (`processed`: fixture word). */
export const COMPLETED_REFUND_STATUSES = ['succeeded', 'processed'] as const

export const isCollected = (status: string) => (COLLECTED_PAYMENT_STATUSES as readonly string[]).includes(status)

/** Prisma filter for collected payments. */
export const collectedWhere = { status: { in: [...COLLECTED_PAYMENT_STATUSES] as string[] } }
