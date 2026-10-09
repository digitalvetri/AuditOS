import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { requireSession, type Session } from '../../platform/auth.js'
import { isAccountAdmin } from '../../platform/roleRank.js'
import { writeAudit } from '../../platform/audit.js'
import { setUploadedFileHeaders } from '../../lib/fileResponse.js'
import { MIN_RETENTION_YEARS, exportClientData, purgeClientRecords, recordsDueForDeletion } from './retention.js'

/**
 * DATA PROTECTION — /api/data-protection
 *
 *   GET   /settings                       any signed-in user (the UI hides AI buttons)
 *   PATCH /settings                       Admin: ai_external_processing, data_retention_years (≥ 7)
 *   GET   /retention/due                  Admin: former clients past their retention period
 *   POST  /retention/clients/:id/purge    Admin: { confirm: <client code> }
 *   GET   /clients/:id/export             Admin: zip for a DPDP access request
 */
export const dataProtectionRouter = Router()

async function orgOf(session: Session): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: session.userId }, select: { organisationId: true } })
  if (!u) throw ApiError.unauthorized()
  return u.organisationId
}

function requireAdmin(session: Session) {
  if (!isAccountAdmin(session)) throw ApiError.forbidden('Only an Admin can do this.')
}

const settingsOut = (o: { aiExternalProcessing: boolean; dataRetentionYears: number }) => ({
  ai_external_processing: o.aiExternalProcessing,
  data_retention_years: o.dataRetentionYears,
  min_retention_years: MIN_RETENTION_YEARS,
})

dataProtectionRouter.get('/settings', handler(async (req, res) => {
  const session = requireSession(req)
  const org = await prisma.organisation.findUniqueOrThrow({ where: { id: await orgOf(session) }, select: { aiExternalProcessing: true, dataRetentionYears: true } })
  ok(res, settingsOut(org))
}))

dataProtectionRouter.patch('/settings', handler(async (req, res) => {
  const session = requireSession(req)
  requireAdmin(session)
  const b = z.object({
    ai_external_processing: z.boolean().optional(),
    data_retention_years: z.number().int().min(MIN_RETENTION_YEARS).max(30).optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest(`Retention is a whole number of years, at least ${MIN_RETENTION_YEARS}.`)
  const id = await orgOf(session)
  const before = await prisma.organisation.findUniqueOrThrow({ where: { id }, select: { aiExternalProcessing: true, dataRetentionYears: true } })
  const after = await prisma.organisation.update({
    where: { id },
    data: {
      ...(b.data.ai_external_processing !== undefined ? { aiExternalProcessing: b.data.ai_external_processing } : {}),
      ...(b.data.data_retention_years !== undefined ? { dataRetentionYears: b.data.data_retention_years } : {}),
      updatedBy: session.userId,
    },
    select: { aiExternalProcessing: true, dataRetentionYears: true },
  })
  await writeAudit({ actorUserId: session.userId, action: 'organisation.data_protection_updated', entityType: 'Organisation', entityId: id, before, after, req })
  ok(res, settingsOut(after))
}))

dataProtectionRouter.get('/retention/due', handler(async (req, res) => {
  const session = requireSession(req)
  requireAdmin(session)
  const items = await recordsDueForDeletion(await orgOf(session))
  ok(res, { items, count: items.length })
}))

dataProtectionRouter.post('/retention/clients/:id/purge', handler(async (req, res) => {
  const session = requireSession(req)
  requireAdmin(session)
  const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm : ''
  const result = await purgeClientRecords({
    organisationId: await orgOf(session), clientId: req.params.id, confirm, actorUserId: session.userId,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'client.records_purged', entityType: 'Client', entityId: req.params.id,
    before: { client_code: result.plan.client_code, exit_date: result.plan.exit_date, retention_ends: result.plan.retention_ends },
    after: { removed: result.plan.remove, retained: result.plan.retained, files_removed: result.files_removed, files_failed: result.files_failed.length },
    req,
  })
  if (result.files_failed.length) {
    console.warn(`[data-protection] purge of ${result.plan.client_code}: ${result.files_failed.length} file(s) could not be removed`, result.files_failed)
  }
  ok(res, result)
}))

dataProtectionRouter.get('/clients/:id/export', handler(async (req, res) => {
  const session = requireSession(req)
  requireAdmin(session)
  const out = await exportClientData(await orgOf(session), req.params.id)
  await writeAudit({
    actorUserId: session.userId, action: 'client.data_exported', entityType: 'Client', entityId: out.client.id,
    after: { client_code: out.client.clientCode, files: out.files, missing_files: out.missing, bytes: out.zip.length }, req,
  })
  setUploadedFileHeaders(res, { mime: 'application/zip', filename: `${out.client.clientCode}-data-export.zip`, inline: false, size: out.zip.length })
  res.end(out.zip)
}))
