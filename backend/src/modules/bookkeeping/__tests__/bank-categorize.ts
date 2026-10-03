/**
 * BOOKKEEPING · BANK AUTO-CATEGORIZE — service verification.
 *
 * Creates a FIXTURE company, seeds a tiny bank ledger + statement, exercises
 * propose + commit, and asserts a receipt and a payment voucher were posted
 * and both statement lines are flipped to matched. Cleans up on exit.
 *
 * Run:  npm --prefix backend run test:bookkeeping-bank-categorize
 */
import '../../../lib/env.js'
import { PrismaClient } from '@prisma/client'
import type { Session } from '../../../platform/auth.js'
import { BookkeepingCompanyService } from '../services/BookkeepingCompanyService.js'
import { BookkeepingBootstrapService } from '../services/BookkeepingBootstrapService.js'
import { BookkeepingBankingService } from '../services/BookkeepingBankingService.js'
import { BookkeepingBankCategorizeService, DEFAULT_RULES } from '../services/BookkeepingBankCategorizeService.js'

const prisma = new PrismaClient()
const FIXTURE_PREFIX = 'FIXTURE-BANK-CAT-'
let passed = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) { passed++; console.log(`  ✓ ${name}`); return }
  failures.push(`${name}: expected ${String(expected)}, got ${String(actual)}`)
  console.error(`  ✗ ${name} — expected ${String(expected)}, got ${String(actual)}`)
}

async function loadSession(): Promise<Session> {
  const user = await prisma.user.findFirst({
    where: { role: { code: 'md' } },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  })
  if (!user) throw new Error('No MD-role user available for the fixture suite.')
  return {
    userId: user.id,
    role: user.role.code,
    organisationId: user.organisationId,
    permissions: user.role.permissions.map((p) => p.permission.code),
  } as unknown as Session
}

async function cleanupByName(organisationId: string) {
  const cos = await prisma.bookkeepingCompany.findMany({ where: { organisationId, name: { startsWith: FIXTURE_PREFIX } } })
  for (const c of cos) {
    const id = c.id
    await prisma.bookkeepingVoucherEntry.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingVoucher.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingVoucherType.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingBankStatementLine.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingBankCategorizeRule.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingGodown.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingUnit.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingLedger.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingGroup.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingFinancialYear.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingCompany.delete({ where: { id } })
  }
}

async function createCompany(session: Session) {
  return BookkeepingCompanyService.create(session, {
    name: `${FIXTURE_PREFIX}${Date.now()}`,
    state: 'Tamil Nadu',
    booksBeginFrom: '2026-04-01',
    baseCurrency: 'INR',
  } as never)
}

async function suite() {
  // Sanity: default rules compile.
  for (const r of DEFAULT_RULES) {
    try { new RegExp(r.pattern, 'i') }
    catch (e) { failures.push(`Default rule "${r.label}" has invalid regex: ${(e as Error).message}`) }
  }
  check('All default rules compile', failures.length, 0)

  const session = await loadSession()
  const organisationId = await BookkeepingCompanyService.organisationIdOf(session)
  await cleanupByName(organisationId)

  const company = await createCompany(session)
  // BookkeepingCompanyService.create() already called ensure() implicitly,
  // so the rule-target ledgers are in place before the first explicit call.
  // Verify from the DB rather than from the return value — the latter is 0
  // on a second ensure() by design.
  const seededNames = await prisma.bookkeepingLedger.findMany({
    where: { tallyCompanyId: company.id, name: { in: ['Rent', 'Bank Charges', 'Suspense', 'Interest Income', 'GST Clearing', 'Salary', 'TDS Payable'] } },
    select: { name: true },
  })
  check('Rent ledger seeded', seededNames.some((l) => l.name === 'Rent'), true)
  check('Bank Charges ledger seeded', seededNames.some((l) => l.name === 'Bank Charges'), true)
  check('Suspense ledger seeded', seededNames.some((l) => l.name === 'Suspense'), true)
  check('Interest Income ledger seeded', seededNames.some((l) => l.name === 'Interest Income'), true)
  check('GST Clearing ledger seeded', seededNames.some((l) => l.name === 'GST Clearing'), true)
  check('Salary ledger seeded', seededNames.some((l) => l.name === 'Salary'), true)
  check('TDS Payable ledger seeded', seededNames.some((l) => l.name === 'TDS Payable'), true)

  // A second explicit ensure() must not duplicate — seed is per-name
  // idempotent for the new rule-target block too.
  const seed2 = await BookkeepingBootstrapService.ensure(company.id)
  check('Second ensure() creates no duplicate rule-target ledgers', seed2.ruleTargetLedgersCreated, 0)

  // A bank ledger under Bank Accounts.
  const bankGroup = await prisma.bookkeepingGroup.findFirst({ where: { tallyCompanyId: company.id, name: 'Bank Accounts' } })
  if (!bankGroup) throw new Error('Bank Accounts group not seeded by bootstrap.')
  const bank = await prisma.bookkeepingLedger.create({
    data: { tallyCompanyId: company.id, name: 'HDFC Current', groupId: bankGroup.id },
    select: { id: true },
  })

  // Import three statement lines: one receipt, one payment that matches a
  // default rule (Rent), one payment with no rule → Suspense.
  await BookkeepingBankingService.importStatement(session, company.id, bank.id, [
    { date: '2026-04-05', description: 'NEFT ACME TRADERS INV-1001', refNumber: 'N001', debitPaise: 0, creditPaise: 100000, balancePaise: null },
    { date: '2026-04-10', description: 'NEFT RENT APR',              refNumber: 'R001', debitPaise: 50000, creditPaise: 0, balancePaise: null },
    { date: '2026-04-12', description: 'MYSTERY XFER 7788',          refNumber: 'M001', debitPaise: 7500,  creditPaise: 0, balancePaise: null },
  ])

  // A party ledger so the first line resolves via party-match (there are
  // no sales invoices in this fixture, so we create ACME directly).
  const debtors = await prisma.bookkeepingGroup.findFirst({ where: { tallyCompanyId: company.id, name: 'Sundry Debtors' } })
  if (!debtors) throw new Error('Sundry Debtors group not seeded.')
  await prisma.bookkeepingLedger.create({ data: { tallyCompanyId: company.id, name: 'ACME Traders', groupId: debtors.id } })

  const { proposals, unresolvedCount } = await BookkeepingBankCategorizeService.proposeForLedger(session, company.id, bank.id)
  check('Proposals generated for every unmatched line', proposals.length, 3)
  check('No unresolved lines (Suspense fallback worked)', unresolvedCount, 0)

  const acme = proposals.find((p) => /ACME/i.test(p.description))
  check('ACME line resolved via party_match', acme?.source, 'party_match')
  check('ACME line is a receipt (bank credit)', acme?.voucherType, 'receipt')
  check('ACME counter-ledger is ACME Traders', acme?.counterLedgerName, 'ACME Traders')

  const rent = proposals.find((p) => /RENT/i.test(p.description))
  check('Rent line resolved via default_rule', rent?.source, 'default_rule')
  check('Rent line is a payment (bank debit)', rent?.voucherType, 'payment')
  check('Rent counter-ledger is Rent', rent?.counterLedgerName, 'Rent')

  const mystery = proposals.find((p) => /MYSTERY/i.test(p.description))
  check('Mystery line falls through to Suspense', mystery?.source, 'suspense')
  check('Mystery counter-ledger is Suspense', mystery?.counterLedgerName, 'Suspense')

  // Commit all three — direction + ledger as proposed.
  const commit = await BookkeepingBankCategorizeService.commitProposals(session, company.id, bank.id, proposals.map((p) => ({
    lineId: p.lineId, counterLedgerId: p.counterLedgerId, voucherType: p.voucherType,
  })))
  check('All three proposals posted', commit.posted, 3)
  check('No commit errors', commit.errorCount, 0)
  check('Nothing skipped on first commit', commit.skipped, 0)

  // Statement lines flipped to matched.
  const lines = await prisma.bookkeepingBankStatementLine.findMany({
    where: { tallyCompanyId: company.id, bankLedgerId: bank.id },
    orderBy: { date: 'asc' },
  })
  check('All lines matched after commit', lines.filter((l) => l.status === 'matched').length, 3)

  // Vouchers of the right types posted.
  const vouchers = await prisma.bookkeepingVoucher.findMany({
    where: { tallyCompanyId: company.id },
    select: { voucherTypeCode: true, totalDebitPaise: true },
  })
  check('One receipt posted', vouchers.filter((v) => v.voucherTypeCode === 'receipt').length, 1)
  check('Two payments posted', vouchers.filter((v) => v.voucherTypeCode === 'payment').length, 2)

  // Idempotency: a second commit of the same proposals should skip, not re-post.
  const second = await BookkeepingBankCategorizeService.commitProposals(session, company.id, bank.id, proposals.map((p) => ({
    lineId: p.lineId, counterLedgerId: p.counterLedgerId, voucherType: p.voucherType,
  })))
  check('Second commit posts nothing', second.posted, 0)
  check('Second commit skips all three', second.skipped, 3)

  // Invalid regex is rejected by createRule.
  const expense = await prisma.bookkeepingGroup.findFirst({ where: { tallyCompanyId: company.id, name: 'Indirect Expenses' } })
  const anyLedger = await prisma.bookkeepingLedger.findFirst({ where: { tallyCompanyId: company.id, groupId: expense?.id ?? '' } })
  let rejected = false
  try {
    await BookkeepingBankCategorizeService.createRule(session, company.id, {
      matchPattern: '(unclosed', counterLedgerId: anyLedger!.id,
    })
  } catch { rejected = true }
  check('createRule rejects invalid regex', rejected, true)

  await cleanupByName(organisationId)
}

async function main() {
  try {
    await suite()
  } finally {
    await prisma.$disconnect()
  }
  console.log(`\n${passed} checks passed, ${failures.length} failed`)
  if (failures.length) {
    console.error('\nFAILURES:\n  ' + failures.join('\n  '))
    process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
