/**
 * Zoho Payments integration config. Read from environment on first use so a
 * test can override before boot and a route handler cannot accidentally hold
 * onto a stale value.
 *
 * Two modes:
 *
 *   fake  — the in-process /fake-zoho router stands in for accounts.zoho.in
 *           and payments.zoho.in. Credentials are manufactured so a boot
 *           without a Zoho developer app still works. Never used in
 *           production (asserted below).
 *   live  — real Zoho. Every required credential must be present, and the
 *           bases are the .in hosts (spec §1 — never .com for Indian
 *           accounts).
 *
 * Encryption:
 *   ZPAY_ENCRYPTION_KEY is a base64-encoded 32-byte key for AES-256-GCM.
 *   Missing in production is a boot failure. In development we generate an
 *   ephemeral key so nothing crashes on startup, and print a warning — a
 *   restart invalidates every stored refresh token, which is the point.
 */
import crypto from 'node:crypto'
import { env as baseEnv } from '../../lib/env.js'

export type ZpayMode = 'fake' | 'live'

export interface ZpayConfig {
  readonly mode: ZpayMode
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  /** Base URL for OAuth (authorize + token). `accounts.zoho.in` in live. */
  readonly accountsBase: string
  /** Base URL for the payments REST API. `payments.zoho.in` in live. */
  readonly paymentsBase: string
  /** Exactly two READ scopes per spec §1. */
  readonly scopes: readonly ['ZohoPay.payments.READ', 'ZohoPay.refunds.READ']
  readonly encryptionKey: Buffer
}

const SCOPES = ['ZohoPay.payments.READ', 'ZohoPay.refunds.READ'] as const

function readMode(): ZpayMode {
  const raw = process.env.ZPAY_MODE?.toLowerCase()
  if (raw && raw !== 'fake' && raw !== 'live') {
    throw new Error(`ZPAY_MODE must be "fake" or "live" (got "${raw}")`)
  }
  // Default: fake in development, live in production. This is the shape
  // an operator expects — a dev laptop should just work; a real deployment
  // should not silently mount a fake token issuer if someone forgot to set
  // the variable.
  const mode = (raw as ZpayMode | undefined) ?? (baseEnv.isProduction ? 'live' : 'fake')
  if (mode === 'fake' && baseEnv.isProduction) {
    throw new Error('ZPAY_MODE=fake is not allowed in production. Set ZPAY_MODE=live.')
  }
  return mode
}

/**
 * A boot-safe view of the mode used by `app.ts` to decide whether to mount
 * the fake Zoho router. Never throws when zpay is simply not configured —
 * a production deployment without Zoho credentials must still be able to
 * start; only an actual zpay endpoint call touches full `zpayConfig()`.
 */
export function zpayShouldMountFake(): boolean {
  try {
    return readMode() === 'fake'
  } catch {
    // Bad ZPAY_MODE value or fake-in-production: don't mount the fake, and
    // let full config resolution throw later when someone actually calls
    // a zpay endpoint.
    return false
  }
}

function readCredential(name: string, mode: ZpayMode): string {
  const value = process.env[name]
  if (value && value.length > 0) return value
  if (mode === 'live') {
    throw new Error(`${name} is required when ZPAY_MODE=live`)
  }
  // Fake mode: manufacture something deterministic-looking so logs and error
  // messages read sensibly. Never used against a real Zoho endpoint because
  // fake mode never talks to one.
  return `fake-${name.toLowerCase().replaceAll('_', '-')}`
}

function readEncryptionKey(): Buffer {
  const raw = process.env.ZPAY_ENCRYPTION_KEY
  if (raw) {
    let buf: Buffer
    try {
      buf = Buffer.from(raw, 'base64')
    } catch {
      throw new Error('ZPAY_ENCRYPTION_KEY must be valid base64')
    }
    if (buf.length !== 32) {
      throw new Error(
        `ZPAY_ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256 (got ${buf.length})`,
      )
    }
    return buf
  }
  if (baseEnv.isProduction) {
    throw new Error('ZPAY_ENCRYPTION_KEY is required in production')
  }
  // Ephemeral key: restart invalidates every stored refresh token. That is
  // safer than shipping a well-known development literal, and it matches how
  // JWT_SECRET is handled in lib/env.ts.
  console.warn(
    '[zpay] ZPAY_ENCRYPTION_KEY is not set — generated an ephemeral key. ' +
      'Stored tokens will not survive a restart.',
  )
  return crypto.randomBytes(32)
}

let cached: ZpayConfig | null = null

/**
 * Read the config, memoised per process. `reset()` is exported for tests
 * that mutate process.env between cases; production code should never call it.
 */
export function zpayConfig(): ZpayConfig {
  if (cached) return cached
  const mode = readMode()
  const accountsBase =
    process.env.ZPAY_ACCOUNTS_BASE ??
    (mode === 'live' ? 'https://accounts.zoho.in' : `http://localhost:${baseEnv.port}/fake-zoho`)
  const paymentsBase =
    process.env.ZPAY_PAYMENTS_BASE ??
    (mode === 'live' ? 'https://payments.zoho.in' : `http://localhost:${baseEnv.port}/fake-zoho`)
  const redirectUri =
    process.env.ZPAY_REDIRECT_URI ?? `http://localhost:${baseEnv.port}/api/zpay/callback`

  cached = {
    mode,
    clientId: readCredential('ZPAY_CLIENT_ID', mode),
    clientSecret: readCredential('ZPAY_CLIENT_SECRET', mode),
    redirectUri,
    accountsBase,
    paymentsBase,
    scopes: SCOPES,
    encryptionKey: readEncryptionKey(),
  }
  return cached
}

export function resetZpayConfigForTests(): void {
  cached = null
}
