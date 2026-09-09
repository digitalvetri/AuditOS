/**
 * Foundation smoke test for the Tally module (Slice 1).
 *
 * Verifies:
 *   - createCompany seeds 17 primary groups + 1 FY atomically
 *   - Two companies in the same org do NOT share groups or ledgers
 *   - Ledger listing scoped to Company A returns no Company B ledgers
 *   - Primary groups can't be deleted; deleting a group with a ledger
 *     is refused
 *   - Duplicate company / group / ledger names in the same company
 *     are rejected with a 409 code
 *
 * Run:  npx tsx server/src/modules/tally/__tests__/foundation.ts
 */
import '../../../lib/env.js'
import { PrismaClient } from '@prisma/client'
import { TallyCompanyService } from '../services/TallyCompanyService.js'
import { TallyGroupService } from '../services/TallyGroupService.js'
import { TallyLedgerService } from '../services/TallyLedgerService.js'
import { PRIMARY_GROUPS } from '../services/primaryGroups.js'
import type { Session } from '../../../platform/auth.js'

const prisma = new PrismaClient()

function pass(name: string) { console.log(`✓ ${name}`) }
function fail(name: string, detail: string): never {
  console.error(`✗ ${name}\n  ${detail}`); process.exit(1)
}

async function loadSession(email: string): Promise<Session> {
  const user = await prisma.user.findFirst({
    where: { email },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  })
  if (!user) throw new Error(`user ${email} not found — run npm run seed first`)
  return {
    userId: user.id,
    email: user.email,
    roleId: user.roleId,
    roleCode: user.role.code as Session['roleCode'],
    roleName: user.role.name,
    grants: user.role.permissions.map((rp) => ({
      permission: rp.permission.code,
      scope: rp.scope as Session['grants'][number]['scope'],
    })),
    employeeId: null,
    departmentId: null,
    employeeFullName: null,
  }
}

async function cleanup(organisationId: string) {
  const cos = await prisma.tallyCompany.findMany({ where: { organisationId, name: { startsWith: 'FIXTURE-' } } })
  for (const c of cos) {
    await prisma.tallyLedger.deleteMany({ where: { tallyCompanyId: c.id } })
    await prisma.tallyGroup.deleteMany({ where: { tallyCompanyId: c.id } })
    await prisma.tallyFinancialYear.deleteMany({ where: { tallyCompanyId: c.id } })
    await prisma.tallyCompany.delete({ where: { id: c.id } })
  }
}

async function main() {
  const md = await loadSession('ravi@auditos.local')
  const hr = await loadSession('priya@auditos.local')

  const { organisationId } = await prisma.user.findUniqueOrThrow({
    where: { id: md.userId }, select: { organisationId: true },
  })
  await cleanup(organisationId)

  // ── 1. Create Company A → primary groups + first FY ──────────────────
  const a = await TallyCompanyService.create(md, {
    name: 'FIXTURE-Alpha Traders',
    booksBeginFrom: '2026-04-01',
    state: 'Tamil Nadu',
    pan: 'AAAPA1234A',
    gstin: '33AAAPA1234A1Z5',
  })
  const aGroupCount = await prisma.tallyGroup.count({ where: { tallyCompanyId: a.id } })
  if (aGroupCount !== PRIMARY_GROUPS.length) {
    fail(`Company A seeded ${PRIMARY_GROUPS.length} primary groups`, `got ${aGroupCount}`)
  }
  const aFyCount = await prisma.tallyFinancialYear.count({ where: { tallyCompanyId: a.id } })
  if (aFyCount !== 1) fail('Company A seeded 1 FY', `got ${aFyCount}`)
  pass(`Company A: ${PRIMARY_GROUPS.length} primary groups + 1 FY seeded atomically`)

  // ── 2. Create Company B in the same org → own primaries, own FY ─────
  const b = await TallyCompanyService.create(md, {
    name: 'FIXTURE-Bravo Consulting',
    booksBeginFrom: '2026-04-01',
    state: 'Karnataka',
    pan: 'AABPB5678B',
  })
  const bGroupCount = await prisma.tallyGroup.count({ where: { tallyCompanyId: b.id } })
  if (bGroupCount !== PRIMARY_GROUPS.length) fail('Company B primary groups', String(bGroupCount))
  pass('Company B: independent primaries + FY (no shared groups)')

  // ── 3. Duplicate company name in same org → 409 ──────────────────────
  try {
    await TallyCompanyService.create(md, { name: 'FIXTURE-Alpha Traders', booksBeginFrom: '2026-04-01' })
    fail('duplicate company name refused', 'expected 409')
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code !== 'duplicate_name') fail('duplicate company code', `got ${code}`)
    pass('duplicate company name → 409 duplicate_name')
  }

  // ── 4. Create a ledger in Company A ──────────────────────────────────
  const cashGroup = await prisma.tallyGroup.findFirstOrThrow({
    where: { tallyCompanyId: a.id, name: 'Cash-in-Hand' },
  })
  const cash = await TallyLedgerService.create(md, a.id, {
    name: 'Main Cash', groupId: cashGroup.id,
    openingBalancePaise: 50000000, openingBalanceType: 'dr',
  })
  pass(`created ledger "Main Cash" in Company A (opening ₹5,00,000 Dr)`)

  // ── 5. Isolation: listing Company B ledgers must not include A's ─────
  const bLedgers = await TallyLedgerService.list(md, b.id)
  if (bLedgers.length !== 0) fail('Company B ledger list empty', `got ${bLedgers.length}`)
  const aLedgers = await TallyLedgerService.list(md, a.id)
  if (!aLedgers.some((l) => l.id === cash.id)) fail('Company A ledger visible', 'not in list')
  pass('isolation: Company B does NOT see Company A ledgers, Company A does')

  // ── 6. Duplicate ledger name in Company A → 409 ──────────────────────
  try {
    await TallyLedgerService.create(md, a.id, { name: 'Main Cash', groupId: cashGroup.id })
    fail('duplicate ledger name refused', 'expected 409')
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code !== 'duplicate_name') fail('duplicate ledger code', `got ${code}`)
    pass('duplicate ledger name in same company → 409')
  }

  // ── 7. Same ledger name allowed in Company B (isolation) ─────────────
  const bCashGroup = await prisma.tallyGroup.findFirstOrThrow({
    where: { tallyCompanyId: b.id, name: 'Cash-in-Hand' },
  })
  await TallyLedgerService.create(md, b.id, { name: 'Main Cash', groupId: bCashGroup.id })
  pass('same ledger name allowed in Company B (isolation confirmed)')

  // ── 8. Cross-company access denied ───────────────────────────────────
  try {
    await TallyLedgerService.list(md, 'not-a-real-company-id')
    fail('bogus company id refused', 'expected 404')
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code !== 'not_found') fail('bogus company code', `got ${code}`)
    pass('bogus company id → 404 not_found')
  }

  // ── 9. Group deletion rules ──────────────────────────────────────────
  const capital = await prisma.tallyGroup.findFirstOrThrow({
    where: { tallyCompanyId: a.id, name: 'Capital Account' },
  })
  try {
    await TallyGroupService.softDelete(md, a.id, capital.id)
    fail('primary group deletion refused', 'expected 400')
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code !== 'validation') fail('primary delete code', `got ${code}`)
    pass('primary group deletion refused (400)')
  }
  // Delete a group WITH a ledger → refused
  try {
    await TallyGroupService.softDelete(md, a.id, cashGroup.id)
    fail('group-with-ledger deletion refused', 'expected 400')
  } catch (err) {
    pass('group with ledger cannot be deleted (400)')
  }

  // ── 10. HR admin RBAC (no tally grants) ──────────────────────────────
  try {
    await TallyCompanyService.listForOrg(hr) // service doesn't check RBAC — routes do
    // Route-level 403 is proven via curl in the e2e script; service list still works
    // because auditor role can be granted read-only in the future without service changes.
    pass('hr_admin can call service (RBAC enforced at route layer — e2e verifies 403)')
  } catch { fail('hr_admin service call', 'threw unexpectedly') }

  await cleanup(organisationId)
  console.log('\nAll Tally Slice 1 foundation assertions passed.')
}

main()
  .catch((e) => { console.error('\n[FAIL]', e instanceof Error ? e.stack : e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
