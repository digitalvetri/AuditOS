/**
 * SERVICE MASTER — /api/service-master.
 *
 * The firm's standard services, each with its scope of work as individual
 * selectable activities (scope, deliverables, client responsibilities,
 * exclusions, notes). Engagement letters start from these.
 *
 *   GET    /                    list (engagement read); ?include_inactive=1
 *   GET    /:id                 one service
 *   POST   /                    add a service            (firm-wide engagement manage)
 *   PUT    /:id                 replace a service + its activities
 *   DELETE /:id                 remove (soft)
 *   GET    /coverage?client_id= by Service id: the best letter naming that service
 *
 * Editing the master changes letters written AFTER the change only: a letter
 * keeps the text it was written with.
 */
import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, noContent, ok } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { requireWorkstation, assertCanSeeClient } from '../../platform/workstation/scope.js'
import { writeAudit } from '../../platform/audit.js'
import { prisma } from '../../lib/prisma.js'
import { scopeWhere } from '../engagement/service.js'

export const serviceMasterRouter = Router()

export const ITEM_KINDS = ['scope', 'deliverable', 'responsibility', 'exclusion', 'note'] as const

const INCLUDE = { items: { orderBy: { sortOrder: 'asc' as const } } }
type Row = NonNullable<Awaited<ReturnType<typeof loadRow>>>
const loadRow = (id: string) => prisma.serviceMaster.findFirst({ where: { id, deletedAt: null }, include: INCLUDE })

export function toApi(r: Row) {
  return {
    id: r.id,
    code: r.code,
    category: r.category,
    name: r.name,
    billing_frequency: r.billingFrequency,
    service_code: r.serviceCode,
    is_active: r.isActive,
    sort_order: r.sortOrder,
    items: r.items.map((i) => ({ id: i.id, kind: i.kind, content: i.content, default_selected: i.defaultSelected })),
    updated_at: r.updatedAt,
  }
}

/** The library is the firm's, not one person's: editing it is a partner's call. */
function requireFirmEdit(session: Session) {
  if (!can(session, 'workstation.engagement.manage', 'organisation')) {
    throw ApiError.forbidden('Only a partner can change the service master.')
  }
}

const bodySchema = z.object({
  category: z.string().trim().min(1, 'Give the main service.').max(120),
  name: z.string().trim().min(1, 'Name the service.').max(200),
  billing_frequency: z.string().trim().min(1, 'Give the billing frequency.').max(60),
  service_code: z.string().trim().max(80).nullish(),
  is_active: z.boolean().default(true),
  sort_order: z.number().int().min(0).max(100000).optional(),
  items: z.array(z.object({
    kind: z.enum(ITEM_KINDS),
    content: z.string().trim().min(1, 'An activity cannot be blank.').max(2000),
    default_selected: z.boolean().default(true),
  })).max(200),
})

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) throw ApiError.badRequest('Check the service.', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
  return r.data
}

async function assertServiceCode(code: string | null | undefined) {
  if (!code) return null
  if (!(await prisma.service.findFirst({ where: { code, deletedAt: null } }))) throw ApiError.badRequest('That Workstation service does not exist.')
  return code
}

const itemsCreate = (items: z.infer<typeof bodySchema>['items']) =>
  items.map((i, n) => ({ kind: i.kind, content: i.content, defaultSelected: i.default_selected, sortOrder: (n + 1) * 10 }))

serviceMasterRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.engagement.read')
  const all = req.query.include_inactive === '1' || req.query.include_inactive === 'true'
  const rows = await prisma.serviceMaster.findMany({
    where: { deletedAt: null, ...(all ? {} : { isActive: true }) },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: INCLUDE,
  })
  ok(res, rows.map(toApi))
}))

/**
 * For each of the client's Workstation services: the best engagement letter
 * that names it — accepted beats sent beats draft. A service no letter names
 * is "none": work should not start until the client has accepted one.
 */
serviceMasterRouter.get('/coverage', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.engagement.read')
  const clientId = String(req.query.client_id ?? '')
  if (!clientId) throw ApiError.badRequest('client_id is required.')
  await assertCanSeeClient(session, scope, clientId)
  const letters = await prisma.engagementLetter.findMany({
    where: { ...(await scopeWhere(session, scope)), clientId, deletedAt: null, status: { in: ['draft', 'sent', 'accepted'] } },
    select: { id: true, letterCode: true, status: true, acceptedAt: true, serviceScopes: true },
    orderBy: { createdAt: 'desc' },
  })
  const rank: Record<string, number> = { accepted: 3, sent: 2, draft: 1 }
  const best = new Map<string, { status: string; letter_id: string; letter_code: string; accepted_at: Date | null }>()
  for (const l of letters) {
    const scopes = Array.isArray(l.serviceScopes) ? (l.serviceScopes as { service_code?: string | null }[]) : []
    for (const s of scopes) {
      if (!s?.service_code) continue
      const cur = best.get(s.service_code)
      if (!cur || rank[l.status] > rank[cur.status]) {
        best.set(s.service_code, { status: l.status, letter_id: l.id, letter_code: l.letterCode, accepted_at: l.acceptedAt })
      }
    }
  }
  // Keyed by Workstation Service id, which is what a client's services carry.
  const services = await prisma.service.findMany({ where: { code: { in: [...best.keys()] } }, select: { id: true, code: true } })
  ok(res, Object.fromEntries(services.map((s) => [s.id, { service_code: s.code, ...best.get(s.code)! }])))
}))

serviceMasterRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.engagement.read')
  const row = await loadRow(req.params.id)
  if (!row) throw ApiError.notFound('Service not found.')
  ok(res, toApi(row))
}))

serviceMasterRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.engagement.manage')
  requireFirmEdit(session)
  const b = parse(bodySchema, req.body)
  const org = await prisma.organisation.findFirst({ select: { id: true } })
  const max = await prisma.serviceMaster.aggregate({ _max: { sortOrder: true } })
  const created = await prisma.serviceMaster.create({
    data: {
      organisationId: org?.id ?? 'org-audit-os',
      code: `SVC_${Date.now().toString(36).toUpperCase()}`,
      category: b.category, name: b.name, billingFrequency: b.billing_frequency,
      serviceCode: await assertServiceCode(b.service_code), isActive: b.is_active,
      sortOrder: b.sort_order ?? (max._max.sortOrder ?? 0) + 10,
      createdBy: session.userId, updatedBy: session.userId,
      items: { create: itemsCreate(b.items) },
    },
    include: INCLUDE,
  })
  await writeAudit({ actorUserId: session.userId, action: 'service_master.create', entityType: 'ServiceMaster', entityId: created.id, after: toApi(created), req })
  ok(res, toApi(created), 201)
}))

serviceMasterRouter.put('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.engagement.manage')
  requireFirmEdit(session)
  const before = await loadRow(req.params.id)
  if (!before) throw ApiError.notFound('Service not found.')
  const b = parse(bodySchema, req.body)
  const serviceCode = await assertServiceCode(b.service_code)
  const after = await prisma.$transaction(async (tx) => {
    await tx.serviceMasterItem.deleteMany({ where: { masterId: before.id } })
    return tx.serviceMaster.update({
      where: { id: before.id },
      data: {
        category: b.category, name: b.name, billingFrequency: b.billing_frequency, serviceCode, isActive: b.is_active,
        ...(b.sort_order !== undefined ? { sortOrder: b.sort_order } : {}),
        updatedBy: session.userId,
        items: { create: itemsCreate(b.items) },
      },
      include: INCLUDE,
    })
  })
  await writeAudit({ actorUserId: session.userId, action: 'service_master.update', entityType: 'ServiceMaster', entityId: after.id, before: toApi(before), after: toApi(after), req })
  ok(res, toApi(after))
}))

serviceMasterRouter.delete('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.engagement.manage')
  requireFirmEdit(session)
  const before = await loadRow(req.params.id)
  if (!before) throw ApiError.notFound('Service not found.')
  await prisma.serviceMaster.update({ where: { id: before.id }, data: { deletedAt: new Date(), isActive: false, updatedBy: session.userId } })
  await writeAudit({ actorUserId: session.userId, action: 'service_master.delete', entityType: 'ServiceMaster', entityId: before.id, before: toApi(before), req })
  noContent(res)
}))
