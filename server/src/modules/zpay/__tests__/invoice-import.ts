/**
 * Invoice-import tests — parser + upsert + probable-tier proposal.
 *
 * Coverage:
 *   1. parseCsv handles quoted cells, escaped quotes, CRLF, trailing
 *      newlines
 *   2. importInvoicesCsv: valid CSV inserts rows, re-upload updates in
 *      place (idempotent), row-level errors don't abort the batch
 *   3. Missing required columns fails the whole upload
 *   4. Client resolution: client_code hits Client.clientCode; unresolved
 *      code lands a warning without failing the row
 *   5. Dates: ISO YYYY-MM-DD accepted, DD-MM-YYYY normalised, garbage
 *      rejected per-row
 *   6. runProbableForAccount proposes exactly-one-candidate matches,
 *      skips zero-candidate and multi-candidate cases, never touches
 *      manual/exact rows
 *
 * Run: DATABASE_URL=… npx tsx src/modules/zpay/__tests__/invoice-import.ts
 */

import '../../../lib/env.js'
import crypto from 'node:crypto'
import { PrismaClient, Prisma } from '@prisma/client'
import { parseCsv, importInvoicesCsv } from '../invoice-import.js'
import { runProbableForAccount } from '../matcher.js'
import { encryptToken } from '../crypto.js'
import { resetZpayConfigForTests, zpayConfig } from '../config.js'

const prisma = new PrismaClient()

function pass(name: string): void { console.log(`✓ ${name}`) }
function fail(name: string, detail: string): never {
  console.error(`✗ ${name}\n  ${detail}`); process.exit(1)
}

async function fullReset(orgId: string, extraClientCodes: string[]): Promise<void> {
  const conns = await prisma.zpayConnection.findMany({
    where: { organisationId: orgId },
    select: { id: true, accounts: { select: { id: true } } },
  })
  const accIds = conns.flatMap((c) => c.accounts.map((a) => a.id))
  if (accIds.length) {
    await prisma.zpayPayment.deleteMany({ where: { accountRowId: { in: accIds } } })
    await prisma.zpayRefund.deleteMany({ where: { accountRowId: { in: accIds } } })
    await prisma.zpaySyncRun.deleteMany({ where: { accountRowId: { in: accIds } } })
    await prisma.zpayExternalInvoice.deleteMany({ where: { billingAccountId: { in: accIds } } })
    await prisma.zpayAccount.deleteMany({ where: { id: { in: accIds } } })
  }
  if (conns.length) {
    await prisma.zpayConnection.deleteMany({ where: { id: { in: conns.map((c) => c.id) } } })
  }
  if (extraClientCodes.length) {
    await prisma.client.updateMany({
      where: { organisationId: orgId, clientCode: { in: extraClientCodes } },
      data: { billingAccountId: null },
    })
    await prisma.client.deleteMany({
      where: { organisationId: orgId, clientCode: { in: extraClientCodes } },
    })
  }
}

async function main() {
  // ── 1. parseCsv unit ─────────────────────────────────────────────
  {
    const rows = parseCsv('a,b,c\n1,"2, still 2",3\n')
    if (rows.length !== 2) fail('parseCsv row count', `${rows.length}`)
    if (rows[1][1] !== '2, still 2') fail('parseCsv quoted', 'quoted comma not preserved')
    pass('parseCsv handles quoted cells with commas and trailing newlines')

    const escaped = parseCsv('name,note\n"O""Reilly","says ""hi"""\n')
    if (escaped[1][0] !== 'O"Reilly') fail('parseCsv escape', 'quoted "" not unescaped')
    if (escaped[1][1] !== 'says "hi"') fail('parseCsv escape', 'nested quotes wrong')
    pass('parseCsv handles doubled-quote escapes')

    const crlf = parseCsv('a,b\r\n1,2\r\n3,4\r\n')
    if (crlf.length !== 3) fail('parseCsv CRLF', 'CRLF row count wrong')
    pass('parseCsv handles CRLF line endings')
  }

  process.env.ZPAY_MODE = 'fake'
  process.env.ZPAY_CLIENT_ID = 't'
  process.env.ZPAY_CLIENT_SECRET = 't'
  process.env.ZPAY_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64')
  resetZpayConfigForTests()
  const cfg = zpayConfig()

  const md = await prisma.user.findFirstOrThrow({ where: { email: 'ravi@auditos.local' } })
  const orgId = md.organisationId
  await fullReset(orgId, ['FX-INV-CLI-A', 'FX-INV-CLI-B'])

  const conn = await prisma.zpayConnection.create({
    data: {
      organisationId: orgId,
      zohoOrgLabel: 'FIXTURE-invoice-import',
      scopesGranted: [...cfg.scopes],
      status: 'connected',
      refreshTokenEncrypted: encryptToken('fake-refresh', cfg.encryptionKey),
      accessTokenEncrypted: encryptToken('fake-access', cfg.encryptionKey),
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      connectedAt: new Date(),
      connectedBy: md.id,
    },
  })
  const account = await prisma.zpayAccount.create({
    data: {
      connectionId: conn.id,
      accountId: 'fx-inv-gst',
      label: 'GST',
      isGstRegistered: true,
      legalEntityName: 'FIXTURE Legal',
      gstin: '33AAACR5055K1Z1',
      invoiceSeriesPrefix: 'INV/2026/',
    },
  })
  const clientA = await prisma.client.create({
    data: {
      organisationId: orgId,
      clientCode: 'FX-INV-CLI-A',
      companyName: 'FIXTURE Invoice Client Alpha',
      contactPerson: 'Alpha', contactNumber: '9999900011',
      status: 'active', onboardingDate: '2026-04-01', accountManagerId: md.id,
    },
  })

  try {
    // ── 2. Missing required column → 400 ─────────────────────────────
    try {
      await importInvoicesCsv({
        billingAccountId: account.id,
        organisationId: orgId, actorUserId: md.id,
        csv: 'invoice_number,amount\nINV/2026/0001,1000\n',
      })
      fail('missing column', 'accepted a CSV without issued_on')
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('issued_on')) {
        fail('missing column', `wrong error: ${(err as Error).message}`)
      }
      pass('missing required column fails the upload')
    }

    // ── 3. Happy path insert + idempotent update ─────────────────────
    const csv = [
      'invoice_number,issued_on,amount,status,due_date,client_code',
      'INV/2026/0001,2026-09-10,25000,open,,FX-INV-CLI-A',
      'INV/2026/0002,10-09-2026,42000.50,open,,FX-INV-CLI-A',
      'INV/2026/0003,2026-09-11,5000,open,,UNKNOWN-CODE',
      'INV/2026/0004,not-a-date,5000,open,,',
      'INV/2026/0005,2026-09-11,notanumber,open,,',
      ',2026-09-12,1000,open,,',                        // empty invoice_number
      '',                                              // fully-empty row → skipped
    ].join('\n')

    const first = await importInvoicesCsv({
      billingAccountId: account.id,
      organisationId: orgId, actorUserId: md.id, csv,
    })
    if (first.inserted !== 3) fail('insert count', `expected 3, got ${first.inserted}`)
    if (first.errors.length !== 3) fail('errors', `expected 3 errors, got ${first.errors.length}`)
    if (first.warnings.length !== 1) fail('warnings', `expected 1 warning, got ${first.warnings.length}`)
    pass('happy CSV inserts good rows, per-row errors do not abort')

    const stored = await prisma.zpayExternalInvoice.findMany({
      where: { billingAccountId: account.id },
      orderBy: { invoiceNumber: 'asc' },
      select: {
        invoiceNumber: true, amountPaise: true, issuedOn: true,
        status: true, clientId: true,
      },
    })
    if (stored.length !== 3) fail('stored count', `expected 3, got ${stored.length}`)
    const inv1 = stored.find((s) => s.invoiceNumber === 'INV/2026/0001')!
    if (inv1.amountPaise !== 25_000_00) fail('amount 1', `${inv1.amountPaise}`)
    if (inv1.clientId !== clientA.id) fail('client resolution', 'client_code did not resolve')
    const inv2 = stored.find((s) => s.invoiceNumber === 'INV/2026/0002')!
    if (inv2.amountPaise !== 42_000_50) fail('amount 2', `expected 42,00,050, got ${inv2.amountPaise}`)
    if (inv2.issuedOn !== '2026-09-10') fail('date normalise', `DD-MM-YYYY not normalised: ${inv2.issuedOn}`)
    const inv3 = stored.find((s) => s.invoiceNumber === 'INV/2026/0003')!
    if (inv3.clientId !== null) fail('unresolved client', 'should be null')
    pass('amounts are integer paise, DD-MM-YYYY normalised, unresolved client_code → null + warning')

    // Re-run the same CSV — every row should be UPDATED, not INSERTED.
    const second = await importInvoicesCsv({
      billingAccountId: account.id,
      organisationId: orgId, actorUserId: md.id, csv,
    })
    if (second.inserted !== 0) fail('re-import inserted', `expected 0, got ${second.inserted}`)
    if (second.updated !== 3) fail('re-import updated', `expected 3, got ${second.updated}`)
    const afterCount = await prisma.zpayExternalInvoice.count({ where: { billingAccountId: account.id } })
    if (afterCount !== 3) fail('re-import idempotency', `duplicated rows: ${afterCount}`)
    pass('re-uploading the same CSV updates in place — no duplicates')

    // ── 4. Probable-tier proposal ────────────────────────────────────
    const rawEmpty = {} as Prisma.InputJsonValue

    // Payment A: amount matches INV/2026/0001 (25,000), paidAt within window, no reference field
    await prisma.zpayPayment.create({
      data: {
        accountRowId: account.id,
        zohoPaymentId: 'fx-inv-p-single',
        amountPaise: 25_000_00,
        status: 'captured',
        matchType: 'unmatched',
        paidAt: new Date('2026-09-15T10:00:00Z'),
        createdAtZoho: new Date('2026-09-15T10:00:00Z'),
        raw: rawEmpty,
      },
    })
    // Payment B: amount matches ZERO invoices (500)
    await prisma.zpayPayment.create({
      data: {
        accountRowId: account.id,
        zohoPaymentId: 'fx-inv-p-zero',
        amountPaise: 500_00,
        status: 'captured',
        matchType: 'unmatched',
        paidAt: new Date('2026-09-15T10:00:00Z'),
        createdAtZoho: new Date('2026-09-15T10:00:00Z'),
        raw: rawEmpty,
      },
    })
    // Payment C: amount 5000 matches INV/2026/0003 only → single candidate
    await prisma.zpayPayment.create({
      data: {
        accountRowId: account.id,
        zohoPaymentId: 'fx-inv-p-one-no-client',
        amountPaise: 5_000_00,
        status: 'captured',
        matchType: 'unmatched',
        paidAt: new Date('2026-09-15T10:00:00Z'),
        createdAtZoho: new Date('2026-09-15T10:00:00Z'),
        raw: rawEmpty,
      },
    })
    // Add another invoice at 25000 to test multi-candidate case.
    await prisma.zpayExternalInvoice.create({
      data: {
        organisationId: orgId,
        billingAccountId: account.id,
        invoiceNumber: 'INV/2026/0009',
        issuedOn: '2026-09-12',
        amountPaise: 25_000_00,
        status: 'open',
        source: 'csv',
      },
    })
    // Now Payment A has TWO candidates at 25,000 → should not propose.
    // Payment D: fresh single-candidate row we'll insert AFTER we resolve the
    // multi-candidate on Payment A. Skip for now.

    const outcome = await runProbableForAccount(account.id)
    if (outcome.proposed !== 1) fail('proposed count', `expected 1, got ${outcome.proposed}`)

    const singleNoClient = await prisma.zpayPayment.findUniqueOrThrow({
      where: {
        accountRowId_zohoPaymentId: { accountRowId: account.id, zohoPaymentId: 'fx-inv-p-one-no-client' },
      },
    })
    if (singleNoClient.matchType !== 'probable') {
      fail('single candidate', `expected probable, got ${singleNoClient.matchType}`)
    }
    if (singleNoClient.matchedInvoiceRef !== 'INV/2026/0003') {
      fail('single candidate ref', `wrong ref: ${singleNoClient.matchedInvoiceRef}`)
    }
    pass('single-candidate case → matchType=probable with matchedInvoiceRef set')

    const multi = await prisma.zpayPayment.findUniqueOrThrow({
      where: {
        accountRowId_zohoPaymentId: { accountRowId: account.id, zohoPaymentId: 'fx-inv-p-single' },
      },
    })
    if (multi.matchType !== 'unmatched') {
      fail('multi candidate', `expected unmatched, got ${multi.matchType}`)
    }
    pass('multi-candidate case → left unmatched (never auto-confirm ambiguous)')

    const zero = await prisma.zpayPayment.findUniqueOrThrow({
      where: {
        accountRowId_zohoPaymentId: { accountRowId: account.id, zohoPaymentId: 'fx-inv-p-zero' },
      },
    })
    if (zero.matchType !== 'unmatched') fail('zero candidate', `got ${zero.matchType}`)
    pass('zero-candidate case → left unmatched')

    // Manual-match preserve: a `manual` row must not be reclassified.
    await prisma.zpayPayment.updateMany({
      where: { accountRowId: account.id, zohoPaymentId: 'fx-inv-p-zero' },
      data: { matchType: 'manual', matchedInvoiceRef: 'INV/OTHER/9999' },
    })
    await runProbableForAccount(account.id)
    const manualAfter = await prisma.zpayPayment.findUniqueOrThrow({
      where: {
        accountRowId_zohoPaymentId: { accountRowId: account.id, zohoPaymentId: 'fx-inv-p-zero' },
      },
    })
    if (manualAfter.matchType !== 'manual') {
      fail('preserve manual', `probable pass overwrote manual to ${manualAfter.matchType}`)
    }
    pass('runProbableForAccount never touches manual/exact rows')
  } finally {
    await fullReset(orgId, [clientA.clientCode])
    await prisma.$disconnect()
  }

  console.log('\nAll Zoho Payments invoice-import checks passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
