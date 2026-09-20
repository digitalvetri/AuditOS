import type { PrismaClient } from '@prisma/client'
import { CHECKLIST_TEMPLATE } from '../src/modules/bookkeeping/validate.js'
import {
  ensureStageTasksForPeriod, migrateChecklistToTasks, seedWorkflowStages,
} from './seed-bookkeeping-stages.js'

/**
 * BOOKKEEPING SERVICE demo data — engagements over the firm's real clients,
 * three months of periods each, with the tasks, chased documents and
 * deliverables a month actually carries. Idempotent: skips if engagements
 * already exist. It creates no accounting rows; Books owns those.
 *
 * The demo data uses the unified stage-task model. Legacy checklist rows
 * are seeded on completed months only so the migration function has data to
 * exercise; on the live month, tasks alone hold state.
 */
export async function seedBookkeeping(prisma: PrismaClient, organisationId: string) {
  // Workflow stages are a prerequisite for any new period, regardless of
  // whether demo engagements exist yet — the config table must always be
  // in sync with the code.
  await seedWorkflowStages(prisma)

  const existing = await prisma.bookkeepingEngagement.count()
  if (existing > 0) {
    // Existing database: migrate any legacy checklist state onto the stage
    // tasks and backfill missing stage tasks.
    const migration = await migrateChecklistToTasks(prisma)
    return {
      engagements: existing,
      periods: await prisma.bookkeepingPeriod.count(),
      migration,
    }
  }

  const clients = await prisma.client.findMany({ where: { deletedAt: null }, take: 4, orderBy: { clientCode: 'asc' } })
  if (clients.length === 0) return { engagements: 0, periods: 0 }

  const staff = await prisma.employee.findMany({
    where: { organisationId, deletedAt: null, status: 'active' },
    select: { id: true, fullName: true }, take: 4,
  })
  if (staff.length === 0) return { engagements: 0, periods: 0 }
  const pick = (i: number) => staff[i % staff.length].id

  // Three months ending with the current one, so Overview always has a
  // "due this month" row no matter when the seed is run.
  const now = new Date()
  const months: { year: number; month: number }[] = []
  for (let back = 2; back >= 0; back--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
    months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 })
  }
  const dayOf = (y: number, m: number, day: number) =>
    `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  const ENG_STATUS = ['active', 'active', 'active', 'on_hold']
  let periods = 0

  for (const [ci, client] of clients.entries()) {
    const owner = pick(ci)
    const last = months[months.length - 1]

    const engagement = await prisma.bookkeepingEngagement.create({
      data: {
        clientId: client.id,
        status: ENG_STATUS[ci % ENG_STATUS.length],
        serviceStartDate: dayOf(months[0].year, months[0].month, 1),
        assignedEmployeeId: owner,
        billingFrequency: 'monthly',
        nextDueDate: dayOf(last.year, last.month, 5),
        notes: 'Monthly bookkeeping, GST-registered.',
      },
    })

    for (const [mi, m] of months.entries()) {
      const isCurrent = mi === months.length - 1
      const isMiddle = mi === 1
      const status = isCurrent ? 'in_progress' : isMiddle ? 'under_review' : 'completed'

      // Legacy checklist rows only seeded on the two closed months, so the
      // migration function has real data to translate; the live month goes
      // straight to stage-task state.
      const seedLegacyChecklist = !isCurrent

      const period = await prisma.bookkeepingPeriod.create({
        data: {
          engagementId: engagement.id, year: m.year, month: m.month,
          status,
          dueDate: dayOf(m.year, m.month, 5),
          completedDate: status === 'completed' ? new Date(Date.UTC(m.year, m.month - 1, 4)) : null,
          assignedEmployeeId: owner,
          ...(seedLegacyChecklist ? {
            checklistItems: {
              create: CHECKLIST_TEMPLATE.map((label, i) => ({
                label, sortOrder: i,
                status: status === 'completed' ? 'completed' : i < 4 ? 'completed' : i < 6 ? 'in_progress' : 'pending',
                completedAt: status === 'completed' || i < 4 ? new Date(Date.UTC(m.year, m.month - 1, 3)) : null,
                completedByEmployeeId: status === 'completed' || i < 4 ? owner : null,
              })),
            },
          } : {}),
        },
      })
      periods++

      // Seed the stage tasks. On completed months, mark them all done; on the
      // live month, leave them at their default pending. Assign the first
      // three to different owners so the assignee filter has variety.
      const stageTasksCreated = await ensureStageTasksForPeriod(prisma, {
        periodId: period.id, clientId: client.id, assignedEmployeeId: owner,
      })

      if (status === 'completed') {
        await prisma.bookkeepingTask.updateMany({
          where: { periodId: period.id, stageId: { not: null } },
          data: { status: 'completed', completedAt: new Date(Date.UTC(m.year, m.month - 1, 4)) },
        })
      } else if (isCurrent) {
        // Progress the live month partway: first two stages done, next in
        // progress, one deliberately overdue so the KPI is exercised.
        const stageTasks = await prisma.bookkeepingTask.findMany({
          where: { periodId: period.id, stageId: { not: null } },
          include: { stage: true },
          orderBy: { stage: { sequence: 'asc' } },
        })
        for (const [ti, t] of stageTasks.entries()) {
          const isOverdue = ti === 5
          await prisma.bookkeepingTask.update({
            where: { id: t.id },
            data: {
              status: ti < 2 ? 'completed' : ti === 2 ? 'in_progress' : 'pending',
              completedAt: ti < 2 ? new Date(Date.UTC(m.year, m.month - 1, 4)) : null,
              assignedEmployeeId: pick(ci + ti),
              dueDate: isOverdue ? dayOf(m.year, m.month, 2) : dayOf(m.year, m.month, 5 + ti),
            },
          })
        }
      }

      if (!isCurrent && status !== 'completed') continue

      if (isCurrent) {
        await prisma.bookkeepingPendingItem.create({
          data: {
            clientId: client.id, periodId: period.id,
            title: 'Bank statement for the month', category: 'bank_statement',
            priority: 'high', status: 'requested',
            requestedDate: dayOf(m.year, m.month, 1),
            dueDate: dayOf(m.year, m.month, 4),
            assignedEmployeeId: owner,
          },
        })
        await prisma.bookkeepingPendingItem.create({
          data: {
            clientId: client.id, periodId: period.id,
            title: 'Missing purchase bills (3)', category: 'purchase_bills',
            priority: 'medium', status: 'partially_received',
            requestedDate: dayOf(m.year, m.month, 1),
            dueDate: dayOf(m.year, m.month, 6),
            assignedEmployeeId: pick(ci + 1),
          },
        })
        await prisma.bookkeepingDocumentRequest.create({
          data: {
            clientId: client.id, periodId: period.id,
            documentType: 'bank_statement',
            description: 'Signed bank statement PDF for the month.',
            status: 'requested', dueDate: dayOf(m.year, m.month, 4),
          },
        })
      }

      await prisma.bookkeepingDeliverable.create({
        data: {
          clientId: client.id, periodId: period.id,
          type: status === 'completed' ? 'monthly_books' : 'trial_balance',
          status: status === 'completed' ? 'delivered' : 'in_review',
          preparedByEmployeeId: owner,
          reviewedByEmployeeId: status === 'completed' ? pick(ci + 1) : null,
          approvedAt: status === 'completed' ? new Date(Date.UTC(m.year, m.month - 1, 4)) : null,
          deliveredAt: status === 'completed' ? new Date(Date.UTC(m.year, m.month - 1, 5)) : null,
        },
      })

      await prisma.bookkeepingActivity.create({
        data: {
          clientId: client.id, periodId: period.id, actorUserId: null,
          action: 'Period opened',
          detail: `Bookkeeping for ${m.month}/${m.year} opened with ${stageTasksCreated.created} stage tasks.`,
        },
      })
    }
  }

  // For the demo seed we also run the migration so any legacy checklist rows
  // we just inserted are folded into stage tasks — proves the path end-to-end.
  const migration = await migrateChecklistToTasks(prisma)

  return { engagements: clients.length, periods, migration }
}
