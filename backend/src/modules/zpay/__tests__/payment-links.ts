/**
 * Zoho Payments — the collect-payment step, end to end over the fake:
 * invoice imported → payment link raised → client pays through the link →
 * sync → the payment is matched to the invoice from the link, not from a
 * reference (Zoho doesn't promise one on the payment).
 *
 *   npx tsx src/modules/zpay/__tests__/payment-links.ts
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
import { importInvoicesCsv } from '../invoice-import.js'
import { createPaymentLink, invoicePaymentState } from '../payment-links.js'

const prisma = new PrismaClient()
function pass(name: string): void { console.log(`✓ ${name}`) }
function fail(name: string, detail: string): never { console.error(`✗ ${name}\n  ${detail}`); process.exit(1) }

const LABEL = 'FIXTURE-links'

async function reset(orgId: string) {
  const conns = await prisma.zpayConnection.findMany({ where: { organisationId: orgId, zohoOrgLabel: LABEL }, select: { id: true, accounts: { select: { id: true } } } })
  const ids = conns.flatMap((c) => c.accounts.map((a) => a.id))
  if (ids.length) {
    await prisma.zpayPaymentLink.deleteMany({ where: { accountRowId: { in: ids } } })
    await prisma.zpayExternalInvoice.deleteMany({ where: { billingAccountId: { in: ids } } })
    await prisma.zpayPayment.deleteMany({ where: { accountRowId: { in: ids } } })
    await prisma.zpayRefund.deleteMany({ where: { accountRowId: { in: ids } } })
    await prisma.zpaySyncRun.deleteMany({ where: { accountRowId: { in: ids } } })
    await prisma.zpayAccount.deleteMany({ where: { id: { in: ids } } })
  }
  if (conns.length) await prisma.zpayConnection.deleteMany({ where: { id: { in: conns.map((c) => c.id) } } })
}

async function main() {
  const port = 4610 + Math.floor(Math.random() * 100)
  process.env.ZPAY_MODE = 'fake'
  process.env.ZPAY_CLIENT_ID = 'test-client'
  process.env.ZPAY_CLIENT_SECRET = 'test-secret'
  process.env.ZPAY_ACCOUNTS_BASE = `http://127.0.0.1:${port}/fake-zoho`
  process.env.ZPAY_PAYMENTS_BASE = `http://127.0.0.1:${port}/fake-zoho`
  process.env.ZPAY_REDIRECT_URI = `http://127.0.0.1:${port}/api/zpay/callback`
  process.env.ZPAY_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64')
  resetZpayConfigForTests()

  const app = express()
  app.use(express.urlencoded({ extended: true }))
  app.use('/fake-zoho', createFakeZohoRouter(zpayConfig()))
  const server = createServer(app)
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fake-zoho`

  // Record what reached "Zoho" so the request can be asserted.
  const sent: Array<{ url: string; body: unknown }> = []
  const spy = (async (url: string, init: { method: string; body?: unknown; headers?: Record<string, string> }) => {
    if (url.includes('/paymentlinks') && init.method === 'POST') sent.push({ url, body: JSON.parse(String(init.body)) })
    return fetch(url, init as RequestInit)
  }) as never

  const md = await prisma.user.findFirstOrThrow({ where: { email: 'ravi@auditos.local' } })
  const orgId = md.organisationId
  try {
    await reset(orgId)
    const cfg = zpayConfig()
    const conn = await prisma.zpayConnection.create({
      data: {
        organisationId: orgId, zohoOrgLabel: LABEL, scopesGranted: [...cfg.scopes], status: 'connected',
        refreshTokenEncrypted: encryptToken('fake-refresh-links', cfg.encryptionKey),
        accessTokenEncrypted: encryptToken('fake-access-links', cfg.encryptionKey),
        accessTokenExpiresAt: new Date(Date.now() + 3600_000), connectedAt: new Date(), connectedBy: md.id,
      },
    })
    const account = await prisma.zpayAccount.create({
      data: { connectionId: conn.id, accountId: 'fx-links-gst', label: 'GST', isGstRegistered: true, legalEntityName: 'FIXTURE', gstin: '33AAACR5055K1Z1', invoiceSeriesPrefix: 'INV-LINK-' },
    })
    await importInvoicesCsv({
      billingAccountId: account.id, organisationId: orgId, actorUserId: md.id,
      rows: [['invoice_number', 'issued_on', 'amount'], ['INV-LINK-001', '27-09-2026', '116.00'], ['JNS/2026-27/0012', '27-09-2026', '500']],
    })
    const inv = await prisma.zpayExternalInvoice.findFirstOrThrow({ where: { billingAccountId: account.id, invoiceNumber: 'INV-LINK-001' } })

    // ── 1. Raise a link for what is owed ─────────────────────────────
    const first = await createPaymentLink({ invoiceId: inv.id, organisationId: orgId, userId: md.id, email: 'client@example.com', phone: '+91 98765 43210', notify: { email: true, sms: false }, fetchImpl: spy })
    if (first.reused) fail('create', 'first link reported as reused')
    const body = sent[0]?.body as Record<string, unknown>
    if (!body || body.amount !== 116 || body.currency !== 'INR' || body.reference_id !== 'INV-LINK-001' || body.phone !== '9876543210') fail('create', `sent ${JSON.stringify(body)}`)
    if (JSON.stringify(body.notify_customer) !== JSON.stringify({ email: true, sms: false })) fail('create', `notify ${JSON.stringify(body.notify_customer)}`)
    if (!first.link.url.startsWith('https://') || first.link.status !== 'active' || first.link.amountPaise !== 11600) fail('create', JSON.stringify(first.link))
    pass('payment link raised for the owed amount with the invoice number as reference')

    // ── 2. Asking again (e.g. the invoice re-uploaded) reuses it ─────
    const again = await createPaymentLink({ invoiceId: inv.id, organisationId: orgId, userId: md.id, fetchImpl: spy })
    if (!again.reused || again.link.id !== first.link.id || sent.length !== 1) fail('reuse', `reused=${again.reused} calls=${sent.length}`)
    pass('asking again returns the same active link — no second link in Zoho')

    // ── 3. A reference Zoho won't take is made safe ──────────────────
    const inv2 = await prisma.zpayExternalInvoice.findFirstOrThrow({ where: { billingAccountId: account.id, invoiceNumber: 'JNS/2026-27/0012' } })
    await createPaymentLink({ invoiceId: inv2.id, organisationId: orgId, userId: md.id, fetchImpl: spy })
    if ((sent[1]?.body as Record<string, unknown>).reference_id !== 'JNS-2026-27-0012') fail('reference', JSON.stringify(sent[1]?.body))
    pass('an invoice number with "/" becomes an alphanumeric reference')

    // ── 4. Client pays through the link; sync; matched from the link ─
    const pay = await fetch(`${base}/__test/paymentlinks/${first.link.zohoLinkId}/pay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const { payment_id: paymentId } = (await pay.json()) as { payment_id: string }
    const s = await syncAccount(account.id)
    if (s.status !== 'success') fail('sync', JSON.stringify(s))
    const p = await prisma.zpayPayment.findUniqueOrThrow({ where: { accountRowId_zohoPaymentId: { accountRowId: account.id, zohoPaymentId: paymentId } } })
    if (p.referenceNumber !== null) fail('sync', 'fixture should carry no reference on the link payment')
    if (p.matchType !== 'exact' || p.matchedInvoiceRef !== 'INV-LINK-001') fail('link match', `got ${p.matchType} ${p.matchedInvoiceRef}`)
    pass('a link payment with no reference is matched to its invoice from the link')

    // ── 5. The invoice is paid; no further link ──────────────────────
    const state = await invoicePaymentState(inv.id, orgId)
    if (state.state !== 'paid' || state.owed_paise !== 0 || state.payments.length !== 1 || state.links[0].status !== 'paid') fail('state', JSON.stringify(state))
    let refused = ''
    try { await createPaymentLink({ invoiceId: inv.id, organisationId: orgId, userId: md.id, fetchImpl: spy }) } catch (e) { refused = (e as Error).message }
    if (!/already paid/.test(refused)) fail('paid', `expected refusal, got "${refused}"`)
    pass('the invoice shows paid, and a new link for it is refused')

    // ── 6. Not connected: a clear refusal, no Zoho call ──────────────
    await prisma.zpayConnection.update({ where: { id: conn.id }, data: { status: 'expired' } })
    const calls = sent.length
    try { await createPaymentLink({ invoiceId: inv2.id, organisationId: orgId, userId: md.id, fetchImpl: spy }); fail('not connected', 'expected refusal') } catch (e) {
      if (!/Connect this Zoho Payments account/.test((e as Error).message)) fail('not connected', (e as Error).message)
    }
    if (sent.length !== calls) fail('not connected', 'Zoho was called')
    pass('a disconnected account is refused before calling Zoho')

    console.log('All Zoho Payments payment-link checks passed.')
  } finally {
    await reset(orgId)
    await new Promise<void>((r) => server.close(() => r()))
    await prisma.$disconnect()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
