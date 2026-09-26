import type { Prisma } from '@prisma/client'
import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import { assertDate } from './primitives.js'

/**
 * THE POSTING ENGINE — the single writer of Tally financial state.
 *
 * Nothing else in the module inserts a TallyVoucher, a TallyVoucherEntry,
 * a TallyVoucherItem or a TallyBillAllocation. Sales, purchases, payroll
 * and imports are all callers of postVoucher(); that is what makes
 * "reports derive from transactions" true rather than aspirational.
 *
 * Guarantees, all enforced inside one Prisma transaction:
 *   1. Total debit == total credit for any type that affects accounts.
 *   2. Every ledger / stock item / godown referenced belongs to the same
 *      company as the voucher (multi-company isolation).
 *   3. The date falls inside an OPEN financial year of that company and
 *      is not before books-begin-from.
 *   4. The voucher number is unique per (company, type) and is allocated
 *      from the type's own counter in the same transaction.
 *   5. Either everything lands or nothing does — a half-written voucher
 *      is not reachable.
 */

type Tx = Prisma.TransactionClient

export interface BillAllocationInput {
  billRef: string
  /** new | against | advance | on_account */
  method?: string
  amountPaise: number
  dueDate?: string | null
}

export interface EntryInput {
  ledgerId: string
  entryType: 'dr' | 'cr'
  amountPaise: number
  narration?: string | null
  isPartyLedger?: boolean
  costCentre?: string | null
  bankDate?: string | null
  billAllocations?: BillAllocationInput[]
}

export interface ItemInput {
  stockItemId: string
  godownId?: string | null
  batchId?: string | null
  /** in | out */
  direction: 'in' | 'out'
  qtyMilli: number
  ratePaise?: number
  discountPct?: number
  discountPaise?: number
  /** Taxable value; computed from qty x rate - discount when omitted. */
  amountPaise?: number
  hsnCode?: string | null
  gstRateBp?: number
  cgstPaise?: number
  sgstPaise?: number
  igstPaise?: number
  cessPaise?: number
  salesLedgerId?: string | null
  description?: string | null
}

export interface PostVoucherInput {
  voucherTypeId?: string
  voucherTypeCode?: string
  date: string
  voucherNumber?: string
  referenceNumber?: string | null
  referenceDate?: string | null
  narration?: string | null
  partyLedgerId?: string | null
  placeOfSupply?: string | null
  dueDate?: string | null
  roundOffPaise?: number
  entries?: EntryInput[]
  items?: ItemInput[]
}

export interface LedgerTaxConfig {
  gst_component?: 'cgst' | 'sgst' | 'igst' | 'cess'
  gst_direction?: 'input' | 'output'
  [k: string]: unknown
}

export function parseTaxConfig(json: string | null | undefined): LedgerTaxConfig {
  if (!json) return {}
  try {
    const v = JSON.parse(json) as unknown
    return v && typeof v === 'object' ? (v as LedgerTaxConfig) : {}
  } catch {
    return {}
  }
}

/** Resolve the open FY that contains `date`, or explain why none does. */
export async function resolveFinancialYear(tx: Tx, companyId: string, date: string) {
  const fys = await tx.tallyFinancialYear.findMany({ where: { tallyCompanyId: companyId } })
  const fy = fys.find((f) => date >= f.startDate && date <= f.endDate)
  if (!fy) {
    throw ApiError.unprocessable(
      'no_financial_year',
      `No financial year covers ${date}. Create the financial year before posting into it.`,
    )
  }
  if (fy.closed) {
    throw ApiError.unprocessable('financial_year_closed', `Financial year ${fy.label} is closed. Reopen it to post.`)
  }
  return fy
}

/**
 * Allocate the next number for a voucher type. Runs inside the posting
 * transaction, so two concurrent posts cannot take the same number: the
 * row update serialises them.
 */
export async function allocateVoucherNumber(
  tx: Tx,
  voucherType: { id: string; prefix: string | null; suffix: string | null; startNumber: number; currentNumber: number; numberingMethod: string },
  manual?: string,
): Promise<string> {
  if (voucherType.numberingMethod === 'manual') {
    if (!manual || !manual.trim()) {
      throw ApiError.badRequest('This voucher type uses manual numbering — a voucher number is required.')
    }
    return manual.trim()
  }
  if (manual && manual.trim()) {
    // An explicit number on an auto type is honoured (imports, corrections)
    // but never advances the counter.
    return manual.trim()
  }
  const updated = await tx.tallyVoucherType.update({
    where: { id: voucherType.id },
    data: { currentNumber: Math.max(voucherType.currentNumber + 1, voucherType.startNumber) },
    select: { currentNumber: true },
  })
  return `${voucherType.prefix ?? ''}${String(updated.currentNumber).padStart(4, '0')}${voucherType.suffix ?? ''}`
}

interface ValidatedLines {
  entries: EntryInput[]
  items: ItemInput[]
  totalDebit: number
  totalCredit: number
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  grandTotal: number
}

/**
 * Validate the lines against the company's own masters and roll up the
 * header totals. Tax totals are DERIVED: from the stock lines when the
 * voucher has them, otherwise from the ledgers the entries touch whose
 * taxConfigJson declares a GST component. No rate is hardcoded here.
 */
async function validateAndRollUp(
  tx: Tx,
  companyId: string,
  type: { code: string; affectsAccounts: boolean; affectsStock: boolean; isOrder: boolean },
  input: PostVoucherInput,
): Promise<ValidatedLines> {
  const entries = input.entries ?? []
  const items = input.items ?? []

  if (type.affectsAccounts && entries.length < 2) {
    throw ApiError.unprocessable('unbalanced', 'An accounting voucher needs at least one debit and one credit line.')
  }
  if (!type.affectsAccounts && entries.length > 0 && !type.isOrder) {
    // Delivery notes / stock journals carry no accounting effect.
    throw ApiError.unprocessable('not_accounting', `A ${type.code} voucher does not post accounting entries.`)
  }
  if (items.length > 0 && !type.affectsStock && !type.isOrder) {
    throw ApiError.unprocessable('not_inventory', `A ${type.code} voucher does not carry stock lines.`)
  }

  // ── Ledgers: existence + company ownership in ONE query ──────────────
  const ledgerIds = Array.from(new Set([
    ...entries.map((e) => e.ledgerId),
    ...items.map((i) => i.salesLedgerId).filter((x): x is string => Boolean(x)),
    ...(input.partyLedgerId ? [input.partyLedgerId] : []),
  ]))
  const ledgers = ledgerIds.length
    ? await tx.tallyLedger.findMany({
        where: { id: { in: ledgerIds }, tallyCompanyId: companyId, ...alive },
        select: { id: true, name: true, taxConfigJson: true, active: true, group: { select: { name: true, nature: true, affectsPL: true } } },
      })
    : []
  const ledgerById = new Map(ledgers.map((l) => [l.id, l]))
  for (const id of ledgerIds) {
    if (!ledgerById.has(id)) {
      throw ApiError.unprocessable('unknown_ledger', 'A ledger on this voucher does not belong to this company.')
    }
  }
  const inactive = ledgers.find((l) => !l.active)
  if (inactive) throw ApiError.unprocessable('inactive_ledger', `Ledger "${inactive.name}" is inactive.`)

  // ── Stock masters: existence + company ownership ────────────────────
  if (items.length) {
    const itemIds = Array.from(new Set(items.map((i) => i.stockItemId)))
    const stock = await tx.tallyStockItem.findMany({
      where: { id: { in: itemIds }, tallyCompanyId: companyId, ...alive }, select: { id: true },
    })
    if (stock.length !== itemIds.length) {
      throw ApiError.unprocessable('unknown_stock_item', 'A stock item on this voucher does not belong to this company.')
    }
    const godownIds = Array.from(new Set(items.map((i) => i.godownId).filter((x): x is string => Boolean(x))))
    if (godownIds.length) {
      const gds = await tx.tallyGodown.findMany({
        where: { id: { in: godownIds }, tallyCompanyId: companyId, ...alive }, select: { id: true },
      })
      if (gds.length !== godownIds.length) {
        throw ApiError.unprocessable('unknown_godown', 'A godown on this voucher does not belong to this company.')
      }
    }
    const batchIds = Array.from(new Set(items.map((i) => i.batchId).filter((x): x is string => Boolean(x))))
    if (batchIds.length) {
      const bs = await tx.tallyStockBatch.findMany({
        where: { id: { in: batchIds }, tallyCompanyId: companyId }, select: { id: true },
      })
      if (bs.length !== batchIds.length) {
        throw ApiError.unprocessable('unknown_batch', 'A batch on this voucher does not belong to this company.')
      }
    }
  }

  // ── Accounting roll-up ──────────────────────────────────────────────
  let totalDebit = 0
  let totalCredit = 0
  let cgst = 0, sgst = 0, igst = 0, cess = 0
  let salesPurchaseValue = 0

  for (const e of entries) {
    if (!Number.isInteger(e.amountPaise) || e.amountPaise <= 0) {
      throw ApiError.badRequest('Every voucher line must carry a positive amount in paise.')
    }
    if (e.entryType === 'dr') totalDebit += e.amountPaise
    else if (e.entryType === 'cr') totalCredit += e.amountPaise
    else throw ApiError.badRequest('Entry type must be dr or cr.')

    const led = ledgerById.get(e.ledgerId)!
    const cfg = parseTaxConfig(led.taxConfigJson)
    const signed = e.entryType === 'dr' ? e.amountPaise : -e.amountPaise
    if (cfg.gst_component === 'cgst') cgst += Math.abs(signed)
    else if (cfg.gst_component === 'sgst') sgst += Math.abs(signed)
    else if (cfg.gst_component === 'igst') igst += Math.abs(signed)
    else if (cfg.gst_component === 'cess') cess += Math.abs(signed)
    else if (led.group.name === 'Sales Accounts' || led.group.name === 'Purchase Accounts') {
      salesPurchaseValue += e.amountPaise
    }
  }

  if (type.affectsAccounts && totalDebit !== totalCredit) {
    throw ApiError.unprocessable(
      'unbalanced',
      `Voucher is out of balance: debit ${(totalDebit / 100).toFixed(2)} vs credit ${(totalCredit / 100).toFixed(2)}.`,
    )
  }

  // ── Stock roll-up. When the voucher carries stock lines they are the
  //    authority for taxable value and per-line tax. ────────────────────
  let itemTaxable = 0
  let itemCgst = 0, itemSgst = 0, itemIgst = 0, itemCess = 0
  for (const i of items) {
    if (!Number.isInteger(i.qtyMilli) || i.qtyMilli <= 0) {
      throw ApiError.badRequest('Every stock line needs a positive quantity.')
    }
    if (i.direction !== 'in' && i.direction !== 'out') {
      throw ApiError.badRequest('Stock line direction must be in or out.')
    }
    const gross = Math.round(((i.ratePaise ?? 0) * i.qtyMilli) / 1000)
    const discount = i.discountPaise ?? Math.round((gross * (i.discountPct ?? 0)) / 100)
    const taxable = i.amountPaise ?? gross - discount
    itemTaxable += taxable
    itemCgst += i.cgstPaise ?? 0
    itemSgst += i.sgstPaise ?? 0
    itemIgst += i.igstPaise ?? 0
    itemCess += i.cessPaise ?? 0
  }

  const taxable = items.length ? itemTaxable : salesPurchaseValue
  if (items.length && type.affectsAccounts) {
    // Where both exist they must agree — otherwise the stock report and
    // the P&L would tell two different stories about the same invoice.
    if (itemCgst || itemSgst || itemIgst || itemCess) {
      if (itemCgst !== cgst || itemSgst !== sgst || itemIgst !== igst || itemCess !== cess) {
        throw ApiError.unprocessable(
          'tax_mismatch',
          'Tax on the stock lines does not match the tax ledgers posted on this voucher.',
        )
      }
    }
  }

  const grandTotal = type.affectsAccounts ? totalDebit : taxable + itemCgst + itemSgst + itemIgst + itemCess

  return {
    entries, items, totalDebit, totalCredit,
    taxable,
    cgst: items.length && !type.affectsAccounts ? itemCgst : cgst,
    sgst: items.length && !type.affectsAccounts ? itemSgst : sgst,
    igst: items.length && !type.affectsAccounts ? itemIgst : igst,
    cess: items.length && !type.affectsAccounts ? itemCess : cess,
    grandTotal,
  }
}

export interface PostedVoucher {
  id: string
  voucherNumber: string
  voucherTypeCode: string
  date: string
}

/** Create and post a voucher. Atomic; returns the header identity. */
export async function postVoucher(
  companyId: string,
  input: PostVoucherInput,
  actorUserId: string | null,
): Promise<PostedVoucher> {
  assertDate(input.date)
  const company = await prisma.tallyCompany.findFirst({
    where: { id: companyId, ...alive }, select: { id: true, booksBeginFrom: true },
  })
  if (!company) throw ApiError.notFound('No such company.')
  if (input.date < company.booksBeginFrom) {
    throw ApiError.unprocessable('before_books_begin', `Books begin on ${company.booksBeginFrom}; ${input.date} is earlier.`)
  }

  return prisma.$transaction(async (tx) => {
    const type = input.voucherTypeId
      ? await tx.tallyVoucherType.findFirst({ where: { id: input.voucherTypeId, tallyCompanyId: companyId, ...alive } })
      : await tx.tallyVoucherType.findFirst({
          where: { tallyCompanyId: companyId, code: input.voucherTypeCode ?? '', ...alive },
          orderBy: { createdAt: 'asc' },
        })
    if (!type) throw ApiError.unprocessable('unknown_voucher_type', 'No such voucher type for this company.')
    if (!type.active) throw ApiError.unprocessable('inactive_voucher_type', `Voucher type "${type.name}" is inactive.`)

    const fy = await resolveFinancialYear(tx, companyId, input.date)
    const rolled = await validateAndRollUp(tx, companyId, type, input)
    const voucherNumber = await allocateVoucherNumber(tx, type, input.voucherNumber)

    const clash = await tx.tallyVoucher.findFirst({
      where: { tallyCompanyId: companyId, voucherTypeId: type.id, voucherNumber },
      select: { id: true },
    })
    if (clash) throw ApiError.conflict('duplicate_voucher_number', `Voucher number ${voucherNumber} already exists for ${type.name}.`)

    const voucher = await tx.tallyVoucher.create({
      data: {
        tallyCompanyId: companyId,
        financialYearId: fy.id,
        voucherTypeId: type.id,
        voucherTypeCode: type.code,
        voucherNumber,
        date: input.date,
        referenceNumber: input.referenceNumber?.trim() || null,
        referenceDate: input.referenceDate || null,
        narration: input.narration?.trim() || null,
        partyLedgerId: input.partyLedgerId || null,
        placeOfSupply: input.placeOfSupply || null,
        dueDate: input.dueDate || null,
        totalDebitPaise: rolled.totalDebit,
        totalCreditPaise: rolled.totalCredit,
        taxableValuePaise: rolled.taxable,
        cgstPaise: rolled.cgst,
        sgstPaise: rolled.sgst,
        igstPaise: rolled.igst,
        cessPaise: rolled.cess,
        roundOffPaise: input.roundOffPaise ?? 0,
        grandTotalPaise: rolled.grandTotal,
        createdByUserId: actorUserId,
      },
    })

    await writeLines(tx, companyId, voucher.id, voucher.date, rolled)

    await tx.tallyVoucherRevision.create({
      data: {
        tallyCompanyId: companyId,
        voucherId: voucher.id,
        version: 1,
        action: 'created',
        afterJson: JSON.stringify(snapshotOf(voucher, rolled)),
        actorUserId,
      },
    })

    return { id: voucher.id, voucherNumber, voucherTypeCode: type.code, date: voucher.date }
  })
}

/** Write entries, bill allocations and stock lines for a voucher. */
async function writeLines(tx: Tx, companyId: string, voucherId: string, date: string, rolled: ValidatedLines) {
  let position = 0
  for (const e of rolled.entries) {
    const entry = await tx.tallyVoucherEntry.create({
      data: {
        tallyCompanyId: companyId,
        voucherId,
        ledgerId: e.ledgerId,
        entryType: e.entryType,
        amountPaise: e.amountPaise,
        narration: e.narration?.trim() || null,
        position: position++,
        isPartyLedger: e.isPartyLedger ?? false,
        costCentre: e.costCentre || null,
        bankDate: e.bankDate || null,
      },
    })
    for (const b of e.billAllocations ?? []) {
      if (!b.billRef?.trim()) throw ApiError.badRequest('A bill allocation needs a bill reference.')
      await tx.tallyBillAllocation.create({
        data: {
          tallyCompanyId: companyId,
          voucherId,
          voucherEntryId: entry.id,
          ledgerId: e.ledgerId,
          billRef: b.billRef.trim(),
          method: b.method ?? 'new',
          amountPaise: b.amountPaise,
          dueDate: b.dueDate || null,
          date,
        },
      })
    }
  }

  let ipos = 0
  for (const i of rolled.items) {
    const gross = Math.round(((i.ratePaise ?? 0) * i.qtyMilli) / 1000)
    const discount = i.discountPaise ?? Math.round((gross * (i.discountPct ?? 0)) / 100)
    await tx.tallyVoucherItem.create({
      data: {
        tallyCompanyId: companyId,
        voucherId,
        stockItemId: i.stockItemId,
        godownId: i.godownId || null,
        batchId: i.batchId || null,
        direction: i.direction,
        qtyMilli: i.qtyMilli,
        ratePaise: i.ratePaise ?? 0,
        discountPct: i.discountPct ?? 0,
        discountPaise: discount,
        amountPaise: i.amountPaise ?? gross - discount,
        hsnCode: i.hsnCode || null,
        gstRateBp: i.gstRateBp ?? 0,
        cgstPaise: i.cgstPaise ?? 0,
        sgstPaise: i.sgstPaise ?? 0,
        igstPaise: i.igstPaise ?? 0,
        cessPaise: i.cessPaise ?? 0,
        salesLedgerId: i.salesLedgerId || null,
        description: i.description || null,
        position: ipos++,
      },
    })
  }
}

function snapshotOf(v: { voucherNumber: string; date: string; narration: string | null; grandTotalPaise: number }, rolled: ValidatedLines) {
  return {
    voucher_number: v.voucherNumber,
    date: v.date,
    narration: v.narration,
    grand_total_paise: v.grandTotalPaise,
    entries: rolled.entries.map((e) => ({ ledger_id: e.ledgerId, type: e.entryType, amount_paise: e.amountPaise })),
    items: rolled.items.map((i) => ({ stock_item_id: i.stockItemId, direction: i.direction, qty_milli: i.qtyMilli, rate_paise: i.ratePaise ?? 0 })),
  }
}

/**
 * Alter a posted voucher. The old lines are replaced wholesale (a voucher
 * is its lines), the before/after pair is written to TallyVoucherRevision,
 * and `version` is bumped — so "altered transactions" is a query, not a
 * guess. Cancelled vouchers cannot be altered.
 */
export async function alterVoucher(
  companyId: string,
  voucherId: string,
  input: PostVoucherInput,
  actorUserId: string | null,
): Promise<PostedVoucher> {
  assertDate(input.date)
  return prisma.$transaction(async (tx) => {
    const existing = await tx.tallyVoucher.findFirst({
      where: { id: voucherId, tallyCompanyId: companyId, ...alive },
      include: { entries: true, items: true, voucherType: true },
    })
    if (!existing) throw ApiError.notFound('No such voucher.')
    if (existing.status === 'cancelled') {
      throw ApiError.unprocessable('cancelled', 'A cancelled voucher cannot be altered. Restore it first.')
    }
    const type = existing.voucherType
    const fy = await resolveFinancialYear(tx, companyId, input.date)
    const rolled = await validateAndRollUp(tx, companyId, type, input)

    const before = {
      voucher_number: existing.voucherNumber,
      date: existing.date,
      narration: existing.narration,
      grand_total_paise: existing.grandTotalPaise,
      entries: existing.entries.map((e) => ({ ledger_id: e.ledgerId, type: e.entryType, amount_paise: e.amountPaise })),
      items: existing.items.map((i) => ({ stock_item_id: i.stockItemId, direction: i.direction, qty_milli: i.qtyMilli, rate_paise: i.ratePaise })),
    }

    await tx.tallyBillAllocation.deleteMany({ where: { voucherId } })
    await tx.tallyVoucherEntry.deleteMany({ where: { voucherId } })
    await tx.tallyVoucherItem.deleteMany({ where: { voucherId } })

    const voucher = await tx.tallyVoucher.update({
      where: { id: voucherId },
      data: {
        financialYearId: fy.id,
        date: input.date,
        voucherNumber: input.voucherNumber?.trim() || existing.voucherNumber,
        referenceNumber: input.referenceNumber?.trim() || null,
        referenceDate: input.referenceDate || null,
        narration: input.narration?.trim() || null,
        partyLedgerId: input.partyLedgerId || null,
        placeOfSupply: input.placeOfSupply || null,
        dueDate: input.dueDate || null,
        totalDebitPaise: rolled.totalDebit,
        totalCreditPaise: rolled.totalCredit,
        taxableValuePaise: rolled.taxable,
        cgstPaise: rolled.cgst,
        sgstPaise: rolled.sgst,
        igstPaise: rolled.igst,
        cessPaise: rolled.cess,
        roundOffPaise: input.roundOffPaise ?? 0,
        grandTotalPaise: rolled.grandTotal,
        modifiedByUserId: actorUserId,
        version: { increment: 1 },
      },
    })
    await writeLines(tx, companyId, voucher.id, voucher.date, rolled)
    await tx.tallyVoucherRevision.create({
      data: {
        tallyCompanyId: companyId,
        voucherId,
        version: voucher.version,
        action: 'updated',
        beforeJson: JSON.stringify(before),
        afterJson: JSON.stringify(snapshotOf(voucher, rolled)),
        actorUserId,
      },
    })
    return { id: voucher.id, voucherNumber: voucher.voucherNumber, voucherTypeCode: voucher.voucherTypeCode, date: voucher.date }
  })
}

/**
 * Cancel a voucher. The row and its lines STAY — a cancelled voucher keeps
 * its number (so the series has no silent gap) and every report filters on
 * status === 'active'. This is the only way financial effect is removed.
 */
export async function cancelVoucher(
  companyId: string,
  voucherId: string,
  reason: string | null,
  actorUserId: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const v = await tx.tallyVoucher.findFirst({ where: { id: voucherId, tallyCompanyId: companyId, ...alive } })
    if (!v) throw ApiError.notFound('No such voucher.')
    if (v.status === 'cancelled') return v
    const updated = await tx.tallyVoucher.update({
      where: { id: voucherId },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledByUserId: actorUserId,
        cancelReason: reason?.trim() || null,
        version: { increment: 1 },
      },
    })
    await tx.tallyVoucherRevision.create({
      data: {
        tallyCompanyId: companyId, voucherId, version: updated.version, action: 'cancelled',
        beforeJson: JSON.stringify({ status: 'active' }),
        afterJson: JSON.stringify({ status: 'cancelled', reason: reason ?? null }),
        actorUserId, note: reason ?? null,
      },
    })
    return updated
  })
}

/** Restore a cancelled voucher — the effect comes back, the history stays. */
export async function restoreVoucher(companyId: string, voucherId: string, actorUserId: string | null) {
  return prisma.$transaction(async (tx) => {
    const v = await tx.tallyVoucher.findFirst({ where: { id: voucherId, tallyCompanyId: companyId, ...alive } })
    if (!v) throw ApiError.notFound('No such voucher.')
    if (v.status !== 'cancelled') return v
    const fy = await tx.tallyFinancialYear.findUnique({ where: { id: v.financialYearId } })
    if (fy?.closed) throw ApiError.unprocessable('financial_year_closed', `Financial year ${fy.label} is closed.`)
    const updated = await tx.tallyVoucher.update({
      where: { id: voucherId },
      data: { status: 'active', cancelledAt: null, cancelledByUserId: null, cancelReason: null, version: { increment: 1 } },
    })
    await tx.tallyVoucherRevision.create({
      data: {
        tallyCompanyId: companyId, voucherId, version: updated.version, action: 'restored',
        beforeJson: JSON.stringify({ status: 'cancelled' }), afterJson: JSON.stringify({ status: 'active' }), actorUserId,
      },
    })
    return updated
  })
}
