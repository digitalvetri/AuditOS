import type { PrismaClient } from '@prisma/client'
import { CHECKLIST_TEMPLATE } from '../src/modules/bookkeeping/validate.js'

/**
 * BOOKKEEPING SERVICE demo data — engagements over the firm's real clients,
 * three months of periods each, with the tasks, chased documents and
 * deliverables a month actually carries. Idempotent: skips if engagements
 * already exist. It creates no accounting rows; Books owns those.
 */
export async function seedBookkeeping(prisma: PrismaClient, organisationId: string) {
  const existing = await prisma.bookkeepingEngagement.count()
  if (existing > 0) return { engagements: existing, periods: await prisma.bookkeepingPeriod.count() }

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

      const period = await prisma.bookkeepingPeriod.create({
        data: {
          engagementId: engagement.id, year: m.year, month: m.month,
          status,
          dueDate: dayOf(m.year, m.month, 5),
          completedDate: status === 'completed' ? new Date(Date.UTC(m.year, m.month - 1, 4)) : null,
          assignedEmployeeId: owner,
          checklistItems: {
            create: CHECKLIST_TEMPLATE.map((label, i) => ({
              label, sortOrder: i,
              // A finished month has a finished checklist; the live month is
              // partway through it.
              status: status === 'completed' ? 'completed' : i < 4 ? 'completed' : i < 6 ? 'in_progress' : 'pending',
              completedAt: status === 'completed' || i < 4 ? new Date(Date.UTC(m.year, m.month - 1, 3)) : null,
              completedByEmployeeId: status === 'completed' || i < 4 ? owner : null,
            })),
          },
        },
      })
      periods++

      const taskSpec = [
        ['Collect bank statements', 'data_collection', 'high'],
        ['Enter sales invoices', 'sales', 'medium'],
        ['Enter purchase bills', 'purchases', 'medium'],
        ['Record expenses', 'expenses', 'low'],
        ['Reconcile bank account', 'reconciliation', 'high'],
        ['Review trial balance', 'review', 'critical'],
      ] as const

      for (const [ti, [title, category, priority]] of taskSpec.entries()) {
        const done = status === 'completed' || ti < 3
        await prisma.bookkeepingTask.create({
          data: {
            clientId: client.id, periodId: period.id, title,
            description: `${title} for ${client.companyName}.`,
            category, priority,
            status: done ? 'completed' : ti === 3 ? 'in_progress' : 'pending',
            assignedEmployeeId: pick(ci + ti),
            // One deliberately overdue task on the live month so the overdue
            // KPI is exercised rather than always reading zero.
            dueDate: isCurrent && ti === 5 ? dayOf(m.year, m.month, 2) : dayOf(m.year, m.month, 5 + ti),
            completedAt: done ? new Date(Date.UTC(m.year, m.month - 1, 4)) : null,
          },
        })
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
          detail: `Bookkeeping for ${m.month}/${m.year} opened with ${CHECKLIST_TEMPLATE.length} checklist items.`,
        },
      })
    }
  }

  return { engagements: clients.length, periods }
}
