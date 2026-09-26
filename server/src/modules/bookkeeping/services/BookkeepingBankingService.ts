import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { BookkeepingCompanyService } from './BookkeepingCompanyService.js'
import { ledgerBalances } from '../engine/balances.js'
import { daysBetween } from '../engine/primitives.js'

/**
 * BookkeepingBankingService — bank accounts, the bank book, statement import
 * and reconciliation.
 *
 * Reconciliation NEVER changes an amount. Matching a statement line to a
 * voucher entry records the bank date and who matched it; the book figure
 * stays exactly what the voucher says. A difference between book and
 * statement is reported, not "corrected".
 */

const ACTIVE = { status: 'active', ...alive }

async function bankLedgerOf(companyId: string, bankLedgerId: string) {
  const l = await prisma.tallyLedger.findFirst({
    where: { id: bankLedgerId, tallyCompanyId: companyId, ...alive },
    select: { id: true, name: true, group: { select: { name: true } } },
  })
  if (!l) throw ApiError.notFound('No such bank ledger.')
  return l
}

export const BookkeepingBankingService = {
  /** Every ledger under Bank Accounts, with its book balance. */
  async listAccounts(session: Session, companyId: string, asOf?: string | null) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const balances = (await ledgerBalances(companyId, { to: asOf ?? null }))
      .filter((b) => b.primaryGroupName === 'Bank Accounts')
    const details = await prisma.tallyLedger.findMany({
      where: { id: { in: balances.map((b) => b.ledgerId) } },
      select: { id: true, bankAccountName: true, bankAccountNumber: true, bankIfsc: true },
    })
    const byId = new Map(details.map((d) => [d.id, d]))
    const unmatched = await prisma.tallyBankStatementLine.groupBy({
      by: ['bankLedgerId'],
      where: { tallyCompanyId: companyId, status: 'unmatched', ...alive },
      _count: { _all: true },
    })
    const unmatchedBy = new Map(unmatched.map((u) => [u.bankLedgerId, u._count._all]))
    return balances.map((b) => ({
      ledger_id: b.ledgerId,
      ledger_name: b.ledgerName,
      account_name: byId.get(b.ledgerId)?.bankAccountName ?? null,
      account_number: byId.get(b.ledgerId)?.bankAccountNumber ?? null,
      ifsc: byId.get(b.ledgerId)?.bankIfsc ?? null,
      book_balance_paise: b.closingPaise,
      unmatched_statement_lines: unmatchedBy.get(b.ledgerId) ?? 0,
    }))
  },

  /**
   * Bank book — every posted movement on a bank ledger with its
   * reconciliation state. `unreconciledPaise` is the classic bank-recon
   * reconciling item: cheques issued or deposits not yet in the statement.
   */
  async bankBook(session: Session, companyId: string, bankLedgerId: string, filter: { from?: string | null; to?: string | null } = {}) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const ledger = await bankLedgerOf(companyId, bankLedgerId)
    const [balance] = await ledgerBalances(companyId, { ...filter, ledgerIds: [bankLedgerId] })
    const entries = await prisma.tallyVoucherEntry.findMany({
      where: {
        tallyCompanyId: companyId, ledgerId: bankLedgerId,
        voucher: {
          ...ACTIVE,
          ...(filter.from || filter.to
            ? { date: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
            : {}),
        },
      },
      select: {
        id: true, entryType: true, amountPaise: true, bankDate: true, reconciledAt: true, bankStatementLineId: true,
        voucher: { select: { id: true, date: true, voucherNumber: true, voucherTypeCode: true, narration: true, partyLedger: { select: { name: true } } } },
      },
      orderBy: [{ voucher: { date: 'asc' } }],
    })
    let running = balance.openingPaise
    const rows = entries.map((e) => {
      running += e.entryType === 'dr' ? e.amountPaise : -e.amountPaise
      return {
        entry_id: e.id,
        voucher_id: e.voucher.id,
        date: e.voucher.date,
        voucher_number: e.voucher.voucherNumber,
        voucher_type_code: e.voucher.voucherTypeCode,
        particulars: e.voucher.partyLedger?.name ?? e.voucher.narration ?? '—',
        deposit_paise: e.entryType === 'dr' ? e.amountPaise : 0,
        withdrawal_paise: e.entryType === 'cr' ? e.amountPaise : 0,
        running_balance_paise: running,
        bank_date: e.bankDate,
        reconciled: Boolean(e.reconciledAt),
        statement_line_id: e.bankStatementLineId,
      }
    })
    return {
      ledger: { id: ledger.id, name: ledger.name },
      opening_paise: balance.openingPaise,
      closing_paise: balance.closingPaise,
      rows,
      reconciled_paise: rows.filter((r) => r.reconciled).reduce((s, r) => s + r.deposit_paise - r.withdrawal_paise, 0),
      unreconciled_paise: rows.filter((r) => !r.reconciled).reduce((s, r) => s + r.deposit_paise - r.withdrawal_paise, 0),
    }
  },

  /** Import statement lines. Duplicate rows (same date+ref+amount) are skipped. */
  async importStatement(session: Session, companyId: string, bankLedgerId: string, rows: {
    date: string; description: string; refNumber?: string | null; debitPaise?: number; creditPaise?: number; balancePaise?: number | null
  }[]) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    await bankLedgerOf(companyId, bankLedgerId)
    const batch = `imp-${Date.now()}`
    const existing = await prisma.tallyBankStatementLine.findMany({
      where: { tallyCompanyId: companyId, bankLedgerId, ...alive },
      select: { date: true, refNumber: true, debitPaise: true, creditPaise: true, description: true },
    })
    const seen = new Set(existing.map((e) => `${e.date}|${e.refNumber ?? ''}|${e.debitPaise}|${e.creditPaise}|${e.description}`))
    const fresh: typeof rows = []
    let duplicates = 0
    for (const r of rows) {
      const key = `${r.date}|${r.refNumber ?? ''}|${r.debitPaise ?? 0}|${r.creditPaise ?? 0}|${r.description}`
      if (seen.has(key)) { duplicates++; continue }
      seen.add(key)
      fresh.push(r)
    }
    if (fresh.length) {
      await prisma.tallyBankStatementLine.createMany({
        data: fresh.map((r) => ({
          tallyCompanyId: companyId, bankLedgerId,
          date: r.date, description: r.description, refNumber: r.refNumber ?? null,
          debitPaise: r.debitPaise ?? 0, creditPaise: r.creditPaise ?? 0,
          balancePaise: r.balancePaise ?? null, importBatch: batch,
        })),
      })
    }
    return { imported: fresh.length, duplicates_skipped: duplicates, import_batch: batch }
  },

  async listStatementLines(session: Session, companyId: string, bankLedgerId: string, filter: { status?: string; from?: string; to?: string } = {}) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const rows = await prisma.tallyBankStatementLine.findMany({
      where: {
        tallyCompanyId: companyId, bankLedgerId, ...alive,
        ...(filter.status && filter.status !== 'all' ? { status: filter.status } : {}),
        ...(filter.from || filter.to
          ? { date: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
          : {}),
      },
      include: { entry: { select: { id: true, voucherId: true, voucher: { select: { voucherNumber: true } } } } },
      orderBy: [{ date: 'asc' }],
    })
    return rows.map((r) => ({
      id: r.id, date: r.date, description: r.description, ref_number: r.refNumber,
      debit_paise: r.debitPaise, credit_paise: r.creditPaise, balance_paise: r.balancePaise,
      status: r.status, matched_entry_id: r.entry?.id ?? null,
      matched_voucher_id: r.entry?.voucherId ?? null,
      matched_voucher_number: r.entry?.voucher.voucherNumber ?? null,
    }))
  },

  /**
   * Candidate book entries for a statement line: same direction, same
   * amount, within a window of days. Suggestions only — a human confirms.
   */
  async suggestMatches(session: Session, companyId: string, statementLineId: string, windowDays = 7) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const line = await prisma.tallyBankStatementLine.findFirst({ where: { id: statementLineId, tallyCompanyId: companyId, ...alive } })
    if (!line) throw ApiError.notFound('No such statement line.')
    const wantType = line.debitPaise > 0 ? 'cr' : 'dr' // a bank debit is money leaving = credit in books
    const amount = line.debitPaise > 0 ? line.debitPaise : line.creditPaise
    const candidates = await prisma.tallyVoucherEntry.findMany({
      where: {
        tallyCompanyId: companyId, ledgerId: line.bankLedgerId, entryType: wantType,
        amountPaise: amount, bankStatementLineId: null, voucher: ACTIVE,
      },
      select: {
        id: true, amountPaise: true,
        voucher: { select: { id: true, date: true, voucherNumber: true, narration: true, partyLedger: { select: { name: true } } } },
      },
      take: 25,
    })
    return candidates
      .map((c) => ({
        entry_id: c.id,
        voucher_id: c.voucher.id,
        voucher_number: c.voucher.voucherNumber,
        date: c.voucher.date,
        party_name: c.voucher.partyLedger?.name ?? null,
        narration: c.voucher.narration,
        amount_paise: c.amountPaise,
        day_gap: Math.abs(daysBetween(c.voucher.date, line.date)),
      }))
      .filter((c) => c.day_gap <= windowDays)
      .sort((a, b) => a.day_gap - b.day_gap)
  },

  async match(session: Session, companyId: string, statementLineId: string, entryId: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    return prisma.$transaction(async (tx) => {
      const line = await tx.tallyBankStatementLine.findFirst({ where: { id: statementLineId, tallyCompanyId: companyId, ...alive } })
      if (!line) throw ApiError.notFound('No such statement line.')
      if (line.status === 'matched') throw ApiError.conflict('already_matched', 'This statement line is already matched.')
      const entry = await tx.tallyVoucherEntry.findFirst({ where: { id: entryId, tallyCompanyId: companyId, ledgerId: line.bankLedgerId } })
      if (!entry) throw ApiError.notFound('No such bank entry on this account.')
      if (entry.bankStatementLineId) throw ApiError.conflict('already_matched', 'That book entry is already reconciled.')
      const bookAmount = entry.entryType === 'dr' ? entry.amountPaise : -entry.amountPaise
      const stmtAmount = line.creditPaise - line.debitPaise
      if (bookAmount !== stmtAmount) {
        throw ApiError.unprocessable('amount_mismatch', 'The statement line and the book entry are for different amounts.')
      }
      await tx.tallyVoucherEntry.update({
        where: { id: entryId },
        data: { bankStatementLineId: statementLineId, bankDate: line.date, reconciledAt: new Date(), reconciledByUserId: session.userId },
      })
      await tx.tallyBankStatementLine.update({
        where: { id: statementLineId },
        data: { status: 'matched', matchedAt: new Date(), matchedByUserId: session.userId },
      })
      return { statement_line_id: statementLineId, entry_id: entryId, status: 'matched' }
    })
  },

  async unmatch(session: Session, companyId: string, statementLineId: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    return prisma.$transaction(async (tx) => {
      const line = await tx.tallyBankStatementLine.findFirst({ where: { id: statementLineId, tallyCompanyId: companyId, ...alive }, include: { entry: true } })
      if (!line) throw ApiError.notFound('No such statement line.')
      if (line.entry) {
        await tx.tallyVoucherEntry.update({
          where: { id: line.entry.id },
          data: { bankStatementLineId: null, reconciledAt: null, reconciledByUserId: null },
        })
      }
      await tx.tallyBankStatementLine.update({ where: { id: statementLineId }, data: { status: 'unmatched', matchedAt: null, matchedByUserId: null } })
      return { statement_line_id: statementLineId, status: 'unmatched' }
    })
  },

  /** The reconciliation statement: book balance → statement balance. */
  async reconciliation(session: Session, companyId: string, bankLedgerId: string, statementDate: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const book = await BookkeepingBankingService.bankBook(session, companyId, bankLedgerId, { to: statementDate })
    const lines = await prisma.tallyBankStatementLine.findMany({
      where: { tallyCompanyId: companyId, bankLedgerId, ...alive, date: { lte: statementDate } },
      select: { id: true, status: true, debitPaise: true, creditPaise: true, balancePaise: true, date: true, description: true },
      orderBy: { date: 'asc' },
    })
    const statementMovement = lines.reduce((s, l) => s + l.creditPaise - l.debitPaise, 0)
    const latestWithBalance = [...lines].reverse().find((l) => l.balancePaise !== null)
    const statementBalance = latestWithBalance?.balancePaise ?? statementMovement
    const unmatchedBook = book.rows.filter((r) => !r.reconciled)
    const unmatchedStatement = lines.filter((l) => l.status === 'unmatched')
    return {
      ledger: book.ledger,
      statement_date: statementDate,
      book_balance_paise: book.closing_paise,
      statement_balance_paise: statementBalance,
      difference_paise: book.closing_paise - statementBalance,
      matched_count: lines.filter((l) => l.status === 'matched').length,
      unmatched_statement_count: unmatchedStatement.length,
      unmatched_book_count: unmatchedBook.length,
      unmatched_book: unmatchedBook,
      unmatched_statement: unmatchedStatement.map((l) => ({
        id: l.id, date: l.date, description: l.description, debit_paise: l.debitPaise, credit_paise: l.creditPaise,
      })),
    }
  },

  /** Freeze a reconciliation as evidence. */
  async saveReconciliation(session: Session, companyId: string, bankLedgerId: string, statementDate: string, notes?: string | null) {
    const r = await BookkeepingBankingService.reconciliation(session, companyId, bankLedgerId, statementDate)
    const row = await prisma.tallyBankReconciliation.create({
      data: {
        tallyCompanyId: companyId, bankLedgerId, statementDate,
        bookBalancePaise: r.book_balance_paise,
        statementBalancePaise: r.statement_balance_paise,
        differencePaise: r.difference_paise,
        matchedCount: r.matched_count,
        unmatchedCount: r.unmatched_statement_count + r.unmatched_book_count,
        notes: notes ?? null,
        reconciledByUserId: session.userId,
      },
    })
    return { id: row.id, statement_date: row.statementDate, difference_paise: row.differencePaise, created_at: row.createdAt.toISOString() }
  },

  async listReconciliations(session: Session, companyId: string, bankLedgerId?: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const rows = await prisma.tallyBankReconciliation.findMany({
      where: { tallyCompanyId: companyId, ...(bankLedgerId ? { bankLedgerId } : {}) },
      include: { bankLedger: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }, take: 100,
    })
    return rows.map((r) => ({
      id: r.id, bank_ledger_id: r.bankLedgerId, bank_ledger_name: r.bankLedger.name,
      statement_date: r.statementDate, book_balance_paise: r.bookBalancePaise,
      statement_balance_paise: r.statementBalancePaise, difference_paise: r.differencePaise,
      matched_count: r.matchedCount, unmatched_count: r.unmatchedCount,
      notes: r.notes, created_at: r.createdAt.toISOString(),
    }))
  },
}
