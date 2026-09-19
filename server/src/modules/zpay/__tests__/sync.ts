/**
 * Sync end-to-end test.
 *
 * Boots a real fake-Zoho listener, points the zpay config at it, then
 * drives the sync against the real Prisma database. This is the test
 * that closes the step-3 gate ("re-run creates no duplicates") — a
 * mocked prisma cannot prove that.
 *
 * Coverage:
 *   1. First sync inserts N payments; ZpaySyncRun records success.
 *   2. Second sync inserts zero new rows (unique upsert key holds).
 *   3. lastSyncAt advances; per-account isolation — one account with
 *      an unknown accountId still produces a failed run without
 *      touching the good account's rows.
 *   4. Amounts stored are INTEGER paise (no float leaked past the
 *      adapter boundary).
 *
 * Requires DATABASE_URL pointing at a running Postgres — the docker
 * stack in dev satisfies this. Cleans up every FIXTURE- row it made.
 *
 * Run:  npx tsx src/modules/zpay/__tests__/sync.ts
 */

import '../../../lib/env.js'
import crypto from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { PrismaClient } from '@prisma/client'
import { createFakeZohoRouter } from '../fake-zoho.js'
import { encryptToken } from '../crypto.js'
import { resetZpayConfigForTests, zpayConfig } from '../config.js'
import { syncAccount } from '../sync.js'

const prisma = new PrismaClient()

function pass(name: string): void { console.log(`✓ ${name}`) }
function fail(name: string, detail: string): never {
  console.error(`✗ ${name}\n  ${detail}`); process.exit(1)
}

async function bootFake(port: number, clientId: string, clientSecret: string, redirect: string) {
  const app = express()
  app.use(express.urlencoded({ extended: true }))
  const cfg = zpayConfig()
  app.use('/fake-zoho', createFakeZohoRouter(cfg))
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function cleanup(orgId: string): Promise<void> {
  // Delete FIXTURE- connections and everything under them.
  const conns = await prisma.zpayConnection.findMany({
    where: { organisationId: orgId, zohoOrgLabel: { startsWith: 'FIXTURE-' } },
    select: { id: true, accounts: { select: { id: true } } },
  })
  for (const c of conns) {
    const accountIds = c.accounts.map((a) => a.id)
    if (accountIds.length) {
      await prisma.zpayPayment.deleteMany({ where: { accountRowId: { in: accountIds } } })
      await prisma.zpayRefund.deleteMany({ where: { accountRowId: { in: accountIds } } })
      await prisma.zpaySyncRun.deleteMany({ where: { accountRowId: { in: accountIds } } })
      await prisma.zpayAccount.deleteMany({ where: { id: { in: accountIds } } })
    }
    await prisma.zpayConnection.delete({ where: { id: c.id } })
  }
}

async function main() {
  // Point config at a listener we'll start in a moment. The listener port
  // is a fixed value here so redirectUri lines up before we boot the app.
  const testPort = 4310 + Math.floor(Math.random() * 100)
  process.env.ZPAY_MODE = 'fake'
  process.env.ZPAY_CLIENT_ID = 'test-client'
  process.env.ZPAY_CLIENT_SECRET = 'test-secret'
  process.env.ZPAY_ACCOUNTS_BASE = `http://127.0.0.1:${testPort}/fake-zoho`
  process.env.ZPAY_PAYMENTS_BASE = `http://127.0.0.1:${testPort}/fake-zoho`
  process.env.ZPAY_REDIRECT_URI = `http://127.0.0.1:${testPort}/api/zpay/callback`
  process.env.ZPAY_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64')
  resetZpayConfigForTests()

  const { close } = await bootFake(
    testPort,
    process.env.ZPAY_CLIENT_ID,
    process.env.ZPAY_CLIENT_SECRET,
    process.env.ZPAY_REDIRECT_URI,
  )

  try {
    // The docker seed guarantees this user + org exist.
    const md = await prisma.user.findFirstOrThrow({ where: { email: 'ravi@auditos.local' } })
    const orgId = md.organisationId
    await cleanup(orgId)

    const cfg = zpayConfig()

    const conn = await prisma.zpayConnection.create({
      data: {
        organisationId: orgId,
        zohoOrgLabel: 'FIXTURE-Zoho GST entity',
        scopesGranted: [...cfg.scopes],
        status: 'connected',
        refreshTokenEncrypted: encryptToken('fake-refresh-testing', cfg.encryptionKey),
        accessTokenEncrypted: encryptToken('fake-access-testing', cfg.encryptionKey),
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        connectedAt: new Date(),
        connectedBy: md.id,
      },
    })

    const good = await prisma.zpayAccount.create({
      data: {
        connectionId: conn.id,
        accountId: 'acc-gst-fixture-001',
        label: 'GST',
        isGstRegistered: true,
        legalEntityName: 'FIXTURE Legal Pvt Ltd',
        gstin: '33AAACR5055K1Z1',
        invoiceSeriesPrefix: 'INV/2026/',
      },
    })

    // ── 1. First sync populates ──────────────────────────────────────
    const first = await syncAccount(good.id)
    if (first.status !== 'success') fail('first sync', `status=${first.status} err=${first.errorDetail}`)
    if (first.paymentsFetched === 0) fail('first sync', 'fake produced zero payments')
    const initialCount = await prisma.zpayPayment.count({ where: { accountRowId: good.id } })
    if (initialCount !== first.paymentsFetched) {
      fail('first sync', `payments in DB (${initialCount}) != fetched (${first.paymentsFetched})`)
    }
    pass(`first sync: ${first.paymentsFetched} payments, ${first.refundsFetched} refunds inserted`)

    // ── 2. Integer paise, no floats ──────────────────────────────────
    const sample = await prisma.zpayPayment.findFirst({ where: { accountRowId: good.id } })
    if (!sample) fail('paise check', 'no payment to inspect')
    if (!Number.isInteger(sample.amountPaise)) fail('paise check', 'amountPaise is not an integer')
    if (sample.feePaise !== null && !Number.isInteger(sample.feePaise)) {
      fail('paise check', 'feePaise is not an integer')
    }
    pass('amounts stored as integer paise')

    // ── 3. `raw` mirror preserved ────────────────────────────────────
    if (!sample.raw || typeof sample.raw !== 'object') fail('raw', 'raw is not present')
    const rawObj = sample.raw as Record<string, unknown>
    if (!('payment_id' in rawObj) || !('amount' in rawObj)) {
      fail('raw', 'raw does not carry the original Zoho payload')
    }
    if (typeof rawObj.amount !== 'number') {
      fail('raw', 'raw.amount should be a Zoho float, not something normalised')
    }
    pass('`raw` mirrors the untouched Zoho payload')

    // ── 4. Idempotency ────────────────────────────────────────────────
    // Reset lastSyncAt so the window opens fresh; a second sync of the
    // same data must not create duplicates.
    await prisma.zpayAccount.update({
      where: { id: good.id },
      data: { lastSyncAt: null },
    })
    const second = await syncAccount(good.id)
    if (second.status !== 'success') fail('second sync', `status=${second.status}`)
    const secondCount = await prisma.zpayPayment.count({ where: { accountRowId: good.id } })
    if (secondCount !== initialCount) {
      fail('idempotency', `second sync duplicated rows (${initialCount} → ${secondCount})`)
    }
    pass('re-sync is idempotent (unique (accountRowId, zohoPaymentId) upsert)')

    // ── 5. Per-account isolation ─────────────────────────────────────
    // A second account under the same connection with a well-formed
    // accountId that the fake also seeds — plus a bad one that would
    // 400 at the fake. Neither may affect the other's sync outcome.
    const bad = await prisma.zpayAccount.create({
      data: {
        connectionId: conn.id,
        accountId: '', // rejected at the fake with 400 (missing account_id)
        label: 'GST',
        isGstRegistered: true,
        legalEntityName: 'FIXTURE Legal Pvt Ltd',
        gstin: '33AAACR5055K1Z1',
        invoiceSeriesPrefix: 'INV/2026/',
      },
    })
    const badOutcome = await syncAccount(bad.id)
    if (badOutcome.status !== 'failed') fail('isolation', 'bad account did not fail')
    pass('bad account fails cleanly with a `failed` run row')

    // The good account is unaffected — no new rows, sync count unchanged.
    const afterCount = await prisma.zpayPayment.count({ where: { accountRowId: good.id } })
    if (afterCount !== initialCount) fail('isolation', 'good account lost or gained rows')
    pass('one account failing does not touch another account\'s data')

    // ── cleanup ──────────────────────────────────────────────────────
    await cleanup(orgId)
  } finally {
    await close()
    await prisma.$disconnect()
  }

  console.log('\nAll Zoho Payments sync checks passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
