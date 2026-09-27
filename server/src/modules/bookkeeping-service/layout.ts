/**
 * Checklist LAYOUT for Bookkeeping → Monthly Work.
 *
 * The monthly checklist is the firm's list of workflow stages: opening a
 * period creates one task per active stage (service.ts), and those tasks are
 * the checkboxes. This router edits that list.
 *
 *   GET    /api/bookkeeping-service/layout                     the steps, in order
 *   POST   /api/bookkeeping-service/layout/stages              add a step
 *   PATCH  /api/bookkeeping-service/layout/stages/:id          rename / category / due offset
 *   POST   /api/bookkeeping-service/layout/stages/:id/move     { direction: 'up' | 'down' }
 *   DELETE /api/bookkeeping-service/layout/stages/:id          remove a step
 *
 * Removing a step RETIRES it (isActive = false) rather than deleting the row:
 * every month that already used it keeps its task and its history, and a
 * completed task is never touched. Optionally its untouched (pending) tasks
 * are removed from months still open. Adding a step can likewise be applied
 * to the months still open, so the change shows up where people are working.
 *
 * "Open" = any period whose status is not `completed`, in the caller's own
 * firm. The step list itself is shared (BookkeepingWorkflowStage has no
 * organisation column), as it was before this editor existed.
 */
import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'
import { computeDueDate } from './dates.js'
import { workflowStageToApi } from './serialize.js'
import { TASK_CATEGORIES } from './validate.js'

export const bookkeepingLayoutRouter = Router()

const READ = ['workstation.service.read', 'workstation.service.manage'] as const
const MANAGE = ['workstation.service.manage'] as const

/**
 * The layout is firm-wide — one change reaches every client's checklist — so
 * editing it needs service.manage at ORGANISATION scope (managers, MD). An
 * employee's `self` grant lets them progress their own clients' work, not
 * reshape everyone's.
 */
function requireLayoutManage(session: Parameters<typeof requireWorkstation>[0]): void {
  if (requireWorkstation(session, ...MANAGE) !== 'organisation') {
    throw ApiError.forbidden('Changing the checklist layout needs firm-wide Services manage access.')
  }
}
/** Months still being worked on — in the caller's own firm only. */
const openIn = (organisationId: string) => ({
  status: { not: 'completed' }, deletedAt: null, engagement: { client: { organisationId } },
})
async function firmOf(userId: string): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { organisationId: true } })
  return u.organisationId
}

async function activeStages() {
  return prisma.bookkeepingWorkflowStage.findMany({ where: { isActive: true }, orderBy: { sequence: 'asc' } })
}

bookkeepingLayoutRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, ...READ)
  const stages = await activeStages()
  const openPeriods = await prisma.bookkeepingPeriod.count({ where: openIn(await firmOf(session.userId)) })
  ok(res, { stages: stages.map(workflowStageToApi), task_categories: TASK_CATEGORIES, open_periods: openPeriods })
}))

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'step'

const AddBody = z.object({
  name: z.string().trim().min(1, 'Enter a name for the step.').max(120),
  default_category: z.enum(TASK_CATEGORIES as unknown as [string, ...string[]]).default('other'),
  default_offset_days: z.coerce.number().int().min(-60).max(120).default(0),
  apply_to_open: z.boolean().default(true),
})

bookkeepingLayoutRouter.post('/stages', handler(async (req, res) => {
  const session = requireSession(req)
  requireLayoutManage(session)
  const parsed = AddBody.safeParse(req.body)
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid request.')
  const b = parsed.data

  const dup = await prisma.bookkeepingWorkflowStage.findFirst({ where: { isActive: true, name: { equals: b.name, mode: 'insensitive' } } })
  if (dup) throw ApiError.conflict('duplicate_step', `The checklist already has a step called "${dup.name}".`)

  const org = await firmOf(session.userId)
  const result = await prisma.$transaction(async (tx) => {
    // Sequence and slug are unique across ALL stages, retired ones included.
    const last = await tx.bookkeepingWorkflowStage.aggregate({ _max: { sequence: true } })
    let slug = `custom_${slugify(b.name)}`
    for (let i = 2; await tx.bookkeepingWorkflowStage.findUnique({ where: { slug } }); i++) slug = `custom_${slugify(b.name)}_${i}`
    const stage = await tx.bookkeepingWorkflowStage.create({
      data: { sequence: (last._max.sequence ?? 0) + 1, name: b.name, slug, defaultCategory: b.default_category, defaultOffsetDays: b.default_offset_days, isActive: true },
    })

    let added = 0
    if (b.apply_to_open) {
      const periods = await tx.bookkeepingPeriod.findMany({ where: openIn(org), include: { engagement: { select: { clientId: true, assignedEmployeeId: true } } } })
      for (const p of periods) {
        await tx.bookkeepingTask.create({
          data: {
            periodId: p.id, clientId: p.engagement.clientId, stageId: stage.id, title: stage.name,
            category: stage.defaultCategory, priority: 'medium', status: 'pending',
            // The month's owner, else the engagement's — as when a month is opened.
            assignedEmployeeId: p.assignedEmployeeId ?? p.engagement.assignedEmployeeId,
            // Same rule as a newly opened month (service.ts); a legacy month
            // without a period end falls back to its own due date, then today.
            dueDate: p.periodEnd ? computeDueDate(p.periodEnd, stage.defaultOffsetDays) : (p.dueDate ?? new Date().toISOString().slice(0, 10)),
          },
        })
        added++
      }
    }
    return { stage, added }
  })
  await writeAudit({ actorUserId: session.userId, action: 'bookkeeping.checklist.step_added', entityType: 'bookkeeping.workflow_stage', entityId: result.stage.id, after: { name: result.stage.name, added_to_open_months: result.added }, req })
  ok(res, { stage: workflowStageToApi(result.stage), added_to_open_months: result.added }, 201)
}))

const EditBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  default_category: z.enum(TASK_CATEGORIES as unknown as [string, ...string[]]).optional(),
  default_offset_days: z.coerce.number().int().min(-60).max(120).optional(),
})

bookkeepingLayoutRouter.patch('/stages/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireLayoutManage(session)
  const parsed = EditBody.safeParse(req.body)
  if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid request.')
  const stage = await prisma.bookkeepingWorkflowStage.findFirst({ where: { id: req.params.id, isActive: true } })
  if (!stage) throw ApiError.notFound('No such checklist step.')
  const b = parsed.data
  if (b.name && b.name.toLowerCase() !== stage.name.toLowerCase()) {
    const dup = await prisma.bookkeepingWorkflowStage.findFirst({ where: { isActive: true, id: { not: stage.id }, name: { equals: b.name, mode: 'insensitive' } } })
    if (dup) throw ApiError.conflict('duplicate_step', `The checklist already has a step called "${dup.name}".`)
  }
  const org = await firmOf(session.userId)
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.bookkeepingWorkflowStage.update({
      where: { id: stage.id },
      data: { name: b.name, defaultCategory: b.default_category, defaultOffsetDays: b.default_offset_days },
    })
    // A rename carries to the step's not-yet-started tasks in open months,
    // so the checklist reads the same everywhere. Started work keeps its title.
    if (b.name && b.name !== stage.name) {
      await tx.bookkeepingTask.updateMany({
        where: { stageId: stage.id, status: 'pending', deletedAt: null, period: openIn(org) },
        data: { title: b.name },
      })
    }
    return u
  })
  await writeAudit({ actorUserId: session.userId, action: 'bookkeeping.checklist.step_updated', entityType: 'bookkeeping.workflow_stage', entityId: stage.id, before: { name: stage.name }, after: { name: updated.name }, req })
  ok(res, workflowStageToApi(updated))
}))

bookkeepingLayoutRouter.post('/stages/:id/move', handler(async (req, res) => {
  const session = requireSession(req)
  requireLayoutManage(session)
  const dir = (req.body ?? {}).direction
  if (dir !== 'up' && dir !== 'down') throw ApiError.badRequest('direction must be "up" or "down".')
  const stages = await activeStages()
  const i = stages.findIndex((s) => s.id === req.params.id)
  if (i === -1) throw ApiError.notFound('No such checklist step.')
  const j = dir === 'up' ? i - 1 : i + 1
  if (j < 0 || j >= stages.length) return ok(res, { stages: stages.map(workflowStageToApi) })
  const [a, b] = [stages[i], stages[j]]
  // `sequence` is UNIQUE, so the swap goes through a free temporary value.
  const last = await prisma.bookkeepingWorkflowStage.aggregate({ _max: { sequence: true } })
  const tmp = (last._max.sequence ?? 0) + 1
  await prisma.$transaction([
    prisma.bookkeepingWorkflowStage.update({ where: { id: a.id }, data: { sequence: tmp } }),
    prisma.bookkeepingWorkflowStage.update({ where: { id: b.id }, data: { sequence: a.sequence } }),
    prisma.bookkeepingWorkflowStage.update({ where: { id: a.id }, data: { sequence: b.sequence } }),
  ])
  ok(res, { stages: (await activeStages()).map(workflowStageToApi) })
}))

bookkeepingLayoutRouter.delete('/stages/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireLayoutManage(session)
  const stage = await prisma.bookkeepingWorkflowStage.findFirst({ where: { id: req.params.id, isActive: true } })
  if (!stage) throw ApiError.notFound('No such checklist step.')
  const remaining = await prisma.bookkeepingWorkflowStage.count({ where: { isActive: true } })
  if (remaining <= 1) throw ApiError.conflict('last_step', 'The checklist needs at least one step.')
  const removeFromOpen = req.query.remove_from_open !== 'false'

  const org = await firmOf(session.userId)
  const removed = await prisma.$transaction(async (tx) => {
    await tx.bookkeepingWorkflowStage.update({ where: { id: stage.id }, data: { isActive: false } })
    if (!removeFromOpen) return 0
    // Only untouched work is removed: pending tasks in months still open.
    // Anything started or completed stays, with its history.
    const r = await tx.bookkeepingTask.updateMany({
      where: { stageId: stage.id, status: 'pending', deletedAt: null, period: openIn(org) },
      data: { deletedAt: new Date() },
    })
    return r.count
  })
  await writeAudit({ actorUserId: session.userId, action: 'bookkeeping.checklist.step_removed', entityType: 'bookkeeping.workflow_stage', entityId: stage.id, before: { name: stage.name }, after: { removed_pending_tasks: removed }, req })
  ok(res, { removed: true, removed_pending_tasks: removed })
}))
