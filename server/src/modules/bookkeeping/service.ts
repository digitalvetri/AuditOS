import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import {
  type BookkeepingFrequency, computeDueDate, periodEndOf, periodStartOf,
} from './dates.js'

export const today = () => new Date().toISOString().slice(0, 10)

/**
 * SERVICE PROGRESS (§18). Computed here, on the server, from task rows —
 * never sent up from the browser and never cached in a column, so it cannot
 * drift away from the tasks it describes.
 */
export interface Progress {
  total: number
  completed: number
  pending: number
  overdue: number
  percent: number
}

export function progressFrom(
  tasks: { status: string; dueDate: string | null }[],
  asOf = today(),
): Progress {
  const total = tasks.length
  const completed = tasks.filter((t) => t.status === 'completed').length
  const open = tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled')
  const overdue = open.filter((t) => t.dueDate && t.dueDate < asOf).length
  return {
    total,
    completed,
    pending: open.length,
    overdue,
    // A period with no tasks is 0% done, not NaN%.
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
  }
}

/** Progress for many periods in one query rather than N. */
export async function progressByPeriod(periodIds: string[]): Promise<Map<string, Progress>> {
  const out = new Map<string, Progress>()
  if (periodIds.length === 0) return out
  const tasks = await prisma.bookkeepingTask.findMany({
    where: { ...alive, periodId: { in: periodIds } },
    select: { periodId: true, status: true, dueDate: true },
  })
  const grouped = new Map<string, { status: string; dueDate: string | null }[]>()
  for (const id of periodIds) grouped.set(id, [])
  for (const t of tasks) if (t.periodId) grouped.get(t.periodId)?.push(t)
  for (const [id, rows] of grouped) out.set(id, progressFrom(rows))
  return out
}

/**
 * Creating a period also lays down one BookkeepingTask per active workflow
 * stage in the same transaction — a period without its tasks is not a state
 * we want to be reachable, least of all halfway through a failed request.
 * The old separate checklist has been folded into these tasks; the
 * "checklist" the UI renders is now a grouping of these rows by stage.
 */
export async function createPeriodWithTasks(
  db: PrismaClient | Prisma.TransactionClient,
  input: {
    engagementId: string
    clientId: string
    year: number
    month: number
    /**
     * Optional caller-supplied due date. When omitted (the normal case), the
     * period's due date is derived from `periodEnd + engagement.dueOffsetDays`
     * per Bookkeeping module spec §5.
     */
    dueDate?: string | null
    assignedEmployeeId?: string | null
    notes?: string | null
    createdBy?: string | null
  },
) {
  const existing = await db.bookkeepingPeriod.findFirst({
    where: { engagementId: input.engagementId, year: input.year, month: input.month },
  })
  if (existing) {
    throw ApiError.conflict('period_exists', 'That month is already open for this client.')
  }
  const owner = input.assignedEmployeeId ?? null
  // Stage tasks all inherit an owner and the schema's assignedEmployeeId is
  // NOT NULL. Falling through with a placeholder would be worse than failing
  // the request; the route already falls back to the engagement's owner, so
  // reaching here with null means neither was set.
  if (!owner) {
    throw ApiError.badRequest(
      'assigned_employee_id is required to open a period — set one on the engagement or pass it explicitly.',
    )
  }
  // Engagement holds the frequency and the per-client due offset — every
  // date this function writes flows from those two knobs.
  const engagement = await db.bookkeepingEngagement.findFirst({
    where: { id: input.engagementId },
    select: { billingFrequency: true, dueOffsetDays: true },
  })
  if (!engagement) throw ApiError.notFound('Engagement not found.')
  const frequency = engagement.billingFrequency as BookkeepingFrequency
  const periodStart = periodStartOf(input.year, input.month, frequency)
  const periodEnd = periodEndOf(input.year, input.month, frequency)
  const dueDate = input.dueDate ?? computeDueDate(periodEnd, engagement.dueOffsetDays)

  const stages = await db.bookkeepingWorkflowStage.findMany({
    where: { isActive: true }, orderBy: { sequence: 'asc' },
  })
  return db.bookkeepingPeriod.create({
    data: {
      engagementId: input.engagementId,
      year: input.year,
      month: input.month,
      periodStart,
      periodEnd,
      dueDate,
      assignedEmployeeId: owner,
      notes: input.notes ?? null,
      createdBy: input.createdBy ?? null,
      tasks: {
        create: stages.map((s) => ({
          clientId: input.clientId,
          stageId: s.id,
          title: s.name,
          category: s.defaultCategory,
          priority: 'medium',
          status: 'pending',
          assignedEmployeeId: owner,
          // Per-stage offset staggers tasks across the window — collection
          // early (offset 0), review late (offset 5). Same weekend rule.
          dueDate: computeDueDate(periodEnd, s.defaultOffsetDays),
        })),
      },
    },
    include: {
      tasks: { include: { stage: true }, orderBy: { stage: { sequence: 'asc' } } },
    },
  })
}

/**
 * Recompute a single period's dueDate and every stage task's dueDate from
 * the current engagement config. Ad-hoc tasks (stageId=null) keep whatever
 * date the user picked. Idempotent; returns how many rows moved.
 */
export async function recomputePeriodDates(
  db: PrismaClient | Prisma.TransactionClient,
  periodId: string,
): Promise<{ periodMoved: boolean; taskMoved: number }> {
  const period = await db.bookkeepingPeriod.findFirst({
    where: { id: periodId },
    include: {
      engagement: { select: { billingFrequency: true, dueOffsetDays: true } },
      tasks: {
        where: { deletedAt: null, stageId: { not: null } },
        include: { stage: true },
      },
    },
  })
  if (!period) return { periodMoved: false, taskMoved: 0 }
  const frequency = period.engagement.billingFrequency as BookkeepingFrequency
  const periodStart = period.periodStart ?? periodStartOf(period.year, period.month, frequency)
  const periodEnd = period.periodEnd ?? periodEndOf(period.year, period.month, frequency)
  const nextDue = computeDueDate(periodEnd, period.engagement.dueOffsetDays)

  const periodMoved =
    period.periodStart !== periodStart ||
    period.periodEnd !== periodEnd ||
    period.dueDate !== nextDue
  if (periodMoved) {
    await db.bookkeepingPeriod.update({
      where: { id: period.id },
      data: { periodStart, periodEnd, dueDate: nextDue },
    })
  }

  let taskMoved = 0
  for (const t of period.tasks) {
    if (!t.stage) continue
    const desired = computeDueDate(periodEnd, t.stage.defaultOffsetDays)
    if (t.dueDate !== desired) {
      await db.bookkeepingTask.update({ where: { id: t.id }, data: { dueDate: desired } })
      taskMoved++
    }
  }
  return { periodMoved, taskMoved }
}

/**
 * Recompute all open (non-completed) periods for one engagement. Called when
 * the engagement's frequency or dueOffsetDays changes.
 */
export async function recomputeOpenPeriodsForEngagement(
  db: PrismaClient | Prisma.TransactionClient,
  engagementId: string,
): Promise<{ periods: number; periodsMoved: number; tasksMoved: number }> {
  const periods = await db.bookkeepingPeriod.findMany({
    where: { engagementId, deletedAt: null, status: { not: 'completed' } },
    select: { id: true },
  })
  let periodsMoved = 0
  let tasksMoved = 0
  for (const p of periods) {
    const r = await recomputePeriodDates(db, p.id)
    if (r.periodMoved) periodsMoved++
    tasksMoved += r.taskMoved
  }
  return { periods: periods.length, periodsMoved, tasksMoved }
}

/** Append-only per-period trail (§32 keeps AuditLog as the compliance record). */
export async function writeBkActivity(input: {
  clientId: string
  periodId?: string | null
  actorUserId: string | null
  action: string
  detail?: string | null
}): Promise<void> {
  try {
    await prisma.bookkeepingActivity.create({
      data: {
        clientId: input.clientId,
        periodId: input.periodId ?? null,
        actorUserId: input.actorUserId,
        action: input.action,
        detail: input.detail ?? null,
      },
    })
  } catch (err) {
    // Never let the trail take down the operation it was describing.
    console.error('[bookkeeping] activity write failed', err instanceof Error ? err.message : err)
  }
}

/**
 * OVERVIEW KPIs (§7/§36). Every number is a database aggregate over the
 * caller's visible clients — there is no hard-coded figure anywhere here.
 */
export async function overviewKpis(clientWhere: { clientId?: { in: string[] } }) {
  const now = new Date()
  const t = today()
  const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
  const monthEnd = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-31`

  const engWhere = clientWhere.clientId ? { clientId: clientWhere.clientId } : {}
  const perWhere = clientWhere.clientId ? { engagement: { clientId: clientWhere.clientId } } : {}

  const [
    totalClients, inProgress, pendingItems, dueThisMonth, completedThisMonth,
    overdueTasks, awaitingDocuments, awaitingBankStatements, pendingReview,
  ] = await Promise.all([
    prisma.bookkeepingEngagement.count({ where: { ...alive, ...engWhere } }),
    prisma.bookkeepingPeriod.count({ where: { ...alive, ...perWhere, status: { in: ['in_progress', 'awaiting_documents'] } } }),
    prisma.bookkeepingPendingItem.count({ where: { ...alive, ...clientWhere, status: { notIn: ['resolved', 'received'] } } }),
    prisma.bookkeepingPeriod.count({ where: { ...alive, ...perWhere, dueDate: { gte: monthStart, lte: monthEnd }, status: { not: 'completed' } } }),
    prisma.bookkeepingPeriod.count({ where: { ...alive, ...perWhere, status: 'completed', completedDate: { gte: new Date(monthStart) } } }),
    prisma.bookkeepingTask.count({ where: { ...alive, ...clientWhere, dueDate: { lt: t }, status: { notIn: ['completed', 'cancelled'] } } }),
    prisma.bookkeepingDocumentRequest.count({ where: { ...alive, ...clientWhere, status: 'requested' } }),
    prisma.bookkeepingPendingItem.count({ where: { ...alive, ...clientWhere, category: 'bank_statement', status: { notIn: ['resolved', 'received'] } } }),
    prisma.bookkeepingDeliverable.count({ where: { ...alive, ...clientWhere, status: 'in_review' } }),
  ])

  return {
    total_clients: totalClients,
    in_progress: inProgress,
    pending_items: pendingItems,
    due_this_month: dueThisMonth,
    completed_this_month: completedThisMonth,
    overdue_tasks: overdueTasks,
    awaiting_documents: awaitingDocuments,
    awaiting_bank_statements: awaitingBankStatements,
    pending_review: pendingReview,
  }
}
