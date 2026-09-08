import { afterAll, describe, expect, it } from 'vitest'
import { prisma, freshBooks, ledger, ledgerByName, balance, paise } from './helpers.js'
import { postJournal, voidJournal, withBooksTx } from '../engine/posting.js'
import { postOpeningBalance } from '../engine/organisation.js'
import { DEFAULT_GROUPS, DEFAULT_LEDGERS } from '../engine/chart.js'
import { applyBp, exclusiveOf, roundToRupee, divRound } from '../engine/money.js'

afterAll(() => prisma.$disconnect())

describe('Phase 1 · organisation and chart of accounts', () => {
  it('seeds the default chart with root categories and Tally groups', async () => {
    const { ctx } = await freshBooks()
    const groups = await prisma.booksAccountGroup.findMany({ where: { booksOrgId: ctx.booksOrgId } })
    const ledgers = await prisma.booksLedger.findMany({ where: { booksOrgId: ctx.booksOrgId } })
    expect(groups.length).toBe(DEFAULT_GROUPS.length)
    expect(ledgers.length).toBe(DEFAULT_LEDGERS.length)
    for (const l of ledgers) {
      expect(['asset', 'liability', 'equity', 'income', 'expense']).toContain(l.rootCategory)
      expect(l.tallyGroup.length).toBeGreaterThan(0)
    }
    expect((await ledger(ctx, 'accounts_receivable')).billWise).toBe(true)
    expect((await ledger(ctx, 'round_off')).tallyGroup).toBe('Indirect Expenses')
    const taxes = await prisma.booksTaxRate.count({ where: { booksOrgId: ctx.booksOrgId } })
    expect(taxes).toBeGreaterThanOrEqual(5)
  })

  it('records an audit event for creation and the trail is append-only', async () => {
    const { ctx } = await freshBooks()
    const ev = await prisma.booksAuditEvent.findFirst({ where: { booksOrgId: ctx.booksOrgId, action: 'organisation.created' } })
    expect(ev).not.toBeNull()
    // SQLite via Prisma reports a trigger RAISE as a generic constraint error,
    // so these assert the refusal and the unchanged row, not the message.
    await expect(prisma.booksAuditEvent.update({ where: { id: ev!.id }, data: { action: 'tampered' } })).rejects.toThrow()
    await expect(prisma.booksAuditEvent.delete({ where: { id: ev!.id } })).rejects.toThrow()
    expect((await prisma.booksAuditEvent.findUniqueOrThrow({ where: { id: ev!.id } })).action).toBe('organisation.created')
  })
})

describe('Phase 1 · the balance invariant', () => {
  it('posts a balanced journal and updates balances', async () => {
    const { ctx } = await freshBooks()
    const cash = await ledger(ctx, 'cash')
    const capital = await ledger(ctx, 'owner_capital')
    const j = await postJournal(prisma, ctx, {
      date: '2026-04-01', voucherType: 'journal', narration: 'Capital introduced',
      lines: [{ ledgerId: cash.id, side: 'debit', amount: paise(100000) }, { ledgerId: capital.id, side: 'credit', amount: paise(100000) }],
    })
    expect(j.status).toBe('posted')
    expect(j.number).toMatch(/^JV-\d{5}$/)
    expect(await balance(ctx, cash.id)).toBe(paise(100000))
    expect(await balance(ctx, capital.id)).toBe(-paise(100000))
  })

  it('rejects an unbalanced journal at the service layer', async () => {
    const { ctx } = await freshBooks()
    const cash = await ledger(ctx, 'cash')
    const sales = await ledger(ctx, 'sales')
    await expect(postJournal(prisma, ctx, {
      date: '2026-04-01', voucherType: 'journal',
      lines: [{ ledgerId: cash.id, side: 'debit', amount: paise(100) }, { ledgerId: sales.id, side: 'credit', amount: paise(90) }],
    })).rejects.toMatchObject({ code: 'unbalanced_journal' })
    expect(await prisma.booksJournal.count({ where: { booksOrgId: ctx.booksOrgId, voucherType: 'journal' } })).toBe(0)
  })

  it('rejects an unbalanced journal at the DATABASE even when the service check is bypassed', async () => {
    const { ctx } = await freshBooks()
    const cash = await ledger(ctx, 'cash')
    const sales = await ledger(ctx, 'sales')
    await expect(prisma.$transaction(async (tx) => {
      const j = await tx.booksJournal.create({ data: { booksOrgId: ctx.booksOrgId, date: '2026-04-01', number: 'HACK-1', voucherType: 'journal', status: 'draft' } })
      await tx.booksJournalLine.create({ data: { journalId: j.id, booksOrgId: ctx.booksOrgId, lineNo: 1, ledgerId: cash.id, side: 'debit', amount: 1000n, fxAmount: 1000n } })
      await tx.booksJournalLine.create({ data: { journalId: j.id, booksOrgId: ctx.booksOrgId, lineNo: 2, ledgerId: sales.id, side: 'credit', amount: 999n, fxAmount: 999n } })
      await tx.booksJournal.update({ where: { id: j.id }, data: { status: 'posted' } })
    })).rejects.toThrow()
    expect(await prisma.booksJournal.count({ where: { number: 'HACK-1' } })).toBe(0)
  })

  it('refuses to insert a journal directly as posted', async () => {
    const { ctx } = await freshBooks()
    await expect(prisma.booksJournal.create({ data: { booksOrgId: ctx.booksOrgId, date: '2026-04-01', number: 'HACK-2', voucherType: 'journal', status: 'posted' } }))
      .rejects.toThrow()
    expect(await prisma.booksJournal.count({ where: { number: 'HACK-2' } })).toBe(0)
  })

  it('refuses a journal with fewer than two lines', async () => {
    const { ctx } = await freshBooks()
    const cash = await ledger(ctx, 'cash')
    await expect(postJournal(prisma, ctx, { date: '2026-04-01', voucherType: 'journal', lines: [{ ledgerId: cash.id, side: 'debit', amount: 100n }] }))
      .rejects.toMatchObject({ code: 'too_few_lines' })
  })

  it('refuses zero and negative amounts', async () => {
    const { ctx } = await freshBooks()
    const cash = await ledger(ctx, 'cash')
    const sales = await ledger(ctx, 'sales')
    await expect(postJournal(prisma, ctx, { date: '2026-04-01', voucherType: 'journal', lines: [{ ledgerId: cash.id, side: 'debit', amount: 0n }, { ledgerId: sales.id, side: 'credit', amount: 0n }] }))
      .rejects.toMatchObject({ code: 'invalid_amount' })
    await expect(prisma.$transaction(async (tx) => {
      const j = await tx.booksJournal.create({ data: { booksOrgId: ctx.booksOrgId, date: '2026-04-01', number: 'HACK-3', voucherType: 'journal', status: 'draft' } })
      await tx.booksJournalLine.create({ data: { journalId: j.id, booksOrgId: ctx.booksOrgId, lineNo: 1, ledgerId: cash.id, side: 'debit', amount: -5n, fxAmount: -5n } })
    })).rejects.toThrow()
  })

  it('refuses a ledger from another set of books', async () => {
    const a = await freshBooks()
    const b = await freshBooks()
    const cashA = await ledger(a.ctx, 'cash')
    const salesB = await ledger(b.ctx, 'sales')
    await expect(postJournal(prisma, a.ctx, { date: '2026-04-01', voucherType: 'journal', lines: [{ ledgerId: cashA.id, side: 'debit', amount: 100n }, { ledgerId: salesB.id, side: 'credit', amount: 100n }] }))
      .rejects.toMatchObject({ code: 'unknown_ledger' })
  })
})

describe('Phase 1 · immutability and void', () => {
  it('cannot edit or delete a posted journal or its lines', async () => {
    const { ctx } = await freshBooks()
    const cash = await ledger(ctx, 'cash')
    const sales = await ledger(ctx, 'sales')
    const j = await postJournal(prisma, ctx, { date: '2026-04-01', voucherType: 'journal', lines: [{ ledgerId: cash.id, side: 'debit', amount: 500n }, { ledgerId: sales.id, side: 'credit', amount: 500n }] })
    await expect(prisma.booksJournal.update({ where: { id: j.id }, data: { date: '2026-05-01' } })).rejects.toThrow()
    await expect(prisma.booksJournalLine.update({ where: { id: j.lines[0].id }, data: { amount: 1n } })).rejects.toThrow()
    await expect(prisma.booksJournalLine.delete({ where: { id: j.lines[0].id } })).rejects.toThrow()
    await expect(prisma.booksJournal.delete({ where: { id: j.id } })).rejects.toThrow()
    await expect(prisma.booksJournalLine.create({ data: { journalId: j.id, booksOrgId: ctx.booksOrgId, lineNo: 3, ledgerId: cash.id, side: 'debit', amount: 1n, fxAmount: 1n } })).rejects.toThrow()
    await expect(prisma.booksJournal.update({ where: { id: j.id }, data: { status: 'draft' } })).rejects.toThrow()
    const after = await prisma.booksJournal.findUniqueOrThrow({ where: { id: j.id }, include: { lines: true } })
    expect(after.date).toBe('2026-04-01')
    expect(after.status).toBe('posted')
    expect(after.lines.length).toBe(2)
    expect(after.lines[0].amount).toBe(500n)
    // Reconciliation columns stay writable on a posted line.
    await prisma.booksJournalLine.update({ where: { id: j.lines[0].id }, data: { reconciledAt: new Date() } })
  })

  it('void posts a reversing journal and preserves the original', async () => {
    const { ctx } = await freshBooks()
    const cash = await ledger(ctx, 'cash')
    const sales = await ledger(ctx, 'sales')
    const j = await postJournal(prisma, ctx, { date: '2026-04-01', voucherType: 'journal', lines: [{ ledgerId: cash.id, side: 'debit', amount: 500n }, { ledgerId: sales.id, side: 'credit', amount: 500n }] })
    const { original, reversal } = await withBooksTx(prisma, (tx) => voidJournal(tx, ctx, j.id, { reason: 'test' }))
    expect(original.status).toBe('void')
    expect(original.voidedByJournalId).toBe(reversal.id)
    expect(reversal.reversesJournalId).toBe(j.id)
    expect(reversal.lines.map((l) => l.side)).toEqual(['credit', 'debit'])
    expect(await balance(ctx, cash.id)).toBe(0n)
    expect(await prisma.booksJournal.count({ where: { id: j.id } })).toBe(1)
    await expect(withBooksTx(prisma, (tx) => voidJournal(tx, ctx, j.id))).rejects.toMatchObject({ code: 'not_posted' })
    const trail = await prisma.booksAuditEvent.findMany({ where: { entityType: 'journal', entityId: j.id }, orderBy: { createdAt: 'asc' } })
    expect(trail.map((e) => e.action)).toEqual(['journal.posted', 'journal.voided'])
  })
})

describe('Phase 1 · bill-wise tracking', () => {
  it('creates an open item, settles it partially then fully, and blocks over-allocation', async () => {
    const { ctx } = await freshBooks()
    const ar = await ledger(ctx, 'accounts_receivable')
    const sales = await ledger(ctx, 'sales')
    const cash = await ledger(ctx, 'cash')
    const inv = await postJournal(prisma, ctx, {
      date: '2026-04-01', voucherType: 'invoice', sourceModule: 'test', sourceId: 'inv-1',
      lines: [{ ledgerId: ar.id, side: 'debit', amount: paise(1000) }, { ledgerId: sales.id, side: 'credit', amount: paise(1000) }],
      allocations: [{ type: 'new_ref', bill: { ledgerId: ar.id, billNo: 'INV-1', billType: 'new_ref', sourceType: 'test', sourceId: 'inv-1', date: '2026-04-01', dueDate: '2026-05-01', side: 'debit', amount: paise(1000) } }],
    })
    const bill = await prisma.booksBill.findFirstOrThrow({ where: { sourceId: 'inv-1' } })
    expect(bill.balance).toBe(paise(1000))
    await postJournal(prisma, ctx, {
      date: '2026-04-10', voucherType: 'payment_in',
      lines: [{ ledgerId: cash.id, side: 'debit', amount: paise(400) }, { ledgerId: ar.id, side: 'credit', amount: paise(400) }],
      allocations: [{ type: 'against_ref', billId: bill.id, amount: paise(400) }],
    })
    expect((await prisma.booksBill.findUniqueOrThrow({ where: { id: bill.id } })).balance).toBe(paise(600))
    await expect(postJournal(prisma, ctx, {
      date: '2026-04-11', voucherType: 'payment_in',
      lines: [{ ledgerId: cash.id, side: 'debit', amount: paise(700) }, { ledgerId: ar.id, side: 'credit', amount: paise(700) }],
      allocations: [{ type: 'against_ref', billId: bill.id, amount: paise(700) }],
    })).rejects.toMatchObject({ code: 'over_allocation' })
    await postJournal(prisma, ctx, {
      date: '2026-04-12', voucherType: 'payment_in',
      lines: [{ ledgerId: cash.id, side: 'debit', amount: paise(600) }, { ledgerId: ar.id, side: 'credit', amount: paise(600) }],
      allocations: [{ type: 'against_ref', billId: bill.id, amount: paise(600) }],
    })
    const settled = await prisma.booksBill.findUniqueOrThrow({ where: { id: bill.id } })
    expect(settled.balance).toBe(0n)
    expect(settled.status).toBe('closed')
    // The invoice can no longer be voided while payments stand against it.
    await expect(withBooksTx(prisma, (tx) => voidJournal(tx, ctx, inv.id))).rejects.toMatchObject({ code: 'bill_has_allocations' })
  })

  it('voiding a payment gives the amount back to the open item', async () => {
    const { ctx } = await freshBooks()
    const ap = await ledger(ctx, 'accounts_payable')
    const exp = await ledger(ctx, 'general_expense')
    const cash = await ledger(ctx, 'cash')
    await postJournal(prisma, ctx, {
      date: '2026-04-01', voucherType: 'bill', lines: [{ ledgerId: exp.id, side: 'debit', amount: paise(500) }, { ledgerId: ap.id, side: 'credit', amount: paise(500) }],
      allocations: [{ type: 'new_ref', bill: { ledgerId: ap.id, billNo: 'B-1', billType: 'new_ref', sourceType: 'test', sourceId: 'b-1', date: '2026-04-01', side: 'credit', amount: paise(500) } }],
    })
    const bill = await prisma.booksBill.findFirstOrThrow({ where: { sourceId: 'b-1' } })
    const pay = await postJournal(prisma, ctx, {
      date: '2026-04-05', voucherType: 'payment_out', lines: [{ ledgerId: ap.id, side: 'debit', amount: paise(500) }, { ledgerId: cash.id, side: 'credit', amount: paise(500) }],
      allocations: [{ type: 'against_ref', billId: bill.id, amount: paise(500) }],
    })
    expect((await prisma.booksBill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe('closed')
    await withBooksTx(prisma, (tx) => voidJournal(tx, ctx, pay.id))
    const reopened = await prisma.booksBill.findUniqueOrThrow({ where: { id: bill.id } })
    expect(reopened.balance).toBe(paise(500))
    expect(reopened.status).toBe('open')
  })

  it('opening balances post through the engine against Opening Balance Equity', async () => {
    const { ctx } = await freshBooks()
    const cash = await ledger(ctx, 'cash')
    const obe = await ledger(ctx, 'opening_balance_equity')
    await withBooksTx(prisma, (tx) => postOpeningBalance(tx, ctx, cash.id, paise(25000), 'debit', '2026-04-01'))
    expect(await balance(ctx, cash.id)).toBe(paise(25000))
    expect(await balance(ctx, obe.id)).toBe(-paise(25000))
    const ob = await prisma.booksJournal.findFirst({ where: { booksOrgId: ctx.booksOrgId, voucherType: 'opening' } })
    expect(ob?.number).toMatch(/^OB-/)
  })
})

describe('Phase 1 · money arithmetic', () => {
  it('rounds half-up and handles inclusive tax and rupee rounding', () => {
    expect(applyBp(100000n, 1800)).toBe(18000n)          // 18% of ₹1,000
    expect(applyBp(33333n, 1800)).toBe(6000n)            // 5999.94 → 6000
    expect(exclusiveOf(118000n, 1800)).toBe(100000n)     // ₹1,180 incl 18% → ₹1,000
    expect(roundToRupee(123450n)).toEqual([123500n, 50n])
    expect(roundToRupee(123449n)).toEqual([123400n, -49n])
    expect(divRound(5n, 2n)).toBe(3n)
    expect(divRound(-5n, 2n)).toBe(-3n)
  })
  it('a ledger named by the round-off key exists in every set of books', async () => {
    const { ctx } = await freshBooks()
    expect((await ledgerByName(ctx, 'Round Off')).systemKey).toBe('round_off')
  })
})
