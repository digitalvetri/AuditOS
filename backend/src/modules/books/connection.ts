/**
 * Zoho Books connection lifecycle.
 *
 *   beginConnect      → consent_pending, returns the Zoho authorize URL
 *   completeConnect   ← /callback: verify signed state, exchange the code
 *                       synchronously (Zoho codes live ~1 minute), encrypt
 *                       tokens, pin the user's data centre, list organisations
 *   refreshOrganizations  re-read GET /organizations for a connection
 *   disconnect        revoke the refresh token at Zoho (best effort), wipe
 *                     tokens, deactivate that connection's organisations
 *
 * The OAuth `state` is a JWT signed with JWT_SECRET, carrying a purpose tag
 * so a Zoho Payments state cannot be replayed here (or vice versa).
 */
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { env } from '../../lib/env.js'
import { ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { encryptToken, decryptToken } from '../zpay/crypto.js'
import { buildAuthorizeUrl, exchangeCodeForTokens, ZohoOAuthError, type FetchLike } from '../zpay/oauth.js'
import { booksConfig, isTrustedZohoHost } from './config.js'
import { accessTokenFor, clientFor, seams, zohoRequest, type ConnectionRow } from './client.js'

const STATE_TTL_SECONDS = 10 * 60
const PURPOSE = 'zoho-books'

/** `rc`: re-consent for a connection that is still live — it stays usable until the new grant lands. */
interface StatePayload { p: string; cid: string; uid: string; oid: string; n: string; rc?: boolean; iat?: number }

export function signState(payload: Omit<StatePayload, 'p' | 'n'>): string {
  return jwt.sign({ ...payload, p: PURPOSE, n: crypto.randomBytes(16).toString('hex') }, env.jwtSecret, { expiresIn: STATE_TTL_SECONDS })
}

export function verifyState(token: string): StatePayload {
  let raw: jwt.JwtPayload
  try {
    raw = jwt.verify(token, env.jwtSecret) as jwt.JwtPayload
  } catch {
    throw new ApiError(400, 'invalid_state', 'The Zoho sign-in link has expired or is invalid. Start again from Books → Settings.')
  }
  if (raw.p !== PURPOSE || typeof raw.cid !== 'string' || typeof raw.uid !== 'string' || typeof raw.oid !== 'string') {
    throw new ApiError(400, 'invalid_state', 'The Zoho sign-in link is invalid. Start again from Books → Settings.')
  }
  return raw as unknown as StatePayload
}

export async function beginConnect(input: { organisationId: string; userId: string; connectionId?: string }): Promise<{ connectionId: string; authorizeUrl: string }> {
  const cfg = booksConfig()
  let conn = input.connectionId
    ? await prisma.booksZohoConnection.findFirst({ where: { id: input.connectionId, organisationId: input.organisationId, deletedAt: null } })
    : null
  if (input.connectionId && !conn) throw ApiError.notFound('No such Zoho Books connection.')
  // A fresh "Connect" reuses an abandoned attempt rather than piling up rows.
  conn ??= await prisma.booksZohoConnection.findFirst({
    where: { organisationId: input.organisationId, deletedAt: null, status: { in: ['not_connected', 'consent_pending', 'error'] }, organizations: { none: {} } },
    orderBy: { createdAt: 'desc' },
  })
  if (!conn) {
    conn = await prisma.booksZohoConnection.create({
      data: { organisationId: input.organisationId, status: 'consent_pending', scopesGranted: [], createdBy: input.userId, updatedBy: input.userId },
    })
  } else if (conn.status !== 'connected') {
    await prisma.booksZohoConnection.update({ where: { id: conn.id }, data: { status: 'consent_pending', updatedBy: input.userId } })
  }
  // Reconnecting a working connection leaves it working: if the Zoho tab is
  // closed, nothing changed. The callback swaps in the new grant.
  const state = signState({ cid: conn.id, uid: input.userId, oid: input.organisationId, ...(conn.status === 'connected' ? { rc: true } : {}) })
  // prompt=consent forces Zoho to issue a fresh refresh token even when the
  // user granted this app before.
  const authorizeUrl = buildAuthorizeUrl(cfg, { state, accessType: 'offline', prompt: 'consent' })
  return { connectionId: conn.id, authorizeUrl }
}

export interface ZohoOrgSummary { organization_id: string; name: string; currency_code?: string; country?: string; is_default_org?: boolean }

export async function completeConnect(input: { code: string; state: string; accountsServer?: string | null; fetchImpl?: FetchLike }): Promise<{ connectionId: string; organisationId: string; userId: string; organizations: number }> {
  const cfg = booksConfig()
  const st = verifyState(input.state)
  const conn = await prisma.booksZohoConnection.findFirst({ where: { id: st.cid, organisationId: st.oid, deletedAt: null } })
  if (!conn) throw ApiError.notFound('No such Zoho Books connection.')
  const reconsent = st.rc === true && conn.status === 'connected'
  // Connected since this link was issued: a repeated browser GET of the same
  // callback — already done. `iat` is whole seconds, so a connection made
  // earlier in that same second must not count; consent takes longer than 1 s.
  const doneSinceIssued = conn.connectedAt && st.iat && conn.connectedAt.getTime() >= (st.iat + 1) * 1000
  if (conn.status === 'connected' && (!reconsent || doneSinceIssued)) {
    return { connectionId: conn.id, organisationId: st.oid, userId: st.uid, organizations: 0 }
  }
  if (conn.status !== 'consent_pending' && !reconsent) throw new ApiError(400, 'invalid_state', 'This connection is not waiting for Zoho consent. Start again from Books → Settings.')

  // Zoho tells us which data centre the user's account lives in; the code
  // must be exchanged there, and only ever on a genuine Zoho host.
  const accountsBase = input.accountsServer && isTrustedZohoHost(input.accountsServer, cfg) ? input.accountsServer.replace(/\/$/, '') : cfg.accountsBase
  const organizations = await exchangeAndStore(conn, { code: input.code, accountsBase, redirectUri: cfg.redirectUri, userId: st.uid, organisationId: st.oid, fetchImpl: input.fetchImpl, keepLive: reconsent })
  return { connectionId: conn.id, organisationId: st.oid, userId: st.uid, organizations }
}

/**
 * Connect with a grant code generated in the Zoho API console (Self Client →
 * Generate Code, scope ZohoBooks.fullaccess.all). No browser redirect is
 * involved, so it works whatever redirect URI the Zoho client has — or none,
 * as with a Self Client. The code is single-use and short-lived (Zoho: 3–10 min).
 */
export async function connectWithCode(input: { organisationId: string; userId: string; code: string; accountsServer?: string | null; fetchImpl?: FetchLike }): Promise<{ connectionId: string; organizations: number }> {
  const cfg = booksConfig()
  const accountsBase = input.accountsServer && isTrustedZohoHost(input.accountsServer, cfg) ? input.accountsServer.replace(/\/$/, '') : cfg.accountsBase
  // Reuse an unfinished attempt (e.g. a browser flow stuck in consent_pending) rather than add rows.
  let conn = await prisma.booksZohoConnection.findFirst({
    where: { organisationId: input.organisationId, deletedAt: null, status: { in: ['not_connected', 'consent_pending', 'error'] }, organizations: { none: {} } },
    orderBy: { createdAt: 'desc' },
  })
  conn ??= await prisma.booksZohoConnection.create({
    data: { organisationId: input.organisationId, status: 'consent_pending', scopesGranted: [], createdBy: input.userId, updatedBy: input.userId },
  })
  const organizations = await exchangeAndStore(conn, { code: input.code, accountsBase, redirectUri: '', userId: input.userId, organisationId: input.organisationId, fetchImpl: input.fetchImpl })
  return { connectionId: conn.id, organizations }
}

/** Exchange a grant code, store the encrypted tokens, mark connected, list organisations. */
async function exchangeAndStore(
  conn: { id: string; clientId?: string | null; clientSecretEncrypted?: string | null },
  input: { code: string; accountsBase: string; redirectUri: string; userId: string; organisationId: string; fetchImpl?: FetchLike; keepLive?: boolean },
): Promise<number> {
  // A failed re-consent records the error but leaves the old, working grant in place.
  const failedStatus = input.keepLive ? 'connected' : 'error'
  const cfg = booksConfig()
  const accountsBase = input.accountsBase
  let tokens
  try {
    tokens = await exchangeCodeForTokens({ ...cfg, ...clientFor(conn), accountsBase, redirectUri: input.redirectUri }, input.code, input.fetchImpl ?? seams.oauth())
  } catch (err) {
    const code = err instanceof ZohoOAuthError ? err.code : 'exchange_failed'
    await prisma.booksZohoConnection.update({ where: { id: conn.id }, data: { status: failedStatus, lastErrorCode: code, lastErrorAt: new Date() } })
    const hint: Record<string, string> = {
      invalid_code: 'The code is wrong, already used or expired — Zoho codes work once and only for a few minutes. Generate a new one.',
      invalid_client: 'Zoho does not recognise this client in that data centre. Check the data centre and ZBOOKS_CLIENT_ID / ZBOOKS_CLIENT_SECRET.',
      invalid_redirect_uri: 'The redirect URI does not match the one registered for this Zoho client.',
    }
    throw new ApiError(400, 'oauth_failed', hint[code] ?? `Zoho did not complete the sign-in (${code}).`)
  }
  if (!tokens.refresh_token) {
    await prisma.booksZohoConnection.update({ where: { id: conn.id }, data: { status: failedStatus, lastErrorCode: 'no_refresh_token', lastErrorAt: new Date() } })
    throw new ApiError(400, 'oauth_failed', 'Zoho did not issue a refresh token. Try connecting again.')
  }
  const apiDomain = tokens.api_domain && isTrustedZohoHost(tokens.api_domain, cfg) ? tokens.api_domain.replace(/\/$/, '') : null

  const updated = await prisma.booksZohoConnection.update({
    where: { id: conn.id },
    data: {
      status: 'connected',
      accessTokenEncrypted: encryptToken(tokens.access_token, cfg.encryptionKey),
      refreshTokenEncrypted: encryptToken(tokens.refresh_token, cfg.encryptionKey),
      accessTokenExpiresAt: new Date(Date.now() + (tokens.expires_in - 60) * 1000),
      accountsServer: accountsBase,
      apiDomain,
      scopesGranted: (tokens.scope ?? '').split(/[\s,]+/).filter(Boolean),
      connectedAt: new Date(),
      connectedBy: input.userId,
      lastErrorCode: null,
      lastErrorAt: null,
      updatedBy: input.userId,
    },
  })
  return refreshOrganizations(updated, input.organisationId)
}

/** Upsert the Zoho organisations this grant can see. New ones start inactive: the user picks. */
export async function refreshOrganizations(conn: ConnectionRow, organisationId: string): Promise<number> {
  const res = await zohoRequest<{ organizations?: ZohoOrgSummary[] }>({ conn, zohoOrgId: null }, { path: 'organizations', cache: false })
  const orgs = res.organizations ?? []
  for (const o of orgs) {
    const zohoOrgId = String(o.organization_id)
    const existing = await prisma.booksZohoOrganization.findUnique({ where: { organisationId_zohoOrgId: { organisationId, zohoOrgId } } })
    const data = { name: o.name, currencyCode: o.currency_code ?? null, countryCode: o.country ?? null, connectionId: conn.id }
    if (existing) await prisma.booksZohoOrganization.update({ where: { id: existing.id }, data })
    else await prisma.booksZohoOrganization.create({ data: { ...data, organisationId, zohoOrgId } })
  }
  return orgs.length
}

export async function disconnect(input: { organisationId: string; connectionId: string; userId: string }): Promise<void> {
  const conn = await prisma.booksZohoConnection.findFirst({ where: { id: input.connectionId, organisationId: input.organisationId, deletedAt: null } })
  if (!conn) throw ApiError.notFound('No such Zoho Books connection.')
  if (conn.refreshTokenEncrypted) {
    try {
      const cfg = booksConfig()
      const token = decryptToken(conn.refreshTokenEncrypted, cfg.encryptionKey)
      const base = conn.accountsServer && isTrustedZohoHost(conn.accountsServer, cfg) ? conn.accountsServer : cfg.accountsBase
      await seams.http()(`${base}/oauth/v2/token/revoke?${new URLSearchParams({ token })}`, { method: 'POST' })
    } catch {
      // Revocation is a courtesy; the local wipe below is what disconnects.
      console.warn('[books] token revoke at Zoho failed; tokens wiped locally')
    }
  }
  await prisma.$transaction([
    prisma.booksZohoConnection.update({
      where: { id: conn.id },
      data: { status: 'disconnected', accessTokenEncrypted: null, refreshTokenEncrypted: null, accessTokenExpiresAt: null, updatedBy: input.userId },
    }),
    prisma.booksZohoOrganization.updateMany({ where: { connectionId: conn.id }, data: { isActive: false, syncStatus: 'idle' } }),
  ])
}

// ── developer-configured connections (prisma/books-connection.ts) ──────────

export type AuthMethod = 'SERVER_OAUTH' | 'SELF_CLIENT'

/**
 * Add a connection with its OWN Zoho client, from a refresh token or a fresh
 * grant code. Only the developer script calls this — there is no API route
 * for it, so nobody using the app can add a connection.
 *
 * The refresh token is proven by refreshing it once, then the organisations
 * it can see are listed; `activate` turns on those (all when omitted).
 */
export async function addConfiguredConnection(input: {
  organisationId: string; name: string; authMethod: AuthMethod
  clientId: string; clientSecret: string; accountsServer: string
  refreshToken?: string; code?: string; activate?: string[] | 'all'
}): Promise<{ connectionId: string; organizations: { zohoOrgId: string; name: string; isActive: boolean }[] }> {
  const cfg = booksConfig()
  if (!isTrustedZohoHost(input.accountsServer, cfg)) throw new Error(`Not a Zoho accounts host: ${input.accountsServer}`)
  const taken = await prisma.booksZohoConnection.findFirst({ where: { organisationId: input.organisationId, name: input.name, deletedAt: null, status: 'connected' } })
  if (taken) throw new Error(`A connected Zoho Books connection named "${input.name}" already exists.`)
  const conn = await prisma.booksZohoConnection.create({
    data: {
      organisationId: input.organisationId, name: input.name, authMethod: input.authMethod,
      clientId: input.clientId, clientSecretEncrypted: encryptToken(input.clientSecret, cfg.encryptionKey),
      accountsServer: input.accountsServer.replace(/\/$/, ''), status: 'consent_pending', scopesGranted: [],
    },
  })
  try {
    if (input.code) {
      await exchangeAndStore(conn, { code: input.code, accountsBase: conn.accountsServer!, redirectUri: '', userId: 'developer', organisationId: input.organisationId })
    } else if (input.refreshToken) {
      const row = await prisma.booksZohoConnection.update({
        where: { id: conn.id },
        data: { status: 'connected', refreshTokenEncrypted: encryptToken(input.refreshToken, cfg.encryptionKey), connectedAt: new Date(), connectedBy: 'developer' },
      })
      await accessTokenFor(row, true) // proves the refresh token works for this client
      await refreshOrganizations(await prisma.booksZohoConnection.findUniqueOrThrow({ where: { id: conn.id } }), input.organisationId)
    } else {
      throw new Error('Give a refresh token or a grant code.')
    }
  } catch (e) {
    // A connection that never worked is not left behind as a half-row.
    await prisma.booksZohoOrganization.deleteMany({ where: { connectionId: conn.id, isActive: false } }).catch(() => undefined)
    await prisma.booksZohoConnection.update({ where: { id: conn.id }, data: { status: 'error', deletedAt: new Date(), refreshTokenEncrypted: null, accessTokenEncrypted: null } }).catch(() => undefined)
    throw e
  }
  const orgs = await prisma.booksZohoOrganization.findMany({ where: { connectionId: conn.id } })
  const want = input.activate ?? 'all'
  for (const o of orgs) {
    if (want === 'all' || want.includes(o.zohoOrgId)) {
      await prisma.booksZohoOrganization.update({ where: { id: o.id }, data: { isActive: true, activatedAt: new Date(), activatedBy: 'developer' } })
    }
  }
  const after = await prisma.booksZohoOrganization.findMany({ where: { connectionId: conn.id }, orderBy: { name: 'asc' } })
  return { connectionId: conn.id, organizations: after.map((o) => ({ zohoOrgId: o.zohoOrgId, name: o.name, isActive: o.isActive })) }
}

/**
 * Give connections made before names existed a name, so the switcher has
 * something to show: the oldest working one is "Main Account". Idempotent;
 * tokens and organisations are not touched.
 */
export async function nameUnnamedConnections(): Promise<number> {
  const unnamed = await prisma.booksZohoConnection.findMany({ where: { name: null, deletedAt: null, status: { in: ['connected', 'expired', 'revoked'] } }, orderBy: { createdAt: 'asc' } })
  let n = 0
  for (const c of unnamed) {
    const hasMain = await prisma.booksZohoConnection.findFirst({ where: { organisationId: c.organisationId, name: 'Main Account', deletedAt: null } })
    const others = await prisma.booksZohoConnection.count({ where: { organisationId: c.organisationId, name: { not: null }, deletedAt: null } })
    await prisma.booksZohoConnection.update({ where: { id: c.id }, data: { name: hasMain ? `Zoho account ${others + 1}` : 'Main Account' } })
    n++
  }
  return n
}
