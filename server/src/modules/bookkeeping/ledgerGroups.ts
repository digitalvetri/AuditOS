/**
 * BOOKKEEPING LEDGER GROUP CLASSIFIER.
 *
 * Maps a Tally parent group name → (category, subtype). Reads the
 * `BookkeepingLedgerGroup` config table so a firm's custom groups
 * ("Loans to Directors", "Advance Tax") classify without a code change.
 *
 * Every unknown group falls through to `other/other` — the row still
 * lands so a reviewer can add a group row and re-import rather than
 * losing the ledger entirely.
 */
import type { PrismaClient } from '@prisma/client'

export interface ClassifiedGroup { category: string; subtype: string }

const FALLBACK: ClassifiedGroup = { category: 'other', subtype: 'other' }

export async function loadLedgerGroups(
  prisma: PrismaClient,
): Promise<Map<string, ClassifiedGroup>> {
  const rows = await prisma.bookkeepingLedgerGroup.findMany({
    where: { deletedAt: null },
    select: { name: true, category: true, subtype: true },
  })
  const out = new Map<string, ClassifiedGroup>()
  for (const r of rows) out.set(normaliseGroupName(r.name), { category: r.category, subtype: r.subtype })
  return out
}

export function classify(
  groups: Map<string, ClassifiedGroup>,
  parentGroup: string,
): ClassifiedGroup {
  return groups.get(normaliseGroupName(parentGroup)) ?? FALLBACK
}

/**
 * Match on TRIMMED, CASE-INSENSITIVE parent-group name. "Bank Accounts",
 * " bank accounts " and "Bank  accounts" all point at the same config row —
 * that leniency saves a reviewer from tripping over whitespace in a Tally
 * export. Anything else (punctuation, ampersand vs "and") is deliberately
 * a different group and needs its own config row.
 */
export function normaliseGroupName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}
