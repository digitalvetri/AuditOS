import { Router } from 'express'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { notifyEmployee } from '../../platform/notify.js'
import { writeActivity } from '../../platform/workstation/activity.js'
import {
  assertCanSeeClient, clientScopeWhere, requireWorkstation,
} from '../../platform/workstation/scope.js'
import { clientServiceToApi, employeeMap, serviceToApi } from '../../api/workstation.serialize.js'
import { body, FieldErrors, SERVICE_STATUSES } from './validate.js'

/**
 * SERVICES (AUDIT_OS_WORKSTATION.md §7.4).
 *
 * `/api/services` is the cross-client work list. `/api/service-catalog` is the
 * configurable list of things the firm sells — two different nouns, kept apart
 * so nobody assigns a catalog row to an employee by accident.
 */
export const servicesRouter = Router()
export const serviceCatalogRouter = Router()

// GET /api/service-catalog
serviceCatalogRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.access')
  const rows = await prisma.service.findMany({ where: { ...alive, isActive: true }, orderBy: { sortOrder: 'asc' } })
  ok(res, { items: rows.map(serviceToApi), count: rows.length })
}))

// GET /api/services — every client service the caller may see
servicesRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.service.read', 'workstation.service.manage')

  const status = typeof req.query.status === 'string' ? req.query.status : null
  const serviceId = typeof req.query.service_id === 'string' ? req.query.service_id : null
  const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : null
  const employeeId = typeof req.query.employee_id === 'string' ? req.query.employee_id : null
  const due = typeof req.query.due === 'string' ? req.query.due : null

  const today = new Date().toISOString().slice(0, 10)
  const inSevenDays = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)

  const rows = await prisma.clientService.findMany({
    where: {
      ...alive,
      ...(await clientScopeWhere(session, scope)),
      ...(status ? { status } : {}),
      ...(serviceId ? { serviceId } : {}),
      ...(clientId ? { clientId } : {}),
      ...(employeeId ? { OR: [{ assignedEmployeeId: employeeId }, { managerId: employeeId }] } : {}),
      // "Overdue" excludes work that is already finished — a completed
      // service with a past due date is not a problem to chase.
      ...(due === 'overdue'
        ? { dueDate: { lt: today }, status: { notIn: ['completed', 'on_hold'] } }
        : {}),
      ...(due === 'soon' ? { dueDate: { gte: today, lte: inSevenDays } } : {}),
    },
    include: { service: true, client: true },
    orderBy: [{ dueDate: 'asc' }],
  })

  const m = await employeeMap(rows.flatMap((r) => [r.assignedEmployeeId, r.managerId]))
  ok(res, { items: rows.map((r) => clientServiceToApi(r, m)), count: rows.length, scope })
}))

/**
 * PATCH /api/services/:id — the service lifecycle (§7.4).
 *
 * Reaching `completed` also updates the parent client's status, in the same
 * transaction, so "Client Status Updated" is a consequence of the work
 * finishing rather than a separate chore someone has to remember.
 */
servicesRouter.patch('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.service.manage')
  const b = body(req)

  const before = await prisma.clientService.findFirst({
    where: { id: req.params.id, ...alive },
    include: { service: true, client: true },
  })
  if (!before) throw ApiError.notFound('Service not found.')
  await assertCanSeeClient(session, scope, before.clientId)

  const v = new FieldErrors()
  const data: Record<string, unknown> = {}
  if ('assigned_employee_id' in b) data.assignedEmployeeId = v.str('assigned_employee_id', b.assigned_employee_id)
  if ('manager_id' in b) data.managerId = v.str('manager_id', b.manager_id, { required: false }) ?? null
  if ('due_date' in b) data.dueDate = v.date('due_date', b.due_date, false) ?? null
  if ('notes' in b) data.notes = v.str('notes', b.notes, { required: false, max: 2000 }) ?? null
  const nextStatus = 'status' in b ? v.oneOf('status', b.status, SERVICE_STATUSES) : undefined
  v.throwIfAny()

  if (nextStatus && nextStatus !== before.status) {
    data.status = nextStatus
    if (nextStatus !== 'not_started' && !before.startedAt) data.startedAt = new Date()
    data.completedAt = nextStatus === 'completed' ? new Date() : null
  }
  data.updatedBy = session.userId

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.clientService.update({
      where: { id: before.id }, data, include: { service: true, client: true },
    })

    if (nextStatus === 'completed') {
      // Does the client still have open work? If not, they are simply Active.
      const open = await tx.clientService.count({
        where: { clientId: updated.clientId, deletedAt: null, status: { notIn: ['completed'] } },
      })
      const pendingDocs = await tx.clientDocument.count({
        where: { clientId: updated.clientId, deletedAt: null, status: { in: ['requested', 'pending'] } },
      })
      const nextClientStatus = pendingDocs > 0 ? 'pending_documents' : open > 0 ? 'active' : 'active'
      if (updated.client.status !== nextClientStatus) {
        await tx.client.update({ where: { id: updated.clientId }, data: { status: nextClientStatus } })
      }
    }
    return updated
  })

  if (nextStatus && nextStatus !== before.status) {
    await writeActivity({
      session, subjectType: 'client', subjectId: row.clientId,
      action: `service.${nextStatus}`,
      description: `${row.service.name}: ${before.status.replace(/_/g, ' ')} → ${nextStatus.replace(/_/g, ' ')}.`,
      entityType: 'ClientService', entityId: row.id,
    })
  }
  if (data.assignedEmployeeId && data.assignedEmployeeId !== before.assignedEmployeeId) {
    await writeActivity({
      session, subjectType: 'client', subjectId: row.clientId,
      action: 'service.reassigned',
      description: `${row.service.name} reassigned.`,
      entityType: 'ClientService', entityId: row.id,
    })
    await notifyEmployee(String(data.assignedEmployeeId), {
      type: 'service.assigned', module: 'system',
      title: 'Service assigned',
      body: `${row.service.name} · ${row.client.companyName}`,
      entityType: 'ClientService', entityId: row.id,
      actionUrl: `/workstation/clients/${row.clientId}/services`,
    })
  }
  await writeAudit({
    actorUserId: session.userId, action: 'client_service.update',
    entityType: 'ClientService', entityId: row.id, before, after: row, req,
  })

  const m = await employeeMap([row.assignedEmployeeId, row.managerId])
  ok(res, clientServiceToApi(row, m))
}))
