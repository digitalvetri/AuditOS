import { Router } from 'express'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { notifyEmployee } from '../../platform/notify.js'
import { writeActivity } from '../../platform/workstation/activity.js'
import {
  assertCanSeeClient, assertCanSeeLead, followUpScopeWhere, requireWorkstation,
} from '../../platform/workstation/scope.js'
import { employeeMap, followUpToApi } from '../../api/workstation.serialize.js'
import { body, FieldErrors, FOLLOWUP_STATUSES, FOLLOWUP_TYPES } from './validate.js'

/**
 * FOLLOW-UPS (AUDIT_OS_WORKSTATION.md §7.5).
 *
 * ONE entity for leads AND clients (§3). `leadId` and `clientId` are both
 * nullable and exactly one must be set — the XOR is enforced here on every
 * write, because a follow-up attached to both or neither is unrenderable.
 */
export const followUpsRouter = Router()

const include = { lead: { include: { service: true } }, client: true } as const

// GET /api/follow-ups
followUpsRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.followup.read', 'workstation.followup.manage')

  const range = typeof req.query.range === 'string' ? req.query.range : null
  const status = typeof req.query.status === 'string' ? req.query.status : null
  const employeeId = typeof req.query.employee_id === 'string' ? req.query.employee_id : null
  const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : null
  const leadId = typeof req.query.lead_id === 'string' ? req.query.lead_id : null

  // IST day boundaries, expressed as the UTC instants that bracket them.
  const now = new Date()
  const istNow = new Date(now.getTime() + 5.5 * 3_600_000)
  const dayStart = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()) - 5.5 * 3_600_000)
  const dayEnd = new Date(dayStart.getTime() + 86_400_000)

  const rangeWhere =
    range === 'today' ? { scheduledAt: { gte: dayStart, lt: dayEnd } }
    : range === 'upcoming' ? { scheduledAt: { gte: dayEnd } }
    // Overdue means "past and still open" — a completed follow-up from last
    // week is history, not a task.
    : range === 'overdue' ? { scheduledAt: { lt: now }, status: 'pending' }
    : {}

  const rows = await prisma.followUp.findMany({
    where: {
      ...alive,
      ...(await followUpScopeWhere(session, scope)),
      ...rangeWhere,
      ...(status ? { status } : {}),
      ...(employeeId ? { assignedEmployeeId: employeeId } : {}),
      ...(clientId ? { clientId } : {}),
      ...(leadId ? { leadId } : {}),
    },
    include,
    orderBy: { scheduledAt: 'asc' },
  })

  const m = await employeeMap(rows.flatMap((r) => [r.assignedEmployeeId, r.completedByEmployeeId]))
  ok(res, { items: rows.map((r) => followUpToApi(r, m)), count: rows.length, scope })
}))

// POST /api/follow-ups
followUpsRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.followup.manage')
  const b = body(req)

  const v = new FieldErrors()
  const title = v.str('title', b.title, { max: 200 })
  const type = v.oneOf('type', b.type, FOLLOWUP_TYPES)
  const scheduledAt = v.datetime('scheduled_at', b.scheduled_at)
  const assignedEmployeeId = v.str('assigned_employee_id', b.assigned_employee_id)
  const notes = v.str('notes', b.notes, { required: false, max: 2000 })
  const leadId = v.str('lead_id', b.lead_id, { required: false })
  const clientId = v.str('client_id', b.client_id, { required: false })

  // The XOR (§3). Both or neither is a client bug, reported as a field error.
  if (!leadId && !clientId) {
    v.add('client_id', 'Choose a lead or a client for this follow-up.')
  } else if (leadId && clientId) {
    v.add('client_id', 'A follow-up belongs to a lead or a client, never both.')
  }
  v.throwIfAny()

  // Whichever side it hangs off, the caller must be able to see it.
  if (leadId) await assertCanSeeLead(session, scope, leadId)
  if (clientId) await assertCanSeeClient(session, scope, clientId)

  const row = await prisma.followUp.create({
    data: {
      organisationId: 'org-audit-os',
      leadId: leadId ?? null,
      clientId: clientId ?? null,
      title: title!,
      type: type!,
      scheduledAt: scheduledAt!,
      assignedEmployeeId: assignedEmployeeId!,
      status: 'pending',
      notes: notes ?? null,
      reminderMinutesBefore: typeof b.reminder_minutes_before === 'number' ? b.reminder_minutes_before : 30,
      createdBy: session.userId,
      updatedBy: session.userId,
    },
    include,
  })

  await writeActivity({
    session,
    subjectType: leadId ? 'lead' : 'client',
    subjectId: (leadId ?? clientId)!,
    action: 'followup.created',
    description: `Follow-up scheduled — ${row.title}.`,
    entityType: 'FollowUp', entityId: row.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'follow_up.create',
    entityType: 'FollowUp', entityId: row.id, after: row, req,
  })
  if (assignedEmployeeId !== session.employeeId) {
    await notifyEmployee(assignedEmployeeId!, {
      type: 'followup.assigned', module: 'system',
      title: 'Follow-up assigned',
      body: row.title,
      entityType: 'FollowUp', entityId: row.id,
      actionUrl: '/workstation/follow-ups',
    })
  }

  const m = await employeeMap([row.assignedEmployeeId])
  ok(res, followUpToApi(row, m), 201)
}))

// PATCH /api/follow-ups/:id
followUpsRouter.patch('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.followup.manage')
  const b = body(req)

  const before = await prisma.followUp.findFirst({ where: { id: req.params.id, ...alive }, include })
  if (!before) throw ApiError.notFound('Follow-up not found.')
  if (before.leadId) await assertCanSeeLead(session, scope, before.leadId)
  if (before.clientId) await assertCanSeeClient(session, scope, before.clientId)

  const v = new FieldErrors()
  const data: Record<string, unknown> = {}
  if ('title' in b) data.title = v.str('title', b.title, { max: 200 })
  if ('type' in b) data.type = v.oneOf('type', b.type, FOLLOWUP_TYPES)
  if ('scheduled_at' in b) data.scheduledAt = v.datetime('scheduled_at', b.scheduled_at)
  if ('assigned_employee_id' in b) data.assignedEmployeeId = v.str('assigned_employee_id', b.assigned_employee_id)
  if ('status' in b) data.status = v.oneOf('status', b.status, FOLLOWUP_STATUSES)
  if ('notes' in b) data.notes = v.str('notes', b.notes, { required: false, max: 2000 }) ?? null
  v.throwIfAny()
  data.updatedBy = session.userId

  const row = await prisma.followUp.update({ where: { id: before.id }, data, include })

  await writeActivity({
    session,
    subjectType: row.leadId ? 'lead' : 'client',
    subjectId: (row.leadId ?? row.clientId)!,
    action: data.scheduledAt ? 'followup.rescheduled' : 'followup.updated',
    description: data.scheduledAt ? `Follow-up rescheduled — ${row.title}.` : `Follow-up updated — ${row.title}.`,
    entityType: 'FollowUp', entityId: row.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'follow_up.update',
    entityType: 'FollowUp', entityId: row.id, before, after: row, req,
  })

  const m = await employeeMap([row.assignedEmployeeId, row.completedByEmployeeId])
  ok(res, followUpToApi(row, m))
}))

// POST /api/follow-ups/:id/complete
followUpsRouter.post('/:id/complete', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.followup.manage')
  const b = body(req)

  const before = await prisma.followUp.findFirst({ where: { id: req.params.id, ...alive }, include })
  if (!before) throw ApiError.notFound('Follow-up not found.')
  if (before.leadId) await assertCanSeeLead(session, scope, before.leadId)
  if (before.clientId) await assertCanSeeClient(session, scope, before.clientId)
  if (before.status === 'completed') {
    throw ApiError.conflict('already_completed', 'This follow-up is already marked completed.')
  }

  const v = new FieldErrors()
  const completionNotes = v.str('completion_notes', b.completion_notes, { required: false, max: 2000 })
  v.throwIfAny()

  const row = await prisma.followUp.update({
    where: { id: before.id },
    data: {
      status: 'completed',
      completedByEmployeeId: session.employeeId,
      completedAt: new Date(),
      completionNotes: completionNotes ?? null,
      updatedBy: session.userId,
    },
    include,
  })

  await writeActivity({
    session,
    subjectType: row.leadId ? 'lead' : 'client',
    subjectId: (row.leadId ?? row.clientId)!,
    action: 'followup.completed',
    description: `Follow-up completed — ${row.title}.${completionNotes ? ` ${completionNotes}` : ''}`,
    entityType: 'FollowUp', entityId: row.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'follow_up.complete',
    entityType: 'FollowUp', entityId: row.id, before, after: row, req,
  })

  const m = await employeeMap([row.assignedEmployeeId, row.completedByEmployeeId])
  ok(res, followUpToApi(row, m))
}))
