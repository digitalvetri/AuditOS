/**
 * Build the LedgerSnapshot deriveVouchers needs, from a company's actual
 * ledger book. Kept separate from the deriver so the deriver stays pure
 * (unit-testable with a hand-written snapshot). This file is the only
 * one that touches Prisma on the import-preview path.
 *
 * Naming discovery is deliberately best-effort:
 *   • The default sales ledger is the FIRST active ledger under
 *     the "Sales Accounts" primary group.
 *   • Purchase is the mirror on "Purchase Accounts".
 *   • Tax ledgers are matched by name pattern under "Duties & Taxes".
 *
 * If a firm names their sales ledger something unusual, deriveVouchers
 * still runs — it just flags the row as "no_sales_ledger" so the
 * operator creates one (or later, we expose a company-level default
 * selector in Settings).
 */
import type { PrismaClient } from '@prisma/client'
import type { LedgerSnapshot } from '../engine/deriveVouchers.js'
import type { MatchCandidate } from '../engine/partyMatch.js'

/**
 * Case-insensitive name-fragment lookup. Matches "Output CGST",
 * "CGST Output", "CGST Output @ 9%" all as CGST-output-shaped.
 */
function findByPatterns(
  ledgers: { id: string; name: string }[],
  patterns: RegExp[],
): string | null {
  for (const l of ledgers) {
    if (patterns.every((p) => p.test(l.name))) return l.id
  }
  return null
}

export async function buildLedgerSnapshot(
  prisma: PrismaClient,
  companyId: string,
): Promise<LedgerSnapshot> {
  // One query fetches every group + ledger the deriver could possibly
  // reference. Filtering happens in-memory — cheaper than five roundtrips.
  const groups = await prisma.bookkeepingGroup.findMany({
    where: { tallyCompanyId: companyId },
    select: { id: true, name: true },
  })
  const groupsByName = new Map(groups.map((g) => [g.name.toLowerCase(), g.id]))

  const groupId = (name: string) => groupsByName.get(name.toLowerCase()) ?? null

  const salesGroupId = groupId('Sales Accounts')
  const purchaseGroupId = groupId('Purchase Accounts')
  const dutiesGroupId = groupId('Duties & Taxes')
  const debtorsGroupId = groupId('Sundry Debtors')
  const creditorsGroupId = groupId('Sundry Creditors')

  const ledgers = await prisma.bookkeepingLedger.findMany({
    where: {
      tallyCompanyId: companyId,
      deletedAt: null,
      groupId: {
        in: [
          salesGroupId, purchaseGroupId, dutiesGroupId,
          debtorsGroupId, creditorsGroupId,
        ].filter((v): v is string => Boolean(v)),
      },
    },
    select: { id: true, name: true, groupId: true },
    orderBy: { name: 'asc' },
  })

  const byGroup = (gid: string | null) =>
    gid ? ledgers.filter((l) => l.groupId === gid) : []

  const sales = byGroup(salesGroupId)
  const purchase = byGroup(purchaseGroupId)
  const duties = byGroup(dutiesGroupId)
  const parties: MatchCandidate[] = [
    ...byGroup(debtorsGroupId),
    ...byGroup(creditorsGroupId),
  ].map((l) => ({ ledgerId: l.id, name: l.name }))

  return {
    parties,
    salesLedgerId: sales[0]?.id ?? null,
    purchaseLedgerId: purchase[0]?.id ?? null,
    cgstOutputLedgerId: findByPatterns(duties, [/cgst/i, /output/i]),
    sgstOutputLedgerId: findByPatterns(duties, [/sgst/i, /output/i]),
    igstOutputLedgerId: findByPatterns(duties, [/igst/i, /output/i]),
    cgstInputLedgerId: findByPatterns(duties, [/cgst/i, /input/i]),
    sgstInputLedgerId: findByPatterns(duties, [/sgst/i, /input/i]),
    igstInputLedgerId: findByPatterns(duties, [/igst/i, /input/i]),
  }
}
