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
import { seams, zohoRequest, type ConnectionRow } from './client.js'

const STATE_TTL_SECONDS = 10 * 60
const PURPOSE = 'zoho-books'

interface StatePayload { p: string; cid: string; uid: string; oid: string; n: string }

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
  } else {
    await prisma.booksZohoConnection.update({ where: { id: conn.id }, data: { status: 'consent_pending', updatedBy: input.userId } })
  }
  const state = signState({ cid: conn.id, uid: input.userId, oid: input.organisationId })
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
  if (conn.status === 'connected') {
    // A repeated browser GET of the same callback: already done.
    return { connectionId: conn.id, organisationId: st.oid, userId: st.uid, organizations: 0 }
  }
  if (conn.status !== 'consent_pending') throw new ApiError(400, 'invalid_state', 'This connection is not waiting for Zoho consent. Start again from Books → Settings.')

  // Zoho tells us which data centre the user's account lives in; the code
  // must be exchanged there, and only ever on a genuine Zoho host.
  const accountsBase = input.accountsServer && isTrustedZohoHost(input.accountsServer, cfg) ? input.accountsServer.replace(/\/$/, '') : cfg.accountsBase

  let tokens
  try {
    tokens = await exchangeCodeForTokens({ ...cfg, accountsBase }, input.code, input.fetchImpl ?? seams.oauth())
  } catch (err) {
    const code = err instanceof ZohoOAuthError ? err.code : 'exchange_failed'
    await prisma.booksZohoConnection.update({ where: { id: conn.id }, data: { status: 'error', lastErrorCode: code, lastErrorAt: new Date() } })
    throw new ApiError(400, 'oauth_failed', `Zoho did not complete the sign-in (${code}).`)
  }
  if (!tokens.refresh_token) {
    await prisma.booksZohoConnection.update({ where: { id: conn.id }, data: { status: 'error', lastErrorCode: 'no_refresh_token', lastErrorAt: new Date() } })
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
      connectedBy: st.uid,
      lastErrorCode: null,
      lastErrorAt: null,
      updatedBy: st.uid,
    },
  })
  const organizations = await refreshOrganizations(updated, st.oid)
  return { connectionId: conn.id, organisationId: st.oid, userId: st.uid, organizations }
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
