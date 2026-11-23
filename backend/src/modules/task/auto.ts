import type { Prisma } from '@prisma/client'
import type { Session } from '../../platform/auth.js'
import { notifyUser, partnerTierRecipients } from '../../platform/notify.js'
import { writeTaskAudit } from './engine.js'

/**
 * AUTOMATIC TASKS — a service added to a client becomes a task at once.
 *
 * The task starts UNASSIGNED: services, leads and clients are added without a
 * person, and work is handed out only from the Task module, where a partner
 * assigns each waiting task. One task per client service (idempotent), so a
 * retried request or a second caller never raises a duplicate.
 *
 * Called inside the transaction that creates the ClientService rows; the
 * Partner tier is told afterwards (notifyTasksToAssign), outside it.
 */
export const AUTO_SOURCE_SERVICE = 'service_added'

type Tx = Prisma.TransactionClient

export async function raiseServiceTask(tx: Tx, clientServiceId: string, session: Session): Promise<string | null> {
  const existing = await tx.task.findFirst({ where: { clientServiceId, deletedAt: null }, select: { id: true } })
  if (existing) return null
  const cs = await tx.clientService.findUnique({
    where: { id: clientServiceId },
    select: { id: true, clientId: true, dueDate: true, notes: true, service: { select: { name: true } }, client: { select: { companyName: true } } },
  })
  if (!cs) return null
  const title = `${cs.service.name} — ${cs.client.companyName}`
  const task = await tx.task.create({
    data: {
      title,
      description: cs.notes?.trim() || null,
      assignedEmployeeId: null,
      assignedById: null,
      priority: 'medium',
      status: 'pending',
      dueDate: cs.dueDate,
      clientId: cs.clientId,
      clientServiceId: cs.id,
      source: AUTO_SOURCE_SERVICE,
      createdBy: session.userId,
      updatedBy: session.userId,
    },
  })
  await writeTaskAudit(tx, {
    taskId: task.id, action: 'task_created', session, newStatus: 'pending',
    meta: { title, priority: 'medium', source: AUTO_SOURCE_SERVICE },
  })
  return task.id
}

/** Tell the Partner tier that new tasks are waiting to be assigned. Best effort. */
export async function notifyTasksToAssign(taskIds: string[], clientName: string, actorUserId?: string | null) {
  if (!taskIds.length) return
  try {
    const one = taskIds.length === 1
    for (const r of await partnerTierRecipients()) {
      if (r.userId === actorUserId) continue
      await notifyUser({
        userId: r.userId, type: 'task', module: 'system',
        title: one ? 'New task to assign' : `${taskIds.length} new tasks to assign`,
        body: `${clientName} · assign ${one ? 'it' : 'them'} from Tasks`,
        entityType: 'Task', entityId: taskIds[0],
        actionUrl: one ? `/workstation/tasks/${taskIds[0]}` : '/workstation/tasks?employee_id=unassigned',
      })
    }
  } catch (err) {
    console.error('[tasks] could not notify partners about new tasks', err)
  }
}
