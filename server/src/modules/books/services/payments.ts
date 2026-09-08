import crypto from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { ApiError } from '../../../lib/http.js'
import type { BooksContext, Db } from '../engine/context.js'
import { booksAudit } from '../engine/audit.js'
import { BooksError } from '../engine/errors.js'
import { applyRate, divRound, sum, toMinor, type Minor } from '../engine/money.js'
import { nextNumber } from '../engine/numbering.js'
import { systemLedger } from '../engine/organisation.js'
import { postJournal, voidJournal, withBooksTx, type Allocation, type PostLine } from '../engine/posting.js'

/**
 * PAYMENTS — received from customers and made to vendors.
 *
 * Every payment is allocated explicitly against open items (partial, or one
 * payment across many invoices); anything left over becomes an advance open
 * item on the control ledger, never a running net. A foreign-currency
 * payment settles the open item at the item's own base value and books the
 * difference to Exchange Gain / Loss (realised).
 *
 *   received:  Dr Bank (amount − charges) · Dr Bank Charges · Dr TDS Receivable
 *              Cr AR (amount + TDS)                          [± FX gain/loss]
 *   made:      Dr AP (amount) · Cr Bank (amount + charges) · Dr Bank Charges
 */
export interface PaymentInput {
  contact_id: string
  date: string
  amount: number | string
  currency?: string
  exchange_rate?: number
  deposit_ledger_id: string
  bank_charges?: number | string
  /** TDS deducted by the customer at source (received payments only). */
  tds_amount?: number | string
  mode?: string
  reference?: string | null
  notes?: string | null
  allocations: { document_id: string; amount: number | string }[]
}

export const Payments = {
  list: (prisma: PrismaClient, ctx: BooksContext, kind: 'received' | 'made', f: { contact_id?: string; from?: string; to?: string } = {}) =>
    prisma.booksPayment.findMany({
      where: { booksOrgId: ctx.booksOrgId, kind, ...(f.contact_id ? { contactId: f.contact_id } : {}), ...(f.from || f.to ? { date: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}) },
      orderBy: [{ date: 'desc' }, { number: 'desc' }],
    }),

  get: async (prisma: PrismaClient, ctx: BooksContext, id: string) => {
    const p = await prisma.booksPayment.findFirst({ where: { id, booksOrgId: ctx.booksOrgId } })
    if (!p) throw ApiError.notFound('Payment not found.')
    const allocations = p.journalId ? await prisma.booksBillAllocation.findMany({ where: { journalId: p.journalId }, include: { bill: true } }) : []
    return { payment: p, allocations }
  },

  create: (prisma: PrismaClient, ctx: BooksContext, kind: 'received' | 'made', b: PaymentInput) => withBooksTx(prisma, async (tx) => createPayment(tx, ctx, kind, b)),

  void: (prisma: PrismaClient, ctx: BooksContext, id: string, reason?: string | null) => withBooksTx(prisma, async (tx) => {
    const p = await tx.booksPayment.findFirst({ where: { id, booksOrgId: ctx.booksOrgId } })
    if (!p) throw ApiError.notFound('Payment not found.')
    if (p.status === 'void') throw new BooksError('already_void', 'Already void.')
    if (p.journalId) {
      const allocs = await tx.booksBillAllocation.findMany({ where: { journalId: p.journalId, type: 'against_ref' }, include: { bill: true } })
      await voidJournal(tx, ctx, p.journalId, { reason: reason ?? null })
      // Give the settled amounts back to the documents.
      for (const a of allocs) {
        const doc = await tx.booksDocument.findFirst({ where: { booksOrgId: ctx.booksOrgId, kind: a.bill.sourceType, id: a.bill.sourceId } })
        if (doc) {
          const fx = doc.exchangeRate === 1 ? a.amount : divRound(a.fxAmount, 1n)
          await tx.booksDocument.update({ where: { id: doc.id }, data: { balanceDue: doc.balanceDue + fx, status: doc.balanceDue + fx >= doc.total - doc.tdsTotal ? 'posted' : 'partially_paid' } })
        }
      }
    }
    const u = await tx.booksPayment.update({ where: { id }, data: { status: 'void' } })
    await booksAudit(tx, ctx, { entityType: `payment_${p.kind}`, entityId: id, action: `payment_${p.kind}.voided`, after: { reason: reason ?? null } })
    return u
  }),
}

async function createPayment(tx: Db, ctx: BooksContext, kind: 'received' | 'made', b: PaymentInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date ?? '')) throw ApiError.badRequest('date must be YYYY-MM-DD.')
  const amount = toMinor(b.amount)
  if (amount <= 0n) throw ApiError.badRequest('amount must be positive.')
  const contact = await tx.booksContact.findFirst({ where: { id: b.contact_id, booksOrgId: ctx.booksOrgId, deletedAt: null } })
  if (!contact) throw new BooksError('unknown_contact', 'Contact not found in this set of books.')
  const deposit = await tx.booksLedger.findFirst({ where: { id: b.deposit_ledger_id, booksOrgId: ctx.booksOrgId, deletedAt: null, isActive: true } })
  if (!deposit || !(deposit.isBank || deposit.isCash || deposit.systemKey === 'undeposited_funds')) throw new BooksError('not_bank_ledger', 'Deposit-to must be a bank, cash or undeposited-funds ledger.')
  const currency = b.currency ?? contact.currency ?? ctx.baseCurrency
  const rate = currency === ctx.baseCurrency ? 1 : (b.exchange_rate ?? 0)
  if (currency !== ctx.baseCurrency && !(rate > 0)) throw new BooksError('missing_rate', `An exchange rate is required for a ${currency} payment.`)
  const base = (fx: Minor) => (rate === 1 ? fx : applyRate(fx, rate))
  const charges = toMinor(b.bank_charges ?? 0)
  const tds = kind === 'received' ? toMinor(b.tds_amount ?? 0) : 0n
  if (charges < 0n || tds < 0n) throw ApiError.badRequest('Charges and TDS cannot be negative.')

  const control = await systemLedger(tx, ctx.booksOrgId, kind === 'received' ? 'accounts_receivable' : 'accounts_payable')
  const settles = amount + tds          // what the open items are reduced by (transaction currency)
  const allocs = b.allocations ?? []
  const allocTotal = sum(allocs.map((a) => toMinor(a.amount)))
  if (allocTotal > settles) throw new BooksError('over_allocation', `Allocations (${allocTotal}) exceed the amount being settled (${settles}).`)

  const number = await nextNumber(tx, ctx.booksOrgId, kind === 'received' ? 'payment_in' : 'payment_out')
  const lines: PostLine[] = []
  const allocations: Allocation[] = []
  const fxOf = (fx: Minor) => ({ fxAmount: fx, fxCurrency: currency, exchangeRate: rate })
  let fxGain = 0n  // base-currency: positive = gain

  // Open items settled — at each item's own base value; the difference is realised FX.
  let controlBase = 0n
  for (const a of allocs) {
    const amt = toMinor(a.amount)
    if (amt <= 0n) throw ApiError.badRequest('Allocation amounts must be positive.')
    const doc = await tx.booksDocument.findFirst({ where: { id: a.document_id, booksOrgId: ctx.booksOrgId, kind: kind === 'received' ? { in: ['invoice', 'retainer_invoice'] } : 'bill', contactId: contact.id } })
    if (!doc) throw new BooksError('unknown_document', 'Allocations must point at posted invoices / bills of this contact.')
    if (doc.currency !== currency) throw new BooksError('currency_mismatch', `${doc.number} is in ${doc.currency}; pay it in the same currency.`)
    const bill = await tx.booksBill.findFirst({ where: { booksOrgId: ctx.booksOrgId, sourceType: doc.kind, sourceId: doc.id } })
    if (!bill || bill.status !== 'open') throw new BooksError('bill_closed', `${doc.number} has nothing outstanding.`)
    if (amt > bill.fxBalance) throw new BooksError('over_allocation', `${doc.number} has only ${bill.fxBalance} outstanding.`)
    // Base value of this slice at the document's rate.
    const baseSlice = bill.fxBalance === amt ? bill.balance : divRound(bill.balance * amt, bill.fxBalance)
    controlBase += baseSlice
    fxGain += (kind === 'received' ? 1n : -1n) * (base(amt) - baseSlice)
    allocations.push({ type: 'against_ref', billId: bill.id, amount: baseSlice, fxAmount: amt })
    const newDue = doc.balanceDue - amt
    await tx.booksDocument.update({ where: { id: doc.id }, data: { balanceDue: newDue, status: newDue === 0n ? 'paid' : 'partially_paid' } })
  }
  // Unallocated remainder → an advance open item on the control ledger.
  const advanceFx = settles - allocTotal
  if (advanceFx > 0n) {
    const advBase = base(advanceFx)
    controlBase += advBase
    allocations.push({ type: 'advance', bill: { ledgerId: control.id, contactId: contact.id, billNo: number, billType: 'advance', sourceType: kind === 'received' ? 'payment_received' : 'payment_made', sourceId: number, date: b.date, side: kind === 'received' ? 'credit' : 'debit', currency, fxAmount: advanceFx, amount: advBase } })
  }

  if (kind === 'received') {
    const net = amount - charges
    if (net <= 0n) throw ApiError.badRequest('Bank charges cannot exceed the amount received.')
    lines.push({ ledgerId: deposit.id, side: 'debit', amount: base(net), ...fxOf(net), description: `${contact.displayName} · ${number}` })
    if (charges > 0n) { const bc = await systemLedger(tx, ctx.booksOrgId, 'bank_charges'); lines.push({ ledgerId: bc.id, side: 'debit', amount: base(charges), ...fxOf(charges) }) }
    if (tds > 0n) { const tr = await systemLedger(tx, ctx.booksOrgId, 'tds_receivable'); lines.push({ ledgerId: tr.id, side: 'debit', amount: base(tds), ...fxOf(tds), description: `TDS deducted by ${contact.displayName}` }) }
    lines.push({ ledgerId: control.id, side: 'credit', amount: controlBase, ...fxOf(settles), partyLedgerId: control.id, description: `${contact.displayName} · ${number}` })
  } else {
    lines.push({ ledgerId: control.id, side: 'debit', amount: controlBase, ...fxOf(settles), partyLedgerId: control.id, description: `${contact.displayName} · ${number}` })
    lines.push({ ledgerId: deposit.id, side: 'credit', amount: base(amount), ...fxOf(amount), description: `${contact.displayName} · ${number}` })
    if (charges > 0n) { const bc = await systemLedger(tx, ctx.booksOrgId, 'bank_charges'); lines.push({ ledgerId: bc.id, side: 'debit', amount: base(charges), ...fxOf(charges) }); lines.push({ ledgerId: deposit.id, side: 'credit', amount: base(charges), ...fxOf(charges), description: 'Bank charges' }) }
  }
  if (fxGain !== 0n) {
    const fx = await systemLedger(tx, ctx.booksOrgId, 'fx_gain_loss')
    lines.push({ ledgerId: fx.id, side: fxGain > 0n ? 'credit' : 'debit', amount: fxGain > 0n ? fxGain : -fxGain, fxAmount: fxGain > 0n ? fxGain : -fxGain, fxCurrency: ctx.baseCurrency, exchangeRate: 1, description: 'Realised exchange difference' })
  }

  const paymentId = crypto.randomUUID()
  const journal = await postJournal(tx, ctx, {
    date: b.date, voucherType: kind === 'received' ? 'payment_in' : 'payment_out', number, sourceModule: `payment_${kind}`, sourceId: paymentId,
    narration: `Payment ${kind} ${number} · ${contact.displayName}`, currency, exchangeRate: rate, lines, allocations,
  })
  const payment = await tx.booksPayment.create({
    data: {
      id: paymentId, booksOrgId: ctx.booksOrgId, kind, number, contactId: contact.id, date: b.date, currency, exchangeRate: rate, fxAmount: amount, amount: base(amount),
      depositLedgerId: deposit.id, bankCharges: charges, tdsAmount: tds, mode: b.mode ?? 'bank_transfer', reference: b.reference ?? null, notes: b.notes ?? null, journalId: journal.id, createdBy: ctx.userId,
    },
  })
  await booksAudit(tx, ctx, { entityType: `payment_${kind}`, entityId: payment.id, action: `payment_${kind}.created`, after: { number, amount: amount.toString(), currency, allocations: allocs.length, fx_gain: fxGain.toString() } })
  return payment
}

export type PaymentRow = Prisma.BooksPaymentGetPayload<object>
