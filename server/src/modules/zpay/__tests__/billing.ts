/**
 * Billing-slice tests — the client-record card (spec §6.3).
 *
 *   1. currentFinancialYear boundaries at Apr-1 IST
 *   2. setBillingAccount validates the account belongs to the org
 *   3. billingSliceFor returns the right totals for the client's
 *      matched payments in this FY, ignores payments outside FY,
 *      ignores payments belonging to a different client
 *   4. Only matched (exact/manual) payments count — an unmatched
 *      payment does NOT show up on the slice even if it happens to
 *      have matched_client_id set (shouldn't happen, but the query
 *      is explicit)
 *
 * Run: DATABASE_URL=… npx tsx src/modules/zpay/__tests__/billing.ts
 */

import '../../../lib/env.js'
import crypto from 'node:crypto'
import { PrismaClient, Prisma } from '@prisma/client'
import {
  billingSliceFor, currentFinancialYear, setBillingAccount,
} from '../billing.js'
import { encryptToken } from '../crypto.js'
import { resetZpayConfigForTests, zpayConfig } from '../config.js'

const prisma = new PrismaClient()

function pass(name: string): void { console.log(`✓ ${name}`) }
function fail(name: string, detail: string): never {
  console.error(`✗ ${name}\n  ${detail}`); process.exit(1)
}

async function cleanup(orgId: string, ids: { clientIds: string[]; connIds: string[] }): Promise<void> {
  // ZpayPayment / accounts under our fixture connections
  const conns = await prisma.zpayConnection.findMany({
    where: { id: { in: ids.connIds } },
    select: { id: true, accounts: { select: { id: true } } },
  })
  const accIds = conns.flatMap((c) => c.accounts.map((a) => a.id))
  if (accIds.length) {
    await prisma.zpayPayment.deleteMany({ where: { accountRowId: { in: accIds } } })
    await prisma.zpayRefund.deleteMany({ where: { accountRowId: { in: accIds } } })
    await prisma.zpaySyncRun.deleteMany({ where: { accountRowId: { in: accIds } } })
    await prisma.zpayAccount.deleteMany({ where: { id: { in: accIds } } })
  }
  if (ids.connIds.length) {
    await prisma.zpayConnection.deleteMany({ where: { id: { in: ids.connIds } } })
  }
  if (ids.clientIds.length) {
    // Detach billingAccountId (accounts already deleted) and delete the
    // fixture clients.
    await prisma.client.updateMany({
      where: { id: { in: ids.clientIds } },
      data: { billingAccountId: null },
    })
    await prisma.client.deleteMany({ where: { id: { in: ids.clientIds }, organisationId: orgId } })
  }
}

async function main() {
  // ── 1. FY math ───────────────────────────────────────────────────
  {
    const marchFy = currentFinancialYear(new Date('2026-03-15T09:00:00+05:30'))
    if (marchFy.startYear !== 2025) {
      fail('FY March', `expected FY start 2025, got ${marchFy.startYear}`)
    }
    const aprilFy = currentFinancialYear(new Date('2026-04-01T09:00:00+05:30'))
    if (aprilFy.startYear !== 2026) {
      fail('FY April 1 IST', `expected FY start 2026, got ${aprilFy.startYear}`)
    }
    // The IST midnight of April 1 in UTC is 2026-03-31T18:30:00Z. A UTC
    // instant on 2026-03-31T18:30 must land in FY 2026, because in IST
    // that is April 1.
    const boundary = currentFinancialYear(new Date('2026-03-31T18:31:00Z'))
    if (boundary.startYear !== 2026) {
      fail('FY IST boundary', `2026-03-31T18:31Z is 2026-04-01 00:01 IST → should be FY 2026`)
    }
    pass('currentFinancialYear honours IST Apr-1 boundary')
  }

  process.env.ZPAY_MODE = 'fake'
  process.env.ZPAY_CLIENT_ID = 't'
  process.env.ZPAY_CLIENT_SECRET = 't'
  process.env.ZPAY_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64')
  resetZpayConfigForTests()
  const cfg = zpayConfig()

  const md = await prisma.user.findFirstOrThrow({ where: { email: 'ravi@auditos.local' } })
  const orgId = md.organisationId

  // Fixture connection + account.
  const conn = await prisma.zpayConnection.create({
    data: {
      organisationId: orgId,
      zohoOrgLabel: 'FIXTURE-billing',
      scopesGranted: [...cfg.scopes],
      status: 'connected',
      refreshTokenEncrypted: encryptToken('fake-refresh', cfg.encryptionKey),
      accessTokenEncrypted: encryptToken('fake-access', cfg.encryptionKey),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      connectedAt: new Date(),
      connectedBy: md.id,
    },
  })
  const gst = await prisma.zpayAccount.create({
    data: {
      connectionId: conn.id,
      accountId: 'fx-billing-gst',
      label: 'GST',
      isGstRegistered: true,
      legalEntityName: 'FIXTURE Legal',
      gstin: '33AAACR5055K1Z1',
      invoiceSeriesPrefix: 'INV/2026/',
    },
  })
  const nongst = await prisma.zpayAccount.create({
    data: {
      connectionId: conn.id,
      accountId: 'fx-billing-nongst',
      label: 'Non-GST',
      isGstRegistered: false,
      legalEntityName: 'FIXTURE Non-GST',
      gstin: null,
      invoiceSeriesPrefix: 'BOS/2026/',
    },
  })

  // Two fixture clients.
  const alpha = await prisma.client.create({
    data: {
      organisationId: orgId,
      clientCode: 'FX-BILL-ALPHA',
      companyName: 'FIXTURE Alpha Textiles',
      contactPerson: 'Alpha Contact',
      contactNumber: '9999900001',
      status: 'active',
      onboardingDate: '2026-04-01',
      accountManagerId: md.id, // reusing the MD as AM for simplicity
    },
  })
  const beta = await prisma.client.create({
    data: {
      organisationId: orgId,
      clientCode: 'FX-BILL-BETA',
      companyName: 'FIXTURE Beta Chemicals',
      contactPerson: 'Beta Contact',
      contactNumber: '9999900002',
      status: 'active',
      onboardingDate: '2026-04-01',
      accountManagerId: md.id,
    },
  })
  const cleanupIds = {
    clientIds: [alpha.id, beta.id],
    connIds: [conn.id],
  }

  try {
    // ── 2. setBillingAccount validates ownership ─────────────────────
    try {
      await setBillingAccount(alpha.id, orgId, 'not-a-real-account-id', md.id)
      fail('setBillingAccount validation', 'accepted an unknown account id')
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('accountId')) {
        fail('setBillingAccount validation', `wrong error: ${(err as Error).message}`)
      }
      pass('setBillingAccount rejects an accountId outside the org')
    }

    await setBillingAccount(alpha.id, orgId, gst.id, md.id)
    const alphaFresh = await prisma.client.findUniqueOrThrow({ where: { id: alpha.id } })
    if (alphaFresh.billingAccountId !== gst.id) fail('setBillingAccount', 'not persisted')
    pass('setBillingAccount persists a valid mapping')

    // ── 3. Seed payments, exercise billingSliceFor ───────────────────
    const now = new Date()
    const fy = currentFinancialYear(now)

    // Two matched payments to alpha in-FY.
    const p1Date = new Date(fy.from.getTime() + 30 * 86_400_000)
    const p2Date = new Date(fy.from.getTime() + 60 * 86_400_000)
    // One payment to alpha OUTSIDE this FY (in the previous FY window).
    const pPriorDate = new Date(fy.from.getTime() - 30 * 86_400_000)
    // One payment to a DIFFERENT client (beta) in-FY — must not count.
    const pBetaDate = new Date(fy.from.getTime() + 45 * 86_400_000)
    // One UNMATCHED payment to alpha in-FY — must not count.
    const pUnmatchedDate = new Date(fy.from.getTime() + 15 * 86_400_000)

    const rawEmpty = {} as Prisma.InputJsonValue

    await prisma.zpayPayment.createMany({
      data: [
        {
          accountRowId: gst.id,
          zohoPaymentId: 'fx-bill-p1',
          amountPaise: 25_000_00,
          status: 'captured',
          matchType: 'manual',
          matchedInvoiceRef: 'INV/2026/0412',
          matchedClientId: alpha.id,
          paidAt: p1Date, createdAtZoho: p1Date, raw: rawEmpty,
        },
        {
          accountRowId: gst.id,
          zohoPaymentId: 'fx-bill-p2',
          amountPaise: 42_000_00,
          status: 'captured',
          matchType: 'exact',
          matchedInvoiceRef: 'INV/2026/0413',
          matchedClientId: alpha.id,
          paidAt: p2Date, createdAtZoho: p2Date, raw: rawEmpty,
        },
        {
          accountRowId: gst.id,
          zohoPaymentId: 'fx-bill-prior',
          amountPaise: 999_000_00,
          status: 'captured',
          matchType: 'exact',
          matchedInvoiceRef: 'INV/2025/9999',
          matchedClientId: alpha.id,
          paidAt: pPriorDate, createdAtZoho: pPriorDate, raw: rawEmpty,
        },
        {
          accountRowId: gst.id,
          zohoPaymentId: 'fx-bill-beta',
          amountPaise: 33_000_00,
          status: 'captured',
          matchType: 'exact',
          matchedInvoiceRef: 'INV/2026/0500',
          matchedClientId: beta.id,
          paidAt: pBetaDate, createdAtZoho: pBetaDate, raw: rawEmpty,
        },
        {
          accountRowId: gst.id,
          zohoPaymentId: 'fx-bill-un',
          amountPaise: 100_000_00,
          status: 'captured',
          matchType: 'unmatched',
          matchedClientId: alpha.id, // shouldn't happen in practice
          paidAt: pUnmatchedDate, createdAtZoho: pUnmatchedDate, raw: rawEmpty,
        },
      ],
    })

    // ── 4. Slice math ────────────────────────────────────────────────
    const slice = await billingSliceFor(alpha.id, orgId)
    if (!slice.billingAccount || slice.billingAccount.id !== gst.id) {
      fail('slice billed-from', `expected GST account, got ${slice.billingAccount?.id}`)
    }
    if (slice.paidThisFyPaise !== 67_000_00) {
      fail('slice paid FY', `expected 67,00,000 paise, got ${slice.paidThisFyPaise}`)
    }
    if (slice.paymentCountThisFy !== 2) {
      fail('slice count', `expected 2 payments, got ${slice.paymentCountThisFy}`)
    }
    if (!slice.lastPayment) fail('slice last payment', 'expected a last payment')
    if (slice.lastPayment.amountPaise !== 42_000_00) {
      fail('slice last payment amount', `wrong amount: ${slice.lastPayment.amountPaise}`)
    }
    if (slice.lastPayment.matchedInvoiceRef !== 'INV/2026/0413') {
      fail('slice last payment ref', `wrong ref: ${slice.lastPayment.matchedInvoiceRef}`)
    }
    pass('billingSliceFor sums matched-only, in-FY, this-client payments only')

    if (slice.outstandingPaise !== null || slice.oldestOpenInvoice !== null) {
      fail('slice invoice placeholders', 'outstanding/oldest should be null placeholders')
    }
    pass('outstanding & oldest-open-invoice are explicit nulls until an invoice source lands')

    // Beta client has one payment in-FY (matched) and shouldn't leak alpha's rows.
    const betaSlice = await billingSliceFor(beta.id, orgId)
    if (betaSlice.paidThisFyPaise !== 33_000_00) {
      fail('beta slice', `expected 33,00,000 paise, got ${betaSlice.paidThisFyPaise}`)
    }
    if (betaSlice.billingAccount !== null) fail('beta billed-from', 'should be null')
    pass('per-client isolation — one client\'s payments do not leak into another\'s slice')

    // ── 5. Clearing the billing account ──────────────────────────────
    await setBillingAccount(alpha.id, orgId, null, md.id)
    const cleared = await billingSliceFor(alpha.id, orgId)
    if (cleared.billingAccount !== null) fail('clear', 'billing account not cleared')
    // Payments still sum — clearing billed-from does not un-match past
    // payments (those keep their matchedClientId).
    if (cleared.paidThisFyPaise !== 67_000_00) {
      fail('clear FY sum', 'clearing billed-from should not affect past matches')
    }
    pass('setBillingAccount(null) clears billed-from without touching prior matches')
  } finally {
    await cleanup(orgId, cleanupIds)
    await prisma.$disconnect()
  }

  console.log('\nAll Zoho Payments billing-slice checks passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
