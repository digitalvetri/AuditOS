import crypto from 'node:crypto'
import { Prisma } from '@prisma/client'
import { env } from '../lib/env.js'
import { ApiError } from '../lib/http.js'
import { prisma } from '../lib/prisma.js'

/**
 * Payslip PDFs and document downloads are served through signed URLs, never a
 * guessable public path (§8.8 / §11). The signature binds the resource, the
 * subject user and an expiry, and is verified in constant time.
 *
 * Two flavours, with different HMAC keys:
 *   - `signedLink`      — short-lived (default 5 min), SIGNED_URL_SECRET.
 *     For in-app downloads where the signer is still logged in.
 *     Token: `exp.subject.hmac`.
 *   - `permanentLink`   — PERMANENT_LINK_TTL_DAYS (default 365 days),
 *     PERMANENT_LINK_SECRET. For links pasted into an email or WhatsApp
 *     message and clicked days or weeks later by a client who is not logged
 *     in here. Token: `exp.subject.hmac.iat` — the issue time (ms) is signed
 *     too, so "revoke every link issued before now" can be enforced.
 *     Tokens issued before the iat part existed (3 parts, 100-year expiry)
 *     are still accepted; their issue time is taken as exp − 100 years.
 *
 * `verifyResourceToken` (sync) accepts ONLY short-lived tokens.
 * `verifyLinkToken` (async) accepts both, and for a permanent link also
 * checks revocation and that the user who shared it is still active — one
 * indexed round trip. Separate secrets mean rotating one does not invalidate
 * the other.
 */
export interface SignedLink {
  url: string
  expires_at: string
}

/** The expiry every permanent link had before PERMANENT_LINK_TTL_DAYS. */
const LEGACY_PERMANENT_TTL_SECONDS = 100 * 365 * 24 * 60 * 60

const permanentTtlSeconds = () => Math.round(env.permanentLinkTtlDays * 24 * 60 * 60)

function sign(key: string, resource: string, subjectUserId: string, exp: number, iat?: number): string {
  const data = iat === undefined
    ? `${resource}.${subjectUserId}.${exp}`
    : `${resource}.${subjectUserId}.${exp}.${iat}`
  return crypto.createHmac('sha256', key).update(data).digest('hex')
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

export function signResource(resource: string, subjectUserId: string, ttlSeconds = env.signedUrlTtlSeconds): { token: string; expiresAt: Date } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  return { token: `${exp}.${subjectUserId}.${sign(env.signedUrlSecret, resource, subjectUserId, exp)}`, expiresAt: new Date(exp * 1000) }
}

/** A shareable token valid for PERMANENT_LINK_TTL_DAYS, carrying its issue time. */
export function signPermanentResource(resource: string, subjectUserId: string, now = Date.now()): { token: string; expiresAt: Date } {
  const iat = now
  const exp = Math.floor(now / 1000) + permanentTtlSeconds()
  const sig = sign(env.permanentLinkSecret, resource, subjectUserId, exp, iat)
  return { token: `${exp}.${subjectUserId}.${sig}.${iat}`, expiresAt: new Date(exp * 1000) }
}

interface ParsedToken {
  subject: string
  permanent: boolean
  /** Issue time in ms — permanent tokens only. */
  issuedAt: number | null
}

function parseAndCheck(resource: string, token: string | undefined, allowPermanent: boolean): ParsedToken {
  if (!token) throw new ApiError(403, 'missing_token', 'Token required.')
  const parts = token.split('.')
  if (parts.length !== 3 && parts.length !== 4) throw new ApiError(403, 'invalid_token', 'Invalid or expired token.')
  const [exp, sub, sig, iatRaw] = parts
  const expiry = Number(exp)
  if (!Number.isFinite(expiry) || expiry * 1000 < Date.now()) {
    throw new ApiError(403, 'invalid_token', 'This link has expired. Open the document again.')
  }
  if (parts.length === 4) {
    // Only permanent links carry an issue time.
    const iat = Number(iatRaw)
    if (allowPermanent && Number.isSafeInteger(iat) && same(sign(env.permanentLinkSecret, resource, sub, expiry, iat), sig)) {
      return { subject: sub, permanent: true, issuedAt: iat }
    }
    throw new ApiError(403, 'invalid_token', 'Invalid or expired token.')
  }
  if (same(sign(env.signedUrlSecret, resource, sub, expiry), sig)) {
    return { subject: sub, permanent: false, issuedAt: null }
  }
  if (allowPermanent && same(sign(env.permanentLinkSecret, resource, sub, expiry), sig)) {
    // A pre-iat permanent link: it was minted with a 100-year expiry.
    return { subject: sub, permanent: true, issuedAt: (expiry - LEGACY_PERMANENT_TTL_SECONDS) * 1000 }
  }
  throw new ApiError(403, 'invalid_token', 'Invalid or expired token.')
}

/**
 * Short-lived tokens only (in-app downloads). Synchronous — a shared
 * (permanent) link is never accepted here, because accepting one needs the
 * revocation check in `verifyLinkToken`.
 */
export function verifyResourceToken(resource: string, token: string | undefined): string {
  return parseAndCheck(resource, token, false).subject
}

/**
 * Short-lived OR shared (permanent) tokens. A shared link is refused when it
 * was issued before the resource's revocation cut-off, or when the user who
 * shared it is no longer active. Returns the subject user id.
 */
export async function verifyLinkToken(resource: string, token: string | undefined): Promise<{ subject: string; permanent: boolean }> {
  const t = parseAndCheck(resource, token, true)
  if (!t.permanent) return { subject: t.subject, permanent: false }
  // One round trip: two primary-key lookups as scalar subqueries.
  const rows = await prisma.$queryRaw<{ revoked_before: Date | null; user_ok: boolean | null }[]>(Prisma.sql`
    SELECT
      (SELECT "revokedBefore" FROM "SharedLinkRevocation" WHERE "resource" = ${resource}) AS revoked_before,
      (SELECT ("isActive" AND "deletedAt" IS NULL) FROM "User" WHERE "id" = ${t.subject}) AS user_ok
  `)
  const row = rows[0]
  if (!row?.user_ok) {
    throw new ApiError(403, 'link_revoked', 'This link is no longer valid. Ask the sender for a new one.')
  }
  if (row.revoked_before && row.revoked_before.getTime() >= (t.issuedAt ?? 0)) {
    throw new ApiError(403, 'link_revoked', 'This link has been withdrawn. Ask the sender for a new one.')
  }
  return { subject: t.subject, permanent: true }
}

/** Revoke every shared link to `resource` issued up to now. */
export async function revokeSharedLinks(resource: string, revokedBy: string | null, now = new Date()): Promise<Date> {
  await prisma.sharedLinkRevocation.upsert({
    where: { resource },
    create: { resource, revokedBefore: now, revokedBy },
    update: { revokedBefore: now, revokedBy },
  })
  return now
}

export function signedLink(basePath: string, resource: string, subjectUserId: string, ttlSeconds?: number): SignedLink {
  const { token, expiresAt } = signResource(resource, subjectUserId, ttlSeconds)
  return { url: `${basePath}?t=${encodeURIComponent(token)}`, expires_at: expiresAt.toISOString() }
}

/** Absolute URL with a long-lived, revocable token. For links a client receives by email or WhatsApp. */
export function permanentLink(basePath: string, resource: string, subjectUserId: string): SignedLink {
  const { token, expiresAt } = signPermanentResource(resource, subjectUserId)
  return { url: `${basePath}?t=${encodeURIComponent(token)}`, expires_at: expiresAt.toISOString() }
}
