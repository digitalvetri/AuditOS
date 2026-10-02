/**
 * TDS PORTAL CREDENTIALS — one record per client, same rules as gst-portal.
 *
 *   GET    /api/tds-portal/status             { clientId: configured } for visible clients (no secrets)
 *   GET    /api/tds-portal/:clientId          record; password reduced to `password_present`
 *   PUT    /api/tds-portal/:clientId          upsert; password encrypted server-side
 *   DELETE /api/tds-portal/:clientId          soft delete + wipe ciphertext (client untouched)
 *   POST   /api/tds-portal/:clientId/reveal   decrypt the password, audit row
 *
 * Isolation is enforced here, not in the UI: every :clientId is checked
 * against assignedClientIds() and every query is keyed on that clientId, so
 * a caller can only ever read the record of a client they can see. Unknown
 * and out-of-scope clients both answer 404 so ids can't be probed.
 */
import { Router } from 'express'
import { prisma } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { requireWorkstation, assignedClientIds } from '../../platform/workstation/scope.js'
import { body, FieldErrors } from '../workstation/validate.js'
import { encryptPortalSecret, decryptPortalSecret } from '../../platform/portalCrypto.js'

const VIEW = ['workstation.tds.portal.view'] as const
const REVEAL = ['workstation.tds.portal.reveal'] as const
const CRYPTO_FIELD = 'tds_portal_password'

export const tdsPortalRouter = Router()

async function assertCanSeeClient(session: ReturnType<typeof requireSession>, scope: 'self' | 'department' | 'organisation', clientId: string) {
  const client = await prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { id: true, companyName: true } })
  if (!client) throw ApiError.notFound('Client not found.')
  const ids = await assignedClientIds(session, scope)
  if (ids !== 'ALL' && !ids.includes(client.id)) throw ApiError.notFound('Client not found.')
  return client
}

function toApi(row: { userId: string; passwordCiphertext: string | null; updatedAt: Date }) {
  return {
    user_id: row.userId,
    password_present: !!row.passwordCiphertext,
    updated_at: row.updatedAt,
  }
}

const findLive = (clientId: string) =>
  prisma.tdsPortalCredential.findFirst({ where: { clientId, deletedAt: null } })

// GET /api/tds-portal/status — which visible clients have credentials configured.
tdsPortalRouter.get('/status', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...VIEW)
  const ids = await assignedClientIds(session, scope)
  const rows = await prisma.tdsPortalCredential.findMany({
    where: { deletedAt: null, ...(ids === 'ALL' ? {} : { clientId: { in: ids } }) },
    select: { clientId: true, userId: true },
  })
  ok(res, { items: rows.map((r) => ({ client_id: r.clientId, user_id: r.userId })) })
}))

tdsPortalRouter.get('/:clientId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...VIEW)
  await assertCanSeeClient(session, scope, req.params.clientId)
  const row = await findLive(req.params.clientId)
  ok(res, { record: row ? toApi(row) : null })
}))

// PUT — `user_id` required. `password`: string sets it, omitted keeps the
// stored one (so Edit can change only the User ID), empty/null is rejected
// on create and ignored on edit.
tdsPortalRouter.put('/:clientId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...VIEW)
  const client = await assertCanSeeClient(session, scope, req.params.clientId)

  const b = body(req)
  const e = new FieldErrors()
  const userId = typeof b.user_id === 'string' ? b.user_id.trim() : ''
  if (!userId) e.add('user_id', 'User ID (TAN) is required.')
  else if (userId.length > 100) e.add('user_id', 'Max 100 characters.')
  const password = typeof b.password === 'string' && b.password.length > 0 ? b.password : undefined
  if (b.password !== undefined && b.password !== null && typeof b.password !== 'string') e.add('password', 'Must be a string.')
  if (password && password.length > 200) e.add('password', 'Max 200 characters.')

  const existing = await findLive(client.id)
  if (!existing && !password) e.add('password', 'Password is required.')
  e.throwIfAny()

  const data: { userId: string; updatedBy: string; passwordCiphertext?: string | null } = { userId, updatedBy: session.userId }
  if (password) data.passwordCiphertext = encryptPortalSecret(password, CRYPTO_FIELD)

  // A soft-deleted row still owns the @unique clientId — revive it instead of inserting.
  const saved = await prisma.tdsPortalCredential.upsert({
    where: { clientId: client.id },
    update: { ...data, deletedAt: null },
    create: { clientId: client.id, ...data, createdBy: session.userId },
  })

  await writeAudit({
    actorUserId: session.userId,
    action: existing ? 'tds_portal_credential.update' : 'tds_portal_credential.create',
    entityType: 'tds_portal_credential',
    entityId: saved.id,
    // Never the plaintext — only whether the password was touched.
    after: { clientId: client.id, companyName: client.companyName, userId, password: password ? '<encrypted>' : '<unchanged>' },
    req,
  })
  ok(res, { record: toApi(saved) })
}))

tdsPortalRouter.delete('/:clientId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...VIEW)
  const client = await assertCanSeeClient(session, scope, req.params.clientId)
  const row = await findLive(client.id)
  if (!row) throw ApiError.notFound('No TDS credentials for this client.')
  await prisma.tdsPortalCredential.update({
    where: { id: row.id },
    data: { deletedAt: new Date(), passwordCiphertext: null, updatedBy: session.userId },
  })
  await writeAudit({
    actorUserId: session.userId,
    action: 'tds_portal_credential.delete',
    entityType: 'tds_portal_credential',
    entityId: row.id,
    after: { clientId: client.id, companyName: client.companyName },
    req,
  })
  ok(res, { deleted: true })
}))

tdsPortalRouter.post('/:clientId/reveal', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...REVEAL)
  const client = await assertCanSeeClient(session, scope, req.params.clientId)
  const row = await findLive(client.id)
  if (!row?.passwordCiphertext) throw ApiError.notFound('No TDS password saved for this client.')
  const value = decryptPortalSecret(row.passwordCiphertext, CRYPTO_FIELD)
  await writeAudit({
    actorUserId: session.userId,
    action: 'tds_portal_credential.reveal',
    entityType: 'tds_portal_credential',
    entityId: row.id,
    after: { clientId: client.id, companyName: client.companyName },
    req,
  })
  // Reveal responses must never be cached by the browser or a proxy.
  res.setHeader('Cache-Control', 'no-store')
  ok(res, { value })
}))
