import crypto from 'node:crypto'
import { env } from '../lib/env.js'
import { ApiError } from '../lib/http.js'

/**
 * Payslip PDFs and document downloads are served through signed URLs, never a
 * guessable public path (§8.8 / §11). The signature binds the resource, the
 * subject user and an expiry, and is verified in constant time.
 *
 * Two flavours share the same token format (`exp.subject.hmac`) but use
 * different HMAC keys:
 *   - `signedLink`      — short-lived (default 5 min), SIGNED_URL_SECRET.
 *     For in-app downloads where the signer is still logged in.
 *   - `permanentLink`   — effectively never expires (100 years), PERMANENT_LINK_SECRET.
 *     For links pasted into an email or WhatsApp message and clicked days or
 *     weeks later by a client who is not logged in here.
 *
 * `verifyResourceToken` accepts either. Separate secrets mean rotating one
 * does not invalidate the other.
 */
export interface SignedLink {
  url: string
  expires_at: string
}

const PERMANENT_TTL_SECONDS = 100 * 365 * 24 * 60 * 60

function sign(key: string, resource: string, subjectUserId: string, exp: number): string {
  return crypto.createHmac('sha256', key).update(`${resource}.${subjectUserId}.${exp}`).digest('hex')
}

export function signResource(resource: string, subjectUserId: string, ttlSeconds = env.signedUrlTtlSeconds): { token: string; expiresAt: Date } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  return { token: `${exp}.${subjectUserId}.${sign(env.signedUrlSecret, resource, subjectUserId, exp)}`, expiresAt: new Date(exp * 1000) }
}

/** 100-year signed token. The exp is still a real timestamp; verification runs the same code path. */
export function signPermanentResource(resource: string, subjectUserId: string): { token: string; expiresAt: Date } {
  const exp = Math.floor(Date.now() / 1000) + PERMANENT_TTL_SECONDS
  return { token: `${exp}.${subjectUserId}.${sign(env.permanentLinkSecret, resource, subjectUserId, exp)}`, expiresAt: new Date(exp * 1000) }
}

export function verifyResourceToken(resource: string, token: string | undefined): string {
  if (!token) throw new ApiError(403, 'missing_token', 'Token required.')
  const parts = token.split('.')
  if (parts.length !== 3) throw new ApiError(403, 'invalid_token', 'Invalid or expired token.')
  const [exp, sub, sig] = parts
  const expiry = Number(exp)
  if (!Number.isFinite(expiry) || expiry * 1000 < Date.now()) {
    throw new ApiError(403, 'invalid_token', 'This link has expired. Open the document again.')
  }
  const got = Buffer.from(sig)
  // Try the permanent secret first (the common case for links a client opens);
  // fall back to the short-lived secret (in-app downloads).
  for (const key of [env.permanentLinkSecret, env.signedUrlSecret]) {
    const expected = Buffer.from(sign(key, resource, sub, expiry))
    if (expected.length === got.length && crypto.timingSafeEqual(expected, got)) return sub
  }
  throw new ApiError(403, 'invalid_token', 'Invalid or expired token.')
}

export function signedLink(basePath: string, resource: string, subjectUserId: string, ttlSeconds?: number): SignedLink {
  const { token, expiresAt } = signResource(resource, subjectUserId, ttlSeconds)
  return { url: `${basePath}?t=${encodeURIComponent(token)}`, expires_at: expiresAt.toISOString() }
}

/** Absolute URL with a 100-year token. Used for links a client receives by email or WhatsApp. */
export function permanentLink(basePath: string, resource: string, subjectUserId: string): SignedLink {
  const { token, expiresAt } = signPermanentResource(resource, subjectUserId)
  return { url: `${basePath}?t=${encodeURIComponent(token)}`, expires_at: expiresAt.toISOString() }
}
