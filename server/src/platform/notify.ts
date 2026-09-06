import { prisma } from '../lib/prisma.js'

/**
 * Notification primitive (§8.9). Owned by the platform, emitted into by every
 * module. The realtime transport subscribes through `setNotificationEmitter`;
 * no domain code imports socket.io.
 */
export type NotificationModule =
  | 'attendance' | 'leave' | 'payroll' | 'expense' | 'message' | 'document' | 'system'

type Emitter = (userId: string, payload: unknown) => void
let emit: Emitter = () => {}
export function setNotificationEmitter(fn: Emitter) { emit = fn }

export interface NotifyInput {
  userId: string
  type: string
  module: NotificationModule
  title: string
  body: string
  entityType?: string | null
  entityId?: string | null
  actionUrl?: string | null
}

export async function notifyUser(input: NotifyInput) {
  const row = await prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      module: input.module,
      title: input.title,
      body: input.body,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      actionUrl: input.actionUrl ?? null,
    },
  })
  emit(input.userId, row)
  return row
}

/** Resolve an employee to their login and notify them. No login → no-op. */
export async function notifyEmployee(employeeId: string, input: Omit<NotifyInput, 'userId'>) {
  const user = await prisma.user.findFirst({
    where: { employeeId, isActive: true, deletedAt: null },
    select: { id: true },
  })
  if (!user) return null
  return notifyUser({ ...input, userId: user.id })
}

/** Notify every active holder of a role code (e.g. escalate leave to HR). */
export async function notifyRole(roleCode: string, input: Omit<NotifyInput, 'userId'>) {
  const users = await prisma.user.findMany({
    where: { role: { code: roleCode }, isActive: true, deletedAt: null },
    select: { id: true },
  })
  for (const u of users) await notifyUser({ ...input, userId: u.id })
}
