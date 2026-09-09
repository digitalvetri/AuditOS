import crypto from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { ApiError } from '../../../lib/http.js'
import type { BooksContext } from '../engine/context.js'
import { booksAudit } from '../engine/audit.js'
import { BooksError } from '../engine/errors.js'
import { applyRate, type Minor } from '../engine/money.js'
import { systemLedger } from '../engine/organisation.js'
import { postJournal, voidJournal, withBooksTx, type Allocation, type PostLine } from '../engine/posting.js'

/**
 * MULTI-CURRENCY — exchange rates by date, and revaluation of open
 * foreign-currency items: each open invoice / bill is restated at the new
 * rate, the delta is booked to Exchange Gain / Loss (unrealised), and the
 * item's base balance is updated so a later payment realises only what is
 * left. Realised differences on settlement live in payments.ts.
 */
export const FX = {
  rates: (prisma: PrismaClient, ctx: BooksContext, currency?: string) =>
    prisma.booksExchangeRate.findMany({ where: { booksOrgId: ctx.booksOrgId, ...(currency ? { currency } : {}) }, orderBy: [{ currency: 'asc' }, { date: 'desc' }] }),

  setRate: (prisma: PrismaClient, ctx: BooksContext, b: { currency: string; date: string; rate: number }) => withBooksTx(prisma, async (tx) => {
    if (!/^[A-Z]{3}$/.test(b.currency ?? '')) throw ApiError.badRequest('currency must be a 3-letter ISO code.')
    if (b.currency === ctx.baseCurrency) throw ApiError.badRequest(`${b.currency} is the base currency.`)
    if (!(b.rate > 0)) throw ApiError.badRequest('rate must be positive.')
    const r = await tx.booksExchangeRate.upsert({ where: { booksOrgId_currency_date: { booksOrgId: ctx.booksOrgId, currency: b.currency, date: b.date } }, update: { rate: b.rate }, create: { booksOrgId: ctx.booksOrgId, currency: b.currency, date: b.date, rate: b.rate } })
    await booksAudit(tx, ctx, { entityType: 'exchange_rate', entityId: r.id, action: 'exchange_rate.set', after: { currency: b.currency, date: b.date, rate: b.rate } })
    return r
  }),

  /** Latest rate on or before `date`. */
  rateFor: async (prisma: PrismaClient, ctx: BooksContext, currency: string, date: string) => {
    if (currency === ctx.baseCurrency) return 1
    const r = await prisma.booksExchangeRate.findFirst({ where: { booksOrgId: ctx.booksOrgId, currency, date: { lte: date } }, orderBy: { date: 'desc' } })
    return r?.rate ?? null
  },

  /** Open foreign-currency items with their current base and what they would be at a rate. */
  exposure: async (prisma: PrismaClient, ctx: BooksContext, currency: string, rate?: number) => {
    const bills = await prisma.booksBill.findMany({ where: { booksOrgId: ctx.booksOrgId, currency, status: 'open', fxBalance: { gt: 0n } }, orderBy: { date: 'asc' } })
    return bills.map((b) => ({ ...b, revalued: rate ? applyRate(b.fxBalance, rate) : null, delta: rate ? applyRate(b.fxBalance, rate) - b.balance : null }))
  },

  revalue: (prisma: PrismaClient, ctx: BooksContext, b: { currency: string; rate: number; date: string }) => withBooksTx(prisma, async (tx) => {
    if (!(b.rate > 0)) throw ApiError.badRequest('rate must be positive.')
    if (b.currency === ctx.baseCurrency) throw ApiError.badRequest('Base currency needs no revaluation.')
    const bills = await tx.booksBill.findMany({ where: { booksOrgId: ctx.booksOrgId, currency: b.currency, status: 'open', fxBalance: { gt: 0n } } })
    if (!bills.length) throw new BooksError('nothing_to_revalue', `No open ${b.currency} items.`)
    const fxLedger = await systemLedger(tx, ctx.booksOrgId, 'fx_gain_loss')
    const byLedger = new Map<string, Minor>()   // signed delta per control ledger (base)
    const allocations: Allocation[] = []
    const detail: { bill_no: string; fx_balance: string; old_base: string; new_base: string; delta: string }[] = []
    let net = 0n   // gain (+) / loss (−) in base
    for (const bill of bills) {
      const newBase = applyRate(bill.fxBalance, b.rate)
      const delta = newBase - bill.balance
      if (delta === 0n) continue
      byLedger.set(bill.ledgerId, (byLedger.get(bill.ledgerId) ?? 0n) + delta)
      // A receivable growing is a gain; a payable growing is a loss.
      net += bill.side === 'debit' ? delta : -delta
      allocations.push({ type: 'revalue', billId: bill.id, newBalance: newBase })
      detail.push({ bill_no: bill.billNo, fx_balance: bill.fxBalance.toString(), old_base: bill.balance.toString(), new_base: newBase.toString(), delta: delta.toString() })
    }
    if (!allocations.length) throw new BooksError('nothing_to_revalue', 'Every open item is already at this rate.')
    const lines: PostLine[] = []
    for (const [ledgerId, delta] of byLedger) {
      // Debit-side control (AR) rises with a positive delta; credit-side (AP) rises with a credit.
      const sample = bills.find((x) => x.ledgerId === ledgerId)!
      const side: 'debit' | 'credit' = sample.side === 'debit' ? (delta > 0n ? 'debit' : 'credit') : (delta > 0n ? 'credit' : 'debit')
      lines.push({ ledgerId, side, amount: delta > 0n ? delta : -delta, fxCurrency: ctx.baseCurrency, exchangeRate: 1, description: `Revaluation of ${b.currency} at ${b.rate}` })
    }
    lines.push({ ledgerId: fxLedger.id, side: net > 0n ? 'credit' : 'debit', amount: net > 0n ? net : -net, fxCurrency: ctx.baseCurrency, exchangeRate: 1, description: 'Unrealised exchange difference' })
    const revId = crypto.randomUUID()
    const journal = await postJournal(tx, ctx, { date: b.date, voucherType: 'revaluation', sourceModule: 'revaluation', sourceId: revId, narration: `${b.currency} revalued at ${b.rate}`, lines, allocations })
    await tx.booksExchangeRate.upsert({ where: { booksOrgId_currency_date: { booksOrgId: ctx.booksOrgId, currency: b.currency, date: b.date } }, update: { rate: b.rate }, create: { booksOrgId: ctx.booksOrgId, currency: b.currency, date: b.date, rate: b.rate } })
    const rev = await tx.booksRevaluation.create({ data: { id: revId, booksOrgId: ctx.booksOrgId, date: b.date, currency: b.currency, rate: b.rate, delta: net, journalId: journal.id, detailJson: JSON.stringify(detail), createdBy: ctx.userId } })
    await booksAudit(tx, ctx, { entityType: 'revaluation', entityId: rev.id, action: 'revaluation.posted', after: { currency: b.currency, rate: b.rate, net: net.toString(), items: detail.length } })
    return { revaluation: rev, journal, detail }
  }),

  revaluations: (prisma: PrismaClient, ctx: BooksContext) => prisma.booksRevaluation.findMany({ where: { booksOrgId: ctx.booksOrgId }, orderBy: { date: 'desc' } }),

  voidRevaluation: (prisma: PrismaClient, ctx: BooksContext, id: string) => withBooksTx(prisma, async (tx) => {
    const r = await tx.booksRevaluation.findFirst({ where: { id, booksOrgId: ctx.booksOrgId } })
    if (!r || !r.journalId) throw ApiError.notFound('Revaluation not found.')
    await voidJournal(tx, ctx, r.journalId, { reason: 'revaluation reversed' })
    await booksAudit(tx, ctx, { entityType: 'revaluation', entityId: id, action: 'revaluation.voided' })
  }),
}
