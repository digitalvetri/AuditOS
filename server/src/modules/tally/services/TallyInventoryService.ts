import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { TallyCompanyService } from './TallyCompanyService.js'
import { TallyBootstrapService } from './TallyBootstrapService.js'
import { stockPositions, stockMovement, godownStock, type StockFilter } from '../engine/inventory.js'

/**
 * TallyInventoryService — inventory MASTERS (stock groups, categories,
 * units, godowns, items, batches, opening stock) plus the read models.
 *
 * Inventory TRANSACTIONS are vouchers and go through the posting engine
 * like everything else; there is no separate inventory writer.
 */

async function own(session: Session, companyId: string) {
  await TallyCompanyService.requireOwned(session, companyId)
  await TallyBootstrapService.ensure(companyId)
}

async function assertUniqueName(model: 'tallyStockGroup' | 'tallyStockCategory' | 'tallyUnit' | 'tallyGodown' | 'tallyStockItem', companyId: string, name: string, excludeId?: string) {
  const delegate = prisma[model] as unknown as { findFirst: (a: unknown) => Promise<{ id: string } | null> }
  const clash = await delegate.findFirst({
    where: { tallyCompanyId: companyId, name, ...alive, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    select: { id: true },
  })
  if (clash) throw ApiError.conflict('duplicate_name', `"${name}" already exists.`)
}

export const TallyInventoryService = {
  // ── Stock groups ───────────────────────────────────────────────────
  async listStockGroups(session: Session, companyId: string) {
    await own(session, companyId)
    const rows = await prisma.tallyStockGroup.findMany({ where: { tallyCompanyId: companyId, ...alive }, orderBy: { name: 'asc' } })
    return rows.map((r) => ({ id: r.id, name: r.name, parent_id: r.parentId }))
  },
  async createStockGroup(session: Session, companyId: string, input: { name: string; parentId?: string | null }) {
    await own(session, companyId)
    const name = input.name.trim()
    if (!name) throw ApiError.badRequest('Name is required.')
    await assertUniqueName('tallyStockGroup', companyId, name)
    if (input.parentId) {
      const parent = await prisma.tallyStockGroup.findFirst({ where: { id: input.parentId, tallyCompanyId: companyId, ...alive } })
      if (!parent) throw ApiError.badRequest('Parent stock group does not belong to this company.')
    }
    const r = await prisma.tallyStockGroup.create({ data: { tallyCompanyId: companyId, name, parentId: input.parentId ?? null } })
    return { id: r.id, name: r.name, parent_id: r.parentId }
  },

  // ── Categories ─────────────────────────────────────────────────────
  async listCategories(session: Session, companyId: string) {
    await own(session, companyId)
    const rows = await prisma.tallyStockCategory.findMany({ where: { tallyCompanyId: companyId, ...alive }, orderBy: { name: 'asc' } })
    return rows.map((r) => ({ id: r.id, name: r.name }))
  },
  async createCategory(session: Session, companyId: string, name: string) {
    await own(session, companyId)
    const n = name.trim()
    if (!n) throw ApiError.badRequest('Name is required.')
    await assertUniqueName('tallyStockCategory', companyId, n)
    const r = await prisma.tallyStockCategory.create({ data: { tallyCompanyId: companyId, name: n } })
    return { id: r.id, name: r.name }
  },

  // ── Units ──────────────────────────────────────────────────────────
  async listUnits(session: Session, companyId: string) {
    await own(session, companyId)
    const rows = await prisma.tallyUnit.findMany({ where: { tallyCompanyId: companyId, ...alive }, orderBy: { name: 'asc' } })
    return rows.map((r) => ({ id: r.id, name: r.name, decimals: r.decimals }))
  },
  async createUnit(session: Session, companyId: string, input: { name: string; decimals?: number }) {
    await own(session, companyId)
    const name = input.name.trim()
    if (!name) throw ApiError.badRequest('Name is required.')
    await assertUniqueName('tallyUnit', companyId, name)
    const r = await prisma.tallyUnit.create({ data: { tallyCompanyId: companyId, name, decimals: input.decimals ?? 0 } })
    return { id: r.id, name: r.name, decimals: r.decimals }
  },

  // ── Godowns ────────────────────────────────────────────────────────
  async listGodowns(session: Session, companyId: string) {
    await own(session, companyId)
    const rows = await prisma.tallyGodown.findMany({ where: { tallyCompanyId: companyId, ...alive }, orderBy: { name: 'asc' } })
    return rows.map((r) => ({ id: r.id, name: r.name, address: r.address, parent_id: r.parentId }))
  },
  async createGodown(session: Session, companyId: string, input: { name: string; address?: string | null; parentId?: string | null }) {
    await own(session, companyId)
    const name = input.name.trim()
    if (!name) throw ApiError.badRequest('Name is required.')
    await assertUniqueName('tallyGodown', companyId, name)
    const r = await prisma.tallyGodown.create({
      data: { tallyCompanyId: companyId, name, address: input.address ?? null, parentId: input.parentId ?? null },
    })
    return { id: r.id, name: r.name, address: r.address, parent_id: r.parentId }
  },

  // ── Stock items ────────────────────────────────────────────────────
  async listItems(session: Session, companyId: string, filter: { q?: string; stockGroupId?: string } = {}) {
    await own(session, companyId)
    const rows = await prisma.tallyStockItem.findMany({
      where: {
        tallyCompanyId: companyId, ...alive,
        ...(filter.stockGroupId ? { stockGroupId: filter.stockGroupId } : {}),
        ...(filter.q ? { name: { contains: filter.q, mode: 'insensitive' as const } } : {}),
      },
      include: { unit: { select: { name: true } }, stockGroup: { select: { name: true } }, openings: true },
      orderBy: { name: 'asc' },
    })
    return rows.map((r) => ({
      id: r.id, name: r.name, stock_group_id: r.stockGroupId, stock_group_name: r.stockGroup?.name ?? null,
      category_id: r.categoryId, unit_id: r.unitId, unit_name: r.unit?.name ?? null,
      hsn_code: r.hsnCode, gst_rate_bp: r.gstRateBp, reorder_level_milli: r.reorderLevelMilli,
      standard_cost_paise: r.standardCostPaise, standard_price_paise: r.standardPricePaise,
      valuation_method: r.valuationMethod, batch_tracking: r.batchTracking, active: r.active,
      opening_qty_milli: r.openings.reduce((s, o) => s + o.qtyMilli, 0),
      opening_value_paise: r.openings.reduce((s, o) => s + o.valuePaise, 0),
    }))
  },

  async createItem(session: Session, companyId: string, input: {
    name: string; stockGroupId?: string | null; categoryId?: string | null; unitId?: string | null
    hsnCode?: string | null; gstRateBp?: number; reorderLevelMilli?: number
    standardCostPaise?: number; standardPricePaise?: number; valuationMethod?: string; batchTracking?: boolean
    openingQtyMilli?: number; openingRatePaise?: number; openingGodownId?: string | null
  }) {
    await own(session, companyId)
    const name = input.name.trim()
    if (!name) throw ApiError.badRequest('Item name is required.')
    await assertUniqueName('tallyStockItem', companyId, name)

    return prisma.$transaction(async (tx) => {
      const item = await tx.tallyStockItem.create({
        data: {
          tallyCompanyId: companyId, name,
          stockGroupId: input.stockGroupId ?? null,
          categoryId: input.categoryId ?? null,
          unitId: input.unitId ?? null,
          hsnCode: input.hsnCode?.trim() || null,
          gstRateBp: input.gstRateBp ?? 0,
          reorderLevelMilli: input.reorderLevelMilli ?? 0,
          standardCostPaise: input.standardCostPaise ?? 0,
          standardPricePaise: input.standardPricePaise ?? 0,
          valuationMethod: input.valuationMethod ?? 'avg',
          batchTracking: input.batchTracking ?? false,
        },
      })
      if (input.openingQtyMilli) {
        const rate = input.openingRatePaise ?? 0
        await tx.tallyStockOpening.create({
          data: {
            tallyCompanyId: companyId, stockItemId: item.id,
            godownId: input.openingGodownId ?? null,
            qtyMilli: input.openingQtyMilli,
            ratePaise: rate,
            valuePaise: Math.round((input.openingQtyMilli * rate) / 1000),
          },
        })
      }
      return { id: item.id, name: item.name }
    })
  },

  async updateItem(session: Session, companyId: string, itemId: string, patch: Record<string, unknown>) {
    await own(session, companyId)
    const existing = await prisma.tallyStockItem.findFirst({ where: { id: itemId, tallyCompanyId: companyId, ...alive } })
    if (!existing) throw ApiError.notFound('No such stock item.')
    if (typeof patch.name === 'string') await assertUniqueName('tallyStockItem', companyId, patch.name.trim(), itemId)
    const row = await prisma.tallyStockItem.update({ where: { id: itemId }, data: patch })
    return { id: row.id, name: row.name }
  },

  async setOpeningStock(session: Session, companyId: string, itemId: string, input: { qtyMilli: number; ratePaise: number; godownId?: string | null; batchId?: string | null }) {
    await own(session, companyId)
    const item = await prisma.tallyStockItem.findFirst({ where: { id: itemId, tallyCompanyId: companyId, ...alive } })
    if (!item) throw ApiError.notFound('No such stock item.')
    const existing = await prisma.tallyStockOpening.findFirst({
      where: { tallyCompanyId: companyId, stockItemId: itemId, godownId: input.godownId ?? null, batchId: input.batchId ?? null },
    })
    const value = Math.round((input.qtyMilli * input.ratePaise) / 1000)
    if (existing) {
      await prisma.tallyStockOpening.update({ where: { id: existing.id }, data: { qtyMilli: input.qtyMilli, ratePaise: input.ratePaise, valuePaise: value } })
    } else {
      await prisma.tallyStockOpening.create({
        data: {
          tallyCompanyId: companyId, stockItemId: itemId,
          godownId: input.godownId ?? null, batchId: input.batchId ?? null,
          qtyMilli: input.qtyMilli, ratePaise: input.ratePaise, valuePaise: value,
        },
      })
    }
    return { stock_item_id: itemId, qty_milli: input.qtyMilli, value_paise: value }
  },

  async createBatch(session: Session, companyId: string, itemId: string, input: { name: string; mfgDate?: string | null; expiryDate?: string | null }) {
    await own(session, companyId)
    const item = await prisma.tallyStockItem.findFirst({ where: { id: itemId, tallyCompanyId: companyId, ...alive } })
    if (!item) throw ApiError.notFound('No such stock item.')
    const r = await prisma.tallyStockBatch.create({
      data: { tallyCompanyId: companyId, stockItemId: itemId, name: input.name.trim(), mfgDate: input.mfgDate ?? null, expiryDate: input.expiryDate ?? null },
    })
    return { id: r.id, name: r.name, stock_item_id: r.stockItemId }
  },

  async listBatches(session: Session, companyId: string, itemId: string) {
    await own(session, companyId)
    const rows = await prisma.tallyStockBatch.findMany({ where: { tallyCompanyId: companyId, stockItemId: itemId }, orderBy: { name: 'asc' } })
    return rows.map((r) => ({ id: r.id, name: r.name, mfg_date: r.mfgDate, expiry_date: r.expiryDate }))
  },

  // ── Reports ────────────────────────────────────────────────────────
  async summary(session: Session, companyId: string, filter: StockFilter = {}) {
    await own(session, companyId)
    const rows = await stockPositions(companyId, filter)
    return {
      items: rows.map((r) => ({
        stock_item_id: r.stockItemId, stock_item_name: r.stockItemName,
        stock_group_name: r.stockGroupName, unit_name: r.unitName, hsn_code: r.hsnCode,
        opening_qty_milli: r.openingQtyMilli, opening_value_paise: r.openingValuePaise,
        inward_qty_milli: r.inwardQtyMilli, inward_value_paise: r.inwardValuePaise,
        outward_qty_milli: r.outwardQtyMilli, outward_value_paise: r.outwardValuePaise,
        closing_qty_milli: r.closingQtyMilli, closing_value_paise: r.closingValuePaise,
        avg_rate_paise: r.avgRatePaise, reorder_level_milli: r.reorderLevelMilli,
        below_reorder: r.belowReorder, negative: r.negative,
      })),
      totals: {
        closing_value_paise: rows.reduce((s, r) => s + r.closingValuePaise, 0),
        negative_count: rows.filter((r) => r.negative).length,
        below_reorder_count: rows.filter((r) => r.belowReorder).length,
      },
    }
  },

  async movement(session: Session, companyId: string, itemId: string, filter: StockFilter = {}) {
    await own(session, companyId)
    const rows = await stockMovement(companyId, itemId, filter)
    return {
      rows: rows.map((r) => ({
        voucher_id: r.voucherId, voucher_number: r.voucherNumber, voucher_type_code: r.voucherTypeCode,
        date: r.date, direction: r.direction, godown_name: r.godownName, batch_name: r.batchName,
        qty_milli: r.qtyMilli, rate_paise: r.ratePaise, amount_paise: r.amountPaise, party_name: r.partyName,
      })),
    }
  },

  async godownSummary(session: Session, companyId: string, filter: StockFilter = {}) {
    await own(session, companyId)
    const rows = await godownStock(companyId, filter)
    return {
      rows: rows.map((r) => ({
        godown_id: r.godownId, godown_name: r.godownName,
        stock_item_id: r.stockItemId, stock_item_name: r.stockItemName, closing_qty_milli: r.closingQtyMilli,
      })),
    }
  },
}
