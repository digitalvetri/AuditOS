/**
 * Zoho OAuth helpers — pure functions that do exactly the two things the
 * flow needs, and nothing else:
 *
 *   1. build the authorize URL (browser redirect target)
 *   2. exchange an authorization code for tokens (server-to-server POST)
 *
 * The `fetch` used for step 2 is injectable so a test can drive the flow
 * without a real HTTP stack and without spawning the express app. In
 * production the global `fetch` (Node ≥ 18) is used.
 *
 * Spec constraints enforced here:
 *   • exactly two READ scopes, no more (§1)
 *   • the token endpoint is `/oauth/v2/token` on accounts.zoho.in in live
 *     mode; §1 forbids accounts.zoho.com for Indian accounts.
 *   • the authorization code is single-use and short-lived — the callback
 *     exchanges it synchronously. The service layer holds that guarantee;
 *     this file's job is just to make the exchange call.
 */
import type { ZpayConfig } from './config.js'

/**
 * The slice of a Zoho OAuth client these helpers read. Zoho Payments passes
 * its full ZpayConfig; the Books integration (modules/books) passes its own
 * config, which is why this is structural rather than ZpayConfig itself.
 */
export type ZohoOAuthClient = Pick<ZpayConfig, 'clientId' | 'clientSecret' | 'redirectUri' | 'accountsBase'> & {
  readonly scopes: readonly string[]
}

export interface AuthorizeUrlInput {
  state: string
  /**
   * offline: needed so the response includes a refresh_token. Zoho only
   * returns a refresh_token when access_type=offline is set on consent.
   */
  accessType?: 'online' | 'offline'
  /**
   * prompt=consent forces the consent screen even if the user has already
   * granted the scopes. Useful for a re-consent that must return a fresh
   * refresh token — a silent grant will reuse the old one.
   */
  prompt?: 'consent'
}

export function buildAuthorizeUrl(config: ZohoOAuthClient, input: AuthorizeUrlInput): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    scope: config.scopes.join(' '),
    redirect_uri: config.redirectUri,
    state: input.state,
    access_type: input.accessType ?? 'offline',
  })
  if (input.prompt) params.set('prompt', input.prompt)
  return `${config.accountsBase}/oauth/v2/auth?${params.toString()}`
}

/**
 * Zoho's token response fields. `refresh_token` is only present on the
 * first exchange (when access_type=offline was set on consent); subsequent
 * refresh calls return only a new access_token.
 */
export interface ZohoTokenResponse {
  access_token: string
  refresh_token?: string
  scope: string
  token_type: string
  expires_in: number
  api_domain?: string
}

export interface ZohoTokenError {
  error: string
}

export type FetchLike = (
  url: string,
  init: { method: string; body?: URLSearchParams; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export class ZohoOAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'ZohoOAuthError'
  }
}

/**
 * Exchange an authorization code for tokens. Throws ZohoOAuthError on any
 * non-ok response OR when Zoho returns a 200 with an `error` field
 * (which it does, e.g. `invalid_code` reads 200 in some versions).
 */
export async function exchangeCodeForTokens(
  config: ZohoOAuthClient,
  code: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<ZohoTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
  })
  // A Self Client grant code was issued without a redirect, so none is sent
  // with it; a browser-flow code must repeat the redirect it was issued for.
  if (config.redirectUri) body.set('redirect_uri', config.redirectUri)
  const url = `${config.accountsBase}/oauth/v2/token`
  const res = await fetchImpl(url, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    throw new ZohoOAuthError('bad_response', 'Zoho returned a non-JSON body', res.status)
  }
  if (!res.ok) {
    const err = (payload as ZohoTokenError | undefined)?.error ?? 'http_error'
    throw new ZohoOAuthError(err, `Zoho token endpoint returned ${res.status}`, res.status)
  }
  const p = payload as Partial<ZohoTokenResponse> & Partial<ZohoTokenError>
  if (p.error) {
    throw new ZohoOAuthError(p.error, `Zoho refused the code: ${p.error}`, res.status)
  }
  if (!p.access_token || typeof p.expires_in !== 'number') {
    throw new ZohoOAuthError(
      'bad_response',
      'Zoho response missing access_token or expires_in',
      res.status,
    )
  }
  return p as ZohoTokenResponse
}

/**
 * Refresh an access token. Zoho only returns a fresh `refresh_token` on
 * the first exchange; refresh calls return an access_token only, and
 * the refresh_token in the DB stays as-is.
 *
 * On `invalid_grant` the caller must treat the connection as revoked
 * (spec §3: STOP RETRYING). Any other failure — network, rate limit,
 * 5xx — is transient and should be retried later.
 */
export async function exchangeRefreshTokenForAccess(
  config: ZohoOAuthClient,
  refreshToken: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<Omit<ZohoTokenResponse, 'refresh_token'>> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
  })
  const url = `${config.accountsBase}/oauth/v2/token`
  const res = await fetchImpl(url, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    throw new ZohoOAuthError('bad_response', 'Zoho returned a non-JSON body on refresh', res.status)
  }
  if (!res.ok) {
    const err = (payload as ZohoTokenError | undefined)?.error ?? 'http_error'
    throw new ZohoOAuthError(err, `Zoho refresh returned ${res.status}`, res.status)
  }
  const p = payload as Partial<ZohoTokenResponse> & Partial<ZohoTokenError>
  if (p.error) {
    throw new ZohoOAuthError(p.error, `Zoho refused the refresh: ${p.error}`, res.status)
  }
  if (!p.access_token || typeof p.expires_in !== 'number') {
    throw new ZohoOAuthError(
      'bad_response',
      'Zoho refresh missing access_token or expires_in',
      res.status,
    )
  }
  return p as Omit<ZohoTokenResponse, 'refresh_token'>
}

/**
 * Parse and validate the scope string Zoho returned. A missing or
 * downgraded scope is a hard failure — spec §7 acceptance requires that
 * exactly the two READ scopes were granted.
 */
export function assertScopesGranted(returned: string, required: readonly string[]): string[] {
  const granted = returned.trim().split(/\s+/).filter(Boolean)
  const missing = required.filter((s) => !granted.includes(s))
  if (missing.length) {
    throw new ZohoOAuthError(
      'scope_downgrade',
      `Zoho did not grant required scopes: ${missing.join(', ')}`,
    )
  }
  return granted
}
