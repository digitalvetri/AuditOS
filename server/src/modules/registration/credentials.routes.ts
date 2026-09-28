/**
 * REGISTRATION CREDENTIALS — the portal login and reference details a client
 * holds for each registration (MSME Udyam, Shops & Establishment, IEC, PF,
 * ESI, E-Invoice, E-Way Bill). One record per client per registration, so
 * details entered once are shown the next time instead of asked for again.
 *
 *   GET    /api/registration-credentials/specs                   field layout per registration
 *   GET    /api/registration-credentials/:type/:clientId          record; password → `password_present`
 *   PUT    /api/registration-credentials/:type/:clientId          upsert; password encrypted server-side
 *   DELETE /api/registration-credentials/:type/:clientId          soft delete + wipe ciphertext
 *   POST   /api/registration-credentials/:type/:clientId/reveal   decrypt the password, audit row
 *
 * Same rules as tds-portal: every :clientId is checked against the caller's
 * visible clients (unknown and out-of-scope both answer 404), the password is
 * never part of a normal read, and every reveal is audited.
 */
import { Router } from 'express'
import { prisma } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { requireWorkstation, assignedClientIds } from '../../platform/workstation/scope.js'
import { body, FieldErrors } from '../workstation/validate.js'
import { encryptPortalSecret, decryptPortalSecret } from '../../platform/portalCrypto.js'

const VIEW = ['workstation.registration.portal.view'] as const
const REVEAL = ['workstation.registration.portal.reveal'] as const

type Mode = 'new' | 'existing'

interface FieldSpec {
  key: string
  label: string
  kind?: 'text' | 'email' | 'phone' | 'gstin' | 'textarea' | 'select'
  options?: string[]
  placeholder?: string
  /** Required in these modes (or always, for a registration without modes). */
  required?: boolean | Mode[]
  /** Shown only in these modes; all modes when omitted. */
  modes?: Mode[]
  /** Pre-filled from the client record on first entry. */
  prefill?: 'gstin' | 'contact_number' | 'email'
  mono?: boolean
}

interface RegistrationSpec {
  code: string
  title: string
  modes?: { key: Mode; label: string; hint: string }[]
  fields: FieldSpec[]
  /** Whether the record carries a password, and when it is required on create. */
  password?: { label: string; required: boolean | Mode[]; modes?: Mode[] }
}

const TWO_MODES: RegistrationSpec['modes'] = [
  { key: 'new', label: 'New registration', hint: 'Registering the client now — credentials are issued after registration.' },
  { key: 'existing', label: 'Already registered', hint: 'The client is already registered — only the login is needed.' },
]

export const REGISTRATION_SPECS: RegistrationSpec[] = [
  {
    code: 'msme-udyam',
    title: 'MSME Udyam Registration',
    fields: [
      { key: 'udyam_number', label: 'Udyam Registration Number', required: true, placeholder: 'UDYAM-TN-00-0000000', mono: true },
      { key: 'signatory_mobile', label: 'Authorised Signatory’s Mobile', kind: 'phone', prefill: 'contact_number' },
      { key: 'signatory_email', label: 'Authorised Signatory’s Email', kind: 'email', prefill: 'email' },
    ],
  },
  {
    code: 'shops-establishment',
    title: 'Shops & Establishment Registration',
    fields: [
      { key: 'username', label: 'User ID / Username', required: true, mono: true },
      { key: 'licence_number', label: 'Shop Registration Number / Licence Number', mono: true },
    ],
    password: { label: 'Password', required: true },
  },
  {
    code: 'import-export-code',
    title: 'Import Export Code (IEC)',
    fields: [
      { key: 'username', label: 'Registered Email ID / Username', required: true, prefill: 'email' },
    ],
    password: { label: 'Password', required: true },
  },
  {
    code: 'pf',
    title: 'PF Registration',
    fields: [
      { key: 'username', label: 'Username', required: true, mono: true },
      {
        key: 'signatory_verification', label: 'Signatory Verification', kind: 'select',
        options: ['Pending', 'Verified — DSC', 'Verified — Aadhaar e-Sign'],
      },
    ],
    password: { label: 'Password', required: true },
  },
  {
    code: 'esi',
    title: 'ESI Registration',
    fields: [
      { key: 'username', label: 'User ID / Username', required: true, mono: true },
    ],
    password: { label: 'Password', required: true },
  },
  {
    code: 'e-invoice',
    title: 'E-Invoice Registration',
    modes: TWO_MODES,
    fields: [
      { key: 'gstin', label: 'GSTIN', kind: 'gstin', required: ['new'], modes: ['new'], prefill: 'gstin', mono: true },
      {
        key: 'turnover_eligibility', label: 'Turnover Eligibility', kind: 'select', modes: ['new'],
        options: ['Eligible — AATO above ₹5 crore', 'Not yet eligible', 'Registering voluntarily'],
      },
      { key: 'username', label: 'Username', required: ['existing'], mono: true, placeholder: 'Issued after registration' },
    ],
    password: { label: 'Password', required: ['existing'] },
  },
  {
    code: 'e-way-bill',
    title: 'E-Way Bill Registration',
    modes: TWO_MODES,
    fields: [
      { key: 'gstin', label: 'GSTIN', kind: 'gstin', required: ['new'], modes: ['new'], prefill: 'gstin', mono: true },
      { key: 'applicant_details', label: 'Applicant Details', kind: 'textarea', modes: ['new'], placeholder: 'Applicant name, designation, address' },
      { key: 'registered_mobile', label: 'Registered Mobile Number', kind: 'phone', modes: ['new'], prefill: 'contact_number' },
      { key: 'registered_email', label: 'Registered Email', kind: 'email', modes: ['new'], prefill: 'email' },
      { key: 'username', label: 'Username', required: ['existing'], mono: true, placeholder: 'Issued after registration' },
    ],
    password: { label: 'Password', required: ['existing'] },
  },
]

const SPEC_BY_CODE = new Map(REGISTRATION_SPECS.map((s) => [s.code, s]))

function specFor(code: string): RegistrationSpec {
  const s = SPEC_BY_CODE.get(code)
  if (!s) throw ApiError.notFound('Unknown registration.')
  return s
}

const inMode = (modes: Mode[] | undefined, mode: Mode | null) => !modes || !mode || modes.includes(mode)
const requiredIn = (req: boolean | Mode[] | undefined, mode: Mode | null) =>
  req === true || (Array.isArray(req) && !!mode && req.includes(mode))

const cryptoField = (code: string) => `registration_${code.replace(/-/g, '_')}_password`

export const registrationCredentialsRouter = Router()

async function assertCanSeeClient(session: ReturnType<typeof requireSession>, scope: 'self' | 'department' | 'organisation', clientId: string) {
  const client = await prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { id: true, companyName: true } })
  if (!client) throw ApiError.notFound('Client not found.')
  const ids = await assignedClientIds(session, scope)
  if (ids !== 'ALL' && !ids.includes(client.id)) throw ApiError.notFound('Client not found.')
  return client
}

function parseFields(json: string): Record<string, string> {
  try {
    const v = JSON.parse(json) as unknown
    return v && typeof v === 'object' ? (v as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function toApi(row: { mode: string | null; fieldsJson: string; passwordCiphertext: string | null; updatedAt: Date }) {
  return {
    mode: row.mode,
    fields: parseFields(row.fieldsJson),
    password_present: !!row.passwordCiphertext,
    updated_at: row.updatedAt,
  }
}

const findLive = (clientId: string, typeCode: string) =>
  prisma.registrationCredential.findFirst({ where: { clientId, typeCode, deletedAt: null } })

registrationCredentialsRouter.get('/specs', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, ...VIEW)
  ok(res, { items: REGISTRATION_SPECS })
}))

registrationCredentialsRouter.get('/:type/:clientId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...VIEW)
  const spec = specFor(req.params.type)
  await assertCanSeeClient(session, scope, req.params.clientId)
  const row = await findLive(req.params.clientId, spec.code)
  ok(res, { spec, record: row ? toApi(row) : null })
}))

// PUT — `fields` holds the non-secret values. `password`: a string sets it;
// omitted keeps the stored one, so Edit can change the other fields alone.
registrationCredentialsRouter.put('/:type/:clientId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...VIEW)
  const spec = specFor(req.params.type)
  const client = await assertCanSeeClient(session, scope, req.params.clientId)

  const b = body(req)
  const e = new FieldErrors()
  let mode: Mode | null = null
  if (spec.modes) {
    mode = b.mode === 'new' || b.mode === 'existing' ? b.mode : null
    if (!mode) e.add('mode', 'Choose new registration or already registered.')
  }

  const raw = (b.fields && typeof b.fields === 'object' ? b.fields : {}) as Record<string, unknown>
  const fields: Record<string, string> = {}
  for (const f of spec.fields) {
    if (!inMode(f.modes, mode)) continue
    const v = typeof raw[f.key] === 'string' ? (raw[f.key] as string).trim() : ''
    if (!v) {
      if (requiredIn(f.required, mode)) e.add(`fields.${f.key}`, `${f.label} is required.`)
      continue
    }
    if (v.length > 500) { e.add(`fields.${f.key}`, `${f.label} is too long.`); continue }
    if (f.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) e.add(`fields.${f.key}`, `Enter a valid email for ${f.label}.`)
    if (f.kind === 'phone' && !/^\+?[0-9\s-]{10,15}$/.test(v)) e.add(`fields.${f.key}`, `Enter a valid mobile number for ${f.label}.`)
    if (f.kind === 'gstin' && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v.toUpperCase())) e.add(`fields.${f.key}`, 'Enter a valid 15-character GSTIN.')
    if (f.kind === 'select' && f.options && !f.options.includes(v)) e.add(`fields.${f.key}`, `Choose a value for ${f.label}.`)
    fields[f.key] = f.kind === 'gstin' ? v.toUpperCase() : v
  }

  const existing = await findLive(client.id, spec.code)
  const usesPassword = !!spec.password && inMode(spec.password.modes, mode)
  let password: string | undefined
  if (usesPassword) {
    if (typeof b.password === 'string' && b.password.length > 0) {
      if (b.password.length > 200) e.add('password', 'Password is too long.')
      else password = b.password
    } else if (!existing?.passwordCiphertext && requiredIn(spec.password!.required, mode)) {
      e.add('password', 'Password is required.')
    }
  }
  e.throwIfAny()

  const passwordData = !usesPassword
    ? { passwordCiphertext: null }
    : password !== undefined
      ? { passwordCiphertext: encryptPortalSecret(password, cryptoField(spec.code)) }
      : {}

  const row = await prisma.registrationCredential.upsert({
    where: { clientId_typeCode: { clientId: client.id, typeCode: spec.code } },
    create: {
      clientId: client.id, typeCode: spec.code, mode, fieldsJson: JSON.stringify(fields),
      passwordCiphertext: password !== undefined ? encryptPortalSecret(password, cryptoField(spec.code)) : null,
      createdBy: session.userId, updatedBy: session.userId,
    },
    // A soft-deleted record is revived rather than duplicated.
    update: { mode, fieldsJson: JSON.stringify(fields), ...passwordData, deletedAt: null, updatedBy: session.userId },
  })

  await writeAudit({
    actorUserId: session.userId,
    action: `registration_credential.${existing ? 'update' : 'create'}`,
    entityType: 'registration_credential', entityId: row.id,
    after: {
      client_id: client.id, registration: spec.code, mode, fields,
      password: password !== undefined ? '<encrypted>' : usesPassword ? '<unchanged>' : '<none>',
    },
    req,
  })
  ok(res, { record: toApi(row) }, existing ? 200 : 201)
}))

registrationCredentialsRouter.delete('/:type/:clientId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...VIEW)
  const spec = specFor(req.params.type)
  const client = await assertCanSeeClient(session, scope, req.params.clientId)
  const row = await findLive(client.id, spec.code)
  if (!row) throw ApiError.notFound('No saved details for this registration.')
  await prisma.registrationCredential.update({
    where: { id: row.id },
    data: { deletedAt: new Date(), passwordCiphertext: null, updatedBy: session.userId },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'registration_credential.delete',
    entityType: 'registration_credential', entityId: row.id,
    after: { client_id: client.id, registration: spec.code }, req,
  })
  ok(res, { deleted: true })
}))

registrationCredentialsRouter.post('/:type/:clientId/reveal', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...REVEAL)
  const spec = specFor(req.params.type)
  const client = await assertCanSeeClient(session, scope, req.params.clientId)
  const row = await findLive(client.id, spec.code)
  if (!row?.passwordCiphertext) throw ApiError.notFound('No password is saved for this registration.')
  const value = decryptPortalSecret(row.passwordCiphertext, cryptoField(spec.code))
  if (value === null) throw ApiError.notFound('No password is saved for this registration.')
  const action = body(req).action === 'copy' ? 'copy' : 'show'
  await writeAudit({
    actorUserId: session.userId, action: 'registration_credential.reveal',
    entityType: 'registration_credential', entityId: row.id,
    after: { client_id: client.id, registration: spec.code, action }, req,
  })
  res.setHeader('Cache-Control', 'no-store')
  ok(res, { value })
}))
