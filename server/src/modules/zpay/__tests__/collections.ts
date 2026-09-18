/**
 * Collections aggregate test.
 *
 * Runs against the real Prisma database — parsePeriod is pure but the
 * whole point of collectionsAggregate is that it returns numbers pulled
 * from a live schema, so the math is only meaningful with actual rows.
 *
 * Coverage:
 *   1. parsePeriod: 'YYYY-MM' → UTC month bounds, default is now-month
 *   2. Sums add up: seed 3 payments (one matched, two unmatched, one
 *      refund) into a FIXTURE- connection and confirm the tiles match
 *   3. Entity filter: gst returns only GST-registered accounts
 *   4. Period filter: a payment paidAt just outside the window is not
 *      counted
 *
 * Run: DATABASE_URL=… npx tsx src/modules/zpay/__tests__/collections.ts
 */

import '../../../lib/env.js'
import crypto from 'node:crypto'
import { PrismaClient, Prisma } from '@prisma/client'
import { collectionsAggregate, parsePeriod } from '../collections.js'
import { encryptToken } from '../crypto.js'
import { resetZpayConfigForTests, zpayConfig } from '../config.js'

const prisma = new PrismaClient()

function pass(name: string): void { console.log(`✓ ${name}`) }
function fail(name: string, detail: string): never {
  console.error(`✗ ${name}\n  ${detail}`); process.exit(1)
}

/**
 * This test asserts absolute sums, so it can only trust results if the
 * org's zpay tables are empty going in. In a dev DB where the UI or
 * previous tests have left rows, we clear everything under this org
 * first — collectionsAggregate joins on organisationId, so anything
 * left over would pollute the aggregate.
 */
async function fullReset(orgId: string): Promise<void> {
  const conns = await prisma.zpayConnection.findMany({
    where: { organisationId: orgId },
    select: { id: true, accounts: { select: { id: true } } },
  })
  const accountIds = conns.flatMap((c) => c.accounts.map((a) => a.id))
  if (accountIds.length) {
    await prisma.zpayPayment.deleteMany({ where: { accountRowId: { in: accountIds } } })
    await prisma.zpayRefund.deleteMany({ where: { accountRowId: { in: accountIds } } })
    await prisma.zpaySyncRun.deleteMany({ where: { accountRowId: { in: accountIds } } })
    await prisma.zpayAccount.deleteMany({ where: { id: { in: accountIds } } })
  }
  if (conns.length) {
    await prisma.zpayConnection.deleteMany({ where: { id: { in: conns.map((c) => c.id) } } })
  }
}

async function main() {
  // Pure period parsing first — no DB.
  {
    const p = parsePeriod('2026-09')
    if (p.yearMonth !== '2026-09') fail('parsePeriod', 'yearMonth wrong')
    if (p.from.toISOString() !== '2026-09-01T00:00:00.000Z') {
      fail('parsePeriod', `from wrong: ${p.from.toISOString()}`)
    }
    if (p.to.toISOString() !== '2026-10-01T00:00:00.000Z') {
      fail('parsePeriod', `to wrong: ${p.to.toISOString()}`)
    }
    pass('parsePeriod parses YYYY-MM to UTC month bounds')

    const now = parsePeriod(undefined)
    const today = new Date()
    const ym = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`
    if (now.yearMonth !== ym) fail('parsePeriod default', 'expected current month')
    pass('parsePeriod defaults to current UTC month')

    const bad = parsePeriod('not-a-period')
    if (bad.yearMonth !== ym) fail('parsePeriod bad', 'invalid input should fall back to now')
    pass('parsePeriod tolerates junk and falls back to now')
  }

  // Config needed for encrypting tokens on the fixture connection.
  process.env.ZPAY_MODE = 'fake'
  process.env.ZPAY_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64')
  resetZpayConfigForTests()
  const cfg = zpayConfig()

  const md = await prisma.user.findFirstOrThrow({ where: { email: 'ravi@auditos.local' } })
  const orgId = md.organisationId
  await fullReset(orgId)

  const conn = await prisma.zpayConnection.create({
    data: {
      organisationId: orgId,
      zohoOrgLabel: 'FIXTURE-collections-one',
      scopesGranted: [...cfg.scopes],
      status: 'connected',
      refreshTokenEncrypted: encryptToken('fake-refresh', cfg.encryptionKey),
      accessTokenEncrypted: encryptToken('fake-access', cfg.encryptionKey),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      connectedAt: new Date(),
      connectedBy: md.id,
    },
  })

  const accGst = await prisma.zpayAccount.create({
    data: {
      connectionId: conn.id,
      accountId: 'fx-gst-collections',
      label: 'GST',
      isGstRegistered: true,
      legalEntityName: 'FIXTURE Legal',
      gstin: '33AAACR5055K1Z1',
      invoiceSeriesPrefix: 'INV/2026/',
      lastSyncAt: new Date('2026-09-10T10:00:00Z'),
      lastSyncStatus: 'success',
    },
  })
  const accNonGst = await prisma.zpayAccount.create({
    data: {
      connectionId: conn.id,
      accountId: 'fx-nongst-collections',
      label: 'Non-GST',
      isGstRegistered: false,
      legalEntityName: 'FIXTURE Legal 2',
      gstin: null,
      invoiceSeriesPrefix: 'BOS/2026/',
      lastSyncAt: new Date('2026-09-10T10:00:00Z'),
      lastSyncStatus: 'success',
    },
  })

  const period = parsePeriod('2026-09')
  const inMonth = new Date('2026-09-15T10:00:00Z')
  const alsoInMonth = new Date('2026-09-20T10:00:00Z')
  const priorMonth = new Date('2026-08-30T10:00:00Z')

  // Three payments on the GST account: two matched (exact + manual),
  // one unmatched. One in-window on the Non-GST account. One PRIOR
  // month on the GST account which must NOT count.
  const rawEmpty = {} as Prisma.InputJsonValue

  await prisma.zpayPayment.create({
    data: {
      accountRowId: accGst.id,
      zohoPaymentId: 'fx-p1',
      amountPaise: 25_000_00,
      status: 'captured',
      matchType: 'exact',
      matchedInvoiceRef: 'INV/2026/0412',
      paidAt: inMonth,
      createdAtZoho: inMonth,
      raw: rawEmpty,
    },
  })
  await prisma.zpayPayment.create({
    data: {
      accountRowId: accGst.id,
      zohoPaymentId: 'fx-p2',
      amountPaise: 15_000_00,
      status: 'captured',
      matchType: 'manual',
      matchedInvoiceRef: 'INV/2026/0413',
      paidAt: inMonth,
      createdAtZoho: inMonth,
      raw: rawEmpty,
    },
  })
  await prisma.zpayPayment.create({
    data: {
      accountRowId: accGst.id,
      zohoPaymentId: 'fx-p3',
      amountPaise: 8_000_00,
      status: 'captured',
      matchType: 'unmatched',
      paidAt: alsoInMonth,
      createdAtZoho: alsoInMonth,
      raw: rawEmpty,
    },
  })
  await prisma.zpayPayment.create({
    data: {
      accountRowId: accNonGst.id,
      zohoPaymentId: 'fx-p4',
      amountPaise: 5_000_00,
      status: 'captured',
      matchType: 'unmatched',
      paidAt: inMonth,
      createdAtZoho: inMonth,
      raw: rawEmpty,
    },
  })
  await prisma.zpayPayment.create({
    data: {
      accountRowId: accGst.id,
      zohoPaymentId: 'fx-p-prior',
      amountPaise: 999_000_00,
      status: 'captured',
      matchType: 'exact',
      paidAt: priorMonth,
      createdAtZoho: priorMonth,
      raw: rawEmpty,
    },
  })
  await prisma.zpayRefund.create({
    data: {
      accountRowId: accGst.id,
      zohoRefundId: 'fx-r1',
      zohoPaymentId: 'fx-p1',
      amountPaise: 1_200_00,
      status: 'processed',
      refundedAt: inMonth,
      raw: rawEmpty,
    },
  })

  // ── entity=all ────────────────────────────────────────────────────
  const all = await collectionsAggregate(orgId, 'all', period)
  // Collected: p1 + p2 + p3 + p4 = 53_000_00; prior excluded.
  if (all.collected.amountPaise !== 53_000_00) {
    fail('all collected', `expected 53,00,000 paise, got ${all.collected.amountPaise}`)
  }
  if (all.collected.count !== 4) fail('all collected count', `expected 4, got ${all.collected.count}`)
  // Matched: p1 (exact) + p2 (manual) = 40_000_00.
  if (all.matched.amountPaise !== 40_000_00) {
    fail('all matched', `expected 40,00,000 paise, got ${all.matched.amountPaise}`)
  }
  // Unmatched: p3 + p4 = 13_000_00.
  if (all.unmatched.amountPaise !== 13_000_00) {
    fail('all unmatched', `expected 13,00,000 paise, got ${all.unmatched.amountPaise}`)
  }
  if (all.refunded.amountPaise !== 1_200_00) fail('refunded', `${all.refunded.amountPaise}`)
  if (all.accounts.length !== 2) fail('all accounts', `expected 2 accounts, got ${all.accounts.length}`)
  pass('entity=all: tiles + per-account breakdown match seed')

  // ── entity=gst ────────────────────────────────────────────────────
  const gst = await collectionsAggregate(orgId, 'gst', period)
  // p1 + p2 + p3 = 48_000_00. p4 (non-GST) excluded.
  if (gst.collected.amountPaise !== 48_000_00) {
    fail('gst collected', `expected 48,00,000 paise, got ${gst.collected.amountPaise}`)
  }
  if (gst.accounts.length !== 1) fail('gst accounts', `expected only the GST account`)
  pass('entity=gst: excludes the non-GST account and its payment')

  // ── entity=non-gst ────────────────────────────────────────────────
  const nonGst = await collectionsAggregate(orgId, 'non-gst', period)
  if (nonGst.collected.amountPaise !== 5_000_00) {
    fail('non-gst collected', `expected 5,00,000 paise, got ${nonGst.collected.amountPaise}`)
  }
  if (nonGst.unmatched.count !== 1) fail('non-gst unmatched', `expected 1, got ${nonGst.unmatched.count}`)
  pass('entity=non-gst: only sees the Non-GST account')

  // ── prior month is NOT included ───────────────────────────────────
  const prior = await collectionsAggregate(orgId, 'all', parsePeriod('2026-08'))
  if (prior.collected.amountPaise !== 999_000_00) {
    fail('prior month', `expected only the prior-month payment, got ${prior.collected.amountPaise}`)
  }
  pass('period=2026-08: only prior-month payment counted')

  await fullReset(orgId)
  await prisma.$disconnect()
  console.log('\nAll Zoho Payments collections checks passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
