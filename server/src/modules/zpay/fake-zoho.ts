/**
 * In-process fake for accounts.zoho.in — the OAuth surface only.
 *
 * Mount at `/fake-zoho` when ZPAY_MODE=fake. Exists so the OAuth flow can
 * be driven end-to-end (browser → authorize → callback → token exchange)
 * without a Zoho developer app. Real endpoints replace this one when the
 * env flips to live; the shape of what returns here matches what Zoho
 * documents.
 *
 * What is faithful:
 *   • authorize → 302 to redirect_uri with `code` and `state`
 *   • code is single-use and expires after 60 seconds (spec §1)
 *   • token endpoint returns access_token, refresh_token, scope, expires_in
 *   • scope in the response is what the client asked for (no downgrade path
 *     because the fake grants everything)
 *
 * What is simplified:
 *   • no consent screen — the authorize endpoint just redirects
 *   • no rate limiting, no throttling
 *   • no key rotation
 *
 * NEVER mount this in production. The router refuses to construct if
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

  return router
}
