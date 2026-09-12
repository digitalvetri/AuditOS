import { Router } from 'express'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { writeActivity } from '../../platform/workstation/activity.js'
import {
  assertCanSeeClient, clientScopeWhere, requireWorkstation,
} from '../../platform/workstation/scope.js'
import { nextRegistrationCode } from '../../platform/workstation/codes.js'
import { employeeMap } from '../../api/workstation.serialize.js'
import { body, FieldErrors } from '../workstation/validate.js'
import {
  REGISTRATION_STATUSES, assertRegisteredHasNumber, assertStatusTransition,
  type RegistrationStatus,
} from './validate.js'
import { overview, renewalFrom, today, writeRegistrationEvent } from './service.js'
import { registrationToApi, registrationTypeToApi } from './serialize.js'

/**
 * REGISTRATION SERVICE.
 *
 * The ten registrations the firm files for clients, under Workstation →
 * Services → Registration.
 *
 * IT CALLS NOTHING. There is no GST, MCA, DGFT, EPFO or ESIC client in this
 * module — not even a mocked one. Every government fact it holds (GSTIN, CIN,
 * ARN, IEC) was typed in by an employee, is stamped with who typed it and
 * when, and is serialised with that attribution attached. Nothing here has
 * been confirmed by a department.
 *
 * Permissions are the EXISTING workstation.service.read / .manage pair that
 * Bookkeeping and Incorporation already use — this module adds no permission
 * code. Catalogue writes additionally require .manage at `organisation`.
 */
export const registrationsRouter = Router()

const include = { client: true, type: true }
const withEvents = { ...include, events: { orderBy: { createdAt: 'desc' as const }, take: 50 } }

/** Employee ids referenced by a set of rows, for one lookup per request. */
const actorIds = (rows: { assignedEmployeeId: string | null; recordedByEmployeeId: string | null }[]) =>
  rows.flatMap((r) => [r.assignedEmployeeId, r.recordedByEmployeeId])

// ── Catalogue ──────────────────────────────────────────────────────────────

// GET /api/registrations/types
registrationsRouter.get('/types', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.service.read', 'workstation.service.manage')
  const rows = await prisma.registrationType.findMany({
    where: { ...alive, isActive: true },
    orderBy: { sortOrder: 'asc' },
  })
  ok(res, { items: rows.map(registrationTypeToApi), count: rows.length })
}))

// ── Board ──────────────────────────────────────────────────────────────────

// GET /api/registrations/overview — the tiles above the board.
registrationsRouter.get('/overview', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.service.read', 'workstation.service.manage')
  ok(res, { ...(await overview(await clientScopeWhere(session, scope))), scope })
}))

// GET /api/registrations — cross-client list, scoped.
registrationsRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.service.read', 'workstation.service.manage')

  const q = req.query
  const str = (k: string) => (typeof q[k] === 'string' && q[k] ? (q[k] as string) : null)
  const typeCode = str('type')
  const status = str('status')
  const clientId = str('client_id')
  // `renewal_due=true` is the one filter the board cannot express as a column
  // match — it is a comparison against today.
  const renewalDue = str('renewal_due') === 'true'

  const rows = await prisma.clientRegistration.findMany({
    where: {
      ...alive,
      ...(await clientScopeWhere(session, scope)),
      ...(status ? { status } : {}),
      ...(clientId ? { clientId } : {}),
      ...(typeCode ? { type: { code: typeCode } } : {}),
      ...(renewalDue ? { status: 'registered', nextRenewalOn: { lte: today(), not: null } } : {}),
    },
    include,
    orderBy: [{ updatedAt: 'desc' }],
  })

  const m = await employeeMap(actorIds(rows))
  const t = today()
  ok(res, { items: rows.map((r) => registrationToApi(r, m, t)), count: rows.length, scope })
}))

// GET /api/registrations/:id
registrationsRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.service.read', 'workstation.service.manage')
  const row = await prisma.clientRegistration.findFirst({
    where: { id: req.params.id, ...alive }, include: withEvents,
  })
  if (!row) throw ApiError.notFound('Registration not found.')
  await assertCanSeeClient(session, scope, row.clientId)

  const m = await employeeMap([...actorIds([row]), ...row.events.map((e) => e.actorEmployeeId)])
  ok(res, registrationToApi(row, m, today()))
}))

// POST /api/registrations — open one for a client.
registrationsRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.service.manage')
  const b = body(req)

  const v = new FieldErrors()
  const clientId = v.str('client_id', b.client_id)
  const typeCode = v.str('type_code', b.type_code)
  const assignedEmployeeId = v.str('assigned_employee_id', b.assigned_employee_id, { required: false })
  const notes = v.str('notes', b.notes, { required: false, max: 2000 })
  v.throwIfAny()

  await assertCanSeeClient(session, scope, clientId!)

  const type = await prisma.registrationType.findFirst({ where: { code: typeCode!, ...alive } })
  if (!type) {
    throw ApiError.badRequest('Unknown registration.', { type_code: 'Select a valid registration.' })
  }

  // One live registration of each kind per client. Checked here rather than
  // with a DB unique index, because soft-deleted rows would occupy the index
  // and permanently block re-registering — see the schema note.
  const existing = await prisma.clientRegistration.findFirst({
    where: { clientId: clientId!, typeId: type.id, ...alive },
  })
  if (existing) {
    throw ApiError.conflict(
      'already_open',
      `This client already has a ${type.shortName} registration (${existing.registrationCode}).`,
      { type_code: 'Open the existing registration instead of starting a second one.' },
    )
  }

  const row = await prisma.$transaction(async (tx) => {
    const code = await nextRegistrationCode(tx, Number(today().slice(0, 4)))
    return tx.clientRegistration.create({
      data: {
        organisationId: 'org-audit-os',
        registrationCode: code,
        clientId: clientId!,
        typeId: type.id,
        status: 'not_started',
        assignedEmployeeId: assignedEmployeeId ?? session.employeeId ?? null,
        notes: notes ?? null,
        recordedByEmployeeId: session.employeeId ?? null,
        createdBy: session.userId,
        updatedBy: session.userId,
      },
      include,
    })
  })

  await writeRegistrationEvent(row.id, session, 'registration.opened', `${type.name} opened.`)
  await writeActivity({
    session, subjectType: 'client', subjectId: row.clientId,
    action: 'registration.opened', description: `${type.name} opened (${row.registrationCode}).`,
    entityType: 'ClientRegistration', entityId: row.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'client_registration.create',
    entityType: 'ClientRegistration', entityId: row.id, after: row, req,
  })

  const m = await employeeMap(actorIds([row]))
  ok(res, {
    ...registrationToApi(row, m, today()),
    /* Honest about what did NOT happen: opening a row files nothing. */
    portal_notice: 'Opened in Audit OS only. No application has been made — file on the portal, then record the outcome here.',
  }, 201)
}))

// PATCH /api/registrations/:id — record what the portal returned.
registrationsRouter.patch('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.service.manage')
  const b = body(req)

  const before = await prisma.clientRegistration.findFirst({
    where: { id: req.params.id, ...alive }, include,
  })
  if (!before) throw ApiError.notFound('Registration not found.')
  await assertCanSeeClient(session, scope, before.clientId)

  const v = new FieldErrors()
  const data: Record<string, unknown> = {}

  let nextStatus = before.status as RegistrationStatus
  if ('status' in b) {
    const s = v.oneOf('status', b.status, REGISTRATION_STATUSES)
    if (s) nextStatus = s
  }
  if ('application_ref' in b) data.applicationRef = v.str('application_ref', b.application_ref, { required: false, max: 60 }) ?? null
  if ('registration_number' in b) data.registrationNumber = v.str('registration_number', b.registration_number, { required: false, max: 60 }) ?? null
  if ('applied_on' in b) data.appliedOn = v.date('applied_on', b.applied_on) ?? null
  if ('registered_on' in b) data.registeredOn = v.date('registered_on', b.registered_on) ?? null
  if ('valid_till' in b) data.validTill = v.date('valid_till', b.valid_till) ?? null
  if ('assigned_employee_id' in b) data.assignedEmployeeId = v.str('assigned_employee_id', b.assigned_employee_id, { required: false }) ?? null
  if ('certificate_document_id' in b) data.certificateDocumentId = v.str('certificate_document_id', b.certificate_document_id, { required: false }) ?? null
  if ('notes' in b) data.notes = v.str('notes', b.notes, { required: false, max: 2000 }) ?? null
  v.throwIfAny()

  assertStatusTransition(before.status as RegistrationStatus, nextStatus)

  const registrationNumber = 'registration_number' in b
    ? (data.registrationNumber as string | null)
    : before.registrationNumber
  assertRegisteredHasNumber(nextStatus, registrationNumber)

  // Becoming `registered` stamps the date if the caller did not, and derives
  // the next renewal from the type's cadence.
  const registeredOn = nextStatus === 'registered'
    ? ((data.registeredOn as string | null) ?? before.registeredOn ?? today())
    : ((data.registeredOn as string | undefined) ?? before.registeredOn)

  data.status = nextStatus
  data.registeredOn = registeredOn ?? null
  data.nextRenewalOn = renewalFrom(nextStatus, registeredOn ?? null, before.type?.renewalMonths ?? null)
  // The facts below were typed in by this employee, now.
  data.recordedByEmployeeId = session.employeeId ?? null
  data.recordedAt = new Date()
  data.updatedBy = session.userId

  const row = await prisma.clientRegistration.update({
    where: { id: before.id }, data, include,
  })

  if (before.status !== row.status) {
    await writeRegistrationEvent(
      row.id, session, 'registration.status',
      `${before.status} → ${row.status}${row.registrationNumber ? ` · ${row.registrationNumber}` : ''}`,
    )
    await writeActivity({
      session, subjectType: 'client', subjectId: row.clientId,
      action: 'registration.status',
      description: `${row.type?.name ?? 'Registration'} moved to ${row.status}.`,
      entityType: 'ClientRegistration', entityId: row.id,
    })
  } else {
    await writeRegistrationEvent(row.id, session, 'registration.updated', 'Details updated.')
  }
  await writeAudit({
    actorUserId: session.userId, action: 'client_registration.update',
    entityType: 'ClientRegistration', entityId: row.id, before, after: row, req,
  })

  const m = await employeeMap(actorIds([row]))
  ok(res, registrationToApi(row, m, today()))
}))

// POST /api/registrations/:id/events — a note on the trail.
registrationsRouter.post('/:id/events', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.service.manage')
  const b = body(req)

  const row = await prisma.clientRegistration.findFirst({
    where: { id: req.params.id, ...alive },
  })
  if (!row) throw ApiError.notFound('Registration not found.')
  await assertCanSeeClient(session, scope, row.clientId)

  const v = new FieldErrors()
  const detail = v.str('detail', b.detail, { max: 1000 })
  v.throwIfAny()

  await writeRegistrationEvent(row.id, session, 'registration.note', detail!)
  const events = await prisma.registrationEvent.findMany({
    where: { registrationId: row.id }, orderBy: { createdAt: 'desc' }, take: 50,
  })
  const m = await employeeMap(events.map((e) => e.actorEmployeeId))
  ok(res, { items: events.map((e) => ({
    id: e.id, registration_id: e.registrationId, action: e.action, detail: e.detail,
    actor: e.actorEmployeeId ? m.get(e.actorEmployeeId) ?? null : null,
    created_at: e.createdAt.toISOString(),
  })), count: events.length }, 201)
}))
