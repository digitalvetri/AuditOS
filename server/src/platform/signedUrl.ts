import crypto from 'node:crypto'
import { env } from '../lib/env.js'
import { ApiError } from '../lib/http.js'

/**
 * Payslip PDFs and document downloads are served through short-lived signed
 * URLs, never a guessable public path (§8.8 / §11). The signature binds the
 * resource, the subject user and an expiry, and is verified in constant time.
 */
export interface SignedLink {
  url: string
  expires_at: string
}

export function signResource(resource: string, subjectUserId: string): { token: string; expiresAt: Date } {
  const exp = Math.floor(Date.now() / 1000) + env.signedUrlTtlSeconds
  const sig = crypto
    .createHmac('sha256', env.signedUrlSecret)
    .update(`${resource}.${subjectUserId}.${exp}`)
    .digest('hex')
  return {
    token: `${exp}.${subjectUserId}.${sig}`,
    expiresAt: new Date(exp * 1000),
  }
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
  const expected = crypto
    .createHmac('sha256', env.signedUrlSecret)
    .update(`${resource}.${sub}.${exp}`)
    .digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(sig)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ApiError(403, 'invalid_token', 'Invalid or expired token.')
  }
  return sub
}

export function signedLink(basePath: string, resource: string, subjectUserId: string): SignedLink {
  const { token, expiresAt } = signResource(resource, subjectUserId)
  return {
    url: `${basePath}?t=${encodeURIComponent(token)}`,
    expires_at: expiresAt.toISOString(),
  }
}
