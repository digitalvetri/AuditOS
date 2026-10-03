/**
 * PORTAL AUTOFILL — Phase 1 of the CRM government-portal autofill extension.
 *
 *   GET  /api/portal-autofill/registry          portals + status (session)
 *   POST /api/portal-autofill/launch            short-lived launch token (session)
 *   POST /api/extension/credentials/request     redeem a token → ONE credential
 *
 * Rules (see docs/portal-autofill/README.md):
 *   - The credential's identity is client + registration + portal. The
 *     registration picks the record; the domain alone never does (MCA hosts
 *     both Private Limited and LLP).
 *   - A token is issued only to a user who may reveal the client's portal
 *     password, and on redemption the user is re-loaded and re-checked.
 *   - A token is single-use and expires in minutes. It never carries a
 *     credential; nothing secret is put in a URL.
 *   - Exactly one credential is returned per redemption, with no-store.
 *   - Audit rows carry metadata only — never a password or a token.
 */
import { Router } from 'express'
import { prisma } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { loadSession, requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { assignedClientIds, workstationScope } from '../../platform/workstation/scope.js'
import { decryptPortalSecret } from '../../platform/portalCrypto.js'
import { body } from '../workstation/validate.js'
import { PORTAL_REGISTRY, byRegistrationId, hostAllowed, type PortalConfig } from './registry.js'
import { consumeLaunchToken, issueLaunchToken, verifyLaunchToken } from './launchToken.js'

export const portalAutofillRouter = Router()
export const extensionCredentialsRouter = Router()

/** Revealing a GST login and a registration login are separate permissions. */
const revealPermission = (p: PortalConfig) =>
  p.slug === 'gst' ? 'workstation.gst.portal.reveal' as const : 'workstation.registration.portal.reveal' as const

/** The user may reveal this registration's password for this client. */
async function authorise(session: Session, entry: PortalConfig, clientId: string) {
  const scope = workstationScope(session, revealPermission(entry))
  if (!scope) return null
  const client = await prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { id: true, companyName: true, clientCode: true } })
  if (!client) return null
  const ids = await assignedClientIds(session, scope)
  if (ids !== 'ALL' && !ids.includes(client.id)) return null
  return client
}

/** The ONE credential for client + registration (+ its portal). */
async function credentialFor(entry: PortalConfig, clientId: string): Promise<{ username: string | null; password: string | null; mobile?: string | null } | null> {
  if (entry.slug === 'gst') {
    const profile = await prisma.gstProfile.findFirst({ where: { clientId, deletedAt: null }, select: { id: true } })
    if (!profile) return null
    const row = await prisma.gstPortalAccess.findFirst({ where: { gstProfileId: profile.id, deletedAt: null } })
    if (!row) return null
    return { username: row.portalUsername ?? null, password: decryptPortalSecret(row.portalPasswordCiphertext, 'portal_password') }
  }
  const row = await prisma.registrationCredential.findFirst({ where: { clientId, typeCode: entry.slug, deletedAt: null } })
  if (!row) return null
  let fields: Record<string, string> = {}
  try { fields = JSON.parse(row.fieldsJson) as Record<string, string> } catch { /* empty */ }
  const username = fields.username || fields.udyam_number || null
  if (entry.passwordless) return { username, password: null, mobile: fields.signatory_mobile || null }
  return { username, password: decryptPortalSecret(row.passwordCiphertext, `registration.${entry.slug}`) }
}

/** The page the extension is on is a legitimate login page for this entry. */
function pageMatches(entry: PortalConfig, pageUrl: unknown): boolean {
  if (typeof pageUrl !== 'string') return false
  let u: URL
  try { u = new URL(pageUrl) } catch { return false }
  return u.protocol === 'https:' && hostAllowed(u.hostname, entry.allowedDomains)
}

portalAutofillRouter.get('/registry', handler(async (req, res) => {
  requireSession(req)
  ok(res, { items: PORTAL_REGISTRY.map(({ registrationId, slug, portalId, name, portalName, launchUrl, status }) => ({ registration_id: registrationId, slug, portal_id: portalId, name, portal_name: portalName, launch_url: launchUrl, status })) })
}))

// The CRM's "Open & autofill" — returns the URL to open and the token the
// extension holds for that one tab. Nothing secret in the URL.
portalAutofillRouter.post('/launch', handler(async (req, res) => {
  const session = requireSession(req)
  const b = body(req)
  const entry = typeof b.registration_id === 'string' ? byRegistrationId(b.registration_id) : null
  if (!entry) throw ApiError.badRequest('Unknown registration.')
  if (typeof b.portal_id === 'string' && b.portal_id !== entry.portalId) throw ApiError.badRequest('Portal does not match the registration.')
  const client = await authorise(session, entry, String(b.client_id ?? ''))
  if (!client) throw ApiError.forbidden('You cannot open portal logins for this client.')
  const cred = await credentialFor(entry, client.id)
  const { token, claims } = issueLaunchToken({ uid: session.userId, cid: client.id, rid: entry.registrationId, pid: entry.portalId })
  await writeAudit({
    actorUserId: session.userId, action: 'portal_autofill.launch', entityType: 'client', entityId: client.id,
    after: { client_id: client.id, registration_id: entry.registrationId, portal_id: entry.portalId }, req,
  })
  res.setHeader('Cache-Control', 'no-store')
  ok(res, {
    launch_token: token,
    launch_url: entry.launchUrl,
    expires_at: new Date(claims.exp * 1000).toISOString(),
    client: { id: client.id, name: client.companyName, code: client.clientCode },
    registration_id: entry.registrationId, registration_name: entry.name,
    portal_id: entry.portalId, portal_name: entry.portalName,
    status: entry.status,
    credential_ready: !!(cred && cred.username && (cred.password || entry.passwordless)),
  })
}))

// Redeemed by the extension's service worker. No session cookie: the signed,
// single-use token is the authority — and the user it names is re-checked.
extensionCredentialsRouter.post('/credentials/request', handler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const b = body(req)
  const fail = async (code: string, message: string, meta: Record<string, unknown> = {}) => {
    await writeAudit({ actorUserId: typeof meta.uid === 'string' ? meta.uid : null, action: 'portal_autofill.credential_denied', entityType: 'client', entityId: typeof meta.cid === 'string' ? meta.cid : 'unknown', after: { reason: code, registration_id: b.registrationId ?? null, portal_id: b.portalId ?? null }, req }).catch(() => undefined)
    throw ApiError.forbidden(message)
  }
  const v = verifyLaunchToken(b.launchToken)
  if (!v.ok) {
    return fail(v.reason, v.reason === 'expired' || v.reason === 'used'
      ? 'CRM session expired. Please reopen this service from the CRM.'
      : 'Credential authorization failed.')
  }
  const c = v.claims
  // The request must name exactly what the token was issued for.
  if (b.clientId !== c.cid || b.registrationId !== c.rid || b.portalId !== c.pid) return fail('context_mismatch', 'Credential authorization failed.', c as unknown as Record<string, unknown>)
  const entry = byRegistrationId(c.rid)
  if (!entry || entry.portalId !== c.pid) return fail('unknown_registration', 'This portal is not currently supported.', c as unknown as Record<string, unknown>)
  if (!pageMatches(entry, b.pageUrl)) return fail('portal_mismatch', 'This page is not the portal this service was opened for.', c as unknown as Record<string, unknown>)
  const session = await loadSession(c.uid)
  if (!session) return fail('user_inactive', 'Credential authorization failed.', c as unknown as Record<string, unknown>)
  const client = await authorise(session, entry, c.cid)
  if (!client) return fail('not_authorised', 'Credential authorization failed.', c as unknown as Record<string, unknown>)
  const cred = await credentialFor(entry, client.id)
  if (!cred || !cred.username || (!cred.password && !entry.passwordless)) return fail('no_credential', 'No credential configured for this client.', c as unknown as Record<string, unknown>)
  consumeLaunchToken(c)
  await writeAudit({
    actorUserId: c.uid, action: 'portal_autofill.credential_issued', entityType: 'client', entityId: client.id,
    after: { client_id: client.id, registration_id: c.rid, portal_id: c.pid }, req,
  })
  ok(res, entry.passwordless ? { username: cred.username, password: '', mobile: cred.mobile ?? '' } : { username: cred.username, password: cred.password })
}))
