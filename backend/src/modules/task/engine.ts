import type { Prisma } from '@prisma/client'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import type { Session } from '../../platform/auth.js'

/**
 * THE TASK TIME ENGINE — the only place a task's status or its tracked time
 * changes.
 *
 * Three rules hold this module together:
 *
 *  1. TIME COMES FROM THE SERVER. Every timestamp written here is the
 *     database/process clock. No request body can carry a start time, an end
 *     time or a duration, so there is no shape of API call that lets an
 *     employee type in how long something took.
 *
 *  2. DURATION IS DERIVED, NEVER STORED BY HAND. actualMinutes is recomputed
 *     from the sum of closed TaskTimeSession rows every time anything moves,
 *     and totalPauseMinutes is elapsed-minus-actual. Pause is the ABSENCE of
 *     an open work session, so it cannot be double-counted.
 *
 *  3. EVERY TRANSITION IS ATOMIC. Close the session, recompute, update the
 *     task and write the audit row inside one transaction — or write nothing.
 *     A double-clicked Start is stopped by the service check and, if it races
 *     past it, by the partial unique index in prisma/sql/task-invariants.sql.
 */

type Tx = Prisma.TransactionClient

/** The statuses this module writes. */
export const TASK_STATUSES = ['pending', 'in_progress', 'paused', 'completed', 'cancelled'] as const
export type TaskStatus = typeof TASK_STATUSES[number]

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const
export type TaskPriority = typeof TASK_PRIORITIES[number]

/**
 * Rows written before this module carry the older vocabulary. Reads
 * normalise; writes only ever emit the new values, so the legacy set shrinks
 * on its own as old tasks are touched.
 */
const LEGACY: Record<string, TaskStatus> = {
  open: 'pending',
  blocked: 'paused',
  done: 'completed',
}

export function normaliseStatus(raw: string): TaskStatus {
  if ((TASK_STATUSES as readonly string[]).includes(raw)) return raw as TaskStatus
  return LEGACY[raw] ?? 'pending'
}

/** Which transitions the engine allows, before permissions are considered. */
const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  pending: ['in_progress', 'cancelled'],
  in_progress: ['paused', 'completed', 'cancelled'],
  paused: ['in_progress', 'completed', 'cancelled'],
  completed: ['pending'],   // reopen — manager only, see reopenTask
  cancelled: ['pending'],   // reopen — manager only
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!ALLOWED[from].includes(to)) {
    throw ApiError.unprocessable(
      'invalid_transition',
      `A ${from.replace('_', ' ')} task cannot move to ${to.replace('_', ' ')}.`,
    )
  }
}

export interface TaskActor {
  session: Session
  /** True when the caller holds workstation.task.manage at any scope. */
  canManage: boolean
}

/**
 * Load a task for a state change and check the caller may make it.
 *
 * The assignee may run their own task's clock. A manager may act on any task
 * in scope. Anyone else gets 403 — and a task they may not see answers
 * identically to a task that does not exist, so the caller learns nothing
 * from the difference.
 */
async function loadForAction(tx: Tx, taskId: string, actor: TaskActor) {
  const task = await tx.task.findFirst({ where: { id: taskId, ...alive } })
  if (!task) throw ApiError.notFound('No such task.')
  const isAssignee = Boolean(actor.session.employeeId) && task.assignedEmployeeId === actor.session.employeeId
  if (!isAssignee && !actor.canManage) throw ApiError.forbidden()
  return task
}

/** Whole minutes between two instants, never negative. */
function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000))
}

/**
 * Recompute a task's tracked time from its sessions and write it.
 *
 * actualMinutes  = Σ (session.endedAt − session.startedAt), rounded once at
 *                  the end so a long task does not accumulate rounding drift.
 * elapsedMinutes = (endedAt ?? now) − startedAt
 * pauseMinutes   = elapsed − actual
 */
async function recomputeTotals(tx: Tx, taskId: string, endMarker: Date) {
  const [task, sessions] = await Promise.all([
    tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { startedAt: true } }),
    tx.taskTimeSession.findMany({
      where: { taskId, endedAt: { not: null } },
      select: { startedAt: true, endedAt: true },
    }),
  ])
  const workedMs = sessions.reduce((sum, s) => sum + (s.endedAt!.getTime() - s.startedAt.getTime()), 0)
  const actualMinutes = Math.max(0, Math.round(workedMs / 60_000))
  const elapsedMinutes = task.startedAt ? minutesBetween(task.startedAt, endMarker) : 0
  const totalPauseMinutes = Math.max(0, elapsedMinutes - actualMinutes)
  return { actualMinutes, totalPauseMinutes }
}

/** Write the append-only audit row for a task action. */
async function audit(tx: Tx, input: {
  taskId: string
  action: string
  session: Session
  oldStatus?: string | null
  newStatus?: string | null
  meta?: unknown
}) {
  await tx.taskAuditLog.create({
    data: {
      taskId: input.taskId,
      action: input.action,
      performedByUserId: input.session.userId,
      performedByEmployeeId: input.session.employeeId,
      oldStatus: input.oldStatus ?? null,
      newStatus: input.newStatus ?? null,
      metaJson: input.meta === undefined ? null : JSON.stringify(input.meta),
    },
  })
}

export { audit as writeTaskAudit, minutesBetween }

/**
 * START — the first run of the clock on a pending task.
 * Sets startedAt once; a later resume never moves it.
 */
/**
 * `now` exists so the verification suite can drive the clock to exact
 * minutes. No route passes it — the HTTP layer never accepts a timestamp —
 * so in production every one of these is the real server clock.
 */
export async function startTask(taskId: string, actor: TaskActor, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    const task = await loadForAction(tx, taskId, actor)
    const from = normaliseStatus(task.status)
    if (from === 'in_progress') {
      // A double-clicked Start is not an error; the task is already running.
      return task
    }
    assertTransition(from, 'in_progress')

    const open = await tx.taskTimeSession.findFirst({ where: { taskId, endedAt: null } })
    if (open) throw ApiError.conflict('session_already_open', 'This task already has a running work session.')
    await assertEmployeeFree(tx, task.assignedEmployeeId, taskId)

    await tx.taskTimeSession.create({
      data: { taskId, employeeId: task.assignedEmployeeId, startedAt: now, sessionType: 'work', openedBy: 'start' },
    })
    const updated = await tx.task.update({
      where: { id: taskId },
      data: {
        status: 'in_progress',
        startedAt: task.startedAt ?? now,
        updatedBy: actor.session.userId,
      },
    })
    await audit(tx, { taskId, action: 'task_started', session: actor.session, oldStatus: task.status, newStatus: 'in_progress', meta: { at: now.toISOString() } })
    return updated
  })
}

/**
 * PAUSE — close the running session and bank the time worked so far.
 * Paused time is never counted as work: it is simply the stretch with no
 * open session, and falls out of elapsed-minus-actual.
 */
export async function pauseTask(taskId: string, actor: TaskActor, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    const task = await loadForAction(tx, taskId, actor)
    const from = normaliseStatus(task.status)
    if (from === 'paused') return task
    assertTransition(from, 'paused')

    await closeOpenSession(tx, taskId, now, 'pause')
    const totals = await recomputeTotals(tx, taskId, now)
    const updated = await tx.task.update({
      where: { id: taskId },
      data: { status: 'paused', ...totals, updatedBy: actor.session.userId },
    })
    await audit(tx, {
      taskId, action: 'task_paused', session: actor.session,
      oldStatus: task.status, newStatus: 'paused',
      meta: { at: now.toISOString(), actual_minutes: totals.actualMinutes },
    })
    return updated
  })
}

/** RESUME — open a NEW session. Previous sessions are never touched. */
export async function resumeTask(taskId: string, actor: TaskActor, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    const task = await loadForAction(tx, taskId, actor)
    const from = normaliseStatus(task.status)
    if (from === 'in_progress') return task
    assertTransition(from, 'in_progress')

    const open = await tx.taskTimeSession.findFirst({ where: { taskId, endedAt: null } })
    if (open) throw ApiError.conflict('session_already_open', 'This task already has a running work session.')
    await assertEmployeeFree(tx, task.assignedEmployeeId, taskId)

    await tx.taskTimeSession.create({
      data: { taskId, employeeId: task.assignedEmployeeId, startedAt: now, sessionType: 'work', openedBy: 'resume' },
    })
    const updated = await tx.task.update({
      where: { id: taskId },
      data: { status: 'in_progress', startedAt: task.startedAt ?? now, updatedBy: actor.session.userId },
    })
    await audit(tx, { taskId, action: 'task_resumed', session: actor.session, oldStatus: task.status, newStatus: 'in_progress', meta: { at: now.toISOString() } })
    return updated
  })
}

/** COMPLETE — close the clock and freeze the totals. */
export async function completeTask(taskId: string, actor: TaskActor, note?: string | null, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    const task = await loadForAction(tx, taskId, actor)
    const from = normaliseStatus(task.status)
    if (from === 'completed') return task
    assertTransition(from, 'completed')

    await closeOpenSession(tx, taskId, now, 'complete')
    // Totals are frozen at the completion instant, not at "now" on later reads.
    await tx.task.update({ where: { id: taskId }, data: { endedAt: now } })
    const totals = await recomputeTotals(tx, taskId, now)
    const updated = await tx.task.update({
      where: { id: taskId },
      data: {
        status: 'completed',
        endedAt: now,
        completedAt: now,
        ...totals,
        notes: note?.trim() ? `${task.notes ? `${task.notes}\n` : ''}${note.trim()}` : task.notes,
        updatedBy: actor.session.userId,
      },
    })
    await audit(tx, {
      taskId, action: 'task_completed', session: actor.session,
      oldStatus: task.status, newStatus: 'completed',
      meta: { at: now.toISOString(), actual_minutes: totals.actualMinutes, pause_minutes: totals.totalPauseMinutes },
    })
    return updated
  })
}

/** CANCEL — stop the clock without claiming the work was done. */
export async function cancelTask(taskId: string, actor: TaskActor, reason?: string | null, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    const task = await loadForAction(tx, taskId, actor)
    const from = normaliseStatus(task.status)
    if (from === 'cancelled') return task
    if (from === 'in_progress' && !actor.canManage) {
      throw ApiError.forbidden('A running task can only be cancelled by a manager.')
    }
    assertTransition(from, 'cancelled')

    await closeOpenSession(tx, taskId, now, 'cancel')
    await tx.task.update({ where: { id: taskId }, data: { endedAt: now } })
    const totals = await recomputeTotals(tx, taskId, now)
    const updated = await tx.task.update({
      where: { id: taskId },
      data: {
        status: 'cancelled', cancelledAt: now, endedAt: now,
        cancelReason: reason?.trim() || null, ...totals, updatedBy: actor.session.userId,
      },
    })
    await audit(tx, {
      taskId, action: 'task_cancelled', session: actor.session,
      oldStatus: task.status, newStatus: 'cancelled', meta: { reason: reason ?? null, at: now.toISOString() },
    })
    return updated
  })
}

/**
 * REOPEN — the authorised correction workflow for a completed or cancelled
 * task. Manager only. The sessions and the time already tracked STAY; only
 * the closing marks are cleared, so reopening can never erase recorded work.
 */
export async function reopenTask(taskId: string, actor: TaskActor, reason?: string | null) {
  if (!actor.canManage) throw ApiError.forbidden('Only a manager can reopen a closed task.')
  return prisma.$transaction(async (tx) => {
    const task = await loadForAction(tx, taskId, actor)
    const from = normaliseStatus(task.status)
    if (from !== 'completed' && from !== 'cancelled') {
      throw ApiError.unprocessable('not_closed', 'Only a completed or cancelled task can be reopened.')
    }
    const next: TaskStatus = task.actualMinutes > 0 ? 'paused' : 'pending'
    const updated = await tx.task.update({
      where: { id: taskId },
      data: {
        status: next, completedAt: null, cancelledAt: null, cancelReason: null, endedAt: null,
        updatedBy: actor.session.userId,
      },
    })
    await audit(tx, {
      taskId, action: 'task_reopened', session: actor.session,
      oldStatus: task.status, newStatus: next, meta: { reason: reason ?? null },
    })
    return updated
  })
}

/** Close whatever session is open on a task, writing its duration. */
async function closeOpenSession(tx: Tx, taskId: string, at: Date, closedBy: string) {
  const open = await tx.taskTimeSession.findFirst({ where: { taskId, endedAt: null } })
  if (!open) return null
  return tx.taskTimeSession.update({
    where: { id: open.id },
    data: { endedAt: at, durationMinutes: minutesBetween(open.startedAt, at), closedBy },
  })
}

/**
 * An employee works one thing at a time. If another task is already running
 * for them, say which one rather than silently double-counting their day.
 */
async function assertEmployeeFree(tx: Tx, employeeId: string, exceptTaskId: string) {
  const other = await tx.taskTimeSession.findFirst({
    where: { employeeId, endedAt: null, NOT: { taskId: exceptTaskId } },
    select: { task: { select: { id: true, title: true } } },
  })
  if (other) {
    throw ApiError.conflict(
      'another_task_running',
      `"${other.task.title}" is already running. Pause it before starting another task.`,
      { task_id: other.task.id },
    )
  }
}

/**
 * Live totals for a task that is running right now: the open session's
 * elapsed time added to the banked minutes. The UI ticks a visual timer, but
 * this is what it reconciles to on every refresh.
 */
export function liveTotals(task: {
  status: string
  actualMinutes: number
  totalPauseMinutes: number
  startedAt: Date | null
  endedAt: Date | null
}, openSessionStartedAt: Date | null, now = new Date()) {
  const status = normaliseStatus(task.status)
  const running = status === 'in_progress' && openSessionStartedAt !== null
  const liveActual = running
    ? task.actualMinutes + minutesBetween(openSessionStartedAt, now)
    : task.actualMinutes
  const elapsedTo = task.endedAt ?? (status === 'completed' || status === 'cancelled' ? task.endedAt : now)
  const elapsed = task.startedAt && elapsedTo ? minutesBetween(task.startedAt, elapsedTo) : 0
  return {
    actualMinutes: liveActual,
    elapsedMinutes: elapsed,
    pauseMinutes: Math.max(0, elapsed - liveActual),
    running,
    currentSessionStartedAt: running ? openSessionStartedAt : null,
  }
}

/**
 * Overdue is a DISPLAY state, not a stored status: a task is overdue when its
 * due date has passed and it is neither completed nor cancelled. The stored
 * status keeps saying what the employee is actually doing.
 */
export function isOverdue(dueDate: string | null, status: string, today = new Date().toISOString().slice(0, 10)): boolean {
  if (!dueDate) return false
  const s = normaliseStatus(status)
  if (s === 'completed' || s === 'cancelled') return false
  return dueDate < today
}
