import { Router } from 'express'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { notifyEmployee } from '../../platform/notify.js'
import {
  assertCanSeeClient, clientScopeWhere, requireWorkstation,
} from '../../platform/workstation/scope.js'
import { employeeMap } from '../../api/workstation.serialize.js'
import { body, FieldErrors } from '../workstation/validate.js'
import {
  CASE_STATUSES, CHECKLIST_CATEGORIES, CHECKLIST_STATUSES, DELIVERABLE_STATUSES,
  DELIVERABLE_TYPES, DOC_CATEGORIES, DOCREQ_STATUSES, DSC_STATUSES, FEE_CATEGORIES,
  FEE_STATUSES, FILING_STATUSES, FILING_TYPES, HANDOVER_CHECKLIST, NAME_STATUSES,
  PARTY_ROLE_LABELS, PRIORITIES, QUERY_STATUSES, STAGE_LABELS, STAGES, TASK_STATUSES,
  TASK_TEMPLATES, assertStageTransition, isBackwardMove, rolesOf,
} from './validate.js'
import {
  addDays, caseScope, createCaseWithChecklist, overviewKpis, pendingItems,
  progressByCase, progressFrom, stageSideEffects, today, writeCaseActivity,
} from './service.js'
import {
  activityToApi, caseTaskToApi, caseToApi, checklistItemToApi, checklistTemplateToApi,
  deliverableToApi, documentRequestToApi, dscToApi, entityTypeToApi, feeToApi,
  filingToApi, nameToApi, partyToApi, queryToApi,
} from './serialize.js'

/**
 * INCORPORATION SERVICE.
 *
 * Case management for company / LLP / firm incorporation, living under
 * Workstation → Services → Incorporation.
 *
 * IT CALLS NOTHING. There is no MCA client here, no portal scrape, no DSC
 * driver, no PAN/TAN lookup — not even a mocked one. Every government fact
 * this module holds was typed in by an employee, is stamped with who typed it
 * and when, and is rendered with that attribution beside it. The word
 * "verified" appears in exactly one status, on DSC, and means an employee
 * physically checked a token.
 *
 * Permissions are the EXISTING workstation.service.read / .manage pair that
 * Bookkeeping already uses — this module adds no permission code. Settings
 * writes additionally require that grant at `organisation` scope.
 */
export const incorporationRouter = Router()

const READ = ['workstation.service.read', 'workstation.service.manage'] as const
const MANAGE = ['workstation.service.manage'] as const

const q = (req: { query: Record<string, unknown> }, key: string) =>
  (typeof req.query[key] === 'string' && req.query[key] !== '' ? (req.query[key] as string) : null)

const num = (v: string | null, dflt: number, max: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : dflt
}

/** Settings writes are an organisation-scope act, not a per-assignment one. */
function requireOrgScope(session: Session): void {
  const scope = requireWorkstation(session, ...MANAGE)
  if (scope !== 'organisation') {
    throw ApiError.forbidden('Incorporation settings are managed at the firm level.')
  }
}

/**
 * Load a case the caller may actually see, or 403. Never 404 for an
 * out-of-scope id — that would leak which case ids exist.
 */
async function loadCase(session: Session, scope: Parameters<typeof assertCanSeeClient>[1], caseId: string) {
  const row = await prisma.incorporationCase.findFirst({
    where: { ...alive, id: caseId },
    include: { client: true, entityType: true },
  })
  if (!row) throw ApiError.notFound('No such case.')
  await assertCanSeeClient(session, scope, row.clientId)
  return row
}

/** Every mutation writes both trails: AuditLog for compliance, Activity for people. */
async function trail(
  req: Parameters<typeof writeAudit>[0]['req'],
  session: Session,
  caseId: string,
  action: string,
  detail: string,
  before?: unknown,
  after?: unknown,
) {
  await writeAudit({
    actorUserId: session.userId,
    action,
    entityType: 'IncorporationCase',
    entityId: caseId,
    before,
    after,
    req,
  })
  await writeCaseActivity({ caseId, actorUserId: session.userId, action, detail })
}

// ── Overview ──────────────────────────────────────────────────────────────
// GET /api/incorporation/overview
incorporationRouter.get('/overview', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)

  const kpis = await overviewKpis(where)

  // Active cases, most urgent first, so Overview is actionable rather than a
  // wall of counters.
  const cases = await prisma.incorporationCase.findMany({
    where: { ...alive, ...where, status: 'active' },
    include: { client: true, entityType: true },
    orderBy: [{ targetDate: 'asc' }, { updatedAt: 'desc' }],
    take: 8,
  })
  const prog = await progressByCase(cases.map((c) => c.id))
  const m = await employeeMap(cases.map((c) => c.assignedEmployeeId))

  ok(res, {
    kpis,
    active: cases.map((c) => caseToApi(c, m, { progress: prog.get(c.id) })),
    scope,
  })
}))

// ── Settings / reference data ─────────────────────────────────────────────
// GET /api/incorporation/settings — entity types, templates and the
// vocabularies the forms render. One call, so a wizard step is not six.
incorporationRouter.get('/settings', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)

  const [entityTypes, templates] = await Promise.all([
    prisma.incorporationEntityType.findMany({ where: alive, orderBy: { sortOrder: 'asc' } }),
    prisma.incorporationChecklistTemplate.findMany({ where: alive, orderBy: [{ sortOrder: 'asc' }] }),
  ])
  const m = await employeeMap(entityTypes.map((e) => e.defaultAssignedEmployeeId))

  ok(res, {
    entity_types: entityTypes.map((e) => entityTypeToApi(e, m)),
    checklist_templates: templates.map(checklistTemplateToApi),
    vocabularies: {
      stages: STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] })),
      case_statuses: CASE_STATUSES,
      priorities: PRIORITIES,
      party_roles: Object.entries(PARTY_ROLE_LABELS).map(([value, label]) => ({ value, label })),
      checklist_categories: CHECKLIST_CATEGORIES,
      checklist_statuses: CHECKLIST_STATUSES,
      document_categories: DOC_CATEGORIES,
      document_statuses: DOCREQ_STATUSES,
      dsc_statuses: DSC_STATUSES,
      name_statuses: NAME_STATUSES,
      filing_types: FILING_TYPES,
      filing_statuses: FILING_STATUSES,
      query_statuses: QUERY_STATUSES,
      deliverable_types: DELIVERABLE_TYPES,
      deliverable_statuses: DELIVERABLE_STATUSES,
      fee_categories: FEE_CATEGORIES,
      fee_statuses: FEE_STATUSES,
      task_templates: TASK_TEMPLATES,
      handover_checklist: HANDOVER_CHECKLIST,
    },
    /// The UI hides Settings' write controls on this flag; the server refuses
    /// the write regardless, which is where the control actually lives.
    can_manage_settings: scope === 'organisation',
  })
}))

// PATCH /api/incorporation/entity-types/:id
incorporationRouter.patch('/entity-types/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireOrgScope(session)
  const b = body(req)
  const f = new FieldErrors()

  const existing = await prisma.incorporationEntityType.findFirst({ where: { ...alive, id: req.params.id } })
  if (!existing) throw ApiError.notFound('No such entity type.')

  const name = b.name === undefined ? undefined : f.str('name', b.name, { max: 120 })
  const description = b.description === undefined ? undefined : f.str('description', b.description, { required: false, max: 500 })
  const defaultTargetDays = b.default_target_days === undefined ? undefined : Number(b.default_target_days)
  if (defaultTargetDays !== undefined && (!Number.isFinite(defaultTargetDays) || defaultTargetDays < 1 || defaultTargetDays > 365)) {
    f.add('default_target_days', 'Enter a number of days between 1 and 365.')
  }
  const minParties = b.min_parties === undefined ? undefined : Number(b.min_parties)
  if (minParties !== undefined && (!Number.isFinite(minParties) || minParties < 1)) {
    f.add('min_parties', 'At least one person is required.')
  }

  let partyRolesJson: string | undefined
  if (b.party_roles !== undefined) {
    const roles = b.party_roles
    if (!Array.isArray(roles) || roles.some((r) => typeof r !== 'string' || !(r in PARTY_ROLE_LABELS))) {
      f.add('party_roles', 'Choose roles from the standard list.')
    } else if (roles.length === 0) {
      f.add('party_roles', 'An entity type needs at least one role.')
    } else {
      partyRolesJson = JSON.stringify(roles)
    }
  }
  f.throwIfAny()

  const row = await prisma.incorporationEntityType.update({
    where: { id: existing.id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(defaultTargetDays !== undefined ? { defaultTargetDays } : {}),
      ...(minParties !== undefined ? { minParties } : {}),
      ...(partyRolesJson !== undefined ? { partyRolesJson } : {}),
      ...(b.default_assigned_employee_id !== undefined
        ? { defaultAssignedEmployeeId: (b.default_assigned_employee_id as string) || null } : {}),
      ...(b.is_active !== undefined ? { isActive: !!b.is_active } : {}),
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'incorporation.entity_type.updated',
    entityType: 'IncorporationEntityType', entityId: row.id, before: existing, after: row, req,
  })
  const m = await employeeMap([row.defaultAssignedEmployeeId])
  ok(res, entityTypeToApi(row, m))
}))

// POST /api/incorporation/checklist-templates
incorporationRouter.post('/checklist-templates', handler(async (req, res) => {
  const session = requireSession(req)
  requireOrgScope(session)
  const b = body(req)
  const f = new FieldErrors()

  const category = f.oneOf('category', b.category, CHECKLIST_CATEGORIES)
  const label = f.str('label', b.label, { max: 200 })
  const entityTypeId = b.entity_type_id ? f.str('entity_type_id', b.entity_type_id) : null
  const stage = b.stage ? f.oneOf('stage', b.stage, STAGES) : null
  f.throwIfAny()

  const maxOrder = await prisma.incorporationChecklistTemplate.aggregate({
    where: { entityTypeId: entityTypeId ?? null }, _max: { sortOrder: true },
  })

  const row = await prisma.incorporationChecklistTemplate.create({
    data: {
      organisationId: (await prisma.organisation.findFirstOrThrow({ select: { id: true } })).id,
      entityTypeId: entityTypeId ?? null,
      category: category!,
      label: label!,
      stage: stage ?? null,
      sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
      createdBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'incorporation.checklist_template.created',
    entityType: 'IncorporationChecklistTemplate', entityId: row.id, after: row, req,
  })
  ok(res, checklistTemplateToApi(row), 201)
}))

// PATCH /api/incorporation/checklist-templates/:id
incorporationRouter.patch('/checklist-templates/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireOrgScope(session)
  const b = body(req)
  const f = new FieldErrors()
  const existing = await prisma.incorporationChecklistTemplate.findFirst({ where: { ...alive, id: req.params.id } })
  if (!existing) throw ApiError.notFound('No such checklist item.')

  const label = b.label === undefined ? undefined : f.str('label', b.label, { max: 200 })
  f.throwIfAny()

  const row = await prisma.incorporationChecklistTemplate.update({
    where: { id: existing.id },
    data: {
      ...(label !== undefined ? { label } : {}),
      ...(b.is_active !== undefined ? { isActive: !!b.is_active } : {}),
      ...(b.sort_order !== undefined ? { sortOrder: Number(b.sort_order) || 0 } : {}),
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'incorporation.checklist_template.updated',
    entityType: 'IncorporationChecklistTemplate', entityId: row.id, before: existing, after: row, req,
  })
  ok(res, checklistTemplateToApi(row))
}))

// ── Cases ─────────────────────────────────────────────────────────────────
// GET /api/incorporation/cases — server-side pagination, sorting, search and
// filters. Every predicate is folded into the Prisma query; nothing is
// filtered after the rows come back, which is the difference between a
// control and a decoration.
incorporationRouter.get('/cases', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)

  const page = num(q(req, 'page'), 1, 10_000)
  const pageSize = num(q(req, 'page_size'), 25, 100)
  const search = q(req, 'q')
  const stage = q(req, 'stage')
  const status = q(req, 'status')
  const entityTypeId = q(req, 'entity_type_id')
  const employeeId = q(req, 'employee_id')
  const priority = q(req, 'priority')
  const from = q(req, 'from')
  const to = q(req, 'to')
  const overdue = q(req, 'overdue') === 'true'
  const pendingDocs = q(req, 'pending_documents') === 'true'

  const SORTS: Record<string, Record<string, 'asc' | 'desc'>> = {
    case_code: { caseCode: 'asc' },
    client: { clientId: 'asc' },
    proposed_name: { proposedName: 'asc' },
    stage: { stage: 'asc' },
    priority: { priority: 'asc' },
    target_date: { targetDate: 'asc' },
    updated_at: { updatedAt: 'desc' },
  }
  const sortKey = q(req, 'sort') ?? 'updated_at'
  const dir = q(req, 'dir') === 'asc' ? 'asc' : 'desc'
  const base = SORTS[sortKey] ?? SORTS.updated_at
  const orderBy = Object.fromEntries(Object.keys(base).map((k) => [k, dir])) as Record<string, 'asc' | 'desc'>

  const filters = {
    ...alive,
    ...where,
    ...(stage ? { stage } : {}),
    ...(status ? { status } : {}),
    ...(entityTypeId ? { entityTypeId } : {}),
    ...(employeeId ? { assignedEmployeeId: employeeId } : {}),
    ...(priority ? { priority } : {}),
    ...(from || to ? { targetDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    // Overdue = a target date in the past on a case still running.
    ...(overdue ? { targetDate: { lt: today() }, status: 'active' } : {}),
    ...(pendingDocs
      ? { documentRequests: { some: { deletedAt: null, status: { in: ['required', 'requested', 'under_review'] } } } }
      : {}),
    ...(search
      ? {
        OR: [
          { caseCode: { contains: search, mode: 'insensitive' as const } },
          { proposedName: { contains: search, mode: 'insensitive' as const } },
          { alternateName: { contains: search, mode: 'insensitive' as const } },
          { client: { companyName: { contains: search, mode: 'insensitive' as const } } },
          { client: { clientCode: { contains: search, mode: 'insensitive' as const } } },
          { names: { some: { applicationRef: { contains: search, mode: 'insensitive' as const } } } },
          { filings: { some: { applicationRef: { contains: search, mode: 'insensitive' as const } } } },
          { filings: { some: { acknowledgementRef: { contains: search, mode: 'insensitive' as const } } } },
        ],
      }
      : {}),
  }

  const [total, rows] = await Promise.all([
    prisma.incorporationCase.count({ where: filters }),
    prisma.incorporationCase.findMany({
      where: filters,
      include: { client: true, entityType: true },
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  const ids = rows.map((r) => r.id)
  const [prog, m, queryCounts, docCounts] = await Promise.all([
    progressByCase(ids),
    employeeMap(rows.map((r) => r.assignedEmployeeId)),
    prisma.incorporationQuery.groupBy({
      by: ['caseId'], where: { ...alive, caseId: { in: ids }, status: { not: 'resolved' } }, _count: { _all: true },
    }),
    prisma.incorporationDocumentRequest.groupBy({
      by: ['caseId'], where: { ...alive, caseId: { in: ids }, status: { in: ['required', 'requested', 'under_review'] } }, _count: { _all: true },
    }),
  ])
  const qc = new Map(queryCounts.map((c) => [c.caseId, c._count._all]))
  const dc = new Map(docCounts.map((c) => [c.caseId, c._count._all]))

  ok(res, {
    items: rows.map((r) => caseToApi(r, m, {
      progress: prog.get(r.id),
      openQueries: qc.get(r.id) ?? 0,
      pendingDocuments: dc.get(r.id) ?? 0,
    })),
    count: rows.length,
    page,
    page_size: pageSize,
    total,
    scope,
  })
}))

// POST /api/incorporation/cases — the wizard's submit. Code allocation,
// parties and checklist instantiation all happen in ONE transaction.
incorporationRouter.post('/cases', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const b = body(req)
  const f = new FieldErrors()

  const clientId = f.str('client_id', b.client_id)
  const entityTypeId = f.str('entity_type_id', b.entity_type_id)
  const proposedName = f.str('proposed_name', b.proposed_name, { max: 200 })
  const alternateName = f.str('alternate_name', b.alternate_name, { required: false, max: 200 })
  const businessActivity = f.str('business_activity', b.business_activity, { required: false, max: 500 })
  const businessCategory = f.str('business_category', b.business_category, { required: false, max: 120 })
  const state = f.str('state', b.state, { required: false, max: 120 })
  const city = f.str('city', b.city, { required: false, max: 120 })
  const registeredOfficeInfo = f.str('registered_office_info', b.registered_office_info, { required: false, max: 1000 })
  const incorporationObjective = f.str('incorporation_objective', b.incorporation_objective, { required: false, max: 1000 })
  const assignedEmployeeId = f.str('assigned_employee_id', b.assigned_employee_id)
  const priority = f.oneOf('priority', b.priority ?? 'medium', PRIORITIES)
  const targetDate = f.date('target_date', b.target_date, false)
  const internalNotes = f.str('internal_notes', b.internal_notes, { required: false, max: 2000 })

  const rawParties = Array.isArray(b.parties) ? (b.parties as Record<string, unknown>[]) : []
  if (rawParties.length === 0) f.add('parties', 'Add at least one person to the case.')
  const parties = rawParties.map((p, i) => ({
    role: f.str(`parties.${i}.role`, p.role) ?? '',
    name: f.str(`parties.${i}.name`, p.name, { max: 160 }) ?? '',
    contactNumber: p.contact_number ? f.phone(`parties.${i}.contact_number`, p.contact_number, false) ?? null : null,
    email: p.email ? f.email(`parties.${i}.email`, p.email, false) ?? null : null,
    address: f.str(`parties.${i}.address`, p.address, { required: false, max: 500 }) ?? null,
    clientContactId: typeof p.client_contact_id === 'string' && p.client_contact_id ? p.client_contact_id : null,
    dscRequired: p.dsc_required === undefined ? true : !!p.dsc_required,
  }))

  const rawDocs = Array.isArray(b.document_requests) ? (b.document_requests as Record<string, unknown>[]) : []
  const documentRequests = rawDocs.map((d, i) => ({
    category: f.oneOf(`document_requests.${i}.category`, d.category ?? 'other', DOC_CATEGORIES) ?? 'other',
    documentType: f.str(`document_requests.${i}.document_type`, d.document_type, { max: 160 }) ?? '',
    description: f.str(`document_requests.${i}.description`, d.description, { required: false, max: 500 }) ?? null,
  }))

  f.throwIfAny()
  await assertCanSeeClient(session, scope, clientId!)

  const client = await prisma.client.findFirst({ where: { ...alive, id: clientId! } })
  if (!client) throw ApiError.badRequest('Choose a client.', { client_id: 'Unknown client.' })

  const created = await prisma.$transaction((tx) => createCaseWithChecklist(tx, {
    organisationId: client.organisationId,
    clientId: clientId!,
    entityTypeId: entityTypeId!,
    proposedName: proposedName!,
    alternateName: alternateName ?? null,
    businessActivity: businessActivity ?? null,
    businessCategory: businessCategory ?? null,
    state: state ?? null,
    city: city ?? null,
    registeredOfficeInfo: registeredOfficeInfo ?? null,
    incorporationObjective: incorporationObjective ?? null,
    assignedEmployeeId: assignedEmployeeId!,
    priority: priority!,
    targetDate: targetDate ?? null,
    internalNotes: internalNotes ?? null,
    parties,
    documentRequests,
    createdBy: session.userId,
  }))

  await trail(req, session, created.id, 'incorporation.case.created',
    `Case ${created.caseCode} opened for ${client.companyName} (${created.entityType.name}).`,
    undefined, { caseCode: created.caseCode, stage: created.stage })

  await notifyEmployee(assignedEmployeeId!, {
    type: 'incorporation.case_assigned',
    module: 'system',
    title: 'Incorporation case assigned',
    body: `${created.caseCode} — ${created.proposedName} (${client.companyName})`,
    entityType: 'IncorporationCase',
    entityId: created.id,
    actionUrl: `/workstation/services/incorporation/cases/${created.id}`,
  })

  const m = await employeeMap([created.assignedEmployeeId])
  ok(res, {
    ...caseToApi(created, m, { progress: progressFrom(created.checklistItems) }),
    parties: created.parties.map((p) => partyToApi(p)),
  }, 201)
}))

// GET /api/incorporation/cases/:id
incorporationRouter.get('/cases/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const row = await loadCase(session, scope, req.params.id)

  const [items, openQueries, pendingDocs] = await Promise.all([
    prisma.incorporationChecklistItem.findMany({ where: { caseId: row.id }, select: { status: true } }),
    prisma.incorporationQuery.count({ where: { ...alive, caseId: row.id, status: { not: 'resolved' } } }),
    prisma.incorporationDocumentRequest.count({
      where: { ...alive, caseId: row.id, status: { in: ['required', 'requested', 'under_review'] } },
    }),
  ])
  const m = await employeeMap([row.assignedEmployeeId])

  ok(res, {
    case: caseToApi(row, m, { progress: progressFrom(items), openQueries, pendingDocuments: pendingDocs }),
    entity_type: entityTypeToApi(row.entityType, m),
    party_roles: rolesOf(row.entityType).map((v) => ({ value: v, label: PARTY_ROLE_LABELS[v] ?? v })),
    handover_checklist: HANDOVER_CHECKLIST,
    task_templates: TASK_TEMPLATES,
  })
}))

// PATCH /api/incorporation/cases/:id
incorporationRouter.patch('/cases/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await loadCase(session, scope, req.params.id)
  const b = body(req)
  const f = new FieldErrors()

  // `stage` and `status` are DELIBERATELY not settable here — a stage move is
  // its own endpoint so it cannot skip the transition table.
  const data: Record<string, unknown> = {}
  const strField = (key: string, col: string, max: number, required = false) => {
    if (b[key] === undefined) return
    data[col] = f.str(key, b[key], { required, max }) ?? null
  }
  strField('proposed_name', 'proposedName', 200, true)
  strField('alternate_name', 'alternateName', 200)
  strField('business_activity', 'businessActivity', 500)
  strField('business_category', 'businessCategory', 120)
  strField('state', 'state', 120)
  strField('city', 'city', 120)
  strField('registered_office_info', 'registeredOfficeInfo', 1000)
  strField('incorporation_objective', 'incorporationObjective', 1000)
  strField('internal_notes', 'internalNotes', 2000)
  if (b.priority !== undefined) data.priority = f.oneOf('priority', b.priority, PRIORITIES)
  if (b.target_date !== undefined) data.targetDate = f.date('target_date', b.target_date, false) ?? null
  if (b.assigned_employee_id !== undefined) data.assignedEmployeeId = f.str('assigned_employee_id', b.assigned_employee_id)
  f.throwIfAny()

  const row = await prisma.incorporationCase.update({
    where: { id: existing.id },
    data: { ...data, updatedBy: session.userId },
    include: { client: true, entityType: true },
  })

  const reassigned = data.assignedEmployeeId && data.assignedEmployeeId !== existing.assignedEmployeeId
  await trail(req, session, row.id,
    reassigned ? 'incorporation.case.assigned' : 'incorporation.case.updated',
    reassigned ? 'Case reassigned.' : 'Case details updated.',
    existing, row)

  if (reassigned) {
    await notifyEmployee(row.assignedEmployeeId, {
      type: 'incorporation.case_assigned',
      module: 'system',
      title: 'Incorporation case assigned',
      body: `${row.caseCode} — ${row.proposedName}`,
      entityType: 'IncorporationCase',
      entityId: row.id,
      actionUrl: `/workstation/services/incorporation/cases/${row.id}`,
    })
  }

  const m = await employeeMap([row.assignedEmployeeId])
  ok(res, caseToApi(row, m))
}))

// POST /api/incorporation/cases/:id/stage — THE stage machine.
//
// The transition table lives on the server and is checked here. A backward
// move is not in the table; it is permitted only for an organisation-scope
// caller, only with a reason, and it is logged under a DISTINCT action so a
// reversal is never mistaken for ordinary progress.
incorporationRouter.post('/cases/:id/stage', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await loadCase(session, scope, req.params.id)
  const b = body(req)
  const f = new FieldErrors()

  const to = f.oneOf('stage', b.stage, STAGES)
  const reason = f.str('reason', b.reason, { required: false, max: 500 })
  f.throwIfAny()

  const backward = isBackwardMove(existing.stage, to!)
  if (backward) {
    if (scope !== 'organisation') {
      throw ApiError.forbidden('Only a firm-level role can move a case backwards.')
    }
    if (!reason) {
      throw ApiError.badRequest('Please correct the highlighted fields.', {
        reason: 'A reason is required to move a case backwards.',
      })
    }
  } else {
    assertStageTransition(existing.stage, to!, existing.heldFromStage)
  }
  if (to === 'cancelled' && !reason) {
    throw ApiError.badRequest('Please correct the highlighted fields.', {
      reason: 'Say why the case is being cancelled.',
    })
  }

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.incorporationCase.update({
      where: { id: existing.id },
      data: { ...stageSideEffects(to!, existing.stage, reason ?? null), updatedBy: session.userId },
      include: { client: true, entityType: true },
    })
    await tx.incorporationActivity.create({
      data: {
        caseId: existing.id,
        actorUserId: session.userId,
        action: backward ? 'incorporation.case.stage_reverted' : 'incorporation.case.stage_changed',
        detail: `${STAGE_LABELS[existing.stage as keyof typeof STAGE_LABELS] ?? existing.stage} → `
          + `${STAGE_LABELS[to as keyof typeof STAGE_LABELS] ?? to}`
          + (reason ? ` · ${reason}` : ''),
      },
    })
    return updated
  })

  await writeAudit({
    actorUserId: session.userId,
    action: backward ? 'incorporation.case.stage_reverted' : 'incorporation.case.stage_changed',
    entityType: 'IncorporationCase',
    entityId: row.id,
    before: { stage: existing.stage, status: existing.status },
    after: { stage: row.stage, status: row.status, reason: reason ?? null },
    req,
  })

  const m = await employeeMap([row.assignedEmployeeId])
  ok(res, caseToApi(row, m))
}))

// GET /api/incorporation/cases/:id/timeline
incorporationRouter.get('/cases/:id/timeline', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const row = await loadCase(session, scope, req.params.id)

  const items = await prisma.incorporationActivity.findMany({
    where: { caseId: row.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  // Actor names resolved in one query, not one per row.
  const userIds = Array.from(new Set(items.map((i) => i.actorUserId).filter((v): v is string => !!v)))
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, include: { employee: { select: { fullName: true } } } })
    : []
  const names = new Map(users.map((u) => [u.id, u.employee?.fullName ?? u.email]))

  ok(res, {
    items: items.map((i) => activityToApi({ ...i, actorName: i.actorUserId ? names.get(i.actorUserId) ?? null : null })),
    count: items.length,
  })
}))

// ══════════════════════════════════════════════════════════════════════════
// CASE SUB-RESOURCES
//
// Every write below stamps PROVENANCE where the row carries an
// externally-sourced fact: `source = 'manual_entry'`, the employee who typed
// it, and when. That triple is what lets the UI say "Recorded by Priya ·
// 10 Sep 2026" instead of implying the system checked with anybody.
// ══════════════════════════════════════════════════════════════════════════

/** The provenance stamp applied on every create and on every status change. */
const stamp = (session: Session) => ({
  source: 'manual_entry',
  recordedByEmployeeId: session.employeeId,
  recordedAt: new Date(),
})

// ── Parties ───────────────────────────────────────────────────────────────
incorporationRouter.get('/cases/:id/parties', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const row = await loadCase(session, scope, req.params.id)
  const parties = await prisma.incorporationParty.findMany({
    where: { ...alive, caseId: row.id },
    include: { clientContact: true },
    orderBy: { sortOrder: 'asc' },
  })
  ok(res, {
    items: parties.map(partyToApi),
    count: parties.length,
    /// The roles THIS entity type uses — the form renders exactly these, so a
    /// proprietorship is never offered a designated partner.
    roles: rolesOf(row.entityType).map((v) => ({ value: v, label: PARTY_ROLE_LABELS[v] ?? v })),
  })
}))

incorporationRouter.post('/cases/:id/parties', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const row = await loadCase(session, scope, req.params.id)
  const b = body(req)
  const f = new FieldErrors()

  const roles = rolesOf(row.entityType)
  const role = f.oneOf('role', b.role, roles as readonly string[])
  const name = f.str('name', b.name, { max: 160 })
  const contactNumber = b.contact_number ? f.phone('contact_number', b.contact_number, false) : null
  const email = b.email ? f.email('email', b.email, false) : null
  const address = f.str('address', b.address, { required: false, max: 500 })
  f.throwIfAny()

  if (row.entityType.maxParties !== null) {
    const count = await prisma.incorporationParty.count({ where: { ...alive, caseId: row.id } })
    if (count >= row.entityType.maxParties) {
      throw ApiError.unprocessable('party_limit',
        `${row.entityType.name} takes at most ${row.entityType.maxParties} people.`)
    }
  }

  const max = await prisma.incorporationParty.aggregate({ where: { caseId: row.id }, _max: { sortOrder: true } })
  const party = await prisma.incorporationParty.create({
    data: {
      caseId: row.id,
      role: role!,
      name: name!,
      contactNumber: contactNumber ?? null,
      email: email ?? null,
      address: address ?? null,
      clientContactId: typeof b.client_contact_id === 'string' && b.client_contact_id ? b.client_contact_id : null,
      dscRequired: b.dsc_required === undefined ? true : !!b.dsc_required,
      sortOrder: (max._max.sortOrder ?? -1) + 1,
      notes: f.str('notes', b.notes, { required: false, max: 500 }) ?? null,
      createdBy: session.userId,
    },
    include: { clientContact: true },
  })
  await trail(req, session, row.id, 'incorporation.party.added',
    `${PARTY_ROLE_LABELS[party.role] ?? party.role} added: ${party.name}.`, undefined, party)
  ok(res, partyToApi(party), 201)
}))

incorporationRouter.patch('/parties/:partyId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await prisma.incorporationParty.findFirst({ where: { ...alive, id: req.params.partyId } })
  if (!existing) throw ApiError.notFound('No such person on this case.')
  const row = await loadCase(session, scope, existing.caseId)
  const b = body(req)
  const f = new FieldErrors()

  const data: Record<string, unknown> = {}
  if (b.role !== undefined) data.role = f.oneOf('role', b.role, rolesOf(row.entityType) as readonly string[])
  if (b.name !== undefined) data.name = f.str('name', b.name, { max: 160 })
  if (b.contact_number !== undefined) data.contactNumber = b.contact_number ? f.phone('contact_number', b.contact_number, false) ?? null : null
  if (b.email !== undefined) data.email = b.email ? f.email('email', b.email, false) ?? null : null
  if (b.address !== undefined) data.address = f.str('address', b.address, { required: false, max: 500 }) ?? null
  if (b.notes !== undefined) data.notes = f.str('notes', b.notes, { required: false, max: 500 }) ?? null
  if (b.dsc_required !== undefined) data.dscRequired = !!b.dsc_required
  if (b.client_contact_id !== undefined) data.clientContactId = (b.client_contact_id as string) || null
  f.throwIfAny()

  const party = await prisma.incorporationParty.update({
    where: { id: existing.id },
    data: { ...data, updatedBy: session.userId },
    include: { clientContact: true },
  })
  await trail(req, session, row.id, 'incorporation.party.updated', `${party.name} updated.`, existing, party)
  ok(res, partyToApi(party))
}))

incorporationRouter.delete('/parties/:partyId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await prisma.incorporationParty.findFirst({ where: { ...alive, id: req.params.partyId } })
  if (!existing) throw ApiError.notFound('No such person on this case.')
  await loadCase(session, scope, existing.caseId)
  // Soft delete, per the schema-wide convention — the DSC row that references
  // this person stays readable in the case history.
  await prisma.incorporationParty.update({
    where: { id: existing.id },
    data: { deletedAt: new Date(), updatedBy: session.userId },
  })
  await trail(req, session, existing.caseId, 'incorporation.party.removed',
    `${existing.name} removed from the case.`, existing, null)
  ok(res, { id: existing.id, deleted: true })
}))

// ── Checklist ─────────────────────────────────────────────────────────────
incorporationRouter.get('/cases/:id/checklist', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const row = await loadCase(session, scope, req.params.id)
  const items = await prisma.incorporationChecklistItem.findMany({
    where: { caseId: row.id },
    orderBy: { sortOrder: 'asc' },
  })
  const m = await employeeMap(items.flatMap((i) => [i.assignedEmployeeId, i.completedByEmployeeId]))
  ok(res, {
    items: items.map((i) => checklistItemToApi(i, m)),
    count: items.length,
    progress: progressFrom(items),
  })
}))

incorporationRouter.patch('/checklist-items/:itemId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await prisma.incorporationChecklistItem.findFirst({ where: { id: req.params.itemId } })
  if (!existing) throw ApiError.notFound('No such checklist item.')
  await loadCase(session, scope, existing.caseId)
  const b = body(req)
  const f = new FieldErrors()

  const status = b.status === undefined ? undefined : f.oneOf('status', b.status, CHECKLIST_STATUSES)
  const remarks = b.remarks === undefined ? undefined : f.str('remarks', b.remarks, { required: false, max: 1000 })
  const dueDate = b.due_date === undefined ? undefined : f.date('due_date', b.due_date, false)
  f.throwIfAny()

  const completing = status === 'completed' && existing.status !== 'completed'
  const item = await prisma.incorporationChecklistItem.update({
    where: { id: existing.id },
    data: {
      ...(status !== undefined ? { status } : {}),
      ...(remarks !== undefined ? { remarks: remarks ?? null } : {}),
      ...(dueDate !== undefined ? { dueDate: dueDate ?? null } : {}),
      ...(b.assigned_employee_id !== undefined ? { assignedEmployeeId: (b.assigned_employee_id as string) || null } : {}),
      ...(completing
        ? { completedAt: new Date(), completedByEmployeeId: session.employeeId }
        : status !== undefined && status !== 'completed'
          ? { completedAt: null, completedByEmployeeId: null }
          : {}),
    },
  })
  await trail(req, session, existing.caseId, 'incorporation.checklist_item.updated',
    `Checklist · ${item.label} → ${item.status.replace(/_/g, ' ')}.`, existing, item)
  const m = await employeeMap([item.assignedEmployeeId, item.completedByEmployeeId])
  ok(res, checklistItemToApi(item, m))
}))

// POST /api/incorporation/cases/:id/checklist/apply-template — re-applies the
// entity type's templates, ADDING anything missing. It never resets or
// removes an item an employee has already worked.
incorporationRouter.post('/cases/:id/checklist/apply-template', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const row = await loadCase(session, scope, req.params.id)

  const added = await prisma.$transaction(async (tx) => {
    const [templates, existing] = await Promise.all([
      tx.incorporationChecklistTemplate.findMany({
        where: { deletedAt: null, isActive: true, OR: [{ entityTypeId: null }, { entityTypeId: row.entityTypeId }] },
        orderBy: { sortOrder: 'asc' },
      }),
      tx.incorporationChecklistItem.findMany({ where: { caseId: row.id }, select: { label: true, sortOrder: true } }),
    ])
    const have = new Set(existing.map((e) => e.label))
    const missing = templates.filter((t) => !have.has(t.label))
    if (missing.length === 0) return 0
    let order = Math.max(-1, ...existing.map((e) => e.sortOrder))
    await tx.incorporationChecklistItem.createMany({
      data: missing.map((t) => ({
        caseId: row.id, templateId: t.id, category: t.category, label: t.label,
        stage: t.stage, sortOrder: ++order,
      })),
    })
    return missing.length
  })

  if (added > 0) {
    await trail(req, session, row.id, 'incorporation.checklist.template_applied',
      `${added} checklist item${added === 1 ? '' : 's'} added from the ${row.entityType.name} template.`)
  }
  ok(res, { added })
}))

// ── Document requests ─────────────────────────────────────────────────────
// FILES LIVE IN THE EXISTING DOCUMENTS MODULE. These rows are the ASK, and
// `client_document_id` is the link to the delivered file. This module has no
// uploader of its own.
incorporationRouter.get('/cases/:id/documents', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const row = await loadCase(session, scope, req.params.id)

  const [items, available] = await Promise.all([
    prisma.incorporationDocumentRequest.findMany({
      where: { ...alive, caseId: row.id },
      include: { clientDocument: { select: { id: true, name: true, status: true, currentVersion: true } } },
      orderBy: [{ category: 'asc' }, { createdAt: 'asc' }],
    }),
    // What is already on file for this client, so a request is LINKED to an
    // existing document rather than the same PDF being uploaded twice.
    prisma.clientDocument.findMany({
      where: { ...alive, clientId: row.clientId },
      select: { id: true, name: true, status: true, currentVersion: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  ])
  const m = await employeeMap(items.flatMap((i) => [i.requestedByEmployeeId, i.reviewedByEmployeeId]))
  ok(res, {
    items: items.map((i) => documentRequestToApi(i, m)),
    count: items.length,
    available_documents: available,
  })
}))

incorporationRouter.post('/cases/:id/documents', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const row = await loadCase(session, scope, req.params.id)
  const b = body(req)
  const f = new FieldErrors()

  const category = f.oneOf('category', b.category ?? 'other', DOC_CATEGORIES)
  const documentType = f.str('document_type', b.document_type, { max: 160 })
  const description = f.str('description', b.description, { required: false, max: 500 })
  const dueDate = f.date('due_date', b.due_date, false)
  const status = f.oneOf('status', b.status ?? 'requested', DOCREQ_STATUSES)
  f.throwIfAny()

  const item = await prisma.incorporationDocumentRequest.create({
    data: {
      caseId: row.id,
      clientId: row.clientId,
      partyId: typeof b.party_id === 'string' && b.party_id ? b.party_id : null,
      category: category!,
      documentType: documentType!,
      description: description ?? null,
      status: status!,
      dueDate: dueDate ?? null,
      requestedByEmployeeId: session.employeeId,
      requestedAt: status === 'required' ? null : new Date(),
      createdBy: session.userId,
    },
    include: { clientDocument: { select: { id: true, name: true, status: true, currentVersion: true } } },
  })
  await trail(req, session, row.id, 'incorporation.document.requested',
    `Document requested: ${item.documentType}.`, undefined, item)
  const m = await employeeMap([item.requestedByEmployeeId])
  ok(res, documentRequestToApi(item, m), 201)
}))

incorporationRouter.patch('/document-requests/:reqId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await prisma.incorporationDocumentRequest.findFirst({ where: { ...alive, id: req.params.reqId } })
  if (!existing) throw ApiError.notFound('No such document request.')
  await loadCase(session, scope, existing.caseId)
  const b = body(req)
  const f = new FieldErrors()

  const status = b.status === undefined ? undefined : f.oneOf('status', b.status, DOCREQ_STATUSES)
  const dueDate = b.due_date === undefined ? undefined : f.date('due_date', b.due_date, false)
  const description = b.description === undefined ? undefined : f.str('description', b.description, { required: false, max: 500 })
  const rejectionReason = b.rejection_reason === undefined ? undefined : f.str('rejection_reason', b.rejection_reason, { required: false, max: 500 })
  f.throwIfAny()

  if (status === 'rejected' && !(rejectionReason ?? existing.rejectionReason)) {
    throw ApiError.badRequest('Please correct the highlighted fields.', {
      rejection_reason: 'Say why the document was rejected.',
    })
  }

  const item = await prisma.incorporationDocumentRequest.update({
    where: { id: existing.id },
    data: {
      ...(status !== undefined ? { status } : {}),
      ...(dueDate !== undefined ? { dueDate: dueDate ?? null } : {}),
      ...(description !== undefined ? { description: description ?? null } : {}),
      ...(rejectionReason !== undefined ? { rejectionReason: rejectionReason ?? null } : {}),
      ...(status === 'received' && !existing.receivedAt ? { receivedAt: new Date() } : {}),
      ...(status === 'requested' && !existing.requestedAt
        ? { requestedAt: new Date(), requestedByEmployeeId: session.employeeId } : {}),
      ...(status === 'approved' || status === 'rejected'
        ? { reviewedByEmployeeId: session.employeeId } : {}),
      updatedBy: session.userId,
    },
    include: { clientDocument: { select: { id: true, name: true, status: true, currentVersion: true } } },
  })
  await trail(req, session, existing.caseId, 'incorporation.document.updated',
    `Document · ${item.documentType} → ${item.status.replace(/_/g, ' ')}.`, existing, item)
  const m = await employeeMap([item.requestedByEmployeeId, item.reviewedByEmployeeId])
  ok(res, documentRequestToApi(item, m))
}))

// POST /api/incorporation/document-requests/:reqId/link  { client_document_id }
// Links an EXISTING ClientDocument. Pass null to unlink.
incorporationRouter.post('/document-requests/:reqId/link', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await prisma.incorporationDocumentRequest.findFirst({ where: { ...alive, id: req.params.reqId } })
  if (!existing) throw ApiError.notFound('No such document request.')
  await loadCase(session, scope, existing.caseId)
  const b = body(req)

  const raw = b.client_document_id
  const documentId = typeof raw === 'string' && raw ? raw : null

  if (documentId) {
    // The document must belong to THIS CASE'S CLIENT. Linking another
    // client's file would leak it through this case's Documents tab.
    const doc = await prisma.clientDocument.findFirst({
      where: { ...alive, id: documentId, clientId: existing.clientId },
      select: { id: true, name: true },
    })
    if (!doc) {
      throw ApiError.badRequest('Choose a document that belongs to this client.', {
        client_document_id: 'That document is not on this client’s file.',
      })
    }
  }

  const item = await prisma.incorporationDocumentRequest.update({
    where: { id: existing.id },
    data: {
      clientDocumentId: documentId,
      ...(documentId && existing.status === 'requested' ? { status: 'received', receivedAt: new Date() } : {}),
      updatedBy: session.userId,
    },
    include: { clientDocument: { select: { id: true, name: true, status: true, currentVersion: true } } },
  })
  await trail(req, session, existing.caseId,
    documentId ? 'incorporation.document.linked' : 'incorporation.document.unlinked',
    documentId
      ? `${item.documentType} linked to ${item.clientDocument?.name ?? 'a client document'}.`
      : `${item.documentType} unlinked from its client document.`,
    existing, item)
  const m = await employeeMap([item.requestedByEmployeeId, item.reviewedByEmployeeId])
  ok(res, documentRequestToApi(item, m))
}))

// ── DSC (tracking only) ───────────────────────────────────────────────────
// This module performs NO DSC operation. It records what an employee did with
// a token elsewhere. `verified` means an employee physically checked it.
incorporationRouter.get('/cases/:id/dsc', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const row = await loadCase(session, scope, req.params.id)
  const [items, parties] = await Promise.all([
    prisma.incorporationDsc.findMany({
      where: { ...alive, caseId: row.id },
      include: { party: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.incorporationParty.findMany({
      where: { ...alive, caseId: row.id },
      select: { id: true, name: true, role: true, dscRequired: true },
      orderBy: { sortOrder: 'asc' },
    }),
  ])
  const m = await employeeMap(items.map((i) => i.recordedByEmployeeId))
  ok(res, { items: items.map((i) => dscToApi(i, m)), count: items.length, parties })
}))

incorporationRouter.post('/cases/:id/dsc', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const row = await loadCase(session, scope, req.params.id)
  const b = body(req)
  const f = new FieldErrors()

  const partyId = f.str('party_id', b.party_id)
  const status = f.oneOf('status', b.status ?? 'pending', DSC_STATUSES)
  const provider = f.str('provider', b.provider, { required: false, max: 120 })
  const referenceNo = f.str('reference_no', b.reference_no, { required: false, max: 120 })
  const requestDate = f.date('request_date', b.request_date, false)
  const receivedDate = f.date('received_date', b.received_date, false)
  const expiryDate = f.date('expiry_date', b.expiry_date, false)
  const remarks = f.str('remarks', b.remarks, { required: false, max: 500 })
  f.throwIfAny()

  const party = await prisma.incorporationParty.findFirst({ where: { ...alive, id: partyId!, caseId: row.id } })
  if (!party) throw ApiError.badRequest('Choose a person on this case.', { party_id: 'Unknown person.' })

  const existing = await prisma.incorporationDsc.findFirst({ where: { caseId: row.id, partyId: partyId! } })
  if (existing) {
    throw ApiError.conflict('dsc_exists', `${party.name} already has a DSC record on this case.`)
  }

  const item = await prisma.incorporationDsc.create({
    data: {
      caseId: row.id,
      partyId: partyId!,
      required: b.required === undefined ? true : !!b.required,
      status: status!,
      provider: provider ?? null,
      referenceNo: referenceNo ?? null,
      requestDate: requestDate ?? null,
      receivedDate: receivedDate ?? null,
      expiryDate: expiryDate ?? null,
      remarks: remarks ?? null,
      ...stamp(session),
      createdBy: session.userId,
    },
    include: { party: true },
  })
  await trail(req, session, row.id, 'incorporation.dsc.recorded',
    `DSC recorded for ${party.name} · ${item.status.replace(/_/g, ' ')}.`, undefined, item)
  const m = await employeeMap([item.recordedByEmployeeId])
  ok(res, dscToApi(item, m), 201)
}))

incorporationRouter.patch('/dsc/:dscId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await prisma.incorporationDsc.findFirst({ where: { ...alive, id: req.params.dscId }, include: { party: true } })
  if (!existing) throw ApiError.notFound('No such DSC record.')
  await loadCase(session, scope, existing.caseId)
  const b = body(req)
  const f = new FieldErrors()

  const data: Record<string, unknown> = {}
  if (b.status !== undefined) data.status = f.oneOf('status', b.status, DSC_STATUSES)
  if (b.required !== undefined) data.required = !!b.required
  if (b.provider !== undefined) data.provider = f.str('provider', b.provider, { required: false, max: 120 }) ?? null
  if (b.reference_no !== undefined) data.referenceNo = f.str('reference_no', b.reference_no, { required: false, max: 120 }) ?? null
  if (b.request_date !== undefined) data.requestDate = f.date('request_date', b.request_date, false) ?? null
  if (b.received_date !== undefined) data.receivedDate = f.date('received_date', b.received_date, false) ?? null
  if (b.expiry_date !== undefined) data.expiryDate = f.date('expiry_date', b.expiry_date, false) ?? null
  if (b.remarks !== undefined) data.remarks = f.str('remarks', b.remarks, { required: false, max: 500 }) ?? null
  f.throwIfAny()

  // Re-stamp: this row now records a NEW observation by whoever just made it.
  const item = await prisma.incorporationDsc.update({
    where: { id: existing.id },
    data: { ...data, ...stamp(session), updatedBy: session.userId },
    include: { party: true },
  })
  await trail(req, session, existing.caseId, 'incorporation.dsc.updated',
    `DSC · ${item.party.name} → ${item.status.replace(/_/g, ' ')}.`, existing, item)
  const m = await employeeMap([item.recordedByEmployeeId])
  ok(res, dscToApi(item, m))
}))

// ── Proposed names ────────────────────────────────────────────────────────
incorporationRouter.get('/cases/:id/names', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const row = await loadCase(session, scope, req.params.id)
  const items = await prisma.incorporationName.findMany({
    where: { ...alive, caseId: row.id },
    orderBy: { priority: 'asc' },
  })
  const m = await employeeMap(items.map((i) => i.recordedByEmployeeId))
  ok(res, { items: items.map((i) => nameToApi(i, m)), count: items.length })
}))

incorporationRouter.post('/cases/:id/names', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const row = await loadCase(session, scope, req.params.id)
  const b = body(req)
  const f = new FieldErrors()

  const proposedName = f.str('proposed_name', b.proposed_name, { max: 200 })
  const status = f.oneOf('status', b.status ?? 'draft', NAME_STATUSES)
  const priorityRaw = Number(b.priority ?? 0)
  const remarks = f.str('remarks', b.remarks, { required: false, max: 500 })
  f.throwIfAny()

  // Priority is unique per case; default to the next free slot rather than
  // failing on a constraint the caller never chose.
  let priority = Number.isFinite(priorityRaw) && priorityRaw > 0 ? Math.floor(priorityRaw) : 0
  if (priority === 0) {
    const max = await prisma.incorporationName.aggregate({ where: { caseId: row.id }, _max: { priority: true } })
    priority = (max._max.priority ?? 0) + 1
  } else {
    const clash = await prisma.incorporationName.findFirst({ where: { caseId: row.id, priority } })
    if (clash) {
      throw ApiError.badRequest('Please correct the highlighted fields.', {
        priority: `Preference ${priority} is already taken by "${clash.proposedName}".`,
      })
    }
  }

  const item = await prisma.incorporationName.create({
    data: {
      caseId: row.id,
      proposedName: proposedName!,
      priority,
      status: status!,
      submissionDate: f.date('submission_date', b.submission_date, false) ?? null,
      applicationRef: f.str('application_ref', b.application_ref, { required: false, max: 120 }) ?? null,
      responseDate: f.date('response_date', b.response_date, false) ?? null,
      remarks: remarks ?? null,
      ...stamp(session),
      createdBy: session.userId,
    },
  })
  await trail(req, session, row.id, 'incorporation.name.added',
    `Name option ${priority}: ${item.proposedName}.`, undefined, item)
  const m = await employeeMap([item.recordedByEmployeeId])
  ok(res, nameToApi(item, m), 201)
}))

incorporationRouter.patch('/names/:nameId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await prisma.incorporationName.findFirst({ where: { ...alive, id: req.params.nameId } })
  if (!existing) throw ApiError.notFound('No such name option.')
  await loadCase(session, scope, existing.caseId)
  const b = body(req)
  const f = new FieldErrors()

  const data: Record<string, unknown> = {}
  if (b.proposed_name !== undefined) data.proposedName = f.str('proposed_name', b.proposed_name, { max: 200 })
  if (b.status !== undefined) data.status = f.oneOf('status', b.status, NAME_STATUSES)
  if (b.submission_date !== undefined) data.submissionDate = f.date('submission_date', b.submission_date, false) ?? null
  if (b.application_ref !== undefined) data.applicationRef = f.str('application_ref', b.application_ref, { required: false, max: 120 }) ?? null
  if (b.response_date !== undefined) data.responseDate = f.date('response_date', b.response_date, false) ?? null
  if (b.remarks !== undefined) data.remarks = f.str('remarks', b.remarks, { required: false, max: 500 }) ?? null
  if (b.priority !== undefined) {
    const p = Math.floor(Number(b.priority))
    if (!Number.isFinite(p) || p < 1) f.add('priority', 'Enter a preference number of 1 or more.')
    else {
      const clash = await prisma.incorporationName.findFirst({
        where: { caseId: existing.caseId, priority: p, id: { not: existing.id } },
      })
      if (clash) f.add('priority', `Preference ${p} is already taken by "${clash.proposedName}".`)
      else data.priority = p
    }
  }
  f.throwIfAny()

  const item = await prisma.incorporationName.update({
    where: { id: existing.id },
    data: { ...data, ...stamp(session), updatedBy: session.userId },
  })
  await trail(req, session, existing.caseId, 'incorporation.name.status_recorded',
    `Name "${item.proposedName}" → ${item.status.replace(/_/g, ' ')}`
    + (item.applicationRef ? ` · ref ${item.applicationRef}` : '') + '.', existing, item)
  const m = await employeeMap([item.recordedByEmployeeId])
  ok(res, nameToApi(item, m))
}))

// ── Filings ───────────────────────────────────────────────────────────────
incorporationRouter.get('/cases/:id/filings', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const row = await loadCase(session, scope, req.params.id)
  const items = await prisma.incorporationFiling.findMany({
    where: { ...alive, caseId: row.id },
    include: { clientDocument: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  })
  const m = await employeeMap(items.flatMap((i) => [i.assignedEmployeeId, i.recordedByEmployeeId]))
  ok(res, { items: items.map((i) => filingToApi(i, m)), count: items.length })
}))

incorporationRouter.post('/cases/:id/filings', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const row = await loadCase(session, scope, req.params.id)
  const b = body(req)
  const f = new FieldErrors()

  const filingType = f.oneOf('filing_type', b.filing_type, FILING_TYPES)
  const status = f.oneOf('status', b.status ?? 'not_started', FILING_STATUSES)
  f.throwIfAny()

  const item = await prisma.incorporationFiling.create({
    data: {
      caseId: row.id,
      filingType: filingType!,
      status: status!,
      portal: f.str('portal', b.portal, { required: false, max: 120 }) ?? null,
      applicationRef: f.str('application_ref', b.application_ref, { required: false, max: 120 }) ?? null,
      acknowledgementRef: f.str('acknowledgement_ref', b.acknowledgement_ref, { required: false, max: 120 }) ?? null,
      preparedDate: f.date('prepared_date', b.prepared_date, false) ?? null,
      submittedDate: f.date('submitted_date', b.submitted_date, false) ?? null,
      assignedEmployeeId: (b.assigned_employee_id as string) || row.assignedEmployeeId,
      remarks: f.str('remarks', b.remarks, { required: false, max: 1000 }) ?? null,
      ...stamp(session),
      createdBy: session.userId,
    },
    include: { clientDocument: { select: { id: true, name: true } } },
  })
  await trail(req, session, row.id, 'incorporation.filing.recorded',
    `Filing recorded: ${item.filingType.replace(/_/g, ' ')} · ${item.status.replace(/_/g, ' ')}.`, undefined, item)
  const m = await employeeMap([item.assignedEmployeeId, item.recordedByEmployeeId])
  ok(res, filingToApi(item, m), 201)
}))

incorporationRouter.patch('/filings/:filingId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await prisma.incorporationFiling.findFirst({ where: { ...alive, id: req.params.filingId } })
  if (!existing) throw ApiError.notFound('No such filing.')
  await loadCase(session, scope, existing.caseId)
  const b = body(req)
  const f = new FieldErrors()

  const data: Record<string, unknown> = {}
  if (b.filing_type !== undefined) data.filingType = f.oneOf('filing_type', b.filing_type, FILING_TYPES)
  if (b.status !== undefined) data.status = f.oneOf('status', b.status, FILING_STATUSES)
  if (b.portal !== undefined) data.portal = f.str('portal', b.portal, { required: false, max: 120 }) ?? null
  if (b.application_ref !== undefined) data.applicationRef = f.str('application_ref', b.application_ref, { required: false, max: 120 }) ?? null
  if (b.acknowledgement_ref !== undefined) data.acknowledgementRef = f.str('acknowledgement_ref', b.acknowledgement_ref, { required: false, max: 120 }) ?? null
  if (b.prepared_date !== undefined) data.preparedDate = f.date('prepared_date', b.prepared_date, false) ?? null
  if (b.submitted_date !== undefined) data.submittedDate = f.date('submitted_date', b.submitted_date, false) ?? null
  if (b.remarks !== undefined) data.remarks = f.str('remarks', b.remarks, { required: false, max: 1000 }) ?? null
  if (b.assigned_employee_id !== undefined) data.assignedEmployeeId = (b.assigned_employee_id as string) || null
  if (b.client_document_id !== undefined) data.clientDocumentId = (b.client_document_id as string) || null
  f.throwIfAny()

  const item = await prisma.incorporationFiling.update({
    where: { id: existing.id },
    data: { ...data, ...stamp(session), updatedBy: session.userId },
    include: { clientDocument: { select: { id: true, name: true } } },
  })
  await trail(req, session, existing.caseId, 'incorporation.filing.updated',
    `Filing ${item.filingType.replace(/_/g, ' ')} → ${item.status.replace(/_/g, ' ')}`
    + (item.applicationRef ? ` · ref ${item.applicationRef}` : '') + '.', existing, item)
  const m = await employeeMap([item.assignedEmployeeId, item.recordedByEmployeeId])
  ok(res, filingToApi(item, m))
}))

// ── Government queries ────────────────────────────────────────────────────
incorporationRouter.get('/cases/:id/queries', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const row = await loadCase(session, scope, req.params.id)
  const [items, filings] = await Promise.all([
    prisma.incorporationQuery.findMany({
      where: { ...alive, caseId: row.id },
      include: { filing: true, clientDocument: { select: { id: true, name: true } } },
      orderBy: [{ responseDueDate: 'asc' }, { queryDate: 'desc' }],
    }),
    prisma.incorporationFiling.findMany({
      where: { ...alive, caseId: row.id },
      select: { id: true, filingType: true, applicationRef: true },
    }),
  ])
  const m = await employeeMap(items.flatMap((i) => [i.assignedEmployeeId, i.recordedByEmployeeId]))
  ok(res, { items: items.map((i) => queryToApi(i, m)), count: items.length, filings })
}))

incorporationRouter.post('/cases/:id/queries', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const row = await loadCase(session, scope, req.params.id)
  const b = body(req)
  const f = new FieldErrors()

  const queryDate = f.date('query_date', b.query_date, true)
  const description = f.str('description', b.description, { max: 4000 })
  const status = f.oneOf('status', b.status ?? 'new', QUERY_STATUSES)
  f.throwIfAny()

  const item = await prisma.incorporationQuery.create({
    data: {
      caseId: row.id,
      filingId: (b.filing_id as string) || null,
      queryDate: queryDate!,
      authority: f.str('authority', b.authority, { required: false, max: 160 }) ?? null,
      description: description!,
      assignedEmployeeId: (b.assigned_employee_id as string) || row.assignedEmployeeId,
      responseDueDate: f.date('response_due_date', b.response_due_date, false) ?? null,
      remarks: f.str('remarks', b.remarks, { required: false, max: 1000 }) ?? null,
      status: status!,
      ...stamp(session),
      createdBy: session.userId,
    },
    include: { filing: true, clientDocument: { select: { id: true, name: true } } },
  })
  await trail(req, session, row.id, 'incorporation.query.recorded',
    `Government query recorded${item.authority ? ` (${item.authority})` : ''}.`, undefined, item)
  const m = await employeeMap([item.assignedEmployeeId, item.recordedByEmployeeId])
  ok(res, queryToApi(item, m), 201)
}))

incorporationRouter.patch('/queries/:queryId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await prisma.incorporationQuery.findFirst({ where: { ...alive, id: req.params.queryId } })
  if (!existing) throw ApiError.notFound('No such query.')
  await loadCase(session, scope, existing.caseId)
  const b = body(req)
  const f = new FieldErrors()

  const data: Record<string, unknown> = {}
  if (b.status !== undefined) data.status = f.oneOf('status', b.status, QUERY_STATUSES)
  if (b.authority !== undefined) data.authority = f.str('authority', b.authority, { required: false, max: 160 }) ?? null
  if (b.description !== undefined) data.description = f.str('description', b.description, { max: 4000 })
  if (b.response !== undefined) data.response = f.str('response', b.response, { required: false, max: 4000 }) ?? null
  if (b.response_submitted_date !== undefined) data.responseSubmittedDate = f.date('response_submitted_date', b.response_submitted_date, false) ?? null
  if (b.resubmission_ref !== undefined) data.resubmissionRef = f.str('resubmission_ref', b.resubmission_ref, { required: false, max: 120 }) ?? null
  if (b.resolution !== undefined) data.resolution = f.str('resolution', b.resolution, { required: false, max: 2000 }) ?? null
  if (b.remarks !== undefined) data.remarks = f.str('remarks', b.remarks, { required: false, max: 1000 }) ?? null
  if (b.response_due_date !== undefined) data.responseDueDate = f.date('response_due_date', b.response_due_date, false) ?? null
  if (b.query_date !== undefined) data.queryDate = f.date('query_date', b.query_date, true)
  if (b.assigned_employee_id !== undefined) data.assignedEmployeeId = (b.assigned_employee_id as string) || null
  if (b.filing_id !== undefined) data.filingId = (b.filing_id as string) || null
  if (b.client_document_id !== undefined) data.clientDocumentId = (b.client_document_id as string) || null
  f.throwIfAny()

  if (data.status === 'resolved' && !(data.resolution ?? existing.resolution)) {
    throw ApiError.badRequest('Please correct the highlighted fields.', {
      resolution: 'Record how the query was resolved before closing it.',
    })
  }

  const item = await prisma.incorporationQuery.update({
    where: { id: existing.id },
    data: { ...data, ...stamp(session), updatedBy: session.userId },
    include: { filing: true, clientDocument: { select: { id: true, name: true } } },
  })

  const respondedNow = data.response !== undefined && data.response !== existing.response
  const resubmittedNow = data.resubmission_ref !== undefined
    || (data.resubmissionRef !== undefined && data.resubmissionRef !== existing.resubmissionRef)
  await trail(req, session, existing.caseId,
    resubmittedNow ? 'incorporation.query.resubmission_recorded'
      : respondedNow ? 'incorporation.query.response_recorded'
        : 'incorporation.query.updated',
    resubmittedNow ? `Resubmission recorded${item.resubmissionRef ? ` · ref ${item.resubmissionRef}` : ''}.`
      : respondedNow ? 'Response to the government query recorded.'
        : `Query → ${item.status.replace(/_/g, ' ')}.`,
    existing, item)

  const m = await employeeMap([item.assignedEmployeeId, item.recordedByEmployeeId])
  ok(res, queryToApi(item, m))
}))

// ── Tasks ─────────────────────────────────────────────────────────────────
// THE EXISTING TASK MODEL. There is no second task engine and no second
// reminder engine here — a task raised from a case is a row in `Task`, linked
// by `incorporationCaseId`, and it shows up in the client's Tasks tab
// alongside every other task in the firm.
incorporationRouter.get('/cases/:id/tasks', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const row = await loadCase(session, scope, req.params.id)
  const items = await prisma.task.findMany({
    where: { ...alive, incorporationCaseId: row.id },
    orderBy: [{ dueDate: 'asc' }],
  })
  const m = await employeeMap(items.map((i) => i.assignedEmployeeId))
  ok(res, { items: items.map((i) => caseTaskToApi(i, m)), count: items.length, templates: TASK_TEMPLATES })
}))

incorporationRouter.post('/cases/:id/tasks', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const row = await loadCase(session, scope, req.params.id)
  const b = body(req)
  const f = new FieldErrors()

  // A one-click template fills the title and due date; everything stays
  // editable, and a bare title works just as well.
  const templateKey = typeof b.template === 'string' ? b.template : null
  const template = templateKey ? TASK_TEMPLATES.find((t) => t.key === templateKey) : null
  if (templateKey && !template) f.add('template', 'Unknown task template.')

  const title = b.title === undefined && template
    ? template.title
    : f.str('title', b.title, { max: 200 })
  const assignedEmployeeId = (b.assigned_employee_id as string) || row.assignedEmployeeId
  const dueDate = b.due_date === undefined && template
    ? addDays(today(), template.dueInDays)
    : f.date('due_date', b.due_date, false)
  const status = f.oneOf('status', b.status ?? 'open', TASK_STATUSES)
  const description = f.str('description', b.description, { required: false, max: 2000 })
  f.throwIfAny()

  const task = await prisma.task.create({
    data: {
      clientId: row.clientId,
      clientServiceId: row.clientServiceId,
      incorporationCaseId: row.id,
      title: title!,
      description: description ?? null,
      assignedEmployeeId,
      dueDate: dueDate ?? null,
      status: status!,
      createdBy: session.userId,
    },
  })
  await trail(req, session, row.id, 'incorporation.task.created', `Task created: ${task.title}.`, undefined, task)
  await notifyEmployee(assignedEmployeeId, {
    type: 'incorporation.task_assigned',
    module: 'system',
    title: 'Incorporation task assigned',
    body: `${task.title} — ${row.caseCode}`,
    entityType: 'Task',
    entityId: task.id,
    actionUrl: `/workstation/services/incorporation/cases/${row.id}`,
  })
  const m = await employeeMap([task.assignedEmployeeId])
  ok(res, caseTaskToApi(task, m), 201)
}))

incorporationRouter.patch('/tasks/:taskId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await prisma.task.findFirst({ where: { ...alive, id: req.params.taskId } })
  if (!existing) throw ApiError.notFound('No such task.')
  if (!existing.incorporationCaseId) {
    // A task belonging to another module is edited there, not here.
    throw ApiError.notFound('No such task.')
  }
  await loadCase(session, scope, existing.incorporationCaseId)
  const b = body(req)
  const f = new FieldErrors()

  const data: Record<string, unknown> = {}
  if (b.title !== undefined) data.title = f.str('title', b.title, { max: 200 })
  if (b.description !== undefined) data.description = f.str('description', b.description, { required: false, max: 2000 }) ?? null
  if (b.status !== undefined) data.status = f.oneOf('status', b.status, TASK_STATUSES)
  if (b.due_date !== undefined) data.dueDate = f.date('due_date', b.due_date, false) ?? null
  if (b.assigned_employee_id !== undefined) data.assignedEmployeeId = f.str('assigned_employee_id', b.assigned_employee_id)
  f.throwIfAny()

  const task = await prisma.task.update({
    where: { id: existing.id },
    data: { ...data, updatedBy: session.userId },
  })
  await trail(req, session, existing.incorporationCaseId, 'incorporation.task.updated',
    `Task "${task.title}" → ${task.status.replace(/_/g, ' ')}.`, existing, task)
  const m = await employeeMap([task.assignedEmployeeId])
  ok(res, caseTaskToApi(task, m))
}))

// ── Fees ──────────────────────────────────────────────────────────────────
// Amounts arrive in RUPEES from the form and are stored as integer PAISE,
// which is how money works everywhere else in this schema.
incorporationRouter.get('/cases/:id/fees', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const row = await loadCase(session, scope, req.params.id)
  const [items, services] = await Promise.all([
    prisma.incorporationFee.findMany({ where: { ...alive, caseId: row.id }, orderBy: { createdAt: 'asc' } }),
    // The client's existing service rows, so a fee can be attached to the
    // engagement it was actually billed under.
    prisma.clientService.findMany({
      where: { ...alive, clientId: row.clientId },
      include: { service: { select: { name: true } } },
    }),
  ])
  const m = await employeeMap(items.map((i) => i.recordedByEmployeeId))
  const billed = items.reduce((n, i) => n + i.amountPaise, 0)
  const received = items.reduce((n, i) => n + i.paidAmountPaise, 0)
  ok(res, {
    items: items.map((i) => feeToApi(i, m)),
    count: items.length,
    totals: { billed_paise: billed, received_paise: received, outstanding_paise: billed - received },
    client_services: services.map((s) => ({ id: s.id, name: s.service.name, status: s.status })),
  })
}))

incorporationRouter.post('/cases/:id/fees', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const row = await loadCase(session, scope, req.params.id)
  const b = body(req)
  const f = new FieldErrors()

  const category = f.oneOf('category', b.category ?? 'professional_fee', FEE_CATEGORIES)
  const amountPaise = f.rupeesToPaise('amount', b.amount, true)
  const status = f.oneOf('status', b.status ?? 'pending', FEE_STATUSES)
  f.throwIfAny()

  const item = await prisma.incorporationFee.create({
    data: {
      caseId: row.id,
      clientId: row.clientId,
      category: category!,
      description: f.str('description', b.description, { required: false, max: 500 }) ?? null,
      amountPaise: amountPaise!,
      status: status!,
      clientServiceId: (b.client_service_id as string) || row.clientServiceId,
      invoiceRef: f.str('invoice_ref', b.invoice_ref, { required: false, max: 120 }) ?? null,
      dueDate: f.date('due_date', b.due_date, false) ?? null,
      notes: f.str('notes', b.notes, { required: false, max: 500 }) ?? null,
      recordedByEmployeeId: session.employeeId,
      createdBy: session.userId,
    },
  })
  await trail(req, session, row.id, 'incorporation.fee.recorded',
    `Fee recorded: ${item.category.replace(/_/g, ' ')} ₹${(item.amountPaise / 100).toFixed(2)}.`, undefined, item)
  const m = await employeeMap([item.recordedByEmployeeId])
  ok(res, feeToApi(item, m), 201)
}))

incorporationRouter.patch('/fees/:feeId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await prisma.incorporationFee.findFirst({ where: { ...alive, id: req.params.feeId } })
  if (!existing) throw ApiError.notFound('No such fee.')
  await loadCase(session, scope, existing.caseId)
  const b = body(req)
  const f = new FieldErrors()

  const data: Record<string, unknown> = {}
  if (b.category !== undefined) data.category = f.oneOf('category', b.category, FEE_CATEGORIES)
  if (b.status !== undefined) data.status = f.oneOf('status', b.status, FEE_STATUSES)
  if (b.amount !== undefined) data.amountPaise = f.rupeesToPaise('amount', b.amount, true)
  if (b.paid_amount !== undefined) data.paidAmountPaise = f.rupeesToPaise('paid_amount', b.paid_amount, false)
  if (b.description !== undefined) data.description = f.str('description', b.description, { required: false, max: 500 }) ?? null
  if (b.invoice_ref !== undefined) data.invoiceRef = f.str('invoice_ref', b.invoice_ref, { required: false, max: 120 }) ?? null
  if (b.due_date !== undefined) data.dueDate = f.date('due_date', b.due_date, false) ?? null
  if (b.paid_date !== undefined) data.paidDate = f.date('paid_date', b.paid_date, false) ?? null
  if (b.notes !== undefined) data.notes = f.str('notes', b.notes, { required: false, max: 500 }) ?? null
  if (b.client_service_id !== undefined) data.clientServiceId = (b.client_service_id as string) || null
  f.throwIfAny()

  const item = await prisma.incorporationFee.update({
    where: { id: existing.id },
    data: { ...data, recordedByEmployeeId: session.employeeId, updatedBy: session.userId },
  })
  await trail(req, session, existing.caseId, 'incorporation.fee.updated',
    `Fee ${item.category.replace(/_/g, ' ')} → ${item.status.replace(/_/g, ' ')}.`, existing, item)
  const m = await employeeMap([item.recordedByEmployeeId])
  ok(res, feeToApi(item, m))
}))

// ── Deliverables ──────────────────────────────────────────────────────────
incorporationRouter.get('/cases/:id/deliverables', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const row = await loadCase(session, scope, req.params.id)
  const [items, available] = await Promise.all([
    prisma.incorporationDeliverable.findMany({
      where: { ...alive, caseId: row.id },
      include: { clientDocument: { select: { id: true, name: true, currentVersion: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.clientDocument.findMany({
      where: { ...alive, clientId: row.clientId },
      select: { id: true, name: true, status: true, currentVersion: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
  ])
  const m = await employeeMap(items.flatMap((i) => [i.deliveredByEmployeeId, i.recordedByEmployeeId]))
  ok(res, {
    items: items.map((i) => deliverableToApi(i, m)),
    count: items.length,
    available_documents: available,
  })
}))

incorporationRouter.post('/cases/:id/deliverables', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const row = await loadCase(session, scope, req.params.id)
  const b = body(req)
  const f = new FieldErrors()

  const name = f.str('name', b.name, { max: 200 })
  const type = f.oneOf('type', b.type ?? 'other', DELIVERABLE_TYPES)
  const status = f.oneOf('status', b.status ?? 'pending', DELIVERABLE_STATUSES)
  f.throwIfAny()

  const documentId = (b.client_document_id as string) || null
  if (documentId) {
    const doc = await prisma.clientDocument.findFirst({
      where: { ...alive, id: documentId, clientId: row.clientId }, select: { id: true },
    })
    if (!doc) {
      throw ApiError.badRequest('Choose a document that belongs to this client.', {
        client_document_id: 'That document is not on this client’s file.',
      })
    }
  }

  const item = await prisma.incorporationDeliverable.create({
    data: {
      caseId: row.id,
      clientId: row.clientId,
      name: name!,
      type: type!,
      status: status!,
      clientDocumentId: documentId,
      preparedDate: f.date('prepared_date', b.prepared_date, false) ?? null,
      deliveredDate: f.date('delivered_date', b.delivered_date, false) ?? null,
      referenceNo: f.str('reference_no', b.reference_no, { required: false, max: 120 }) ?? null,
      notes: f.str('notes', b.notes, { required: false, max: 1000 }) ?? null,
      ...stamp(session),
      createdBy: session.userId,
    },
    include: { clientDocument: { select: { id: true, name: true, currentVersion: true } } },
  })
  await trail(req, session, row.id, 'incorporation.deliverable.added',
    `Deliverable added: ${item.name}.`, undefined, item)
  const m = await employeeMap([item.recordedByEmployeeId])
  ok(res, deliverableToApi(item, m), 201)
}))

incorporationRouter.patch('/deliverables/:delId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await prisma.incorporationDeliverable.findFirst({ where: { ...alive, id: req.params.delId } })
  if (!existing) throw ApiError.notFound('No such deliverable.')
  await loadCase(session, scope, existing.caseId)
  const b = body(req)
  const f = new FieldErrors()

  const data: Record<string, unknown> = {}
  if (b.name !== undefined) data.name = f.str('name', b.name, { max: 200 })
  if (b.type !== undefined) data.type = f.oneOf('type', b.type, DELIVERABLE_TYPES)
  if (b.status !== undefined) data.status = f.oneOf('status', b.status, DELIVERABLE_STATUSES)
  if (b.prepared_date !== undefined) data.preparedDate = f.date('prepared_date', b.prepared_date, false) ?? null
  if (b.delivered_date !== undefined) data.deliveredDate = f.date('delivered_date', b.delivered_date, false) ?? null
  if (b.reference_no !== undefined) data.referenceNo = f.str('reference_no', b.reference_no, { required: false, max: 120 }) ?? null
  if (b.notes !== undefined) data.notes = f.str('notes', b.notes, { required: false, max: 1000 }) ?? null
  if (b.client_document_id !== undefined) {
    const documentId = (b.client_document_id as string) || null
    if (documentId) {
      const doc = await prisma.clientDocument.findFirst({
        where: { ...alive, id: documentId, clientId: existing.clientId }, select: { id: true },
      })
      if (!doc) f.add('client_document_id', 'That document is not on this client’s file.')
    }
    data.clientDocumentId = documentId
  }
  f.throwIfAny()

  if (data.status === 'delivered') {
    data.deliveredByEmployeeId = session.employeeId
    if (!existing.deliveredDate && data.deliveredDate === undefined) data.deliveredDate = today()
  }

  const item = await prisma.incorporationDeliverable.update({
    where: { id: existing.id },
    data: { ...data, ...stamp(session), updatedBy: session.userId },
    include: { clientDocument: { select: { id: true, name: true, currentVersion: true } } },
  })
  await trail(req, session, existing.caseId, 'incorporation.deliverable.updated',
    `Deliverable "${item.name}" → ${item.status}.`, existing, item)
  const m = await employeeMap([item.deliveredByEmployeeId, item.recordedByEmployeeId])
  ok(res, deliverableToApi(item, m))
}))

// ══════════════════════════════════════════════════════════════════════════
// CROSS-CASE WORK QUEUES
// ══════════════════════════════════════════════════════════════════════════

// GET /api/incorporation/pending-items — the one queue (§6.5).
incorporationRouter.get('/pending-items', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)

  const kind = q(req, 'kind')
  const all = await pendingItems(where)
  const items = kind ? all.filter((i) => i.kind === kind) : all
  // Overdue first, then by due date; undated rows sort last rather than first.
  items.sort((a, x) => {
    if (a.overdue !== x.overdue) return a.overdue ? -1 : 1
    return (a.due_date ?? '9999-12-31').localeCompare(x.due_date ?? '9999-12-31')
  })

  ok(res, {
    items,
    count: items.length,
    counts_by_kind: all.reduce<Record<string, number>>((acc, i) => {
      acc[i.kind] = (acc[i.kind] ?? 0) + 1
      return acc
    }, {}),
  })
}))

// GET /api/incorporation/deliverables — cross-case (§6.6).
incorporationRouter.get('/deliverables', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)

  const status = q(req, 'status')
  const type = q(req, 'type')
  const rows = await prisma.incorporationDeliverable.findMany({
    where: {
      ...alive, ...where,
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
    },
    include: {
      case: { include: { client: true } },
      clientDocument: { select: { id: true, name: true, currentVersion: true } },
    },
    orderBy: [{ createdAt: 'desc' }],
    take: 300,
  })
  const m = await employeeMap(rows.flatMap((r) => [r.deliveredByEmployeeId, r.recordedByEmployeeId]))
  ok(res, { items: rows.map((r) => deliverableToApi(r, m)), count: rows.length })
}))

// GET /api/incorporation/tasks — cross-case, over the EXISTING Task table.
incorporationRouter.get('/tasks', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)

  const status = q(req, 'status')
  const employeeId = q(req, 'employee_id')
  const overdue = q(req, 'overdue') === 'true'

  const rows = await prisma.task.findMany({
    where: {
      ...alive, ...where,
      incorporationCaseId: { not: null },
      ...(status ? { status } : {}),
      ...(employeeId ? { assignedEmployeeId: employeeId } : {}),
      ...(overdue ? { dueDate: { lt: today() }, status: { not: 'done' } } : {}),
    },
    include: { incorporationCase: { include: { client: true } } },
    orderBy: [{ dueDate: 'asc' }],
    take: 300,
  })
  const m = await employeeMap(rows.map((r) => r.assignedEmployeeId))
  const t = today()
  ok(res, {
    items: rows.map((r) => ({
      ...caseTaskToApi(r, m),
      case_code: r.incorporationCase?.caseCode ?? null,
      client_name: r.incorporationCase?.client.companyName ?? null,
      is_overdue: !!r.dueDate && r.dueDate < t && r.status !== 'done',
    })),
    count: rows.length,
  })
}))

// GET /api/incorporation/queries — cross-case, overdue first.
incorporationRouter.get('/queries', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const where = await clientScopeWhere(session, scope)

  const status = q(req, 'status')
  const rows = await prisma.incorporationQuery.findMany({
    where: { ...alive, ...caseScope(where), ...(status ? { status } : {}) },
    include: {
      case: { include: { client: true } },
      filing: true,
      clientDocument: { select: { id: true, name: true } },
    },
    orderBy: [{ responseDueDate: 'asc' }],
    take: 300,
  })
  const m = await employeeMap(rows.flatMap((r) => [r.assignedEmployeeId, r.recordedByEmployeeId]))
  ok(res, { items: rows.map((r) => queryToApi(r, m)), count: rows.length })
}))
