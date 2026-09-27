/**
 * Books HTTP surface — Tools → Books, backed by Zoho Books.
 *
 *   booksCallbackRouter   public GET /api/books/callback (Zoho's browser
 *                         redirect; the signed state is the authorisation)
 *   booksRouter           everything else; requires books.access, then a
 *                         per-route grant:
 *                           books.settings    connect / disconnect / activate / map
 *                           books.manage      create & edit, sync
 *                           books.accountant  delete, void, payments, banking
 *                           books.reports     reports
 *
 * Tenant isolation: every organisation is looked up by (firm, id), so one
 * firm can never address another firm's Zoho organisation or tokens.
 * Tokens never appear in a response — the serialisers below list fields
 * explicitly.
 */
import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { ApiError, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { can, requirePermission, requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import type { PermissionCode } from '../../platform/rbac/matrix.js'
import { BooksNotConfigured, booksConfig, booksConfigured } from './config.js'
import { toApiError, zohoRequest, ZohoBooksError, type ZohoContext } from './client.js'
import { beginConnect, completeConnect, connectWithCode, disconnect, refreshOrganizations } from './connection.js'
import { ENTITIES, isZohoId, type EntityDef } from './entities.js'
import { computeDashboard, REPORTS, runReport } from './insights.js'

export const booksRouter = Router()
export const booksCallbackRouter = Router()

// ── helpers ──────────────────────────────────────────────────────────────
function translate(err: unknown): unknown {
  if (err instanceof ZohoBooksError) return toApiError(err)
  if (err instanceof BooksNotConfigured) return new ApiError(503, 'books_not_configured', err.message)
  return err
}
/** handler() that maps Zoho/config errors to clean API errors. `pass` = middleware: call next() on success. */
const h = (fn: (req: Request, res: Response) => Promise<unknown>, pass = false) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).then(() => { if (pass) next() }, (e) => next(translate(e)))
  }

function need(req: Request, perm: PermissionCode) {
  if (!can(requireSession(req), perm, 'organisation')) throw ApiError.forbidden('Your role does not allow this Books action.')
}

async function firmOf(req: Request): Promise<{ userId: string; organisationId: string }> {
  const s = requireSession(req)
  const u = await prisma.user.findUniqueOrThrow({ where: { id: s.userId }, select: { organisationId: true } })
  return { userId: s.userId, organisationId: u.organisationId }
}

function cleanBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw ApiError.badRequest('A JSON object body is required.')
  if (JSON.stringify(body).length > 200_000) throw ApiError.badRequest('The request is too large.')
  const out = { ...(body as Record<string, unknown>) }
  for (const k of Object.keys(out)) if (!/^[a-z0-9_]+$/.test(k) || k === 'organization_id') delete out[k]
  return out
}

function entityOf(req: Request): EntityDef {
  const def = ENTITIES[req.params.entity]
  if (!def) throw ApiError.notFound('Unknown Books resource.')
  return def
}
function idOf(req: Request): string {
  if (!isZohoId(req.params.id)) throw ApiError.badRequest('Invalid Zoho Books id.')
  return req.params.id
}

function serializeOrg(o: {
  id: string; zohoOrgId: string; name: string; currencyCode: string | null; countryCode: string | null; isActive: boolean
  clientId: string | null; connectionId: string; syncStatus: string; lastSyncAt: Date | null; lastSyncAttemptAt: Date | null
  lastSyncError: string | null; activatedAt: Date | null; autoRefreshMinutes: number
}, extra: Record<string, unknown> = {}) {
  return {
    id: o.id, zoho_org_id: o.zohoOrgId, name: o.name, currency_code: o.currencyCode, country: o.countryCode,
    is_active: o.isActive, client_id: o.clientId, connection_id: o.connectionId, sync_status: o.syncStatus,
    last_sync_at: o.lastSyncAt, last_sync_attempt_at: o.lastSyncAttemptAt, last_sync_error: o.lastSyncError,
    activated_at: o.activatedAt, auto_refresh_minutes: o.autoRefreshMinutes, ...extra,
  }
}

// ── OAuth callback (public) ──────────────────────────────────────────────
booksCallbackRouter.get('/callback', async (req, res) => {
  const back = (() => { try { return booksConfig().webReturnUrl } catch { return '/books/settings' } })()
  const q = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : null)
  const go = (params: Record<string, string>) => res.redirect(302, `${back}?${new URLSearchParams(params)}`)
  if (q('error')) return go({ zoho: 'error', reason: q('error')!.slice(0, 60) })
  const code = q('code'); const state = q('state')
  if (!code || !state) return go({ zoho: 'error', reason: 'missing_parameters' })
  try {
    const r = await completeConnect({ code, state, accountsServer: q('accounts-server') })
    await writeAudit({ actorUserId: r.userId, action: 'books.zoho.connected', entityType: 'books.connection', entityId: r.connectionId, after: { organizations: r.organizations }, req })
    return go({ zoho: 'connected' })
  } catch (e) {
    const t = translate(e)
    const reason = t instanceof ApiError ? t.code : 'oauth_failed'
    console.warn('[books] callback failed', reason)
    return go({ zoho: 'error', reason })
  }
})

// ── connection & organisations ───────────────────────────────────────────
booksRouter.use(requirePermission('books.access', 'organisation'))

booksRouter.get('/status', h(async (req, res) => {
  const { organisationId } = await firmOf(req)
  const session = requireSession(req)
  const [connections, orgs] = await Promise.all([
    prisma.booksZohoConnection.findMany({ where: { organisationId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
    prisma.booksZohoOrganization.findMany({ where: { organisationId }, orderBy: { name: 'asc' } }),
  ])
  const clientIds = orgs.flatMap((o) => (o.clientId ? [o.clientId] : []))
  const clients = clientIds.length ? await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, companyName: true } }) : []
  const clientName = new Map(clients.map((c) => [c.id, c.companyName]))
  const connStatus = new Map(connections.map((c) => [c.id, c.status]))
  const visible = connections.filter((c) => c.status !== 'disconnected' || orgs.some((o) => o.connectionId === c.id))
  ok(res, {
    configured: booksConfigured(),
    connections: visible.map((c) => ({
      id: c.id, status: c.status, connected_at: c.connectedAt, last_error_code: c.lastErrorCode,
      last_error_at: c.lastErrorAt, scopes: c.scopesGranted, data_center: c.accountsServer,
    })),
    organizations: orgs.map((o) => serializeOrg(o, { client_name: o.clientId ? clientName.get(o.clientId) ?? null : null, connection_status: connStatus.get(o.connectionId) ?? 'disconnected' })),
    permissions: {
      manage: can(session, 'books.manage', 'organisation'), accountant: can(session, 'books.accountant', 'organisation'),
      settings: can(session, 'books.settings', 'organisation'), reports: can(session, 'books.reports', 'organisation'),
    },
  })
}))

booksRouter.post('/connect', h(async (req, res) => {
  need(req, 'books.settings')
  const { userId, organisationId } = await firmOf(req)
  ok(res, await beginConnect({ organisationId, userId }))
}))

// Connect with a grant code pasted from the Zoho API console (Self Client).
// No browser redirect — works whatever redirect URI the Zoho client has.
booksRouter.post('/connect/code', h(async (req, res) => {
  need(req, 'books.settings')
  const { userId, organisationId } = await firmOf(req)
  const b = (req.body ?? {}) as { code?: unknown; data_center?: unknown }
  const code = typeof b.code === 'string' ? b.code.trim() : ''
  if (!/^1000\.[A-Za-z0-9.]{20,200}$/.test(code)) {
    throw ApiError.badRequest('Paste the whole code from Zoho — it starts with "1000." and looks like 1000.abc…', { code: 'Invalid code format.' })
  }
  const dc = typeof b.data_center === 'string' && b.data_center ? b.data_center : null
  const r = await connectWithCode({ organisationId, userId, code, accountsServer: dc })
  ok(res, r)
}))

booksRouter.post('/connections/:id/reconnect', h(async (req, res) => {
  need(req, 'books.settings')
  const { userId, organisationId } = await firmOf(req)
  ok(res, await beginConnect({ organisationId, userId, connectionId: req.params.id }))
}))

booksRouter.post('/connections/:id/disconnect', h(async (req, res) => {
  need(req, 'books.settings')
  const { userId, organisationId } = await firmOf(req)
  await disconnect({ organisationId, userId, connectionId: req.params.id })
  await writeAudit({ actorUserId: userId, action: 'books.zoho.disconnected', entityType: 'books.connection', entityId: req.params.id, req })
  ok(res, { disconnected: true })
}))

booksRouter.post('/connections/:id/organizations/refresh', h(async (req, res) => {
  need(req, 'books.settings')
  const { organisationId } = await firmOf(req)
  const conn = await prisma.booksZohoConnection.findFirst({ where: { id: req.params.id, organisationId, deletedAt: null } })
  if (!conn) throw ApiError.notFound('No such Zoho Books connection.')
  ok(res, { organizations: await refreshOrganizations(conn, organisationId) })
}))

booksRouter.get('/clients', h(async (req, res) => {
  need(req, 'books.settings')
  const { organisationId } = await firmOf(req)
  const rows = await prisma.client.findMany({ where: { organisationId }, select: { id: true, companyName: true, clientCode: true }, orderBy: { companyName: 'asc' } })
  ok(res, { items: rows.map((c) => ({ id: c.id, name: c.companyName, code: c.clientCode })) })
}))

booksRouter.patch('/organizations/:id', h(async (req, res) => {
  need(req, 'books.settings')
  const { userId, organisationId } = await firmOf(req)
  const org = await prisma.booksZohoOrganization.findFirst({ where: { id: req.params.id, organisationId }, include: { connection: true } })
  if (!org) throw ApiError.notFound('No such Zoho Books organisation.')
  const body = (req.body ?? {}) as { is_active?: unknown; client_id?: unknown; auto_refresh_minutes?: unknown }
  const data: { isActive?: boolean; activatedAt?: Date; activatedBy?: string; clientId?: string | null; autoRefreshMinutes?: number } = {}

  if (body.is_active !== undefined) {
    if (typeof body.is_active !== 'boolean') throw ApiError.badRequest('is_active must be true or false.')
    if (body.is_active && org.connection.status !== 'connected') throw ApiError.conflict('books_reconnect_required', 'Reconnect Zoho Books before activating this organisation.')
    data.isActive = body.is_active
    if (body.is_active && !org.isActive) { data.activatedAt = new Date(); data.activatedBy = userId }
  }
  if (body.client_id !== undefined) {
    if (body.client_id === null || body.client_id === '') data.clientId = null
    else {
      if (typeof body.client_id !== 'string') throw ApiError.badRequest('client_id must be a string.')
      const client = await prisma.client.findFirst({ where: { id: body.client_id, organisationId }, select: { id: true } })
      if (!client) throw ApiError.badRequest('No such client.')
      const other = await prisma.booksZohoOrganization.findFirst({ where: { organisationId, clientId: body.client_id, id: { not: org.id } }, select: { name: true } })
      if (other) throw ApiError.conflict('books_client_already_mapped', `This client is already mapped to the Zoho Books organisation "${other.name}".`)
      data.clientId = body.client_id
    }
  }
  if (body.auto_refresh_minutes !== undefined) {
    const n = Number(body.auto_refresh_minutes)
    if (!Number.isInteger(n) || n < 0 || n > 1440) throw ApiError.badRequest('auto_refresh_minutes must be 0–1440.')
    data.autoRefreshMinutes = n
  }
  const updated = await prisma.booksZohoOrganization.update({ where: { id: org.id }, data })
  await writeAudit({ actorUserId: userId, action: 'books.organization.updated', entityType: 'books.organization', entityId: org.id, before: { is_active: org.isActive, client_id: org.clientId }, after: { is_active: updated.isActive, client_id: updated.clientId, zoho_org_id: org.zohoOrgId }, req })
  ok(res, serializeOrg(updated))
}))

// ── one active organisation ──────────────────────────────────────────────
async function loadOrg(organisationId: string, id: string) {
  return prisma.booksZohoOrganization.findFirst({ where: { id, organisationId }, include: { connection: true } })
}
interface Loc { org: NonNullable<Awaited<ReturnType<typeof loadOrg>>>; userId: string; ctx: ZohoContext }
const loc = (res: Response) => res.locals.books as Loc

const orgRouter = Router()
booksRouter.use('/o/:ref', h(async (req, res) => {
  const { organisationId, userId } = await firmOf(req)
  const org = await loadOrg(organisationId, req.params.ref)
  if (!org || !org.isActive) throw ApiError.notFound('This Zoho Books organisation is not active in Audit OS.')
  if (org.connection.status !== 'connected') throw ApiError.conflict('books_reconnect_required', 'The Zoho Books connection has expired or was revoked. Reconnect it in Books → Settings.')
  res.locals.books = { org, userId, ctx: { conn: org.connection, zohoOrgId: org.zohoOrgId } } satisfies Loc
}, true), orgRouter)

// Sync: one at a time per organisation (a stale claim older than 5 min is reclaimable).
async function runSync(res: Response, trigger: 'manual' | 'auto', req: Request) {
  const { org, userId, ctx } = loc(res)
  const claim = await prisma.booksZohoOrganization.updateMany({
    where: { id: org.id, OR: [{ syncStatus: { not: 'syncing' } }, { lastSyncAttemptAt: { lt: new Date(Date.now() - 5 * 60_000) } }] },
    data: { syncStatus: 'syncing', lastSyncAttemptAt: new Date() },
  })
  if (claim.count === 0) throw ApiError.conflict('books_sync_in_progress', 'A sync is already running for this organisation.')
  const log = await prisma.booksSyncLog.create({ data: { zohoOrgRef: org.id, trigger, status: 'running', startedBy: userId } })
  const counter = { calls: 0 }
  try {
    const snapshot = await computeDashboard({ ...ctx, counter }, org.currencyCode)
    const now = new Date()
    await prisma.booksZohoOrganization.update({ where: { id: org.id }, data: { syncStatus: 'synced', lastSyncAt: now, lastSyncError: null, snapshotJson: JSON.stringify(snapshot) } })
    await prisma.booksSyncLog.update({ where: { id: log.id }, data: { status: 'succeeded', finishedAt: now, apiCalls: counter.calls } })
    if (trigger === 'manual') await writeAudit({ actorUserId: userId, action: 'books.sync.completed', entityType: 'books.organization', entityId: org.id, after: { api_calls: counter.calls }, req })
    return { snapshot, lastSyncAt: now }
  } catch (e) {
    const t = translate(e)
    const message = t instanceof ApiError ? t.message : 'Sync failed.'
    await prisma.booksZohoOrganization.update({ where: { id: org.id }, data: { syncStatus: 'failed', lastSyncError: message } })
    await prisma.booksSyncLog.update({ where: { id: log.id }, data: { status: 'failed', finishedAt: new Date(), error: message, apiCalls: counter.calls } })
    await writeAudit({ actorUserId: userId, action: 'books.sync.failed', entityType: 'books.organization', entityId: org.id, after: { error: message }, req })
    throw e
  }
}

orgRouter.get('/dashboard', h(async (req, res) => {
  const { org } = loc(res)
  const stale = !org.snapshotJson || (org.autoRefreshMinutes > 0 && (!org.lastSyncAt || Date.now() - org.lastSyncAt.getTime() > org.autoRefreshMinutes * 60_000))
  if (stale && org.syncStatus !== 'syncing') {
    try {
      const r = await runSync(res, 'auto', req)
      return ok(res, { snapshot: r.snapshot, last_sync_at: r.lastSyncAt, sync_status: 'synced', last_sync_error: null })
    } catch (e) {
      if (!org.snapshotJson) throw translate(e)
      const t = translate(e)
      return ok(res, { snapshot: JSON.parse(org.snapshotJson), last_sync_at: org.lastSyncAt, sync_status: 'failed', last_sync_error: t instanceof ApiError ? t.message : 'Sync failed.' })
    }
  }
  ok(res, { snapshot: org.snapshotJson ? JSON.parse(org.snapshotJson) : null, last_sync_at: org.lastSyncAt, sync_status: org.syncStatus, last_sync_error: org.lastSyncError })
}))

orgRouter.post('/sync', h(async (req, res) => {
  need(req, 'books.manage')
  await writeAudit({ actorUserId: loc(res).userId, action: 'books.sync.started', entityType: 'books.organization', entityId: loc(res).org.id, req })
  const r = await runSync(res, 'manual', req)
  ok(res, { snapshot: r.snapshot, last_sync_at: r.lastSyncAt, sync_status: 'synced', last_sync_error: null })
}))

orgRouter.get('/sync-logs', h(async (_req, res) => {
  const rows = await prisma.booksSyncLog.findMany({ where: { zohoOrgRef: loc(res).org.id }, orderBy: { startedAt: 'desc' }, take: 20 })
  ok(res, { items: rows.map((r) => ({ id: r.id, trigger: r.trigger, status: r.status, error: r.error, api_calls: r.apiCalls, started_at: r.startedAt, finished_at: r.finishedAt })) })
}))

orgRouter.get('/organization', h(async (_req, res) => {
  const { ctx, org } = loc(res)
  const r = await zohoRequest<{ organization?: Record<string, unknown> }>(ctx, { path: `organizations/${org.zohoOrgId}` })
  ok(res, r.organization ?? null)
}))

orgRouter.get('/reports', h(async (req, res) => { need(req, 'books.reports'); ok(res, { items: REPORTS }) }))
orgRouter.get('/reports/:report', h(async (req, res) => {
  need(req, 'books.reports')
  if (!REPORTS.some((r) => r.id === req.params.report)) throw ApiError.notFound('Unknown report.')
  const date = (k: string, d: string) => { const v = req.query[k]; return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : d }
  const now = new Date()
  const fyStart = `${now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1}-04-01`
  ok(res, await runReport(loc(res).ctx, req.params.report, date('from', fyStart), date('to', now.toISOString().slice(0, 10))))
}))

// Bank match suggestions for an uncategorised transaction.
orgRouter.get('/e/banktransactions/:id/match', h(async (req, res) => {
  const r = await zohoRequest(loc(res).ctx, { path: `banktransactions/uncategorized/${idOf(req)}/match`, cache: false })
  ok(res, { items: (r as Record<string, unknown>).matching_transactions ?? [] })
}))

// ── generic resources ────────────────────────────────────────────────────
orgRouter.get('/e/:entity', h(async (req, res) => {
  const def = entityOf(req)
  const query: Record<string, string> = { ...(def.baseQuery ?? {}) }
  for (const p of def.listParams) {
    const v = req.query[p]
    if (typeof v === 'string' && v.length <= 200) query[p] = v
  }
  query.per_page = String(Math.min(Math.max(Number(query.per_page) || 25, 1), 200))
  const r = await zohoRequest<Record<string, unknown>>(loc(res).ctx, { path: def.path, query })
  const pc = (r.page_context ?? {}) as { page?: number; per_page?: number; has_more_page?: boolean }
  ok(res, { items: (r[def.listKey] as unknown[]) ?? [], page: pc.page ?? Number(query.page ?? 1), per_page: pc.per_page ?? Number(query.per_page), has_more: Boolean(pc.has_more_page) })
}))

orgRouter.get('/e/:entity/:id', h(async (req, res) => {
  const def = entityOf(req)
  const r = await zohoRequest<Record<string, unknown>>(loc(res).ctx, { path: `${def.path}/${idOf(req)}` })
  if (!r[def.key]) throw ApiError.notFound('This record no longer exists in Zoho Books.')
  ok(res, r[def.key])
}))

orgRouter.get('/e/:entity/:id/pdf', h(async (req, res) => {
  const def = entityOf(req)
  if (!def.pdf) throw ApiError.notFound('PDF is not available for this record type.')
  const buf = await zohoRequest<Buffer>(loc(res).ctx, { path: `${def.path}/${idOf(req)}`, query: { accept: 'pdf' }, binary: true })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${req.params.entity}-${req.params.id}.pdf"`)
  res.setHeader('Cache-Control', 'private, no-store')
  res.end(buf)
}))

async function audit(req: Request, res: Response, def: EntityDef, verb: string, zohoId: string, record?: Record<string, unknown>) {
  const number = def.numberField && record ? record[def.numberField] : record?.contact_name ?? record?.name ?? undefined
  await writeAudit({ actorUserId: loc(res).userId, action: `books.${req.params.entity}.${verb}`, entityType: `books.${req.params.entity}`, entityId: zohoId, after: { zoho_org_id: loc(res).org.zohoOrgId, ...(number ? { ref: number } : {}) }, req })
}

orgRouter.post('/e/:entity', h(async (req, res) => {
  const def = entityOf(req)
  if (!def.create) throw ApiError.notFound('Creating this record type is not supported.')
  need(req, def.create)
  const body = { ...cleanBody(req.body), ...(def.createDefaults ?? {}) }
  const query = def.numberField && typeof body[def.numberField] === 'string' && body[def.numberField] ? { ignore_auto_number_generation: 'true' } : undefined
  const r = await zohoRequest<Record<string, unknown>>(loc(res).ctx, { method: 'POST', path: def.path, body, query })
  const rec = r[def.key] as Record<string, unknown> | undefined
  if (!rec) throw new ZohoBooksError('bad_response', 'create returned no record')
  await audit(req, res, def, 'created', String(rec[def.idField]), rec)
  ok(res, rec, 201)
}))

orgRouter.put('/e/:entity/:id', h(async (req, res) => {
  const def = entityOf(req)
  if (!def.update) throw ApiError.notFound('Editing this record type is not supported.')
  need(req, def.update)
  const r = await zohoRequest<Record<string, unknown>>(loc(res).ctx, { method: 'PUT', path: `${def.path}/${idOf(req)}`, body: cleanBody(req.body) })
  const rec = r[def.key] as Record<string, unknown> | undefined
  await audit(req, res, def, 'updated', req.params.id, rec)
  ok(res, rec ?? null)
}))

orgRouter.delete('/e/:entity/:id', h(async (req, res) => {
  const def = entityOf(req)
  if (!def.remove) throw ApiError.notFound('Deleting this record type is not supported.')
  need(req, def.remove)
  await zohoRequest(loc(res).ctx, { method: 'DELETE', path: `${def.path}/${idOf(req)}` })
  await audit(req, res, def, 'deleted', req.params.id)
  ok(res, { deleted: true })
}))

orgRouter.post('/e/:entity/:id/a/:action', h(async (req, res) => {
  const def = entityOf(req)
  const action = def.actions?.[req.params.action]
  if (!action) throw ApiError.notFound('This action is not supported for this record type.')
  need(req, action.perm)
  const r = await zohoRequest<Record<string, unknown>>(loc(res).ctx, {
    method: action.method, path: `${action.root ?? def.path}/${idOf(req)}/${action.sub}`, body: action.body ? cleanBody(req.body) : undefined,
  })
  await audit(req, res, def, req.params.action, req.params.id)
  ok(res, { message: typeof r.message === 'string' ? r.message : 'Done.' })
}))

const receiptUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } })
orgRouter.post('/e/expenses/:id/receipt', receiptUpload.single('receipt'), h(async (req, res) => {
  need(req, 'books.manage')
  if (!req.file) throw ApiError.badRequest('Attach a receipt file.')
  if (!/^(image\/(png|jpe?g|gif)|application\/pdf)$/.test(req.file.mimetype)) throw ApiError.badRequest('Receipts must be a PDF or an image.')
  const form = new FormData()
  form.append('receipt', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname.replace(/[^\w.-]/g, '_'))
  await zohoRequest(loc(res).ctx, { method: 'POST', path: `expenses/${idOf(req)}/receipt`, form })
  await writeAudit({ actorUserId: loc(res).userId, action: 'books.expenses.receipt_attached', entityType: 'books.expenses', entityId: req.params.id, req })
  ok(res, { attached: true })
}))
