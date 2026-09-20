/**
 * Zoho Payments HTTP surface — step 2: OAuth only.
 *
 * Two routers:
 *
 *   zpayRouter        authenticated; requires `accounts.manage` at
 *                     organisation scope (spec §1: connect action lives in
 *                     Settings under a finance permission).
 *
 *   zpayCallbackRouter  public; the callback is a browser redirect from
 *                       accounts.zoho.in. The signed `state` param carries
 *                       everything the endpoint needs, so no session cookie
 *                       is required.
 *
 * The routes deliberately do the token exchange synchronously inside the
 * callback handler — per spec §1 the authorization code is valid for one
 * minute, and a queue between callback and exchange throws that window
 * away.
 */
import { Router } from 'express'
import multer from 'multer'
import { ApiError, handler, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { requireSession, requirePermission } from '../../platform/auth.js'
import { beginConsent, completeConsent } from './service.js'
import { syncAccount, syncConnection } from './sync.js'
import { collectionsAggregate, parsePeriod } from './collections.js'
import { manuallyMatch, unmatch } from './matching-service.js'
import { billingSliceFor, setBillingAccount } from './billing.js'
import { importInvoicesCsv } from './invoice-import.js'
import { runProbableForAccount } from './matcher.js'

export const zpayRouter = Router()

zpayRouter.use(requirePermission('accounts.manage', 'organisation'))

const MAX_CSV_MB = 5
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CSV_MB * 1024 * 1024, files: 1 },
})

// POST /api/zpay/connections
zpayRouter.post('/connections', handler(async (req, res) => {
  const session = requireSession(req)
  const body = (req.body ?? {}) as { zohoOrgLabel?: unknown }
  if (typeof body.zohoOrgLabel !== 'string' || body.zohoOrgLabel.trim().length === 0) {
    throw ApiError.badRequest('zohoOrgLabel is required.')
  }
  const orgId = await orgIdFor(session.userId)
  const created = await prisma.zpayConnection.create({
    data: {
      organisationId: orgId,
      zohoOrgLabel: body.zohoOrgLabel.trim(),
      scopesGranted: [],
      status: 'not_connected',
      createdBy: session.userId,
      updatedBy: session.userId,
    },
    select: { id: true, zohoOrgLabel: true, status: true, createdAt: true },
  })
  ok(res, created, 201)
}))

// GET /api/zpay/connections
zpayRouter.get('/connections', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const rows = await prisma.zpayConnection.findMany({
    where: { organisationId: orgId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, zohoOrgLabel: true, status: true, connectedAt: true,
      lastErrorCode: true, lastErrorAt: true, scopesGranted: true,
      accounts: {
        where: { deletedAt: null },
        select: {
          id: true, accountId: true, label: true, isGstRegistered: true,
          gstin: true, lastSyncAt: true, lastSyncStatus: true, isActive: true,
        },
      },
    },
  })
  ok(res, { items: rows, count: rows.length })
}))

// POST /api/zpay/connections/:id/authorize
// Returns the authorize URL the client should navigate to. The connection
// transitions to consent_pending inside beginConsent().
zpayRouter.post('/connections/:id/authorize', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const result = await beginConsent({
    connectionId: req.params.id,
    userId: session.userId,
    organisationId: orgId,
  })
  ok(res, result)
}))

// ── account CRUD (spec §2, §3) ─────────────────────────────────────────

// POST /api/zpay/connections/:id/accounts
// One connection may hold multiple accounts (see spec §2 topology check).
// The operator sets label, GST flag, GSTIN, invoice-series prefix.
zpayRouter.post('/connections/:id/accounts', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const conn = await prisma.zpayConnection.findFirst({
    where: { id: req.params.id, organisationId: orgId, deletedAt: null },
    select: { id: true, status: true },
  })
  if (!conn) throw ApiError.notFound('No such connection.')

  const body = (req.body ?? {}) as Record<string, unknown>
  const accountId = str(body.accountId)
  const label = str(body.label)
  const legalEntityName = str(body.legalEntityName)
  const invoiceSeriesPrefix = str(body.invoiceSeriesPrefix)
  const isGstRegistered = body.isGstRegistered === true
  const gstin = str(body.gstin) ?? null

  if (!accountId) throw ApiError.badRequest('accountId is required (Zoho\'s account identifier).')
  if (!label) throw ApiError.badRequest('label is required.')
  if (!legalEntityName) throw ApiError.badRequest('legalEntityName is required.')
  if (!invoiceSeriesPrefix) throw ApiError.badRequest('invoiceSeriesPrefix is required.')
  if (isGstRegistered && !gstin) throw ApiError.badRequest('gstin is required for a GST-registered account.')

  try {
    const created = await prisma.zpayAccount.create({
      data: {
        connectionId: conn.id,
        accountId,
        label,
        isGstRegistered,
        legalEntityName,
        gstin,
        invoiceSeriesPrefix,
        createdBy: session.userId,
        updatedBy: session.userId,
      },
      select: {
        id: true, accountId: true, label: true, isGstRegistered: true,
        gstin: true, invoiceSeriesPrefix: true, isActive: true,
        lastSyncAt: true, lastSyncStatus: true,
      },
    })
    ok(res, created, 201)
  } catch (err) {
    // Unique on (connectionId, accountId) — a duplicate is a 409.
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      throw ApiError.conflict('duplicate_account', 'This Zoho account is already added to this connection.')
    }
    throw err
  }
}))

// POST /api/zpay/connections/:cid/accounts/:aid/sync
// Trigger a sync. Runs synchronously — spec §3 defers scheduling to the
// job runner that lands in a later PR. For the manual button the caller
// waits and gets the outcome.
zpayRouter.post('/connections/:cid/accounts/:aid/sync', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const account = await prisma.zpayAccount.findFirst({
    where: {
      id: req.params.aid,
      connectionId: req.params.cid,
      deletedAt: null,
      connection: { organisationId: orgId },
    },
    select: { id: true },
  })
  if (!account) throw ApiError.notFound('No such account.')
  const outcome = await syncAccount(account.id)
  ok(res, outcome)
}))

// POST /api/zpay/connections/:cid/sync
// Kick off a sync for every active account under this connection. Same
// caveat as above — synchronous for now.
zpayRouter.post('/connections/:cid/sync', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const conn = await prisma.zpayConnection.findFirst({
    where: { id: req.params.cid, organisationId: orgId, deletedAt: null },
    select: { id: true },
  })
  if (!conn) throw ApiError.notFound('No such connection.')
  const outcomes = await syncConnection(conn.id)
  ok(res, { runs: outcomes })
}))

// ── external invoices (spec §9) ───────────────────────────────────────

// POST /api/zpay/accounts/:aid/invoices/import  multipart file=<csv>
// Bulk import CSV of invoices raised from an account. Upsert on
// (billingAccountId, invoice_number) so re-uploading is idempotent.
zpayRouter.post('/accounts/:aid/invoices/import', (req, res, next) => {
  csvUpload.single('file')(req, res, (err: unknown) => {
    if (!err) return next()
    const code = (err as { code?: string }).code
    if (code === 'LIMIT_FILE_SIZE') {
      return next(ApiError.unprocessable('too_large', `CSV is larger than ${MAX_CSV_MB} MB.`))
    }
    return next(err)
  })
}, handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const file = (req as unknown as { file?: { buffer: Buffer; originalname: string } }).file
  if (!file || !file.buffer) throw ApiError.badRequest('Attach a CSV file under the "file" field.')
  const csv = file.buffer.toString('utf8')
  const outcome = await importInvoicesCsv({
    billingAccountId: req.params.aid,
    organisationId: orgId,
    actorUserId: session.userId,
    csv,
  })
  // Fresh invoices can unlock proposals for previously-unmatched
  // payments on this account — spec §4.2 doesn't distinguish "matched
  // during sync" from "matched after an import".
  const { proposed } = await runProbableForAccount(req.params.aid)
  ok(res, { ...outcome, probableProposed: proposed })
}))

// GET /api/zpay/accounts/:aid/invoices — recent invoices for the ops screen.
zpayRouter.get('/accounts/:aid/invoices', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const account = await prisma.zpayAccount.findFirst({
    where: {
      id: req.params.aid,
      deletedAt: null,
      connection: { organisationId: orgId, deletedAt: null },
    },
    select: { id: true },
  })
  if (!account) throw ApiError.notFound('No such account.')
  const rows = await prisma.zpayExternalInvoice.findMany({
    where: { billingAccountId: account.id, deletedAt: null },
    orderBy: { issuedOn: 'desc' },
    take: 100,
    select: {
      id: true, invoiceNumber: true, clientId: true, issuedOn: true,
      dueDate: true, amountPaise: true, status: true, importedAt: true,
    },
  })
  ok(res, { items: rows, count: rows.length })
}))

// ── client billing slice (spec §6.3) ──────────────────────────────────

// GET /api/zpay/clients/:id/billing-slice
// The card on the client record: billed-from account, paid-this-FY,
// last-payment, plus placeholders for outstanding & oldest-open-invoice
// (these come alive when an invoice source lands). Behind
// accounts.manage@organisation — spec §6.3: hidden entirely, not greyed.
zpayRouter.get('/clients/:id/billing-slice', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const slice = await billingSliceFor(req.params.id, orgId)
  ok(res, slice)
}))

// PATCH /api/zpay/clients/:id/billing-account  { accountId | null }
// One client is billed from ONE account (spec §3). Setting null clears
// the mapping. Behind accounts.manage@organisation.
zpayRouter.patch('/clients/:id/billing-account', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const body = (req.body ?? {}) as { accountId?: unknown }
  const accountId =
    body.accountId === null ? null
    : typeof body.accountId === 'string' && body.accountId.length ? body.accountId
    : undefined
  if (accountId === undefined) {
    throw ApiError.badRequest('accountId must be a string or null.')
  }
  const result = await setBillingAccount(req.params.id, orgId, accountId, session.userId)
  ok(res, result)
}))

// GET /api/zpay/payments — the matching queue.
//   filter:   unmatched | proposed | matched   (default: unmatched)
//   entity:   all | gst | non-gst              (default: all)
//   period:   YYYY-MM                          (default: current month)
//   limit:    1..500                           (default: 100)
zpayRouter.get('/payments', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const filterRaw = typeof req.query.filter === 'string' ? req.query.filter : 'unmatched'
  const filter = filterRaw === 'matched' || filterRaw === 'proposed' ? filterRaw : 'unmatched'
  const entityRaw = typeof req.query.entity === 'string' ? req.query.entity : 'all'
  const entity = entityRaw === 'gst' || entityRaw === 'non-gst' ? entityRaw : 'all'
  const period = parsePeriod(typeof req.query.period === 'string' ? req.query.period : undefined)
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))

  const matchTypeWhere =
    filter === 'unmatched' ? { matchType: 'unmatched' as const }
    : filter === 'proposed' ? { matchType: 'probable' as const }
    : { matchType: { in: ['exact', 'manual'] } }

  const entityWhere =
    entity === 'gst' ? { account: { isGstRegistered: true } }
    : entity === 'non-gst' ? { account: { isGstRegistered: false } }
    : {}

  const rows = await prisma.zpayPayment.findMany({
    where: {
      paidAt: { gte: period.from, lt: period.to },
      account: {
        connection: { organisationId: orgId, deletedAt: null },
        deletedAt: null,
        ...(entity !== 'all' ? { isGstRegistered: entity === 'gst' } : {}),
      },
      ...matchTypeWhere,
      ...entityWhere,
    },
    orderBy: { paidAt: 'desc' },
    take: limit,
    select: {
      id: true,
      paidAt: true,
      amountPaise: true,
      customerName: true,
      referenceNumber: true,
      matchType: true,
      matchedInvoiceRef: true,
      matchedClientId: true,
      matchConfirmedAt: true,
      account: {
        select: {
          id: true,
          label: true,
          isGstRegistered: true,
          invoiceSeriesPrefix: true,
        },
      },
    },
  })

  // For probable/matched rows that point at an external invoice, hydrate
  // the candidate details so the queue can render "Probable: INV/2026/… ·
  // ₹25,000 · raised 09 Sep" without a second call.
  const refKeys = rows
    .filter((r) => r.matchedInvoiceRef)
    .map((r) => ({ billingAccountId: r.account.id, invoiceNumber: r.matchedInvoiceRef as string }))
  const invoices = refKeys.length
    ? await prisma.zpayExternalInvoice.findMany({
        where: { OR: refKeys, deletedAt: null },
        select: {
          billingAccountId: true, invoiceNumber: true, issuedOn: true,
          amountPaise: true, status: true, clientId: true,
        },
      })
    : []
  const invoiceMap = new Map(
    invoices.map((i) => [`${i.billingAccountId}::${i.invoiceNumber}`, i]),
  )
  const enriched = rows.map((r) => ({
    ...r,
    candidateInvoice: r.matchedInvoiceRef
      ? invoiceMap.get(`${r.account.id}::${r.matchedInvoiceRef}`) ?? null
      : null,
  }))

  // Counts of every bucket so tabs can render badges without a second call.
  const countsFor = (m: 'unmatched' | 'proposed' | 'matched') =>
    prisma.zpayPayment.count({
      where: {
        paidAt: { gte: period.from, lt: period.to },
        account: {
          connection: { organisationId: orgId, deletedAt: null },
          deletedAt: null,
          ...(entity !== 'all' ? { isGstRegistered: entity === 'gst' } : {}),
        },
        ...(m === 'unmatched' ? { matchType: 'unmatched' }
          : m === 'proposed' ? { matchType: 'probable' }
          : { matchType: { in: ['exact', 'manual'] as string[] } }),
      },
    })
  const [unmatchedCount, proposedCount, matchedCount] = await Promise.all([
    countsFor('unmatched'),
    countsFor('proposed'),
    countsFor('matched'),
  ])

  ok(res, {
    items: enriched,
    counts: {
      unmatched: unmatchedCount,
      proposed: proposedCount,
      matched: matchedCount,
    },
  })
}))

// POST /api/zpay/payments/:id/confirm-probable
// Promote a proposed (probable) match to `manual`. Keeps
// matchedInvoiceRef + matchedClientId and stamps the confirming user.
zpayRouter.post('/payments/:id/confirm-probable', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const payment = await prisma.zpayPayment.findFirst({
    where: {
      id: req.params.id,
      account: { connection: { organisationId: orgId, deletedAt: null } },
    },
    select: { id: true, matchType: true },
  })
  if (!payment) throw ApiError.notFound('No such payment.')
  if (payment.matchType !== 'probable') {
    throw ApiError.conflict('not_probable', 'Only a probable-tier proposal can be confirmed.')
  }
  await prisma.zpayPayment.update({
    where: { id: payment.id },
    data: {
      matchType: 'manual',
      matchConfirmedBy: session.userId,
      matchConfirmedAt: new Date(),
    },
  })
  ok(res, { paymentId: payment.id, matchType: 'manual' })
}))

// POST /api/zpay/payments/:id/match  { invoiceRef, clientId? }
zpayRouter.post('/payments/:id/match', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const body = (req.body ?? {}) as { invoiceRef?: unknown; clientId?: unknown }
  const invoiceRef = typeof body.invoiceRef === 'string' ? body.invoiceRef : ''
  if (!invoiceRef.trim()) throw ApiError.badRequest('invoiceRef is required.')
  const clientId = typeof body.clientId === 'string' && body.clientId.length ? body.clientId : null
  await manuallyMatch({
    paymentId: req.params.id,
    organisationId: orgId,
    actorUserId: session.userId,
    invoiceRef,
    clientId,
  })
  ok(res, { paymentId: req.params.id, matchType: 'manual', invoiceRef })
}))

// POST /api/zpay/payments/:id/unmatch
zpayRouter.post('/payments/:id/unmatch', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  await unmatch({
    paymentId: req.params.id,
    organisationId: orgId,
    actorUserId: session.userId,
  })
  ok(res, { paymentId: req.params.id, matchType: 'unmatched' })
}))

// GET /api/zpay/collections?period=YYYY-MM&entity=all|gst|non-gst
// Local aggregate for the Collections card. Never touches Zoho on read
// (spec §3) — if the tiles are stale, sync is where to look.
zpayRouter.get('/collections', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const period = parsePeriod(typeof req.query.period === 'string' ? req.query.period : undefined)
  const entityRaw = typeof req.query.entity === 'string' ? req.query.entity : 'all'
  const entity = entityRaw === 'gst' || entityRaw === 'non-gst' ? entityRaw : 'all'
  const aggregate = await collectionsAggregate(orgId, entity, period)
  ok(res, aggregate)
}))

// GET /api/zpay/connections/:cid/accounts/:aid/sync-runs
// Recent runs for the account, most-recent first, for the ops screen.
zpayRouter.get('/connections/:cid/accounts/:aid/sync-runs', handler(async (req, res) => {
  const session = requireSession(req)
  const orgId = await orgIdFor(session.userId)
  const account = await prisma.zpayAccount.findFirst({
    where: {
      id: req.params.aid,
      connectionId: req.params.cid,
      connection: { organisationId: orgId },
    },
    select: { id: true },
  })
  if (!account) throw ApiError.notFound('No such account.')
  const runs = await prisma.zpaySyncRun.findMany({
    where: { accountRowId: account.id },
    orderBy: { startedAt: 'desc' },
    take: 20,
    select: {
      id: true, startedAt: true, finishedAt: true, status: true,
      paymentsFetched: true, refundsFetched: true, errorCode: true,
      errorDetail: true, windowFrom: true, windowTo: true,
    },
  })
  ok(res, { items: runs, count: runs.length })
}))

// ── public callback router ────────────────────────────────────────────

export const zpayCallbackRouter = Router()

// GET /api/zpay/callback?code=…&state=…
zpayCallbackRouter.get('/callback', handler(async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null
  const state = typeof req.query.state === 'string' ? req.query.state : null
  if (!code || !state) {
    // A user hitting /callback directly, without OAuth params, gets a page
    // rather than a 400 JSON blob — this endpoint is meant for a browser.
    return respondHtml(res, 400, 'Missing OAuth parameters. Start the connect flow from Settings.')
  }
  try {
    const result = await completeConsent({ code, state })
    return respondHtml(
      res,
      200,
      `Connection complete — you can close this tab.\n\nConnection: ${result.connectionId}`,
    )
  } catch (err) {
    const errCode = err instanceof ApiError ? err.code : 'oauth_failed'
    const message = err instanceof Error ? err.message : 'The consent flow could not be completed.'
    return respondHtml(res, 400, `Connection failed (${errCode}).\n\n${message}`)
  }
}))

// ── helpers ───────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t.length ? t : undefined
}

async function orgIdFor(userId: string): Promise<string> {
  // A user belongs to exactly one Organisation in this schema; the value is
  // cached in-request only when the session is loaded elsewhere. Fetching
  // it once per handler is cheap and keeps the service pure.
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { organisationId: true },
  })
  return user.organisationId
}

function respondHtml(res: import('express').Response, status: number, body: string): void {
  res
    .status(status)
    .type('text/html; charset=utf-8')
    .send(
      `<!doctype html><meta charset="utf-8"><title>Zoho Payments</title>` +
        `<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;padding:3rem;max-width:38rem;margin:auto;color:#0f172a}` +
        `pre{white-space:pre-wrap;background:#f8fafc;padding:1rem;border-radius:.5rem;border:1px solid #e2e8f0}</style>` +
        `<h1>Zoho Payments</h1><pre>${escapeHtml(body)}</pre>`,
    )
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
