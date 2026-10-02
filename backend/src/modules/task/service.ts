import type { Prisma } from '@prisma/client'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import type { Session } from '../../platform/auth.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { writeAudit } from '../../platform/audit.js'
import { writeActivity } from '../../platform/workstation/activity.js'
import {
  normaliseStatus, isOverdue, liveTotals, writeTaskAudit,
  TASK_PRIORITIES, type TaskPriority,
} from './engine.js'

/**
 * TaskService — everything about a task that is not the clock.
 *
 * Scoping follows the Workstation convention (platform/workstation/scope.ts):
 * `self` means "assigned to me", `department` means "assigned to someone in
 * my department", `organisation` means everything. The predicate is folded
 * into the query, never applied to rows after they come back.
 */

export interface TaskFilters {
  status?: string
  priority?: string
  employeeId?: string
  clientId?: string
  clientServiceId?: string
  /**
   * The tasks for a set of GST return cases — GST-CLIENT-DASHBOARD-TASKS §4
   * fills this from the three case ids surfaced on the GstClientView, so the
   * per-client per-period panel is one round-trip. An empty array matches
   * nothing (there are no such tasks); undefined leaves the filter off.
   */
  partnershipCaseIdIn?: string[]
  dueFrom?: string
  dueTo?: string
  createdFrom?: string
  createdTo?: string
  overdueOnly?: boolean
  q?: string
  sort?: 'newest' | 'oldest' | 'due_date' | 'priority' | 'duration'
  limit?: number
  offset?: number
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

/**
 * The `where` fragment for the caller's scope. `self` with no employee
 * record matches nothing — a user who is not an employee has no assignments.
 */
export async function taskScopeWhere(session: Session, scope: Scope): Promise<Prisma.TaskWhereInput> {
  if (scope === 'organisation') return {}
  if (scope === 'department') {
    const me = session.employeeId
    if (!me) return { id: '__none__' }
    const employee = await prisma.employee.findUnique({ where: { id: me }, select: { departmentId: true } })
    if (!employee) return { id: '__none__' }
    return { assignedEmployee: { departmentId: employee.departmentId } }
  }
  return { assignedEmployeeId: session.employeeId ?? '__none__' }
}

const TASK_INCLUDE = {
  assignedEmployee: { select: { id: true, fullName: true, employeeCode: true, departmentId: true } },
  assignedBy: { select: { id: true, fullName: true } },
  client: { select: { id: true, companyName: true } },
  clientService: { select: { id: true, service: { select: { id: true, name: true } } } },
  sessions: { orderBy: { startedAt: 'asc' } },
} as const

type TaskRow = Awaited<ReturnType<typeof prisma.task.findFirstOrThrow<{ include: typeof TASK_INCLUDE }>>>

export interface TaskApi {
  id: string
  title: string
  description: string | null
  status: string
  raw_status: string
  priority: string
  overdue: boolean
  assigned_employee_id: string
  assigned_employee_name: string
  assigned_by_id: string | null
  assigned_by_name: string | null
  client_id: string | null
  client_name: string | null
  project_id: string | null
  project_name: string | null
  due_date: string | null
  estimated_minutes: number | null
  actual_minutes: number
  /// Exact tracked seconds. Minutes are the record; this exists so a
  /// short session reads as "48s" instead of rounding away to nothing.
  actual_seconds: number
  pause_minutes: number
  elapsed_minutes: number
  variance_minutes: number | null
  running: boolean
  current_session_started_at: string | null
  started_at: string | null
  ended_at: string | null
  completed_at: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  notes: string | null
  attachment_url: string | null
  session_count: number
  created_at: string
  updated_at: string
}

export function taskToApi(row: TaskRow, now = new Date()): TaskApi {
  const openSession = row.sessions.find((s) => s.endedAt === null) ?? null
  const live = liveTotals(row, openSession?.startedAt ?? null, now)
  // Exact seconds across every session, closed and open.
  const workedMs = row.sessions.reduce(
    (sum, s) => sum + ((s.endedAt ?? now).getTime() - s.startedAt.getTime()), 0,
  )
  const status = normaliseStatus(row.status)
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status,
    raw_status: row.status,
    priority: row.priority,
    overdue: isOverdue(row.dueDate, row.status, now.toISOString().slice(0, 10)),
    assigned_employee_id: row.assignedEmployeeId,
    assigned_employee_name: row.assignedEmployee.fullName,
    assigned_by_id: row.assignedById,
    assigned_by_name: row.assignedBy?.fullName ?? null,
    client_id: row.clientId,
    client_name: row.client?.companyName ?? null,
    project_id: row.clientServiceId,
    project_name: row.clientService?.service.name ?? null,
    due_date: row.dueDate,
    estimated_minutes: row.estimatedMinutes,
    actual_minutes: live.actualMinutes,
    actual_seconds: Math.max(0, Math.round(workedMs / 1000)),
    pause_minutes: live.pauseMinutes,
    elapsed_minutes: live.elapsedMinutes,
    variance_minutes: row.estimatedMinutes === null ? null : live.actualMinutes - row.estimatedMinutes,
    running: live.running,
    current_session_started_at: live.currentSessionStartedAt?.toISOString() ?? null,
    started_at: row.startedAt?.toISOString() ?? null,
    ended_at: row.endedAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
    cancelled_at: row.cancelledAt?.toISOString() ?? null,
    cancel_reason: row.cancelReason,
    notes: row.notes,
    attachment_url: row.attachmentUrl,
    session_count: row.sessions.length,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

/** Status filter that understands the legacy vocabulary on old rows. */
function statusWhere(status?: string): Record<string, unknown> {
  if (!status || status === 'all') return {}
  if (status === 'overdue') return {}   // handled separately — overdue is a display state
  const legacyFor: Record<string, string[]> = {
    pending: ['pending', 'open'],
    paused: ['paused', 'blocked'],
    completed: ['completed', 'done'],
    in_progress: ['in_progress'],
    cancelled: ['cancelled'],
  }
  return { status: { in: legacyFor[status] ?? [status] } }
}

export const TaskService = {
  async list(session: Session, scope: Scope, filters: TaskFilters = {}) {
    const today = new Date().toISOString().slice(0, 10)
    const scopeWhere = await taskScopeWhere(session, scope)
    const overdueWhere = filters.overdueOnly || filters.status === 'overdue'
      ? { dueDate: { lt: today, not: null }, status: { notIn: ['completed', 'done', 'cancelled'] } }
      : {}

    // Free-text search across the task and the names hanging off it. Built
    // as a typed array so the nullable client/project relations use `is`.
    const search: Prisma.TaskWhereInput[] | null = filters.q
      ? [
          { title: { contains: filters.q, mode: 'insensitive' } },
          { description: { contains: filters.q, mode: 'insensitive' } },
          { assignedEmployee: { is: { fullName: { contains: filters.q, mode: 'insensitive' } } } },
          { client: { is: { companyName: { contains: filters.q, mode: 'insensitive' } } } },
          { clientService: { is: { service: { is: { name: { contains: filters.q, mode: 'insensitive' } } } } } },
        ]
      : null

    const where: Prisma.TaskWhereInput = {
      ...alive,
      ...scopeWhere,
      ...statusWhere(filters.status),
      ...overdueWhere,
      ...(filters.priority && filters.priority !== 'all' ? { priority: filters.priority } : {}),
      ...(filters.employeeId ? { assignedEmployeeId: filters.employeeId } : {}),
      ...(filters.clientId ? { clientId: filters.clientId } : {}),
      ...(filters.clientServiceId ? { clientServiceId: filters.clientServiceId } : {}),
      ...(filters.partnershipCaseIdIn ? { partnershipCaseId: { in: filters.partnershipCaseIdIn } } : {}),
      ...(filters.dueFrom || filters.dueTo
        ? { dueDate: { ...(filters.dueFrom ? { gte: filters.dueFrom } : {}), ...(filters.dueTo ? { lte: filters.dueTo } : {}) } }
        : {}),
      ...(filters.createdFrom || filters.createdTo
        ? {
            createdAt: {
              ...(filters.createdFrom ? { gte: new Date(`${filters.createdFrom}T00:00:00Z`) } : {}),
              ...(filters.createdTo ? { lte: new Date(`${filters.createdTo}T23:59:59Z`) } : {}),
            },
          }
        : {}),
      ...(search ? { OR: search } : {}),
    }

    const orderBy =
      filters.sort === 'oldest' ? [{ createdAt: 'asc' as const }]
      : filters.sort === 'due_date' ? [{ dueDate: 'asc' as const }]
      : filters.sort === 'duration' ? [{ actualMinutes: 'desc' as const }]
      : [{ createdAt: 'desc' as const }]

    const take = Math.min(filters.limit ?? 50, 200)
    const skip = filters.offset ?? 0

    // Priority is a word, so it cannot be ordered in SQL without a CASE; the
    // page is sorted after the database has already narrowed it.
    const [rows, total] = await Promise.all([
      prisma.task.findMany({ where, include: TASK_INCLUDE, orderBy, take, skip }),
      prisma.task.count({ where }),
    ])
    const items = rows.map((r) => taskToApi(r))
    if (filters.sort === 'priority') {
      items.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9))
    }
    return { items, total, limit: take, offset: skip }
  },

  /** One task, with its sessions, timeline and audit history. */
  async get(session: Session, scope: Scope, taskId: string) {
    const scopeWhere = await taskScopeWhere(session, scope)
    const row = await prisma.task.findFirst({ where: { id: taskId, ...alive, ...scopeWhere }, include: TASK_INCLUDE })
    // Out of scope and non-existent answer identically: the caller learns nothing.
    if (!row) throw ApiError.notFound('No such task.')

    const [auditRows, employees] = await Promise.all([
      prisma.taskAuditLog.findMany({ where: { taskId }, orderBy: { performedAt: 'asc' } }),
      prisma.employee.findMany({
        where: { id: { in: Array.from(new Set(row.sessions.map((s) => s.employeeId))) } },
        select: { id: true, fullName: true },
      }),
    ])
    const actorIds = Array.from(new Set(auditRows.map((a) => a.performedByEmployeeId).filter((x): x is string => Boolean(x))))
    const actors = actorIds.length
      ? await prisma.employee.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true } })
      : []
    const actorName = new Map(actors.map((a) => [a.id, a.fullName]))
    const employeeName = new Map(employees.map((e) => [e.id, e.fullName]))

    return {
      task: taskToApi(row),
      sessions: row.sessions.map((s) => ({
        id: s.id,
        employee_id: s.employeeId,
        employee_name: employeeName.get(s.employeeId) ?? '',
        started_at: s.startedAt.toISOString(),
        ended_at: s.endedAt?.toISOString() ?? null,
        duration_minutes: s.durationMinutes,
        opened_by: s.openedBy,
        closed_by: s.closedBy,
        open: s.endedAt === null,
      })),
      timeline: auditRows.map((a) => ({
        id: a.id,
        action: a.action,
        at: a.performedAt.toISOString(),
        by: a.performedByEmployeeId ? actorName.get(a.performedByEmployeeId) ?? 'Someone' : 'System',
        old_status: a.oldStatus ? normaliseStatus(a.oldStatus) : null,
        new_status: a.newStatus ? normaliseStatus(a.newStatus) : null,
        meta: a.metaJson ? safeParse(a.metaJson) : null,
      })),
    }
  },

  async create(session: Session, input: {
    title: string
    description?: string | null
    assignedEmployeeId: string
    priority: string
    dueDate: string
    clientId?: string | null
    clientServiceId?: string | null
    /**
     * Two-way link to the GST return-cycle case (schema commit 070a81d).
     * Set by the GST period seed generator (§4) so completing the case's
     * "Filed" item can close the task and vice versa.
     */
    partnershipCaseId?: string | null
    estimatedMinutes?: number | null
    notes?: string | null
    attachmentUrl?: string | null
  }) {
    const title = input.title.trim()
    if (!title) throw ApiError.badRequest('A task needs a title.')
    if (!(TASK_PRIORITIES as readonly string[]).includes(input.priority)) {
      throw ApiError.badRequest('Priority must be low, medium, high or urgent.')
    }
    const employee = await prisma.employee.findFirst({
      where: { id: input.assignedEmployeeId, deletedAt: null }, select: { id: true, fullName: true, status: true },
    })
    if (!employee) throw ApiError.badRequest('That employee does not exist.')
    if (employee.status === 'inactive') throw ApiError.unprocessable('inactive_employee', `${employee.fullName} is inactive and cannot be assigned work.`)
    if (input.clientId) {
      const client = await prisma.client.findFirst({ where: { id: input.clientId, ...alive }, select: { id: true } })
      if (!client) throw ApiError.badRequest('That client does not exist.')
    }
    if (input.clientServiceId) {
      const cs = await prisma.clientService.findFirst({ where: { id: input.clientServiceId, ...alive }, select: { id: true, clientId: true } })
      if (!cs) throw ApiError.badRequest('That project does not exist.')
      if (input.clientId && cs.clientId !== input.clientId) {
        throw ApiError.badRequest('That project belongs to a different client.')
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          title,
          description: input.description?.trim() || null,
          assignedEmployeeId: input.assignedEmployeeId,
          assignedById: session.employeeId,
          priority: input.priority,
          status: 'pending',
          dueDate: input.dueDate,
          clientId: input.clientId || null,
          clientServiceId: input.clientServiceId || null,
          partnershipCaseId: input.partnershipCaseId || null,
          estimatedMinutes: input.estimatedMinutes ?? null,
          notes: input.notes?.trim() || null,
          attachmentUrl: input.attachmentUrl?.trim() || null,
          createdBy: session.userId,
          updatedBy: session.userId,
        },
      })
      await writeTaskAudit(tx, { taskId: task.id, action: 'task_created', session, newStatus: 'pending', meta: { title, priority: input.priority } })
      await writeTaskAudit(tx, {
        taskId: task.id, action: 'task_assigned', session,
        meta: { employee_id: input.assignedEmployeeId, employee_name: employee.fullName },
      })
      return task
    })

    await writeAudit({
      actorUserId: session.userId, action: 'workstation.task.create',
      entityType: 'Task', entityId: created.id,
      after: { title, assigned_employee_id: input.assignedEmployeeId, priority: input.priority, due_date: input.dueDate },
    })
    if (created.clientId) {
      await writeActivity({
        session, subjectType: 'client', subjectId: created.clientId,
        action: 'task.created', description: `Task "${title}" assigned to ${employee.fullName}`,
        entityType: 'Task', entityId: created.id,
      })
    }
    await notify(input.assignedEmployeeId, {
      title: 'New task assigned',
      body: `${title} — due ${input.dueDate}`,
      entityId: created.id,
    })
    return TaskService.get(session, 'organisation', created.id)
  },

  async update(session: Session, scope: Scope, taskId: string, patch: {
    title?: string
    description?: string | null
    priority?: string
    dueDate?: string
    clientId?: string | null
    clientServiceId?: string | null
    estimatedMinutes?: number | null
    notes?: string | null
  }) {
    const existing = await prisma.task.findFirst({ where: { id: taskId, ...alive } })
    if (!existing) throw ApiError.notFound('No such task.')
    if (normaliseStatus(existing.status) === 'completed') {
      throw ApiError.unprocessable('completed_immutable', 'A completed task cannot be edited. Reopen it first.')
    }
    if (patch.priority && !(TASK_PRIORITIES as readonly string[]).includes(patch.priority)) {
      throw ApiError.badRequest('Priority must be low, medium, high or urgent.')
    }

    const data: Record<string, unknown> = { updatedBy: session.userId }
    if (patch.title !== undefined) data.title = patch.title.trim()
    if (patch.description !== undefined) data.description = patch.description?.trim() || null
    if (patch.priority !== undefined) data.priority = patch.priority
    if (patch.dueDate !== undefined) data.dueDate = patch.dueDate
    if (patch.clientId !== undefined) data.clientId = patch.clientId || null
    if (patch.clientServiceId !== undefined) data.clientServiceId = patch.clientServiceId || null
    if (patch.estimatedMinutes !== undefined) data.estimatedMinutes = patch.estimatedMinutes
    if (patch.notes !== undefined) data.notes = patch.notes?.trim() || null

    await prisma.$transaction(async (tx) => {
      await tx.task.update({ where: { id: taskId }, data })
      await writeTaskAudit(tx, {
        taskId, action: 'task_edited', session,
        meta: {
          before: { title: existing.title, priority: existing.priority, due_date: existing.dueDate, estimated_minutes: existing.estimatedMinutes },
          after: patch,
        },
      })
    })
    await writeAudit({
      actorUserId: session.userId, action: 'workstation.task.update', entityType: 'Task', entityId: taskId,
      before: { title: existing.title, priority: existing.priority, due_date: existing.dueDate },
      after: patch,
    })
    return TaskService.get(session, scope, taskId)
  },

  /** Reassign — the work already tracked stays with the task, not the person. */
  async reassign(session: Session, scope: Scope, taskId: string, employeeId: string, reason?: string | null) {
    const existing = await prisma.task.findFirst({ where: { id: taskId, ...alive } })
    if (!existing) throw ApiError.notFound('No such task.')
    if (existing.assignedEmployeeId === employeeId) return TaskService.get(session, scope, taskId)
    const employee = await prisma.employee.findFirst({ where: { id: employeeId, deletedAt: null }, select: { id: true, fullName: true, status: true } })
    if (!employee) throw ApiError.badRequest('That employee does not exist.')
    if (employee.status === 'inactive') throw ApiError.unprocessable('inactive_employee', `${employee.fullName} is inactive.`)

    await prisma.$transaction(async (tx) => {
      // A task cannot be handed over mid-session: close the clock first so the
      // minutes already worked stay attributed to the person who worked them.
      const open = await tx.taskTimeSession.findFirst({ where: { taskId, endedAt: null } })
      if (open) {
        const now = new Date()
        await tx.taskTimeSession.update({
          where: { id: open.id },
          data: { endedAt: now, durationMinutes: Math.max(0, Math.round((now.getTime() - open.startedAt.getTime()) / 60_000)), closedBy: 'pause' },
        })
        const sessions = await tx.taskTimeSession.findMany({ where: { taskId, endedAt: { not: null } }, select: { startedAt: true, endedAt: true } })
        const workedMs = sessions.reduce((s, x) => s + (x.endedAt!.getTime() - x.startedAt.getTime()), 0)
        const actualMinutes = Math.max(0, Math.round(workedMs / 60_000))
        const elapsed = existing.startedAt ? Math.max(0, Math.round((now.getTime() - existing.startedAt.getTime()) / 60_000)) : 0
        await tx.task.update({
          where: { id: taskId },
          data: { status: 'paused', actualMinutes, totalPauseMinutes: Math.max(0, elapsed - actualMinutes) },
        })
      }
      await tx.task.update({ where: { id: taskId }, data: { assignedEmployeeId: employeeId, updatedBy: session.userId } })
      await writeTaskAudit(tx, {
        taskId, action: 'task_reassigned', session,
        meta: { from_employee_id: existing.assignedEmployeeId, to_employee_id: employeeId, to_employee_name: employee.fullName, reason: reason ?? null },
      })
    })
    await writeAudit({
      actorUserId: session.userId, action: 'workstation.task.reassign', entityType: 'Task', entityId: taskId,
      before: { assigned_employee_id: existing.assignedEmployeeId }, after: { assigned_employee_id: employeeId },
    })
    await notify(employeeId, { title: 'Task reassigned to you', body: existing.title, entityId: taskId })
    return TaskService.get(session, scope, taskId)
  },

  /** Employees a manager may assign work to, for the picker. */
  async assignableEmployees() {
    const rows = await prisma.employee.findMany({
      where: { deletedAt: null, status: { not: 'inactive' } },
      select: { id: true, fullName: true, employeeCode: true, department: { select: { name: true } } },
      orderBy: { fullName: 'asc' },
    })
    return rows.map((r) => ({ id: r.id, name: r.fullName, code: r.employeeCode, department: r.department?.name ?? null }))
  },
}

/**
 * Notifications ride the existing Notification table — the same one HRMS
 * writes to — so the bell the user already has picks these up. A failure
 * here must never fail the task operation that caused it.
 */
async function notify(employeeId: string, input: { title: string; body: string; entityId: string }) {
  try {
    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true } })
    if (!employee) return
    const user = await prisma.user.findFirst({ where: { employeeId }, select: { id: true } })
    if (!user) return
    await prisma.notification.create({
      data: {
        userId: user.id,
        type: 'task',
        module: 'system',
        entityType: 'Task',
        entityId: input.entityId,
        title: input.title,
        body: input.body,
        actionUrl: `/workstation/tasks/${input.entityId}`,
      },
    })
  } catch (err) {
    console.error('[task] notification failed', err instanceof Error ? err.message : err)
  }
}

export { notify as notifyTaskAssignee }

function safeParse(json: string): unknown {
  try { return JSON.parse(json) } catch { return null }
}
