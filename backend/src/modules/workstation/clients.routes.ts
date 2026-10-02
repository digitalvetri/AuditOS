import { Router } from 'express'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { notifyEmployee } from '../../platform/notify.js'
import { writeActivity } from '../../platform/workstation/activity.js'
import { nextClientCode } from '../../platform/workstation/codes.js'
import {
  assertCanSeeClient, clientIdWhere, requireWorkstation,
} from '../../platform/workstation/scope.js'
import {
  activityToApi, clientContactToApi, clientDocumentToApi, clientServiceToApi,
  clientToApi, employeeMap, ewayBillToApi, gstFilingToApi, gstProfileToApi, taskToApi,
} from '../../api/workstation.serialize.js'
import {
  body, CLIENT_STATUSES, DOCUMENT_STATUSES, FieldErrors, SERVICE_STATUSES,
} from './validate.js'

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

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  const status = typeof req.query.status === 'string' ? req.query.status : null
  const managerId = typeof req.query.account_manager_id === 'string' ? req.query.account_manager_id : null
  const serviceId = typeof req.query.service_id === 'string' ? req.query.service_id : null
  const pendingDocs = req.query.pending_documents === 'true'

  const where = {
    ...alive,
    ...(await clientIdWhere(session, scope)),
    ...(status ? { status } : {}),
    ...(managerId ? { accountManagerId: managerId } : {}),
    ...(serviceId ? { services: { some: { serviceId, deletedAt: null } } } : {}),
    ...(pendingDocs
      ? { documents: { some: { status: { in: ['requested', 'pending'] }, deletedAt: null } } }
      : {}),
    // §7.2 search: company · client id · GSTIN · contact person · number.
    ...(q
      ? {
          OR: [
            { companyName: { contains: q } },
            { clientCode: { contains: q } },
            { gstin: { contains: q } },
            { contactPerson: { contains: q } },
            { contactNumber: { contains: q } },
          ],
        }
      : {}),
  }

  const rows = await prisma.client.findMany({
    where,
    include: {
      services: { where: alive, include: { service: true } },
      _count: { select: { documents: { where: { deletedAt: null } } } },
    },
    orderBy: { clientCode: 'asc' },
  })

  const m = await employeeMap(rows.map((r) => r.accountManagerId))
  ok(res, {
    items: rows.map((r) => ({
      ...clientToApi(r, m),
      service_names: r.services.map((s) => s.service.name),
      document_count: r._count.documents,
    })),
    count: rows.length,
    scope,
  })
}))

// POST /api/clients — direct creation (a client that never was a lead)
clientsRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.client.manage')
  const b = body(req)

  const v = new FieldErrors()
  const companyName = v.str('company_name', b.company_name, { max: 200 })
  const contactPerson = v.str('contact_person', b.contact_person, { max: 120 })
  const contactNumber = v.phone('contact_number', b.contact_number)
  const email = v.email('email', b.email, false)
  const gstin = b.gstin ? v.gstin('gstin', b.gstin) : undefined
  const pan = b.pan ? v.pan('pan', b.pan) : undefined
  const accountManagerId = v.str('account_manager_id', b.account_manager_id)
  const businessType = v.str('business_type', b.business_type, { required: false, max: 80 })
  const address = v.str('address', b.address, { required: false, max: 500 })
  v.throwIfAny()

  const manager = await prisma.employee.findFirst({ where: { id: accountManagerId!, ...alive } })
  if (!manager) v.add('account_manager_id', 'Select a valid employee.')
  v.throwIfAny()

  const client = await prisma.$transaction(async (tx) => {
    const clientCode = await nextClientCode(tx)
    const created = await tx.client.create({
      data: {
        organisationId: 'org-audit-os',
        clientCode,
        companyName: companyName!,
        legalName: companyName!,
        businessType: businessType ?? null,
        contactPerson: contactPerson!,
        contactNumber: contactNumber!,
        email: email ?? null,
        address: address ?? null,
        gstin: gstin ?? null,
        pan: pan ?? null,
        accountManagerId: accountManagerId!,
        status: 'onboarding',
        onboardingDate: new Date().toISOString().slice(0, 10),
        createdBy: session.userId,
        updatedBy: session.userId,
      },
    })
    await tx.clientContact.create({
      data: {
        clientId: created.id, name: contactPerson!, designation: 'Primary contact',
        phone: contactNumber!, email: email ?? null, isPrimary: true, createdBy: session.userId,
      },
    })
    return created
  })

  await writeActivity({
    session, subjectType: 'client', subjectId: client.id,
    action: 'client.created', description: `Client ${client.clientCode} created.`,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'client.create',
    entityType: 'Client', entityId: client.id, after: client, req,
  })

  const m = await employeeMap([client.accountManagerId])
  ok(res, clientToApi(client, m), 201)
}))

// GET /api/clients/:id
clientsRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.client.read', 'workstation.client.manage')
  await assertCanSeeClient(session, scope, req.params.id)

  const client = await prisma.client.findFirst({
    where: { id: req.params.id, ...alive },
    include: { contacts: { where: alive }, _count: { select: { documents: { where: alive }, followUps: { where: alive } } } },
  })
  if (!client) throw ApiError.notFound('Client not found.')

  const m = await employeeMap([client.accountManagerId])
  ok(res, {
    ...clientToApi(client, m),
    contacts: client.contacts.map(clientContactToApi),
    document_count: client._count.documents,
    follow_up_count: client._count.followUps,
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
  if ('tan' in b) data.tan = v.str('tan', b.tan, { required: false, max: 20 }) ?? null
  if ('account_manager_id' in b) data.accountManagerId = v.str('account_manager_id', b.account_manager_id)
  if ('assigned_team' in b) data.assignedTeam = v.str('assigned_team', b.assigned_team, { required: false, max: 80 }) ?? null
  if ('status' in b) data.status = v.oneOf('status', b.status, CLIENT_STATUSES)
  if ('notes' in b) data.notes = v.str('notes', b.notes, { required: false, max: 2000 }) ?? null
  v.throwIfAny()
  data.updatedBy = session.userId

  const client = await prisma.client.update({ where: { id: before.id }, data })

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

  const m = await employeeMap([client.accountManagerId])
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
  const last = await prisma.ewayBill.findFirst({ orderBy: { ewbNo: 'desc' }, select: { ewbNo: true } })
  const nextNo = `EWB-${(Number(last?.ewbNo.slice(4) ?? 100000) + 1)}`
  const validUntil = new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10)

  const row = await prisma.ewayBill.create({
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
