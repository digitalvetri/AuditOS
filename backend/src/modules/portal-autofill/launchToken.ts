/**
 * Short-lived launch tokens for the portal autofill extension.
 *
 * A token carries WHO launched (CRM user), FOR WHOM (client) and WHAT
 * (registration + portal), and expires after a few minutes. It is HMAC-signed
 * server-side; the extension cannot forge or edit it. It carries no
 * credential — the password is only released when the token is redeemed, and
 * a token can be redeemed exactly once.
 *
 * The signing key is derived from PORTAL_ACCESS_ENC_KEY (or PORTAL_AUTOFILL_SECRET
 * when set) and never leaves the server.
 */
import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto'

export const LAUNCH_TTL_SECONDS = 10 * 60

export interface LaunchClaims {
  v: 1
  uid: string   // CRM user who launched
  cid: string   // client
  rid: string   // registrationId
  pid: string   // portalId
  exp: number   // unix seconds
  jti: string   // single-use id
}

let cachedKey: Buffer | null = null
function key(): Buffer {
  if (cachedKey) return cachedKey
  const explicit = process.env.PORTAL_AUTOFILL_SECRET
  if (explicit) { cachedKey = Buffer.from(explicit, 'utf8'); return cachedKey }
  const base = process.env.PORTAL_ACCESS_ENC_KEY
  if (!base) throw new Error('portal_autofill misconfigured: no signing secret')
  cachedKey = Buffer.from(hkdfSync('sha256', Buffer.from(base, 'base64'), Buffer.alloc(0), 'auditos-portal-autofill-launch-v1', 32))
  return cachedKey
}

const b64u = (b: Buffer) => b.toString('base64url')
const sign = (data: string) => createHmac('sha256', key()).update(data).digest()

export function issueLaunchToken(c: Omit<LaunchClaims, 'v' | 'exp' | 'jti'>, now = Date.now()): { token: string; claims: LaunchClaims } {
  const claims: LaunchClaims = { v: 1, ...c, exp: Math.floor(now / 1000) + LAUNCH_TTL_SECONDS, jti: randomUUID() }
  const body = b64u(Buffer.from(JSON.stringify(claims)))
  return { token: `${body}.${b64u(sign(body))}`, claims }
}

export type VerifyResult = { ok: true; claims: LaunchClaims } | { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'used' }

/** Single-use ledger: jti → expiry. In-memory — fine for one API process. */
const used = new Map<string, number>()
function sweep(nowSec: number) { for (const [j, e] of used) if (e < nowSec) used.delete(j) }

/**
 * A launch serves two fills, each once: the portal's login, and (where the
 * portal has one) its registration form with the saved first-time details.
 */
export type LaunchPurpose = 'login' | 'registration'

export function verifyLaunchToken(token: unknown, now = Date.now(), purpose: LaunchPurpose = 'login'): VerifyResult {
  if (typeof token !== 'string' || token.length > 2000) return { ok: false, reason: 'malformed' }
  const [body, sig] = token.split('.')
  if (!body || !sig) return { ok: false, reason: 'malformed' }
  const want = sign(body)
  const got = Buffer.from(sig, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'signature' }
  let claims: LaunchClaims
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LaunchClaims } catch { return { ok: false, reason: 'malformed' } }
  if (claims.v !== 1 || !claims.uid || !claims.cid || !claims.rid || !claims.pid || !claims.jti) return { ok: false, reason: 'malformed' }
  const nowSec = Math.floor(now / 1000)
  if (claims.exp < nowSec) return { ok: false, reason: 'expired' }
  sweep(nowSec)
  if (used.has(`${claims.jti}:${purpose}`)) return { ok: false, reason: 'used' }
  return { ok: true, claims }
}

/** Burn a token for one purpose once that fill's data has been released. */
export function consumeLaunchToken(claims: LaunchClaims, purpose: LaunchPurpose = 'login') { used.set(`${claims.jti}:${purpose}`, claims.exp) }
