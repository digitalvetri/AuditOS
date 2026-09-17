import { prisma, alive } from '../../../lib/prisma.js'

/**
 * INVENTORY — closing stock is opening stock plus every inward line
 * minus every outward line, computed here and nowhere else. There is no
 * running-quantity column to drift out of step with the vouchers.
 *
 * Quantities are integer MILLI-UNITS (qty x 1000); values are paise.
 */

export interface StockFilter {
  from?: string | null
  to?: string | null
  stockItemIds?: string[]
  godownId?: string | null
  batchId?: string | null
}

export interface StockPositionRow {
  stockItemId: string
  stockItemName: string
  stockGroupName: string | null
  unitName: string | null
  hsnCode: string | null
  openingQtyMilli: number
  openingValuePaise: number
  inwardQtyMilli: number
  inwardValuePaise: number
  outwardQtyMilli: number
  outwardValuePaise: number
  closingQtyMilli: number
  /** Closing value at the weighted-average rate of opening + inwards. */
  closingValuePaise: number
  avgRatePaise: number
  reorderLevelMilli: number
  belowReorder: boolean
  negative: boolean
}

/** Only these voucher types move stock; orders and quotations do not. */
const STOCK_VOUCHER_FILTER = { status: 'active', deletedAt: null, voucherType: { affectsStock: true, isOrder: false } }

export async function stockPositions(companyId: string, filter: StockFilter = {}): Promise<StockPositionRow[]> {
  const items = await prisma.tallyStockItem.findMany({
    where: {
      tallyCompanyId: companyId, ...alive,
      ...(filter.stockItemIds ? { id: { in: filter.stockItemIds } } : {}),
    },
    select: {
      id: true, name: true, hsnCode: true, reorderLevelMilli: true,
      stockGroup: { select: { name: true } }, unit: { select: { name: true } },
      openings: {
        where: {
          ...(filter.godownId ? { godownId: filter.godownId } : {}),
          ...(filter.batchId ? { batchId: filter.batchId } : {}),
        },
        select: { qtyMilli: true, valuePaise: true },
      },
    },
    orderBy: { name: 'asc' },
  })
  if (!items.length) return []

  const scope = {
    tallyCompanyId: companyId,
    ...(filter.godownId ? { godownId: filter.godownId } : {}),
    ...(filter.batchId ? { batchId: filter.batchId } : {}),
    stockItemId: { in: items.map((i) => i.id) },
  }

  // Lines before the period fold into opening; lines inside it are the movement.
  const [priorLines, periodLines] = await Promise.all([
    filter.from
      ? prisma.tallyVoucherItem.groupBy({
          by: ['stockItemId', 'direction'],
          where: { ...scope, voucher: { ...STOCK_VOUCHER_FILTER, date: { lt: filter.from } } },
          _sum: { qtyMilli: true, amountPaise: true },
        })
      : Promise.resolve([] as { stockItemId: string; direction: string; _sum: { qtyMilli: number | null; amountPaise: number | null } }[]),
    prisma.tallyVoucherItem.groupBy({
      by: ['stockItemId', 'direction'],
      where: {
        ...scope,
        voucher: {
          ...STOCK_VOUCHER_FILTER,
          ...(filter.from || filter.to
            ? { date: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
            : {}),
        },
      },
      _sum: { qtyMilli: true, amountPaise: true },
    }),
  ])

  const key = (id: string, d: string) => `${id}|${d}`
  const prior = new Map<string, { qty: number; value: number }>()
  for (const r of priorLines) prior.set(key(r.stockItemId, r.direction), { qty: r._sum.qtyMilli ?? 0, value: r._sum.amountPaise ?? 0 })
  const period = new Map<string, { qty: number; value: number }>()
  for (const r of periodLines) period.set(key(r.stockItemId, r.direction), { qty: r._sum.qtyMilli ?? 0, value: r._sum.amountPaise ?? 0 })

  return items.map((item) => {
    const openMaster = item.openings.reduce(
      (a, o) => ({ qty: a.qty + o.qtyMilli, value: a.value + o.valuePaise }),
      { qty: 0, value: 0 },
    )
    const pIn = prior.get(key(item.id, 'in')) ?? { qty: 0, value: 0 }
    const pOut = prior.get(key(item.id, 'out')) ?? { qty: 0, value: 0 }
    const openingQty = openMaster.qty + pIn.qty - pOut.qty
    const openingValue = openMaster.value + pIn.value - pOut.value

    const inward = period.get(key(item.id, 'in')) ?? { qty: 0, value: 0 }
    const outward = period.get(key(item.id, 'out')) ?? { qty: 0, value: 0 }
    const closingQty = openingQty + inward.qty - outward.qty

    // Weighted average of what the business actually paid for the stock
    // it held — sales prices never inflate a closing-stock valuation.
    const availQty = Math.max(openingQty, 0) + inward.qty
    const availValue = Math.max(openingValue, 0) + inward.value
    const avgRate = availQty > 0 ? Math.round((availValue * 1000) / availQty) : 0
    const closingValue = Math.round((closingQty * avgRate) / 1000)

    return {
      stockItemId: item.id,
      stockItemName: item.name,
      stockGroupName: item.stockGroup?.name ?? null,
      unitName: item.unit?.name ?? null,
      hsnCode: item.hsnCode,
      openingQtyMilli: openingQty,
      openingValuePaise: openingValue,
      inwardQtyMilli: inward.qty,
      inwardValuePaise: inward.value,
      outwardQtyMilli: outward.qty,
      outwardValuePaise: outward.value,
      closingQtyMilli: closingQty,
      closingValuePaise: closingValue,
      avgRatePaise: avgRate,
      reorderLevelMilli: item.reorderLevelMilli,
      belowReorder: item.reorderLevelMilli > 0 && closingQty < item.reorderLevelMilli,
      negative: closingQty < 0,
    }
  })
}

export interface StockMovementRow {
  voucherId: string
  voucherNumber: string
  voucherTypeCode: string
  date: string
  direction: string
  godownName: string | null
  batchName: string | null
  qtyMilli: number
  ratePaise: number
  amountPaise: number
  partyName: string | null
}

/** Item-wise movement — the drill-down under a stock summary row. */
export async function stockMovement(companyId: string, stockItemId: string, filter: StockFilter = {}): Promise<StockMovementRow[]> {
  const rows = await prisma.tallyVoucherItem.findMany({
    where: {
      tallyCompanyId: companyId, stockItemId,
      ...(filter.godownId ? { godownId: filter.godownId } : {}),
      voucher: {
        ...STOCK_VOUCHER_FILTER,
        ...(filter.from || filter.to
          ? { date: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
          : {}),
      },
    },
    select: {
      direction: true, qtyMilli: true, ratePaise: true, amountPaise: true,
      godown: { select: { name: true } },
      batch: { select: { name: true } },
      voucher: {
        select: { id: true, voucherNumber: true, voucherTypeCode: true, date: true, partyLedger: { select: { name: true } } },
      },
    },
    orderBy: [{ voucher: { date: 'asc' } }],
  })
  return rows.map((r) => ({
    voucherId: r.voucher.id,
    voucherNumber: r.voucher.voucherNumber,
    voucherTypeCode: r.voucher.voucherTypeCode,
    date: r.voucher.date,
    direction: r.direction,
    godownName: r.godown?.name ?? null,
    batchName: r.batch?.name ?? null,
    qtyMilli: r.qtyMilli,
    ratePaise: r.ratePaise,
    amountPaise: r.amountPaise,
    partyName: r.voucher.partyLedger?.name ?? null,
  }))
}

export interface GodownStockRow {
  godownId: string | null
  godownName: string
  stockItemId: string
  stockItemName: string
  closingQtyMilli: number
}

/** Godown-wise closing quantities (value is reported at item level). */
export async function godownStock(companyId: string, filter: StockFilter = {}): Promise<GodownStockRow[]> {
  const [godowns, openings, lines] = await Promise.all([
    prisma.tallyGodown.findMany({ where: { tallyCompanyId: companyId, ...alive }, select: { id: true, name: true } }),
    prisma.tallyStockOpening.findMany({
      where: { tallyCompanyId: companyId },
      select: { godownId: true, stockItemId: true, qtyMilli: true, stockItem: { select: { name: true } } },
    }),
    prisma.tallyVoucherItem.groupBy({
      by: ['godownId', 'stockItemId', 'direction'],
      where: {
        tallyCompanyId: companyId,
        voucher: { ...STOCK_VOUCHER_FILTER, ...(filter.to ? { date: { lte: filter.to } } : {}) },
      },
      _sum: { qtyMilli: true },
    }),
  ])
  const names = new Map(godowns.map((g) => [g.id, g.name]))
  const itemNames = new Map(openings.map((o) => [o.stockItemId, o.stockItem.name]))
  const acc = new Map<string, GodownStockRow>()
  const push = (godownId: string | null, stockItemId: string, qty: number) => {
    const k = `${godownId ?? 'none'}|${stockItemId}`
    if (!acc.has(k)) {
      acc.set(k, {
        godownId, godownName: godownId ? names.get(godownId) ?? 'Unknown' : 'Unspecified',
        stockItemId, stockItemName: itemNames.get(stockItemId) ?? '', closingQtyMilli: 0,
      })
    }
    acc.get(k)!.closingQtyMilli += qty
  }
  for (const o of openings) push(o.godownId, o.stockItemId, o.qtyMilli)
  for (const l of lines) push(l.godownId, l.stockItemId, (l.direction === 'in' ? 1 : -1) * (l._sum.qtyMilli ?? 0))

  const missing = Array.from(acc.values()).filter((r) => !r.stockItemName).map((r) => r.stockItemId)
  if (missing.length) {
    const rows = await prisma.tallyStockItem.findMany({ where: { id: { in: missing } }, select: { id: true, name: true } })
    const m = new Map(rows.map((r) => [r.id, r.name]))
    for (const r of acc.values()) if (!r.stockItemName) r.stockItemName = m.get(r.stockItemId) ?? ''
  }
  return Array.from(acc.values()).filter((r) => r.closingQtyMilli !== 0).sort((a, b) =>
    a.godownName.localeCompare(b.godownName) || a.stockItemName.localeCompare(b.stockItemName))
}
