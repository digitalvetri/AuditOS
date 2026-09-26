/**
 * The one door to the Zoho Books REST API. Every page, report and sync goes
 * through `zohoRequest`, which owns:
 *
 *   • the access token — decrypted from the connection row, refreshed a
 *     minute before expiry, one refresh in flight per connection
 *   • retries — reads only, on network/timeout/5xx/short 429; a write is
 *     never repeated because nobody knows whether it landed
 *   • rate limiting — a per-organisation budget under Zoho's per-minute cap
 *   • error normalisation — every Zoho failure becomes a ZohoBooksError the
 *     routes map to a clean HTTP error; raw bodies never reach the browser
 *   • logging — method, path, status and Zoho code only. Never a token,
 *     never a query string (it can carry search text), never a body.
 */
import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import { decryptToken, encryptToken } from '../zpay/crypto.js'
import { exchangeRefreshTokenForAccess, ZohoOAuthError, type FetchLike } from '../zpay/oauth.js'
import { booksConfig, isTrustedZohoHost } from './config.js'

export type ZohoErrorKind =
  | 'reconnect' | 'permission' | 'validation' | 'not_found' | 'rate_limit'
  | 'network' | 'timeout' | 'upstream' | 'bad_response'

export class ZohoBooksError extends Error {
  constructor(
    public readonly kind: ZohoErrorKind,
    message: string,
    public readonly zohoCode?: number,
    public readonly httpStatus?: number,
  ) {
    super(message)
    this.name = 'ZohoBooksError'
  }
}

const STATUS: Record<ZohoErrorKind, number> = {
  reconnect: 409, permission: 403, validation: 422, not_found: 404, rate_limit: 429,
  network: 502, timeout: 504, upstream: 502, bad_response: 502,
}
const CODE: Record<ZohoErrorKind, string> = {
  reconnect: 'books_reconnect_required', permission: 'books_forbidden', validation: 'books_validation',
  not_found: 'books_not_found', rate_limit: 'books_rate_limited', network: 'books_unreachable',
  timeout: 'books_timeout', upstream: 'books_upstream_error', bad_response: 'books_bad_response',
}
const FRIENDLY: Partial<Record<ZohoErrorKind, string>> = {
  reconnect: 'The Zoho Books connection has expired or was revoked. Reconnect it in Books → Settings.',
  rate_limit: 'Zoho Books is rate-limiting requests. Wait a minute and try again.',
  network: 'Could not reach Zoho Books. Check the network and try again.',
  timeout: 'Zoho Books took too long to respond. Try again.',
  upstream: 'Zoho Books returned a server error. Try again shortly.',
  bad_response: 'Zoho Books returned a response Audit OS could not read.',
}

/** A clean API error for the browser. Validation messages are Zoho's own user-facing text. */
export function toApiError(err: ZohoBooksError): ApiError {
  const passthrough = err.kind === 'validation' || err.kind === 'not_found' || err.kind === 'permission'
  // Zoho occasionally sends a code with no message; never let that surface as a blank / generic error.
  const message = (passthrough ? err.message : FRIENDLY[err.kind] ?? err.message)
    || `Zoho Books rejected this request${err.zohoCode ? ` (Zoho code ${err.zohoCode})` : ''}. Check the fields and try again.`
  return new ApiError(STATUS[err.kind], CODE[err.kind], message, err.zohoCode ? { zoho_code: err.zohoCode } : undefined)
}

// ── test seam ────────────────────────────────────────────────────────────
type HttpFetch = (url: string, init: RequestInit) => Promise<Response>
let httpFetch: HttpFetch = (url, init) => fetch(url, init)
let oauthFetch: FetchLike | undefined
export function setBooksFetchForTests(f: HttpFetch | null, oauth?: FetchLike | null): void {
  httpFetch = f ?? ((url, init) => fetch(url, init))
  oauthFetch = oauth ?? undefined
}
/** The HTTP functions currently in effect (tests swap them; production uses global fetch). */
export const seams = { http: (): HttpFetch => httpFetch, oauth: (): FetchLike | undefined => oauthFetch }

// ── tokens ───────────────────────────────────────────────────────────────
export interface ConnectionRow {
  id: string
  status: string
  accessTokenEncrypted: string | null
  refreshTokenEncrypted: string | null
  accessTokenExpiresAt: Date | null
  accountsServer: string | null
  apiDomain: string | null
}

const refreshing = new Map<string, Promise<string>>()

async function markConnection(id: string, status: string, code: string): Promise<void> {
  await prisma.booksZohoConnection.update({
    where: { id },
    data: { status, lastErrorCode: code, lastErrorAt: new Date() },
  }).catch(() => undefined)
}

export async function accessTokenFor(conn: ConnectionRow, force = false): Promise<string> {
  if (conn.status !== 'connected' || !conn.refreshTokenEncrypted) {
    throw new ZohoBooksError('reconnect', 'connection is not connected')
  }
  const cfg = booksConfig()
  if (!force && conn.accessTokenEncrypted && conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() > Date.now() + 60_000) {
    return decryptToken(conn.accessTokenEncrypted, cfg.encryptionKey)
  }
  const inflight = refreshing.get(conn.id)
  if (inflight) return inflight
  const p = (async () => {
    const refreshToken = decryptToken(conn.refreshTokenEncrypted!, cfg.encryptionKey)
    const accountsBase = conn.accountsServer && isTrustedZohoHost(conn.accountsServer, cfg) ? conn.accountsServer : cfg.accountsBase
    try {
      const t = await exchangeRefreshTokenForAccess({ ...cfg, accountsBase }, refreshToken, oauthFetch)
      const expiresAt = new Date(Date.now() + (t.expires_in - 60) * 1000)
      const accessTokenEncrypted = encryptToken(t.access_token, cfg.encryptionKey)
      await prisma.booksZohoConnection.update({
        where: { id: conn.id },
        data: { accessTokenEncrypted, accessTokenExpiresAt: expiresAt },
      })
      conn.accessTokenEncrypted = accessTokenEncrypted
      conn.accessTokenExpiresAt = expiresAt
      return t.access_token
    } catch (err) {
      if (err instanceof ZohoOAuthError && (err.code === 'invalid_code' || err.code === 'invalid_grant' || err.code === 'invalid_client')) {
        // The grant is gone (revoked in Zoho, or the refresh token expired):
        // stop retrying, the user must re-consent.
        await markConnection(conn.id, 'revoked', err.code)
        throw new ZohoBooksError('reconnect', `refresh refused: ${err.code}`)
      }
      console.warn('[books] token refresh failed', err instanceof ZohoOAuthError ? err.code : 'network')
      throw new ZohoBooksError('network', 'token refresh failed')
    }
  })()
  refreshing.set(conn.id, p)
  try {
    return await p
  } finally {
    refreshing.delete(conn.id)
  }
}

// ── rate limit: stay under Zoho's 100 requests/minute/organisation ───────
const WINDOW_MS = 60_000
const BUDGET = Number(process.env.ZBOOKS_RATE_PER_MINUTE ?? 90)
const calls = new Map<string, number[]>()
function takeBudget(zohoOrgId: string): void {
  const now = Date.now()
  const recent = (calls.get(zohoOrgId) ?? []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= BUDGET) throw new ZohoBooksError('rate_limit', 'local per-minute budget exhausted')
  recent.push(now)
  calls.set(zohoOrgId, recent)
}

// ── short read cache, invalidated by any write to the same organisation ──
const CACHE_TTL_MS = 30_000
const cache = new Map<string, { at: number; data: unknown }>()
export function clearBooksCacheForTests(): void { cache.clear(); calls.clear() }
export function invalidateOrgCache(zohoOrgId: string): void {
  for (const k of cache.keys()) if (k.startsWith(`${zohoOrgId}|`)) cache.delete(k)
}

// ── the request ──────────────────────────────────────────────────────────
export interface ZohoRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  query?: Record<string, string | number | boolean | undefined | null>
  body?: unknown
  form?: FormData
  /** Return the raw Response body as bytes (PDF). */
  binary?: boolean
  cache?: boolean
}

export interface ZohoContext {
  conn: ConnectionRow
  /** Zoho's organization_id; null only for GET /organizations. */
  zohoOrgId: string | null
  /** Counts every HTTP call, for the sync log. */
  counter?: { calls: number }
}

const TIMEOUT_MS = 25_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function apiBase(conn: ConnectionRow): string {
  const cfg = booksConfig()
  const domain = conn.apiDomain && isTrustedZohoHost(conn.apiDomain, cfg) ? conn.apiDomain.replace(/\/$/, '') : 'https://www.zohoapis.in'
  return `${domain}/books/v3`
}

function classify(httpStatus: number, zohoCode: number | undefined, message: string): ZohoBooksError {
  if (httpStatus === 401 || zohoCode === 14) return new ZohoBooksError('reconnect', message, zohoCode, httpStatus)
  if (httpStatus === 429 || zohoCode === 44 || zohoCode === 45) return new ZohoBooksError('rate_limit', message, zohoCode, httpStatus)
  if (httpStatus === 403 || zohoCode === 57) return new ZohoBooksError('permission', message || 'Your Zoho Books user is not allowed to do this.', zohoCode, httpStatus)
  if (httpStatus === 404) return new ZohoBooksError('not_found', message || 'This record no longer exists in Zoho Books.', zohoCode, httpStatus)
  if (httpStatus >= 500) return new ZohoBooksError('upstream', message, zohoCode, httpStatus)
  return new ZohoBooksError('validation', message || 'Zoho Books rejected the request.', zohoCode, httpStatus)
}

export async function zohoRequest<T = Record<string, unknown>>(ctx: ZohoContext, req: ZohoRequest): Promise<T> {
  const method = req.method ?? 'GET'
  const params = new URLSearchParams()
  if (ctx.zohoOrgId) params.set('organization_id', ctx.zohoOrgId)
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined && v !== null && v !== '') params.set(k, String(v))
  const url = `${apiBase(ctx.conn)}/${req.path.replace(/^\//, '')}?${params.toString()}`

  // Keyed by connection too: the same Zoho org reached through two firms'
  // grants must never share a response.
  const cacheKey = `${ctx.zohoOrgId ?? '-'}|${ctx.conn.id}|${url}`
  if (method === 'GET' && req.cache !== false && !req.binary) {
    const hit = cache.get(cacheKey)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data as T
  }

  let forcedRefresh = false
  for (let attempt = 0; ; attempt++) {
    if (ctx.zohoOrgId) takeBudget(ctx.zohoOrgId)
    const token = await accessTokenFor(ctx.conn, forcedRefresh)
    const headers: Record<string, string> = { Authorization: `Zoho-oauthtoken ${token}`, Accept: req.binary ? 'application/pdf' : 'application/json' }
    let body: FormData | string | undefined
    if (req.form) body = req.form
    else if (req.body !== undefined) { body = JSON.stringify(req.body); headers['Content-Type'] = 'application/json' }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
    let res: Response
    try {
      if (ctx.counter) ctx.counter.calls++
      res = await httpFetch(url, { method, headers, body, signal: ac.signal })
    } catch (e) {
      clearTimeout(timer)
      const kind: ZohoErrorKind = (e as Error)?.name === 'AbortError' ? 'timeout' : 'network'
      console.warn('[books] zoho', method, req.path, kind)
      if (method === 'GET' && attempt < 2) { await sleep(400 * 2 ** attempt); continue }
      throw new ZohoBooksError(kind, kind === 'timeout' ? 'Zoho Books timed out' : 'Zoho Books unreachable')
    }
    clearTimeout(timer)

    if (res.ok && req.binary) {
      return Buffer.from(await res.arrayBuffer()) as unknown as T
    }

    let payload: { code?: number; message?: string } & Record<string, unknown>
    try {
      payload = (await res.json()) as typeof payload
    } catch {
      console.warn('[books] zoho', method, req.path, res.status, 'non-json')
      if (method === 'GET' && res.status >= 500 && attempt < 2) { await sleep(400 * 2 ** attempt); continue }
      throw res.ok ? new ZohoBooksError('bad_response', 'non-JSON response') : classify(res.status, undefined, '')
    }

    const zohoCode = typeof payload.code === 'number' ? payload.code : undefined
    if (res.ok && (zohoCode === undefined || zohoCode === 0)) {
      if (method === 'GET' && !req.binary) cache.set(cacheKey, { at: Date.now(), data: payload })
      else if (ctx.zohoOrgId) invalidateOrgCache(ctx.zohoOrgId)
      return payload as T
    }

    const err = classify(res.status, zohoCode, typeof payload.message === 'string' ? payload.message : '')
    // Zoho's message names the offending field ("Invalid value passed for …") — no secrets, and it is what diagnoses a 4xx.
    console.warn('[books] zoho', method, req.path, res.status, zohoCode ?? '-', err.kind, typeof payload.message === 'string' ? JSON.stringify(payload.message.slice(0, 200)) : '')
    if (err.kind === 'reconnect' && !forcedRefresh) {
      // Zoho can revoke an access token before its stated expiry; one forced
      // refresh tells a stale token from a revoked grant.
      forcedRefresh = true
      continue
    }
    if (err.kind === 'reconnect') await markConnection(ctx.conn.id, 'expired', `zoho_${zohoCode ?? res.status}`)
    const retryAfter = Number(res.headers.get('retry-after') ?? '')
    const retryable = err.kind === 'upstream' || (err.kind === 'rate_limit' && retryAfter > 0 && retryAfter <= 5)
    if (method === 'GET' && retryable && attempt < 2) {
      await sleep(err.kind === 'rate_limit' ? retryAfter * 1000 : 400 * 2 ** attempt)
      continue
    }
    throw err
  }
}

/**
 * Page through a Zoho list. `stop` lets a caller end early (e.g. a list
 * sorted by date descending, once it has passed the start of a period).
 * `truncated` is true when maxPages ran out before Zoho did.
 */
export async function zohoListAll<T = Record<string, unknown>>(
  ctx: ZohoContext,
  path: string,
  listKey: string,
  query: Record<string, string | number | undefined> = {},
  opts: { maxPages?: number; stop?: (row: T) => boolean } = {},
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = []
  const maxPages = opts.maxPages ?? 5
  for (let page = 1; page <= maxPages; page++) {
    const res = await zohoRequest<Record<string, unknown>>(ctx, { path, query: { ...query, page, per_page: 200 } })
    const batch = (res[listKey] as T[] | undefined) ?? []
    for (const r of batch) {
      if (opts.stop?.(r)) return { rows, truncated: false }
      rows.push(r)
    }
    const more = (res.page_context as { has_more_page?: boolean } | undefined)?.has_more_page
    if (!more) return { rows, truncated: false }
  }
  return { rows, truncated: true }
}
