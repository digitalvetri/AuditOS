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

/**
 * 'INC-2026-0001' — per-YEAR sequence, so a case code carries the year it was
 * opened. Same rule as the two above: read the maximum inside the creating
 * transaction, soft-deleted rows included, because a retired code must never
 * be handed out twice and `caseCode` is @unique.
 */
export async function nextIncorporationCaseCode(tx: Tx, year: number): Promise<string> {
  const prefix = `INC-${year}-`
  const rows = await tx.incorporationCase.findMany({
    where: { caseCode: { startsWith: prefix } },
    select: { caseCode: true },
  })
  let max = 0
  for (const r of rows) {
    const n = Number(r.caseCode.slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

/**
 * 'REG-2026-0001' — per-YEAR sequence, same rule as the incorporation case
 * code above: read the maximum inside the creating transaction, soft-deleted
 * rows included, because `registrationCode` is @unique and a retired code
 * must never be handed out twice.
 */
export async function nextRegistrationCode(tx: Tx, year: number): Promise<string> {
  const prefix = `REG-${year}-`
  const rows = await tx.clientRegistration.findMany({
    where: { registrationCode: { startsWith: prefix } },
    select: { registrationCode: true },
  })
  let max = 0
  for (const r of rows) {
    const n = Number(r.registrationCode.slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}
