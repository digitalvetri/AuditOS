/**
 * Zoho Books integration config, read from the environment on first use.
 *
 *   ZBOOKS_CLIENT_ID / ZBOOKS_CLIENT_SECRET   Zoho API console "server-based
 *                                              application" credentials
 *   ZBOOKS_REDIRECT_URI     must equal the redirect registered in Zoho;
 *                           defaults to this API's /api/books/callback
 *   ZBOOKS_ACCOUNTS_BASE    accounts host consent starts on (default .in —
 *                           Zoho redirects to the user's own data centre and
 *                           tells us which in the callback)
 *   ZBOOKS_SCOPES           space-separated; default ZohoBooks.fullaccess.all
 *   ZBOOKS_ENCRYPTION_KEY   base64 32-byte AES-256-GCM key for tokens; falls
 *                           back to ZPAY_ENCRYPTION_KEY so one firm key can
 *                           cover both Zoho integrations
 *
 * Unlike Zoho Payments there is no fake mode: Books shows real Zoho data or
 * nothing. Without credentials the module reports `configured: false` and
 * the UI says so, rather than inventing an organisation.
 */
import crypto from 'node:crypto'
import { env } from '../../lib/env.js'

export interface BooksConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  readonly accountsBase: string
  readonly scopes: readonly string[]
  readonly encryptionKey: Buffer
  /** Where the browser is sent after the callback: the web app's Books settings. */
  readonly webReturnUrl: string
}

export class BooksNotConfigured extends Error {
  constructor() {
    super('Zoho Books is not configured on the server (ZBOOKS_CLIENT_ID / ZBOOKS_CLIENT_SECRET).')
    this.name = 'BooksNotConfigured'
  }
}

export function booksConfigured(): boolean {
  return Boolean(process.env.ZBOOKS_CLIENT_ID && process.env.ZBOOKS_CLIENT_SECRET)
}

function readKey(): Buffer {
  const raw = process.env.ZBOOKS_ENCRYPTION_KEY ?? process.env.ZPAY_ENCRYPTION_KEY
  if (raw) {
    const buf = Buffer.from(raw, 'base64')
    if (buf.length !== 32) throw new Error('ZBOOKS_ENCRYPTION_KEY must decode to exactly 32 bytes')
    return buf
  }
  if (env.isProduction) throw new Error('ZBOOKS_ENCRYPTION_KEY is required in production')
  console.warn('[books] ZBOOKS_ENCRYPTION_KEY is not set — generated an ephemeral key. Stored Zoho tokens will not survive a restart.')
  return crypto.randomBytes(32)
}

let cached: BooksConfig | null = null

export function booksConfig(): BooksConfig {
  if (cached) return cached
  if (!booksConfigured()) throw new BooksNotConfigured()
  cached = {
    clientId: process.env.ZBOOKS_CLIENT_ID!,
    clientSecret: process.env.ZBOOKS_CLIENT_SECRET!,
    redirectUri: process.env.ZBOOKS_REDIRECT_URI ?? `http://localhost:${env.port}/api/books/callback`,
    accountsBase: (process.env.ZBOOKS_ACCOUNTS_BASE ?? 'https://accounts.zoho.in').replace(/\/$/, ''),
    scopes: (process.env.ZBOOKS_SCOPES ?? 'ZohoBooks.fullaccess.all').split(/[\s,]+/).filter(Boolean),
    encryptionKey: readKey(),
    webReturnUrl: `${env.webOrigins[0] ?? 'http://localhost:5173'}/books/settings`,
  }
  return cached
}

export function resetBooksConfigForTests(): void {
  cached = null
}

/**
 * Zoho data-centre hosts we will send tokens to. The callback's
 * `accounts-server` and the token response's `api_domain` are both
 * attacker-influencable strings, so they are only ever accepted when they
 * are HTTPS on a Zoho domain (or equal the configured base, for tests).
 */
export function isTrustedZohoHost(url: string, cfg: Pick<BooksConfig, 'accountsBase'>): boolean {
  if (url.replace(/\/$/, '') === cfg.accountsBase) return true
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && /(^|\.)zoho(apis|cloud)?\.(com|in|eu|com\.au|jp|com\.cn|ca|sa|uk)$/.test(u.hostname)
  } catch {
    return false
  }
}
