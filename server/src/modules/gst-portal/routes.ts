/**
 * GST PORTAL ACCESS — credentials + audit — GST-RETURNS-CASE-SCREEN §9-5.
 *
 * Three endpoints, none of them return plaintext passwords:
 *   GET    /api/gst-portal/:gstProfileId          record with passwords masked
 *   PUT    /api/gst-portal/:gstProfileId          upsert; encrypts server-side
 *   POST   /api/gst-portal/:gstProfileId/reveal   decrypt ONE field, audit row
 *
 * Permissions are their own — viewing credentials is NOT implied by
 * workstation.service.read. `workstation.gst.portal.view` sees the masked
 * record and edits it; `workstation.gst.portal.reveal` is the extra ticket
 * that lets an operator see the plaintext. Every reveal is audited with
 * actor + timestamp + gstProfile + field so "who saw which password when"
 * is answerable after the fact.
 *
 * Server-side invariant: when passwordHeldBy = 'client', the corresponding
 * ciphertext MUST be null. The PUT handler enforces this so an operator
 * cannot leave an orphaned password behind after switching modes.
 */
import { Router } from 'express'
import { prisma } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { requireWorkstation, assignedClientIds } from '../../platform/workstation/scope.js'
import { body, FieldErrors } from '../workstation/validate.js'
import { encryptPortalSecret, decryptPortalSecret, maskPhone } from '../../platform/portalCrypto.js'

const VIEW = ['workstation.gst.portal.view'] as const
const REVEAL = ['workstation.gst.portal.reveal'] as const

const PASSWORD_FIELDS = ['portal_password', 'ewb_password', 'irp_password'] as const
type PasswordField = (typeof PASSWORD_FIELDS)[number]
const MFA_METHODS = ['otp_mobile', 'authenticator', 'none'] as const
const HELD_BY = ['firm', 'client'] as const

export const gstPortalRouter = Router()

/** Restrict a GstProfile lookup to clients the caller can see. */
async function assertCanSeeGstProfile(session: ReturnType<typeof requireSession>, scope: 'self' | 'department' | 'organisation', gstProfileId: string) {
  const profile = await prisma.gstProfile.findFirst({ where: { id: gstProfileId, deletedAt: null } })
  if (!profile) throw ApiError.notFound('GST profile not found.')
  const ids = await assignedClientIds(session, scope)
  if (ids !== 'ALL' && !ids.includes(profile.clientId)) throw ApiError.notFound('GST profile not found.')
  return profile
}

/** Never returns plaintext — password fields become booleans that say "we hold it" or not. */
function toMaskedApi(row: {
  portalUsername: string | null
  portalPasswordCiphertext: string | null
  passwordHeldBy: string
  registeredMobileMasked: string | null
  otpContactName: string | null
  otpContactNumber: string | null
  mfaMethod: string
  ewbUsername: string | null
  ewbPasswordCiphertext: string | null
  irpName: string | null
  irpUsername: string | null
  irpPasswordCiphertext: string | null
  lastVerifiedAt: Date | null
  lastVerifiedByEmployeeId: string | null
}) {
  return {
    portal_username: row.portalUsername,
    portal_password_present: !!row.portalPasswordCiphertext,
    password_held_by: row.passwordHeldBy,
    registered_mobile_masked: row.registeredMobileMasked,
    otp_contact_name: row.otpContactName,
    otp_contact_number: maskPhone(row.otpContactNumber),
    otp_contact_number_masked: !!row.otpContactNumber,
    mfa_method: row.mfaMethod,
    ewb_username: row.ewbUsername,
    ewb_password_present: !!row.ewbPasswordCiphertext,
    irp_name: row.irpName,
    irp_username: row.irpUsername,
    irp_password_present: !!row.irpPasswordCiphertext,
    last_verified_at: row.lastVerifiedAt,
    last_verified_by_employee_id: row.lastVerifiedByEmployeeId,
  }
}

// GET /api/gst-portal/:gstProfileId
gstPortalRouter.get('/:gstProfileId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...VIEW)
  await assertCanSeeGstProfile(session, scope, req.params.gstProfileId)
  const row = await prisma.gstPortalAccess.findFirst({
    where: { gstProfileId: req.params.gstProfileId, deletedAt: null },
  })
  ok(res, { record: row ? toMaskedApi(row) : null })
}))

// PUT /api/gst-portal/:gstProfileId — upsert. Plaintext passwords in the
// request body are encrypted before storage; passing `null` or an empty
// string clears the field. Omitted keys leave the current value alone.
gstPortalRouter.put('/:gstProfileId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...VIEW)
  await assertCanSeeGstProfile(session, scope, req.params.gstProfileId)

  const b = body(req)
  const e = new FieldErrors()
  const str = (k: string, max: number, required = false) => {
    const v = b[k]
    if (v === undefined) return undefined
    if (v === null || v === '') return null
    if (typeof v !== 'string') { e.add(k, 'Must be a string.'); return undefined }
    if (v.length > max) { e.add(k, `Max ${max} characters.`); return undefined }
    return v
  }
  const oneOf = <T extends readonly string[]>(k: string, list: T): T[number] | null | undefined => {
    const v = b[k]
    if (v === undefined) return undefined
    if (v === null || v === '') return null
    if (typeof v !== 'string' || !list.includes(v as T[number])) { e.add(k, `Must be one of ${list.join(', ')}.`); return undefined }
    return v as T[number]
  }

  const patch = {
    portalUsername: str('portal_username', 200),
    portalPassword: str('portal_password', 200), // plaintext in, ciphertext out
    passwordHeldBy: oneOf('password_held_by', HELD_BY),
    registeredMobile: str('registered_mobile', 20),
    otpContactName: str('otp_contact_name', 200),
    otpContactNumber: str('otp_contact_number', 30),
    mfaMethod: oneOf('mfa_method', MFA_METHODS),
    ewbUsername: str('ewb_username', 200),
    ewbPassword: str('ewb_password', 200),
    irpName: str('irp_name', 100),
    irpUsername: str('irp_username', 200),
    irpPassword: str('irp_password', 200),
  }
  e.throwIfAny()

  const held = patch.passwordHeldBy
  // §9-5 invariant: passwordHeldBy=client → the portal password ciphertext
  // MUST be null. If the caller is toggling to client and passing a
  // password in the same request, that's a contradiction; reject rather
  // than silently drop the password.
  if (held === 'client' && patch.portalPassword && patch.portalPassword.length > 0) {
    throw ApiError.badRequest('client_holds_password',
      'When password_held_by is "client", the firm cannot store the password. Clear it or switch to "firm".')
  }

  const data: Record<string, unknown> = { updatedBy: session.userId }
  if (patch.portalUsername !== undefined) data.portalUsername = patch.portalUsername
  if (held !== undefined) {
    data.passwordHeldBy = held ?? 'firm'
    if (held === 'client') data.portalPasswordCiphertext = null // wipe on toggle
  }
  if (patch.portalPassword !== undefined && held !== 'client') {
    data.portalPasswordCiphertext = patch.portalPassword ? encryptPortalSecret(patch.portalPassword, 'portal_password') : null
  }
  if (patch.registeredMobile !== undefined) data.registeredMobileMasked = patch.registeredMobile ? maskPhone(patch.registeredMobile) : null
  if (patch.otpContactName !== undefined) data.otpContactName = patch.otpContactName
  if (patch.otpContactNumber !== undefined) data.otpContactNumber = patch.otpContactNumber
  if (patch.mfaMethod !== undefined) data.mfaMethod = patch.mfaMethod ?? 'otp_mobile'
  if (patch.ewbUsername !== undefined) data.ewbUsername = patch.ewbUsername
  if (patch.ewbPassword !== undefined) data.ewbPasswordCiphertext = patch.ewbPassword ? encryptPortalSecret(patch.ewbPassword, 'ewb_password') : null
  if (patch.irpName !== undefined) data.irpName = patch.irpName
  if (patch.irpUsername !== undefined) data.irpUsername = patch.irpUsername
  if (patch.irpPassword !== undefined) data.irpPasswordCiphertext = patch.irpPassword ? encryptPortalSecret(patch.irpPassword, 'irp_password') : null

  const existing = await prisma.gstPortalAccess.findFirst({ where: { gstProfileId: req.params.gstProfileId, deletedAt: null } })
  const saved = existing
    ? await prisma.gstPortalAccess.update({ where: { id: existing.id }, data })
    : await prisma.gstPortalAccess.create({
        data: { gstProfileId: req.params.gstProfileId, ...data, createdBy: session.userId },
      })

  await writeAudit({
    actorUserId: session.userId,
    action: 'gst_portal_access.save',
    entityType: 'gst_portal_access',
    entityId: saved.id,
    // Never log plaintexts — record only which fields the caller touched.
    after: Object.fromEntries(Object.entries(data).map(([k, v]) => [
      k, k.endsWith('Ciphertext') ? (v === null ? '<cleared>' : '<encrypted>') : v,
    ])),
    req,
  })
  ok(res, { record: toMaskedApi(saved) })
}))

// POST /api/gst-portal/:gstProfileId/reveal { field: 'portal_password' | 'ewb_password' | 'irp_password' }
gstPortalRouter.post('/:gstProfileId/reveal', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...REVEAL)
  const profile = await assertCanSeeGstProfile(session, scope, req.params.gstProfileId)

  const b = body(req)
  const e = new FieldErrors()
  const field = b.field
  if (typeof field !== 'string' || !(PASSWORD_FIELDS as readonly string[]).includes(field)) {
    e.add('field', `Must be one of ${PASSWORD_FIELDS.join(', ')}.`)
    e.throwIfAny()
  }

  const row = await prisma.gstPortalAccess.findFirst({ where: { gstProfileId: req.params.gstProfileId, deletedAt: null } })
  if (!row) throw ApiError.notFound('No portal record for this GST profile.')

  const map: Record<PasswordField, string | null> = {
    portal_password: row.portalPasswordCiphertext,
    ewb_password: row.ewbPasswordCiphertext,
    irp_password: row.irpPasswordCiphertext,
  }
  const ct = map[field as PasswordField]
  if (!ct) throw ApiError.notFound('That password field is not set.')
  const plain = decryptPortalSecret(ct, field as string)

  await writeAudit({
    actorUserId: session.userId,
    action: 'gst_portal_access.reveal',
    entityType: 'gst_portal_access',
    entityId: row.id,
    // The audit row NEVER contains the plaintext — only the metadata.
    after: { field, gstProfileId: profile.id, clientId: profile.clientId },
    req,
  })
  ok(res, { field, value: plain })
}))
