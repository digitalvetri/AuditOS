import type { PrismaClient } from '@prisma/client'
import { ApiError } from '../../../lib/http.js'
import type { BooksContext } from '../engine/context.js'
import { booksAudit } from '../engine/audit.js'
import { BooksError } from '../engine/errors.js'
import { toMinor } from '../engine/money.js'
import { postOpeningBalance } from '../engine/organisation.js'
import { withBooksTx } from '../engine/posting.js'
import { GST_STATES } from '../engine/chart.js'

/**
 * Master data: contacts, items, tax rates, account groups and ledgers.
 * Plain CRUD with the org scope folded into every query and an audit event
 * on every write. Deletes are soft; a ledger with postings cannot go.
 */
const alive = { deletedAt: null }

// ── Contacts ──────────────────────────────────────────────────────────────
export interface ContactInput {
  type: 'customer' | 'vendor' | 'both'
  display_name: string
  company_name?: string | null
  email?: string | null
  phone?: string | null
  gstin?: string | null
  gst_treatment?: 'business_gst' | 'business_none' | 'overseas' | 'consumer'
  pan?: string | null
  place_of_supply_state?: string | null
  currency?: string
  payment_terms_days?: number
  credit_limit?: number | string
  tds_section?: string | null
  notes?: string | null
  persons?: { name: string; email?: string | null; phone?: string | null; designation?: string | null; is_primary?: boolean }[]
  addresses?: { kind: 'billing' | 'shipping'; line1?: string | null; line2?: string | null; city?: string | null; state_code?: string | null; pincode?: string | null; country?: string }[]
}

function validateContact(b: ContactInput) {
  if (!b.display_name?.trim()) throw ApiError.badRequest('display_name is required.')
  if (!['customer', 'vendor', 'both'].includes(b.type)) throw ApiError.badRequest('type must be customer, vendor or both.')
  if (b.gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(b.gstin.toUpperCase())) throw new BooksError('invalid_gstin', 'GSTIN must be 15 characters (state code + PAN + entity + Z + check).')
  if (b.pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(b.pan.toUpperCase())) throw new BooksError('invalid_pan', 'PAN must look like AAAAA9999A.')
  if (b.place_of_supply_state && !GST_STATES[b.place_of_supply_state]) throw new BooksError('invalid_state', 'Unknown GST state code.')
}

export const Contacts = {
  list: (prisma: PrismaClient, ctx: BooksContext, f: { type?: string; q?: string } = {}) =>
    prisma.booksContact.findMany({
      where: {
        booksOrgId: ctx.booksOrgId, ...alive,
        ...(f.type ? { type: { in: f.type === 'customer' ? ['customer', 'both'] : f.type === 'vendor' ? ['vendor', 'both'] : [f.type] } } : {}),
        ...(f.q ? { OR: [{ displayName: { contains: f.q } }, { companyName: { contains: f.q } }, { gstin: { contains: f.q } }, { email: { contains: f.q } }] } : {}),
      },
      include: { persons: true, addresses: true }, orderBy: { displayName: 'asc' },
    }),

  get: async (prisma: PrismaClient, ctx: BooksContext, id: string) => {
    const c = await prisma.booksContact.findFirst({ where: { id, booksOrgId: ctx.booksOrgId, ...alive }, include: { persons: true, addresses: true } })
    if (!c) throw ApiError.notFound('Contact not found.')
    return c
  },

  create: (prisma: PrismaClient, ctx: BooksContext, b: ContactInput) => withBooksTx(prisma, async (tx) => {
    validateContact(b)
    const c = await tx.booksContact.create({
      data: {
        booksOrgId: ctx.booksOrgId, type: b.type, displayName: b.display_name.trim(), companyName: b.company_name ?? null, email: b.email ?? null, phone: b.phone ?? null,
        gstin: b.gstin?.toUpperCase() ?? null, gstTreatment: b.gst_treatment ?? (b.gstin ? 'business_gst' : 'business_none'), pan: b.pan?.toUpperCase() ?? null,
        placeOfSupplyState: b.place_of_supply_state ?? (b.gstin ? b.gstin.slice(0, 2) : null), currency: b.currency ?? ctx.baseCurrency,
        paymentTermsDays: b.payment_terms_days ?? 30, creditLimit: toMinor(b.credit_limit ?? 0), tdsSection: b.tds_section ?? null, notes: b.notes ?? null,
        createdBy: ctx.userId, updatedBy: ctx.userId,
        persons: { create: (b.persons ?? []).map((p) => ({ name: p.name, email: p.email ?? null, phone: p.phone ?? null, designation: p.designation ?? null, isPrimary: p.is_primary ?? false })) },
        addresses: { create: (b.addresses ?? []).map((a) => ({ kind: a.kind, line1: a.line1 ?? null, line2: a.line2 ?? null, city: a.city ?? null, stateCode: a.state_code ?? null, stateName: a.state_code ? GST_STATES[a.state_code] ?? null : null, pincode: a.pincode ?? null, country: a.country ?? 'IN' })) },
      },
      include: { persons: true, addresses: true },
    })
    await booksAudit(tx, ctx, { entityType: 'contact', entityId: c.id, action: 'contact.created', after: { name: c.displayName, type: c.type, gstin: c.gstin } })
    return c
  }),

  update: (prisma: PrismaClient, ctx: BooksContext, id: string, b: Partial<ContactInput>) => withBooksTx(prisma, async (tx) => {
    const before = await tx.booksContact.findFirst({ where: { id, booksOrgId: ctx.booksOrgId, ...alive } })
    if (!before) throw ApiError.notFound('Contact not found.')
    validateContact({ ...b, type: b.type ?? (before.type as ContactInput['type']), display_name: b.display_name ?? before.displayName })
    const c = await tx.booksContact.update({
      where: { id },
      data: {
        ...(b.type ? { type: b.type } : {}), ...(b.display_name ? { displayName: b.display_name.trim() } : {}),
        ...(b.company_name !== undefined ? { companyName: b.company_name } : {}), ...(b.email !== undefined ? { email: b.email } : {}), ...(b.phone !== undefined ? { phone: b.phone } : {}),
        ...(b.gstin !== undefined ? { gstin: b.gstin?.toUpperCase() ?? null } : {}), ...(b.gst_treatment ? { gstTreatment: b.gst_treatment } : {}),
        ...(b.pan !== undefined ? { pan: b.pan?.toUpperCase() ?? null } : {}), ...(b.place_of_supply_state !== undefined ? { placeOfSupplyState: b.place_of_supply_state } : {}),
        ...(b.currency ? { currency: b.currency } : {}), ...(b.payment_terms_days !== undefined ? { paymentTermsDays: b.payment_terms_days } : {}),
        ...(b.credit_limit !== undefined ? { creditLimit: toMinor(b.credit_limit) } : {}), ...(b.tds_section !== undefined ? { tdsSection: b.tds_section } : {}),
        ...(b.notes !== undefined ? { notes: b.notes } : {}), updatedBy: ctx.userId,
        ...(b.persons ? { persons: { deleteMany: {}, create: b.persons.map((p) => ({ name: p.name, email: p.email ?? null, phone: p.phone ?? null, designation: p.designation ?? null, isPrimary: p.is_primary ?? false })) } } : {}),
        ...(b.addresses ? { addresses: { deleteMany: {}, create: b.addresses.map((a) => ({ kind: a.kind, line1: a.line1 ?? null, line2: a.line2 ?? null, city: a.city ?? null, stateCode: a.state_code ?? null, stateName: a.state_code ? GST_STATES[a.state_code] ?? null : null, pincode: a.pincode ?? null, country: a.country ?? 'IN' })) } } : {}),
      },
      include: { persons: true, addresses: true },
    })
    await booksAudit(tx, ctx, { entityType: 'contact', entityId: c.id, action: 'contact.updated', before: { name: before.displayName, gstin: before.gstin, type: before.type }, after: { name: c.displayName, gstin: c.gstin, type: c.type } })
    return c
  }),

  deactivate: (prisma: PrismaClient, ctx: BooksContext, id: string, active: boolean) => withBooksTx(prisma, async (tx) => {
    const c = await tx.booksContact.findFirst({ where: { id, booksOrgId: ctx.booksOrgId, ...alive } })
    if (!c) throw ApiError.notFound('Contact not found.')
    const u = await tx.booksContact.update({ where: { id }, data: { isActive: active, updatedBy: ctx.userId } })
    await booksAudit(tx, ctx, { entityType: 'contact', entityId: id, action: active ? 'contact.activated' : 'contact.deactivated' })
    return u
  }),
}

// ── Items ─────────────────────────────────────────────────────────────────
export interface ItemInput {
  name: string; sku?: string | null; unit?: string; item_type?: string; product_type?: string
  sell_rate?: number | string; purchase_rate?: number | string; tax_rate_id?: string | null; hsn_sac?: string | null
  sales_ledger_id?: string | null; purchase_ledger_id?: string | null; description?: string | null
}

export const Items = {
  list: (prisma: PrismaClient, ctx: BooksContext, f: { q?: string } = {}) =>
    prisma.booksItem.findMany({ where: { booksOrgId: ctx.booksOrgId, ...alive, ...(f.q ? { OR: [{ name: { contains: f.q } }, { sku: { contains: f.q } }, { hsnSac: { contains: f.q } }] } : {}) }, orderBy: { name: 'asc' } }),

  get: async (prisma: PrismaClient, ctx: BooksContext, id: string) => {
    const i = await prisma.booksItem.findFirst({ where: { id, booksOrgId: ctx.booksOrgId, ...alive } })
    if (!i) throw ApiError.notFound('Item not found.')
    return i
  },

  create: (prisma: PrismaClient, ctx: BooksContext, b: ItemInput) => withBooksTx(prisma, async (tx) => {
    if (!b.name?.trim()) throw ApiError.badRequest('name is required.')
    if (b.tax_rate_id) await assertTaxRate(tx, ctx, b.tax_rate_id, 'gst')
    const i = await tx.booksItem.create({
      data: {
        booksOrgId: ctx.booksOrgId, name: b.name.trim(), sku: b.sku ?? null, unit: b.unit ?? 'nos', itemType: b.item_type ?? 'sales_and_purchases', productType: b.product_type ?? 'service',
        sellRate: toMinor(b.sell_rate ?? 0), purchaseRate: toMinor(b.purchase_rate ?? 0), taxRateId: b.tax_rate_id ?? null, hsnSac: b.hsn_sac ?? null,
        salesLedgerId: b.sales_ledger_id ?? null, purchaseLedgerId: b.purchase_ledger_id ?? null, description: b.description ?? null,
      },
    })
    await booksAudit(tx, ctx, { entityType: 'item', entityId: i.id, action: 'item.created', after: { name: i.name, sell_rate: i.sellRate } })
    return i
  }),

  update: (prisma: PrismaClient, ctx: BooksContext, id: string, b: Partial<ItemInput>) => withBooksTx(prisma, async (tx) => {
    const before = await tx.booksItem.findFirst({ where: { id, booksOrgId: ctx.booksOrgId, ...alive } })
    if (!before) throw ApiError.notFound('Item not found.')
    if (b.tax_rate_id) await assertTaxRate(tx, ctx, b.tax_rate_id, 'gst')
    const i = await tx.booksItem.update({
      where: { id },
      data: {
        ...(b.name ? { name: b.name.trim() } : {}), ...(b.sku !== undefined ? { sku: b.sku } : {}), ...(b.unit ? { unit: b.unit } : {}), ...(b.item_type ? { itemType: b.item_type } : {}),
        ...(b.product_type ? { productType: b.product_type } : {}), ...(b.sell_rate !== undefined ? { sellRate: toMinor(b.sell_rate) } : {}), ...(b.purchase_rate !== undefined ? { purchaseRate: toMinor(b.purchase_rate) } : {}),
        ...(b.tax_rate_id !== undefined ? { taxRateId: b.tax_rate_id } : {}), ...(b.hsn_sac !== undefined ? { hsnSac: b.hsn_sac } : {}),
        ...(b.sales_ledger_id !== undefined ? { salesLedgerId: b.sales_ledger_id } : {}), ...(b.purchase_ledger_id !== undefined ? { purchaseLedgerId: b.purchase_ledger_id } : {}),
        ...(b.description !== undefined ? { description: b.description } : {}),
      },
    })
    await booksAudit(tx, ctx, { entityType: 'item', entityId: id, action: 'item.updated', before: { name: before.name, sell_rate: before.sellRate }, after: { name: i.name, sell_rate: i.sellRate } })
    return i
  }),
}

async function assertTaxRate(db: { booksTaxRate: PrismaClient['booksTaxRate'] }, ctx: BooksContext, id: string, type?: string) {
  const t = await db.booksTaxRate.findFirst({ where: { id, booksOrgId: ctx.booksOrgId, ...alive } })
  if (!t) throw new BooksError('unknown_tax_rate', 'Tax rate not found in this set of books.')
  if (type && t.type !== type) throw new BooksError('wrong_tax_type', `Expected a ${type.toUpperCase()} rate.`)
  return t
}

// ── Tax rates ─────────────────────────────────────────────────────────────
export interface TaxRateInput { name: string; type: 'gst' | 'tds' | 'tcs' | 'other'; percentage_bp: number; no_pan_percentage_bp?: number | null; section?: string | null; is_compound?: boolean }

export const TaxRates = {
  list: (prisma: PrismaClient, ctx: BooksContext, type?: string) =>
    prisma.booksTaxRate.findMany({ where: { booksOrgId: ctx.booksOrgId, ...alive, ...(type ? { type } : {}) }, orderBy: [{ type: 'asc' }, { percentageBp: 'asc' }] }),

  create: (prisma: PrismaClient, ctx: BooksContext, b: TaxRateInput) => withBooksTx(prisma, async (tx) => {
    if (!b.name?.trim()) throw ApiError.badRequest('name is required.')
    if (!Number.isInteger(b.percentage_bp) || b.percentage_bp < 0 || b.percentage_bp > 10000) throw ApiError.badRequest('percentage_bp must be 0–10000 (basis points).')
    const t = await tx.booksTaxRate.create({ data: { booksOrgId: ctx.booksOrgId, name: b.name.trim(), type: b.type, percentageBp: b.percentage_bp, noPanPercentageBp: b.no_pan_percentage_bp ?? null, section: b.section ?? null, isCompound: b.is_compound ?? false } })
    await booksAudit(tx, ctx, { entityType: 'tax_rate', entityId: t.id, action: 'tax_rate.created', after: { name: t.name, bp: t.percentageBp } })
    return t
  }),

  update: (prisma: PrismaClient, ctx: BooksContext, id: string, b: Partial<TaxRateInput> & { is_active?: boolean }) => withBooksTx(prisma, async (tx) => {
    const before = await assertTaxRate(tx, ctx, id)
    const t = await tx.booksTaxRate.update({
      where: { id },
      data: {
        ...(b.name ? { name: b.name.trim() } : {}), ...(b.percentage_bp !== undefined ? { percentageBp: b.percentage_bp } : {}), ...(b.no_pan_percentage_bp !== undefined ? { noPanPercentageBp: b.no_pan_percentage_bp } : {}),
        ...(b.section !== undefined ? { section: b.section } : {}), ...(b.is_compound !== undefined ? { isCompound: b.is_compound } : {}), ...(b.is_active !== undefined ? { isActive: b.is_active } : {}),
      },
    })
    await booksAudit(tx, ctx, { entityType: 'tax_rate', entityId: id, action: 'tax_rate.updated', before: { name: before.name, bp: before.percentageBp }, after: { name: t.name, bp: t.percentageBp } })
    return t
  }),
}

// ── Chart of accounts ─────────────────────────────────────────────────────
export interface LedgerInput {
  name: string; group_id: string; alias?: string | null; code?: string | null; contact_id?: string | null
  opening_balance?: number | string; opening_balance_type?: 'debit' | 'credit'; opening_date?: string | null
  currency?: string; bill_wise?: boolean; gstin?: string | null; state_code?: string | null; tds_section?: string | null
  bank_name?: string | null; bank_account_no?: string | null; bank_ifsc?: string | null; is_bank?: boolean; is_cash?: boolean; description?: string | null
}

export const Chart = {
  groups: (prisma: PrismaClient, ctx: BooksContext) =>
    prisma.booksAccountGroup.findMany({ where: { booksOrgId: ctx.booksOrgId, ...alive }, orderBy: { sortOrder: 'asc' } }),

  createGroup: (prisma: PrismaClient, ctx: BooksContext, b: { name: string; parent_group_id: string }) => withBooksTx(prisma, async (tx) => {
    if (!b.name?.trim()) throw ApiError.badRequest('name is required.')
    const parent = await tx.booksAccountGroup.findFirst({ where: { id: b.parent_group_id, booksOrgId: ctx.booksOrgId, ...alive } })
    if (!parent) throw new BooksError('unknown_group', 'Parent group not found.')
    const g = await tx.booksAccountGroup.create({ data: { booksOrgId: ctx.booksOrgId, name: b.name.trim(), rootCategory: parent.rootCategory, tallyGroup: parent.tallyGroup, parentGroupId: parent.id, sortOrder: parent.sortOrder + 1 } })
    await booksAudit(tx, ctx, { entityType: 'account_group', entityId: g.id, action: 'account_group.created', after: { name: g.name, parent: parent.name } })
    return g
  }),

  ledgers: (prisma: PrismaClient, ctx: BooksContext, f: { root?: string; q?: string; bank?: boolean } = {}) =>
    prisma.booksLedger.findMany({
      where: { booksOrgId: ctx.booksOrgId, ...alive, ...(f.root ? { rootCategory: f.root } : {}), ...(f.q ? { name: { contains: f.q } } : {}), ...(f.bank ? { OR: [{ isBank: true }, { isCash: true }] } : {}) },
      include: { group: true }, orderBy: [{ rootCategory: 'asc' }, { name: 'asc' }],
    }),

  getLedger: async (prisma: PrismaClient, ctx: BooksContext, id: string) => {
    const l = await prisma.booksLedger.findFirst({ where: { id, booksOrgId: ctx.booksOrgId, ...alive }, include: { group: true } })
    if (!l) throw ApiError.notFound('Ledger not found.')
    return l
  },

  createLedger: (prisma: PrismaClient, ctx: BooksContext, b: LedgerInput) => withBooksTx(prisma, async (tx) => {
    if (!b.name?.trim()) throw ApiError.badRequest('name is required.')
    const group = await tx.booksAccountGroup.findFirst({ where: { id: b.group_id, booksOrgId: ctx.booksOrgId, ...alive } })
    if (!group) throw new BooksError('unknown_group', 'Account group not found.')
    const opening = toMinor(b.opening_balance ?? 0)
    const l = await tx.booksLedger.create({
      data: {
        booksOrgId: ctx.booksOrgId, groupId: group.id, name: b.name.trim(), alias: b.alias ?? null, code: b.code ?? null, rootCategory: group.rootCategory, tallyGroup: group.tallyGroup,
        contactId: b.contact_id ?? null, openingBalance: opening, openingBalanceType: b.opening_balance_type ?? 'debit', openingDate: b.opening_date ?? null,
        currency: b.currency ?? ctx.baseCurrency, billWise: b.bill_wise ?? false, gstin: b.gstin ?? null, stateCode: b.state_code ?? null, tdsSection: b.tds_section ?? null,
        bankName: b.bank_name ?? null, bankAccountNo: b.bank_account_no ?? null, bankIfsc: b.bank_ifsc ?? null,
        isBank: b.is_bank ?? group.tallyGroup === 'Bank Accounts', isCash: b.is_cash ?? group.tallyGroup === 'Cash-in-Hand', description: b.description ?? null,
        createdBy: ctx.userId, updatedBy: ctx.userId,
      },
      include: { group: true },
    })
    if (opening > 0n) {
      await postOpeningBalance(tx, ctx, l.id, opening, b.opening_balance_type ?? 'debit', b.opening_date ?? `${new Date().getFullYear()}-04-01`)
    }
    await booksAudit(tx, ctx, { entityType: 'ledger', entityId: l.id, action: 'ledger.created', after: { name: l.name, group: group.name, opening: opening.toString() } })
    return l
  }),

  updateLedger: (prisma: PrismaClient, ctx: BooksContext, id: string, b: Partial<LedgerInput> & { is_active?: boolean }) => withBooksTx(prisma, async (tx) => {
    const before = await tx.booksLedger.findFirst({ where: { id, booksOrgId: ctx.booksOrgId, ...alive } })
    if (!before) throw ApiError.notFound('Ledger not found.')
    if (before.isSystem && b.is_active === false) throw new BooksError('system_ledger', 'A system ledger cannot be deactivated.')
    let groupPatch = {}
    if (b.group_id && b.group_id !== before.groupId) {
      const group = await tx.booksAccountGroup.findFirst({ where: { id: b.group_id, booksOrgId: ctx.booksOrgId, ...alive } })
      if (!group) throw new BooksError('unknown_group', 'Account group not found.')
      if (group.rootCategory !== before.rootCategory && (await tx.booksJournalLine.count({ where: { ledgerId: id } })) > 0) {
        throw new BooksError('ledger_has_postings', 'A ledger with postings cannot move to a different root category.')
      }
      groupPatch = { groupId: group.id, rootCategory: group.rootCategory, tallyGroup: group.tallyGroup }
    }
    const l = await tx.booksLedger.update({
      where: { id },
      data: {
        ...groupPatch, ...(b.name ? { name: b.name.trim() } : {}), ...(b.alias !== undefined ? { alias: b.alias } : {}), ...(b.code !== undefined ? { code: b.code } : {}),
        ...(b.gstin !== undefined ? { gstin: b.gstin } : {}), ...(b.state_code !== undefined ? { stateCode: b.state_code } : {}), ...(b.tds_section !== undefined ? { tdsSection: b.tds_section } : {}),
        ...(b.bill_wise !== undefined ? { billWise: b.bill_wise } : {}), ...(b.bank_name !== undefined ? { bankName: b.bank_name } : {}), ...(b.bank_account_no !== undefined ? { bankAccountNo: b.bank_account_no } : {}),
        ...(b.bank_ifsc !== undefined ? { bankIfsc: b.bank_ifsc } : {}), ...(b.is_bank !== undefined ? { isBank: b.is_bank } : {}), ...(b.is_cash !== undefined ? { isCash: b.is_cash } : {}),
        ...(b.description !== undefined ? { description: b.description } : {}), ...(b.is_active !== undefined ? { isActive: b.is_active } : {}), updatedBy: ctx.userId,
      },
      include: { group: true },
    })
    await booksAudit(tx, ctx, { entityType: 'ledger', entityId: id, action: 'ledger.updated', before: { name: before.name, group: before.groupId, active: before.isActive }, after: { name: l.name, group: l.groupId, active: l.isActive } })
    return l
  }),

  deleteLedger: (prisma: PrismaClient, ctx: BooksContext, id: string) => withBooksTx(prisma, async (tx) => {
    const l = await tx.booksLedger.findFirst({ where: { id, booksOrgId: ctx.booksOrgId, ...alive } })
    if (!l) throw ApiError.notFound('Ledger not found.')
    if (l.isSystem) throw new BooksError('system_ledger', 'A system ledger cannot be deleted.')
    if ((await tx.booksJournalLine.count({ where: { ledgerId: id } })) > 0) throw new BooksError('ledger_has_postings', 'A ledger with postings cannot be deleted; deactivate it instead.')
    await tx.booksLedger.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: ctx.userId } })
    await booksAudit(tx, ctx, { entityType: 'ledger', entityId: id, action: 'ledger.deleted', before: { name: l.name } })
  }),
}
