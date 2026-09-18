/**
 * OAuth service — the two things the routes call, factored so a test can
 * exercise them without an HTTP client.
 *
 *   beginConsent(...)     transitions the connection to consent_pending and
 *                         returns the URL the browser should visit
 *   completeConsent(...)  invoked by /callback: verifies state, exchanges
 *                         the code SYNCHRONOUSLY (spec §1: one-minute
 *                         window), encrypts tokens, transitions to connected
 *
 * The state parameter is a JWT signed with the existing JWT_SECRET. That
 * lets the callback prove the code came from a request we started, without
 * a shared cookie between /authorize and /callback — which is important
 * because the callback is public (Zoho hits it via a browser redirect from
 * accounts.zoho.in, without our session cookie in same-site scope).
 */
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { env } from '../../lib/env.js'
import { ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { assertTransition, type ZpayStatus } from './state.js'
import { zpayConfig } from './config.js'
import { encryptToken } from './crypto.js'
import {
  assertScopesGranted,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  ZohoOAuthError,
  type FetchLike,
} from './oauth.js'

const STATE_TTL_SECONDS = 10 * 60

interface StatePayload {
  cid: string
  uid: string
  oid: string
  /** Fresh random per authorize; not deduped for step 2, added when replay
   *  becomes a real concern (see notes in the PR body). */
  n: string
}

function signState(payload: StatePayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: STATE_TTL_SECONDS })
}

function verifyState(token: string): StatePayload {
  try {
    const raw = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload
    if (typeof raw.cid !== 'string' || typeof raw.uid !== 'string' ||
        typeof raw.oid !== 'string' || typeof raw.n !== 'string') {
      throw new ApiError(400, 'invalid_state', 'OAuth state payload is malformed')
    }
    return { cid: raw.cid, uid: raw.uid, oid: raw.oid, n: raw.n }
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError(400, 'invalid_state', 'OAuth state failed to verify')
  }
}

export interface BeginConsentInput {
  connectionId: string
  userId: string
  organisationId: string
}

export interface BeginConsentResult {
  authorizeUrl: string
}

export async function beginConsent(input: BeginConsentInput): Promise<BeginConsentResult> {
  const cfg = zpayConfig()
  const conn = await prisma.zpayConnection.findFirst({
    where: { id: input.connectionId, organisationId: input.organisationId, deletedAt: null },
  })
  if (!conn) throw ApiError.notFound('No such Zoho Payments connection.')

  assertTransition(conn.status as ZpayStatus, 'consent_pending')

  const state = signState({
    cid: conn.id,
    uid: input.userId,
    oid: input.organisationId,
    n: crypto.randomBytes(16).toString('hex'),
  })

  await prisma.zpayConnection.update({
    where: { id: conn.id },
    data: {
      status: 'consent_pending',
      updatedBy: input.userId,
      // consent_pending has no timestamp column in the schema; last_error_at
      // stays untouched. connectedAt is only stamped on the transition to
      // `connected`.
    },
  })

  const authorizeUrl = buildAuthorizeUrl(cfg, {
    state,
    accessType: 'offline',
    prompt: 'consent',
  })
  return { authorizeUrl }
}

export interface CompleteConsentInput {
  code: string
  state: string
  /** Injected for tests; defaults to global fetch in production. */
  fetchImpl?: FetchLike
}

export interface CompleteConsentResult {
  connectionId: string
  status: 'connected'
}

export async function completeConsent(
  input: CompleteConsentInput,
): Promise<CompleteConsentResult> {
  const cfg = zpayConfig()
  const parsed = verifyState(input.state)

  const conn = await prisma.zpayConnection.findFirst({
    where: { id: parsed.cid, organisationId: parsed.oid, deletedAt: null },
  })
  if (!conn) throw ApiError.notFound('No such Zoho Payments connection.')

  // Idempotent completion — the callback is a browser GET, which can fire
  // twice for the same successful consent (a back-then-forward, a
  // duplicate history entry, an eager preloader). A signed state token
  // guaranteed to be one of ours plus a `connected` row means the prior
  // callback already ran; treat this hit as a no-op instead of throwing
  // a `connected → connected` illegal transition.
  if (conn.status === 'connected') {
    return { connectionId: conn.id, status: 'connected' }
  }

  assertTransition(conn.status as ZpayStatus, 'connected')

  let tokens
  try {
    tokens = await exchangeCodeForTokens(cfg, input.code, input.fetchImpl)
  } catch (err) {
    // Any Zoho refusal here is `consent_pending → error`: we asked for the
    // token and Zoho declined. The user must re-consent from scratch.
    await prisma.zpayConnection.update({
      where: { id: conn.id },
      data: {
        status: 'error',
        lastErrorCode: err instanceof ZohoOAuthError ? err.code : 'exchange_failed',
        lastErrorAt: new Date(),
      },
    })
    throw err
  }

  const grantedScopes = assertScopesGranted(tokens.scope, cfg.scopes)

  const now = Date.now()
  // Refresh proactively — spec §1: never on a 401. We stamp expiry a full
  // minute before Zoho's own clock so the scheduler that lands in step 2b
  // has a comfortable margin.
  const expiresAt = new Date(now + (tokens.expires_in - 60) * 1000)

  await prisma.zpayConnection.update({
    where: { id: conn.id },
    data: {
      status: 'connected',
      accessTokenEncrypted: encryptToken(tokens.access_token, cfg.encryptionKey),
      // Zoho only returns a refresh_token on the first exchange. On
      // subsequent re-consents (prompt=consent) it returns one again; but
      // if a caller loops beginConsent→completeConsent without a full
      // consent, tokens.refresh_token can legitimately be undefined.
      refreshTokenEncrypted: tokens.refresh_token
        ? encryptToken(tokens.refresh_token, cfg.encryptionKey)
        : conn.refreshTokenEncrypted,
      accessTokenExpiresAt: expiresAt,
      scopesGranted: grantedScopes,
      connectedAt: new Date(),
      connectedBy: parsed.uid,
      lastErrorCode: null,
      lastErrorAt: null,
      updatedBy: parsed.uid,
    },
  })

  return { connectionId: conn.id, status: 'connected' }
}
