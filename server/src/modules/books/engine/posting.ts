import type { Prisma, PrismaClient } from '@prisma/client'
import type { BooksContext, Db } from './context.js'
import { booksAudit } from './audit.js'
import { nextNumber } from './numbering.js'
import { BooksError, UnbalancedJournalError, translateDbError } from './errors.js'
import { sum, type Minor } from './money.js'

/**
 * THE POSTING ENGINE — the one code path that changes ledger balances.
 *
 * Every invoice, bill, payment, credit, transfer, revaluation and manual
 * journal ends here. The service layer validates business rules; this layer
 * validates the accounting rules, writes the journal as a draft, writes the
 * lines, applies bill-wise allocations, and then flips the journal to posted
 * — which is where the database trigger re-checks the balance. Nothing else
 * in the codebase writes BooksJournal, BooksJournalLine, BooksBill or
 * BooksBillAllocation.
 */
export interface PostLine {
  ledgerId: string
  side: 'debit' | 'credit'
  /** Base-currency minor units. */
  amount: Minor
  fxAmount?: Minor
  fxCurrency?: string
  exchangeRate?: number
  partyLedgerId?: string | null
  taxRateId?: string | null
  description?: string | null
}

export interface NewBill {
  ledgerId: string
  contactId?: string | null
  billNo: string
  billType: 'new_ref' | 'advance' | 'on_account'
  sourceType: string
  sourceId: string
  date: string
  dueDate?: string | null
  side: 'debit' | 'credit'
  currency?: string
  fxAmount?: Minor
  amount: Minor
}

export type Allocation =
  | { type: 'new_ref' | 'advance' | 'on_account'; bill: NewBill }
  | { type: 'against_ref'; billId: string; amount: Minor; fxAmount?: Minor }
  /** Revaluation: restate an open foreign-currency item's base balance. */
  | { type: 'revalue'; billId: string; newBalance: Minor }

export interface PostInput {
  date: string
  voucherType: string
  sourceModule?: string | null
  sourceId?: string | null
  narration?: string | null
  currency?: string
  exchangeRate?: number
  number?: string
  lines: PostLine[]
  allocations?: Allocation[]
  /** Set when this journal reverses another (void). */
  reversesJournalId?: string | null
}

export type PostedJournal = Prisma.BooksJournalGetPayload<{ include: { lines: true; allocations: true } }>

export async function postJournal(db: Db, ctx: BooksContext, input: PostInput): Promise<PostedJournal> {
  // ── 1. Accounting validation, before anything touches the database ──────
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new BooksError('invalid_date', 'Date must be YYYY-MM-DD.')
  if (input.lines.length < 2) throw new BooksError('too_few_lines', 'A journal needs at least two lines.')
  for (const l of input.lines) {
    if (l.amount <= 0n) throw new BooksError('invalid_amount', 'Every line amount must be greater than zero.')
    if (l.side !== 'debit' && l.side !== 'credit') throw new BooksError('invalid_side', 'Line side must be debit or credit.')
  }
  const debit = sum(input.lines.filter((l) => l.side === 'debit').map((l) => l.amount))
  const credit = sum(input.lines.filter((l) => l.side === 'credit').map((l) => l.amount))
  if (debit !== credit) throw new UnbalancedJournalError(debit, credit)

  const ledgerIds = [...new Set(input.lines.map((l) => l.ledgerId))]
  const ledgers = await db.booksLedger.findMany({ where: { id: { in: ledgerIds }, booksOrgId: ctx.booksOrgId, deletedAt: null } })
  if (ledgers.length !== ledgerIds.length) throw new BooksError('unknown_ledger', 'A line refers to a ledger that is not in this set of books.')
  const inactive = ledgers.find((l) => !l.isActive)
  if (inactive) throw new BooksError('inactive_ledger', `Ledger "${inactive.name}" is inactive.`)

  const currency = input.currency ?? ctx.baseCurrency
  const exchangeRate = input.exchangeRate ?? 1

  try {
    // ── 2. Draft header ────────────────────────────────────────────────────
    const number = input.number ?? await nextNumber(db, ctx.booksOrgId, input.voucherType)
    const journal = await db.booksJournal.create({
      data: {
        booksOrgId: ctx.booksOrgId,
        date: input.date,
        number,
        voucherType: input.voucherType,
        sourceModule: input.sourceModule ?? null,
        sourceId: input.sourceId ?? null,
        narration: input.narration ?? null,
        status: 'draft',
        reversesJournalId: input.reversesJournalId ?? null,
        currency,
        exchangeRate,
        totalDebit: debit,
        totalCredit: credit,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    })

    // ── 3. Lines ───────────────────────────────────────────────────────────
    let lineNo = 0
    for (const l of input.lines) {
      await db.booksJournalLine.create({
        data: {
          journalId: journal.id,
          booksOrgId: ctx.booksOrgId,
          lineNo: ++lineNo,
          ledgerId: l.ledgerId,
          side: l.side,
          amount: l.amount,
          fxCurrency: l.fxCurrency ?? currency,
          fxAmount: l.fxAmount ?? l.amount,
          exchangeRate: l.exchangeRate ?? exchangeRate,
          partyLedgerId: l.partyLedgerId ?? null,
          taxRateId: l.taxRateId ?? null,
          description: l.description ?? null,
        },
      })
    }

    // ── 4. Bill-wise allocations ───────────────────────────────────────────
    for (const a of input.allocations ?? []) {
      if (a.type === 'against_ref') {
        const bill = await db.booksBill.findFirst({ where: { id: a.billId, booksOrgId: ctx.booksOrgId } })
        if (!bill) throw new BooksError('unknown_bill', 'Allocation refers to an open item that is not in this set of books.')
        if (bill.status === 'closed' || bill.balance <= 0n) throw new BooksError('bill_closed', `${bill.billNo} is already settled.`)
        if (a.amount <= 0n) throw new BooksError('invalid_allocation', 'Allocation amount must be greater than zero.')
        if (a.amount > bill.balance) {
          throw new BooksError('over_allocation', `Allocation ${a.amount} exceeds the ${bill.balance} outstanding on ${bill.billNo}.`)
        }
        const fx = a.fxAmount ?? a.amount
        const newBalance = bill.balance - a.amount
        const newFx = bill.fxBalance - fx < 0n ? 0n : bill.fxBalance - fx
        await db.booksBill.update({
          where: { id: bill.id },
          data: { balance: newBalance, fxBalance: newBalance === 0n ? 0n : newFx, status: newBalance === 0n ? 'closed' : 'open' },
        })
        await db.booksBillAllocation.create({
          data: { booksOrgId: ctx.booksOrgId, journalId: journal.id, billId: bill.id, type: 'against_ref', currency: bill.currency, fxAmount: fx, amount: a.amount },
        })
      } else if (a.type === 'revalue') {
        const bill = await db.booksBill.findFirst({ where: { id: a.billId, booksOrgId: ctx.booksOrgId } })
        if (!bill) throw new BooksError('unknown_bill', 'Revaluation refers to an open item that is not in this set of books.')
        if (bill.status !== 'open') throw new BooksError('bill_closed', `${bill.billNo} is settled; nothing to revalue.`)
        const delta = a.newBalance - bill.balance
        await db.booksBill.update({ where: { id: bill.id }, data: { balance: a.newBalance } })
        await db.booksBillAllocation.create({ data: { booksOrgId: ctx.booksOrgId, journalId: journal.id, billId: bill.id, type: 'revalue', currency: bill.currency, fxAmount: 0n, amount: delta } })
      } else {
        const b = a.bill
        if (b.amount <= 0n) throw new BooksError('invalid_allocation', 'A new open item must have a positive amount.')
        const bill = await db.booksBill.create({
          data: {
            booksOrgId: ctx.booksOrgId,
            ledgerId: b.ledgerId,
            contactId: b.contactId ?? null,
            billNo: b.billNo,
            billType: a.type,
            sourceType: b.sourceType,
            sourceId: b.sourceId,
            date: b.date,
            dueDate: b.dueDate ?? null,
            side: b.side,
            currency: b.currency ?? currency,
            fxAmount: b.fxAmount ?? b.amount,
            amount: b.amount,
            fxBalance: b.fxAmount ?? b.amount,
            balance: b.amount,
            status: 'open',
          },
        })
        await db.booksBillAllocation.create({
          data: { booksOrgId: ctx.booksOrgId, journalId: journal.id, billId: bill.id, type: a.type, currency: bill.currency, fxAmount: bill.fxAmount, amount: bill.amount },
        })
      }
    }

    // ── 5. Post — the trigger re-checks the balance here ───────────────────
    const posted = await db.booksJournal.update({
      where: { id: journal.id },
      data: { status: 'posted', postedAt: new Date(), postedBy: ctx.userId },
      include: { lines: { orderBy: { lineNo: 'asc' } }, allocations: true },
    }).catch((err: unknown) => { throw invariantRefused(err) })
    await booksAudit(db, ctx, { entityType: 'journal', entityId: posted.id, action: 'journal.posted', after: summarise(posted) })
    return posted
  } catch (err) {
    throw translateDbError(err)
  }
}

/**
 * Void a posted journal: a dated reversing journal is posted (every line
 * with its side flipped, every allocation undone) and the original is
 * marked void with a pointer to its reversal. Nothing is deleted.
 */
export async function voidJournal(db: Db, ctx: BooksContext, journalId: string, opts: { date?: string; reason?: string | null } = {}): Promise<{ original: PostedJournal; reversal: PostedJournal }> {
  const original = await db.booksJournal.findFirst({
    where: { id: journalId, booksOrgId: ctx.booksOrgId },
    include: { lines: { orderBy: { lineNo: 'asc' } }, allocations: { include: { bill: true } } },
  })
  if (!original) throw new BooksError('unknown_journal', 'Journal not found in this set of books.')
  if (original.status !== 'posted') throw new BooksError('not_posted', 'Only a posted journal can be voided.')

  // An open item this journal created must not have been settled by others.
  for (const a of original.allocations) {
    if (a.type !== 'against_ref' && a.type !== 'revalue') {
      const settledByOthers = await db.booksBillAllocation.count({ where: { billId: a.billId, journalId: { not: original.id }, type: { not: 'revalue' } } })
      if (settledByOthers > 0) {
        throw new BooksError('bill_has_allocations', `${a.bill.billNo} has payments or credits applied. Void those first.`)
      }
    }
  }

  try {
    const number = await nextNumber(db, ctx.booksOrgId, 'void')
    const reversal = await db.booksJournal.create({
      data: {
        booksOrgId: ctx.booksOrgId,
        date: opts.date ?? original.date,
        number,
        voucherType: original.voucherType,
        sourceModule: original.sourceModule,
        sourceId: original.sourceId,
        narration: `Reversal of ${original.number}${opts.reason ? ` — ${opts.reason}` : ''}`,
        status: 'draft',
        reversesJournalId: original.id,
        currency: original.currency,
        exchangeRate: original.exchangeRate,
        totalDebit: original.totalCredit,
        totalCredit: original.totalDebit,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    })
    for (const l of original.lines) {
      await db.booksJournalLine.create({
        data: {
          journalId: reversal.id, booksOrgId: ctx.booksOrgId, lineNo: l.lineNo, ledgerId: l.ledgerId,
          side: l.side === 'debit' ? 'credit' : 'debit', amount: l.amount, fxCurrency: l.fxCurrency, fxAmount: l.fxAmount,
          exchangeRate: l.exchangeRate, partyLedgerId: l.partyLedgerId, taxRateId: l.taxRateId, description: l.description,
        },
      })
    }
    for (const a of original.allocations) {
      if (a.type === 'revalue') {
        await db.booksBill.update({ where: { id: a.billId }, data: { balance: { decrement: a.amount } } })
        await db.booksBillAllocation.create({ data: { booksOrgId: ctx.booksOrgId, journalId: reversal.id, billId: a.billId, type: 'revalue', currency: a.currency, fxAmount: 0n, amount: -a.amount } })
      } else if (a.type === 'against_ref') {
        // Give the settled amount back to the open item.
        await db.booksBill.update({
          where: { id: a.billId },
          data: { balance: { increment: a.amount }, fxBalance: { increment: a.fxAmount }, status: 'open' },
        })
        await db.booksBillAllocation.create({ data: { booksOrgId: ctx.booksOrgId, journalId: reversal.id, billId: a.billId, type: 'against_ref', currency: a.currency, fxAmount: -a.fxAmount, amount: -a.amount } })
      } else {
        // The open item this journal created disappears.
        await db.booksBill.update({ where: { id: a.billId }, data: { balance: 0n, fxBalance: 0n, status: 'closed' } })
        await db.booksBillAllocation.create({ data: { booksOrgId: ctx.booksOrgId, journalId: reversal.id, billId: a.billId, type: a.type, currency: a.currency, fxAmount: -a.fxAmount, amount: -a.amount } })
      }
    }
    const postedReversal = await db.booksJournal.update({
      where: { id: reversal.id },
      data: { status: 'posted', postedAt: new Date(), postedBy: ctx.userId },
      include: { lines: { orderBy: { lineNo: 'asc' } }, allocations: true },
    }).catch((err: unknown) => { throw invariantRefused(err) })
    const voided = await db.booksJournal.update({
      where: { id: original.id },
      data: { status: 'void', voidedByJournalId: reversal.id, updatedBy: ctx.userId },
      include: { lines: { orderBy: { lineNo: 'asc' } }, allocations: true },
    })
    await booksAudit(db, ctx, { entityType: 'journal', entityId: original.id, action: 'journal.voided', before: summarise(original), after: { reversal_id: reversal.id, reason: opts.reason ?? null } })
    return { original: voided, reversal: postedReversal }
  } catch (err) {
    throw translateDbError(err)
  }
}

/** Run `fn` inside a transaction (or reuse the caller's). Every service uses this. */
export async function withBooksTx<T>(prisma: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(fn, { maxWait: 10_000, timeout: 60_000 })
  } catch (err) {
    throw translateDbError(err)
  }
}

/**
 * The database trigger refused the post. On PostgreSQL the trigger's text
 * reaches us; SQLite through Prisma reports every RAISE(ABORT) as a generic
 * constraint failure, so the message is spelled out here.
 */
function invariantRefused(err: unknown): unknown {
  const translated = translateDbError(err)
  if (translated instanceof BooksError) return translated
  return new BooksError('journal_invariant', 'The database refused to post this journal: it is unbalanced or breaks a ledger invariant.')
}

function summarise(j: PostedJournal) {
  return {
    number: j.number, date: j.date, voucher_type: j.voucherType, status: j.status, source: j.sourceModule ? `${j.sourceModule}:${j.sourceId}` : null,
    total: j.totalDebit.toString(),
    lines: j.lines.map((l) => ({ ledger_id: l.ledgerId, side: l.side, amount: l.amount.toString() })),
  }
}

/**
 * DRAFT MANUAL JOURNALS — saved without touching balances (status draft),
 * editable until posted. Posting goes through the same validation as
 * postJournal, and the same database trigger.
 */
export async function saveDraftJournal(db: Db, ctx: BooksContext, input: PostInput & { id?: string }): Promise<PostedJournal> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new BooksError('invalid_date', 'Date must be YYYY-MM-DD.')
  if (input.lines.length === 0) throw new BooksError('too_few_lines', 'Add at least one line.')
  for (const l of input.lines) if (l.amount <= 0n) throw new BooksError('invalid_amount', 'Every line amount must be greater than zero.')
  const ledgerIds = [...new Set(input.lines.map((l) => l.ledgerId))]
  const ledgers = await db.booksLedger.findMany({ where: { id: { in: ledgerIds }, booksOrgId: ctx.booksOrgId, deletedAt: null } })
  if (ledgers.length !== ledgerIds.length) throw new BooksError('unknown_ledger', 'A line refers to a ledger that is not in this set of books.')
  const debit = sum(input.lines.filter((l) => l.side === 'debit').map((l) => l.amount))
  const credit = sum(input.lines.filter((l) => l.side === 'credit').map((l) => l.amount))
  try {
    let id = input.id
    if (id) {
      const existing = await db.booksJournal.findFirst({ where: { id, booksOrgId: ctx.booksOrgId } })
      if (!existing) throw new BooksError('unknown_journal', 'Journal not found.')
      if (existing.status !== 'draft') throw new BooksError('journal_immutable', 'Only a draft journal can be edited.')
      await db.booksJournalLine.deleteMany({ where: { journalId: id } })
      await db.booksJournal.update({ where: { id }, data: { date: input.date, narration: input.narration ?? null, totalDebit: debit, totalCredit: credit, updatedBy: ctx.userId } })
    } else {
      const number = input.number ?? await nextNumber(db, ctx.booksOrgId, input.voucherType)
      id = (await db.booksJournal.create({ data: { booksOrgId: ctx.booksOrgId, date: input.date, number, voucherType: input.voucherType, narration: input.narration ?? null, status: 'draft', currency: input.currency ?? ctx.baseCurrency, exchangeRate: input.exchangeRate ?? 1, totalDebit: debit, totalCredit: credit, createdBy: ctx.userId, updatedBy: ctx.userId } })).id
    }
    let n = 0
    for (const l of input.lines) {
      await db.booksJournalLine.create({ data: { journalId: id, booksOrgId: ctx.booksOrgId, lineNo: ++n, ledgerId: l.ledgerId, side: l.side, amount: l.amount, fxCurrency: l.fxCurrency ?? ctx.baseCurrency, fxAmount: l.fxAmount ?? l.amount, exchangeRate: l.exchangeRate ?? 1, partyLedgerId: l.partyLedgerId ?? null, description: l.description ?? null } })
    }
    const saved = await db.booksJournal.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } }, allocations: true } })
    await booksAudit(db, ctx, { entityType: 'journal', entityId: id, action: input.id ? 'journal.draft_updated' : 'journal.draft_created', after: summarise(saved) })
    return saved
  } catch (err) {
    throw translateDbError(err)
  }
}

export async function postDraftJournal(db: Db, ctx: BooksContext, id: string): Promise<PostedJournal> {
  const j = await db.booksJournal.findFirst({ where: { id, booksOrgId: ctx.booksOrgId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  if (!j) throw new BooksError('unknown_journal', 'Journal not found.')
  if (j.status !== 'draft') throw new BooksError('already_posted', `This journal is ${j.status}.`)
  if (j.lines.length < 2) throw new BooksError('too_few_lines', 'A journal needs at least two lines.')
  const debit = sum(j.lines.filter((l) => l.side === 'debit').map((l) => l.amount))
  const credit = sum(j.lines.filter((l) => l.side === 'credit').map((l) => l.amount))
  if (debit !== credit) throw new UnbalancedJournalError(debit, credit)
  try {
    const posted = await db.booksJournal.update({ where: { id }, data: { status: 'posted', postedAt: new Date(), postedBy: ctx.userId, totalDebit: debit, totalCredit: credit }, include: { lines: { orderBy: { lineNo: 'asc' } }, allocations: true } })
      .catch((err: unknown) => { throw invariantRefused(err) })
    await booksAudit(db, ctx, { entityType: 'journal', entityId: id, action: 'journal.posted', after: summarise(posted) })
    return posted
  } catch (err) {
    throw translateDbError(err)
  }
}

export async function deleteDraftJournal(db: Db, ctx: BooksContext, id: string): Promise<void> {
  const j = await db.booksJournal.findFirst({ where: { id, booksOrgId: ctx.booksOrgId } })
  if (!j) throw new BooksError('unknown_journal', 'Journal not found.')
  if (j.status !== 'draft') throw new BooksError('journal_immutable', 'Only a draft journal can be deleted; void a posted one.')
  await db.booksJournalLine.deleteMany({ where: { journalId: id } })
  await db.booksJournal.delete({ where: { id } })
  await booksAudit(db, ctx, { entityType: 'journal', entityId: id, action: 'journal.draft_deleted', before: { number: j.number } })
}
