import { afterAll, describe, expect, it } from 'vitest'
import { prisma, freshBooks, ledger, balance, paise, taxRate } from './helpers.js'
import { Contacts, Items, Chart } from '../services/masters.js'
import { Documents } from '../services/documents.js'
import { Payments } from '../services/payments.js'
import { computeDocument, distribute } from '../services/compute.js'

afterAll(() => prisma.$disconnect())

async function setup(opts: { orgState?: string; customerState?: string; vendorPan?: boolean } = {}) {
  const b = await freshBooks({ stateCode: opts.orgState ?? '33' })
  const gst18 = await taxRate(b.ctx, 'GST 18%')
  const customer = await Contacts.create(prisma, b.ctx, { type: 'customer', display_name: 'Sharma Traders', gstin: `${opts.customerState ?? '33'}AAACS1234A1Z5`, place_of_supply_state: opts.customerState ?? '33', payment_terms_days: 30 })
  const vendor = await Contacts.create(prisma, b.ctx, { type: 'vendor', display_name: 'Murugan & Co', gstin: '33AADFM9012C1Z9', pan: opts.vendorPan === false ? null : 'AADFM9012C', tds_section: '194J' })
  const item = await Items.create(prisma, b.ctx, { name: 'Audit fee', sell_rate: 1000_00, purchase_rate: 800_00, tax_rate_id: gst18.id, hsn_sac: '998221' })
  return { ...b, gst18, customer, vendor, item }
}

describe('Phase 2 · master data', () => {
  it('creates contacts, items, tax rates and ledgers with validation', async () => {
    const { ctx } = await freshBooks()
    await expect(Contacts.create(prisma, ctx, { type: 'customer', display_name: 'Bad GSTIN', gstin: '123' })).rejects.toMatchObject({ code: 'invalid_gstin' })
    const c = await Contacts.create(prisma, ctx, { type: 'both', display_name: 'Nila Foods', gstin: '29AAFCN7890E1Z7', addresses: [{ kind: 'billing', line1: '1 MG Road', state_code: '29' }], persons: [{ name: 'Nila', is_primary: true }] })
    expect(c.placeOfSupplyState).toBe('29')
    expect(c.addresses[0].stateName).toBe('Karnataka')
    const gst = await taxRate(ctx, 'GST 18%')
    await expect(Items.create(prisma, ctx, { name: 'X', tax_rate_id: (await taxRate(ctx, 'TDS 194J Professional Fees 10%')).id })).rejects.toMatchObject({ code: 'wrong_tax_type' })
    const i = await Items.create(prisma, ctx, { name: 'Consulting', sell_rate: '250000', tax_rate_id: gst.id })
    expect(i.sellRate).toBe(250000n)
    const groups = await Chart.groups(prisma, ctx)
    const bank = groups.find((g) => g.name === 'Bank Accounts')!
    const l = await Chart.createLedger(prisma, ctx, { name: 'HDFC Current A/c', group_id: bank.id, opening_balance: 500000_00, opening_balance_type: 'debit', opening_date: '2026-04-01', bank_account_no: '1234' })
    expect(l.isBank).toBe(true)
    expect(await balance(ctx, l.id)).toBe(paise(500000))
    await expect(Chart.deleteLedger(prisma, ctx, l.id)).rejects.toMatchObject({ code: 'ledger_has_postings' })
    const ar = await ledger(ctx, 'accounts_receivable')
    await expect(Chart.deleteLedger(prisma, ctx, ar.id)).rejects.toMatchObject({ code: 'system_ledger' })
    const events = await prisma.booksAuditEvent.findMany({ where: { booksOrgId: ctx.booksOrgId } })
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(['contact.created', 'item.created', 'ledger.created', 'journal.posted']))
  })
})

describe('Phase 3 · document arithmetic', () => {
  it('splits GST intra vs inter state, handles inclusive tax, discounts and round-off', () => {
    const intra = computeDocument({ lines: [{ quantity: 2, rate: 1000_00n, taxPercentBp: 1800 }], taxInclusive: false, interState: false, roundOff: true })
    expect(intra.taxableTotal).toBe(2000_00n); expect(intra.cgstTotal).toBe(180_00n); expect(intra.sgstTotal).toBe(180_00n); expect(intra.igstTotal).toBe(0n); expect(intra.total).toBe(2360_00n)
    const inter = computeDocument({ lines: [{ quantity: 2, rate: 1000_00n, taxPercentBp: 1800 }], taxInclusive: false, interState: true, roundOff: true })
    expect(inter.igstTotal).toBe(360_00n); expect(inter.cgstTotal).toBe(0n)
    const incl = computeDocument({ lines: [{ quantity: 1, rate: 1180_00n, taxPercentBp: 1800 }], taxInclusive: true, interState: false, roundOff: true })
    expect(incl.taxableTotal).toBe(1000_00n); expect(incl.taxTotal).toBe(180_00n); expect(incl.total).toBe(1180_00n)
    const disc = computeDocument({ lines: [{ quantity: 1, rate: 1000_00n, discountPercentBp: 1000, taxPercentBp: 1800 }, { quantity: 1, rate: 500_00n, taxPercentBp: 500 }], taxInclusive: false, interState: false, discountPercentBp: 500, roundOff: true })
    // line1 900 → doc 5% (of 1400) = 70 split 900:500 → 45 / 25 → taxable 855 + 475 = 1330
    expect(disc.discountTotal).toBe(170_00n); expect(disc.taxableTotal).toBe(1330_00n)
    expect(disc.lines[0].taxable).toBe(855_00n); expect(disc.lines[1].taxable).toBe(475_00n)
    // 855×18% = 153.90 ; 475×5% = 23.75 ; total 1330 + 177.65 = 1507.65 → 1508, round-off +0.35
    expect(disc.taxTotal).toBe(177_65n); expect(disc.total).toBe(1508_00n); expect(disc.roundOff).toBe(35n)
    const odd = computeDocument({ lines: [{ quantity: 3, rate: 33_33n, taxPercentBp: 1800 }], taxInclusive: false, interState: false, roundOff: true })
    expect(odd.cgstTotal + odd.sgstTotal).toBe(odd.taxTotal)
    expect(distribute(100n, [3n, 3n, 3n]).reduce((a, b) => a + b, 0n)).toBe(100n)
  })
})

describe('Phase 3 · sales chain', () => {
  it('posts an invoice: Dr AR, Cr income, Cr CGST/SGST, round-off; creates an open item', async () => {
    const { ctx, customer, item, gst18 } = await setup()
    const inv = await Documents.create(prisma, ctx, 'invoice', { contact_id: customer.id, date: '2026-04-05', lines: [{ item_id: item.id, quantity: 1, rate: 1000_50, tax_rate_id: gst18.id }] })
    expect(inv.number).toMatch(/^INV-/)
    // 1000.50 taxable, 18% = 180.09 → 1180.59 → rounded 1181.00, round-off +0.41
    expect(inv.total).toBe(1181_00n); expect(inv.roundOff).toBe(41n); expect(inv.cgstTotal).toBe(90_05n); expect(inv.sgstTotal).toBe(90_04n)
    const posted = await Documents.post(prisma, ctx, inv.id)
    expect(posted.status).toBe('posted'); expect(posted.journalId).toBeTruthy()
    expect(await balance(ctx, (await ledger(ctx, 'accounts_receivable')).id)).toBe(1181_00n)
    expect(await balance(ctx, (await ledger(ctx, 'sales')).id)).toBe(-1000_50n)
    expect(await balance(ctx, (await ledger(ctx, 'cgst_output')).id)).toBe(-90_05n)
    expect(await balance(ctx, (await ledger(ctx, 'round_off')).id)).toBe(-41n)
    const bill = await prisma.booksBill.findFirstOrThrow({ where: { sourceType: 'invoice', sourceId: inv.id } })
    expect(bill.balance).toBe(1181_00n); expect(bill.side).toBe('debit')
    await expect(Documents.post(prisma, ctx, inv.id)).rejects.toMatchObject({ code: 'already_posted' })
    await expect(Documents.update(prisma, ctx, inv.id, { contact_id: customer.id, date: '2026-04-05', lines: [{ rate: 1 }] })).rejects.toMatchObject({ code: 'not_editable' })
  })

  it('an inter-state customer gets IGST', async () => {
    const { ctx, customer, item, gst18 } = await setup({ orgState: '33', customerState: '29' })
    const inv = await Documents.create(prisma, ctx, 'invoice', { contact_id: customer.id, date: '2026-04-05', lines: [{ item_id: item.id, quantity: 1, rate: 1000_00, tax_rate_id: gst18.id }] })
    expect(inv.isInterState).toBe(true); expect(inv.igstTotal).toBe(180_00n); expect(inv.cgstTotal).toBe(0n)
  })

  it('estimate → sales order → invoice conversion carries lines and is non-financial until posted', async () => {
    const { ctx, customer, item, gst18 } = await setup()
    const est = await Documents.create(prisma, ctx, 'estimate', { contact_id: customer.id, date: '2026-04-01', lines: [{ item_id: item.id, quantity: 2, rate: 1000_00, tax_rate_id: gst18.id }] })
    await expect(Documents.post(prisma, ctx, est.id)).rejects.toMatchObject({ code: 'not_financial' })
    await Documents.setStatus(prisma, ctx, est.id, 'sent')
    const so = await Documents.convert(prisma, ctx, est.id, 'sales_order')
    expect(so.kind).toBe('sales_order'); expect(so.lines.length).toBe(1); expect(so.total).toBe(2360_00n)
    const inv = await Documents.convert(prisma, ctx, so.id, 'invoice')
    expect(inv.sourceDocumentId).toBe(so.id)
    expect((await Documents.get(prisma, ctx, so.id)).status).toBe('closed')
    expect(await prisma.booksJournal.count({ where: { booksOrgId: ctx.booksOrgId } })).toBe(0)
  })

  it('customer payment: partial, then one payment across two invoices, with bank charges', async () => {
    const { ctx, customer, item, gst18 } = await setup()
    const bank = await prisma.booksLedger.findFirstOrThrow({ where: { booksOrgId: ctx.booksOrgId, systemKey: 'cash' } })
    const mk = async (rate: number) => Documents.post(prisma, ctx, (await Documents.create(prisma, ctx, 'invoice', { contact_id: customer.id, date: '2026-04-05', lines: [{ item_id: item.id, quantity: 1, rate, tax_rate_id: gst18.id }] })).id)
    const inv1 = await mk(1000_00)   // 1180
    const inv2 = await mk(2000_00)   // 2360
    await Payments.create(prisma, ctx, 'received', { contact_id: customer.id, date: '2026-04-10', amount: 500_00, deposit_ledger_id: bank.id, allocations: [{ document_id: inv1.id, amount: 500_00 }] })
    expect((await Documents.get(prisma, ctx, inv1.id)).status).toBe('partially_paid')
    expect((await Documents.get(prisma, ctx, inv1.id)).balanceDue).toBe(680_00n)
    await expect(Payments.create(prisma, ctx, 'received', { contact_id: customer.id, date: '2026-04-11', amount: 100_00, deposit_ledger_id: bank.id, allocations: [{ document_id: inv1.id, amount: 200_00 }] })).rejects.toMatchObject({ code: 'over_allocation' })
    const p = await Payments.create(prisma, ctx, 'received', { contact_id: customer.id, date: '2026-04-12', amount: 3040_00, bank_charges: 10_00, deposit_ledger_id: bank.id, allocations: [{ document_id: inv1.id, amount: 680_00 }, { document_id: inv2.id, amount: 2360_00 }] })
    expect(p.number).toMatch(/^PMT-/)
    expect((await Documents.get(prisma, ctx, inv1.id)).status).toBe('paid')
    expect((await Documents.get(prisma, ctx, inv2.id)).status).toBe('paid')
    expect(await balance(ctx, (await ledger(ctx, 'accounts_receivable')).id)).toBe(0n)
    expect(await balance(ctx, bank.id)).toBe(500_00n + 3030_00n)
    expect(await balance(ctx, (await ledger(ctx, 'bank_charges')).id)).toBe(10_00n)
    // Voiding the payment re-opens the invoices.
    await Payments.void(prisma, ctx, p.id, 'bounced')
    expect((await Documents.get(prisma, ctx, inv2.id)).status).toBe('posted')
    expect((await Documents.get(prisma, ctx, inv2.id)).balanceDue).toBe(2360_00n)
    expect(await balance(ctx, (await ledger(ctx, 'accounts_receivable')).id)).toBe(3040_00n)
  })

  it('unallocated receipt becomes a customer advance open item, and TDS deducted by the customer posts to TDS Receivable', async () => {
    const { ctx, customer } = await setup()
    const cash = await ledger(ctx, 'cash')
    await Payments.create(prisma, ctx, 'received', { contact_id: customer.id, date: '2026-04-10', amount: 900_00, tds_amount: 100_00, deposit_ledger_id: cash.id, allocations: [] })
    const adv = await prisma.booksBill.findFirstOrThrow({ where: { booksOrgId: ctx.booksOrgId, billType: 'advance' } })
    expect(adv.side).toBe('credit'); expect(adv.balance).toBe(1000_00n)
    expect(await balance(ctx, (await ledger(ctx, 'tds_receivable')).id)).toBe(100_00n)
    expect(await balance(ctx, (await ledger(ctx, 'accounts_receivable')).id)).toBe(-1000_00n)
  })

  it('credit note is applied manually to a chosen invoice — never FIFO', async () => {
    const { ctx, customer, item, gst18 } = await setup()
    const mk = async (rate: number, date: string) => Documents.post(prisma, ctx, (await Documents.create(prisma, ctx, 'invoice', { contact_id: customer.id, date, lines: [{ item_id: item.id, quantity: 1, rate, tax_rate_id: gst18.id }] })).id)
    const older = await mk(1000_00, '2026-04-01')
    const newer = await mk(1000_00, '2026-04-15')
    const cn = await Documents.post(prisma, ctx, (await Documents.create(prisma, ctx, 'credit_note', { contact_id: customer.id, date: '2026-04-20', lines: [{ item_id: item.id, quantity: 1, rate: 500_00, tax_rate_id: gst18.id }] })).id)
    expect(cn.creditsRemaining).toBe(590_00n)
    expect(await balance(ctx, (await ledger(ctx, 'sales')).id)).toBe(-1500_00n)
    await Documents.applyCredit(prisma, ctx, cn.id, [{ document_id: newer.id, amount: 400_00 }], '2026-04-21')
    expect((await Documents.get(prisma, ctx, newer.id)).balanceDue).toBe(780_00n)
    expect((await Documents.get(prisma, ctx, older.id)).balanceDue).toBe(1180_00n)   // untouched: not FIFO
    expect((await Documents.get(prisma, ctx, cn.id)).creditsRemaining).toBe(190_00n)
    await expect(Documents.applyCredit(prisma, ctx, cn.id, [{ document_id: older.id, amount: 500_00 }])).rejects.toMatchObject({ code: 'over_allocation' })
    await expect(Documents.void(prisma, ctx, cn.id)).rejects.toMatchObject({ code: 'credit_applied' })
    expect(await balance(ctx, (await ledger(ctx, 'accounts_receivable')).id)).toBe(2360_00n - 590_00n)
  })

  it('retainer posts to Unearned Revenue and is recognised only when applied to a real invoice', async () => {
    const { ctx, customer, item, gst18 } = await setup()
    const cash = await ledger(ctx, 'cash')
    const unearned = await ledger(ctx, 'unearned_revenue')
    const sales = await ledger(ctx, 'sales')
    const ret = await Documents.post(prisma, ctx, (await Documents.create(prisma, ctx, 'retainer_invoice', { contact_id: customer.id, date: '2026-04-01', lines: [{ description: 'Advance for FY audit', rate: 10000_00, tax_rate_id: gst18.id }] })).id)
    expect(await balance(ctx, unearned.id)).toBe(-10000_00n)
    expect(await balance(ctx, sales.id)).toBe(0n)
    await expect(Documents.applyRetainer(prisma, ctx, ret.id, [{ document_id: ret.id, amount: 1 }])).rejects.toMatchObject({ code: 'retainer_unpaid' })
    await Payments.create(prisma, ctx, 'received', { contact_id: customer.id, date: '2026-04-02', amount: 11800_00, deposit_ledger_id: cash.id, allocations: [{ document_id: ret.id, amount: 11800_00 }] })
    const inv = await Documents.post(prisma, ctx, (await Documents.create(prisma, ctx, 'invoice', { contact_id: customer.id, date: '2026-05-01', lines: [{ item_id: item.id, quantity: 1, rate: 25000_00, tax_rate_id: gst18.id }] })).id)
    await Documents.applyRetainer(prisma, ctx, ret.id, [{ document_id: inv.id, amount: 10000_00 }], '2026-05-01')
    expect(await balance(ctx, unearned.id)).toBe(0n)
    expect(await balance(ctx, sales.id)).toBe(-25000_00n)
    expect((await Documents.get(prisma, ctx, inv.id)).balanceDue).toBe(29500_00n - 10000_00n)
    await expect(Documents.applyRetainer(prisma, ctx, ret.id, [{ document_id: inv.id, amount: 1_00 }])).rejects.toMatchObject({ code: 'over_allocation' })
  })

  it('voiding a posted invoice reverses it and keeps it in history', async () => {
    const { ctx, customer, item, gst18 } = await setup()
    const inv = await Documents.post(prisma, ctx, (await Documents.create(prisma, ctx, 'invoice', { contact_id: customer.id, date: '2026-04-05', lines: [{ item_id: item.id, rate: 1000_00, tax_rate_id: gst18.id }] })).id)
    const v = await Documents.void(prisma, ctx, inv.id, 'raised in error')
    expect(v.status).toBe('void')
    expect(await balance(ctx, (await ledger(ctx, 'accounts_receivable')).id)).toBe(0n)
    expect(await prisma.booksJournal.count({ where: { booksOrgId: ctx.booksOrgId, sourceId: inv.id } })).toBe(2)
    expect((await prisma.booksBill.findFirstOrThrow({ where: { sourceId: inv.id } })).status).toBe('closed')
  })
})

describe('Phase 4 · purchase chain', () => {
  it('posts a bill: Dr expense, Dr GST input, Cr AP net of TDS, Cr TDS Payable; pays it', async () => {
    const { ctx, vendor, gst18 } = await setup()
    const cash = await ledger(ctx, 'cash')
    const fees = await prisma.booksLedger.findFirstOrThrow({ where: { booksOrgId: ctx.booksOrgId, name: 'Professional Fees' } })
    const bill = await Documents.create(prisma, ctx, 'bill', { contact_id: vendor.id, date: '2026-04-05', lines: [{ description: 'Legal opinion', rate: 10000_00, tax_rate_id: gst18.id, ledger_id: fees.id }] })
    // 194J 10% on taxable 10,000 → TDS 1,000; total 11,800; payable 10,800
    expect(bill.tdsTotal).toBe(1000_00n); expect(bill.total).toBe(11800_00n); expect(bill.balanceDue).toBe(10800_00n)
    const posted = await Documents.post(prisma, ctx, bill.id)
    expect(posted.status).toBe('posted')
    expect(await balance(ctx, fees.id)).toBe(10000_00n)
    expect(await balance(ctx, (await ledger(ctx, 'cgst_input')).id)).toBe(900_00n)
    expect(await balance(ctx, (await ledger(ctx, 'accounts_payable')).id)).toBe(-10800_00n)
    expect(await balance(ctx, (await ledger(ctx, 'tds_payable')).id)).toBe(-1000_00n)
    const p = await Payments.create(prisma, ctx, 'made', { contact_id: vendor.id, date: '2026-04-20', amount: 10800_00, deposit_ledger_id: cash.id, allocations: [{ document_id: bill.id, amount: 10800_00 }] })
    expect(p.number).toMatch(/^VPMT-/)
    expect((await Documents.get(prisma, ctx, bill.id)).status).toBe('paid')
    expect(await balance(ctx, (await ledger(ctx, 'accounts_payable')).id)).toBe(0n)
    expect(await balance(ctx, cash.id)).toBe(-10800_00n)
  })

  it('a vendor without PAN is deducted at the higher rate', async () => {
    const { ctx, vendor, gst18 } = await setup({ vendorPan: false })
    const bill = await Documents.create(prisma, ctx, 'bill', { contact_id: vendor.id, date: '2026-04-05', lines: [{ description: 'Fees', rate: 10000_00, tax_rate_id: gst18.id }] })
    expect(bill.tdsTotal).toBe(2000_00n)   // 20% without PAN
  })

  it('purchase order → bill; vendor credit applied to a bill; wrong contact type refused', async () => {
    const { ctx, vendor, customer, gst18 } = await setup()
    const po = await Documents.create(prisma, ctx, 'purchase_order', { contact_id: vendor.id, date: '2026-04-01', lines: [{ description: 'Laptops', quantity: 2, rate: 50000_00, tax_rate_id: gst18.id }] })
    const bill = await Documents.convert(prisma, ctx, po.id, 'bill')
    expect(bill.kind).toBe('bill'); expect(bill.sourceDocumentId).toBe(po.id)
    await Documents.post(prisma, ctx, bill.id)
    const vc = await Documents.post(prisma, ctx, (await Documents.create(prisma, ctx, 'vendor_credit', { contact_id: vendor.id, date: '2026-04-10', lines: [{ description: 'Returned one laptop', rate: 50000_00, tax_rate_id: gst18.id }] })).id)
    expect(vc.creditsRemaining).toBe(59000_00n)
    await Documents.applyCredit(prisma, ctx, vc.id, [{ document_id: bill.id, amount: 59000_00 }])
    const after = await Documents.get(prisma, ctx, bill.id)
    expect(after.balanceDue).toBe(bill.balanceDue - 59000_00n)
    expect((await Documents.get(prisma, ctx, vc.id)).status).toBe('closed')
    await expect(Documents.create(prisma, ctx, 'bill', { contact_id: customer.id, date: '2026-04-01', lines: [{ rate: 1 }] })).rejects.toMatchObject({ code: 'wrong_contact_type' })
  })
})
