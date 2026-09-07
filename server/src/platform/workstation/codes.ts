import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * Human-readable id allocation — 'LD-1001', 'CLI-1001' (§5.2).
 *
 * Allocated SERVER-SIDE, inside the transaction that creates the row, by
 * reading the current maximum. Never `count() + 1` outside a transaction:
 * with a soft-deleted row or two concurrent creates that reuses a code, and
 * `leadCode`/`clientCode` are @unique so the second insert would simply fail.
 *
 * Both sequences start at 1001 so the first record reads 'LD-1001', matching
 * the examples in the build prompt.
 */
type Tx = Prisma.TransactionClient | PrismaClient

const START = 1001

function nextFrom(codes: string[], prefix: string): string {
  let max = START - 1
  for (const c of codes) {
    const n = Number(c.slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${max + 1}`
}

export async function nextLeadCode(tx: Tx): Promise<string> {
  // Soft-deleted rows are INCLUDED deliberately — a retired code must never
  // be handed out again.
  const rows = await tx.lead.findMany({ select: { leadCode: true } })
  return nextFrom(rows.map((r) => r.leadCode), 'LD-')
}

export async function nextClientCode(tx: Tx): Promise<string> {
  const rows = await tx.client.findMany({ select: { clientCode: true } })
  return nextFrom(rows.map((r) => r.clientCode), 'CLI-')
}
