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
import { burnLaunchToken, issueLaunchToken, verifyLaunchToken, type LaunchClaims, type LaunchPurpose } from './launchToken.js'

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
    // The GST module's saved portal access first; else the login saved with
    // the GST registration (Registration → GST → Already registered).
    const profile = await prisma.gstProfile.findFirst({ where: { clientId, deletedAt: null }, select: { id: true } })
    const row = profile ? await prisma.gstPortalAccess.findFirst({ where: { gstProfileId: profile.id, deletedAt: null } }) : null
    if (row?.portalUsername) return { username: row.portalUsername, password: decryptPortalSecret(row.portalPasswordCiphertext, 'portal_password') }
  }
  const row = await prisma.registrationCredential.findFirst({ where: { clientId, typeCode: entry.slug, deletedAt: null } })
  if (!row) return null
  let fields: Record<string, string> = {}
  try { fields = JSON.parse(row.fieldsJson) as Record<string, string> } catch { /* empty */ }
  const username = fields.username || fields.udyam_number || null
  if (entry.passwordless) return { username, password: null, mobile: fields.signatory_mobile || null }
  return { username, password: decryptPortalSecret(row.passwordCiphertext, `registration.${entry.slug}`) }
}

/**
 * The GST portal's New Registration form (Part A) — reg.gst.gov.in/registration/.
 * On this page the extension fills the client's saved first-time registration
 * details (Registration → GST → First-time registration), not a login.
 */
function isGstNewRegistrationPage(pageUrl: unknown): boolean {
  if (typeof pageUrl !== 'string') return false
  try {
    const u = new URL(pageUrl)
    return u.protocol === 'https:' && u.hostname === 'reg.gst.gov.in' && u.pathname.startsWith('/registration')
  } catch { return false }
}

/**
 * Registration forms the extension can fill from the saved first-time
 * details: the response kind, and each form field → the saved field it reads.
 */
const REGISTRATION_FORMS: Record<string, { kind: string; fields: Record<string, string> }> = {
  gst: { kind: 'gst_new_registration', fields: { applicant_type: 'applicant_type', state: 'state', district: 'district', legal_name: 'legal_name', pan: 'pan', email: 'email', mobile: 'mobile' } },
  // Labour TN applicant registration: the Aadhaar (a secret field) and the
  // password the form's Security Details ask for are decrypted for this fill.
  'shops-establishment': { kind: 'labour_registration', fields: {
    name: 'applicant_name', designation: 'applicant_designation', dob: 'dob', aadhaar: 'aadhaar', id_proof: 'id_proof', id_number: 'id_proof_number',
    state: 'state', district: 'district', taluk: 'taluk', village: 'village_town_city', street1: 'street1', street2: 'street2',
    door_no: 'door_number', pincode: 'pincode', std_code: 'std_code', telephone: 'telephone', mobile: 'reg_mobile', email: 'reg_email', password: '$password',
  } },
  // TNREGINET Sign Up: the security answer and ID number (secret fields) and the password are decrypted for this fill.
  'partnership-firm': { kind: 'tnreginet_registration', fields: {
    user_type: 'user_type', username: 'username', password: '$password', security_question: 'security_question', security_answer: 'security_answer',
    salutation: 'salutation', first_name: 'first_name', middle_name: 'middle_name', last_name: 'last_name', gender: 'gender',
    identification_type: 'identification_type', identification_no: 'identification_no', email: 'reg_email', dob: 'dob', mobile: 'reg_mobile',
    phone: 'phone', state: 'state', district: 'district', pincode: 'pincode', door_flat: 'door_flat', street: 'street', village_town: 'village_town',
  } },
  // Udyam Aadhaar verification: the Aadhaar (a secret field) is decrypted for this fill.
  // ESIC: Employer Sign Up and the Insured Person's User Sign Up (the page decides which it fills).
  esi: { kind: 'esi_registration', fields: {
    company_name: 'company_name', principal_employer_name: 'principal_employer_name', state: 'state', region: 'region', email: 'signup_email',
    phone: 'phone', exclusive_contractor: 'exclusive_contractor', ip_number: 'ip_insurance_number', ip_dob: 'ip_dob', ip_mobile: 'ip_mobile',
  } },
  // E-Way Bill Registration Form: Enter GSTIN (the portal fetches the rest).
  'e-way-bill': { kind: 'ewb_registration', fields: { gstin: 'gstin' } },
  'msme-udyam': { kind: 'udyam_registration', fields: { aadhaar: 'aadhaar', entrepreneur_name: 'entrepreneur_name' } },
  'import-export-code': { kind: 'iec_registration', fields: { register_as: 'register_as', first_name: 'first_name', last_name: 'last_name', email: 'reg_email', mobile: 'reg_mobile', pincode: 'pincode', district: 'district', state: 'state', city: 'city' } },
}

/** A registration's saved first-time details, shaped for its portal form. */
async function registrationDetails(slug: string, clientId: string): Promise<{ kind: string; details: Record<string, string> } | null> {
  const form = REGISTRATION_FORMS[slug]
  if (!form) return null
  const row = await prisma.registrationCredential.findFirst({ where: { clientId, typeCode: slug, deletedAt: null } })
  if (!row) return null
  let f: Record<string, string> = {}
  try { f = JSON.parse(row.fieldsJson) as Record<string, string> } catch { /* empty */ }
  const read = (key: string): string => {
    if (key === '$password') return (row.passwordCiphertext && decryptPortalSecret(row.passwordCiphertext, `registration.${slug}`)) || ''
    const v = f[key]
    if (typeof v !== 'string') return ''
    // Secret fields (e.g. Aadhaar) are stored encrypted.
    if (v.startsWith('enc:')) return decryptPortalSecret(v.slice(4), `registration_${slug.replace(/-/g, '_')}_password_${key}`) ?? ''
    return v.trim()
  }
  const details = Object.fromEntries(Object.entries(form.fields).map(([out, key]) => [out, read(key)]))
  return Object.values(details).some(Boolean) ? { kind: form.kind, details } : null
}

/** ESIC's Insured Person login (EmployeePortal) — a different login from the employer's. */
function isEsicInsuredPersonPage(pageUrl: unknown): boolean {
  if (typeof pageUrl !== 'string') return false
  try {
    const u = new URL(pageUrl)
    return u.hostname.endsWith('esic.gov.in') && /\/employeeportal\//i.test(u.pathname)
  } catch { return false }
}

/** The client's Insured Person login (Registration → ESI). Never the employer's. */
async function esicInsuredPersonLogin(clientId: string): Promise<{ username: string; password: string } | null> {
  const row = await prisma.registrationCredential.findFirst({ where: { clientId, typeCode: 'esi', deletedAt: null } })
  if (!row) return null
  let f: Record<string, string> = {}
  try { f = JSON.parse(row.fieldsJson) as Record<string, string> } catch { /* empty */ }
  const enc = typeof f.ip_password === 'string' && f.ip_password.startsWith('enc:') ? f.ip_password.slice(4) : null
  const password = enc ? decryptPortalSecret(enc, 'registration_esi_password_ip_password') : null
  return f.ip_user_id && password ? { username: f.ip_user_id, password } : null
}

/** EPFO's member portal — the employee's UAN login, not the employer's. */
function isEpfoMemberPage(pageUrl: unknown): boolean {
  if (typeof pageUrl !== 'string') return false
  try { return new URL(pageUrl).hostname === 'unifiedportal-mem.epfindia.gov.in' } catch { return false }
}

/** The client's Employee (UAN) login (Registration → PF). Never the employer's. */
async function epfoUanLogin(clientId: string): Promise<{ username: string; password: string } | null> {
  const row = await prisma.registrationCredential.findFirst({ where: { clientId, typeCode: 'pf', deletedAt: null } })
  if (!row) return null
  let f: Record<string, string> = {}
  try { f = JSON.parse(row.fieldsJson) as Record<string, string> } catch { /* empty */ }
  const enc = typeof f.uan_password === 'string' && f.uan_password.startsWith('enc:') ? f.uan_password.slice(4) : null
  const password = enc ? decryptPortalSecret(enc, 'registration_pf_password_uan_password') : null
  return f.uan && password ? { username: f.uan, password } : null
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

// Redeemed by the extension's service worker. No session cookie: the signed
// token is the authority, and the user it names is re-checked. Single use is
// enforced by `burnLaunchToken` (a database insert) immediately before any
// data is released — two racing redemptions cannot both get it.
extensionCredentialsRouter.post('/credentials/request', handler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const b = body(req)
  const fail = async (code: string, message: string, meta: Record<string, unknown> = {}) => {
    await writeAudit({ actorUserId: typeof meta.uid === 'string' ? meta.uid : null, action: 'portal_autofill.credential_denied', entityType: 'client', entityId: typeof meta.cid === 'string' ? meta.cid : 'unknown', after: { reason: code, registration_id: b.registrationId ?? null, portal_id: b.portalId ?? null }, req }).catch(() => undefined)
    throw ApiError.forbidden(message)
  }
  // Which fill this is: the login, or the registration form (GST New Registration
  // is told apart by its page; others by the extension, which sees the form).
  const purpose = b.purpose === 'registration' || isGstNewRegistrationPage(b.pageUrl) ? 'registration' : 'login'
  const v = verifyLaunchToken(b.launchToken, Date.now())
  if (!v.ok) {
    return fail(v.reason, v.reason === 'expired'
      ? 'CRM session expired. Please reopen this service from the CRM.'
      : 'Credential authorization failed.')
  }
  /** Burn now; a token already burned for this fill is a 409, not a release. */
  const burn = async (claims: LaunchClaims, p: LaunchPurpose) => {
    if (await burnLaunchToken(claims, p)) return
    await writeAudit({ actorUserId: claims.uid, action: 'portal_autofill.credential_denied', entityType: 'client', entityId: claims.cid, after: { reason: 'used', registration_id: claims.rid, portal_id: claims.pid }, req }).catch(() => undefined)
    throw new ApiError(409, 'token_used', 'This launch was already used — CRM session expired. Please reopen this service from the CRM.')
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
  // A registration form: hand over the saved first-time details. These can
  // include secrets the form needs (an encrypted field such as Aadhaar, or
  // the portal password where a form asks for it), so this path is gated and
  // audited exactly like the login.
  if (purpose === 'registration') {
    const r = await registrationDetails(entry.slug, client.id)
    if (!r) return fail('no_details', `No first-time registration details are saved for this client. Add them in Registration → ${entry.name} → First-time registration.`, c as unknown as Record<string, unknown>)
    await burn(c, 'registration')
    await writeAudit({
      actorUserId: c.uid, action: 'portal_autofill.registration_details_issued', entityType: 'client', entityId: client.id,
      after: { client_id: client.id, registration_id: c.rid, portal_id: c.pid, form: r.kind }, req,
    })
    ok(res, r)
    return
  }
  // ESIC Insured Person page: that login only — never fall back to the employer's.
  const ip = entry.slug === 'esi' && isEsicInsuredPersonPage(b.pageUrl)
  // EPFO member portal: the UAN login only — likewise never the employer's.
  const uan = entry.slug === 'pf' && isEpfoMemberPage(b.pageUrl)
  const cred: { username: string | null; password: string | null; mobile?: string | null } | null =
    ip ? await esicInsuredPersonLogin(client.id) : uan ? await epfoUanLogin(client.id) : await credentialFor(entry, client.id)
  if (ip && !cred) return fail('no_credential', 'No Insured Person login is saved for this client. Add it in Registration → ESI.', c as unknown as Record<string, unknown>)
  if (uan && !cred) return fail('no_credential', 'No Employee (UAN) login is saved for this client. Add it in Registration → PF.', c as unknown as Record<string, unknown>)
  if (!cred || !cred.username || (!cred.password && !entry.passwordless)) return fail('no_credential', 'No credential configured for this client.', c as unknown as Record<string, unknown>)
  await burn(c, 'login')
  await writeAudit({
    actorUserId: c.uid, action: 'portal_autofill.credential_issued', entityType: 'client', entityId: client.id,
    after: { client_id: client.id, registration_id: c.rid, portal_id: c.pid }, req,
  })
  ok(res, entry.passwordless ? { username: cred.username, password: '', mobile: cred.mobile ?? '' } : { username: cred.username, password: cred.password })
}))
