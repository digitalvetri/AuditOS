import type { Prisma, PrismaClient } from '@prisma/client'
import { ApiError } from '../../../lib/http.js'
import type { BooksContext, Db } from '../engine/context.js'
import { booksAudit } from '../engine/audit.js'
import { BooksError } from '../engine/errors.js'
import { applyRate, sum, toMinor, type Minor } from '../engine/money.js'
import { nextNumber } from '../engine/numbering.js'
import { systemLedger } from '../engine/organisation.js'
import { postJournal, voidJournal, withBooksTx, type Allocation, type PostLine } from '../engine/posting.js'
import { computeDocument, isInterState } from './compute.js'

/**
 * DOCUMENTS — estimates, sales orders, invoices, retainer invoices, credit
 * notes, purchase orders, bills and vendor credits share one table, one
 * arithmetic (compute.ts) and one posting routine here. Only invoices,
 * retainer invoices, credit notes, bills and vendor credits post journals;
 * estimates, orders and POs are non-financial and never touch the ledger.
 */
export type DocKind = 'estimate' | 'sales_order' | 'invoice' | 'retainer_invoice' | 'credit_note' | 'purchase_order' | 'bill' | 'vendor_credit'
const SALES: DocKind[] = ['estimate', 'sales_order', 'invoice', 'retainer_invoice', 'credit_note']
const POSTING: DocKind[] = ['invoice', 'retainer_invoice', 'credit_note', 'bill', 'vendor_credit']
export const isSales = (k: DocKind) => SALES.includes(k)
export const isPosting = (k: DocKind) => POSTING.includes(k)

export interface DocLineInput {
  item_id?: string | null
  description?: string
  hsn_sac?: string | null
  quantity?: number
  rate: number | string | bigint
  discount_percent_bp?: number
  discount_amount?: number | string | bigint
  tax_rate_id?: string | null
  ledger_id?: string | null
}

export interface DocInput {
  contact_id: string
  date: string
  due_date?: string | null
  expiry_date?: string | null
  reference_no?: string | null
  currency?: string
  exchange_rate?: number
  place_of_supply?: string | null
  tax_inclusive?: boolean
  discount_percent_bp?: number
  discount_amount?: number | string | bigint
  tds_rate_id?: string | null
  notes?: string | null
  terms?: string | null
  source_document_id?: string | null
  lines: DocLineInput[]
}

const include = { lines: { orderBy: { lineNo: 'asc' as const } } }
export type DocRow = Prisma.BooksDocumentGetPayload<{ include: typeof include }>

// ── Read ──────────────────────────────────────────────────────────────────
export const Documents = {
  list: (prisma: PrismaClient, ctx: BooksContext, kind: DocKind, f: { status?: string; contact_id?: string; from?: string; to?: string; q?: string } = {}) =>
    prisma.booksDocument.findMany({
      where: {
        booksOrgId: ctx.booksOrgId, kind,
        ...(f.status ? { status: f.status } : {}), ...(f.contact_id ? { contactId: f.contact_id } : {}),
        ...(f.from || f.to ? { date: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
        ...(f.q ? { OR: [{ number: { contains: f.q } }, { referenceNo: { contains: f.q } }] } : {}),
      },
      include, orderBy: [{ date: 'desc' }, { number: 'desc' }],
    }),

  get: async (prisma: PrismaClient, ctx: BooksContext, id: string): Promise<DocRow> => {
    const d = await prisma.booksDocument.findFirst({ where: { id, booksOrgId: ctx.booksOrgId }, include })
    if (!d) throw ApiError.notFound('Document not found.')
    return d
  },

  // ── Create / update drafts ──────────────────────────────────────────────
  create: (prisma: PrismaClient, ctx: BooksContext, kind: DocKind, b: DocInput) => withBooksTx(prisma, async (tx) => {
    const built = await build(tx, ctx, kind, b)
    const number = await nextNumber(tx, ctx.booksOrgId, kind)
    const d = await tx.booksDocument.create({ data: { ...built.header, kind, number, status: 'draft', createdBy: ctx.userId, updatedBy: ctx.userId, lines: { create: built.lines } }, include })
    await booksAudit(tx, ctx, { entityType: kind, entityId: d.id, action: `${kind}.created`, after: snapshot(d) })
    return d
  }),

  update: (prisma: PrismaClient, ctx: BooksContext, id: string, b: DocInput) => withBooksTx(prisma, async (tx) => {
    const before = await tx.booksDocument.findFirst({ where: { id, booksOrgId: ctx.booksOrgId }, include })
    if (!before) throw ApiError.notFound('Document not found.')
    if (!['draft', 'sent'].includes(before.status)) throw new BooksError('not_editable', `A ${label(before.kind)} that is ${before.status} cannot be edited. Void it and raise a new one.`)
    const built = await build(tx, ctx, before.kind as DocKind, b)
    await tx.booksDocumentLine.deleteMany({ where: { documentId: id } })
    const d = await tx.booksDocument.update({ where: { id }, data: { ...built.header, updatedBy: ctx.userId, lines: { create: built.lines } }, include })
    await booksAudit(tx, ctx, { entityType: d.kind, entityId: d.id, action: `${d.kind}.updated`, before: snapshot(before), after: snapshot(d) })
    return d
  }),

  /** Non-financial status moves: draft → sent → accepted/declined (estimates), etc. */
  setStatus: (prisma: PrismaClient, ctx: BooksContext, id: string, status: string) => withBooksTx(prisma, async (tx) => {
    const d = await tx.booksDocument.findFirst({ where: { id, booksOrgId: ctx.booksOrgId } })
    if (!d) throw ApiError.notFound('Document not found.')
    const allowed: Record<string, string[]> = {
      estimate: ['draft', 'sent', 'accepted', 'declined', 'expired'],
      sales_order: ['draft', 'sent', 'accepted', 'closed'],
      purchase_order: ['draft', 'sent', 'accepted', 'closed'],
    }
    if (!(allowed[d.kind] ?? []).includes(status)) throw new BooksError('invalid_status', `${label(d.kind)} cannot be marked ${status}.`)
    if (['posted', 'void'].includes(d.status)) throw new BooksError('not_editable', 'This document is final.')
    const u = await tx.booksDocument.update({ where: { id }, data: { status, updatedBy: ctx.userId } })
    await booksAudit(tx, ctx, { entityType: d.kind, entityId: id, action: `${d.kind}.status`, before: { status: d.status }, after: { status } })
    return u
  }),

  /** Estimate → Sales Order → Invoice, and Purchase Order → Bill. */
  convert: (prisma: PrismaClient, ctx: BooksContext, id: string, toKind: DocKind) => withBooksTx(prisma, async (tx) => {
    const src = await tx.booksDocument.findFirst({ where: { id, booksOrgId: ctx.booksOrgId }, include })
    if (!src) throw ApiError.notFound('Document not found.')
    const ok: Record<string, DocKind[]> = { estimate: ['sales_order', 'invoice'], sales_order: ['invoice'], purchase_order: ['bill'] }
    if (!(ok[src.kind] ?? []).includes(toKind)) throw new BooksError('invalid_conversion', `A ${label(src.kind)} cannot become a ${label(toKind)}.`)
    if (src.status === 'void' || src.status === 'declined') throw new BooksError('not_convertible', `A ${src.status} ${label(src.kind)} cannot be converted.`)
    const input: DocInput = {
      contact_id: src.contactId, date: new Date().toISOString().slice(0, 10), reference_no: src.number, currency: src.currency, exchange_rate: src.exchangeRate,
      place_of_supply: src.placeOfSupply, tax_inclusive: src.taxInclusive, discount_percent_bp: src.discountPercentBp, discount_amount: src.discountAmount, notes: src.notes, terms: src.terms,
      source_document_id: src.id,
      lines: src.lines.map((l) => ({ item_id: l.itemId, description: l.description, hsn_sac: l.hsnSac, quantity: l.quantity, rate: l.rate, discount_percent_bp: l.discountPercentBp, discount_amount: l.discountAmount, tax_rate_id: l.taxRateId, ledger_id: l.ledgerId })),
    }
    const built = await build(tx, ctx, toKind, input)
    const number = await nextNumber(tx, ctx.booksOrgId, toKind)
    const d = await tx.booksDocument.create({ data: { ...built.header, kind: toKind, number, status: 'draft', createdBy: ctx.userId, updatedBy: ctx.userId, lines: { create: built.lines } }, include })
    if (src.kind !== 'estimate' || toKind === 'invoice') await tx.booksDocument.update({ where: { id: src.id }, data: { status: src.kind === 'estimate' ? 'accepted' : 'closed' } })
    await booksAudit(tx, ctx, { entityType: toKind, entityId: d.id, action: `${toKind}.converted`, before: { from: src.kind, number: src.number }, after: snapshot(d) })
    return d
  }),

  // ── Post ─────────────────────────────────────────────────────────────────
  post: (prisma: PrismaClient, ctx: BooksContext, id: string) => withBooksTx(prisma, async (tx) => postDocument(tx, ctx, id)),

  // ── Void ─────────────────────────────────────────────────────────────────
  void: (prisma: PrismaClient, ctx: BooksContext, id: string, reason?: string | null) => withBooksTx(prisma, async (tx) => {
    const d = await tx.booksDocument.findFirst({ where: { id, booksOrgId: ctx.booksOrgId }, include })
    if (!d) throw ApiError.notFound('Document not found.')
    if (d.status === 'void') throw new BooksError('already_void', 'Already void.')
    if (d.journalId) {
      if (['credit_note', 'vendor_credit'].includes(d.kind) && d.creditsRemaining !== d.total) {
        throw new BooksError('credit_applied', 'This credit has been applied to documents. Void those applications first.')
      }
      await voidJournal(tx, ctx, d.journalId, { reason: reason ?? null })
    }
    const u = await tx.booksDocument.update({ where: { id }, data: { status: 'void', voidReason: reason ?? null, balanceDue: 0n, creditsRemaining: 0n, updatedBy: ctx.userId }, include })
    await booksAudit(tx, ctx, { entityType: d.kind, entityId: id, action: `${d.kind}.voided`, before: { status: d.status }, after: { reason: reason ?? null } })
    return u
  }),

  // ── Credit application (manual, never FIFO) ──────────────────────────────
  applyCredit: (prisma: PrismaClient, ctx: BooksContext, creditId: string, applications: { document_id: string; amount: number | string }[], date?: string) =>
    withBooksTx(prisma, async (tx) => applyCredit(tx, ctx, creditId, applications, date)),

  /** A paid retainer applied to a real invoice: Dr Unearned Revenue / Cr AR. */
  applyRetainer: (prisma: PrismaClient, ctx: BooksContext, retainerId: string, applications: { document_id: string; amount: number | string }[], date?: string) =>
    withBooksTx(prisma, async (tx) => applyRetainer(tx, ctx, retainerId, applications, date)),
}

// ── Build (validate + compute) ────────────────────────────────────────────
async function build(tx: Db, ctx: BooksContext, kind: DocKind, b: DocInput) {
  if (!b.contact_id) throw ApiError.badRequest('contact_id is required.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date ?? '')) throw ApiError.badRequest('date must be YYYY-MM-DD.')
  if (!b.lines?.length) throw ApiError.badRequest('At least one line is required.')
  const contact = await tx.booksContact.findFirst({ where: { id: b.contact_id, booksOrgId: ctx.booksOrgId, deletedAt: null } })
  if (!contact) throw new BooksError('unknown_contact', 'Contact not found in this set of books.')
  const sales = isSales(kind)
  if (sales && contact.type === 'vendor') throw new BooksError('wrong_contact_type', `${contact.displayName} is a vendor, not a customer.`)
  if (!sales && contact.type === 'customer') throw new BooksError('wrong_contact_type', `${contact.displayName} is a customer, not a vendor.`)

  const org = await tx.booksOrganisation.findUniqueOrThrow({ where: { id: ctx.booksOrgId } })
  const itemIds = [...new Set(b.lines.map((l) => l.item_id).filter((x): x is string => Boolean(x)))]
  const items = new Map((await tx.booksItem.findMany({ where: { id: { in: itemIds }, booksOrgId: ctx.booksOrgId, deletedAt: null } })).map((i) => [i.id, i]))
  // A line's GST rate is its own, else its item's.
  const taxIds = [...new Set(b.lines.map((l) => l.tax_rate_id ?? (l.item_id ? items.get(l.item_id)?.taxRateId : null)).filter((x): x is string => Boolean(x)))]
  const taxes = new Map((await tx.booksTaxRate.findMany({ where: { id: { in: taxIds }, booksOrgId: ctx.booksOrgId, deletedAt: null } })).map((t) => [t.id, t]))
  for (const id of taxIds) { const t = taxes.get(id); if (!t) throw new BooksError('unknown_tax_rate', 'A line uses a tax rate that is not in this set of books.'); if (t.type !== 'gst') throw new BooksError('wrong_tax_type', 'Line taxes must be GST rates; TDS goes on the document.') }

  // Default posting ledger: the item's, else Sales / Purchases.
  const defaultLedger = await systemLedger(tx, ctx.booksOrgId, sales ? 'sales' : 'purchases')
  const ledgerIds = new Set<string>()
  const lineInputs = b.lines.map((l, i) => {
    const item = l.item_id ? items.get(l.item_id) : undefined
    if (l.item_id && !item) throw new BooksError('unknown_item', `Line ${i + 1} uses an item that is not in this set of books.`)
    const ledgerId = l.ledger_id ?? (sales ? item?.salesLedgerId : item?.purchaseLedgerId) ?? defaultLedger.id
    ledgerIds.add(ledgerId)
    const taxRateId = l.tax_rate_id ?? item?.taxRateId ?? null
    const qty = l.quantity ?? 1
    if (!(qty > 0)) throw ApiError.badRequest(`Line ${i + 1}: quantity must be positive.`)
    return { item, ledgerId, taxRateId, qty, rate: toMinor(l.rate), description: l.description?.trim() || item?.name || `Line ${i + 1}`, hsn: l.hsn_sac ?? item?.hsnSac ?? null, discBp: l.discount_percent_bp ?? 0, discAmt: toMinor(l.discount_amount ?? 0) }
  })
  const ledgers = await tx.booksLedger.findMany({ where: { id: { in: [...ledgerIds] }, booksOrgId: ctx.booksOrgId, deletedAt: null, isActive: true } })
  if (ledgers.length !== ledgerIds.size) throw new BooksError('unknown_ledger', 'A line posts to a ledger that is not in this set of books.')

  // Place of supply and tax regime.
  const placeOfSupply = b.place_of_supply ?? contact.placeOfSupplyState ?? org.stateCode ?? null
  const gstExempt = contact.gstTreatment === 'overseas' || !org.gstin
  const interState = isInterState(org.stateCode, placeOfSupply)
  const currency = b.currency ?? contact.currency ?? ctx.baseCurrency
  const exchangeRate = currency === ctx.baseCurrency ? 1 : (b.exchange_rate ?? 0)
  if (currency !== ctx.baseCurrency && !(exchangeRate > 0)) throw new BooksError('missing_rate', `An exchange rate is required for a ${currency} document.`)

  // TDS (bills only).
  let tdsBp = 0
  let tdsRateId: string | null = null
  if (kind === 'bill' && ctx.tdsEnabled) {
    const wantedId = b.tds_rate_id ?? null
    if (wantedId) {
      const t = await tx.booksTaxRate.findFirst({ where: { id: wantedId, booksOrgId: ctx.booksOrgId, type: 'tds', deletedAt: null } })
      if (!t) throw new BooksError('unknown_tax_rate', 'TDS rate not found.')
      tdsRateId = t.id
      tdsBp = contact.pan ? t.percentageBp : (t.noPanPercentageBp ?? t.percentageBp)
    } else if (contact.tdsSection) {
      const t = await tx.booksTaxRate.findFirst({ where: { booksOrgId: ctx.booksOrgId, type: 'tds', section: contact.tdsSection, isActive: true, deletedAt: null }, orderBy: { percentageBp: 'desc' } })
      if (t) { tdsRateId = t.id; tdsBp = contact.pan ? t.percentageBp : (t.noPanPercentageBp ?? t.percentageBp) }
    }
  }

  const out = computeDocument({
    lines: lineInputs.map((l) => ({ quantity: l.qty, rate: l.rate, discountPercentBp: l.discBp, discountAmount: l.discAmt, taxPercentBp: l.taxRateId ? taxes.get(l.taxRateId)?.percentageBp ?? 0 : 0 })),
    taxInclusive: b.tax_inclusive ?? false, interState, gstExempt, discountPercentBp: b.discount_percent_bp ?? 0, discountAmount: toMinor(b.discount_amount ?? 0),
    tdsPercentBp: tdsBp, roundOff: currency === 'INR', exchangeRate,
  })
  const financial = isPosting(kind)
  const header = {
    booksOrgId: ctx.booksOrgId, contactId: contact.id, date: b.date, dueDate: b.due_date ?? (['invoice', 'bill'].includes(kind) ? addDays(b.date, contact.paymentTermsDays) : null),
    expiryDate: b.expiry_date ?? null, referenceNo: b.reference_no ?? null, currency, exchangeRate, placeOfSupply, isInterState: interState, taxInclusive: b.tax_inclusive ?? false,
    discountPercentBp: b.discount_percent_bp ?? 0, discountAmount: toMinor(b.discount_amount ?? 0),
    subtotal: out.subtotal, discountTotal: out.discountTotal, taxableTotal: out.taxableTotal, cgstTotal: out.cgstTotal, sgstTotal: out.sgstTotal, igstTotal: out.igstTotal, taxTotal: out.taxTotal,
    tdsRateId, tdsTotal: out.tdsTotal, roundOff: out.roundOff, total: out.total, baseTotal: out.baseTotal,
    balanceDue: financial ? out.total - out.tdsTotal : 0n, creditsRemaining: ['credit_note', 'vendor_credit'].includes(kind) ? out.total : 0n,
    sourceDocumentId: b.source_document_id ?? null, notes: b.notes ?? null, terms: b.terms ?? null,
  }
  const lines = lineInputs.map((l, i) => ({
    booksOrgId: ctx.booksOrgId, lineNo: i + 1, itemId: l.item?.id ?? null, description: l.description, hsnSac: l.hsn, quantity: l.qty, rate: l.rate,
    discountPercentBp: l.discBp, discountAmount: out.lines[i].discount, taxRateId: l.taxRateId, taxPercentBp: out.lines[i].taxPercentBp,
    taxable: out.lines[i].taxable, cgst: out.lines[i].cgst, sgst: out.lines[i].sgst, igst: out.lines[i].igst, tax: out.lines[i].tax, lineTotal: out.lines[i].lineTotal, ledgerId: l.ledgerId,
  }))
  return { header, lines, contact, out }
}

// ── Posting rules ─────────────────────────────────────────────────────────
async function postDocument(tx: Db, ctx: BooksContext, id: string): Promise<DocRow> {
  const d = await tx.booksDocument.findFirst({ where: { id, booksOrgId: ctx.booksOrgId }, include })
  if (!d) throw ApiError.notFound('Document not found.')
  const kind = d.kind as DocKind
  if (!isPosting(kind)) throw new BooksError('not_financial', `${label(kind)}s do not post to the ledger. Convert to an invoice or bill first.`)
  if (d.status !== 'draft') throw new BooksError('already_posted', `This ${label(kind)} is ${d.status}.`)
  if (d.total <= 0n) throw new BooksError('zero_total', 'A document with a zero total cannot be posted.')
  const contact = await tx.booksContact.findUniqueOrThrow({ where: { id: d.contactId } })
  const base = (fx: Minor) => (d.exchangeRate === 1 ? fx : applyRate(fx, d.exchangeRate))
  const sales = isSales(kind)
  const control = await systemLedger(tx, ctx.booksOrgId, sales ? 'accounts_receivable' : 'accounts_payable')
  const roundOffLedger = await systemLedger(tx, ctx.booksOrgId, 'round_off')
  const lines: PostLine[] = []
  const fxOf = (amount: Minor) => ({ fxAmount: amount, fxCurrency: d.currency, exchangeRate: d.exchangeRate })
  const push = (ledgerId: string, side: 'debit' | 'credit', fx: Minor, extra: Partial<PostLine> = {}) => { if (fx > 0n) lines.push({ ledgerId, side, amount: base(fx), ...fxOf(fx), ...extra }) }

  // Per-ledger taxable totals (income / expense side).
  const byLedger = new Map<string, Minor>()
  for (const l of d.lines) byLedger.set(l.ledgerId, (byLedger.get(l.ledgerId) ?? 0n) + l.taxable)

  // The tax ledgers this document touches.
  const tax = {
    cgst: await systemLedger(tx, ctx.booksOrgId, sales ? 'cgst_output' : 'cgst_input'),
    sgst: await systemLedger(tx, ctx.booksOrgId, sales ? 'sgst_output' : 'sgst_input'),
    igst: await systemLedger(tx, ctx.booksOrgId, sales ? 'igst_output' : 'igst_input'),
  }

  let allocation: Allocation
  if (kind === 'invoice' || kind === 'retainer_invoice') {
    // Dr AR (total) · Cr income per line (or Unearned Revenue for a retainer) · Cr GST output · round-off
    push(control.id, 'debit', d.total, { partyLedgerId: control.id, description: `${contact.displayName} · ${d.number}` })
    if (kind === 'retainer_invoice') {
      const unearned = await systemLedger(tx, ctx.booksOrgId, 'unearned_revenue')
      push(unearned.id, 'credit', d.taxableTotal, { description: `Retainer ${d.number}` })
    } else {
      for (const [ledgerId, amt] of byLedger) push(ledgerId, 'credit', amt)
    }
    push(tax.cgst.id, 'credit', d.cgstTotal); push(tax.sgst.id, 'credit', d.sgstTotal); push(tax.igst.id, 'credit', d.igstTotal)
    if (d.roundOff > 0n) push(roundOffLedger.id, 'credit', d.roundOff)
    if (d.roundOff < 0n) push(roundOffLedger.id, 'debit', -d.roundOff)
    allocation = { type: 'new_ref', bill: { ledgerId: control.id, contactId: contact.id, billNo: d.number, billType: 'new_ref', sourceType: kind, sourceId: d.id, date: d.date, dueDate: d.dueDate, side: 'debit', currency: d.currency, fxAmount: d.total, amount: base(d.total) } }
  } else if (kind === 'credit_note') {
    // Dr income per line · Dr GST output · Cr AR — the credit is an open item on AR (credit side), applied manually later.
    for (const [ledgerId, amt] of byLedger) push(ledgerId, 'debit', amt)
    push(tax.cgst.id, 'debit', d.cgstTotal); push(tax.sgst.id, 'debit', d.sgstTotal); push(tax.igst.id, 'debit', d.igstTotal)
    if (d.roundOff > 0n) push(roundOffLedger.id, 'debit', d.roundOff)
    if (d.roundOff < 0n) push(roundOffLedger.id, 'credit', -d.roundOff)
    push(control.id, 'credit', d.total, { partyLedgerId: control.id, description: `${contact.displayName} · ${d.number}` })
    allocation = { type: 'on_account', bill: { ledgerId: control.id, contactId: contact.id, billNo: d.number, billType: 'on_account', sourceType: kind, sourceId: d.id, date: d.date, side: 'credit', currency: d.currency, fxAmount: d.total, amount: base(d.total) } }
  } else if (kind === 'bill') {
    // Dr expense/asset per line · Dr GST input · Cr AP (net of TDS) · Cr TDS Payable · round-off
    for (const [ledgerId, amt] of byLedger) push(ledgerId, 'debit', amt)
    push(tax.cgst.id, 'debit', d.cgstTotal); push(tax.sgst.id, 'debit', d.sgstTotal); push(tax.igst.id, 'debit', d.igstTotal)
    if (d.roundOff > 0n) push(roundOffLedger.id, 'debit', d.roundOff)
    if (d.roundOff < 0n) push(roundOffLedger.id, 'credit', -d.roundOff)
    const payable = d.total - d.tdsTotal
    push(control.id, 'credit', payable, { partyLedgerId: control.id, description: `${contact.displayName} · ${d.number}` })
    if (d.tdsTotal > 0n) { const tds = await systemLedger(tx, ctx.booksOrgId, 'tds_payable'); push(tds.id, 'credit', d.tdsTotal, { taxRateId: d.tdsRateId, description: `TDS on ${d.number}` }) }
    allocation = { type: 'new_ref', bill: { ledgerId: control.id, contactId: contact.id, billNo: d.number, billType: 'new_ref', sourceType: kind, sourceId: d.id, date: d.date, dueDate: d.dueDate, side: 'credit', currency: d.currency, fxAmount: payable, amount: base(payable) } }
  } else {
    // vendor_credit: Dr AP · Cr expense per line · Cr GST input
    push(control.id, 'debit', d.total, { partyLedgerId: control.id, description: `${contact.displayName} · ${d.number}` })
    for (const [ledgerId, amt] of byLedger) push(ledgerId, 'credit', amt)
    push(tax.cgst.id, 'credit', d.cgstTotal); push(tax.sgst.id, 'credit', d.sgstTotal); push(tax.igst.id, 'credit', d.igstTotal)
    if (d.roundOff > 0n) push(roundOffLedger.id, 'credit', d.roundOff)
    if (d.roundOff < 0n) push(roundOffLedger.id, 'debit', -d.roundOff)
    allocation = { type: 'on_account', bill: { ledgerId: control.id, contactId: contact.id, billNo: d.number, billType: 'on_account', sourceType: kind, sourceId: d.id, date: d.date, side: 'debit', currency: d.currency, fxAmount: d.total, amount: base(d.total) } }
  }

  const journal = await postJournal(tx, ctx, {
    date: d.date, voucherType: kind, sourceModule: kind, sourceId: d.id, narration: `${label(kind)} ${d.number} · ${contact.displayName}`,
    currency: d.currency, exchangeRate: d.exchangeRate, lines, allocations: [allocation],
  })
  const posted = await tx.booksDocument.update({ where: { id }, data: { status: 'posted', journalId: journal.id, updatedBy: ctx.userId }, include })
  await booksAudit(tx, ctx, { entityType: kind, entityId: id, action: `${kind}.posted`, after: { journal: journal.number, total: d.total.toString() } })
  return posted
}

// ── Credit application ────────────────────────────────────────────────────
async function applyCredit(tx: Db, ctx: BooksContext, creditId: string, apps: { document_id: string; amount: number | string }[], date?: string) {
  const credit = await tx.booksDocument.findFirst({ where: { id: creditId, booksOrgId: ctx.booksOrgId, kind: { in: ['credit_note', 'vendor_credit'] } } })
  if (!credit) throw ApiError.notFound('Credit not found.')
  if (credit.status !== 'posted') throw new BooksError('not_posted', 'Post the credit before applying it.')
  if (!apps.length) throw ApiError.badRequest('Choose at least one document to apply the credit to.')
  const isCN = credit.kind === 'credit_note'
  const control = await systemLedger(tx, ctx.booksOrgId, isCN ? 'accounts_receivable' : 'accounts_payable')
  const creditBill = await tx.booksBill.findFirst({ where: { booksOrgId: ctx.booksOrgId, sourceType: credit.kind, sourceId: credit.id } })
  if (!creditBill || creditBill.balance <= 0n) throw new BooksError('credit_exhausted', 'This credit has nothing left to apply.')

  const total = sum(apps.map((a) => toMinor(a.amount)))
  if (total <= 0n) throw ApiError.badRequest('Application amount must be positive.')
  if (total > creditBill.balance) throw new BooksError('over_allocation', `Only ${creditBill.balance} of credit remains.`)
  const allocations: Allocation[] = [{ type: 'against_ref', billId: creditBill.id, amount: total }]
  for (const a of apps) {
    const target = await tx.booksDocument.findFirst({ where: { id: a.document_id, booksOrgId: ctx.booksOrgId, kind: isCN ? 'invoice' : 'bill', contactId: credit.contactId } })
    if (!target) throw new BooksError('unknown_document', 'Credits apply only to posted invoices / bills of the same contact.')
    const bill = await tx.booksBill.findFirst({ where: { booksOrgId: ctx.booksOrgId, sourceType: target.kind, sourceId: target.id } })
    if (!bill || bill.status !== 'open') throw new BooksError('bill_closed', `${target.number} has nothing outstanding.`)
    const amt = toMinor(a.amount)
    if (amt > bill.balance) throw new BooksError('over_allocation', `${target.number} has only ${bill.balance} outstanding.`)
    allocations.push({ type: 'against_ref', billId: bill.id, amount: amt })
    await tx.booksDocument.update({ where: { id: target.id }, data: { balanceDue: target.balanceDue - amt, status: target.balanceDue - amt === 0n ? 'paid' : 'partially_paid' } })
  }
  // Both open items sit on the same control ledger, so the journal is a
  // balanced contra on that ledger that carries the allocations.
  const journal = await postJournal(tx, ctx, {
    date: date ?? new Date().toISOString().slice(0, 10), voucherType: isCN ? 'credit_apply' : 'vendor_credit_apply', sourceModule: credit.kind, sourceId: credit.id,
    narration: `${credit.number} applied to ${apps.length} document${apps.length === 1 ? '' : 's'}`,
    lines: [{ ledgerId: control.id, side: isCN ? 'debit' : 'credit', amount: total, description: `Apply ${credit.number}` }, { ledgerId: control.id, side: isCN ? 'credit' : 'debit', amount: total, description: `Settle against ${credit.number}` }],
    allocations,
  })
  const remaining = creditBill.balance - total
  const updated = await tx.booksDocument.update({ where: { id: credit.id }, data: { creditsRemaining: remaining, status: remaining === 0n ? 'closed' : 'posted' }, include })
  await booksAudit(tx, ctx, { entityType: credit.kind, entityId: credit.id, action: `${credit.kind}.applied`, after: { journal: journal.number, applications: apps.map((a) => ({ document_id: a.document_id, amount: String(a.amount) })) } })
  return updated
}

async function applyRetainer(tx: Db, ctx: BooksContext, retainerId: string, apps: { document_id: string; amount: number | string }[], date?: string) {
  const ret = await tx.booksDocument.findFirst({ where: { id: retainerId, booksOrgId: ctx.booksOrgId, kind: 'retainer_invoice' } })
  if (!ret) throw ApiError.notFound('Retainer invoice not found.')
  if (!['posted', 'paid', 'partially_paid', 'closed'].includes(ret.status)) throw new BooksError('not_posted', 'Post the retainer invoice first.')
  const retBill = await tx.booksBill.findFirst({ where: { booksOrgId: ctx.booksOrgId, sourceType: 'retainer_invoice', sourceId: ret.id } })
  if (!retBill || retBill.balance > 0n) throw new BooksError('retainer_unpaid', 'A retainer can be applied only after the customer has paid it.')
  const applied = sum((await tx.booksJournal.findMany({ where: { booksOrgId: ctx.booksOrgId, voucherType: 'retainer_apply', sourceId: ret.id, status: 'posted' } })).map((j) => j.totalDebit))
  const available = ret.taxableTotal - applied
  const total = sum(apps.map((a) => toMinor(a.amount)))
  if (total <= 0n || total > available) throw new BooksError('over_allocation', `Only ${available} of this retainer remains to apply.`)
  const ar = await systemLedger(tx, ctx.booksOrgId, 'accounts_receivable')
  const unearned = await systemLedger(tx, ctx.booksOrgId, 'unearned_revenue')
  const allocations: Allocation[] = []
  for (const a of apps) {
    const inv = await tx.booksDocument.findFirst({ where: { id: a.document_id, booksOrgId: ctx.booksOrgId, kind: 'invoice', contactId: ret.contactId } })
    if (!inv) throw new BooksError('unknown_document', 'A retainer applies only to posted invoices of the same customer.')
    const bill = await tx.booksBill.findFirst({ where: { booksOrgId: ctx.booksOrgId, sourceType: 'invoice', sourceId: inv.id } })
    if (!bill || bill.status !== 'open') throw new BooksError('bill_closed', `${inv.number} has nothing outstanding.`)
    const amt = toMinor(a.amount)
    if (amt > bill.balance) throw new BooksError('over_allocation', `${inv.number} has only ${bill.balance} outstanding.`)
    allocations.push({ type: 'against_ref', billId: bill.id, amount: amt })
    await tx.booksDocument.update({ where: { id: inv.id }, data: { balanceDue: inv.balanceDue - amt, status: inv.balanceDue - amt === 0n ? 'paid' : 'partially_paid' } })
  }
  const journal = await postJournal(tx, ctx, {
    date: date ?? new Date().toISOString().slice(0, 10), voucherType: 'retainer_apply', sourceModule: 'retainer_invoice', sourceId: ret.id,
    narration: `Retainer ${ret.number} applied — revenue recognised`,
    lines: [{ ledgerId: unearned.id, side: 'debit', amount: total }, { ledgerId: ar.id, side: 'credit', amount: total, partyLedgerId: ar.id }],
    allocations,
  })
  const updated = await tx.booksDocument.update({ where: { id: ret.id }, data: { creditsRemaining: available - total, status: available - total === 0n ? 'closed' : ret.status }, include })
  await booksAudit(tx, ctx, { entityType: 'retainer_invoice', entityId: ret.id, action: 'retainer_invoice.applied', after: { journal: journal.number, amount: total.toString() } })
  return updated
}

// ── Helpers ───────────────────────────────────────────────────────────────
export function label(kind: string): string {
  return ({ estimate: 'estimate', sales_order: 'sales order', invoice: 'invoice', retainer_invoice: 'retainer invoice', credit_note: 'credit note', purchase_order: 'purchase order', bill: 'bill', vendor_credit: 'vendor credit' } as Record<string, string>)[kind] ?? kind
}
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10)
}
function snapshot(d: DocRow) {
  return { number: d.number, status: d.status, date: d.date, contact_id: d.contactId, total: d.total.toString(), lines: d.lines.length }
}
