import type { PrismaClient } from '@prisma/client'
import { ApiError } from '../../../lib/http.js'
import type { BooksContext } from '../engine/context.js'
import { booksAudit } from '../engine/audit.js'
import { BooksError } from '../engine/errors.js'
import { toMinor } from '../engine/money.js'
import { nextNumber } from '../engine/numbering.js'
import { postJournal, voidJournal, withBooksTx } from '../engine/posting.js'

/**
 * BANKING — transfers between bank/cash ledgers, manually entered statement
 * lines, and reconciliation: a ledger-side journal line is matched to one
 * statement line. No statement parsing here (separate ingestion module).
 */
export const Banking = {
  accounts: async (prisma: PrismaClient, ctx: BooksContext) => {
    const ledgers = await prisma.booksLedger.findMany({ where: { booksOrgId: ctx.booksOrgId, deletedAt: null, OR: [{ isBank: true }, { isCash: true }] }, orderBy: { name: 'asc' } })
    const sums = await prisma.booksJournalLine.groupBy({ by: ['ledgerId', 'side'], where: { booksOrgId: ctx.booksOrgId, ledgerId: { in: ledgers.map((l) => l.id) }, journal: { status: { in: ['posted', 'void'] } } }, _sum: { amount: true } })
    return ledgers.map((l) => {
      const d = sums.find((s) => s.ledgerId === l.id && s.side === 'debit')?._sum.amount ?? 0n
      const c = sums.find((s) => s.ledgerId === l.id && s.side === 'credit')?._sum.amount ?? 0n
      return { ...l, balance: d - c }
    })
  },

  transfer: (prisma: PrismaClient, ctx: BooksContext, b: { date: string; from_ledger_id: string; to_ledger_id: string; amount: number | string; reference?: string | null; notes?: string | null }) => withBooksTx(prisma, async (tx) => {
    const amount = toMinor(b.amount)
    if (amount <= 0n) throw ApiError.badRequest('amount must be positive.')
    if (b.from_ledger_id === b.to_ledger_id) throw ApiError.badRequest('Choose two different accounts.')
    const both = await tx.booksLedger.findMany({ where: { id: { in: [b.from_ledger_id, b.to_ledger_id] }, booksOrgId: ctx.booksOrgId, deletedAt: null, OR: [{ isBank: true }, { isCash: true }] } })
    if (both.length !== 2) throw new BooksError('not_bank_ledger', 'Both accounts must be bank or cash ledgers in this set of books.')
    const number = await nextNumber(tx, ctx.booksOrgId, 'transfer')
    const journal = await postJournal(tx, ctx, {
      date: b.date, voucherType: 'transfer', number, sourceModule: 'bank_transfer', sourceId: number, narration: `Transfer ${number}${b.reference ? ` · ${b.reference}` : ''}`,
      lines: [{ ledgerId: b.to_ledger_id, side: 'debit', amount, description: b.notes ?? null }, { ledgerId: b.from_ledger_id, side: 'credit', amount, description: b.notes ?? null }],
    })
    const t = await tx.booksBankTransfer.create({ data: { booksOrgId: ctx.booksOrgId, date: b.date, number, fromLedgerId: b.from_ledger_id, toLedgerId: b.to_ledger_id, amount, reference: b.reference ?? null, notes: b.notes ?? null, journalId: journal.id, createdBy: ctx.userId } })
    await booksAudit(tx, ctx, { entityType: 'bank_transfer', entityId: t.id, action: 'bank_transfer.created', after: { number, amount: amount.toString() } })
    return t
  }),

  transfers: (prisma: PrismaClient, ctx: BooksContext) => prisma.booksBankTransfer.findMany({ where: { booksOrgId: ctx.booksOrgId }, orderBy: [{ date: 'desc' }, { number: 'desc' }] }),

  voidTransfer: (prisma: PrismaClient, ctx: BooksContext, id: string, reason?: string | null) => withBooksTx(prisma, async (tx) => {
    const t = await tx.booksBankTransfer.findFirst({ where: { id, booksOrgId: ctx.booksOrgId } })
    if (!t) throw ApiError.notFound('Transfer not found.')
    if (t.status === 'void') throw new BooksError('already_void', 'Already void.')
    if (t.journalId) await voidJournal(tx, ctx, t.journalId, { reason: reason ?? null })
    await booksAudit(tx, ctx, { entityType: 'bank_transfer', entityId: id, action: 'bank_transfer.voided' })
    return tx.booksBankTransfer.update({ where: { id }, data: { status: 'void' } })
  }),

  // ── Statement lines ─────────────────────────────────────────────────────
  addStatementLines: (prisma: PrismaClient, ctx: BooksContext, ledgerId: string, lines: { date: string; description: string; amount: number | string; reference?: string | null }[]) => withBooksTx(prisma, async (tx) => {
    const ledger = await tx.booksLedger.findFirst({ where: { id: ledgerId, booksOrgId: ctx.booksOrgId, deletedAt: null, OR: [{ isBank: true }, { isCash: true }] } })
    if (!ledger) throw new BooksError('not_bank_ledger', 'Statement lines belong to a bank ledger.')
    const created = []
    for (const l of lines) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(l.date)) throw ApiError.badRequest('date must be YYYY-MM-DD.')
      const amount = toMinor(l.amount)
      if (amount === 0n) throw ApiError.badRequest('A statement line cannot be zero.')
      created.push(await tx.booksBankStatementLine.create({ data: { booksOrgId: ctx.booksOrgId, ledgerId, date: l.date, description: l.description ?? '', amount, reference: l.reference ?? null, createdBy: ctx.userId } }))
    }
    await booksAudit(tx, ctx, { entityType: 'ledger', entityId: ledgerId, action: 'statement.lines_added', after: { count: created.length } })
    return created
  }),

  deleteStatementLine: (prisma: PrismaClient, ctx: BooksContext, id: string) => withBooksTx(prisma, async (tx) => {
    const l = await tx.booksBankStatementLine.findFirst({ where: { id, booksOrgId: ctx.booksOrgId } })
    if (!l) throw ApiError.notFound('Statement line not found.')
    if (l.matchedJournalLineId) throw new BooksError('line_matched', 'Unmatch this line before deleting it.')
    await tx.booksBankStatementLine.delete({ where: { id } })
    await booksAudit(tx, ctx, { entityType: 'ledger', entityId: l.ledgerId, action: 'statement.line_deleted', before: { date: l.date, amount: l.amount.toString() } })
  }),

  /** Everything needed to reconcile one bank ledger. */
  reconciliation: async (prisma: PrismaClient, ctx: BooksContext, ledgerId: string, f: { from?: string; to?: string } = {}) => {
    const ledger = await prisma.booksLedger.findFirst({ where: { id: ledgerId, booksOrgId: ctx.booksOrgId, deletedAt: null } })
    if (!ledger) throw ApiError.notFound('Ledger not found.')
    const dateWhere = f.from || f.to ? { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } : undefined
    const journalLines = await prisma.booksJournalLine.findMany({
      where: { booksOrgId: ctx.booksOrgId, ledgerId, journal: { status: { in: ['posted', 'void'] }, ...(dateWhere ? { date: dateWhere } : {}) } },
      include: { journal: { select: { id: true, number: true, date: true, narration: true, voucherType: true, status: true } } },
      orderBy: { journal: { date: 'asc' } },
    })
    const statementLines = await prisma.booksBankStatementLine.findMany({ where: { booksOrgId: ctx.booksOrgId, ledgerId, ...(dateWhere ? { date: dateWhere } : {}) }, orderBy: { date: 'asc' } })
    const ledgerBalance = journalLines.reduce((t, l) => t + (l.side === 'debit' ? l.amount : -l.amount), 0n)
    const reconciledBalance = journalLines.filter((l) => l.reconciledAt).reduce((t, l) => t + (l.side === 'debit' ? l.amount : -l.amount), 0n)
    const statementBalance = statementLines.reduce((t, l) => t + l.amount, 0n)
    return {
      ledger, journal_lines: journalLines, statement_lines: statementLines,
      summary: { ledger_balance: ledgerBalance, reconciled_balance: reconciledBalance, unreconciled: ledgerBalance - reconciledBalance, statement_balance: statementBalance, unmatched_statement: statementLines.filter((l) => !l.matchedJournalLineId).length },
    }
  },

  match: (prisma: PrismaClient, ctx: BooksContext, statementLineId: string, journalLineId: string) => withBooksTx(prisma, async (tx) => {
    const s = await tx.booksBankStatementLine.findFirst({ where: { id: statementLineId, booksOrgId: ctx.booksOrgId } })
    const j = await tx.booksJournalLine.findFirst({ where: { id: journalLineId, booksOrgId: ctx.booksOrgId }, include: { journal: true } })
    if (!s || !j) throw ApiError.notFound('Line not found.')
    if (s.ledgerId !== j.ledgerId) throw new BooksError('ledger_mismatch', 'The statement line and the ledger entry belong to different accounts.')
    if (s.matchedJournalLineId || j.reconciledStatementLineId) throw new BooksError('already_matched', 'One of these lines is already reconciled.')
    const signed = j.side === 'debit' ? j.amount : -j.amount
    if (signed !== s.amount) throw new BooksError('amount_mismatch', `Ledger entry ${signed} does not equal statement line ${s.amount}.`)
    const now = new Date()
    await tx.booksBankStatementLine.update({ where: { id: s.id }, data: { matchedJournalLineId: j.id, matchedAt: now } })
    await tx.booksJournalLine.update({ where: { id: j.id }, data: { reconciledStatementLineId: s.id, reconciledAt: now } })
    await booksAudit(tx, ctx, { entityType: 'journal', entityId: j.journalId, action: 'bank.reconciled', after: { statement_line: s.id, amount: s.amount.toString() } })
  }),

  unmatch: (prisma: PrismaClient, ctx: BooksContext, statementLineId: string) => withBooksTx(prisma, async (tx) => {
    const s = await tx.booksBankStatementLine.findFirst({ where: { id: statementLineId, booksOrgId: ctx.booksOrgId } })
    if (!s || !s.matchedJournalLineId) throw ApiError.notFound('Matched statement line not found.')
    await tx.booksJournalLine.update({ where: { id: s.matchedJournalLineId }, data: { reconciledStatementLineId: null, reconciledAt: null } })
    await tx.booksBankStatementLine.update({ where: { id: s.id }, data: { matchedJournalLineId: null, matchedAt: null } })
    await booksAudit(tx, ctx, { entityType: 'ledger', entityId: s.ledgerId, action: 'bank.unreconciled', before: { statement_line: s.id } })
  }),
}
