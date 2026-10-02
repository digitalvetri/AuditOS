import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, noContent, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'
import { Checklists } from './service.js'
import { CHECKLIST_KINDS, CHECKLIST_STATUSES, FREQUENCIES, type ChecklistKind } from './catalog.js'

/**
 * Checklist HTTP surface — mounted at /api/checklists.
 *
 * Paths carry the kind: /api/checklists/gst/... Only 'gst' is accepted today;
 * adding a TDS checklist later is a new value in CHECKLIST_KINDS and a tab,
 * not a new router.
 *
 * Reads need workstation.gst.read, writes workstation.gst.manage — the
 * permissions the client GST tab already uses, so no role gains anything new.
 */
export const checklistRouter = Router()

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, message: string): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) {
    throw ApiError.badRequest(message, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
  }
  return r.data
}

function kindOf(raw: string): ChecklistKind {
  if (!(CHECKLIST_KINDS as readonly string[]).includes(raw)) throw ApiError.notFound('Unknown checklist.')
  return raw as ChecklistKind
}

function requireManage(session: Session) {
  if (!can(session, 'workstation.gst.manage', 'self')) {
    throw ApiError.forbidden('You do not have permission to change this checklist.')
  }
}

/** The catalogue is organisation-wide; the caller's own org is the only one. */
async function callerOrgId(session: Session): Promise<string> {
  if (session.employeeId) {
    const e = await prisma.employee.findFirst({ where: { id: session.employeeId }, select: { organisationId: true } })
    if (e) return e.organisationId
  }
  const org = await prisma.organisation.findFirst({ select: { id: true } })
  if (!org) throw ApiError.badRequest('No organisation is configured.')
  return org.id
}

// ── Master catalogue ──────────────────────────────────────────────────────

checklistRouter.get('/:kind/catalog', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.gst.read')
  ok(res, await Checklists.catalog(await callerOrgId(session), kindOf(req.params.kind)))
}))

checklistRouter.post('/:kind/categories', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.gst.manage')
  requireManage(session)
  const body = parse(z.object({
    name: z.string().trim().min(1, 'Name the category.').max(100),
    description: z.string().trim().max(500).nullish(),
  }), req.body, 'Invalid category.')
  ok(res, await Checklists.addCategory(session, await callerOrgId(session), kindOf(req.params.kind), {
    name: body.name, description: body.description ?? null,
  }), 201)
}))

/** Cross-client roll-up for the Services → GST screen. */
checklistRouter.get('/:kind/overview', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.gst.read')
  ok(res, await Checklists.overview(session, scope, kindOf(req.params.kind)))
}))

// ── One client's checklist ────────────────────────────────────────────────

checklistRouter.get('/:kind/clients/:clientId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.gst.read')
  ok(res, await Checklists.list(session, scope, req.params.clientId, kindOf(req.params.kind)))
}))

checklistRouter.get('/:kind/clients/:clientId/items/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.gst.read')
  ok(res, await Checklists.get(session, scope, req.params.clientId, kindOf(req.params.kind), req.params.id))
}))

checklistRouter.post('/:kind/clients/:clientId/initialize', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.gst.manage')
  requireManage(session)
  const body = parse(z.object({
    service_ids: z.array(z.string()).min(1, 'Pick at least one service.').max(100),
  }), req.body, 'Invalid selection.')
  ok(res, await Checklists.initialize(session, scope, req.params.clientId, kindOf(req.params.kind), body.service_ids), 201)
}))

checklistRouter.post('/:kind/clients/:clientId/items', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.gst.manage')
  requireManage(session)
  const body = parse(z.object({
    service_id: z.string().nullish(),
    name: z.string().trim().min(1).max(150).nullish(),
    category_id: z.string().nullish(),
    description: z.string().trim().max(1000).nullish(),
    frequency: z.enum(FREQUENCIES).default('one-time'),
    due_date: ISO_DATE.nullish(),
    assigned_to_id: z.string().nullish(),
    notes: z.string().trim().max(2000).nullish(),
    /** §6 — promote a custom item into the master catalogue as well. */
    add_to_master: z.coerce.boolean().default(false),
  }), req.body, 'Invalid checklist item.')

  ok(res, await Checklists.addItem(session, scope, req.params.clientId, kindOf(req.params.kind), {
    serviceId: body.service_id ?? null,
    name: body.name ?? null,
    categoryId: body.category_id ?? null,
    description: body.description ?? null,
    frequency: body.frequency,
    dueDate: body.due_date ?? null,
    assignedToId: body.assigned_to_id ?? null,
    notes: body.notes ?? null,
    addToMaster: body.add_to_master,
  }), 201)
}))

checklistRouter.patch('/:kind/clients/:clientId/items/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.gst.manage')
  requireManage(session)
  const body = parse(z.object({
    status: z.enum(CHECKLIST_STATUSES).optional(),
    assigned_to_id: z.string().nullish(),
    due_date: ISO_DATE.nullish(),
    frequency: z.enum(FREQUENCIES).optional(),
    notes: z.string().trim().max(2000).nullish(),
    description: z.string().trim().max(1000).nullish(),
    category_id: z.string().nullish(),
    name: z.string().trim().min(1).max(150).nullish(),
  }), req.body, 'Invalid change.')

  const patch: Parameters<typeof Checklists.update>[5] = {}
  if (body.status !== undefined) patch.status = body.status
  if ('assigned_to_id' in req.body) patch.assignedToId = body.assigned_to_id ?? null
  if ('due_date' in req.body) patch.dueDate = body.due_date ?? null
  if (body.frequency !== undefined) patch.frequency = body.frequency
  if ('notes' in req.body) patch.notes = body.notes ?? null
  if ('description' in req.body) patch.description = body.description ?? null
  if ('category_id' in req.body) patch.categoryId = body.category_id ?? null
  if ('name' in req.body) patch.name = body.name ?? null

  ok(res, await Checklists.update(session, scope, req.params.clientId, kindOf(req.params.kind), req.params.id, patch))
}))

checklistRouter.delete('/:kind/clients/:clientId/items/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.gst.manage')
  requireManage(session)
  await Checklists.remove(session, scope, req.params.clientId, kindOf(req.params.kind), req.params.id)
  noContent(res)
}))
