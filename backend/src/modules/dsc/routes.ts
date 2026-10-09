/**
 * /api/dsc — firm-wide digital signature register (docs/compliance/README.md).
 *
 * Permissions: workstation.dsc.read / .manage. A client's DSCs follow the
 * Workstation client rule; the firm's own DSCs (no client) are visible only
 * to staff who see every client.
 */
import { Router } from 'express'
import type { DigitalSignature, Prisma } from '@prisma/client'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, noContent, ok } from '../../lib/http.js'
import { addDays, daysBetween, istToday } from '../../lib/dates.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { assertCanSeeClient, assignedClientIds, requireWorkstation } from '../../platform/workstation/scope.js'
import { orgOfUser, isIsoDate } from '../compliance/service.js'

const READ = ['workstation.dsc.read', 'workstation.dsc.manage'] as const
const MANAGE = ['workstation.dsc.manage'] as const

export const HOLDER_ROLES = ['director', 'partner', 'proprietor', 'authorised_signatory', 'trustee', 'firm'] as const
export const DSC_CLASSES = ['class3', 'dgft', 'other'] as const
export const DSC_USAGES = ['signing', 'encryption', 'combo'] as const
export const CUSTODY = ['with_firm', 'with_client'] as const
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/

export const dscRouter = Router()

function dscToApi(d: DigitalSignature, clientName: string | null, today: string) {
  const left = daysBetween(today, d.expiryDate)
  return {
    id: d.id, client_id: d.clientId, client_name: clientName,
    holder_name: d.holderName, holder_pan: d.holderPan, holder_role: d.holderRole,
    dsc_class: d.dscClass, usage: d.usage, provider: d.provider, token_serial: d.tokenSerial,
    valid_from: d.validFrom, expiry_date: d.expiryDate, custody: d.custody, notes: d.notes,
    days_left: left, expired: left < 0, last_alert_days: d.lastAlertDays,
    created_at: d.createdAt, updated_at: d.updatedAt,
  }
}

async function caller(req: Parameters<typeof requireSession>[0], perms: readonly string[]) {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...(perms as ['workstation.dsc.read']))
  return { session, scope, organisationId: await orgOfUser(prisma, session.userId) }
}

/** null clientId = a firm DSC: needs every-client visibility. */
async function assertSee(session: ReturnType<typeof requireSession>, scope: Awaited<ReturnType<typeof caller>>['scope'], clientId: string | null) {
  if (clientId) return assertCanSeeClient(session, scope, clientId)
  if ((await assignedClientIds(session, scope)) !== 'ALL') throw ApiError.forbidden('Only staff who see every client can manage the firm\'s own DSCs.')
}

function fields(b: Record<string, unknown>, partial: boolean) {
  const data: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  const has = (k: string) => !partial || b[k] !== undefined
  if (has('holder_name')) { const v = typeof b.holder_name === 'string' ? b.holder_name.trim() : ''; if (!v) errors.holder_name = 'Required.'; else data.holderName = v.slice(0, 200) }
  if (has('expiry_date')) { if (!isIsoDate(b.expiry_date)) errors.expiry_date = 'YYYY-MM-DD.'; else data.expiryDate = b.expiry_date }
  if (b.valid_from !== undefined) {
    if (b.valid_from === null || b.valid_from === '') data.validFrom = null
    else if (!isIsoDate(b.valid_from)) errors.valid_from = 'YYYY-MM-DD.'
    else data.validFrom = b.valid_from
  }
  if (b.holder_pan !== undefined) {
    const v = b.holder_pan === null ? '' : String(b.holder_pan).trim().toUpperCase()
    if (v && !PAN_RE.test(v)) errors.holder_pan = 'Not a valid PAN.'
    else data.holderPan = v || null
  }
  const oneOf = (k: string, col: string, list: readonly string[], nullable: boolean) => {
    if (b[k] === undefined) return
    if (nullable && (b[k] === null || b[k] === '')) { data[col] = null; return }
    if (!list.includes(String(b[k]))) errors[k] = `One of ${list.join(', ')}.`
    else data[col] = b[k]
  }
  oneOf('holder_role', 'holderRole', HOLDER_ROLES, true)
  oneOf('dsc_class', 'dscClass', DSC_CLASSES, false)
  oneOf('usage', 'usage', DSC_USAGES, false)
  oneOf('custody', 'custody', CUSTODY, false)
  for (const [k, col, max] of [['provider', 'provider', 100], ['token_serial', 'tokenSerial', 100], ['notes', 'notes', 2000]] as const) {
    if (b[k] !== undefined) data[col] = b[k] === null ? null : String(b[k]).trim().slice(0, max) || null
  }
  if (data.validFrom && data.expiryDate && String(data.validFrom) > String(data.expiryDate)) errors.expiry_date = 'Must be after valid from.'
  return { data, errors }
}

dscRouter.get('/', handler(async (req, res) => {
  const { session, scope, organisationId } = await caller(req, READ)
  const q = req.query as Record<string, string | undefined>
  const ids = await assignedClientIds(session, scope)
  const today = istToday()
  if (q.client_id && ids !== 'ALL' && !ids.includes(q.client_id)) throw ApiError.forbidden()
  const where: Prisma.DigitalSignatureWhereInput = {
    organisationId, ...alive,
    ...(q.client_id ? { clientId: q.client_id } : ids === 'ALL' ? {} : { clientId: { in: ids } }),
    ...(q.expiring_within_days && /^\d+$/.test(q.expiring_within_days) ? { expiryDate: { lte: addDays(today, Number(q.expiring_within_days)) } } : {}),
  }
  const rows = await prisma.digitalSignature.findMany({ where, orderBy: [{ expiryDate: 'asc' }, { holderName: 'asc' }] })
  const clients = new Map((await prisma.client.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.clientId).filter((x): x is string => !!x))] } }, select: { id: true, companyName: true },
  })).map((c) => [c.id, c.companyName]))
  ok(res, rows.map((r) => dscToApi(r, r.clientId ? clients.get(r.clientId) ?? null : null, today)))
}))

dscRouter.post('/', handler(async (req, res) => {
  const { session, scope, organisationId } = await caller(req, MANAGE)
  const b = req.body ?? {}
  const clientId = typeof b.client_id === 'string' && b.client_id ? b.client_id : null
  await assertSee(session, scope, clientId)
  const client = clientId ? await prisma.client.findFirst({ where: { id: clientId, organisationId, ...alive }, select: { companyName: true } }) : null
  if (clientId && !client) throw ApiError.forbidden()
  const { data, errors } = fields(b, false)
  if (Object.keys(errors).length) throw ApiError.badRequest('Check the highlighted fields.', errors)
  const row = await prisma.digitalSignature.create({
    data: { ...(data as Prisma.DigitalSignatureUncheckedCreateInput), organisationId, clientId, createdBy: session.userId },
  })
  await writeAudit({ actorUserId: session.userId, action: 'dsc.create', entityType: 'DigitalSignature', entityId: row.id, after: row, req })
  ok(res, dscToApi(row, client?.companyName ?? null, istToday()), 201)
}))

dscRouter.patch('/:id', handler(async (req, res) => {
  const { session, scope, organisationId } = await caller(req, MANAGE)
  const row = await prisma.digitalSignature.findFirst({ where: { id: req.params.id, organisationId, ...alive } })
  if (!row) throw ApiError.notFound()
  await assertSee(session, scope, row.clientId)
  const b = req.body ?? {}
  const { data, errors } = fields(b, true)
  if (b.client_id !== undefined) {
    const next = typeof b.client_id === 'string' && b.client_id ? b.client_id : null
    await assertSee(session, scope, next)
    if (next && !(await prisma.client.findFirst({ where: { id: next, organisationId, ...alive }, select: { id: true } }))) throw ApiError.forbidden()
    data.clientId = next
  }
  const validFrom = (data.validFrom as string | null | undefined) ?? row.validFrom
  const expiry = (data.expiryDate as string | undefined) ?? row.expiryDate
  if (validFrom && validFrom > expiry) errors.expiry_date = 'Must be after valid from.'
  if (Object.keys(errors).length) throw ApiError.badRequest('Check the highlighted fields.', errors)
  // A new expiry date is a renewal: the alerts start over.
  if (data.expiryDate && data.expiryDate !== row.expiryDate) data.lastAlertDays = null
  const after = await prisma.digitalSignature.update({ where: { id: row.id }, data: data as Prisma.DigitalSignatureUncheckedUpdateInput })
  await writeAudit({ actorUserId: session.userId, action: 'dsc.update', entityType: 'DigitalSignature', entityId: row.id, before: row, after, req })
  const name = after.clientId ? (await prisma.client.findFirst({ where: { id: after.clientId }, select: { companyName: true } }))?.companyName ?? null : null
  ok(res, dscToApi(after, name, istToday()))
}))

dscRouter.delete('/:id', handler(async (req, res) => {
  const { session, scope, organisationId } = await caller(req, MANAGE)
  const row = await prisma.digitalSignature.findFirst({ where: { id: req.params.id, organisationId, ...alive } })
  if (!row) throw ApiError.notFound()
  await assertSee(session, scope, row.clientId)
  await prisma.digitalSignature.update({ where: { id: row.id }, data: { deletedAt: new Date() } })
  await writeAudit({ actorUserId: session.userId, action: 'dsc.delete', entityType: 'DigitalSignature', entityId: row.id, before: row, req })
  noContent(res)
}))
