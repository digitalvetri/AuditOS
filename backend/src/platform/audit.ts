import crypto from 'node:crypto'
import type { Request } from 'express'
import { prisma } from '../lib/prisma.js'
import { stringifyJson } from '../lib/json.js'
import { lockSequence } from '../lib/sequence.js'

/**
 * AuditLog primitive (§8.9 / §10). Append-only: there is no update and no
 * delete path to this table anywhere in the application.
 *
 * Tamper evidence: every row carries `hash = sha256(prevHash + canonical
 * content)`, where `prevHash` is the hash of the row written just before it.
 * Editing, deleting or re-ordering any row breaks the chain from that point,
 * which GET /api/platform/audit-log/verify reports. Rows written before the
 * chain existed have no hash and are skipped as "pre-chain".
 *
 * Race safety: reading the last hash and inserting the next row run under one
 * transaction-scoped advisory lock, so two concurrent writers cannot both
 * chain to the same predecessor.
 *
 * A failed write must never take down the operation that was being audited,
 * so this swallows its own errors after logging them.
 */
export const AUDIT_CHAIN_LOCK = 'audit_log_chain'

export interface AuditHashInput {
  actorUserId: string | null
  action: string
  entityType: string
  entityId: string
  beforeJson: string | null
  afterJson: string | null
  ip: string | null
  createdAt: Date
}

/** Fixed key order — the canonical form the hash is computed over. */
export function auditHash(prevHash: string | null, row: AuditHashInput): string {
  const canonical = JSON.stringify({
    actorUserId: row.actorUserId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    beforeJson: row.beforeJson,
    afterJson: row.afterJson,
    ip: row.ip,
    createdAt: row.createdAt.toISOString(),
  })
  return crypto.createHash('sha256').update(`${prevHash ?? ''}|${canonical}`).digest('hex')
}

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
    const content: AuditHashInput = {
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      beforeJson: input.before === undefined ? null : stringifyJson(input.before),
      afterJson: input.after === undefined ? null : stringifyJson(input.after),
      ip: input.req?.ip ?? null,
      // Set here (not by the DB default) so the hashed value is exactly the
      // stored one. Millisecond precision survives a Postgres timestamp(3).
      createdAt: new Date(),
    }
    const userAgent = input.req?.headers['user-agent'] ?? null
    await prisma.$transaction(async (tx) => {
      await lockSequence(tx, AUDIT_CHAIN_LOCK)
      const last = await tx.auditLog.findFirst({
        where: { hash: { not: null } }, orderBy: { seq: 'desc' }, select: { hash: true },
      })
      const prevHash = last?.hash ?? null
      await tx.auditLog.create({
        data: { ...content, userAgent, prevHash, hash: auditHash(prevHash, content) },
      })
    }, { maxWait: 15_000, timeout: 15_000 })
  } catch (err) {
    console.error('[audit] failed to write entry', err instanceof Error ? err.message : err)
  }
}

export interface ChainReport {
  ok: boolean
  /** Rows whose hash was recomputed and matched. */
  checked: number
  /** Rows written before the chain existed (no hash) — not verifiable. */
  pre_chain: number
  first_broken: null | {
    seq: number
    id: string
    reason: 'hash_mismatch' | 'prev_hash_mismatch'
    created_at: string
  }
}

/**
 * Walk the log in `seq` order and recompute every hash. Reports the first
 * row whose content no longer matches its hash, or whose `prevHash` is not
 * the hash of the previous chained row (a row deleted or inserted between).
 */
export async function verifyAuditChain(batchSize = 2000): Promise<ChainReport> {
  let checked = 0
  let preChain = 0
  let prev: string | null = null
  let started = false
  let cursor = -Infinity
  for (;;) {
    const rows = await prisma.auditLog.findMany({
      where: Number.isFinite(cursor) ? { seq: { gt: cursor } } : {},
      orderBy: { seq: 'asc' },
      take: batchSize,
    })
    if (!rows.length) break
    for (const r of rows) {
      cursor = r.seq
      if (!r.hash) {
        // A null hash AFTER the chain began is a row someone blanked.
        if (started) {
          return { ok: false, checked, pre_chain: preChain, first_broken: { seq: r.seq, id: r.id, reason: 'hash_mismatch', created_at: r.createdAt.toISOString() } }
        }
        preChain += 1
        continue
      }
      // The first chained row links to nothing; every later one to the
      // chained row before it. (Deleting the head shows up here too.)
      if (r.prevHash !== (started ? prev : null)) {
        return { ok: false, checked, pre_chain: preChain, first_broken: { seq: r.seq, id: r.id, reason: 'prev_hash_mismatch', created_at: r.createdAt.toISOString() } }
      }
      if (auditHash(r.prevHash, r) !== r.hash) {
        return { ok: false, checked, pre_chain: preChain, first_broken: { seq: r.seq, id: r.id, reason: 'hash_mismatch', created_at: r.createdAt.toISOString() } }
      }
      started = true
      prev = r.hash
      checked += 1
    }
  }
  return { ok: true, checked, pre_chain: preChain, first_broken: null }
}
