import type { PrismaClient } from '@prisma/client'
import {
  CHECKLIST_LABEL_TO_STAGE_SLUG, WORKFLOW_STAGES, mergeChecklistStatuses,
} from '../src/modules/bookkeeping/validate.js'

/**
 * BOOKKEEPING WORKFLOW-STAGE SEED + MIGRATION.
 *
 * This is the mechanism that unifies the old three-way split (checklist item,
 * task, workflow step) into a single record per (period, stage). It runs on
 * every `npm run db:seed` and every Docker `migrate` boot; every step is
 * idempotent, so re-running mid-cutover never duplicates rows and never
 * clobbers a live status.
 *
 * Order of events:
 *   1. Upsert the nine BookkeepingWorkflowStage config rows.
 *   2. For every existing BookkeepingPeriod, upsert one BookkeepingTask per
 *      stage keyed on (periodId, stageId).
 *   3. Merge status from any matching BookkeepingChecklistItem onto that
 *      task, taking the least-advanced status when several checklist rows
 *      map to the same stage (see `mergeChecklistStatuses`).
 *
 * A migration report is printed to stdout so the PR can quote it verbatim.
 */
export interface StageMigrationReport {
  stagesSeeded: number
  tasksCreated: number
  tasksMerged: number
  orphanChecklistRows: number
  periodsTouched: number
}

export async function seedWorkflowStages(prisma: PrismaClient): Promise<number> {
  for (const s of WORKFLOW_STAGES) {
    await prisma.bookkeepingWorkflowStage.upsert({
      where: { slug: s.slug },
      update: {
        sequence: s.sequence,
        name: s.name,
        defaultCategory: s.defaultCategory,
        defaultOffsetDays: s.defaultOffsetDays,
        gateRuleSlug: s.gateRuleSlug,
        isActive: true,
      },
      create: {
        sequence: s.sequence,
        name: s.name,
        slug: s.slug,
        defaultCategory: s.defaultCategory,
        defaultOffsetDays: s.defaultOffsetDays,
        gateRuleSlug: s.gateRuleSlug,
        isActive: true,
      },
    })
  }
  return WORKFLOW_STAGES.length
}

/**
 * Ensures every active workflow stage has a task on this period. Callers use
 * this from route handlers (opening a new period) AND from the migration
 * (backfilling old periods). Never overwrites the status of an existing task.
 */
export async function ensureStageTasksForPeriod(
  prisma: PrismaClient,
  input: {
    periodId: string
    clientId: string
    assignedEmployeeId: string
  },
): Promise<{ created: number }> {
  const stages = await prisma.bookkeepingWorkflowStage.findMany({
    where: { isActive: true }, orderBy: { sequence: 'asc' },
  })
  let created = 0
  for (const stage of stages) {
    const existing = await prisma.bookkeepingTask.findFirst({
      where: { periodId: input.periodId, stageId: stage.id, deletedAt: null },
    })
    if (existing) continue
    await prisma.bookkeepingTask.create({
      data: {
        periodId: input.periodId,
        clientId: input.clientId,
        stageId: stage.id,
        title: stage.name,
        category: stage.defaultCategory,
        priority: 'medium',
        status: 'pending',
        assignedEmployeeId: input.assignedEmployeeId,
      },
    })
    created++
  }
  return { created }
}

/**
 * Backfills stage tasks for every period that has none, and merges legacy
 * BookkeepingChecklistItem state onto the corresponding stage tasks. Idempotent.
 */
export async function migrateChecklistToTasks(prisma: PrismaClient): Promise<StageMigrationReport> {
  const stagesSeeded = await seedWorkflowStages(prisma)

  const stages = await prisma.bookkeepingWorkflowStage.findMany({
    where: { isActive: true }, orderBy: { sequence: 'asc' },
  })
  const stageBySlug = new Map(stages.map((s) => [s.slug, s]))

  const periods = await prisma.bookkeepingPeriod.findMany({
    where: { deletedAt: null },
    include: {
      engagement: { select: { clientId: true, assignedEmployeeId: true } },
      checklistItems: true,
      tasks: { where: { deletedAt: null }, select: { id: true, stageId: true, status: true } },
    },
  })

  let tasksCreated = 0
  let tasksMerged = 0
  let orphanChecklistRows = 0
  let periodsTouched = 0

  for (const period of periods) {
    const owner = period.assignedEmployeeId ?? period.engagement.assignedEmployeeId
    const clientId = period.engagement.clientId
    let touched = false

    // Group legacy checklist rows by target stage slug so several sub-items
    // fold into one stage task by the least-advanced status rule.
    const bySlug = new Map<string, string[]>()
    for (const item of period.checklistItems) {
      const slug = CHECKLIST_LABEL_TO_STAGE_SLUG[item.label]
      if (!slug) {
        orphanChecklistRows++
        continue
      }
      const bucket = bySlug.get(slug) ?? []
      bucket.push(item.status)
      bySlug.set(slug, bucket)
    }

    for (const stage of stages) {
      const existing = period.tasks.find((t) => t.stageId === stage.id)
      const legacyStatuses = bySlug.get(stage.slug) ?? []
      const merged = legacyStatuses.length > 0 ? mergeChecklistStatuses(legacyStatuses) : null

      if (!existing) {
        await prisma.bookkeepingTask.create({
          data: {
            periodId: period.id,
            clientId,
            stageId: stage.id,
            title: stage.name,
            category: stage.defaultCategory,
            priority: 'medium',
            status: merged ?? 'pending',
            assignedEmployeeId: owner,
            completedAt: merged === 'completed' ? new Date() : null,
          },
        })
        tasksCreated++
        if (merged) tasksMerged++
        touched = true
        continue
      }

      // Task already there: only merge when the checklist has strictly more
      // progress recorded than the task does, so we never regress live state.
      if (merged && rank(merged) > rank(existing.status)) {
        await prisma.bookkeepingTask.update({
          where: { id: existing.id },
          data: {
            status: merged,
            completedAt: merged === 'completed' ? new Date() : null,
          },
        })
        tasksMerged++
        touched = true
      }
    }
    if (touched) periodsTouched++
  }

  const report: StageMigrationReport = {
    stagesSeeded, tasksCreated, tasksMerged, orphanChecklistRows, periodsTouched,
  }
  console.log('[bookkeeping] stage migration:', report)
  return report
}

/**
 * Rank a task status by "progress made" so `merge` above never demotes a task
 * from in_progress to pending, even if a legacy checklist row said pending.
 */
function rank(status: string): number {
  switch (status) {
    case 'completed': return 4
    case 'in_progress': return 3
    case 'blocked': return 2
    case 'pending': return 1
    default: return 0
  }
}
