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
import express, { Router } from 'express'
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

  /** Payment links raised through the fake, and the payments made on them per account. */
  const links = new Map<string, { payment_link_id: string; url: string; expires_at: string; amount: string; amount_paid: string; currency: string; status: string; email: unknown; phone: unknown; reference_id: unknown; description: unknown; created_time: number; payments: Array<Record<string, unknown>>; account_id: string }>()
  const paidByLink = new Map<string, Array<Record<string, unknown>>>()

  /** Map<code, IssuedCode>. Purged lazily as codes are read. */
  const codes = new Map<string, IssuedCode>()

  // Zoho Payments' consent is /oauth/v2/org/auth with soid=zohopay.{account_id};
  // the generic endpoint does not authorise a Payments account.
  router.get('/oauth/v2/auth', (_req, res) => {
    res.status(400).json({ error: 'invalid_request', message: 'Zoho Payments needs /oauth/v2/org/auth with soid' })
  })

  // GET /fake-zoho/oauth/v2/org/auth?client_id=…&scope=…&redirect_uri=…&state=…&soid=zohopay.{id}
  router.get('/oauth/v2/org/auth', (req, res) => {
    if (typeof req.query.soid !== 'string' || !/^zohopay\.\S+$/.test(req.query.soid)) {
      return res.status(400).json({ error: 'invalid_soid' })
    }
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
    const scopes = (scope ?? '').split(/[\s,]+/).filter(Boolean)
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

  // ── Payments read API, as Zoho Payments documents it ─────────────────
  //   GET /api/v1/payments?account_id=…&filter_by=ChargeDate.CustomDate&from_date=…&to_date=…&page=…&per_page=…
  //   GET /api/v1/payments/{payment_id}?account_id=…   (detail, with refunds)
  // There is no refunds list; GET /api/v1/refunds is not an endpoint.

  router.get('/api/v1/payments', (req, res) => {
    const auth = requireBearer(req, res)
    if (!auth) return
    const accountId = req.query.account_id
    if (typeof accountId !== 'string' || !accountId) {
      return res.status(400).json({ code: 5, message: 'account_id is required' })
    }
    const { filter_by: filterBy, from_date: from, to_date: to } = req.query as Record<string, string | undefined>
    if (filterBy === 'ChargeDate.CustomDate' && (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))) {
      return res.status(400).json({ code: 2, message: 'from_date and to_date (yyyy-mm-dd) are required for ChargeDate.CustomDate' })
    }
    const page = Math.max(1, Number(req.query.page) || 1)
    const perPage = Math.min(200, Math.max(1, Number(req.query.per_page) || 25))
    let rows = [...seedPayments(accountId), ...(paidByLink.get(accountId) ?? [])]
    if (filterBy === 'ChargeDate.CustomDate') {
      const day = (sec: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(sec * 1000))
      rows = rows.filter((r) => day(r.date as number) >= from! && day(r.date as number) <= to!)
    }
    const start = (page - 1) * perPage
    // No page_context: a page shorter than per_page is the last.
    return res.status(200).json({ code: 0, message: 'success', payments: rows.slice(start, start + perPage).map(listShape) })
  })

  // ── Payment links (payment-links.yml) ────────────────────────────────
  //   POST /api/v1/paymentlinks?account_id=…   → 201 { payment_links: {…} }
  //   GET  /api/v1/paymentlinks/{id}?account_id=… → { payment_links: { …, payments: [] } }
  // POST /__test/paymentlinks/{id}/pay simulates the client paying (fake only):
  // the payment appears in the account's payment list AND on the link.
  router.post('/api/v1/paymentlinks', express.json(), (req, res) => {
    const auth = requireBearer(req, res)
    if (!auth) return
    const accountId = req.query.account_id
    if (typeof accountId !== 'string' || !accountId) return res.status(400).json({ code: 5, message: 'account_id is required' })
    const b = (req.body ?? {}) as Record<string, unknown>
    if (typeof b.amount !== 'number' || !(b.amount > 0) || b.currency !== 'INR' || typeof b.description !== 'string' || !b.description) {
      return res.status(400).json({ code: 2, message: 'amount, currency and description are required' })
    }
    if (b.reference_id != null && !/^[A-Za-z0-9_-]{1,100}$/.test(String(b.reference_id))) {
      return res.status(400).json({ code: 2, message: 'reference_id must be alphanumeric' })
    }
    const id = String(1730000023150 + links.size)
    const link = {
      payment_link_id: id, url: `https://payments.zoho.in/paymentlink/fake${id}`,
      expires_at: String(b.expires_at ?? '2026-12-31'), amount: (b.amount as number).toFixed(2), amount_paid: '0.00',
      currency: 'INR', status: 'active', email: b.email ?? null, phone: b.phone ?? null,
      reference_id: b.reference_id ?? null, description: b.description, created_time: Math.floor(Date.now() / 1000),
      payments: [] as Array<Record<string, unknown>>, account_id: accountId,
    }
    links.set(id, link)
    const { payments: _p, account_id: _a, ...shown } = link
    return res.status(201).json({ code: 0, message: 'Payment link created successfully', payment_links: shown })
  })

  router.get('/api/v1/paymentlinks/:id', (req, res) => {
    const auth = requireBearer(req, res)
    if (!auth) return
    const link = links.get(req.params.id)
    if (!link || link.account_id !== req.query.account_id) return res.status(404).json({ code: 1002, message: 'Payment link does not exist.' })
    const { account_id: _a, ...shown } = link
    return res.status(200).json({ code: 0, message: 'success', payment_links: shown })
  })

  router.post('/__test/paymentlinks/:id/pay', express.json(), (req, res) => {
    const link = links.get(req.params.id)
    if (!link) return res.status(404).json({ message: 'no such link' })
    const amount = String((req.body as { amount?: string })?.amount ?? link.amount)
    const paymentId = `pay_link_${link.payment_link_id}_${link.payments.length + 1}`
    const date = Math.floor(Date.now() / 1000)
    link.payments.push({ payment_id: paymentId, type: 'payment', amount, status: 'succeeded', date })
    const paid = link.payments.reduce((t, p) => t + Number(p.amount), 0)
    link.amount_paid = paid.toFixed(2)
    link.status = paid >= Number(link.amount) ? 'paid' : 'partially_paid'
    // Zoho does not promise the link's reference on the payment: leave it off.
    const extra = paidByLink.get(link.account_id) ?? []
    extra.push({ payment_id: paymentId, amount, fee_amount: '0.00', net_amount: amount, currency: 'INR', status: 'succeeded', payment_method: { type: 'upi' }, receipt_email: link.email, date })
    paidByLink.set(link.account_id, extra)
    return res.status(200).json({ payment_id: paymentId })
  })

  router.get('/api/v1/payments/:paymentId', (req, res) => {
    const auth = requireBearer(req, res)
    if (!auth) return
    const accountId = req.query.account_id
    if (typeof accountId !== 'string' || !accountId) {
      return res.status(400).json({ code: 5, message: 'account_id is required' })
    }
    const p = seedPayments(accountId).find((r) => r.payment_id === req.params.paymentId)
    if (!p) return res.status(404).json({ code: 1002, message: 'Payment does not exist.' })
    const refunds = seedRefunds(accountId).filter((r) => r.payment_id === p.payment_id)
    const refunded = refunds.reduce((t, r) => t + Number(r.amount), 0)
    return res.status(200).json({ code: 0, message: 'success', payment: { ...p, amount_refunded: refunded.toFixed(2), refunds } })
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
  const refunded = seed % 3 === 0 // the first payment of some accounts is refunded
  const rows: Array<Record<string, unknown>> = []
  for (let i = 0; i < count; i++) {
    const amountRupees = 5_000 + Math.floor(rng() * 45_000)
    const feeRupees = Math.round(amountRupees * 0.0236 * 100) / 100 // 2% + 18% GST on it
    const daysAgo = i * 2 + Math.floor(rng() * 3)
    rows.push({
      payment_id: `pay_${accountId.slice(-6)}_${(i + 1).toString().padStart(4, '0')}`,
      // Zoho Payments sends money as strings and dates as epoch seconds.
      amount: amountRupees.toFixed(2),
      fee_amount: feeRupees.toFixed(2),
      net_amount: (amountRupees - feeRupees).toFixed(2),
      currency: 'INR',
      status: i === 0 && refunded ? 'refunded' : 'succeeded',
      payment_method: { type: ['upi', 'card', 'net_banking'][Math.floor(rng() * 3)] },
      receipt_email: 'billing@fixture.local',
      reference_number: `INV/2026/${(400 + Math.floor(rng() * 200)).toString().padStart(4, '0')}`,
      description: 'Compliance filing fee',
      date: Math.floor((now - daysAgo * 86_400_000) / 1000),
    })
  }
  // An attempt that never completed: listed by Zoho, but no money arrived.
  rows.push({
    payment_id: `pay_${accountId.slice(-6)}_9999`,
    amount: '1234.00', fee_amount: '0.00', net_amount: '0.00', currency: 'INR', status: 'failed',
    payment_method: { type: 'upi' }, receipt_email: 'billing@fixture.local',
    reference_number: 'INV/2026/0400', description: 'Failed attempt',
    date: Math.floor(now / 1000),
  })
  return rows
}

/** List rows carry fewer fields than the detail view. */
function listShape(r: Record<string, unknown>): Record<string, unknown> {
  const { description: _d, ...rest } = r
  return rest
}

function seedRefunds(accountId: string): Array<Record<string, unknown>> {
  const first = seedPayments(accountId)[0]
  if (first.status !== 'refunded') return []
  return [{
    refund_id: `rfd_${accountId.slice(-6)}_0001`,
    payment_id: first.payment_id,
    amount: first.amount,
    status: 'succeeded',
    reason: 'duplicate_payment',
    date: first.date,
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
