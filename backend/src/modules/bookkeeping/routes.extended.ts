import type { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { BookkeepingVoucherService } from './services/BookkeepingVoucherService.js'
import { BookkeepingReportService } from './services/BookkeepingReportService.js'
import { BookkeepingInventoryService } from './services/BookkeepingInventoryService.js'
import { BookkeepingBankingService } from './services/BookkeepingBankingService.js'
import { BookkeepingGstService } from './services/BookkeepingGstService.js'
import { BookkeepingPayrollService } from './services/BookkeepingPayrollService.js'
import { BookkeepingAuditService } from './services/BookkeepingAuditService.js'
import { BookkeepingDataService, type ImportEntity } from './services/BookkeepingDataService.js'
import { BookkeepingSettingsService } from './services/BookkeepingSettingsService.js'
import { BookkeepingDashboardService } from './services/BookkeepingDashboardService.js'
import { BookkeepingSearchService } from './services/BookkeepingSearchService.js'
import type { PostVoucherInput } from './engine/posting.js'

/**
 * Tally HTTP surface, slices 2+ (vouchers → dashboard).
 *
 * Same pipeline as the foundation routes: authenticate → permission →
 * Zod validate → service → writeAudit on every mutation. Company scoping
 * is enforced inside the services, never here, so no route can forget it.
 */

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

function gate(permission: string, message: string) {
  return (session: Session) => {
    if (!can(session, permission as never, 'self')) throw ApiError.forbidden(message)
  }
}
const requireVoucherRead = gate('tools.audit_automation.bookkeeping.voucher.read', 'You do not have permission to view Tally vouchers.')
const requireVoucherManage = gate('tools.audit_automation.bookkeeping.voucher.manage', 'You do not have permission to create or alter Tally vouchers.')
const requireVoucherCancel = gate('tools.audit_automation.bookkeeping.voucher.cancel', 'You do not have permission to cancel Tally vouchers.')
const requireReportRead = gate('tools.audit_automation.bookkeeping.report.read', 'You do not have permission to view Tally reports.')
const requireAuditRead = gate('tools.audit_automation.bookkeeping.audit.read', 'You do not have permission to view the Tally audit trail.')
const requireSettings = gate('tools.audit_automation.bookkeeping.settings.manage', 'You do not have permission to change Tally settings.')
const requireData = gate('tools.audit_automation.bookkeeping.data.manage', 'You do not have permission to import, export, back up or restore Tally data.')
const requireMasterRead = gate('tools.audit_automation.bookkeeping.master.read', 'You do not have permission to view Tally masters.')
const requireMasterManage = gate('tools.audit_automation.bookkeeping.master.manage', 'You do not have permission to manage Tally masters.')

const periodOf = (q: Record<string, unknown>) => ({
  from: typeof q.from === 'string' && q.from ? q.from : null,
  to: typeof q.to === 'string' && q.to ? q.to : null,
})

const entrySchema = z.object({
  ledger_id: z.string().min(1),
  entry_type: z.enum(['dr', 'cr']),
  amount_paise: z.number().int().positive(),
  narration: z.string().nullable().optional(),
  is_party_ledger: z.boolean().optional(),
  cost_centre: z.string().nullable().optional(),
  bank_date: ISO.nullable().optional(),
  bill_allocations: z.array(z.object({
    bill_ref: z.string().min(1),
    method: z.enum(['new', 'against', 'advance', 'on_account']).optional(),
    amount_paise: z.number().int(),
    due_date: ISO.nullable().optional(),
  })).optional(),
})

const itemSchema = z.object({
  stock_item_id: z.string().min(1),
  godown_id: z.string().nullable().optional(),
  batch_id: z.string().nullable().optional(),
  direction: z.enum(['in', 'out']),
  qty_milli: z.number().int().positive(),
  rate_paise: z.number().int().nonnegative().optional(),
  discount_pct: z.number().nonnegative().optional(),
  discount_paise: z.number().int().nonnegative().optional(),
  amount_paise: z.number().int().optional(),
  hsn_code: z.string().nullable().optional(),
  gst_rate_bp: z.number().int().nonnegative().optional(),
  cgst_paise: z.number().int().nonnegative().optional(),
  sgst_paise: z.number().int().nonnegative().optional(),
  igst_paise: z.number().int().nonnegative().optional(),
  cess_paise: z.number().int().nonnegative().optional(),
  sales_ledger_id: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
})

const voucherSchema = z.object({
  voucher_type_id: z.string().optional(),
  voucher_type_code: z.string().optional(),
  date: ISO,
  voucher_number: z.string().optional(),
  reference_number: z.string().nullable().optional(),
  reference_date: ISO.nullable().optional(),
  narration: z.string().nullable().optional(),
  party_ledger_id: z.string().nullable().optional(),
  place_of_supply: z.string().nullable().optional(),
  due_date: ISO.nullable().optional(),
  round_off_paise: z.number().int().optional(),
  entries: z.array(entrySchema).optional(),
  items: z.array(itemSchema).optional(),
})

function toPostInput(b: z.infer<typeof voucherSchema>): PostVoucherInput {
  return {
    voucherTypeId: b.voucher_type_id,
    voucherTypeCode: b.voucher_type_code,
    date: b.date,
    voucherNumber: b.voucher_number,
    referenceNumber: b.reference_number,
    referenceDate: b.reference_date,
    narration: b.narration,
    partyLedgerId: b.party_ledger_id,
    placeOfSupply: b.place_of_supply,
    dueDate: b.due_date,
    roundOffPaise: b.round_off_paise,
    entries: b.entries?.map((e) => ({
      ledgerId: e.ledger_id,
      entryType: e.entry_type,
      amountPaise: e.amount_paise,
      narration: e.narration,
      isPartyLedger: e.is_party_ledger,
      costCentre: e.cost_centre,
      bankDate: e.bank_date,
      billAllocations: e.bill_allocations?.map((a) => ({
        billRef: a.bill_ref, method: a.method, amountPaise: a.amount_paise, dueDate: a.due_date,
      })),
    })),
    items: b.items?.map((i) => ({
      stockItemId: i.stock_item_id,
      godownId: i.godown_id,
      batchId: i.batch_id,
      direction: i.direction,
      qtyMilli: i.qty_milli,
      ratePaise: i.rate_paise,
      discountPct: i.discount_pct,
      discountPaise: i.discount_paise,
      amountPaise: i.amount_paise,
      hsnCode: i.hsn_code,
      gstRateBp: i.gst_rate_bp,
      cgstPaise: i.cgst_paise,
      sgstPaise: i.sgst_paise,
      igstPaise: i.igst_paise,
      cessPaise: i.cess_paise,
      salesLedgerId: i.sales_ledger_id,
      description: i.description,
    })),
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, message: string): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) throw ApiError.badRequest(message, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
  return r.data
}

export function registerExtendedBookkeepingRoutes(router: Router): void {
  const C = '/companies/:id'

  // ══ Voucher types ═════════════════════════════════════════════════
  router.get(`${C}/voucher-types`, handler(async (req, res) => {
    const s = requireSession(req); requireVoucherRead(s)
    ok(res, { items: await BookkeepingVoucherService.listVoucherTypes(s, req.params.id) })
  }))

  router.patch(`${C}/voucher-types/:typeId`, handler(async (req, res) => {
    const s = requireSession(req); requireSettings(s)
    const b = parse(z.object({
      name: z.string().min(1).optional(),
      numbering_method: z.enum(['auto', 'manual']).optional(),
      prefix: z.string().nullable().optional(),
      suffix: z.string().nullable().optional(),
      start_number: z.number().int().positive().optional(),
      active: z.boolean().optional(),
    }), req.body, 'Invalid voucher type patch.')
    const out = await BookkeepingVoucherService.updateVoucherType(s, req.params.id, req.params.typeId, {
      name: b.name, numberingMethod: b.numbering_method, prefix: b.prefix, suffix: b.suffix,
      startNumber: b.start_number, active: b.active,
    })
    await writeAudit({
      actorUserId: s.userId, action: 'tally.voucher_type_updated', entityType: 'TallyVoucherType',
      entityId: req.params.typeId, after: { company_id: req.params.id, ...b }, req,
    })
    ok(res, out)
  }))

  // ══ Vouchers ══════════════════════════════════════════════════════
  router.get(`${C}/vouchers`, handler(async (req, res) => {
    const s = requireSession(req); requireVoucherRead(s)
    const q = parse(z.object({
      from: ISO.optional(), to: ISO.optional(),
      type_codes: z.string().optional(),
      ledger_id: z.string().optional(),
      party_ledger_id: z.string().optional(),
      status: z.string().optional(),
      q: z.string().optional(),
      limit: z.coerce.number().int().positive().optional(),
      offset: z.coerce.number().int().nonnegative().optional(),
    }), req.query, 'Invalid voucher filter.')
    ok(res, await BookkeepingVoucherService.list(s, req.params.id, {
      from: q.from, to: q.to,
      typeCodes: q.type_codes ? q.type_codes.split(',').filter(Boolean) : undefined,
      ledgerId: q.ledger_id, partyLedgerId: q.party_ledger_id,
      status: q.status, q: q.q, limit: q.limit, offset: q.offset,
    }))
  }))

  router.get(`${C}/vouchers/:voucherId`, handler(async (req, res) => {
    const s = requireSession(req); requireVoucherRead(s)
    ok(res, await BookkeepingVoucherService.get(s, req.params.id, req.params.voucherId))
  }))

  router.post(`${C}/vouchers`, handler(async (req, res) => {
    const s = requireSession(req); requireVoucherManage(s)
    const b = parse(voucherSchema, req.body, 'Invalid voucher.')
    if (!b.voucher_type_id && !b.voucher_type_code) throw ApiError.badRequest('voucher_type_id or voucher_type_code is required.')
    const v = await BookkeepingVoucherService.create(s, req.params.id, toPostInput(b))
    await writeAudit({
      actorUserId: s.userId, action: 'tally.voucher_created', entityType: 'TallyVoucher', entityId: v.id,
      after: { company_id: req.params.id, voucher_number: v.voucher_number, type: v.voucher_type_code, date: v.date, total_paise: v.grand_total_paise },
      req,
    })
    ok(res, v, 201)
  }))

  router.patch(`${C}/vouchers/:voucherId`, handler(async (req, res) => {
    const s = requireSession(req); requireVoucherManage(s)
    const b = parse(voucherSchema, req.body, 'Invalid voucher.')
    const before = await BookkeepingVoucherService.get(s, req.params.id, req.params.voucherId)
    const v = await BookkeepingVoucherService.update(s, req.params.id, req.params.voucherId, toPostInput(b))
    await writeAudit({
      actorUserId: s.userId, action: 'tally.voucher_updated', entityType: 'TallyVoucher', entityId: v.id,
      before: { voucher_number: before.voucher_number, date: before.date, total_paise: before.grand_total_paise },
      after: { company_id: req.params.id, voucher_number: v.voucher_number, date: v.date, total_paise: v.grand_total_paise, version: v.version },
      req,
    })
    ok(res, v)
  }))

  router.post(`${C}/vouchers/:voucherId/cancel`, handler(async (req, res) => {
    const s = requireSession(req); requireVoucherCancel(s)
    const b = parse(z.object({ reason: z.string().nullable().optional() }), req.body ?? {}, 'Invalid cancel request.')
    const v = await BookkeepingVoucherService.cancel(s, req.params.id, req.params.voucherId, b.reason ?? null)
    await writeAudit({
      actorUserId: s.userId, action: 'tally.voucher_cancelled', entityType: 'TallyVoucher', entityId: v.id,
      before: { status: 'active' }, after: { company_id: req.params.id, status: 'cancelled', reason: b.reason ?? null }, req,
    })
    ok(res, v)
  }))

  router.post(`${C}/vouchers/:voucherId/restore`, handler(async (req, res) => {
    const s = requireSession(req); requireVoucherCancel(s)
    const v = await BookkeepingVoucherService.restore(s, req.params.id, req.params.voucherId)
    await writeAudit({
      actorUserId: s.userId, action: 'tally.voucher_restored', entityType: 'TallyVoucher', entityId: v.id,
      before: { status: 'cancelled' }, after: { company_id: req.params.id, status: 'active' }, req,
    })
    ok(res, v)
  }))

  router.post(`${C}/vouchers/:voucherId/duplicate`, handler(async (req, res) => {
    const s = requireSession(req); requireVoucherManage(s)
    const b = parse(z.object({ date: ISO.optional() }), req.body ?? {}, 'Invalid duplicate request.')
    const v = await BookkeepingVoucherService.duplicate(s, req.params.id, req.params.voucherId, b.date)
    await writeAudit({
      actorUserId: s.userId, action: 'tally.voucher_created', entityType: 'TallyVoucher', entityId: v.id,
      after: { company_id: req.params.id, voucher_number: v.voucher_number, duplicated_from: req.params.voucherId }, req,
    })
    ok(res, v, 201)
  }))

  // ══ Reports ═══════════════════════════════════════════════════════
  router.get(`${C}/reports/day-book`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const q = parse(z.object({
      from: ISO.optional(), to: ISO.optional(), type_codes: z.string().optional(),
      limit: z.coerce.number().int().positive().optional(), include_cancelled: z.coerce.boolean().optional(),
    }), req.query, 'Invalid day book filter.')
    ok(res, await BookkeepingReportService.dayBook(s, req.params.id, {
      from: q.from, to: q.to, limit: q.limit, includeCancelled: q.include_cancelled,
      typeCodes: q.type_codes ? q.type_codes.split(',').filter(Boolean) : undefined,
    }))
  }))

  router.get(`${C}/reports/ledger/:ledgerId`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    ok(res, await BookkeepingReportService.ledgerStatement(s, req.params.id, req.params.ledgerId, periodOf(req.query)))
  }))

  router.get(`${C}/reports/trial-balance`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    ok(res, await BookkeepingReportService.trialBalance(s, req.params.id, periodOf(req.query)))
  }))

  router.get(`${C}/reports/profit-and-loss`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    ok(res, await BookkeepingReportService.profitAndLoss(s, req.params.id, periodOf(req.query)))
  }))

  router.get(`${C}/reports/balance-sheet`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const p = periodOf(req.query)
    ok(res, await BookkeepingReportService.balanceSheet(s, req.params.id, { asOf: p.to, fyStart: p.from }))
  }))

  router.get(`${C}/reports/group-summary`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    ok(res, { items: await BookkeepingReportService.groupSummary(s, req.params.id, periodOf(req.query)) })
  }))

  router.get(`${C}/reports/register/:typeCode`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    ok(res, await BookkeepingReportService.register(s, req.params.id, req.params.typeCode, periodOf(req.query)))
  }))

  router.get(`${C}/reports/outstandings`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const q = parse(z.object({ side: z.enum(['receivable', 'payable']), as_of: ISO.optional(), ledger_id: z.string().optional() }), req.query, 'side must be receivable or payable.')
    ok(res, await BookkeepingReportService.outstandings(s, req.params.id, { side: q.side, asOf: q.as_of ?? null, ledgerId: q.ledger_id }))
  }))

  router.get(`${C}/reports/book/:kind`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const kind = req.params.kind
    if (kind !== 'cash' && kind !== 'bank') throw ApiError.badRequest('kind must be cash or bank.')
    ok(res, await BookkeepingReportService.cashOrBankBook(s, req.params.id, kind, periodOf(req.query)))
  }))

  router.get(`${C}/reports/cash-flow`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    ok(res, await BookkeepingReportService.cashFlow(s, req.params.id, periodOf(req.query)))
  }))

  router.get(`${C}/reports/ratios`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const p = periodOf(req.query)
    ok(res, await BookkeepingReportService.ratios(s, req.params.id, { asOf: p.to, fyStart: p.from }))
  }))

  // ══ Inventory ═════════════════════════════════════════════════════
  router.get(`${C}/inventory/stock-groups`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterRead(s)
    ok(res, { items: await BookkeepingInventoryService.listStockGroups(s, req.params.id) })
  }))
  router.post(`${C}/inventory/stock-groups`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterManage(s)
    const b = parse(z.object({ name: z.string().min(1), parent_id: z.string().nullable().optional() }), req.body, 'Name is required.')
    const out = await BookkeepingInventoryService.createStockGroup(s, req.params.id, { name: b.name, parentId: b.parent_id })
    await writeAudit({ actorUserId: s.userId, action: 'tally.stock_group_created', entityType: 'TallyStockGroup', entityId: out.id, after: { company_id: req.params.id, name: out.name }, req })
    ok(res, out, 201)
  }))

  router.get(`${C}/inventory/categories`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterRead(s)
    ok(res, { items: await BookkeepingInventoryService.listCategories(s, req.params.id) })
  }))
  router.post(`${C}/inventory/categories`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterManage(s)
    const b = parse(z.object({ name: z.string().min(1) }), req.body, 'Name is required.')
    ok(res, await BookkeepingInventoryService.createCategory(s, req.params.id, b.name), 201)
  }))

  router.get(`${C}/inventory/units`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterRead(s)
    ok(res, { items: await BookkeepingInventoryService.listUnits(s, req.params.id) })
  }))
  router.post(`${C}/inventory/units`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterManage(s)
    const b = parse(z.object({ name: z.string().min(1), decimals: z.number().int().min(0).max(4).optional() }), req.body, 'Name is required.')
    ok(res, await BookkeepingInventoryService.createUnit(s, req.params.id, b), 201)
  }))

  router.get(`${C}/inventory/godowns`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterRead(s)
    ok(res, { items: await BookkeepingInventoryService.listGodowns(s, req.params.id) })
  }))
  router.post(`${C}/inventory/godowns`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterManage(s)
    const b = parse(z.object({ name: z.string().min(1), address: z.string().nullable().optional(), parent_id: z.string().nullable().optional() }), req.body, 'Name is required.')
    const out = await BookkeepingInventoryService.createGodown(s, req.params.id, { name: b.name, address: b.address, parentId: b.parent_id })
    await writeAudit({ actorUserId: s.userId, action: 'tally.godown_created', entityType: 'TallyGodown', entityId: out.id, after: { company_id: req.params.id, name: out.name }, req })
    ok(res, out, 201)
  }))

  router.get(`${C}/inventory/items`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterRead(s)
    const q = parse(z.object({ q: z.string().optional(), stock_group_id: z.string().optional() }), req.query, 'Invalid filter.')
    ok(res, { items: await BookkeepingInventoryService.listItems(s, req.params.id, { q: q.q, stockGroupId: q.stock_group_id }) })
  }))

  router.post(`${C}/inventory/items`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterManage(s)
    const b = parse(z.object({
      name: z.string().min(1),
      stock_group_id: z.string().nullable().optional(),
      category_id: z.string().nullable().optional(),
      unit_id: z.string().nullable().optional(),
      hsn_code: z.string().nullable().optional(),
      gst_rate_bp: z.number().int().nonnegative().optional(),
      reorder_level_milli: z.number().int().nonnegative().optional(),
      standard_cost_paise: z.number().int().nonnegative().optional(),
      standard_price_paise: z.number().int().nonnegative().optional(),
      valuation_method: z.enum(['avg', 'fifo']).optional(),
      batch_tracking: z.boolean().optional(),
      opening_qty_milli: z.number().int().optional(),
      opening_rate_paise: z.number().int().nonnegative().optional(),
      opening_godown_id: z.string().nullable().optional(),
    }), req.body, 'Item name is required.')
    const out = await BookkeepingInventoryService.createItem(s, req.params.id, {
      name: b.name, stockGroupId: b.stock_group_id, categoryId: b.category_id, unitId: b.unit_id,
      hsnCode: b.hsn_code, gstRateBp: b.gst_rate_bp, reorderLevelMilli: b.reorder_level_milli,
      standardCostPaise: b.standard_cost_paise, standardPricePaise: b.standard_price_paise,
      valuationMethod: b.valuation_method, batchTracking: b.batch_tracking,
      openingQtyMilli: b.opening_qty_milli, openingRatePaise: b.opening_rate_paise, openingGodownId: b.opening_godown_id,
    })
    await writeAudit({ actorUserId: s.userId, action: 'tally.stock_item_created', entityType: 'TallyStockItem', entityId: out.id, after: { company_id: req.params.id, name: out.name }, req })
    ok(res, out, 201)
  }))

  router.patch(`${C}/inventory/items/:itemId`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterManage(s)
    const b = parse(z.object({
      name: z.string().min(1).optional(),
      hsn_code: z.string().nullable().optional(),
      gst_rate_bp: z.number().int().nonnegative().optional(),
      reorder_level_milli: z.number().int().nonnegative().optional(),
      standard_price_paise: z.number().int().nonnegative().optional(),
      standard_cost_paise: z.number().int().nonnegative().optional(),
      active: z.boolean().optional(),
    }), req.body, 'Invalid patch.')
    const patch: Record<string, unknown> = {}
    if (b.name !== undefined) patch.name = b.name.trim()
    if (b.hsn_code !== undefined) patch.hsnCode = b.hsn_code
    if (b.gst_rate_bp !== undefined) patch.gstRateBp = b.gst_rate_bp
    if (b.reorder_level_milli !== undefined) patch.reorderLevelMilli = b.reorder_level_milli
    if (b.standard_price_paise !== undefined) patch.standardPricePaise = b.standard_price_paise
    if (b.standard_cost_paise !== undefined) patch.standardCostPaise = b.standard_cost_paise
    if (b.active !== undefined) patch.active = b.active
    const out = await BookkeepingInventoryService.updateItem(s, req.params.id, req.params.itemId, patch)
    await writeAudit({ actorUserId: s.userId, action: 'tally.stock_item_updated', entityType: 'TallyStockItem', entityId: out.id, after: { company_id: req.params.id, ...b }, req })
    ok(res, out)
  }))

  router.put(`${C}/inventory/items/:itemId/opening`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterManage(s)
    const b = parse(z.object({
      qty_milli: z.number().int(), rate_paise: z.number().int().nonnegative(),
      godown_id: z.string().nullable().optional(), batch_id: z.string().nullable().optional(),
    }), req.body, 'qty_milli and rate_paise are required.')
    const out = await BookkeepingInventoryService.setOpeningStock(s, req.params.id, req.params.itemId, {
      qtyMilli: b.qty_milli, ratePaise: b.rate_paise, godownId: b.godown_id, batchId: b.batch_id,
    })
    await writeAudit({ actorUserId: s.userId, action: 'tally.opening_stock_set', entityType: 'TallyStockItem', entityId: req.params.itemId, after: { company_id: req.params.id, ...out }, req })
    ok(res, out)
  }))

  router.get(`${C}/inventory/items/:itemId/batches`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterRead(s)
    ok(res, { items: await BookkeepingInventoryService.listBatches(s, req.params.id, req.params.itemId) })
  }))
  router.post(`${C}/inventory/items/:itemId/batches`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterManage(s)
    const b = parse(z.object({ name: z.string().min(1), mfg_date: ISO.nullable().optional(), expiry_date: ISO.nullable().optional() }), req.body, 'Batch name is required.')
    ok(res, await BookkeepingInventoryService.createBatch(s, req.params.id, req.params.itemId, { name: b.name, mfgDate: b.mfg_date, expiryDate: b.expiry_date }), 201)
  }))

  router.get(`${C}/inventory/summary`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const q = parse(z.object({ from: ISO.optional(), to: ISO.optional(), godown_id: z.string().optional() }), req.query, 'Invalid filter.')
    ok(res, await BookkeepingInventoryService.summary(s, req.params.id, { from: q.from, to: q.to, godownId: q.godown_id }))
  }))

  router.get(`${C}/inventory/items/:itemId/movement`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const q = parse(z.object({ from: ISO.optional(), to: ISO.optional(), godown_id: z.string().optional() }), req.query, 'Invalid filter.')
    ok(res, await BookkeepingInventoryService.movement(s, req.params.id, req.params.itemId, { from: q.from, to: q.to, godownId: q.godown_id }))
  }))

  router.get(`${C}/inventory/godown-summary`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    ok(res, await BookkeepingInventoryService.godownSummary(s, req.params.id, periodOf(req.query)))
  }))

  // ══ Banking ═══════════════════════════════════════════════════════
  router.get(`${C}/banking/accounts`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const q = parse(z.object({ as_of: ISO.optional() }), req.query, 'Invalid filter.')
    ok(res, { items: await BookkeepingBankingService.listAccounts(s, req.params.id, q.as_of ?? null) })
  }))

  router.get(`${C}/banking/accounts/:ledgerId/book`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    ok(res, await BookkeepingBankingService.bankBook(s, req.params.id, req.params.ledgerId, periodOf(req.query)))
  }))

  router.post(`${C}/banking/accounts/:ledgerId/statement`, handler(async (req, res) => {
    const s = requireSession(req); requireData(s)
    const b = parse(z.object({
      rows: z.array(z.object({
        date: ISO, description: z.string(), ref_number: z.string().nullable().optional(),
        debit_paise: z.number().int().nonnegative().optional(),
        credit_paise: z.number().int().nonnegative().optional(),
        balance_paise: z.number().int().nullable().optional(),
      })).min(1),
    }), req.body, 'A statement needs at least one row.')
    const out = await BookkeepingBankingService.importStatement(s, req.params.id, req.params.ledgerId, b.rows.map((r) => ({
      date: r.date, description: r.description, refNumber: r.ref_number,
      debitPaise: r.debit_paise, creditPaise: r.credit_paise, balancePaise: r.balance_paise,
    })))
    await writeAudit({ actorUserId: s.userId, action: 'tally.bank_statement_imported', entityType: 'TallyLedger', entityId: req.params.ledgerId, after: { company_id: req.params.id, ...out }, req })
    ok(res, out, 201)
  }))

  router.get(`${C}/banking/accounts/:ledgerId/statement-lines`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const q = parse(z.object({ status: z.string().optional(), from: ISO.optional(), to: ISO.optional() }), req.query, 'Invalid filter.')
    ok(res, { items: await BookkeepingBankingService.listStatementLines(s, req.params.id, req.params.ledgerId, q) })
  }))

  router.get(`${C}/banking/statement-lines/:lineId/suggestions`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    ok(res, { items: await BookkeepingBankingService.suggestMatches(s, req.params.id, req.params.lineId) })
  }))

  router.post(`${C}/banking/statement-lines/:lineId/match`, handler(async (req, res) => {
    const s = requireSession(req); requireVoucherManage(s)
    const b = parse(z.object({ entry_id: z.string().min(1) }), req.body, 'entry_id is required.')
    const out = await BookkeepingBankingService.match(s, req.params.id, req.params.lineId, b.entry_id)
    await writeAudit({ actorUserId: s.userId, action: 'tally.bank_line_matched', entityType: 'TallyBankStatementLine', entityId: req.params.lineId, after: { company_id: req.params.id, ...out }, req })
    ok(res, out)
  }))

  router.post(`${C}/banking/statement-lines/:lineId/unmatch`, handler(async (req, res) => {
    const s = requireSession(req); requireVoucherManage(s)
    const out = await BookkeepingBankingService.unmatch(s, req.params.id, req.params.lineId)
    await writeAudit({ actorUserId: s.userId, action: 'tally.bank_line_unmatched', entityType: 'TallyBankStatementLine', entityId: req.params.lineId, after: { company_id: req.params.id }, req })
    ok(res, out)
  }))

  router.get(`${C}/banking/accounts/:ledgerId/reconciliation`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const q = parse(z.object({ statement_date: ISO }), req.query, 'statement_date is required.')
    ok(res, await BookkeepingBankingService.reconciliation(s, req.params.id, req.params.ledgerId, q.statement_date))
  }))

  router.post(`${C}/banking/accounts/:ledgerId/reconciliation`, handler(async (req, res) => {
    const s = requireSession(req); requireVoucherManage(s)
    const b = parse(z.object({ statement_date: ISO, notes: z.string().nullable().optional() }), req.body, 'statement_date is required.')
    const out = await BookkeepingBankingService.saveReconciliation(s, req.params.id, req.params.ledgerId, b.statement_date, b.notes)
    await writeAudit({ actorUserId: s.userId, action: 'tally.bank_reconciled', entityType: 'TallyBankReconciliation', entityId: out.id, after: { company_id: req.params.id, ...out }, req })
    ok(res, out, 201)
  }))

  router.get(`${C}/banking/reconciliations`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const q = parse(z.object({ ledger_id: z.string().optional() }), req.query, 'Invalid filter.')
    ok(res, { items: await BookkeepingBankingService.listReconciliations(s, req.params.id, q.ledger_id) })
  }))

  // ══ GST / statutory ═══════════════════════════════════════════════
  router.get(`${C}/gst/summary`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const q = parse(z.object({ from: ISO.optional(), to: ISO.optional() }), req.query, 'Invalid period.')
    ok(res, await BookkeepingGstService.summary(s, req.params.id, q))
  }))

  router.get(`${C}/gst/gstr1`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const q = parse(z.object({ from: ISO, to: ISO }), req.query, 'from and to are required.')
    ok(res, await BookkeepingGstService.gstr1(s, req.params.id, q.from, q.to))
  }))

  router.get(`${C}/gst/gstr3b`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const q = parse(z.object({ from: ISO, to: ISO }), req.query, 'from and to are required.')
    ok(res, await BookkeepingGstService.gstr3b(s, req.params.id, q.from, q.to))
  }))

  router.get(`${C}/gst/exceptions`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const q = parse(z.object({ from: ISO, to: ISO }), req.query, 'from and to are required.')
    ok(res, await BookkeepingGstService.exceptions(s, req.params.id, q.from, q.to))
  }))

  router.get(`${C}/gst/tax-rates`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterRead(s)
    const q = parse(z.object({ tax_type: z.enum(['gst', 'tds', 'tcs']).optional() }), req.query, 'Invalid filter.')
    ok(res, { items: await BookkeepingGstService.listTaxRates(s, req.params.id, q.tax_type) })
  }))

  router.post(`${C}/gst/tax-rates`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterManage(s)
    const b = parse(z.object({
      tax_type: z.enum(['gst', 'tds', 'tcs']), name: z.string().min(1),
      rate_bp: z.number().int().nonnegative(), cess_bp: z.number().int().nonnegative().optional(),
      hsn_code: z.string().nullable().optional(), sac_code: z.string().nullable().optional(),
      section: z.string().nullable().optional(), threshold_paise: z.number().int().nullable().optional(),
      effective_from: ISO.nullable().optional(),
    }), req.body, 'tax_type, name and rate_bp are required.')
    const out = await BookkeepingGstService.createTaxRate(s, req.params.id, {
      taxType: b.tax_type, name: b.name, rateBp: b.rate_bp, cessBp: b.cess_bp,
      hsnCode: b.hsn_code, sacCode: b.sac_code, section: b.section,
      thresholdPaise: b.threshold_paise, effectiveFrom: b.effective_from,
    })
    await writeAudit({ actorUserId: s.userId, action: 'tally.tax_rate_created', entityType: 'TallyTaxRate', entityId: out.id, after: { company_id: req.params.id, ...out }, req })
    ok(res, out, 201)
  }))

  router.get(`${C}/gst/statutory/:taxType`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const t = req.params.taxType
    if (t !== 'tds' && t !== 'tcs') throw ApiError.badRequest('taxType must be tds or tcs.')
    ok(res, await BookkeepingGstService.statutorySummary(s, req.params.id, t, periodOf(req.query) as { from?: string; to?: string }))
  }))

  router.get(`${C}/gst/e-invoice/:voucherId`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    ok(res, await BookkeepingGstService.eInvoicePayload(s, req.params.id, req.params.voucherId))
  }))

  router.post(`${C}/gst/e-way-bill/:voucherId`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const b = parse(z.object({
      transporter_id: z.string().nullable().optional(), transporter_name: z.string().nullable().optional(),
      vehicle_number: z.string().nullable().optional(), transport_mode: z.string().nullable().optional(),
      distance_km: z.number().nullable().optional(),
    }), req.body ?? {}, 'Invalid transport details.')
    ok(res, await BookkeepingGstService.eWayBillPayload(s, req.params.id, req.params.voucherId, {
      transporterId: b.transporter_id, transporterName: b.transporter_name,
      vehicleNumber: b.vehicle_number, transportMode: b.transport_mode, distanceKm: b.distance_km,
    }))
  }))

  // ══ Payroll ═══════════════════════════════════════════════════════
  router.get(`${C}/payroll/employees`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterRead(s)
    ok(res, { items: await BookkeepingPayrollService.listEmployees(s, req.params.id) })
  }))

  router.post(`${C}/payroll/employees`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterManage(s)
    const b = parse(z.object({
      name: z.string().min(1), code: z.string().nullable().optional(),
      employee_group: z.string().nullable().optional(), designation: z.string().nullable().optional(),
      date_of_joining: ISO.nullable().optional(), pan: z.string().nullable().optional(),
      bank_account_number: z.string().nullable().optional(), bank_ifsc: z.string().nullable().optional(),
    }), req.body, 'Employee name is required.')
    const out = await BookkeepingPayrollService.createEmployee(s, req.params.id, {
      name: b.name, code: b.code, employeeGroup: b.employee_group, designation: b.designation,
      dateOfJoining: b.date_of_joining, pan: b.pan, bankAccountNumber: b.bank_account_number, bankIfsc: b.bank_ifsc,
    })
    await writeAudit({ actorUserId: s.userId, action: 'tally.employee_created', entityType: 'TallyEmployee', entityId: out.id, after: { company_id: req.params.id, name: out.name }, req })
    ok(res, out, 201)
  }))

  router.get(`${C}/payroll/pay-heads`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterRead(s)
    ok(res, { items: await BookkeepingPayrollService.listPayHeads(s, req.params.id) })
  }))

  router.post(`${C}/payroll/pay-heads`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterManage(s)
    const b = parse(z.object({
      name: z.string().min(1), head_type: z.enum(['earning', 'deduction', 'employer_contribution']),
      calc_type: z.enum(['flat', 'percent_of_basic', 'attendance']).optional(),
      value_paise: z.number().int().nonnegative().optional(), percent_bp: z.number().int().nonnegative().optional(),
      statutory: z.enum(['pf', 'esi', 'pt', 'income_tax']).nullable().optional(),
      ledger_id: z.string().nullable().optional(),
    }), req.body, 'name and head_type are required.')
    const out = await BookkeepingPayrollService.createPayHead(s, req.params.id, {
      name: b.name, headType: b.head_type, calcType: b.calc_type, valuePaise: b.value_paise,
      percentBp: b.percent_bp, statutory: b.statutory, ledgerId: b.ledger_id,
    })
    ok(res, out, 201)
  }))

  router.put(`${C}/payroll/employees/:employeeId/structure`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterManage(s)
    const b = parse(z.object({
      lines: z.array(z.object({
        pay_head_id: z.string().min(1),
        value_paise: z.number().int().nonnegative().optional(),
        percent_bp: z.number().int().nonnegative().optional(),
      })),
    }), req.body, 'lines is required.')
    ok(res, await BookkeepingPayrollService.setStructure(s, req.params.id, req.params.employeeId, b.lines.map((l) => ({
      payHeadId: l.pay_head_id, valuePaise: l.value_paise, percentBp: l.percent_bp,
    }))))
  }))

  router.get(`${C}/payroll/attendance`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterRead(s)
    const q = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) }), req.query, 'period (YYYY-MM) is required.')
    ok(res, { items: await BookkeepingPayrollService.getAttendance(s, req.params.id, q.period) })
  }))

  router.put(`${C}/payroll/attendance`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterManage(s)
    const b = parse(z.object({
      period: z.string().regex(/^\d{4}-\d{2}$/),
      rows: z.array(z.object({
        employee_id: z.string().min(1), payable_days: z.number().int().nonnegative(),
        present_days: z.number().int().nonnegative(), lop_days: z.number().int().nonnegative().optional(),
      })),
    }), req.body, 'period and rows are required.')
    ok(res, await BookkeepingPayrollService.setAttendance(s, req.params.id, b.period, b.rows.map((r) => ({
      employeeId: r.employee_id, payableDays: r.payable_days, presentDays: r.present_days, lopDays: r.lop_days,
    }))))
  }))

  router.get(`${C}/payroll/runs`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterRead(s)
    ok(res, { items: await BookkeepingPayrollService.listRuns(s, req.params.id) })
  }))

  router.get(`${C}/payroll/runs/:runId`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterRead(s)
    ok(res, await BookkeepingPayrollService.getRun(s, req.params.id, req.params.runId))
  }))

  router.post(`${C}/payroll/runs`, handler(async (req, res) => {
    const s = requireSession(req); requireVoucherManage(s)
    const b = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) }), req.body, 'period (YYYY-MM) is required.')
    const out = await BookkeepingPayrollService.process(s, req.params.id, b.period)
    await writeAudit({ actorUserId: s.userId, action: 'tally.payroll_processed', entityType: 'TallyPayrollRun', entityId: out.id, after: { company_id: req.params.id, period: out.period, net_paise: out.net_paise }, req })
    ok(res, out, 201)
  }))

  router.post(`${C}/payroll/runs/:runId/post`, handler(async (req, res) => {
    const s = requireSession(req); requireVoucherManage(s)
    const b = parse(z.object({
      date: ISO, payment_ledger_id: z.string().min(1), default_expense_ledger_id: z.string().optional(),
    }), req.body, 'date and payment_ledger_id are required.')
    const out = await BookkeepingPayrollService.post(s, req.params.id, req.params.runId, {
      date: b.date, paymentLedgerId: b.payment_ledger_id, defaultExpenseLedgerId: b.default_expense_ledger_id,
    })
    await writeAudit({ actorUserId: s.userId, action: 'tally.payroll_posted', entityType: 'TallyPayrollRun', entityId: out.id, after: { company_id: req.params.id, period: out.period, voucher_id: out.voucher_id }, req })
    ok(res, out)
  }))

  // ══ Audit ═════════════════════════════════════════════════════════
  router.get(`${C}/audit/trail`, handler(async (req, res) => {
    const s = requireSession(req); requireAuditRead(s)
    const q = parse(z.object({
      action: z.string().optional(), voucher_id: z.string().optional(),
      from: ISO.optional(), to: ISO.optional(), limit: z.coerce.number().int().positive().optional(),
    }), req.query, 'Invalid filter.')
    ok(res, { items: await BookkeepingAuditService.trail(s, req.params.id, { action: q.action, voucherId: q.voucher_id, from: q.from, to: q.to, limit: q.limit }) })
  }))

  router.get(`${C}/audit/revisions/:revisionId`, handler(async (req, res) => {
    const s = requireSession(req); requireAuditRead(s)
    ok(res, await BookkeepingAuditService.revision(s, req.params.id, req.params.revisionId))
  }))

  router.get(`${C}/audit/altered`, handler(async (req, res) => {
    const s = requireSession(req); requireAuditRead(s)
    ok(res, { items: await BookkeepingAuditService.alteredVouchers(s, req.params.id, periodOf(req.query) as { from?: string; to?: string }) })
  }))

  router.get(`${C}/audit/cancelled`, handler(async (req, res) => {
    const s = requireSession(req); requireAuditRead(s)
    ok(res, { items: await BookkeepingAuditService.cancelledVouchers(s, req.params.id, periodOf(req.query) as { from?: string; to?: string }) })
  }))

  router.get(`${C}/audit/activity`, handler(async (req, res) => {
    const s = requireSession(req); requireAuditRead(s)
    const q = parse(z.object({ limit: z.coerce.number().int().positive().optional() }), req.query, 'Invalid filter.')
    ok(res, { items: await BookkeepingAuditService.userActivity(s, req.params.id, q.limit) })
  }))

  router.get(`${C}/audit/exceptions`, handler(async (req, res) => {
    const s = requireSession(req); requireAuditRead(s)
    ok(res, await BookkeepingAuditService.exceptions(s, req.params.id, periodOf(req.query) as { from?: string; to?: string }))
  }))

  // ══ Import / export / backup ══════════════════════════════════════
  const IMPORT_ENTITIES = ['groups', 'ledgers', 'stock_items', 'vouchers', 'opening_balances'] as const

  router.post(`${C}/data/import/validate`, handler(async (req, res) => {
    const s = requireSession(req); requireData(s)
    const b = parse(z.object({
      entity: z.enum(IMPORT_ENTITIES),
      rows: z.array(z.record(z.unknown())).max(20000),
    }), req.body, 'entity and rows are required.')
    ok(res, await BookkeepingDataService.validateImport(s, req.params.id, b.entity as ImportEntity, b.rows as Record<string, unknown>[]))
  }))

  router.post(`${C}/data/import/commit`, handler(async (req, res) => {
    const s = requireSession(req); requireData(s)
    const b = parse(z.object({
      entity: z.enum(IMPORT_ENTITIES),
      rows: z.array(z.record(z.unknown())).max(20000),
      skip_invalid: z.boolean().optional(),
    }), req.body, 'entity and rows are required.')
    const out = await BookkeepingDataService.commitImport(s, req.params.id, b.entity as ImportEntity, b.rows as Record<string, unknown>[], { skipInvalid: b.skip_invalid })
    await writeAudit({ actorUserId: s.userId, action: 'tally.data_imported', entityType: 'TallyCompany', entityId: req.params.id, after: { ...out }, req })
    ok(res, out, 201)
  }))

  router.get(`${C}/data/export/json`, handler(async (req, res) => {
    const s = requireSession(req); requireData(s)
    ok(res, await BookkeepingDataService.exportJson(s, req.params.id))
  }))

  router.get(`${C}/data/export/xml`, handler(async (req, res) => {
    const s = requireSession(req); requireData(s)
    const q = parse(z.object({ from: ISO.optional(), to: ISO.optional() }), req.query, 'Invalid period.')
    const xml = await BookkeepingDataService.exportVoucherXml(s, req.params.id, q)
    res.setHeader('Content-Type', 'application/xml; charset=utf-8')
    res.send(xml)
  }))

  router.get(`${C}/data/backups`, handler(async (req, res) => {
    const s = requireSession(req); requireData(s)
    ok(res, { items: await BookkeepingDataService.listBackups(s, req.params.id) })
  }))

  router.post(`${C}/data/backups`, handler(async (req, res) => {
    const s = requireSession(req); requireData(s)
    const b = parse(z.object({ label: z.string().optional() }), req.body ?? {}, 'Invalid backup request.')
    const out = await BookkeepingDataService.createBackup(s, req.params.id, b.label)
    await writeAudit({ actorUserId: s.userId, action: 'tally.backup_created', entityType: 'TallyBackup', entityId: out.id, after: { company_id: req.params.id, label: out.label, voucher_count: out.voucher_count }, req })
    ok(res, out, 201)
  }))

  router.get(`${C}/data/backups/:backupId`, handler(async (req, res) => {
    const s = requireSession(req); requireData(s)
    const out = await BookkeepingDataService.downloadBackup(s, req.params.id, req.params.backupId)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.send(out.payload)
  }))

  router.post(`${C}/data/backups/:backupId/restore`, handler(async (req, res) => {
    const s = requireSession(req); requireData(s)
    const b = parse(z.object({
      new_company_name: z.string().min(1),
      confirm: z.literal(true),
    }), req.body, 'new_company_name and confirm:true are required — restore always creates a new company.')
    const out = await BookkeepingDataService.restoreBackup(s, req.params.id, req.params.backupId, b.new_company_name)
    await writeAudit({ actorUserId: s.userId, action: 'tally.backup_restored', entityType: 'TallyCompany', entityId: out.restored_company_id, after: { source_company_id: req.params.id, ...out }, req })
    ok(res, out, 201)
  }))

  router.get(`${C}/data/verify-restore/:restoredCompanyId`, handler(async (req, res) => {
    const s = requireSession(req); requireData(s)
    ok(res, await BookkeepingDataService.verifyRestore(s, req.params.id, req.params.restoredCompanyId))
  }))

  // ══ Settings ══════════════════════════════════════════════════════
  router.get(`${C}/settings`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterRead(s)
    ok(res, await BookkeepingSettingsService.getAll(s, req.params.id))
  }))

  router.patch(`${C}/settings/:group`, handler(async (req, res) => {
    const s = requireSession(req); requireSettings(s)
    const b = parse(z.record(z.unknown()), req.body, 'Invalid settings patch.')
    const out = await BookkeepingSettingsService.update(s, req.params.id, req.params.group, b as Record<string, unknown>)
    await writeAudit({ actorUserId: s.userId, action: 'tally.settings_updated', entityType: 'TallyCompany', entityId: req.params.id, after: { group: req.params.group, values: out.values }, req })
    ok(res, out)
  }))

  // ══ Dashboard + search ════════════════════════════════════════════
  router.get(`${C}/dashboard`, handler(async (req, res) => {
    const s = requireSession(req); requireReportRead(s)
    const q = parse(z.object({ from: ISO.optional(), to: ISO.optional(), fy_id: z.string().optional() }), req.query, 'Invalid period.')
    ok(res, await BookkeepingDashboardService.overview(s, req.params.id, { from: q.from, to: q.to, fyId: q.fy_id }))
  }))

  router.get(`${C}/search`, handler(async (req, res) => {
    const s = requireSession(req); requireMasterRead(s)
    const q = parse(z.object({ q: z.string(), limit: z.coerce.number().int().positive().optional() }), req.query, 'q is required.')
    ok(res, await BookkeepingSearchService.search(s, req.params.id, q.q, q.limit))
  }))
}
