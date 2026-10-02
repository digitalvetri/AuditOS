import { Router } from 'express'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { notifyEmployee } from '../../platform/notify.js'
import { writeActivity } from '../../platform/workstation/activity.js'
import { nextClientCode, nextLeadCode } from '../../platform/workstation/codes.js'
import {
  assertCanSeeLead, leadScopeWhere, requireWorkstation,
} from '../../platform/workstation/scope.js'
import { activityToApi, clientToApi, employeeMap, leadToApi } from '../../api/workstation.serialize.js'
import { assertLeadTransition, body, FieldErrors, LEAD_STATUSES } from './validate.js'

/**
 * LEADS (AUDIT_OS_WORKSTATION.md §7.2).
 *
 * Pipeline on every route: authenticate (mounted in app.ts) → authorize →
 * validate → handle → activity/audit.
 *
 * The rule this module exists to protect: a lead is never deleted, and
 * converting one produces exactly one client, exactly once.
 */
export const leadsRouter = Router()

const leadInclude = { service: true } as const

// GET /api/leads
leadsRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.lead.read', 'workstation.lead.manage')

  const status = typeof req.query.status === 'string' ? req.query.status : null
  const serviceId = typeof req.query.service_id === 'string' ? req.query.service_id : null
  const employeeId = typeof req.query.employee_id === 'string' ? req.query.employee_id : null
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''

  const where = {
    ...alive,
    ...(await leadScopeWhere(session, scope)),
    ...(status ? { status } : {}),
    ...(serviceId ? { serviceId } : {}),
    ...(employeeId ? { assignedEmployeeId: employeeId } : {}),
    ...(q ? { OR: [{ name: { contains: q } }, { leadCode: { contains: q } }, { contactNumber: { contains: q } }] } : {}),
  }

  const rows = await prisma.lead.findMany({ where, include: leadInclude, orderBy: { createdAt: 'desc' } })
  const m = await employeeMap(rows.map((r) => r.assignedEmployeeId))
  ok(res, { items: rows.map((r) => leadToApi(r, m)), count: rows.length, scope })
}))

// GET /api/leads/:id
leadsRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.lead.read', 'workstation.lead.manage')
  await assertCanSeeLead(session, scope, req.params.id)

  const lead = await prisma.lead.findFirst({ where: { id: req.params.id, ...alive }, include: leadInclude })
  if (!lead) throw ApiError.notFound('Lead not found.')
  const m = await employeeMap([lead.assignedEmployeeId])
  ok(res, leadToApi(lead, m))
}))

// GET /api/leads/:id/activity
leadsRouter.get('/:id/activity', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.lead.read', 'workstation.lead.manage')
  await assertCanSeeLead(session, scope, req.params.id)

  const rows = await prisma.activity.findMany({
    where: { subjectType: 'lead', subjectId: req.params.id },
    orderBy: { createdAt: 'desc' },
  })
  const m = await employeeMap(rows.map((r) => r.actorEmployeeId))
  ok(res, { items: rows.map((r) => activityToApi(r, m)), count: rows.length })
}))

// POST /api/leads
leadsRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.lead.manage')
  const b = body(req)

  const v = new FieldErrors()
  const name = v.str('name', b.name, { max: 120 })
  const contactNumber = v.phone('contact_number', b.contact_number)
  const serviceId = v.str('service_id', b.service_id)
  const priceQuotedPaise = v.rupeesToPaise('price_quoted', b.price_quoted)
  const assignedEmployeeId = v.str('assigned_employee_id', b.assigned_employee_id)
  const email = v.email('email', b.email, false)
  const notes = v.str('notes', b.notes, { required: false, max: 2000 })
  v.throwIfAny()

  // Referential checks produce field-level messages too, not a 500.
  const [service, employee] = await Promise.all([
    prisma.service.findFirst({ where: { id: serviceId!, ...alive } }),
    prisma.employee.findFirst({ where: { id: assignedEmployeeId!, ...alive } }),
  ])
  if (!service) v.add('service_id', 'Select a valid service.')
  if (!employee) v.add('assigned_employee_id', 'Select a valid employee.')
  v.throwIfAny()

  /* created_at / created_time are SYSTEM-GENERATED (§5.2). Anything the
     caller sent for them is discarded here rather than trusted. */
  const lead = await prisma.$transaction(async (tx) => {
    const leadCode = await nextLeadCode(tx)
    return tx.lead.create({
      data: {
        organisationId: 'org-audit-os',
        leadCode,
        name: name!,
        contactNumber: contactNumber!,
        email: email ?? null,
        serviceId: serviceId!,
        priceQuotedPaise: priceQuotedPaise ?? 0,
        assignedEmployeeId: assignedEmployeeId!,
        status: 'new',
        notes: notes ?? null,
        createdBy: session.userId,
        updatedBy: session.userId,
      },
      include: leadInclude,
    })
  })

  await writeActivity({
    session, subjectType: 'lead', subjectId: lead.id,
    action: 'lead.created',
    description: `Lead ${lead.leadCode} created for ${lead.name}.`,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'lead.create',
    entityType: 'Lead', entityId: lead.id, after: lead, req,
  })
  if (assignedEmployeeId !== session.employeeId) {
    await notifyEmployee(assignedEmployeeId!, {
      type: 'lead.assigned', module: 'system',
      title: 'New lead assigned',
      body: `${lead.name} · ${service!.name}`,
      entityType: 'Lead', entityId: lead.id,
      actionUrl: `/workstation/leads/${lead.id}`,
    })
  }

  const m = await employeeMap([lead.assignedEmployeeId])
  ok(res, leadToApi(lead, m), 201)
}))

// PATCH /api/leads/:id
leadsRouter.patch('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.lead.manage')
  await assertCanSeeLead(session, scope, req.params.id)
  const b = body(req)

  const before = await prisma.lead.findFirst({ where: { id: req.params.id, ...alive } })
  if (!before) throw ApiError.notFound('Lead not found.')

  const v = new FieldErrors()
  const data: Record<string, unknown> = {}

  if ('name' in b) data.name = v.str('name', b.name, { max: 120 })
  if ('contact_number' in b) data.contactNumber = v.phone('contact_number', b.contact_number)
  if ('email' in b) data.email = v.email('email', b.email, false) ?? null
  if ('service_id' in b) data.serviceId = v.str('service_id', b.service_id)
  if ('price_quoted' in b) data.priceQuotedPaise = v.rupeesToPaise('price_quoted', b.price_quoted)
  if ('assigned_employee_id' in b) data.assignedEmployeeId = v.str('assigned_employee_id', b.assigned_employee_id)
  if ('notes' in b) data.notes = v.str('notes', b.notes, { required: false, max: 2000 }) ?? null
  if ('lost_reason' in b) data.lostReason = v.str('lost_reason', b.lost_reason, { required: false, max: 500 }) ?? null

  const nextStatus = 'status' in b ? v.oneOf('status', b.status, LEAD_STATUSES) : undefined
  v.throwIfAny()

  if (nextStatus && nextStatus !== before.status) {
    // A won lead is closed by conversion, not by editing it back open.
    if (before.convertedClientId) {
      throw ApiError.conflict('already_converted', 'This lead has been converted; its status can no longer change.')
    }
    assertLeadTransition(before.status, nextStatus)
    data.status = nextStatus
  }

  data.updatedBy = session.userId

  const lead = await prisma.lead.update({
    where: { id: before.id }, data, include: leadInclude,
  })

  if (nextStatus && nextStatus !== before.status) {
    await writeActivity({
      session, subjectType: 'lead', subjectId: lead.id,
      action: nextStatus === 'lost' ? 'lead.lost' : `lead.${nextStatus}`,
      description: nextStatus === 'lost'
        ? `Lead marked lost. ${lead.lostReason ?? ''}`.trim()
        : `Status changed from ${before.status.replace(/_/g, ' ')} to ${nextStatus.replace(/_/g, ' ')}.`,
    })
  }
  if (data.assignedEmployeeId && data.assignedEmployeeId !== before.assignedEmployeeId) {
    await writeActivity({
      session, subjectType: 'lead', subjectId: lead.id,
      action: 'lead.reassigned', description: 'Lead reassigned.',
    })
  }
  if (!nextStatus && !data.assignedEmployeeId) {
    await writeActivity({
      session, subjectType: 'lead', subjectId: lead.id,
      action: 'lead.updated', description: 'Lead details updated.',
    })
  }
  await writeAudit({
    actorUserId: session.userId, action: 'lead.update',
    entityType: 'Lead', entityId: lead.id, before, after: lead, req,
  })

  const m = await employeeMap([lead.assignedEmployeeId])
  ok(res, leadToApi(lead, m))
}))

// POST /api/leads/:id/convert  — THE core workflow (§7.2)
leadsRouter.post('/:id/convert', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.lead.convert')
  await assertCanSeeLead(session, scope, req.params.id)
  const b = body(req)

  const v = new FieldErrors()
  const companyName = v.str('company_name', b.company_name, { max: 200 })
  const contactPerson = v.str('contact_person', b.contact_person, { max: 120 })
  const contactNumber = v.phone('contact_number', b.contact_number)
  const email = v.email('email', b.email, false)
  const gstin = 'gstin' in b && b.gstin ? v.gstin('gstin', b.gstin) : undefined
  const pan = 'pan' in b && b.pan ? v.pan('pan', b.pan) : undefined
  const accountManagerId = v.str('account_manager_id', b.account_manager_id)
  const dueDate = v.date('due_date', b.due_date, false)
  v.throwIfAny()

  /* One transaction. Lead.convertedClientId is @unique, so even a double
     submit that races past the status check cannot create a second client —
     the database refuses the second write. */
  const result = await prisma.$transaction(async (tx) => {
    const lead = await tx.lead.findFirst({ where: { id: req.params.id, deletedAt: null } })
    if (!lead) throw ApiError.notFound('Lead not found.')
    if (lead.convertedClientId) {
      throw ApiError.conflict('already_converted', 'This lead has already been converted to a client.')
    }
    if (lead.status !== 'won') {
      throw ApiError.unprocessable(
        'lead_not_won',
        'Only a lead marked Won can be converted. Change the status to Won first.',
        { status: lead.status },
      )
    }

    const clientCode = await nextClientCode(tx)
    const today = new Date().toISOString().slice(0, 10)

    const client = await tx.client.create({
      data: {
        organisationId: 'org-audit-os',
        clientCode,
        companyName: companyName!,
        legalName: companyName!,
        contactPerson: contactPerson!,
        contactNumber: contactNumber!,
        email: email ?? null,
        gstin: gstin ?? null,
        pan: pan ?? null,
        accountManagerId: accountManagerId!,
        status: 'onboarding',
        onboardingDate: today,
        sourceLeadId: lead.id,
        createdBy: session.userId,
        updatedBy: session.userId,
      },
    })

    await tx.clientContact.create({
      data: {
        clientId: client.id, name: contactPerson!, designation: 'Primary contact',
        phone: contactNumber!, email: email ?? null, isPrimary: true,
        createdBy: session.userId,
      },
    })

    // The lead's own service becomes the client's first engagement.
    const clientService = await tx.clientService.create({
      data: {
        clientId: client.id,
        serviceId: lead.serviceId,
        assignedEmployeeId: lead.assignedEmployeeId,
        managerId: accountManagerId!,
        dueDate: dueDate ?? null,
        status: 'not_started',
        createdBy: session.userId,
      },
    })

    // The lead is PRESERVED — only the back-link and timestamp are set.
    const updatedLead = await tx.lead.update({
      where: { id: lead.id },
      data: { convertedClientId: client.id, convertedAt: new Date(), updatedBy: session.userId },
    })

    return { client, lead: updatedLead, clientService }
  })

  await writeActivity({
    session, subjectType: 'lead', subjectId: result.lead.id,
    action: 'lead.converted',
    description: `Lead converted to client ${result.client.clientCode} — ${result.client.companyName}.`,
    entityType: 'Client', entityId: result.client.id,
  })
  await writeActivity({
    session, subjectType: 'client', subjectId: result.client.id,
    action: 'client.created',
    description: `Client created from lead ${result.lead.leadCode}.`,
    entityType: 'Lead', entityId: result.lead.id,
  })
  await writeActivity({
    session, subjectType: 'client', subjectId: result.client.id,
    action: 'client.service_assigned',
    description: 'Initial service assigned from the lead.',
    entityType: 'ClientService', entityId: result.clientService.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'lead.convert',
    entityType: 'Lead', entityId: result.lead.id,
    before: { converted_client_id: null }, after: { converted_client_id: result.client.id }, req,
  })
  await notifyEmployee(result.client.accountManagerId, {
    type: 'client.created', module: 'system',
    title: 'New client created',
    body: `${result.client.clientCode} · ${result.client.companyName}`,
    entityType: 'Client', entityId: result.client.id,
    actionUrl: `/workstation/clients/${result.client.id}`,
  })

  const m = await employeeMap([result.client.accountManagerId])
  ok(res, { client: clientToApi(result.client, m), lead_id: result.lead.id }, 201)
}))
