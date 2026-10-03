import { prisma, alive } from '../../../lib/prisma.js'
import { VOUCHER_TYPE_SEEDS, GST_LEDGER_SEEDS } from '../engine/voucherTypes.js'

/**
 * Company scaffolding beyond the primary groups the foundation slice
 * already seeds: voucher types, the six GST ledgers, a default unit and
 * a default godown.
 *
 * IDEMPOTENT BY DESIGN. It runs when a company is created and again,
 * lazily, the first time a company's vouchers are touched — so companies
 * created before this slice existed pick up their voucher types without
 * a data migration and without ever double-seeding.
 */
/**
 * Operational ledgers the import deriver needs. buildLedgerSnapshot picks
 * the alphabetical-first ledger under each group as the default — without
 * at least one, every imported sales/purchase row flags as
 * `no_sales_ledger` / `no_purchase_ledger` and the commit button never
 * enables. A firm that renames or adds their own ("Sales — Services",
 * "Office Supplies Purchased") keeps that as the alphabetical-first
 * default; we only seed when the group is empty so nothing surprising
 * ever shows up alongside their own names.
 */
const OPERATIONAL_LEDGER_SEEDS: { groupName: string; ledgerName: string }[] = [
  { groupName: 'Sales Accounts', ledgerName: 'Sales' },
  { groupName: 'Purchase Accounts', ledgerName: 'Purchases' },
]

export const BookkeepingBootstrapService = {
  async ensure(companyId: string): Promise<{ voucherTypesCreated: number; gstLedgersCreated: number; operationalLedgersCreated: number }> {
    const existingTypes = await prisma.bookkeepingVoucherType.findMany({
      where: { tallyCompanyId: companyId, ...alive }, select: { code: true },
    })
    const haveCodes = new Set(existingTypes.map((t) => t.code))
    const missing = VOUCHER_TYPE_SEEDS.filter((s) => !haveCodes.has(s.code))
    if (missing.length) {
      await prisma.bookkeepingVoucherType.createMany({
        data: missing.map((s) => ({
          tallyCompanyId: companyId,
          name: s.name,
          code: s.code,
          prefix: s.prefix ?? null,
          affectsAccounts: s.affectsAccounts,
          affectsStock: s.affectsStock,
          isOrder: s.isOrder,
          isDefault: true,
        })),
        skipDuplicates: true,
      })
    }

    // GST ledgers live under Duties & Taxes and carry their component in
    // taxConfigJson — that JSON, not the ledger name, is what the engine
    // and the GST reports key off.
    let gstLedgersCreated = 0
    const duties = await prisma.bookkeepingGroup.findFirst({
      where: { tallyCompanyId: companyId, name: 'Duties & Taxes', ...alive }, select: { id: true },
    })
    if (duties) {
      const have = await prisma.bookkeepingLedger.findMany({
        where: { tallyCompanyId: companyId, name: { in: GST_LEDGER_SEEDS.map((g) => g.name) }, ...alive },
        select: { name: true },
      })
      const haveNames = new Set(have.map((l) => l.name))
      const toCreate = GST_LEDGER_SEEDS.filter((g) => !haveNames.has(g.name))
      if (toCreate.length) {
        await prisma.bookkeepingLedger.createMany({
          data: toCreate.map((g) => ({
            tallyCompanyId: companyId,
            name: g.name,
            groupId: duties.id,
            taxConfigJson: JSON.stringify({ gst_component: g.component, gst_direction: g.direction }),
          })),
          skipDuplicates: true,
        })
        gstLedgersCreated = toCreate.length
      }
    }

    // Operational default ledgers (Sales / Purchases). Seed one per group
    // only when the group has none, so an existing company that already
    // added its own ("Sales — Services") doesn't suddenly see a stock
    // "Sales" row appear beside it on the next ensure() pass.
    let operationalLedgersCreated = 0
    for (const seed of OPERATIONAL_LEDGER_SEEDS) {
      const group = await prisma.bookkeepingGroup.findFirst({
        where: { tallyCompanyId: companyId, name: seed.groupName, ...alive },
        select: { id: true },
      })
      if (!group) continue
      const existing = await prisma.bookkeepingLedger.count({
        where: { tallyCompanyId: companyId, groupId: group.id, ...alive },
      })
      if (existing > 0) continue
      try {
        await prisma.bookkeepingLedger.create({
          data: {
            tallyCompanyId: companyId,
            name: seed.ledgerName,
            groupId: group.id,
          },
        })
        operationalLedgersCreated++
      } catch {
        // Unique (tallyCompanyId, name) collision — someone created a
        // ledger of the same name under a different group between our
        // check and insert. Treat as success-equivalent and move on.
      }
    }

    const unitCount = await prisma.bookkeepingUnit.count({ where: { tallyCompanyId: companyId, ...alive } })
    if (unitCount === 0) {
      await prisma.bookkeepingUnit.createMany({
        data: [
          { tallyCompanyId: companyId, name: 'Nos', decimals: 0 },
          { tallyCompanyId: companyId, name: 'Kg', decimals: 3 },
          { tallyCompanyId: companyId, name: 'Ltr', decimals: 3 },
          { tallyCompanyId: companyId, name: 'Hrs', decimals: 2 },
        ],
        skipDuplicates: true,
      })
    }
    const godownCount = await prisma.bookkeepingGodown.count({ where: { tallyCompanyId: companyId, ...alive } })
    if (godownCount === 0) {
      await prisma.bookkeepingGodown.create({ data: { tallyCompanyId: companyId, name: 'Main Location' } })
    }

    return { voucherTypesCreated: missing.length, gstLedgersCreated, operationalLedgersCreated }
  },
}
