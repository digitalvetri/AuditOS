import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'
import { TaskService } from './service.js'
import { TaskReports } from './reports.js'
import {
  startTask, pauseTask, resumeTask, completeTask, cancelTask, reopenTask,
  TASK_PRIORITIES, type TaskActor,
} from './engine.js'

/**
 * Task HTTP surface — mounted at /api/tasks.
 *
 * Same pipeline as the rest of Workstation: authenticate → require the
 * permission (which returns the caller's scope) → Zod validate → service.
 *
 * NOTHING in any request body carries a timestamp, a duration or an employee
 * id for the actor. Those come from the session and the server clock, which
 * is what makes "employees cannot enter their own time" a property of the
 * API rather than a rule the UI is trusted to follow.
 */
export const tasksRouter = Router()

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')

/** The caller's actor record: who they are, and whether they can manage. */
function actorOf(session: Session): TaskActor {
  return { session, canManage: can(session, 'workstation.task.manage', 'self') }
}

function requireManage(session: Session) {
  if (!can(session, 'workstation.task.manage', 'self')) {
    throw ApiError.forbidden('You do not have permission to manage tasks.')
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, message: string): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) {
    throw ApiError.badRequest(message, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
  }
  return r.data
}

// ── List / read ──────────────────────────────────────────────────────────
tasksRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.task.read')
  const q = parse(z.object({
    status: z.string().optional(),
    priority: z.string().optional(),
    employee_id: z.string().optional(),
    client_id: z.string().optional(),
    project_id: z.string().optional(),
    // Comma-separated GST return-cycle case ids — GST-CLIENT-DASHBOARD-TASKS §4.
    partnership_case_ids: z.string().optional(),
    due_from: ISO_DATE.optional(),
    due_to: ISO_DATE.optional(),
    created_from: ISO_DATE.optional(),
    created_to: ISO_DATE.optional(),
    overdue: z.coerce.boolean().optional(),
    q: z.string().optional(),
    sort: z.enum(['newest', 'oldest', 'due_date', 'priority', 'duration']).optional(),
    limit: z.coerce.number().int().positive().optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  }), req.query, 'Invalid task filter.')

  // Split the CSV once here; the service takes the array. An empty CSV
  // (`?partnership_case_ids=`) already becomes undefined via Zod's optional
  // so this branch only runs when at least one id is present.
  const partnershipCaseIdIn = q.partnership_case_ids
    ? q.partnership_case_ids.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined

  ok(res, await TaskService.list(session, scope, {
    status: q.status, priority: q.priority, employeeId: q.employee_id,
    clientId: q.client_id, clientServiceId: q.project_id,
    partnershipCaseIdIn,
    dueFrom: q.due_from, dueTo: q.due_to, createdFrom: q.created_from, createdTo: q.created_to,
    overdueOnly: q.overdue, q: q.q, sort: q.sort, limit: q.limit, offset: q.offset,
  }))
}))

/** The employees a manager may assign work to. */
tasksRouter.get('/assignable-employees', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.task.read')
  ok(res, { items: await TaskService.assignableEmployees() })
}))

// ── Reports (registered before /:id so the paths are not swallowed) ───────
tasksRouter.get('/reports/dashboard', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.task.read')
  ok(res, await TaskReports.dashboard(session, scope, reportFilters(req.query)))
}))

tasksRouter.get('/reports/by-employee', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.task.report', 'workstation.task.read')
  ok(res, { items: await TaskReports.byEmployee(session, scope, reportFilters(req.query)) })
}))

tasksRouter.get('/reports/by-client', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.task.report', 'workstation.task.read')
  ok(res, { items: await TaskReports.byDimension(session, scope, 'client', reportFilters(req.query)) })
}))

tasksRouter.get('/reports/by-project', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.task.report', 'workstation.task.read')
  ok(res, { items: await TaskReports.byDimension(session, scope, 'project', reportFilters(req.query)) })
}))

tasksRouter.get('/reports/estimated-vs-actual', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.task.report', 'workstation.task.read')
  ok(res, await TaskReports.estimatedVsActual(session, scope, reportFilters(req.query)))
}))

tasksRouter.get('/reports/timesheet', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.task.report', 'workstation.task.read')
  ok(res, await TaskReports.timesheet(session, scope, reportFilters(req.query)))
}))

function reportFilters(query: unknown) {
  const q = parse(z.object({
    from: ISO_DATE.optional(), to: ISO_DATE.optional(),
    employee_id: z.string().optional(), status: z.string().optional(),
    priority: z.string().optional(), client_id: z.string().optional(), project_id: z.string().optional(),
  }), query, 'Invalid report filter.')
  return {
    from: q.from, to: q.to, employeeId: q.employee_id, status: q.status,
    priority: q.priority, clientId: q.client_id, clientServiceId: q.project_id,
  }
}

tasksRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.task.read')
  ok(res, await TaskService.get(session, scope, req.params.id))
}))

// ── Create / edit / assign ───────────────────────────────────────────────
tasksRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.task.read')
  requireManage(session)
  const b = parse(z.object({
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    assigned_employee_id: z.string().min(1),
    priority: z.enum(TASK_PRIORITIES),
    due_date: ISO_DATE,
    client_id: z.string().nullable().optional(),
    project_id: z.string().nullable().optional(),
    estimated_minutes: z.number().int().positive().nullable().optional(),
    notes: z.string().nullable().optional(),
    attachment_url: z.string().nullable().optional(),
  }), req.body, 'A task needs a title, an assignee, a priority and a due date.')

  ok(res, await TaskService.create(session, {
    title: b.title,
    description: b.description,
    assignedEmployeeId: b.assigned_employee_id,
    priority: b.priority,
    dueDate: b.due_date,
    clientId: b.client_id,
    clientServiceId: b.project_id,
    estimatedMinutes: b.estimated_minutes ?? null,
    notes: b.notes,
    attachmentUrl: b.attachment_url,
  }), 201)
}))

tasksRouter.patch('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.task.read')
  requireManage(session)
  const b = parse(z.object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    due_date: ISO_DATE.optional(),
    client_id: z.string().nullable().optional(),
    project_id: z.string().nullable().optional(),
    estimated_minutes: z.number().int().positive().nullable().optional(),
    notes: z.string().nullable().optional(),
  }), req.body, 'Invalid task patch.')

  ok(res, await TaskService.update(session, scope, req.params.id, {
    title: b.title, description: b.description, priority: b.priority, dueDate: b.due_date,
    clientId: b.client_id, clientServiceId: b.project_id,
    estimatedMinutes: b.estimated_minutes, notes: b.notes,
  }))
}))

tasksRouter.post('/:id/reassign', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.task.read')
  requireManage(session)
  const b = parse(z.object({
    employee_id: z.string().min(1),
    reason: z.string().nullable().optional(),
  }), req.body, 'employee_id is required.')
  ok(res, await TaskService.reassign(session, scope, req.params.id, b.employee_id, b.reason))
}))

// ── The clock ────────────────────────────────────────────────────────────
// Each of these is a POST with NO body of consequence: the server supplies
// the time, the session supplies the actor.

tasksRouter.post('/:id/start', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.task.read')
  await startTask(req.params.id, actorOf(session))
  ok(res, await TaskService.get(session, scope, req.params.id))
}))

tasksRouter.post('/:id/pause', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.task.read')
  await pauseTask(req.params.id, actorOf(session))
  ok(res, await TaskService.get(session, scope, req.params.id))
}))

tasksRouter.post('/:id/resume', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.task.read')
  await resumeTask(req.params.id, actorOf(session))
  ok(res, await TaskService.get(session, scope, req.params.id))
}))

tasksRouter.post('/:id/complete', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.task.read')
  const b = parse(z.object({ note: z.string().nullable().optional() }), req.body ?? {}, 'Invalid completion note.')
  await completeTask(req.params.id, actorOf(session), b.note)
  ok(res, await TaskService.get(session, scope, req.params.id))
}))

tasksRouter.post('/:id/cancel', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.task.read')
  const b = parse(z.object({ reason: z.string().nullable().optional() }), req.body ?? {}, 'Invalid cancel reason.')
  await cancelTask(req.params.id, actorOf(session), b.reason)
  ok(res, await TaskService.get(session, scope, req.params.id))
}))

tasksRouter.post('/:id/reopen', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.task.read')
  requireManage(session)
  const b = parse(z.object({ reason: z.string().nullable().optional() }), req.body ?? {}, 'Invalid reopen reason.')
  await reopenTask(req.params.id, actorOf(session), b.reason)
  ok(res, await TaskService.get(session, scope, req.params.id))
}))
