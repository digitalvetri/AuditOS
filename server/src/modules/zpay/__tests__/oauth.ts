/**
 * OAuth-layer tests for the Zoho Payments integration.
 *
 * These are pure — no DB, no HTTP stack. They cover the parts that don't
 * need a running server:
 *
 *   1. AES-256-GCM round-trip; tag mismatch and short-buffer rejection
 *   2. buildAuthorizeUrl assembles the expected params and points at the
 *      configured accounts base
 *   3. exchangeCodeForTokens with an injected fetchImpl:
 *        • success returns the token payload
 *        • Zoho `error` field in a 200 body still throws ZohoOAuthError
 *        • an HTTP failure throws with the status carried on the error
 *   4. assertScopesGranted refuses a downgraded scope response
 *
 * The DB-bound service (beginConsent / completeConsent) lands its
 * integration coverage in step 3 alongside the sync end-to-end.
 *
 * Run:  npx tsx src/modules/zpay/__tests__/oauth.ts
 */

import crypto from 'node:crypto'
import { encryptToken, decryptToken, ZpayCryptoError } from '../crypto.js'
import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  assertScopesGranted,
  ZohoOAuthError,
  type FetchLike,
} from '../oauth.js'
import type { ZpayConfig } from '../config.js'

function pass(name: string): void {
  console.log(`✓ ${name}`)
}
function fail(name: string, detail: string): never {
  console.error(`✗ ${name}\n  ${detail}`)
  process.exit(1)
}

function fakeConfig(overrides: Partial<ZpayConfig> = {}): ZpayConfig {
  return {
    mode: 'fake',
    clientId: 'CID',
    clientSecret: 'CSECRET',
    redirectUri: 'http://localhost:4000/api/zpay/callback',
    accountsBase: 'http://localhost:4000/fake-zoho',
    paymentsBase: 'http://localhost:4000/fake-zoho',
    scopes: ['ZohoPay.payments.READ', 'ZohoPay.refunds.READ'],
    encryptionKey: crypto.randomBytes(32),
    ...overrides,
  }
}

// ── 1. Crypto ──────────────────────────────────────────────────────────

{
  const key = crypto.randomBytes(32)
  const secret = '1000.abcdef0123.deadbeef'
  const ct = encryptToken(secret, key)
  if (ct.includes(secret)) fail('crypto', 'ciphertext leaks plaintext substring')
  if (ct === secret) fail('crypto', 'ciphertext equals plaintext')
  const pt = decryptToken(ct, key)
  if (pt !== secret) fail('crypto', `round-trip mismatch: got ${pt}`)
  pass('encrypt / decrypt round-trip')

  // Two encrypts of the same value must differ (fresh IV each time).
  if (encryptToken(secret, key) === encryptToken(secret, key)) {
    fail('crypto', 'IV appears to be reused — same ciphertext twice')
  }
  pass('IV is not reused')

  // Tag tamper: flip a bit in the middle, decryption must throw.
  const buf = Buffer.from(ct, 'base64')
  buf[20] ^= 0xff
  try {
    decryptToken(buf.toString('base64'), key)
    fail('crypto', 'tampered ciphertext decrypted anyway')
  } catch (err) {
    if (!(err instanceof ZpayCryptoError)) {
      fail('crypto', `wrong error type: ${(err as Error).name}`)
    }
    pass('tampered ciphertext refused')
  }

  // Wrong key: also throws.
  try {
    decryptToken(ct, crypto.randomBytes(32))
    fail('crypto', 'decryption with wrong key succeeded')
  } catch (err) {
    if (!(err instanceof ZpayCryptoError)) fail('crypto', 'wrong error type')
    pass('wrong-key decryption refused')
  }

  // Short buffer.
  try {
    decryptToken(Buffer.from('short').toString('base64'), key)
    fail('crypto', 'short ciphertext accepted')
  } catch (err) {
    if (!(err instanceof ZpayCryptoError)) fail('crypto', 'wrong error type')
    pass('short ciphertext refused')
  }

  // Wrong key length.
  try {
    encryptToken('x', crypto.randomBytes(16))
    fail('crypto', 'accepted a 16-byte key for AES-256')
  } catch (err) {
    if (!(err instanceof ZpayCryptoError)) fail('crypto', 'wrong error type')
    pass('non-32-byte key refused')
  }
}

// ── 2. buildAuthorizeUrl ───────────────────────────────────────────────

{
  const cfg = fakeConfig()
  const url = new URL(buildAuthorizeUrl(cfg, { state: 'STATE-1', accessType: 'offline', prompt: 'consent' }))
  if (url.origin + url.pathname !== 'http://localhost:4000/fake-zoho/oauth/v2/auth') {
    fail('authorize url', `unexpected endpoint: ${url.origin + url.pathname}`)
  }
  const q = url.searchParams
  const checks: [string, string][] = [
    ['response_type', 'code'],
    ['client_id', 'CID'],
    ['scope', 'ZohoPay.payments.READ ZohoPay.refunds.READ'],
    ['redirect_uri', 'http://localhost:4000/api/zpay/callback'],
    ['state', 'STATE-1'],
    ['access_type', 'offline'],
    ['prompt', 'consent'],
  ]
  for (const [k, v] of checks) {
    if (q.get(k) !== v) fail('authorize url', `${k} expected "${v}", got "${q.get(k)}"`)
  }
  pass('buildAuthorizeUrl assembles all params')

  // No prompt when unspecified.
  const u2 = new URL(buildAuthorizeUrl(cfg, { state: 'x' }))
  if (u2.searchParams.has('prompt')) fail('authorize url', 'prompt should be absent by default')
  if (u2.searchParams.get('access_type') !== 'offline') {
    fail('authorize url', 'access_type should default to offline (refresh_token required)')
  }
  pass('access_type defaults to offline; prompt omitted when unspecified')
}

// ── 3. exchangeCodeForTokens ───────────────────────────────────────────

function mockFetch(handler: (url: string, body: URLSearchParams) => { status: number; body: unknown }): FetchLike {
  return async (url, init) => {
    const body = init.body as URLSearchParams
    const { status, body: responseBody } = handler(url, body)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
    }
  }
}

{
  const cfg = fakeConfig()
  let seen: { url?: string; body?: URLSearchParams } = {}
  const fetchImpl = mockFetch((url, body) => {
    seen = { url, body }
    return {
      status: 200,
      body: {
        access_token: 'ACCESS',
        refresh_token: 'REFRESH',
        scope: 'ZohoPay.payments.READ ZohoPay.refunds.READ',
        token_type: 'Bearer',
        expires_in: 3600,
        api_domain: cfg.paymentsBase,
      },
    }
  })

  const result = await exchangeCodeForTokens(cfg, 'CODE-1', fetchImpl)
  if (seen.url !== `${cfg.accountsBase}/oauth/v2/token`) {
    fail('exchange url', `expected /oauth/v2/token, got ${seen.url}`)
  }
  if (seen.body?.get('grant_type') !== 'authorization_code') {
    fail('exchange body', 'grant_type not set correctly')
  }
  if (seen.body?.get('client_id') !== 'CID' || seen.body?.get('client_secret') !== 'CSECRET') {
    fail('exchange body', 'client credentials not forwarded')
  }
  if (seen.body?.get('code') !== 'CODE-1') fail('exchange body', 'code not forwarded')
  if (result.access_token !== 'ACCESS' || result.refresh_token !== 'REFRESH') {
    fail('exchange result', 'tokens not returned')
  }
  pass('exchangeCodeForTokens success')
}

{
  const cfg = fakeConfig()
  const fetchImpl = mockFetch(() => ({ status: 200, body: { error: 'invalid_code' } }))
  try {
    await exchangeCodeForTokens(cfg, 'BAD', fetchImpl)
    fail('exchange 200-with-error', 'no error thrown for Zoho error in 200 body')
  } catch (err) {
    if (!(err instanceof ZohoOAuthError)) fail('exchange 200-with-error', 'wrong error type')
    if (err.code !== 'invalid_code') fail('exchange 200-with-error', `wrong code: ${err.code}`)
    pass('exchangeCodeForTokens throws on 200-with-error')
  }
}

{
  const cfg = fakeConfig()
  const fetchImpl = mockFetch(() => ({ status: 401, body: { error: 'invalid_client' } }))
  try {
    await exchangeCodeForTokens(cfg, 'x', fetchImpl)
    fail('exchange 401', 'no error thrown for 401')
  } catch (err) {
    if (!(err instanceof ZohoOAuthError)) fail('exchange 401', 'wrong error type')
    if (err.status !== 401) fail('exchange 401', `status not propagated (${err.status})`)
    pass('exchangeCodeForTokens throws on HTTP failure')
  }
}

// Missing required fields in an otherwise-ok body.
{
  const cfg = fakeConfig()
  const fetchImpl = mockFetch(() => ({ status: 200, body: { scope: 'x' } }))
  try {
    await exchangeCodeForTokens(cfg, 'x', fetchImpl)
    fail('exchange bad body', 'accepted a body with no access_token')
  } catch (err) {
    if (!(err instanceof ZohoOAuthError)) fail('exchange bad body', 'wrong error type')
    if (err.code !== 'bad_response') fail('exchange bad body', `wrong code: ${err.code}`)
    pass('exchangeCodeForTokens rejects a payload missing access_token')
  }
}

// ── 4. Scope enforcement ───────────────────────────────────────────────

{
  const cfg = fakeConfig()
  const granted = assertScopesGranted(
    'ZohoPay.payments.READ ZohoPay.refunds.READ',
    cfg.scopes,
  )
  if (granted.length !== 2) fail('scopes', `expected 2, got ${granted.length}`)
  pass('assertScopesGranted accepts the expected set')

  try {
    assertScopesGranted('ZohoPay.payments.READ', cfg.scopes)
    fail('scopes', 'accepted a downgraded scope set')
  } catch (err) {
    if (!(err instanceof ZohoOAuthError)) fail('scopes', 'wrong error type')
    if (err.code !== 'scope_downgrade') fail('scopes', `wrong code: ${err.code}`)
    pass('assertScopesGranted refuses a downgraded scope set')
  }
}

console.log('\nAll Zoho Payments OAuth-layer checks passed.')
