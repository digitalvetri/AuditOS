import { afterAll, describe, expect, it } from 'vitest'
import { prisma, freshBooks, ledger, balance, taxRate, uid } from './helpers.js'
import { Contacts, Items, Chart } from '../services/masters.js'
import { Documents } from '../services/documents.js'
import { Payments } from '../services/payments.js'
import { Journals } from '../services/journals.js'
import { Banking } from '../services/banking.js'
import { FX } from '../services/fx.js'
import { Recurring, advance } from '../services/recurring.js'
import { Reports } from '../services/reports.js'
import { contextFor, listBooksForSession } from '../scope.js'
import type { Session } from '../../../platform/auth.js'

afterAll(() => prisma.$disconnect())

describe('Phase 5 · manual journals and banking', () => {
  it('draft journals are editable, unbalanced drafts cannot post, posted ones can be voided', async () => {
    const { ctx } = await freshBooks()
    const cash = await ledger(ctx, 'cash')
    const rent = await prisma.booksLedger.findFirstOrThrow({ where: { booksOrgId: ctx.booksOrgId, name: 'Rent' } })
    const draft = await Journals.saveDraft(prisma, ctx, { date: '2026-04-30', narration: 'Rent accrual', lines: [{ ledger_id: rent.id, side: 'debit', amount: 20000_00 }, { ledger_id: cash.id, side: 'credit', amount: 19000_00 }] })
    expect(draft.status).toBe('draft')
    expect(await balance(ctx, rent.id)).toBe(0n)
    await expect(Journals.postDraft(prisma, ctx, draft.id)).rejects.toMatchObject({ code: 'unbalanced_journal' })
    const fixed = await Journals.saveDraft(prisma, ctx, { date: '2026-04-30', narration: 'Rent accrual', lines: [{ ledger_id: rent.id, side: 'debit', amount: 20000_00 }, { ledger_id: cash.id, side: 'credit', amount: 20000_00 }] }, draft.id)
    expect(fixed.lines.length).toBe(2)
    const posted = await Journals.postDraft(prisma, ctx, draft.id)
    expect(posted.status).toBe('posted')
    expect(await balance(ctx, rent.id)).toBe(20000_00n)
    await expect(Journals.deleteDraft(prisma, ctx, draft.id)).rejects.toMatchObject({ code: 'journal_immutable' })
    await Journals.void(prisma, ctx, draft.id, 'wrong month')
    expect(await balance(ctx, rent.id)).toBe(0n)
    const direct = await Journals.create(prisma, ctx, { date: '2026-05-01', lines: [{ ledger_id: rent.id, side: 'debit', amount: 1_00 }, { ledger_id: cash.id, side: 'credit', amount: 1_00 }] })
    expect(direct.number).toMatch(/^JV-/)
  })

  it('bank transfer, statement lines and reconciliation', async () => {
    const { ctx } = await freshBooks()
    const groups = await Chart.groups(prisma, ctx)
    const bankGroup = groups.find((g) => g.name === 'Bank Accounts')!
    const hdfc = await Chart.createLedger(prisma, ctx, { name: 'HDFC', group_id: bankGroup.id, opening_balance: 100000_00, opening_date: '2026-04-01' })
    const cash = await ledger(ctx, 'cash')
    const t = await Banking.transfer(prisma, ctx, { date: '2026-04-05', from_ledger_id: hdfc.id, to_ledger_id: cash.id, amount: 5000_00, reference: 'ATM' })
    expect(t.number).toMatch(/^TRF-/)
    expect(await balance(ctx, hdfc.id)).toBe(95000_00n)
    expect(await balance(ctx, cash.id)).toBe(5000_00n)
    const accounts = await Banking.accounts(prisma, ctx)
    expect(accounts.find((a) => a.id === hdfc.id)?.balance).toBe(95000_00n)
    const [line] = await Banking.addStatementLines(prisma, ctx, hdfc.id, [{ date: '2026-04-05', description: 'ATM WDL', amount: -5000_00 }, { date: '2026-04-06', description: 'Unknown credit', amount: 777_00 }])
    const rec1 = await Banking.reconciliation(prisma, ctx, hdfc.id)
    expect(rec1.summary.unmatched_statement).toBe(2)
    const jl = rec1.journal_lines.find((l) => l.journal.number === t.number)!
    await expect(Banking.match(prisma, ctx, line.id, rec1.journal_lines.find((l) => l.journal.voucherType === 'opening')!.id)).rejects.toMatchObject({ code: 'amount_mismatch' })
    await Banking.match(prisma, ctx, line.id, jl.id)
    const rec2 = await Banking.reconciliation(prisma, ctx, hdfc.id)
    expect(rec2.summary.unmatched_statement).toBe(1)
    expect(rec2.summary.reconciled_balance).toBe(-5000_00n)
    await expect(Banking.deleteStatementLine(prisma, ctx, line.id)).rejects.toMatchObject({ code: 'line_matched' })
    await Banking.unmatch(prisma, ctx, line.id)
    await Banking.deleteStatementLine(prisma, ctx, line.id)
    await Banking.voidTransfer(prisma, ctx, t.id)
    expect(await balance(ctx, hdfc.id)).toBe(100000_00n)
  })
})

describe('Phase 6 · multi-currency', () => {
  it('foreign invoice stores fx and base, payment realises the difference, revaluation books the unrealised delta', async () => {
    const { ctx } = await freshBooks()
    const gst0 = await taxRate(ctx, 'GST 0%')
    const customer = await Contacts.create(prisma, ctx, { type: 'customer', display_name: 'Acme Inc', gst_treatment: 'overseas', currency: 'USD' })
    const cash = await ledger(ctx, 'cash')
    const ar = await ledger(ctx, 'accounts_receivable')
    const fx = await ledger(ctx, 'fx_gain_loss')
    await FX.setRate(prisma, ctx, { currency: 'USD', date: '2026-04-01', rate: 80 })
    const inv = await Documents.post(prisma, ctx, (await Documents.create(prisma, ctx, 'invoice', { contact_id: customer.id, date: '2026-04-01', currency: 'USD', exchange_rate: 80, lines: [{ description: 'Consulting', rate: 1000_00, tax_rate_id: gst0.id }] })).id)
    expect(inv.total).toBe(1000_00n); expect(inv.baseTotal).toBe(80000_00n); expect(inv.taxTotal).toBe(0n)
    expect(await balance(ctx, ar.id)).toBe(80000_00n)
    const bill = await prisma.booksBill.findFirstOrThrow({ where: { sourceId: inv.id } })
    expect(bill.fxBalance).toBe(1000_00n); expect(bill.balance).toBe(80000_00n)
    // Month end: USD at 82 → receivable worth 82,000; unrealised gain 2,000.
    const rev = await FX.revalue(prisma, ctx, { currency: 'USD', rate: 82, date: '2026-04-30' })
    expect(rev.revaluation.delta).toBe(2000_00n)
    expect(await balance(ctx, ar.id)).toBe(82000_00n)
    expect(await balance(ctx, fx.id)).toBe(-2000_00n)
    expect((await prisma.booksBill.findUniqueOrThrow({ where: { id: bill.id } })).balance).toBe(82000_00n)
    // Paid in full at 85: bank gets 85,000; AR clears at its 82,000 book value; realised gain 3,000.
    await Payments.create(prisma, ctx, 'received', { contact_id: customer.id, date: '2026-05-10', amount: 1000_00, currency: 'USD', exchange_rate: 85, deposit_ledger_id: cash.id, allocations: [{ document_id: inv.id, amount: 1000_00 }] })
    expect(await balance(ctx, cash.id)).toBe(85000_00n)
    expect(await balance(ctx, ar.id)).toBe(0n)
    expect(await balance(ctx, fx.id)).toBe(-5000_00n)
    expect((await Documents.get(prisma, ctx, inv.id)).status).toBe('paid')
    await expect(FX.revalue(prisma, ctx, { currency: 'USD', rate: 90, date: '2026-05-31' })).rejects.toMatchObject({ code: 'nothing_to_revalue' })
    await expect(Payments.create(prisma, ctx, 'received', { contact_id: customer.id, date: '2026-05-10', amount: 1, currency: 'USD', deposit_ledger_id: cash.id, allocations: [] })).rejects.toMatchObject({ code: 'missing_rate' })
  })
})

describe('Phase 7 · recurring and GST returns', () => {
  it('recurring profile creates the due documents and advances', async () => {
    const { ctx } = await freshBooks()
    const gst18 = await taxRate(ctx, 'GST 18%')
    const c = await Contacts.create(prisma, ctx, { type: 'customer', display_name: 'Retainer Client', gstin: '33AAACS1234A1Z5' })
    const p = await Recurring.create(prisma, ctx, { kind: 'invoice', name: 'Monthly retainer', frequency: 'monthly', start_date: '2026-04-01', auto_post: true, template: { contact_id: c.id, date: '2026-04-01', lines: [{ description: 'Monthly bookkeeping', rate: 5000_00, tax_rate_id: gst18.id }] } })
    const run = await Recurring.runDue(prisma, ctx, '2026-06-15')
    expect(run.map((r) => r.date)).toEqual(['2026-04-01', '2026-05-01', '2026-06-01'])
    expect(run.every((r) => r.posted)).toBe(true)
    expect((await prisma.booksRecurringProfile.findUniqueOrThrow({ where: { id: p.id } })).nextRunDate).toBe('2026-07-01')
    expect(await Recurring.runDue(prisma, ctx, '2026-06-15')).toEqual([])
    expect(advance('2026-01-31', 'monthly')).toBe('2026-03-03')   // JS month roll — documented, Zoho does the same
    expect(await balance(ctx, (await ledger(ctx, 'accounts_receivable')).id)).toBe(3n * 5900_00n)
  })

  it('GSTR-1 and GSTR-3B come straight from posted documents', async () => {
    const { ctx } = await freshBooks({ stateCode: '33' })
    const gst18 = await taxRate(ctx, 'GST 18%')
    const b2b = await Contacts.create(prisma, ctx, { type: 'customer', display_name: 'Registered Co', gstin: '29AAACS1234A1Z5' })   // inter-state
    const b2c = await Contacts.create(prisma, ctx, { type: 'customer', display_name: 'Walk-in', gst_treatment: 'consumer', place_of_supply_state: '33' })
    const vendor = await Contacts.create(prisma, ctx, { type: 'vendor', display_name: 'Supplier', gstin: '33AADFM9012C1Z9', pan: 'AADFM9012C' })
    const item = await Items.create(prisma, ctx, { name: 'Widget', sell_rate: 100_00, tax_rate_id: gst18.id, hsn_sac: '8471' })
    await Documents.post(prisma, ctx, (await Documents.create(prisma, ctx, 'invoice', { contact_id: b2b.id, date: '2026-04-10', lines: [{ item_id: item.id, quantity: 10, rate: 100_00 }] })).id)
    await Documents.post(prisma, ctx, (await Documents.create(prisma, ctx, 'invoice', { contact_id: b2c.id, date: '2026-04-12', lines: [{ item_id: item.id, quantity: 5, rate: 100_00 }] })).id)
    await Documents.post(prisma, ctx, (await Documents.create(prisma, ctx, 'credit_note', { contact_id: b2b.id, date: '2026-04-20', lines: [{ item_id: item.id, quantity: 2, rate: 100_00 }] })).id)
    await Documents.post(prisma, ctx, (await Documents.create(prisma, ctx, 'bill', { contact_id: vendor.id, date: '2026-04-15', lines: [{ description: 'Parts', rate: 400_00, tax_rate_id: gst18.id }] })).id)
    const draft = await Documents.create(prisma, ctx, 'invoice', { contact_id: b2b.id, date: '2026-04-25', lines: [{ item_id: item.id, quantity: 1, rate: 100_00 }] })   // never posted → excluded
    expect(draft.status).toBe('draft')
    const r1 = await Reports.gstr1(prisma, ctx, '2026-04-01', '2026-04-30')
    expect(r1.b2b.length).toBe(1); expect(r1.b2b[0].igst).toBe(180_00n); expect(r1.b2b[0].cgst).toBe(0n)
    expect(r1.b2c.length).toBe(1); expect(r1.b2c[0].cgst).toBe(45_00n); expect(r1.b2c[0].sgst).toBe(45_00n)
    expect(r1.cdnr.length).toBe(1); expect(r1.cdnr[0].igst).toBe(36_00n)
    expect(r1.hsn.find((h) => h.hsn_sac === '8471')?.quantity).toBe(15)
    const r3 = await Reports.gstr3b(prisma, ctx, '2026-04-01', '2026-04-30')
    expect(r3['3_1_outward_supplies'].taxable).toBe(1300_00n)   // 1000 + 500 − 200
    expect(r3['3_1_outward_supplies'].igst).toBe(144_00n)       // 180 − 36
    expect(r3['4_eligible_itc'].cgst).toBe(36_00n)
    expect(r3.net_payable.cgst).toBe(45_00n - 36_00n)
  })
})

describe('Phase 8 · reports — golden dataset', () => {
  it('trial balance, P&L, balance sheet, cash flow, GL and ageing agree with fixed expected values', async () => {
    const { ctx } = await freshBooks({ stateCode: '33' })
    const gst18 = await taxRate(ctx, 'GST 18%')
    const groups = await Chart.groups(prisma, ctx)
    const bank = await Chart.createLedger(prisma, ctx, { name: 'Bank', group_id: groups.find((g) => g.name === 'Bank Accounts')!.id, opening_balance: 500000_00, opening_date: '2026-04-01' })
    const customer = await Contacts.create(prisma, ctx, { type: 'customer', display_name: 'Cust', gstin: '33AAACS1234A1Z5', payment_terms_days: 15 })
    const vendor = await Contacts.create(prisma, ctx, { type: 'vendor', display_name: 'Vend', gstin: '33AADFM9012C1Z9', pan: 'AADFM9012C' })
    const rent = await prisma.booksLedger.findFirstOrThrow({ where: { booksOrgId: ctx.booksOrgId, name: 'Rent' } })
    const furniture = await prisma.booksLedger.findFirstOrThrow({ where: { booksOrgId: ctx.booksOrgId, name: 'Furniture & Equipment' } })
    // 1. Invoice ₹1,00,000 + 18% = 1,18,000 (due 2026-04-16)
    const inv = await Documents.post(prisma, ctx, (await Documents.create(prisma, ctx, 'invoice', { contact_id: customer.id, date: '2026-04-01', lines: [{ description: 'Audit fee', rate: 100000_00, tax_rate_id: gst18.id }] })).id)
    // 2. Bill: rent 50,000 + 18% = 59,000, no TDS section on the vendor → 59,000 payable
    const bill = await Documents.post(prisma, ctx, (await Documents.create(prisma, ctx, 'bill', { contact_id: vendor.id, date: '2026-04-02', lines: [{ description: 'Office rent', rate: 50000_00, tax_rate_id: gst18.id, ledger_id: rent.id }] })).id)
    // 3. Customer pays 70,000; 4. vendor paid in full; 5. furniture bought 30,000 by manual journal
    await Payments.create(prisma, ctx, 'received', { contact_id: customer.id, date: '2026-04-20', amount: 70000_00, deposit_ledger_id: bank.id, allocations: [{ document_id: inv.id, amount: 70000_00 }] })
    await Payments.create(prisma, ctx, 'made', { contact_id: vendor.id, date: '2026-04-25', amount: 59000_00, deposit_ledger_id: bank.id, allocations: [{ document_id: bill.id, amount: 59000_00 }] })
    await Journals.create(prisma, ctx, { date: '2026-04-28', narration: 'Chairs', lines: [{ ledger_id: furniture.id, side: 'debit', amount: 30000_00 }, { ledger_id: bank.id, side: 'credit', amount: 30000_00 }] })

    const tb = await Reports.trialBalance(prisma, ctx, '2026-04-30')
    expect(tb.totals.debit).toBe(tb.totals.credit)
    expect(tb.totals.closing_debit).toBe(tb.totals.closing_credit)
    const closing = (name: string) => { const r = tb.rows.find((x) => x.name === name)!; return r.closing_debit - r.closing_credit }
    expect(closing('Bank')).toBe(500000_00n + 70000_00n - 59000_00n - 30000_00n)   // 4,81,000
    expect(closing('Accounts Receivable')).toBe(48000_00n)
    expect(closing('Accounts Payable')).toBe(0n)
    expect(closing('Sales')).toBe(-100000_00n)
    expect(closing('Rent')).toBe(50000_00n)
    expect(closing('CGST Output')).toBe(-9000_00n); expect(closing('CGST Input')).toBe(4500_00n)

    const pl = await Reports.profitAndLoss(prisma, ctx, '2026-04-01', '2026-04-30')
    expect(pl.total_income).toBe(100000_00n); expect(pl.total_expense).toBe(50000_00n); expect(pl.net_profit).toBe(50000_00n)

    const bs = await Reports.balanceSheet(prisma, ctx, '2026-04-30')
    expect(bs.total_assets).toBe(481000_00n + 48000_00n + 30000_00n)              // bank + AR + furniture
    expect(bs.total_liabilities).toBe(18000_00n - 9000_00n)                         // GST output less GST input, both under Duties & Taxes (Tally convention)
    expect(bs.current_year_earnings).toBe(50000_00n)
    expect(bs.total_equity).toBe(500000_00n + 50000_00n)                             // opening balance equity + earnings
    expect(bs.difference).toBe(0n)

    const cf = await Reports.cashFlow(prisma, ctx, '2026-04-02', '2026-04-30')
    expect(cf.opening_cash).toBe(500000_00n)
    expect(cf.operating).toBe(70000_00n - 59000_00n)
    expect(cf.investing).toBe(-30000_00n)
    expect(cf.closing_cash).toBe(481000_00n)

    const gl = await Reports.generalLedger(prisma, ctx, bank.id, '2026-04-02', '2026-04-30')
    expect(gl.opening).toBe(500000_00n); expect(gl.closing).toBe(481000_00n); expect(gl.rows.length).toBe(3)

    const ar = await Reports.ageing(prisma, ctx, 'receivable', '2026-05-31')
    expect(ar.totals.total).toBe(48000_00n)
    expect(ar.totals.d31_60).toBe(48000_00n)   // due 16 Apr, 45 days overdue on 31 May
    expect((await Reports.ageing(prisma, ctx, 'payable', '2026-05-31')).totals.total).toBe(0n)
  })
})

describe('Phase 9 · multi-tenant isolation', () => {
  async function firmWithUsers() {
    const org = await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })
    const role = await prisma.role.upsert({ where: { code: 'employee' }, update: {}, create: { id: uid('role'), code: 'employee', name: 'Employee' } })
    const mk = async (email: string) => prisma.user.create({ data: { id: uid('u'), organisationId: org.id, email, passwordHash: 'x', roleId: role.id } })
    return { org, alice: await mk(`${uid('a')}@x.local`), bob: await mk(`${uid('b')}@x.local`) }
  }
  const sessionFor = (u: { id: string; email: string }, scope: 'self' | 'organisation'): Session => ({
    userId: u.id, email: u.email, roleId: 'r', roleCode: 'employee', roleName: 'Employee', employeeId: null, departmentId: null, employeeFullName: null,
    grants: [{ permission: 'books.access', scope }, { permission: 'books.reports', scope }],
  })

  it('a member sees only their books; a stranger, another firm and a no-grant user are refused', async () => {
    const f1 = await firmWithUsers()
    const f2 = await firmWithUsers()
    const a = await freshBooks({ organisationId: f1.org.id, userId: f1.alice.id, name: 'Client A books' })
    const b = await freshBooks({ organisationId: f1.org.id, userId: f1.bob.id, name: 'Client B books' })
    const other = await freshBooks({ organisationId: f2.org.id, userId: f2.alice.id, name: 'Other firm books' })
    // Alice (member of A only, self scope)
    const alice = sessionFor(f1.alice, 'self')
    expect((await listBooksForSession(alice)).map((o) => o.id)).toEqual([a.org.id])
    expect((await contextFor(alice, a.org.id)).role).toBe('admin')
    await expect(contextFor(alice, b.org.id)).rejects.toMatchObject({ status: 403 })
    await expect(contextFor(alice, other.org.id)).rejects.toMatchObject({ status: 404 })
    // Firm-wide grant sees both of its own firm's books, still never the other firm's
    const partner = sessionFor(f1.bob, 'organisation')
    expect((await listBooksForSession(partner)).map((o) => o.id).sort()).toEqual([a.org.id, b.org.id].sort())
    await expect(contextFor(partner, other.org.id)).rejects.toMatchObject({ status: 404 })
    // No grant at all
    const nobody: Session = { ...alice, grants: [] }
    await expect(listBooksForSession(nobody)).rejects.toMatchObject({ status: 403 })
    await expect(contextFor(nobody, a.org.id)).rejects.toMatchObject({ status: 403 })
  })

  it('a context for one set of books cannot read or write another set through any service', async () => {
    const a = await freshBooks()
    const b = await freshBooks()
    const gst = await taxRate(b.ctx, 'GST 18%')
    const contactB = await Contacts.create(prisma, b.ctx, { type: 'customer', display_name: 'B customer' })
    const invB = await Documents.create(prisma, b.ctx, 'invoice', { contact_id: contactB.id, date: '2026-04-01', lines: [{ description: 'x', rate: 100_00, tax_rate_id: gst.id }] })
    await expect(Documents.get(prisma, a.ctx, invB.id)).rejects.toMatchObject({ status: 404 })
    await expect(Documents.post(prisma, a.ctx, invB.id)).rejects.toMatchObject({ status: 404 })
    await expect(Contacts.get(prisma, a.ctx, contactB.id)).rejects.toMatchObject({ status: 404 })
    await expect(Documents.create(prisma, a.ctx, 'invoice', { contact_id: contactB.id, date: '2026-04-01', lines: [{ rate: 1 }] })).rejects.toMatchObject({ code: 'unknown_contact' })
    const cashB = await ledger(b.ctx, 'cash')
    const salesA = await ledger(a.ctx, 'sales')
    await expect(Journals.create(prisma, a.ctx, { date: '2026-04-01', lines: [{ ledger_id: cashB.id, side: 'debit', amount: 1 }, { ledger_id: salesA.id, side: 'credit', amount: 1 }] })).rejects.toMatchObject({ code: 'unknown_ledger' })
    expect((await Documents.list(prisma, a.ctx, 'invoice')).length).toBe(0)
    expect((await Reports.trialBalance(prisma, a.ctx, '2026-12-31')).rows.length).toBe(0)
    expect((await Journals.list(prisma, a.ctx)).length).toBe(0)
  })
})
