import { Router } from 'express'
import { prisma, alive } from '../../lib/prisma.js'
import { handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import {
  clientIdWhere, clientScopeWhere, followUpScopeWhere, leadScopeWhere, requireWorkstation,
} from '../../platform/workstation/scope.js'
import {
  clientDocumentToApi, clientServiceToApi, clientToApi, employeeMap, followUpToApi, leadToApi,
} from '../../api/workstation.serialize.js'

/**
 * WORKSTATION DASHBOARD + GLOBAL SEARCH (§7.1, §8).
 *
 * This is the WORKSTATION overview — a screen inside Workstation. It is not
 * and does not replace the main AUDIT OS dashboard, which still shows exactly
 * HRMS · Workstation · Tools and is untouched by this module.
 *
 * Everything here is scoped by the same helpers the list routes use, so the
 * KPI counts a GST executive sees describe only their own assignments rather
 * than the firm.
 */
export const workstationRouter = Router()

/** IST day boundaries as the UTC instants that bracket them. */
function istDayBounds() {
  const now = new Date()
  const ist = new Date(now.getTime() + 5.5 * 3_600_000)
  const start = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 5.5 * 3_600_000)
  return { now, start, end: new Date(start.getTime() + 86_400_000) }
}

// GET /api/workstation/dashboard
workstationRouter.get('/dashboard', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.access')

  const { now, start, end } = istDayBounds()
  const today = new Date().toISOString().slice(0, 10)
  const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)

  const leadWhere = { ...alive, ...(await leadScopeWhere(session, scope)) }
  const clientWhere = { ...alive, ...(await clientIdWhere(session, scope)) }
  const serviceWhere = { ...alive, ...(await clientScopeWhere(session, scope)) }
  const followWhere = { ...alive, ...(await followUpScopeWhere(session, scope)) }

  const [
    totalLeads, newLeads, activeClients, followUpsToday, pendingFollowUps,
    activeServices, pendingDocuments, servicesDueSoon,
    pipelineRows, todayRows, clientRows,
  ] = await Promise.all([
    prisma.lead.count({ where: leadWhere }),
    prisma.lead.count({ where: { ...leadWhere, status: 'new' } }),
    prisma.client.count({ where: { ...clientWhere, status: 'active' } }),
    prisma.followUp.count({ where: { ...followWhere, scheduledAt: { gte: start, lt: end } } }),
    prisma.followUp.count({ where: { ...followWhere, status: 'pending' } }),
    prisma.clientService.count({
      where: { ...serviceWhere, status: { notIn: ['completed', 'on_hold', 'not_started'] } },
    }),
    prisma.clientDocument.count({ where: { ...serviceWhere, status: { in: ['requested', 'pending'] } } }),
    prisma.clientService.count({
      where: { ...serviceWhere, dueDate: { gte: today, lte: soon }, status: { notIn: ['completed'] } },
    }),
    prisma.lead.groupBy({ by: ['status'], where: leadWhere, _count: { _all: true } }),
    prisma.followUp.findMany({
      where: { ...followWhere, scheduledAt: { gte: start, lt: end } },
      include: { lead: { include: { service: true } }, client: true },
      orderBy: { scheduledAt: 'asc' },
    }),
    prisma.client.findMany({
      where: clientWhere,
      include: {
        services: { where: alive },
        documents: { where: { ...alive, status: { in: ['requested', 'pending'] } }, select: { id: true } },
        followUps: { where: { ...alive, status: 'pending' }, select: { id: true } },
      },
      orderBy: { clientCode: 'asc' },
    }),
  ])

  const stage = (s: string) => pipelineRows.find((r) => r.status === s)?._count._all ?? 0

  const overdueFollowUps = await prisma.followUp.count({
    where: { ...followWhere, status: 'pending', scheduledAt: { lt: now } },
  })

  const m = await employeeMap(todayRows.map((r) => r.assignedEmployeeId))
  const clientMap = await employeeMap(clientRows.map((c) => c.accountManagerId))

  ok(res, {
    scope,
    kpis: {
      total_leads: totalLeads,
      new_leads: newLeads,
      active_clients: activeClients,
      follow_ups_today: followUpsToday,
      pending_follow_ups: pendingFollowUps,
      overdue_follow_ups: overdueFollowUps,
      active_services: activeServices,
      pending_documents: pendingDocuments,
      services_due_soon: servicesDueSoon,
    },
    // §7.1 pipeline, in the fixed stage order — a stage with zero leads still
    // appears, because a pipeline with a missing stage misreads as a bug.
    pipeline: [
      { status: 'new', label: 'New', count: stage('new') },
      { status: 'contacted', label: 'Contacted', count: stage('contacted') },
      { status: 'requirement_identified', label: 'Requirement Identified', count: stage('requirement_identified') },
      { status: 'quote_sent', label: 'Quote Sent', count: stage('quote_sent') },
      { status: 'negotiation', label: 'Negotiation', count: stage('negotiation') },
      { status: 'won', label: 'Won', count: stage('won') },
      { status: 'lost', label: 'Lost', count: stage('lost') },
    ],
    todays_follow_ups: todayRows.map((r) => followUpToApi(r, m)),
    client_summary: {
      new_clients: clientRows.filter((c) => c.status === 'onboarding').length,
      active_clients: clientRows.filter((c) => c.status === 'active').length,
      pending_documents: clientRows.filter((c) => c.documents.length > 0).length,
      services_due: clientRows.filter((c) =>
        c.services.some((s) => s.dueDate && s.dueDate <= soon && s.status !== 'completed')).length,
      requiring_follow_up: clientRows.filter((c) => c.followUps.length > 0).length,
      items: clientRows.slice(0, 12).map((c) => ({
        ...clientToApi(c, clientMap),
        pending_document_count: c.documents.length,
        pending_follow_up_count: c.followUps.length,
      })),
    },
  })
}))

/**
 * GET /api/workstation/search?q= — §8.
 *
 * Scoped BEFORE results leave the server: searching a client you are not
 * assigned to returns nothing from that client, in any group, rather than
 * returning it and hoping the UI hides it.
 */
workstationRouter.get('/search', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.access')
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''

  if (q.length < 2) {
    ok(res, { query: q, leads: [], clients: [], services: [], follow_ups: [], documents: [], total: 0 })
    return
  }

  const [leads, clients, services, followUps, documents] = await Promise.all([
    prisma.lead.findMany({
      where: {
        ...alive, ...(await leadScopeWhere(session, scope)),
        OR: [{ name: { contains: q } }, { leadCode: { contains: q } }, { contactNumber: { contains: q } }],
      },
      include: { service: true }, take: 10,
    }),
    prisma.client.findMany({
      where: {
        ...alive, ...(await clientIdWhere(session, scope)),
        OR: [
          { companyName: { contains: q } }, { clientCode: { contains: q } },
          { gstin: { contains: q } }, { contactPerson: { contains: q } }, { contactNumber: { contains: q } },
        ],
      },
      take: 10,
    }),
    prisma.clientService.findMany({
      where: {
        ...alive, ...(await clientScopeWhere(session, scope)),
        OR: [{ service: { name: { contains: q } } }, { client: { companyName: { contains: q } } }],
      },
      include: { service: true, client: true }, take: 10,
    }),
    prisma.followUp.findMany({
      where: {
        ...alive, ...(await followUpScopeWhere(session, scope)),
        OR: [
          { title: { contains: q } },
          { client: { companyName: { contains: q } } },
          { lead: { name: { contains: q } } },
        ],
      },
      include: { lead: { include: { service: true } }, client: true }, take: 10,
    }),
    prisma.clientDocument.findMany({
      where: {
        ...alive, ...(await clientScopeWhere(session, scope)),
        OR: [{ name: { contains: q } }, { client: { companyName: { contains: q } } }],
      },
      include: { category: true, client: true, versions: true }, take: 10,
    }),
  ])

  const m = await employeeMap([
    ...leads.map((r) => r.assignedEmployeeId),
    ...clients.map((r) => r.accountManagerId),
    ...services.flatMap((r) => [r.assignedEmployeeId, r.managerId]),
    ...followUps.map((r) => r.assignedEmployeeId),
    ...documents.flatMap((r) => [r.requestedByEmployeeId, r.verifiedByEmployeeId]),
  ])

  ok(res, {
    query: q,
    leads: leads.map((r) => leadToApi(r, m)),
    clients: clients.map((r) => clientToApi(r, m)),
    services: services.map((r) => clientServiceToApi(r, m)),
    follow_ups: followUps.map((r) => followUpToApi(r, m)),
    documents: documents.map((r) => clientDocumentToApi(r, m)),
    total: leads.length + clients.length + services.length + followUps.length + documents.length,
  })
}))

/**
 * GET /api/workstation/assignable-employees
 *
 * The employee picker for every "Assign to" control. It reads the HRMS
 * Employee table directly — there is no second employee store — and returns
 * only the display triple, never salary, bank or contact data.
 */
workstationRouter.get('/assignable-employees', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.access')

  const rows = await prisma.employee.findMany({
    where: { ...alive, status: { not: 'inactive' } },
    select: { id: true, fullName: true, employeeCode: true, designation: { select: { name: true } } },
    orderBy: { employeeCode: 'asc' },
  })
  ok(res, {
    items: rows.map((e) => ({
      id: e.id,
      full_name: e.fullName,
      employee_code: e.employeeCode,
      designation: e.designation.name,
    })),
    count: rows.length,
  })
}))
