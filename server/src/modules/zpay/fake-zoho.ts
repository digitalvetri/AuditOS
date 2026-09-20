/**
 * In-process fake for both Zoho surfaces used by this integration:
 *
 *   /fake-zoho/oauth/v2/*      OAuth (accounts.zoho.in in live)
 *   /fake-zoho/api/v1/*        Payments read API (payments.zoho.in in live)
 *
 * Mount at `/fake-zoho` when ZPAY_MODE=fake. Exists so the OAuth flow AND
 * the sync loop can be exercised end-to-end without a Zoho developer app.
 * The shape of what returns here mirrors what Zoho documents — the same
 * client code should work in live mode with no branching.
 *
 * What is faithful:
 *   • authorize → 302 to redirect_uri with `code` and `state`
 *   • code is single-use and expires after 60 seconds (spec §1)
 *   • token endpoint returns access_token, refresh_token, scope, expires_in
 *   • payments/refunds endpoints require `Zoho-oauthtoken` auth header
 *     and `account_id` query param — a missing header 401s and a missing
 *     account_id 400s, matching Zoho's contract
 *   • payment amounts are RUPEES-as-decimal (Zoho's shape), so the sync
 *     helper must round to paise at the boundary
 *   • `page_context.has_more_page` supported so pagination can be tested
 *   • each `account_id` seeds a deterministic dataset — re-hitting the
 *     same account returns the same rows, which is what makes idempotency
 *     testable
 *
 * What is simplified:
 *   • no consent screen — authorize endpoint just redirects
 *   • no rate limiting, no throttling, no key rotation
 *   • access tokens are NOT tracked for expiry here — a test that needs
 *     "expired token → refresh" drives that with an injected fetchImpl
 *     at the oauth-helper layer instead
 *
 * NEVER mount in production. The router refuses to construct if
 * ZPAY_MODE !== 'fake', so a config mistake fails at boot rather than
 * exposing a token issuer over the internet.
 */
import crypto from 'node:crypto'
import { Router } from 'express'
import type { ZpayConfig } from './config.js'

interface IssuedCode {
  redirectUri: string
  scopes: string[]
  issuedAt: number
  used: boolean
}

const CODE_TTL_MS = 60 * 1000

export function createFakeZohoRouter(config: ZpayConfig): Router {
  if (config.mode !== 'fake') {
    throw new Error('fake-zoho router must only be constructed in ZPAY_MODE=fake')
  }
  const router = Router()

  /** Map<code, IssuedCode>. Purged lazily as codes are read. */
  const codes = new Map<string, IssuedCode>()

  // GET /fake-zoho/oauth/v2/auth?client_id=…&scope=…&redirect_uri=…&state=…
  router.get('/oauth/v2/auth', (req, res) => {
    const {
      client_id: clientId,
      scope,
      redirect_uri: redirectUri,
      state,
      response_type: responseType,
    } = req.query as Record<string, string | undefined>

    if (responseType !== 'code') {
      return res.status(400).json({ error: 'unsupported_response_type' })
    }
    if (clientId !== config.clientId) {
      return res.status(400).json({ error: 'invalid_client' })
    }
    if (!redirectUri || redirectUri !== config.redirectUri) {
      return res.status(400).json({ error: 'redirect_uri_mismatch' })
    }
    if (!state) {
      return res.status(400).json({ error: 'missing_state' })
    }
    const scopes = (scope ?? '').split(/\s+/).filter(Boolean)
    if (scopes.length === 0) {
      return res.status(400).json({ error: 'missing_scope' })
    }

    const code = crypto.randomBytes(24).toString('hex')
    codes.set(code, { redirectUri, scopes, issuedAt: Date.now(), used: false })

    const url = new URL(redirectUri)
    url.searchParams.set('code', code)
    url.searchParams.set('state', state)
    res.redirect(302, url.toString())
  })

  // POST /fake-zoho/oauth/v2/token
  router.post('/oauth/v2/token', (req, res) => {
    // OAuth uses application/x-www-form-urlencoded; the express.urlencoded
    // parser in app.ts populates req.body.
    const body = req.body as Record<string, string | undefined>

    if (body.grant_type === 'authorization_code') {
      const { client_id, client_secret, code, redirect_uri } = body
      if (client_id !== config.clientId || client_secret !== config.clientSecret) {
        return res.status(401).json({ error: 'invalid_client' })
      }
      if (!code) return res.status(400).json({ error: 'invalid_request' })
      const record = codes.get(code)
      if (!record) return res.status(400).json({ error: 'invalid_code' })
      if (record.used) return res.status(400).json({ error: 'code_already_used' })
      if (Date.now() - record.issuedAt > CODE_TTL_MS) {
        codes.delete(code)
        return res.status(400).json({ error: 'code_expired' })
      }
      if (redirect_uri !== record.redirectUri) {
        return res.status(400).json({ error: 'redirect_uri_mismatch' })
      }
      record.used = true
      codes.delete(code)
      return res.status(200).json({
        access_token: `fake-access-${crypto.randomBytes(8).toString('hex')}`,
        refresh_token: `fake-refresh-${crypto.randomBytes(12).toString('hex')}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: record.scopes.join(' '),
        api_domain: config.paymentsBase,
      })
    }

    if (body.grant_type === 'refresh_token') {
      const { client_id, client_secret, refresh_token } = body
      if (client_id !== config.clientId || client_secret !== config.clientSecret) {
        return res.status(401).json({ error: 'invalid_client' })
      }
      if (!refresh_token || !refresh_token.startsWith('fake-refresh-')) {
        return res.status(400).json({ error: 'invalid_grant' })
      }
      return res.status(200).json({
        access_token: `fake-access-${crypto.randomBytes(8).toString('hex')}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: config.scopes.join(' '),
        api_domain: config.paymentsBase,
      })
    }

    return res.status(400).json({ error: 'unsupported_grant_type' })
  })

  // ── Payments / Refunds read API ──────────────────────────────────────
  // Real endpoints:
  //   GET https://payments.zoho.in/api/v1/payments?account_id=…
  //   GET https://payments.zoho.in/api/v1/refunds?account_id=…
  //
  // The `account_id` query param is required — it is how Zoho scopes reads
  // to one of the operator's accounts. The Authorization header carries
  // an access token issued by /oauth/v2/token above; we accept any value
  // that looks like one (see the block comment at the top of this file
  // about why we don't track expiry here).

  router.get('/api/v1/payments', (req, res) => {
    const auth = requireBearer(req, res)
    if (!auth) return
    const accountId = req.query.account_id
    if (typeof accountId !== 'string' || !accountId) {
      return res.status(400).json({ code: 5, message: 'account_id is required' })
    }
    const page = Math.max(1, Number(req.query.page) || 1)
    const perPage = Math.min(200, Math.max(1, Number(req.query.per_page) || 50))
    const rows = seedPayments(accountId)
    return res.status(200).json(paginate(rows, page, perPage, 'payments'))
  })

  router.get('/api/v1/refunds', (req, res) => {
    const auth = requireBearer(req, res)
    if (!auth) return
    const accountId = req.query.account_id
    if (typeof accountId !== 'string' || !accountId) {
      return res.status(400).json({ code: 5, message: 'account_id is required' })
    }
    const page = Math.max(1, Number(req.query.page) || 1)
    const perPage = Math.min(200, Math.max(1, Number(req.query.per_page) || 50))
    const rows = seedRefunds(accountId)
    return res.status(200).json(paginate(rows, page, perPage, 'refunds'))
  })

  return router
}

// ── helpers ───────────────────────────────────────────────────────────

function requireBearer(req: import('express').Request, res: import('express').Response): string | null {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Zoho-oauthtoken ')) {
    res.status(401).json({ code: 57, message: 'invalid_token' })
    return null
  }
  const token = header.slice('Zoho-oauthtoken '.length)
  if (!token.startsWith('fake-access-')) {
    res.status(401).json({ code: 57, message: 'invalid_token' })
    return null
  }
  return token
}

function paginate<T>(
  rows: T[],
  page: number,
  perPage: number,
  key: 'payments' | 'refunds',
): Record<string, unknown> {
  const start = (page - 1) * perPage
  const slice = rows.slice(start, start + perPage)
  return {
    [key]: slice,
    page_context: {
      page,
      per_page: perPage,
      has_more_page: start + perPage < rows.length,
      sort_column: 'created_at',
      sort_order: 'A',
    },
  }
}

/**
 * Deterministic per-account payment dataset. Seed on the account id so
 * every test and every re-run sees the same rows, which is what makes
 * idempotency actually testable — a random dataset would just produce
 * different rows each sync.
 *
 * Amounts are RUPEES-as-decimal (Zoho's shape); the sync converts to
 * paise at the boundary. Reference numbers follow the invoice-series
 * discipline in spec §4.1 so exact-tier matching has something to hit.
 */
function seedPayments(accountId: string): Array<Record<string, unknown>> {
  const seed = hash(accountId)
  const count = 2 + (seed % 4) // 2..5 payments
  const rng = mulberry32(seed)
  const now = new Date('2026-09-15T10:00:00+05:30').getTime()
  const rows: Array<Record<string, unknown>> = []
  for (let i = 0; i < count; i++) {
    const amountRupees = 5_000 + Math.floor(rng() * 45_000)
    const feeRupees = Math.round(amountRupees * 0.0236 * 100) / 100 // 2% + 18% GST on it
    const daysAgo = i * 2 + Math.floor(rng() * 3)
    const paidAt = new Date(now - daysAgo * 86_400_000).toISOString()
    rows.push({
      payment_id: `pay_${accountId.slice(-6)}_${(i + 1).toString().padStart(4, '0')}`,
      amount: amountRupees,
      fee: feeRupees,
      currency: 'INR',
      status: 'captured',
      payment_mode: ['upi', 'card', 'netbanking'][Math.floor(rng() * 3)],
      customer_name: pickCustomer(rng),
      customer_email: 'billing@fixture.local',
      reference: `INV/2026/${(400 + Math.floor(rng() * 200)).toString().padStart(4, '0')}`,
      description: 'Compliance filing fee',
      mandate_id: null,
      created_at: paidAt,
      paid_at: paidAt,
    })
  }
  return rows
}

function seedRefunds(accountId: string): Array<Record<string, unknown>> {
  const seed = hash(accountId) ^ 0x9e3779b1
  const count = seed % 3 === 0 ? 1 : 0 // occasional refund
  if (count === 0) return []
  const payments = seedPayments(accountId)
  if (payments.length === 0) return []
  const p = payments[0] as { payment_id: string; amount: number; paid_at: string }
  return [{
    refund_id: `rfd_${accountId.slice(-6)}_0001`,
    payment_id: p.payment_id,
    amount: p.amount,
    status: 'processed',
    reason: 'duplicate_payment',
    refunded_at: p.paid_at,
  }]
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(a: number): () => number {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pickCustomer(rng: () => number): string {
  return [
    'Kovai Textiles',
    'Anand & Sons',
    'R. Muthukumar',
    'Chennai Spice Co',
    'Nadar Brothers',
    'Bharath Traders',
    'Ilanko Industries',
  ][Math.floor(rng() * 7)]
}
