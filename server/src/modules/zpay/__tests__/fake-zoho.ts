/**
 * Round-trip test for the fake Zoho router. Spins up a real HTTP listener
 * so `fetch` in exchangeCodeForTokens actually talks to the fake, then
 * drives the full OAuth handshake:
 *
 *   1. GET /oauth/v2/auth  → 302 with code + state
 *   2. POST /oauth/v2/token (via exchangeCodeForTokens)
 *   3. Assert tokens land, refresh grant works, and every error path Zoho
 *      documents surfaces the right error code.
 *
 * This is the piece that catches an accidental change to the fake's
 * response shape or a mis-typed field name in the exchange helper — a
 * pure unit test can't do that.
 *
 * Run:  npx tsx src/modules/zpay/__tests__/fake-zoho.ts
 */

import crypto from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createFakeZohoRouter } from '../fake-zoho.js'
import { exchangeCodeForTokens, ZohoOAuthError } from '../oauth.js'
import type { ZpayConfig } from '../config.js'

function pass(name: string): void { console.log(`✓ ${name}`) }
function fail(name: string, detail: string): never {
  console.error(`✗ ${name}\n  ${detail}`); process.exit(1)
}

async function bootFake(): Promise<{ config: ZpayConfig; close: () => Promise<void> }> {
  const app = express()
  app.use(express.urlencoded({ extended: true }))

  // The config's callback URL points back at the same http listener so the
  // fake accepts the redirect_uri as legitimate. The port is resolved after
  // the listener is bound, so we construct the config in two phases.
  const partial = {
    mode: 'fake' as const,
    clientId: 'CID',
    clientSecret: 'CSECRET',
    scopes: ['ZohoPay.payments.READ', 'ZohoPay.refunds.READ'] as const,
    encryptionKey: crypto.randomBytes(32),
  }

  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`

  const config: ZpayConfig = {
    ...partial,
    redirectUri: `${base}/api/zpay/callback`,
    accountsBase: `${base}/fake-zoho`,
    paymentsBase: `${base}/fake-zoho`,
  }

  app.use('/fake-zoho', createFakeZohoRouter(config))
  // A stub callback that just records receipt so a manual redirect works.
  app.get('/api/zpay/callback', (_req, res) => res.status(200).end('ok'))

  return {
    config,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function authorize(config: ZpayConfig, state: string): Promise<string> {
  const url = new URL(`${config.accountsBase}/oauth/v2/auth`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('scope', config.scopes.join(' '))
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')

  const res = await fetch(url, { redirect: 'manual' })
  if (res.status !== 302) fail('authorize', `expected 302, got ${res.status}`)
  const loc = res.headers.get('location')
  if (!loc) fail('authorize', 'no Location header')
  const back = new URL(loc)
  const code = back.searchParams.get('code')
  const returnedState = back.searchParams.get('state')
  if (returnedState !== state) fail('authorize', 'state did not round-trip')
  if (!code) fail('authorize', 'no code on redirect')
  return code
}

async function main() {
  const { config, close } = await bootFake()
  try {
    // ── Happy path ────────────────────────────────────────────────────
    {
      const code = await authorize(config, 'STATE-happy')
      const tokens = await exchangeCodeForTokens(config, code)
      if (!tokens.access_token.startsWith('fake-access-')) {
        fail('happy path', `unexpected access token shape: ${tokens.access_token}`)
      }
      if (!tokens.refresh_token?.startsWith('fake-refresh-')) {
        fail('happy path', 'no refresh_token returned on first exchange')
      }
      if (tokens.expires_in !== 3600) fail('happy path', 'expires_in should be 3600')
      if (tokens.scope !== config.scopes.join(' ')) fail('happy path', 'scope not echoed')
      pass('authorize → token round-trip with the fake')
    }

    // ── Code is single-use ────────────────────────────────────────────
    {
      const code = await authorize(config, 'STATE-single-use')
      await exchangeCodeForTokens(config, code)
      try {
        await exchangeCodeForTokens(config, code)
        fail('single-use', 'second exchange succeeded')
      } catch (err) {
        if (!(err instanceof ZohoOAuthError)) fail('single-use', 'wrong error type')
        if (err.code !== 'invalid_code') fail('single-use', `got ${err.code}`)
        pass('code refused after first use')
      }
    }

    // ── Wrong client secret ───────────────────────────────────────────
    {
      const code = await authorize(config, 'STATE-bad-secret')
      const badConfig: ZpayConfig = { ...config, clientSecret: 'WRONG' }
      try {
        await exchangeCodeForTokens(badConfig, code)
        fail('bad secret', 'exchange with wrong secret succeeded')
      } catch (err) {
        if (!(err instanceof ZohoOAuthError)) fail('bad secret', 'wrong error type')
        if (err.status !== 401) fail('bad secret', `expected 401, got ${err.status}`)
        pass('token endpoint refuses wrong client_secret')
      }
    }

    // ── Bad redirect_uri at authorize ─────────────────────────────────
    {
      const url = new URL(`${config.accountsBase}/oauth/v2/auth`)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', config.clientId)
      url.searchParams.set('scope', config.scopes.join(' '))
      url.searchParams.set('redirect_uri', 'http://example.invalid/callback')
      url.searchParams.set('state', 'x')
      const res = await fetch(url, { redirect: 'manual' })
      if (res.status !== 400) fail('bad redirect', `expected 400, got ${res.status}`)
      pass('authorize refuses mismatched redirect_uri')
    }

    // ── Refresh grant returns access-only ─────────────────────────────
    {
      const code = await authorize(config, 'STATE-refresh')
      const first = await exchangeCodeForTokens(config, code)
      const refreshRes = await fetch(`${config.accountsBase}/oauth/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: first.refresh_token!,
        }),
      })
      if (refreshRes.status !== 200) fail('refresh', `expected 200, got ${refreshRes.status}`)
      const refreshed = await refreshRes.json() as { access_token?: string; refresh_token?: string }
      if (!refreshed.access_token?.startsWith('fake-access-')) {
        fail('refresh', 'refresh did not return a new access_token')
      }
      if (refreshed.refresh_token) {
        fail('refresh', 'refresh grant should not return a fresh refresh_token')
      }
      pass('refresh grant returns access-only (no new refresh_token)')
    }

    // ── Fake router refuses to construct in live mode ─────────────────
    {
      try {
        createFakeZohoRouter({ ...config, mode: 'live' })
        fail('mode guard', 'fake router constructed in live mode')
      } catch {
        pass('fake router refuses to construct when mode !== fake')
      }
    }
  } finally {
    await close()
  }

  console.log('\nAll Zoho Payments fake round-trip checks passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
