import type { PrismaClient } from '@prisma/client'

/**
 * The ten default parent-group mappings from spec §6.5. Seeded as
 * isSystem=true so a firm can add custom groups (e.g. "Loans to Directors")
 * without touching these rows; a UI for that is a follow-up.
 *
 * Names match Tally's default group labels VERBATIM — the reports classifier
 * looks these up trimmed and case-insensitive, so exact case is not
 * critical, but keeping them as Tally exports them makes debug output
 * easier to read.
 */
export const DEFAULT_LEDGER_GROUPS: readonly {
  name: string; category: string; subtype: string
}[] = [
  { name: 'Bank Accounts',    category: 'asset',     subtype: 'bank' },
  { name: 'Cash-in-Hand',     category: 'asset',     subtype: 'cash' },
  { name: 'Sundry Debtors',   category: 'asset',     subtype: 'receivable' },
  { name: 'Sundry Creditors', category: 'liability', subtype: 'payable' },
  { name: 'Duties & Taxes',   category: 'liability', subtype: 'gst' },
  { name: 'Sales Accounts',   category: 'income',    subtype: 'other' },
  { name: 'Purchase Accounts',category: 'expense',   subtype: 'other' },
  { name: 'Direct Expenses',  category: 'expense',   subtype: 'other' },
  { name: 'Indirect Expenses',category: 'expense',   subtype: 'other' },
  { name: 'Capital Account',  category: 'equity',    subtype: 'other' },
]

export async function seedBookkeepingLedgerGroups(prisma: PrismaClient): Promise<number> {
  for (const g of DEFAULT_LEDGER_GROUPS) {
    await prisma.bookkeepingLedgerGroup.upsert({
      where: { name: g.name },
      update: { category: g.category, subtype: g.subtype, isSystem: true, deletedAt: null },
      create: { name: g.name, category: g.category, subtype: g.subtype, isSystem: true },
    })
  }
  return DEFAULT_LEDGER_GROUPS.length
}
