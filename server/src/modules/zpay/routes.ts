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
import { ApiError, handler, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { requireSession, requirePermission } from '../../platform/auth.js'
import { beginConsent, completeConsent } from './service.js'
import { syncAccount, syncConnection } from './sync.js'
import { collectionsAggregate, parsePeriod } from './collections.js'

export const zpayRouter = Router()

zpayRouter.use(requirePermission('accounts.manage', 'organisation'))

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
