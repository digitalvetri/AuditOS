/**
 * TALLY ACCOUNTING ENGINE — verification suite (spec §26, §27, §28).
 *
 * Runs against the dev database using FIXTURE-prefixed companies that are
 * deleted before and after the run, so it never touches real data. Every
 * expected number below is the number an accountant would compute by hand;
 * nothing is read back from the same code path that produced it.
 *
 * Run:  npm --prefix server run test:tally
 */
import '../../../lib/env.js'
import { PrismaClient } from '@prisma/client'
import type { Session } from '../../../platform/auth.js'
import { BookkeepingCompanyService } from '../services/BookkeepingCompanyService.js'
import { BookkeepingGroupService } from '../services/BookkeepingGroupService.js'
import { BookkeepingLedgerService } from '../services/BookkeepingLedgerService.js'
import { BookkeepingBootstrapService } from '../services/BookkeepingBootstrapService.js'
import { BookkeepingVoucherService } from '../services/BookkeepingVoucherService.js'
import { BookkeepingReportService } from '../services/BookkeepingReportService.js'
import { postVoucher, cancelVoucher } from '../engine/posting.js'
import { trialBalance, profitAndLoss, balanceSheet, ledgerBalances } from '../engine/balances.js'
import { stockPositions } from '../engine/inventory.js'
import { gstSummary, gstr3b, splitGst } from '../engine/gst.js'

const prisma = new PrismaClient()
const L = (rupees: number) => Math.round(rupees * 100) // rupees → paise

let passed = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) { passed++; console.log(`  ✓ ${name}`); return }
  failures.push(`${name}\n      expected ${String(expected)}\n      actual   ${String(actual)}`)
  console.error(`  ✗ ${name} — expected ${String(expected)}, got ${String(actual)}`)
}
function checkThrows(name: string, fn: () => Promise<unknown>, codeFragment: string) {
  return fn().then(
    () => { failures.push(name + ' — expected a rejection, got success'); console.error(`  ✗ ${name} — expected a rejection`) },
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: string })?.code ?? ''
      if (code.includes(codeFragment) || msg.toLowerCase().includes(codeFragment.toLowerCase())) {
        passed++; console.log(`  ✓ ${name}`)
      } else {
        failures.push(`${name} — rejected with "${code}: ${msg}", expected ${codeFragment}`)
        console.error(`  ✗ ${name} — rejected with "${code}: ${msg}"`)
      }
    },
  )
}

async function loadSession(): Promise<Session> {
  const user = await prisma.user.findFirst({
    where: { role: { code: 'md' } },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  })
  if (!user) throw new Error('no md user found — run `npm --prefix server run seed` first')
  return {
    userId: user.id, email: user.email, roleId: user.roleId,
    roleCode: user.role.code as Session['roleCode'], roleName: user.role.name,
    grants: user.role.permissions.map((rp) => ({
      permission: rp.permission.code, scope: rp.scope as Session['grants'][number]['scope'],
    })),
    employeeId: null, departmentId: null, employeeFullName: null,
  }
}

async function cleanup(organisationId: string) {
  const cos = await prisma.tallyCompany.findMany({ where: { organisationId, name: { startsWith: 'FIXTURE-' } } })
  for (const c of cos) {
    const id = c.id
    await prisma.tallyBillAllocation.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyVoucherItem.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyVoucherEntry.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyVoucherRevision.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyVoucher.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyVoucherType.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyStockOpening.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyStockBatch.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyStockItem.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyStockGroup.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyStockCategory.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyGodown.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyUnit.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyBankStatementLine.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyBankReconciliation.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyTaxRate.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallySetting.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyPayrollLine.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyPayrollRun.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallySalaryStructureLine.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyAttendanceRecord.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyPayHead.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyEmployee.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyBackup.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyLedger.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyGroup.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyFinancialYear.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.tallyCompany.delete({ where: { id } })
  }
}

/** Build a company with the named ledgers under the named primary groups. */
async function makeCompany(session: Session, name: string, ledgerSpecs: [string, string][]) {
  const company = await BookkeepingCompanyService.create(session, { name, booksBeginFrom: '2026-04-01', fyBeginMonth: 4 })
  await BookkeepingBootstrapService.ensure(company.id)
  const groups = await BookkeepingGroupService.list(session, company.id)
  const groupByName = new Map(groups.map((g) => [g.name, g.id]))
  const ledgers = new Map<string, string>()
  for (const [ledgerName, groupName] of ledgerSpecs) {
    const groupId = groupByName.get(groupName)
    if (!groupId) throw new Error(`primary group "${groupName}" missing`)
    const l = await BookkeepingLedgerService.create(session, company.id, { name: ledgerName, groupId })
    ledgers.set(ledgerName, l.id)
  }
  const all = await BookkeepingLedgerService.list(session, company.id, {})
  for (const l of all) ledgers.set(l.name, l.id)
  return { company, ledgers, groupByName }
}

// ════════════════════════════════════════════════════════════════════
// §27 — the mandatory accounting dataset
// ════════════════════════════════════════════════════════════════════
async function mandatoryDataset(session: Session) {
  console.log('\n§27 Mandatory accounting test — Kovai Tech Traders Pvt Ltd')
  const { company, ledgers } = await makeCompany(session, 'FIXTURE-Kovai Tech Traders Pvt Ltd', [
    ['Owner Capital', 'Capital Account'],
    ['HDFC Bank', 'Bank Accounts'],
    ['Cash', 'Cash-in-Hand'],
    ['Computer Equipment', 'Fixed Assets'],
    ['ABC Suppliers', 'Sundry Creditors'],
    ['XYZ Customers', 'Sundry Debtors'],
    ['Purchase', 'Purchase Accounts'],
    ['Sales', 'Sales Accounts'],
    ['Office Rent', 'Indirect Expenses'],
    ['Salary', 'Indirect Expenses'],
  ])
  const id = (n: string) => ledgers.get(n)!
  const post = (input: Parameters<typeof postVoucher>[1]) => postVoucher(company.id, input, session.userId)

  // 01-Apr — capital introduced ₹5,00,000 into HDFC Bank
  await post({
    voucherTypeCode: 'receipt', date: '2026-04-01', narration: 'Capital introduced',
    entries: [
      { ledgerId: id('HDFC Bank'), entryType: 'dr', amountPaise: L(500000) },
      { ledgerId: id('Owner Capital'), entryType: 'cr', amountPaise: L(500000) },
    ],
  })
  // 02-Apr — computer purchased ₹50,000 from HDFC Bank
  await post({
    voucherTypeCode: 'payment', date: '2026-04-02', narration: 'Computer purchased',
    entries: [
      { ledgerId: id('Computer Equipment'), entryType: 'dr', amountPaise: L(50000) },
      { ledgerId: id('HDFC Bank'), entryType: 'cr', amountPaise: L(50000) },
    ],
  })
  // 03-Apr — office rent ₹20,000 from HDFC Bank
  await post({
    voucherTypeCode: 'payment', date: '2026-04-03', narration: 'Office rent April',
    entries: [
      { ledgerId: id('Office Rent'), entryType: 'dr', amountPaise: L(20000) },
      { ledgerId: id('HDFC Bank'), entryType: 'cr', amountPaise: L(20000) },
    ],
  })
  // 05-Apr — credit purchase ₹1,00,000 from ABC Suppliers
  const purchase = await post({
    voucherTypeCode: 'purchase', date: '2026-04-05', narration: 'Credit purchase',
    partyLedgerId: id('ABC Suppliers'), referenceNumber: 'ABC/001',
    entries: [
      { ledgerId: id('Purchase'), entryType: 'dr', amountPaise: L(100000) },
      {
        ledgerId: id('ABC Suppliers'), entryType: 'cr', amountPaise: L(100000), isPartyLedger: true,
        billAllocations: [{ billRef: 'ABC/001', method: 'new', amountPaise: L(100000), dueDate: '2026-05-05' }],
      },
    ],
  })
  // 10-Apr — credit sale ₹1,50,000 to XYZ Customers
  const sale = await post({
    voucherTypeCode: 'sales', date: '2026-04-10', narration: 'Credit sale',
    partyLedgerId: id('XYZ Customers'),
    entries: [
      {
        ledgerId: id('XYZ Customers'), entryType: 'dr', amountPaise: L(150000), isPartyLedger: true,
        billAllocations: [{ billRef: 'INV-0001', method: 'new', amountPaise: L(150000), dueDate: '2026-05-10' }],
      },
      { ledgerId: id('Sales'), entryType: 'cr', amountPaise: L(150000) },
    ],
  })
  // 15-Apr — customer receipt ₹1,00,000 into HDFC Bank
  await post({
    voucherTypeCode: 'receipt', date: '2026-04-15', narration: 'Receipt from XYZ',
    partyLedgerId: id('XYZ Customers'),
    entries: [
      { ledgerId: id('HDFC Bank'), entryType: 'dr', amountPaise: L(100000) },
      {
        ledgerId: id('XYZ Customers'), entryType: 'cr', amountPaise: L(100000), isPartyLedger: true,
        billAllocations: [{ billRef: 'INV-0001', method: 'against', amountPaise: L(100000) }],
      },
    ],
  })
  // 20-Apr — supplier payment ₹60,000 from HDFC Bank
  await post({
    voucherTypeCode: 'payment', date: '2026-04-20', narration: 'Payment to ABC',
    partyLedgerId: id('ABC Suppliers'),
    entries: [
      {
        ledgerId: id('ABC Suppliers'), entryType: 'dr', amountPaise: L(60000), isPartyLedger: true,
        billAllocations: [{ billRef: 'ABC/001', method: 'against', amountPaise: L(60000) }],
      },
      { ledgerId: id('HDFC Bank'), entryType: 'cr', amountPaise: L(60000) },
    ],
  })
  // 25-Apr — salary ₹30,000 from HDFC Bank
  await post({
    voucherTypeCode: 'payment', date: '2026-04-25', narration: 'Salary April',
    entries: [
      { ledgerId: id('Salary'), entryType: 'dr', amountPaise: L(30000) },
      { ledgerId: id('HDFC Bank'), entryType: 'cr', amountPaise: L(30000) },
    ],
  })

  // ── Expected results (§27) ────────────────────────────────────────
  const period = { from: '2026-04-01', to: '2027-03-31' }
  const balances = await ledgerBalances(company.id, period)
  const bal = (n: string) => balances.find((b) => b.ledgerName === n)!.closingPaise

  check('Bank closing = ₹4,40,000 Dr', bal('HDFC Bank'), L(440000))
  check('Customer outstanding = ₹50,000 Dr', bal('XYZ Customers'), L(50000))
  check('Supplier outstanding = ₹40,000 Cr', bal('ABC Suppliers'), -L(40000))
  check('Computer Equipment = ₹50,000 Dr', bal('Computer Equipment'), L(50000))
  check('Sales = ₹1,50,000 Cr', bal('Sales'), -L(150000))
  check('Purchase = ₹1,00,000 Dr', bal('Purchase'), L(100000))
  check('Office Rent = ₹20,000 Dr', bal('Office Rent'), L(20000))
  check('Salary = ₹30,000 Dr', bal('Salary'), L(30000))
  check('Owner Capital = ₹5,00,000 Cr', bal('Owner Capital'), -L(500000))

  const tb = await trialBalance(company.id, period)
  check('Trial balance is balanced', tb.totals.balanced, true)
  check('Trial balance debit total = ₹6,90,000', tb.totals.closingDebitPaise, L(690000))
  check('Trial balance credit total = ₹6,90,000', tb.totals.closingCreditPaise, L(690000))

  const pl = await profitAndLoss(company.id, period)
  check('P&L income = ₹1,50,000', pl.income.totalPaise, L(150000))
  check('P&L expenses = ₹1,50,000', pl.expenses.totalPaise, L(150000))
  check('Profit = ₹0', pl.netProfitPaise, 0)

  const bs = await balanceSheet(company.id, { asOf: '2027-03-31', fyStart: '2026-04-01' })
  check('Total assets = ₹5,40,000', bs.assets.totalPaise, L(540000))
  check('Liabilities + capital = ₹5,40,000', bs.liabilities.totalPaise + bs.netProfitPaise, L(540000))
  check('Balance sheet balances', bs.balanced, true)

  // ── Outstanding / ageing from bill allocations ────────────────────
  const receivables = await BookkeepingReportService.outstandings(session, company.id, { side: 'receivable', asOf: '2026-04-30' })
  check('Receivables total = ₹50,000', receivables.totalPaise, L(50000))
  check('One receivable party', receivables.parties.length, 1)
  const payables = await BookkeepingReportService.outstandings(session, company.id, { side: 'payable', asOf: '2026-04-30' })
  check('Payables total = ₹40,000', payables.totalPaise, L(40000))

  // ── Day book + registers derive from the same vouchers ────────────
  const daybook = await BookkeepingReportService.dayBook(session, company.id, { from: '2026-04-01', to: '2026-04-30' })
  check('Day book shows 8 vouchers', daybook.items.length, 8)
  const salesRegister = await BookkeepingReportService.register(session, company.id, 'sales', period)
  check('Sales register total = ₹1,50,000', salesRegister.totals.grandTotalPaise, L(150000))

  // ── Ledger drill-down ─────────────────────────────────────────────
  const ledger = await BookkeepingReportService.ledgerStatement(session, company.id, ledgers.get('HDFC Bank')!, period)
  check('Bank ledger shows 6 movements', ledger.rows.length, 6)
  check('Bank ledger closing = ₹4,40,000', ledger.closingPaise, L(440000))

  return { company, ledgers, purchaseId: purchase.id, saleId: sale.id }
}

// ════════════════════════════════════════════════════════════════════
// §28 — GST test
// ════════════════════════════════════════════════════════════════════
async function gstDataset(session: Session) {
  console.log('\n§28 GST test')
  const { company, ledgers } = await makeCompany(session, 'FIXTURE-GST Traders', [
    ['GST Supplier', 'Sundry Creditors'],
    ['GST Customer', 'Sundry Debtors'],
    ['Purchase GST', 'Purchase Accounts'],
    ['Sales GST', 'Sales Accounts'],
  ])
  const id = (n: string) => ledgers.get(n)!
  const post = (input: Parameters<typeof postVoucher>[1]) => postVoucher(company.id, input, session.userId)

  // Purchase: taxable ₹1,00,000 + CGST 9% ₹9,000 + SGST 9% ₹9,000 = ₹1,18,000
  const purchaseTax = splitGst(L(100000), 1800, false)
  check('splitGst 18% intra-state → CGST ₹9,000', purchaseTax.cgstPaise, L(9000))
  check('splitGst 18% intra-state → SGST ₹9,000', purchaseTax.sgstPaise, L(9000))
  await post({
    voucherTypeCode: 'purchase', date: '2026-04-05', partyLedgerId: id('GST Supplier'), placeOfSupply: '33',
    entries: [
      { ledgerId: id('Purchase GST'), entryType: 'dr', amountPaise: L(100000) },
      { ledgerId: id('Input CGST'), entryType: 'dr', amountPaise: purchaseTax.cgstPaise },
      { ledgerId: id('Input SGST'), entryType: 'dr', amountPaise: purchaseTax.sgstPaise },
      { ledgerId: id('GST Supplier'), entryType: 'cr', amountPaise: L(118000), isPartyLedger: true },
    ],
  })

  // Sales: taxable ₹1,50,000 + CGST 9% ₹13,500 + SGST 9% ₹13,500 = ₹1,77,000
  const salesTax = splitGst(L(150000), 1800, false)
  await post({
    voucherTypeCode: 'sales', date: '2026-04-10', partyLedgerId: id('GST Customer'), placeOfSupply: '33',
    entries: [
      { ledgerId: id('GST Customer'), entryType: 'dr', amountPaise: L(177000), isPartyLedger: true },
      { ledgerId: id('Sales GST'), entryType: 'cr', amountPaise: L(150000) },
      { ledgerId: id('Output CGST'), entryType: 'cr', amountPaise: salesTax.cgstPaise },
      { ledgerId: id('Output SGST'), entryType: 'cr', amountPaise: salesTax.sgstPaise },
    ],
  })

  const period = { from: '2026-04-01', to: '2027-03-31' }
  const balances = await ledgerBalances(company.id, period)
  const bal = (n: string) => balances.find((b) => b.ledgerName === n)!.closingPaise
  check('Input CGST ledger = ₹9,000 Dr', bal('Input CGST'), L(9000))
  check('Input SGST ledger = ₹9,000 Dr', bal('Input SGST'), L(9000))
  check('Output CGST ledger = ₹13,500 Cr', bal('Output CGST'), -L(13500))
  check('Output SGST ledger = ₹13,500 Cr', bal('Output SGST'), -L(13500))

  const gst = await gstSummary(company.id, period)
  check('GST summary input CGST = ₹9,000', gst.input.cgstPaise, L(9000))
  check('GST summary input SGST = ₹9,000', gst.input.sgstPaise, L(9000))
  check('GST summary output CGST = ₹13,500', gst.output.cgstPaise, L(13500))
  check('GST summary output SGST = ₹13,500', gst.output.sgstPaise, L(13500))
  check('Net CGST payable = ₹4,500', gst.net.cgstPaise, L(4500))
  check('Net SGST payable = ₹4,500', gst.net.sgstPaise, L(4500))
  check('Total net GST = ₹9,000', gst.net.totalPaise, L(9000))
  check('Outward taxable value = ₹1,50,000', gst.outwardTaxableValuePaise, L(150000))
  check('Inward taxable value = ₹1,00,000', gst.inwardTaxableValuePaise, L(100000))

  const r3b = await gstr3b(company.id, period.from, period.to)
  check('GSTR-3B net payable = ₹9,000', r3b.netPayable.totalPaise, L(9000))
  check('GSTR-3B is prepared, not filed', r3b.status, 'prepared')

  const tb = await trialBalance(company.id, period)
  check('GST company trial balance balances', tb.totals.balanced, true)
  const bs = await balanceSheet(company.id, { asOf: '2027-03-31', fyStart: '2026-04-01' })
  check('GST company balance sheet balances', bs.balanced, true)
  const pl = await profitAndLoss(company.id, period)
  check('GST company profit = ₹50,000', pl.netProfitPaise, L(50000))
}

// ════════════════════════════════════════════════════════════════════
// Integrity rules, inventory, isolation, cancellation, audit trail
// ════════════════════════════════════════════════════════════════════
async function integritySuite(session: Session, ctx: Awaited<ReturnType<typeof mandatoryDataset>>) {
  console.log('\nIntegrity rules')
  const { company, ledgers } = ctx
  const id = (n: string) => ledgers.get(n)!

  await checkThrows('Unbalanced voucher is refused',
    () => postVoucher(company.id, {
      voucherTypeCode: 'journal', date: '2026-04-11',
      entries: [
        { ledgerId: id('Office Rent'), entryType: 'dr', amountPaise: L(1000) },
        { ledgerId: id('HDFC Bank'), entryType: 'cr', amountPaise: L(900) },
      ],
    }, session.userId), 'unbalanced')

  await checkThrows('Posting before books-begin is refused',
    () => postVoucher(company.id, {
      voucherTypeCode: 'journal', date: '2026-03-31',
      entries: [
        { ledgerId: id('Office Rent'), entryType: 'dr', amountPaise: L(100) },
        { ledgerId: id('HDFC Bank'), entryType: 'cr', amountPaise: L(100) },
      ],
    }, session.userId), 'before_books_begin')

  await checkThrows('Posting outside any financial year is refused',
    () => postVoucher(company.id, {
      voucherTypeCode: 'journal', date: '2028-06-01',
      entries: [
        { ledgerId: id('Office Rent'), entryType: 'dr', amountPaise: L(100) },
        { ledgerId: id('HDFC Bank'), entryType: 'cr', amountPaise: L(100) },
      ],
    }, session.userId), 'no_financial_year')

  // ── Multi-company isolation ───────────────────────────────────────
  console.log('\nMulti-company isolation')
  const other = await makeCompany(session, 'FIXTURE-Other Co', [['Other Bank', 'Bank Accounts']])
  await checkThrows('A ledger from another company cannot be posted',
    () => postVoucher(other.company.id, {
      voucherTypeCode: 'journal', date: '2026-04-11',
      entries: [
        { ledgerId: other.ledgers.get('Other Bank')!, entryType: 'dr', amountPaise: L(100) },
        { ledgerId: id('HDFC Bank'), entryType: 'cr', amountPaise: L(100) },
      ],
    }, session.userId), 'unknown_ledger')

  const otherBalances = await ledgerBalances(other.company.id, {})
  check('Other company sees none of the first company\'s vouchers',
    otherBalances.every((b) => b.debitPaise === 0 && b.creditPaise === 0), true)
  const otherDaybook = await BookkeepingReportService.dayBook(session, other.company.id, {})
  check('Other company day book is empty', otherDaybook.items.length, 0)

  // ── Voucher cancellation ──────────────────────────────────────────
  console.log('\nCancellation, restore and the audit trail')
  const beforeCancel = (await ledgerBalances(company.id, {})).find((b) => b.ledgerName === 'Salary')!.closingPaise
  const salaryVoucher = await prisma.tallyVoucher.findFirstOrThrow({
    where: { tallyCompanyId: company.id, narration: 'Salary April' },
  })
  await cancelVoucher(company.id, salaryVoucher.id, 'Duplicate entry', session.userId)
  const afterCancel = (await ledgerBalances(company.id, {})).find((b) => b.ledgerName === 'Salary')!.closingPaise
  check('Cancelled voucher stops affecting balances', afterCancel, beforeCancel - L(30000))

  const tbCancelled = await trialBalance(company.id, {})
  check('Trial balance still balances after a cancellation', tbCancelled.totals.balanced, true)

  const revisions = await prisma.tallyVoucherRevision.findMany({ where: { voucherId: salaryVoucher.id }, orderBy: { version: 'asc' } })
  check('Cancellation is recorded in the voucher history', revisions.at(-1)?.action, 'cancelled')
  check('Creation is still in the voucher history', revisions[0]?.action, 'created')

  const restored = await BookkeepingVoucherService.restore(session, company.id, salaryVoucher.id)
  check('Restore brings the voucher back', restored.status, 'active')
  const afterRestore = (await ledgerBalances(company.id, {})).find((b) => b.ledgerName === 'Salary')!.closingPaise
  check('Restored voucher affects balances again', afterRestore, beforeCancel)

  // ── Alteration writes a before/after pair ─────────────────────────
  const rentVoucher = await prisma.tallyVoucher.findFirstOrThrow({
    where: { tallyCompanyId: company.id, narration: 'Office rent April' },
  })
  await BookkeepingVoucherService.update(session, company.id, rentVoucher.id, {
    voucherTypeCode: 'payment', date: '2026-04-03', narration: 'Office rent April (revised)',
    entries: [
      { ledgerId: id('Office Rent'), entryType: 'dr', amountPaise: L(22000) },
      { ledgerId: id('HDFC Bank'), entryType: 'cr', amountPaise: L(22000) },
    ],
  })
  const rentRevisions = await prisma.tallyVoucherRevision.findMany({ where: { voucherId: rentVoucher.id }, orderBy: { version: 'asc' } })
  check('Alteration is recorded with a before snapshot', Boolean(rentRevisions.at(-1)?.beforeJson), true)
  check('Alteration is recorded with an after snapshot', Boolean(rentRevisions.at(-1)?.afterJson), true)
  const rentAfter = (await ledgerBalances(company.id, {})).find((b) => b.ledgerName === 'Office Rent')!.closingPaise
  check('Altered voucher moves the balance to the new amount', rentAfter, L(22000))
  const tbAltered = await trialBalance(company.id, {})
  check('Trial balance balances after an alteration', tbAltered.totals.balanced, true)

  // Put it back so the mandatory figures above stay the documented ones.
  await BookkeepingVoucherService.update(session, company.id, rentVoucher.id, {
    voucherTypeCode: 'payment', date: '2026-04-03', narration: 'Office rent April',
    entries: [
      { ledgerId: id('Office Rent'), entryType: 'dr', amountPaise: L(20000) },
      { ledgerId: id('HDFC Bank'), entryType: 'cr', amountPaise: L(20000) },
    ],
  })
}

// ════════════════════════════════════════════════════════════════════
// Inventory: opening 10 + purchase 5 − sales 3 = 12 (spec §9)
// ════════════════════════════════════════════════════════════════════
async function inventorySuite(session: Session) {
  console.log('\nInventory')
  const { company, ledgers } = await makeCompany(session, 'FIXTURE-Stock Co', [
    ['Stock Supplier', 'Sundry Creditors'],
    ['Stock Customer', 'Sundry Debtors'],
    ['Purchase Stock', 'Purchase Accounts'],
    ['Sales Stock', 'Sales Accounts'],
  ])
  const id = (n: string) => ledgers.get(n)!
  const unit = await prisma.tallyUnit.findFirstOrThrow({ where: { tallyCompanyId: company.id, name: 'Nos' } })
  const godown = await prisma.tallyGodown.findFirstOrThrow({ where: { tallyCompanyId: company.id } })
  const item = await prisma.tallyStockItem.create({
    data: { tallyCompanyId: company.id, name: 'Widget', unitId: unit.id, hsnCode: '8471', gstRateBp: 1800, reorderLevelMilli: 5000 },
  })
  await prisma.tallyStockOpening.create({
    data: { tallyCompanyId: company.id, stockItemId: item.id, godownId: godown.id, qtyMilli: 10_000, ratePaise: L(1000), valuePaise: L(10000) },
  })

  await postVoucher(company.id, {
    voucherTypeCode: 'purchase', date: '2026-04-05', partyLedgerId: id('Stock Supplier'),
    entries: [
      { ledgerId: id('Purchase Stock'), entryType: 'dr', amountPaise: L(5000) },
      { ledgerId: id('Stock Supplier'), entryType: 'cr', amountPaise: L(5000), isPartyLedger: true },
    ],
    items: [{ stockItemId: item.id, godownId: godown.id, direction: 'in', qtyMilli: 5_000, ratePaise: L(1000), hsnCode: '8471', gstRateBp: 1800 }],
  }, session.userId)

  await postVoucher(company.id, {
    voucherTypeCode: 'sales', date: '2026-04-10', partyLedgerId: id('Stock Customer'),
    entries: [
      { ledgerId: id('Stock Customer'), entryType: 'dr', amountPaise: L(4500), isPartyLedger: true },
      { ledgerId: id('Sales Stock'), entryType: 'cr', amountPaise: L(4500) },
    ],
    items: [{ stockItemId: item.id, godownId: godown.id, direction: 'out', qtyMilli: 3_000, ratePaise: L(1500), hsnCode: '8471', gstRateBp: 1800 }],
  }, session.userId)

  const positions = await stockPositions(company.id, { from: '2026-04-01', to: '2027-03-31' })
  const widget = positions.find((p) => p.stockItemName === 'Widget')!
  check('Opening stock = 10', widget.openingQtyMilli / 1000, 10)
  check('Inward = 5', widget.inwardQtyMilli / 1000, 5)
  check('Outward = 3', widget.outwardQtyMilli / 1000, 3)
  check('Closing stock = 12 (not hardcoded)', widget.closingQtyMilli / 1000, 12)
  check('Closing value at average cost = ₹12,000', widget.closingValuePaise, L(12000))
  check('Widget is not below its reorder level', widget.belowReorder, false)

  // A stock journal moving stock out below zero is detected, not hidden.
  await postVoucher(company.id, {
    voucherTypeCode: 'stock_journal', date: '2026-04-20',
    items: [{ stockItemId: item.id, godownId: godown.id, direction: 'out', qtyMilli: 20_000, ratePaise: L(1000) }],
  }, session.userId)
  const after = (await stockPositions(company.id, { from: '2026-04-01', to: '2027-03-31' })).find((p) => p.stockItemName === 'Widget')!
  check('Negative stock is flagged', after.negative, true)
  check('Negative closing quantity is reported honestly', after.closingQtyMilli / 1000, -8)
}

async function main() {
  const session = await loadSession()
  const organisationId = await BookkeepingCompanyService.organisationIdOf(session)
  await cleanup(organisationId)
  try {
    const ctx = await mandatoryDataset(session)
    await gstDataset(session)
    await integritySuite(session, ctx)
    await inventorySuite(session)
  } finally {
    await cleanup(organisationId)
    await prisma.$disconnect()
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed`)
  if (failures.length) {
    console.error('\nFAILURES:\n  ' + failures.join('\n  '))
    process.exit(1)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
