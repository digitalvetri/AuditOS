import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { BookkeepingCompanyService } from './BookkeepingCompanyService.js'
import { BookkeepingBootstrapService } from './BookkeepingBootstrapService.js'
import { postVoucher, alterVoucher, cancelVoucher, restoreVoucher, type PostVoucherInput } from '../engine/posting.js'

/**
 * BookkeepingVoucherService — the HTTP-facing shape of a voucher. All the
 * accounting rules live in engine/posting.ts; this layer is scoping,
 * serialisation and query building.
 */

export interface VoucherEntryApi {
  id: string
  ledger_id: string
  ledger_name: string
  entry_type: 'dr' | 'cr'
  amount_paise: number
  narration: string | null
  is_party_ledger: boolean
  cost_centre: string | null
  bank_date: string | null
  reconciled_at: string | null
  bill_allocations: { bill_ref: string; method: string; amount_paise: number; due_date: string | null }[]
}

export interface VoucherItemApi {
  id: string
  stock_item_id: string
  stock_item_name: string
  godown_id: string | null
  godown_name: string | null
  batch_id: string | null
  direction: 'in' | 'out'
  qty_milli: number
  rate_paise: number
  discount_pct: number
  discount_paise: number
  amount_paise: number
  hsn_code: string | null
  gst_rate_bp: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_paise: number
  description: string | null
}

export interface VoucherApi {
  id: string
  voucher_type_id: string
  voucher_type_code: string
  voucher_type_name?: string
  voucher_number: string
  date: string
  financial_year_id: string
  reference_number: string | null
  reference_date: string | null
  narration: string | null
  party_ledger_id: string | null
  party_name: string | null
  place_of_supply: string | null
  status: string
  total_debit_paise: number
  total_credit_paise: number
  taxable_value_paise: number
  cgst_paise: number
  sgst_paise: number
  igst_paise: number
  cess_paise: number
  round_off_paise: number
  grand_total_paise: number
  due_date: string | null
  version: number
  created_at: string
  updated_at: string
  cancelled_at: string | null
  cancel_reason: string | null
  entries?: VoucherEntryApi[]
  items?: VoucherItemApi[]
}

const LIST_SELECT = {
  id: true, voucherTypeId: true, voucherTypeCode: true, voucherNumber: true, date: true,
  financialYearId: true, referenceNumber: true, referenceDate: true, narration: true,
  partyLedgerId: true, placeOfSupply: true, status: true,
  totalDebitPaise: true, totalCreditPaise: true, taxableValuePaise: true,
  cgstPaise: true, sgstPaise: true, igstPaise: true, cessPaise: true,
  roundOffPaise: true, grandTotalPaise: true, dueDate: true, version: true,
  createdAt: true, updatedAt: true, cancelledAt: true, cancelReason: true,
  partyLedger: { select: { name: true } },
  voucherType: { select: { name: true } },
} as const

type ListRow = {
  id: string; voucherTypeId: string; voucherTypeCode: string; voucherNumber: string; date: string
  financialYearId: string; referenceNumber: string | null; referenceDate: string | null; narration: string | null
  partyLedgerId: string | null; placeOfSupply: string | null; status: string
  totalDebitPaise: number; totalCreditPaise: number; taxableValuePaise: number
  cgstPaise: number; sgstPaise: number; igstPaise: number; cessPaise: number
  roundOffPaise: number; grandTotalPaise: number; dueDate: string | null; version: number
  createdAt: Date; updatedAt: Date; cancelledAt: Date | null; cancelReason: string | null
  partyLedger: { name: string } | null
  voucherType?: { name: string } | null
}

function toApi(v: ListRow): VoucherApi {
  return {
    id: v.id,
    voucher_type_id: v.voucherTypeId,
    voucher_type_code: v.voucherTypeCode,
    voucher_type_name: v.voucherType?.name,
    voucher_number: v.voucherNumber,
    date: v.date,
    financial_year_id: v.financialYearId,
    reference_number: v.referenceNumber,
    reference_date: v.referenceDate,
    narration: v.narration,
    party_ledger_id: v.partyLedgerId,
    party_name: v.partyLedger?.name ?? null,
    place_of_supply: v.placeOfSupply,
    status: v.status,
    total_debit_paise: v.totalDebitPaise,
    total_credit_paise: v.totalCreditPaise,
    taxable_value_paise: v.taxableValuePaise,
    cgst_paise: v.cgstPaise,
    sgst_paise: v.sgstPaise,
    igst_paise: v.igstPaise,
    cess_paise: v.cessPaise,
    round_off_paise: v.roundOffPaise,
    grand_total_paise: v.grandTotalPaise,
    due_date: v.dueDate,
    version: v.version,
    created_at: v.createdAt.toISOString(),
    updated_at: v.updatedAt.toISOString(),
    cancelled_at: v.cancelledAt?.toISOString() ?? null,
    cancel_reason: v.cancelReason,
  }
}

export interface VoucherListFilter {
  from?: string
  to?: string
  typeCodes?: string[]
  ledgerId?: string
  partyLedgerId?: string
  status?: string
  q?: string
  limit?: number
  offset?: number
}

export const BookkeepingVoucherService = {
  toApi,

  async listVoucherTypes(session: Session, companyId: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    await BookkeepingBootstrapService.ensure(companyId)
    const rows = await prisma.bookkeepingVoucherType.findMany({
      where: { tallyCompanyId: companyId, ...alive }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    })
    return rows.map((t) => ({
      id: t.id, name: t.name, code: t.code, numbering_method: t.numberingMethod,
      prefix: t.prefix, suffix: t.suffix, start_number: t.startNumber, current_number: t.currentNumber,
      affects_accounts: t.affectsAccounts, affects_stock: t.affectsStock, is_order: t.isOrder,
      is_default: t.isDefault, active: t.active,
    }))
  },

  async updateVoucherType(session: Session, companyId: string, typeId: string, patch: {
    name?: string; numberingMethod?: string; prefix?: string | null; suffix?: string | null
    startNumber?: number; active?: boolean
  }) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const existing = await prisma.bookkeepingVoucherType.findFirst({ where: { id: typeId, tallyCompanyId: companyId, ...alive } })
    if (!existing) throw ApiError.notFound('No such voucher type.')
    const row = await prisma.bookkeepingVoucherType.update({
      where: { id: typeId },
      data: {
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.numberingMethod !== undefined ? { numberingMethod: patch.numberingMethod } : {}),
        ...(patch.prefix !== undefined ? { prefix: patch.prefix } : {}),
        ...(patch.suffix !== undefined ? { suffix: patch.suffix } : {}),
        ...(patch.startNumber !== undefined ? { startNumber: patch.startNumber } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
      },
    })
    return { id: row.id, name: row.name, code: row.code, prefix: row.prefix, current_number: row.currentNumber }
  },

  async list(session: Session, companyId: string, filter: VoucherListFilter = {}) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const where: Record<string, unknown> = {
      tallyCompanyId: companyId, ...alive,
      ...(filter.status && filter.status !== 'all' ? { status: filter.status } : {}),
      ...(filter.typeCodes?.length ? { voucherTypeCode: { in: filter.typeCodes } } : {}),
      ...(filter.partyLedgerId ? { partyLedgerId: filter.partyLedgerId } : {}),
      ...(filter.from || filter.to
        ? { date: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
        : {}),
      ...(filter.ledgerId ? { entries: { some: { ledgerId: filter.ledgerId } } } : {}),
      ...(filter.q
        ? {
            OR: [
              { voucherNumber: { contains: filter.q, mode: 'insensitive' } },
              { narration: { contains: filter.q, mode: 'insensitive' } },
              { referenceNumber: { contains: filter.q, mode: 'insensitive' } },
              { partyLedger: { name: { contains: filter.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    }
    const take = Math.min(filter.limit ?? 100, 500)
    const [rows, total] = await Promise.all([
      prisma.bookkeepingVoucher.findMany({
        where, select: LIST_SELECT,
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        take, skip: filter.offset ?? 0,
      }),
      prisma.bookkeepingVoucher.count({ where }),
    ])
    return { items: rows.map(toApi), total, limit: take, offset: filter.offset ?? 0 }
  },

  async get(session: Session, companyId: string, voucherId: string): Promise<VoucherApi> {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const v = await prisma.bookkeepingVoucher.findFirst({
      where: { id: voucherId, tallyCompanyId: companyId, ...alive },
      include: {
        partyLedger: { select: { name: true } },
        voucherType: { select: { name: true } },
        entries: {
          orderBy: { position: 'asc' },
          include: { ledger: { select: { name: true } }, allocations: true },
        },
        items: {
          orderBy: { position: 'asc' },
          include: { stockItem: { select: { name: true } }, godown: { select: { name: true } } },
        },
      },
    })
    if (!v) throw ApiError.notFound('No such voucher.')
    return {
      ...toApi(v as unknown as ListRow),
      entries: v.entries.map((e) => ({
        id: e.id,
        ledger_id: e.ledgerId,
        ledger_name: e.ledger.name,
        entry_type: e.entryType as 'dr' | 'cr',
        amount_paise: e.amountPaise,
        narration: e.narration,
        is_party_ledger: e.isPartyLedger,
        cost_centre: e.costCentre,
        bank_date: e.bankDate,
        reconciled_at: e.reconciledAt?.toISOString() ?? null,
        bill_allocations: e.allocations.map((a) => ({
          bill_ref: a.billRef, method: a.method, amount_paise: a.amountPaise, due_date: a.dueDate,
        })),
      })),
      items: v.items.map((i) => ({
        id: i.id,
        stock_item_id: i.stockItemId,
        stock_item_name: i.stockItem.name,
        godown_id: i.godownId,
        godown_name: i.godown?.name ?? null,
        batch_id: i.batchId,
        direction: i.direction as 'in' | 'out',
        qty_milli: i.qtyMilli,
        rate_paise: i.ratePaise,
        discount_pct: i.discountPct,
        discount_paise: i.discountPaise,
        amount_paise: i.amountPaise,
        hsn_code: i.hsnCode,
        gst_rate_bp: i.gstRateBp,
        cgst_paise: i.cgstPaise,
        sgst_paise: i.sgstPaise,
        igst_paise: i.igstPaise,
        cess_paise: i.cessPaise,
        description: i.description,
      })),
    }
  },

  async create(session: Session, companyId: string, input: PostVoucherInput) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    await BookkeepingBootstrapService.ensure(companyId)
    const posted = await postVoucher(companyId, input, session.userId)
    return BookkeepingVoucherService.get(session, companyId, posted.id)
  },

  async update(session: Session, companyId: string, voucherId: string, input: PostVoucherInput) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const posted = await alterVoucher(companyId, voucherId, input, session.userId)
    return BookkeepingVoucherService.get(session, companyId, posted.id)
  },

  async cancel(session: Session, companyId: string, voucherId: string, reason: string | null) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    await cancelVoucher(companyId, voucherId, reason, session.userId)
    return BookkeepingVoucherService.get(session, companyId, voucherId)
  },

  async restore(session: Session, companyId: string, voucherId: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    await restoreVoucher(companyId, voucherId, session.userId)
    return BookkeepingVoucherService.get(session, companyId, voucherId)
  },

  /**
   * Duplicate — copies the lines into a NEW voucher with a fresh number
   * and today's date by default. It posts through the same engine, so a
   * duplicate is validated exactly like a hand-keyed voucher.
   */
  async duplicate(session: Session, companyId: string, voucherId: string, date?: string) {
    const src = await BookkeepingVoucherService.get(session, companyId, voucherId)
    const input: PostVoucherInput = {
      voucherTypeId: src.voucher_type_id,
      date: date ?? new Date().toISOString().slice(0, 10),
      referenceNumber: src.reference_number,
      narration: src.narration,
      partyLedgerId: src.party_ledger_id,
      placeOfSupply: src.place_of_supply,
      roundOffPaise: src.round_off_paise,
      entries: (src.entries ?? []).map((e) => ({
        ledgerId: e.ledger_id,
        entryType: e.entry_type,
        amountPaise: e.amount_paise,
        narration: e.narration,
        isPartyLedger: e.is_party_ledger,
        costCentre: e.cost_centre,
      })),
      items: (src.items ?? []).map((i) => ({
        stockItemId: i.stock_item_id,
        godownId: i.godown_id,
        batchId: i.batch_id,
        direction: i.direction,
        qtyMilli: i.qty_milli,
        ratePaise: i.rate_paise,
        discountPct: i.discount_pct,
        amountPaise: i.amount_paise,
        hsnCode: i.hsn_code,
        gstRateBp: i.gst_rate_bp,
        cgstPaise: i.cgst_paise,
        sgstPaise: i.sgst_paise,
        igstPaise: i.igst_paise,
        cessPaise: i.cess_paise,
        description: i.description,
      })),
    }
    const posted = await postVoucher(companyId, input, session.userId)
    return BookkeepingVoucherService.get(session, companyId, posted.id)
  },
}
