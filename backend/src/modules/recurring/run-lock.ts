import { prisma } from '../../lib/prisma.js'

/**
 * Run a scheduled job at most once at a time across every API process.
 *
 * A transaction-scoped advisory lock (pg_try_advisory_xact_lock) is taken on
 * one pooled connection and held until that transaction ends; the job itself
 * runs on the normal client while it is held. A session-level
 * pg_advisory_lock/unlock pair through Prisma's pool could lock on one
 * connection and unlock on another, leaking the lock — the xact form cannot.
 *
 * Returns null when another process already holds the lock (that run is
 * skipped, not queued).
 */
export async function withRunLock<T>(name: string, fn: () => Promise<T>, timeoutMs = 10 * 60_000): Promise<T | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ got: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`run:${name}`})) AS got`
    if (!rows[0]?.got) return null
    return fn()
  }, { maxWait: 10_000, timeout: timeoutMs })
}
