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
export const BookkeepingBootstrapService = {
  async ensure(companyId: string): Promise<{ voucherTypesCreated: number; gstLedgersCreated: number }> {
    const existingTypes = await prisma.tallyVoucherType.findMany({
      where: { tallyCompanyId: companyId, ...alive }, select: { code: true },
    })
    const haveCodes = new Set(existingTypes.map((t) => t.code))
    const missing = VOUCHER_TYPE_SEEDS.filter((s) => !haveCodes.has(s.code))
    if (missing.length) {
      await prisma.tallyVoucherType.createMany({
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
    const duties = await prisma.tallyGroup.findFirst({
      where: { tallyCompanyId: companyId, name: 'Duties & Taxes', ...alive }, select: { id: true },
    })
    if (duties) {
      const have = await prisma.tallyLedger.findMany({
        where: { tallyCompanyId: companyId, name: { in: GST_LEDGER_SEEDS.map((g) => g.name) }, ...alive },
        select: { name: true },
      })
      const haveNames = new Set(have.map((l) => l.name))
      const toCreate = GST_LEDGER_SEEDS.filter((g) => !haveNames.has(g.name))
      if (toCreate.length) {
        await prisma.tallyLedger.createMany({
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

    const unitCount = await prisma.tallyUnit.count({ where: { tallyCompanyId: companyId, ...alive } })
    if (unitCount === 0) {
      await prisma.tallyUnit.createMany({
        data: [
          { tallyCompanyId: companyId, name: 'Nos', decimals: 0 },
          { tallyCompanyId: companyId, name: 'Kg', decimals: 3 },
          { tallyCompanyId: companyId, name: 'Ltr', decimals: 3 },
          { tallyCompanyId: companyId, name: 'Hrs', decimals: 2 },
        ],
        skipDuplicates: true,
      })
    }
    const godownCount = await prisma.tallyGodown.count({ where: { tallyCompanyId: companyId, ...alive } })
    if (godownCount === 0) {
      await prisma.tallyGodown.create({ data: { tallyCompanyId: companyId, name: 'Main Location' } })
    }

    return { voucherTypesCreated: missing.length, gstLedgersCreated }
  },
}
