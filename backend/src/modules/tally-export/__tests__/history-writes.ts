/**
 * TALLY EXPORT · HISTORY WRITES — verifies the duplicate-detection cycle.
 *
 * The /generate route in routes.ts persists a TallyExport row after a
 * successful XML write. This suite exercises the same create() call-site
 * (so the test does not depend on booting the HTTP server) and then runs
 * computePreflight again on the same scope to confirm the previously-
 * exported warning fires. Before this change the warning was dead code —
 * nothing wrote the row the checker reads.
 *
 * Run:  npx tsx src/modules/tally-export/__tests__/history-writes.ts
 */
import { createHash } from 'node:crypto'
import '../../../lib/env.js'
import { PrismaClient } from '@prisma/client'
import type { Session } from '../../../platform/auth.js'
import { BookkeepingCompanyService } from '../../bookkeeping/services/BookkeepingCompanyService.js'
import { BookkeepingBankingService } from '../../bookkeeping/services/BookkeepingBankingService.js'
import { bulkCreateRules, computePreflight, listExportHistory } from '../service.js'
import { formatVouchersXml } from '../xml.js'

const prisma = new PrismaClient()
const FIXTURE_PREFIX = 'FIXTURE-TALLY-EXP-'
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
    userId: user.id, role: user.role.code, organisationId: user.organisationId,
    permissions: user.role.permissions.map((p) => p.permission.code),
  } as unknown as Session
}

async function cleanupByName(organisationId: string) {
  const cos = await prisma.bookkeepingCompany.findMany({ where: { organisationId, name: { startsWith: FIXTURE_PREFIX } } })
  for (const c of cos) {
    const id = c.id
    await prisma.tallyExport.deleteMany({ where: { companyId: id } })
    await prisma.tallyLedgerRule.deleteMany({ where: { companyId: id } })
    await prisma.bookkeepingVoucherEntry.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingVoucher.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingVoucherType.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingBankStatementLine.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingGodown.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingUnit.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingLedger.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingGroup.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingFinancialYear.deleteMany({ where: { tallyCompanyId: id } })
    await prisma.bookkeepingCompany.delete({ where: { id } })
  }
}

async function suite() {
  const session = await loadSession()
  const organisationId = await BookkeepingCompanyService.organisationIdOf(session)
  await cleanupByName(organisationId)

  const company = await BookkeepingCompanyService.create(session, {
    name: `${FIXTURE_PREFIX}${Date.now()}`,
    state: 'Tamil Nadu',
    booksBeginFrom: '2026-04-01',
    baseCurrency: 'INR',
  } as never)

  const bankGroup = await prisma.bookkeepingGroup.findFirst({ where: { tallyCompanyId: company.id, name: 'Bank Accounts' } })
  if (!bankGroup) throw new Error('Bank Accounts group not seeded.')
  const bank = await prisma.bookkeepingLedger.create({
    data: { tallyCompanyId: company.id, name: 'HDFC', groupId: bankGroup.id },
    select: { id: true, name: true },
  })

  await BookkeepingBankingService.importStatement(session, company.id, bank.id, [
    { date: '2026-04-05', description: 'NEFT ACME TRADERS INV-1001', refNumber: 'N001', debitPaise: 0, creditPaise: 100000, balancePaise: null },
    { date: '2026-04-10', description: 'NEFT RENT APR',              refNumber: 'R001', debitPaise: 50000, creditPaise: 0, balancePaise: null },
  ])

  await bulkCreateRules([
    { companyId: company.id, matchType: 'contains', pattern: 'ACME', ledgerName: 'ACME Traders', priority: 10 },
    { companyId: company.id, matchType: 'contains', pattern: 'RENT', ledgerName: 'Rent', priority: 10 },
  ], session.userId)

  const opts = { companyId: company.id, bankLedgerId: bank.id, periodFrom: '2026-04-01', periodTo: '2026-04-30' }

  // First generate: preflight clean, write TallyExport row (mirrors what
  // routes.ts does after formatVouchersXml returns).
  const report1 = await computePreflight(opts)
  check('First preflight: 2 rows', report1.totals.rows, 2)
  check('First preflight: 0 errors', report1.errors.length, 0)
  check('First preflight: no "previously_exported" warning yet',
    report1.warnings.some((w) => w.kind === 'previously_exported'), false)

  const xml = formatVouchersXml({ rows: report1.rows, bankLedgerName: bank.name })
  const checksum = createHash('sha256').update(xml).digest('hex')
  await prisma.tallyExport.create({
    data: {
      companyId: company.id,
      bankLedgerId: bank.id,
      periodFrom: '2026-04-01',
      periodTo: '2026-04-30',
      kind: 'vouchers',
      rowCount: report1.rows.length,
      voucherCount: report1.rows.length,
      checksum,
      scopeJson: JSON.stringify(report1.rows.map((r) => r.statement_line_id)),
      generatedBy: session.userId,
    },
  })

  // History reflects the write.
  const history1 = await listExportHistory(company.id, bank.id)
  check('History shows one row after generate', history1.length, 1)
  check('History row is "vouchers" kind', history1[0]?.kind, 'vouchers')
  check('History row voucher count matches', history1[0]?.voucher_count, 2)
  check('History row carries the checksum', history1[0]?.checksum, checksum)

  // Second preflight for same scope: now flags the overlap.
  const report2 = await computePreflight(opts)
  check('Second preflight: still 0 errors (not a block, a warning)', report2.errors.length, 0)
  check('Second preflight raises "previously_exported" warning',
    report2.warnings.some((w) => w.kind === 'previously_exported'), true)

  // Determinism: a second XML generation at the same scope produces the
  // same bytes → the same sha256. If this ever drifts it means voucher
  // numbers stopped being deterministic, which breaks the duplicate guard.
  const xml2 = formatVouchersXml({ rows: report2.rows, bankLedgerName: bank.name })
  const checksum2 = createHash('sha256').update(xml2).digest('hex')
  check('Second XML bytes are byte-identical to the first', checksum2, checksum)

  // Scope JSON actually holds the ids we asked for.
  const stored = await prisma.tallyExport.findFirst({ where: { companyId: company.id }, select: { scopeJson: true } })
  const storedIds = stored ? (JSON.parse(stored.scopeJson) as string[]) : []
  check('scopeJson preserves 2 statement line ids', storedIds.length, 2)

  await cleanupByName(organisationId)
}

async function main() {
  try { await suite() } finally { await prisma.$disconnect() }
  console.log(`\n${passed} checks passed, ${failures.length} failed`)
  if (failures.length) {
    console.error('\nFAILURES:\n  ' + failures.join('\n  '))
    process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
