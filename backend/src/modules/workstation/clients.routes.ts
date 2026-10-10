import { Router } from 'express'
import { CIN_RE, LLPIN_RE } from '../gst/validate.js'
import { prisma, alive } from '../../lib/prisma.js'
import { lockSequence, maxSuffix } from '../../lib/sequence.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { notifyEmployee } from '../../platform/notify.js'
import { writeActivity } from '../../platform/workstation/activity.js'
import {
  assertCanSeeClient, assignedClientIds, clientIdWhere, requireWorkstation, seesAllClients,
} from '../../platform/workstation/scope.js'
import { assertCanJoinOrganization, deriveShortName } from '../../platform/workstation/organization.js'
import {
  activityToApi, clientContactToApi, clientDocumentToApi, clientServiceToApi,
  clientToApi, employeeMap, ewayBillToApi, gstFilingToApi, gstProfileToApi, ORGANIZATION_REF, taskToApi,
} from '../../api/workstation.serialize.js'
import {
  body, CLIENT_STATUSES, DOCUMENT_STATUSES, FieldErrors, SERVICE_STATUSES,
} from './validate.js'
import { clientListWhere, clientOrderBy, createClientRow, readClientFields } from './clients.shared.js'

/**
 * CLIENTS (AUDIT_OS_WORKSTATION.md §7.3) — the central workspace.
 *
 * Every nested route re-checks `assertCanSeeClient` rather than trusting that
 * the parent route already did: these are independently addressable URLs, and
 * "the list filtered it out" is not an access control.
 */
export const clientsRouter = Router()

// GET /api/clients
clientsRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.client.read', 'workstation.client.manage')

  const query = req.query as Record<string, unknown>
  const where = await clientListWhere(session, scope, query)

  // Pagination is opt-in: without page/page_size the whole list comes back
  // exactly as before (the pickers and older screens rely on that).
  const paged = query.page !== undefined || query.page_size !== undefined
  const pageSize = Math.min(Math.max(Number(query.page_size) || 50, 1), 200)
  const page = Math.max(Number(query.page) || 1, 1)

  const [rows, total] = await Promise.all([
    prisma.client.findMany({
      where,
      include: {
        parentClient: { select: ORGANIZATION_REF },
        _count: { select: { documents: { where: { deletedAt: null } }, childClients: { where: { deletedAt: null } } } },
        services: { where: alive, include: { service: true } },
      },
      orderBy: clientOrderBy(query),
      ...(paged ? { skip: (page - 1) * pageSize, take: pageSize } : {}),
    }),
    paged ? prisma.client.count({ where }) : Promise.resolve(-1),
  ])

  // facets=1 — the saved-view counts (every client the caller may see, no
  // filters), so the list page does not fetch the whole list to count it.
  let facets: Record<string, unknown> | undefined
  if (query.facets === '1' || query.facets === 'true') {
    const base = { ...alive, ...(await clientIdWhere(session, scope)) }
    const me = session.employeeId
    const [byStatus, organizations, mine] = await Promise.all([
      prisma.client.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
      prisma.client.count({ where: { ...base, isOrganization: true } }),
      me ? prisma.client.count({ where: { ...base, OR: [{ accountManagerId: me }, { secondaryManagerId: me }] } }) : Promise.resolve(0),
    ])
    facets = {
      total: byStatus.reduce((s, r) => s + r._count._all, 0),
      by_status: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      organizations,
      mine,
    }
  }

  const m = await employeeMap(rows.flatMap((r) => [r.accountManagerId, r.secondaryManagerId]))
  ok(res, {
    items: rows.map((r) => ({
      ...clientToApi(r, m),
      service_names: r.services.map((s) => s.service.name),
      document_count: r._count.documents,
      // All children, not only visible ones: a count alone reveals no client.
      child_client_count: r.isOrganization ? r._count.childClients : 0,
    })),
    // `count` stays "how many match", paged or not.
    count: paged ? total : rows.length,
    ...(paged ? { page, page_size: pageSize } : {}),
    ...(facets ? { facets } : {}),
    scope,
  })
}))

// POST /api/clients — direct creation (a client that never was a lead)
clientsRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.client.manage')
  const b = body(req)

  const v = new FieldErrors()
  const f = readClientFields(v, b)
  const { accountManagerId, secondaryManagerId, organizationId, isOrganization } = f
  v.throwIfAny()

  const manager = await prisma.employee.findFirst({ where: { id: accountManagerId, ...alive } })
  if (!manager) v.add('account_manager_id', 'Select a valid employee.')
  if (secondaryManagerId && !(await prisma.employee.findFirst({ where: { id: secondaryManagerId, ...alive } }))) {
    v.add('secondary_manager_id', 'Select a valid employee.')
  }
  // Staff who see only their assigned clients must stay on a client they create.
  if (!seesAllClients(session) && session.employeeId && ![accountManagerId, secondaryManagerId].includes(session.employeeId)) {
    v.add('account_manager_id', 'Assign yourself as account manager or second staff, or the client will not be visible to you.')
  }
  v.throwIfAny()
  const org = organizationId ? await assertCanJoinOrganization(session, scope, organizationId) : null

  const client = await prisma.$transaction((tx) => createClientRow(tx, { ...f, organizationId: org?.id ?? null }, session.userId))

  await writeActivity({
    session, subjectType: 'client', subjectId: client.id,
    action: 'client.created',
    description: org
      ? `Client ${client.clientCode} created under organization ${org.companyName}.`
      : isOrganization ? `Organization client ${client.clientCode} created.` : `Client ${client.clientCode} created.`,
  })
  if (org) {
    await writeActivity({
      session, subjectType: 'client', subjectId: org.id,
      action: 'organization.client_added',
      description: `${client.companyName} (${client.clientCode}) added to the organization.`,
      entityType: 'Client', entityId: client.id,
    })
  }
  await writeAudit({
    actorUserId: session.userId, action: 'client.create',
    entityType: 'Client', entityId: client.id, after: client, req,
  })

  for (const staff of [client.accountManagerId, client.secondaryManagerId]) {
    if (staff && staff !== session.employeeId) {
      await notifyEmployee(staff, {
        type: 'client.assigned', module: 'system',
        title: staff === client.accountManagerId ? 'Client assigned to you' : 'Client assigned to you as second staff',
        body: `${client.clientCode} · ${client.companyName}`,
        entityType: 'Client', entityId: client.id, actionUrl: `/workstation/clients/${client.id}`,
      })
    }
  }

  const m = await employeeMap([client.accountManagerId, client.secondaryManagerId])
  ok(res, clientToApi(client, m), 201)
}))

// GET /api/clients/:id
clientsRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.client.read', 'workstation.client.manage')
  await assertCanSeeClient(session, scope, req.params.id)

  const client = await prisma.client.findFirst({
    where: { id: req.params.id, ...alive },
    include: {
      contacts: { where: alive },
      parentClient: { select: ORGANIZATION_REF },
      _count: { select: { documents: { where: alive }, followUps: { where: alive } } },
    },
  })
  if (!client) throw ApiError.notFound('Client not found.')

  // An organization reports how many of its clients THIS caller can open.
  let childClientCount = 0
  if (client.isOrganization) {
    const ids = await assignedClientIds(session, scope)
    childClientCount = await prisma.client.count({
      where: { parentClientId: client.id, ...alive, ...(ids === 'ALL' ? {} : { id: { in: ids } }) },
    })
  }

  const m = await employeeMap([client.accountManagerId, client.secondaryManagerId])
  ok(res, {
    ...clientToApi(client, m),
    contacts: client.contacts.map(clientContactToApi),
    document_count: client._count.documents,
    follow_up_count: client._count.followUps,
    child_client_count: childClientCount,
  })
}))

// PATCH /api/clients/:id
clientsRouter.patch('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.client.manage')
  await assertCanSeeClient(session, scope, req.params.id)
  const b = body(req)

  const before = await prisma.client.findFirst({ where: { id: req.params.id, ...alive } })
  if (!before) throw ApiError.notFound('Client not found.')

  const v = new FieldErrors()
  const data: Record<string, unknown> = {}
  if ('company_name' in b) data.companyName = v.str('company_name', b.company_name, { max: 200 })
  if ('legal_name' in b) data.legalName = v.str('legal_name', b.legal_name, { required: false, max: 200 }) ?? null
  if ('business_type' in b) data.businessType = v.str('business_type', b.business_type, { required: false, max: 80 }) ?? null
  if ('contact_person' in b) data.contactPerson = v.str('contact_person', b.contact_person, { max: 120 })
  if ('contact_number' in b) data.contactNumber = v.phone('contact_number', b.contact_number)
  if ('email' in b) data.email = v.email('email', b.email, false) ?? null
  if ('address' in b) data.address = v.str('address', b.address, { required: false, max: 500 }) ?? null
  if ('gstin' in b) data.gstin = b.gstin ? v.gstin('gstin', b.gstin) : null
  if ('pan' in b) data.pan = b.pan ? v.pan('pan', b.pan) : null
  if ('tan' in b) {
    const tan = (v.str('tan', b.tan, { required: false, max: 20 }) ?? '').toUpperCase()
    if (tan && !/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(tan)) v.add('tan', 'Enter a valid 10-character TAN (e.g. CHEK09876B).')
    data.tan = tan || null
  }
  if ('cin' in b) {
    const cin = (v.str('cin', b.cin, { required: false, max: 25 }) ?? '').toUpperCase()
    if (cin && !CIN_RE.test(cin) && !LLPIN_RE.test(cin)) v.add('cin', 'Enter a valid CIN (U74999TN2020PTC123456) or LLPIN (AAB-1234).')
    data.cin = cin || null
  }
  // Who a client is assigned to decides who can see it, so only staff who
  // see every client (Admin, Senior Associate, Super Admin) change it.
  if (('account_manager_id' in b || 'secondary_manager_id' in b) && !seesAllClients(session)) {
    throw ApiError.forbidden('Only an Admin, Senior Associate or Super Admin can change who a client is assigned to.')
  }
  if ('account_manager_id' in b) data.accountManagerId = v.str('account_manager_id', b.account_manager_id)
  if ('secondary_manager_id' in b) {
    data.secondaryManagerId = v.str('secondary_manager_id', b.secondary_manager_id, { required: false }) ?? null
  }
  if ('assigned_team' in b) data.assignedTeam = v.str('assigned_team', b.assigned_team, { required: false, max: 80 }) ?? null
  if ('status' in b) data.status = v.oneOf('status', b.status, CLIENT_STATUSES)
  if ('notes' in b) data.notes = v.str('notes', b.notes, { required: false, max: 2000 }) ?? null
  // Exit date: the day the firm stopped acting — starts the retention period
  // (data-protection/retention.ts). Only an inactive client has one.
  if ('exit_date' in b) {
    data.exitDate = b.exit_date ? v.date('exit_date', b.exit_date) ?? null : null
    if (data.exitDate && (data.status ?? before.status) !== 'inactive') v.add('exit_date', 'Set the status to Inactive when entering an exit date.')
  }
  if ('short_name' in b) data.shortName = v.str('short_name', b.short_name, { required: false, max: 20 }) ?? null
  v.throwIfAny()

  // Organization membership: organization_id links an existing client under
  // an organization (null removes it). is_organization turns a client into
  // an organization or back. Both keep the tree one level deep.
  let joined: { id: string; companyName: string } | null = null
  let left: { id: string; companyName: string } | null = null
  if ('organization_id' in b) {
    const target = b.organization_id ? String(b.organization_id) : null
    if (target) {
      joined = await assertCanJoinOrganization(session, scope, target, before)
      if (before.parentClientId === target) joined = null
      data.parentClientId = target
    } else {
      if (before.parentClientId) {
        left = await prisma.client.findUnique({ where: { id: before.parentClientId }, select: { id: true, companyName: true } })
      }
      data.parentClientId = null
    }
  }
  if ('is_organization' in b) {
    const turnOn = b.is_organization === true
    if (turnOn && (data.parentClientId ?? before.parentClientId)) {
      throw ApiError.unprocessable('nested_organization', 'Remove this client from its organization before making it an organization.')
    }
    if (!turnOn && before.isOrganization) {
      const children = await prisma.client.count({ where: { parentClientId: before.id, ...alive } })
      if (children > 0) {
        throw ApiError.unprocessable('has_clients', 'Move or remove this organization\'s clients before turning it back into a normal client.')
      }
    }
    data.isOrganization = turnOn
    if (turnOn && !before.shortName && !data.shortName) data.shortName = deriveShortName(String(data.companyName ?? before.companyName))
  }
  const nextPrimary = (data.accountManagerId as string | undefined) ?? before.accountManagerId
  const nextSecondary = 'secondaryManagerId' in data ? (data.secondaryManagerId as string | null) : before.secondaryManagerId
  if (nextSecondary && nextSecondary === nextPrimary) {
    throw ApiError.badRequest('Choose a different person from the account manager.', { secondary_manager_id: 'Choose a different person from the account manager.' })
  }
  for (const [field, id] of [['account_manager_id', data.accountManagerId], ['secondary_manager_id', data.secondaryManagerId]] as const) {
    if (typeof id === 'string' && !(await prisma.employee.findFirst({ where: { id, ...alive } }))) {
      throw ApiError.badRequest('Select a valid employee.', { [field]: 'Select a valid employee.' })
    }
  }
  data.updatedBy = session.userId

  const client = await prisma.client.update({
    where: { id: before.id }, data, include: { parentClient: { select: ORGANIZATION_REF } },
  })

  // Assignment changes: say who now has the client, and tell them.
  if (nextPrimary !== before.accountManagerId || nextSecondary !== before.secondaryManagerId) {
    const m0 = await employeeMap([nextPrimary, nextSecondary])
    const name = (id: string | null) => (id ? m0.get(id)?.full_name ?? 'Unknown' : 'none')
    await writeActivity({
      session, subjectType: 'client', subjectId: client.id, action: 'client.staff_assigned',
      description: `Assigned staff: ${name(nextPrimary)} (account manager), second staff ${name(nextSecondary)}.`,
    })
    for (const [staff, was, label] of [
      [nextPrimary, before.accountManagerId, 'Client assigned to you'],
      [nextSecondary, before.secondaryManagerId, 'Client assigned to you as second staff'],
    ] as const) {
      if (staff && staff !== was && staff !== session.employeeId) {
        await notifyEmployee(staff, {
          type: 'client.assigned', module: 'system', title: label,
          body: `${client.clientCode} · ${client.companyName}`,
          entityType: 'Client', entityId: client.id, actionUrl: `/workstation/clients/${client.id}`,
        })
      }
    }
  }

  if (joined) {
    await writeActivity({
      session, subjectType: 'client', subjectId: joined.id, action: 'organization.client_added',
      description: `${client.companyName} (${client.clientCode}) added to the organization.`,
      entityType: 'Client', entityId: client.id,
    })
    await writeActivity({
      session, subjectType: 'client', subjectId: client.id, action: 'client.organization_joined',
      description: `Added to organization ${joined.companyName}.`, entityType: 'Client', entityId: joined.id,
    })
  }
  if (left) {
    await writeActivity({
      session, subjectType: 'client', subjectId: left.id, action: 'organization.client_removed',
      description: `${client.companyName} (${client.clientCode}) removed from the organization.`,
      entityType: 'Client', entityId: client.id,
    })
    await writeActivity({
      session, subjectType: 'client', subjectId: client.id, action: 'client.organization_left',
      description: `Removed from organization ${left.companyName}.`, entityType: 'Client', entityId: left.id,
    })
  }

  await writeActivity({
    session, subjectType: 'client', subjectId: client.id,
    action: data.status && data.status !== before.status ? 'client.status_updated' : 'client.updated',
    description: data.status && data.status !== before.status
      ? `Client status changed to ${String(data.status).replace(/_/g, ' ')}.`
      : 'Client details updated.',
  })
  await writeAudit({
    actorUserId: session.userId, action: 'client.update',
    entityType: 'Client', entityId: client.id, before, after: client, req,
  })

  const m = await employeeMap([client.accountManagerId, client.secondaryManagerId])
  ok(res, clientToApi(client, m))
}))

// GET /api/clients/:id/activity
clientsRouter.get('/:id/activity', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.client.read', 'workstation.client.manage')
  await assertCanSeeClient(session, scope, req.params.id)

  const rows = await prisma.activity.findMany({
    where: { subjectType: 'client', subjectId: req.params.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  const m = await employeeMap(rows.map((r) => r.actorEmployeeId))
  ok(res, { items: rows.map((r) => activityToApi(r, m)), count: rows.length })
}))

// GET /api/clients/:id/tasks
clientsRouter.get('/:id/tasks', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.client.read', 'workstation.service.read')
  await assertCanSeeClient(session, scope, req.params.id)

  const rows = await prisma.task.findMany({ where: { clientId: req.params.id, ...alive }, orderBy: { dueDate: 'asc' } })
  const m = await employeeMap(rows.map((r) => r.assignedEmployeeId))
  ok(res, { items: rows.map((r) => taskToApi(r, m)), count: rows.length })
}))

// ── Services on a client (§7.4) ───────────────────────────────────────────

// GET /api/clients/:id/services
clientsRouter.get('/:id/services', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.service.read', 'workstation.service.manage')
  await assertCanSeeClient(session, scope, req.params.id)

  const rows = await prisma.clientService.findMany({
    where: { clientId: req.params.id, ...alive },
    include: { service: true, client: true },
    orderBy: { dueDate: 'asc' },
  })
  const m = await employeeMap(rows.flatMap((r) => [r.assignedEmployeeId, r.managerId]))
  ok(res, { items: rows.map((r) => clientServiceToApi(r, m)), count: rows.length })
}))

// POST /api/clients/:id/services
clientsRouter.post('/:id/services', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.service.manage')
  await assertCanSeeClient(session, scope, req.params.id)
  const b = body(req)

  const v = new FieldErrors()
  const serviceId = v.str('service_id', b.service_id)
  const assignedEmployeeId = v.str('assigned_employee_id', b.assigned_employee_id)
  const managerId = v.str('manager_id', b.manager_id, { required: false })
  const dueDate = v.date('due_date', b.due_date, false)
  const notes = v.str('notes', b.notes, { required: false, max: 2000 })
  v.throwIfAny()

  const [service, employee] = await Promise.all([
    prisma.service.findFirst({ where: { id: serviceId!, ...alive } }),
    prisma.employee.findFirst({ where: { id: assignedEmployeeId!, ...alive } }),
  ])
  if (!service) v.add('service_id', 'Select a valid service.')
  if (!employee) v.add('assigned_employee_id', 'Select a valid employee.')
  v.throwIfAny()

  const row = await prisma.clientService.create({
    data: {
      clientId: req.params.id,
      serviceId: serviceId!,
      assignedEmployeeId: assignedEmployeeId!,
      managerId: managerId ?? null,
      dueDate: dueDate ?? null,
      status: 'not_started',
      notes: notes ?? null,
      createdBy: session.userId,
      updatedBy: session.userId,
    },
    include: { service: true, client: true },
  })

  await writeActivity({
    session, subjectType: 'client', subjectId: req.params.id,
    action: 'client.service_assigned',
    description: `${service!.name} assigned to ${employee!.fullName}.`,
    entityType: 'ClientService', entityId: row.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'client_service.create',
    entityType: 'ClientService', entityId: row.id, after: row, req,
  })
  if (assignedEmployeeId !== session.employeeId) {
    await notifyEmployee(assignedEmployeeId!, {
      type: 'service.assigned', module: 'system',
      title: 'Service assigned',
      body: `${service!.name} · ${row.client.companyName}`,
      entityType: 'ClientService', entityId: row.id,
      actionUrl: `/workstation/clients/${req.params.id}/services`,
    })
  }

  const m = await employeeMap([row.assignedEmployeeId, row.managerId])
  ok(res, clientServiceToApi(row, m), 201)
}))

// ── GST (§7.3) ────────────────────────────────────────────────────────────

clientsRouter.get('/:id/gst', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.gst.read', 'workstation.gst.manage')
  await assertCanSeeClient(session, scope, req.params.id)

  const profile = await prisma.gstProfile.findFirst({
    where: { clientId: req.params.id, ...alive },
    include: { filings: { where: alive, orderBy: [{ period: 'desc' }, { returnType: 'asc' }] } },
  })
  if (!profile) {
    // Not an error: plenty of clients are not GST-registered.
    ok(res, null)
    return
  }
  const m = await employeeMap([profile.assignedEmployeeId, ...profile.filings.map((f) => f.assignedEmployeeId)])
  ok(res, gstProfileToApi(profile, m))
}))

clientsRouter.get('/:id/gst/filings', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.gst.read', 'workstation.gst.manage')
  await assertCanSeeClient(session, scope, req.params.id)

  const profile = await prisma.gstProfile.findFirst({ where: { clientId: req.params.id, ...alive } })
  if (!profile) { ok(res, { items: [], count: 0 }); return }
  const rows = await prisma.gstFiling.findMany({
    where: { gstProfileId: profile.id, ...alive },
    orderBy: [{ period: 'desc' }, { returnType: 'asc' }],
  })
  const m = await employeeMap(rows.map((r) => r.assignedEmployeeId))
  ok(res, { items: rows.map((r) => gstFilingToApi(r, m)), count: rows.length })
}))

// ── E-way bills (§7.3) — SIMULATED ────────────────────────────────────────

clientsRouter.get('/:id/eway', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.eway.read', 'workstation.eway.generate')
  await assertCanSeeClient(session, scope, req.params.id)

  const rows = await prisma.ewayBill.findMany({
    where: { clientId: req.params.id, ...alive },
    orderBy: { generatedAt: 'desc' },
  })
  const m = await employeeMap(rows.map((r) => r.generatedByEmployeeId))
  ok(res, {
    items: rows.map((r) => ewayBillToApi(r, m)),
    count: rows.length,
    /* The connection is SIMULATED. Audit OS is not connected to the
       government e-way bill system and this payload says so explicitly so
       the UI cannot accidentally imply otherwise (§9). */
    connection: {
      status: 'simulated',
      is_simulated: true,
      notice: 'Simulated — Audit OS is not connected to the government e-way bill system. Numbers are generated locally.',
    },
  })
}))

clientsRouter.post('/:id/eway/generate', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.eway.generate')
  await assertCanSeeClient(session, scope, req.params.id)
  const b = body(req)

  const v = new FieldErrors()
  const documentNo = v.str('document_no', b.document_no, { max: 60 })
  const documentDate = v.date('document_date', b.document_date, true)
  const toPartyName = v.str('to_party_name', b.to_party_name, { required: false, max: 200 })
  const toGstin = b.to_gstin ? v.gstin('to_gstin', b.to_gstin) : undefined
  const valuePaise = v.rupeesToPaise('value', b.value, true)
  v.throwIfAny()

  const client = await prisma.client.findFirst({ where: { id: req.params.id, ...alive } })
  if (!client) throw ApiError.notFound('Client not found.')

  /* Locally generated number. There is no government call here, and the row
     carries isSimulated: true forever so no later screen can misreport it. */
  const validUntil = new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10)

  // Number allocated under a lock inside the creating transaction, from the
  // numeric maximum (a string sort breaks once the number gains a digit).
  const row = await prisma.$transaction(async (tx) => {
    await lockSequence(tx, 'code:EWB')
    const prefix = 'EWB-'
    const existing = await tx.ewayBill.findMany({ where: { ewbNo: { startsWith: prefix } }, select: { ewbNo: true } })
    const nextNo = `${prefix}${Math.max(maxSuffix(existing.map((e) => e.ewbNo), prefix), 100000) + 1}`
    return tx.ewayBill.create({
      data: {
        clientId: req.params.id,
        ewbNo: nextNo,
        documentNo: documentNo!,
        documentDate: documentDate!,
        fromGstin: client.gstin,
        toGstin: toGstin ?? null,
        toPartyName: toPartyName ?? null,
        valuePaise: valuePaise ?? 0,
        status: 'generated',
        validUntil,
        generatedByEmployeeId: session.employeeId ?? '',
        isSimulated: true,
        createdBy: session.userId,
      },
    })
  })

  await writeActivity({
    session, subjectType: 'client', subjectId: req.params.id,
    action: 'eway.generated',
    description: `E-way bill ${row.ewbNo} generated (simulated).`,
    entityType: 'EwayBill', entityId: row.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'eway.generate',
    entityType: 'EwayBill', entityId: row.id, after: row, req,
  })

  const m = await employeeMap([row.generatedByEmployeeId])
  ok(res, ewayBillToApi(row, m), 201)
}))

// ── Documents (§7.6) — client-centric ─────────────────────────────────────

clientsRouter.get('/:id/documents', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.read', 'workstation.document.manage')
  await assertCanSeeClient(session, scope, req.params.id)

  const categoryId = typeof req.query.category_id === 'string' ? req.query.category_id : null
  const status = typeof req.query.status === 'string' ? req.query.status : null

  const rows = await prisma.clientDocument.findMany({
    where: {
      clientId: req.params.id, ...alive,
      ...(categoryId ? { categoryId } : {}),
      ...(status ? { status } : {}),
    },
    include: { category: true, client: true, versions: { orderBy: { version: 'asc' } } },
    orderBy: [{ categoryId: 'asc' }, { name: 'asc' }],
  })
  const m = await employeeMap([
    ...rows.map((r) => r.requestedByEmployeeId),
    ...rows.map((r) => r.verifiedByEmployeeId),
    ...rows.flatMap((r) => r.versions.map((v) => v.uploadedBy)),
  ])
  ok(res, { items: rows.map((r) => clientDocumentToApi(r, m)), count: rows.length })
}))

/**
 * POST /api/clients/:id/documents — request OR record a document.
 *
 * `status: 'requested'` is the Client Portal handoff (§7.6). The portal does
 * not exist yet, so this records the request and notifies nobody outside the
 * firm; the response says so and the UI repeats it.
 */
clientsRouter.post('/:id/documents', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.document.manage')
  await assertCanSeeClient(session, scope, req.params.id)
  const b = body(req)

  const v = new FieldErrors()
  const name = v.str('name', b.name, { max: 200 })
  const categoryId = v.str('category_id', b.category_id)
  const financialYear = v.str('financial_year', b.financial_year, { required: false, max: 12 })
  const clientServiceId = v.str('client_service_id', b.client_service_id, { required: false })
  const status = 'status' in b ? v.oneOf('status', b.status, DOCUMENT_STATUSES) : 'requested'
  v.throwIfAny()

  const category = await prisma.documentCategory.findFirst({ where: { id: categoryId!, ...alive } })
  if (!category) v.add('category_id', 'Select a valid category.')
  v.throwIfAny()

  const isRequest = status === 'requested'
  const doc = await prisma.clientDocument.create({
    data: {
      clientId: req.params.id,
      categoryId: categoryId!,
      clientServiceId: clientServiceId ?? null,
      name: name!,
      financialYear: financialYear ?? null,
      status: status!,
      currentVersion: 0,
      requestedByEmployeeId: isRequest ? session.employeeId : null,
      requestedAt: isRequest ? new Date() : null,
      createdBy: session.userId,
      updatedBy: session.userId,
    },
    include: { category: true, client: true, versions: true },
  })

  await writeActivity({
    session, subjectType: 'client', subjectId: req.params.id,
    action: isRequest ? 'document.requested' : 'document.added',
    description: `${category!.name} — ${doc.name} ${isRequest ? 'requested from the client' : 'added'}.`,
    entityType: 'ClientDocument', entityId: doc.id,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'client_document.create',
    entityType: 'ClientDocument', entityId: doc.id, after: doc, req,
  })

  const m = await employeeMap([doc.requestedByEmployeeId])
  ok(res, {
    ...clientDocumentToApi(doc, m),
    /* Honest about what did NOT happen (§9). */
    portal_notice: isRequest
      ? 'Client Portal is not yet available. This request is recorded in Audit OS; no message has been sent to the client.'
      : null,
  }, 201)
}))
