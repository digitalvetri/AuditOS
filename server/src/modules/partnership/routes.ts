import { Router, type Response } from 'express'
import multer from 'multer'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { writeActivity } from '../../platform/workstation/activity.js'
import { signedLink, verifyResourceToken } from '../../platform/signedUrl.js'
import {
  assertCanSeeClient, clientScopeWhere, requireWorkstation,
} from '../../platform/workstation/scope.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { employeeMap, type EmployeeLookup } from '../../api/workstation.serialize.js'
import { body, FieldErrors } from '../workstation/validate.js'
import { CASE_STATUSES } from './template.js'
import { KINDS, type RegistrationKind } from './constants.js'
import {
  CONDITIONS, ITEM_KINDS, ITEM_STATUSES, PREMISES, PRIORITIES, REQUIREMENT_TYPES,
  addPartnerRequirements, conditionApplies, isPartnerTemplateRow, latestVersion, logActivity, openCase,
  recompute, registrationCategoryId, requirementInclude, requirementStatus,
  serviceStatusFor, today, addDays,
} from './service.js'
import {
  ALLOWED_EXTENSIONS, MAX_UPLOAD_MB, MIME_BY_EXT, fileKey, partnershipStorage,
} from './storage.js'

/**
 * PARTNERSHIP FIRM REGISTRATION — Workstation → Services → Registration.
 *
 * Every case route loads the case through `loadCase`, which applies the
 * caller's client scope. A case id from another client, or one the caller may
 * not see, is a 404/403 before anything else runs — that is the isolation
 * between clients. Requirements, items and partners are then looked up WITH
 * `caseId` in the where clause, never by id alone.
 *
 * Permissions reuse Workstation's codes:
 *   read ............ workstation.service.read
 *   write ........... workstation.service.manage
 *   upload .......... workstation.document.manage
 *   verify / delete . workstation.document.verify
 *   master template . workstation.registration.template.manage
 */
export const partnershipRouter = Router()

/**
 * The same router serves /api/partnership and /api/llp; the mount sets which
 * registration it is. Every case lookup checks the case is that kind, so an
 * LLP case id is a 404 under /api/partnership and vice versa.
 */
export const forKind = (kind: RegistrationKind) =>
  (_req: unknown, res: Response, next: () => void) => { res.locals.kind = kind; next() }
const kindOf = (res: Response) => (res.locals.kind ?? 'PARTNERSHIP') as RegistrationKind
export const partnershipSignedRouter = Router()

const READ = ['workstation.service.read', 'workstation.service.manage'] as const
const MANAGE = ['workstation.service.manage'] as const

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
})

// ── helpers ────────────────────────────────────────────────────────────────

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function oneOf<T extends readonly string[]>(e: FieldErrors, field: string, v: unknown, list: T): T[number] | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string' || !list.includes(v)) {
    e.add(field, `Must be one of: ${list.join(', ')}.`)
    return undefined
  }
  return v as T[number]
}

/** An employee id from the body: undefined = untouched, null = cleared. */
async function employeeField(e: FieldErrors, field: string, v: unknown): Promise<string | null | undefined> {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  if (typeof v !== 'string') { e.add(field, 'Invalid employee.'); return undefined }
  const emp = await prisma.employee.findFirst({ where: { id: v, deletedAt: null }, select: { id: true } })
  if (!emp) { e.add(field, 'Employee not found.'); return undefined }
  return v
}

function dueState(due: string | null, done: boolean): string | null {
  if (done) return 'completed'
  if (!due) return null
  const t = today()
  if (due < t) return 'overdue'
  if (due === t) return 'today'
  if (due <= addDays(t, 3)) return 'soon'
  return 'upcoming'
}

const ref = (m: EmployeeLookup, id: string | null | undefined) => (id ? m.get(id) ?? null : null)

async function loadCase(session: Session, scope: Scope, id: string, kind: RegistrationKind) {
  const c = await prisma.partnershipCase.findFirst({ where: { id, kind, deletedAt: null }, include: { client: true } })
  if (!c) throw ApiError.notFound('Registration case not found.')
  await assertCanSeeClient(session, scope, c.clientId)
  return c
}

async function loadRequirement(caseId: string, rid: string) {
  const r = await prisma.partnershipDocRequirement.findFirst({
    where: { id: rid, caseId, deletedAt: null },
    include: requirementInclude,
  })
  if (!r) throw ApiError.notFound('Document requirement not found.')
  return r
}

function mustCan(session: Session, perm: Parameters<typeof can>[1]) {
  if (!can(session, perm, 'self')) throw ApiError.forbidden()
}

type CaseRow = Prisma.PartnershipCaseGetPayload<{ include: { client: true } }>

function caseSummary(c: CaseRow, m: EmployeeLookup) {
  const done = c.status === 'COMPLETED'
  return {
    id: c.id,
    case_code: c.caseCode,
    kind: c.kind,
    client: { id: c.client.id, name: c.client.companyName, code: c.client.clientCode },
    status: c.status,
    stage: c.stage,
    assigned: ref(m, c.assignedEmployeeId),
    reviewer: ref(m, c.reviewerEmployeeId),
    approver: ref(m, c.approverEmployeeId),
    due_date: c.dueDate,
    due_state: dueState(c.dueDate, done),
    premises_type: c.premisesType,
    entity_type: c.entityType,
    progress: {
      pct: c.progressPct,
      items_total: c.itemsTotal,
      items_done: c.itemsDone,
      items_pending: c.itemsTotal - c.itemsDone,
      items_required: c.itemsRequired,
      items_required_done: c.itemsRequiredDone,
      docs_required: c.docsRequired,
      docs_uploaded: c.docsUploaded,
      docs_verified: c.docsVerified,
      docs_pct: c.docsRequired ? Math.round((c.docsVerified / c.docsRequired) * 100) : 0,
    },
    created_at: c.createdAt,
    last_activity_at: c.lastActivityAt,
    completed_at: c.completedAt,
  }
}

const caseEmployeeIds = (c: { assignedEmployeeId: string | null; reviewerEmployeeId: string | null; approverEmployeeId: string | null }) =>
  [c.assignedEmployeeId, c.reviewerEmployeeId, c.approverEmployeeId]

/** Registration Details — the Part A fields of the source PDF. */
const DETAIL_TEXT_FIELDS = [
  'nature_of_business', 'principal_place', 'other_branches',
  'total_capital', 'remuneration_terms', 'interest_on_capital', 'drawing_limits',
  'bank_operation', 'authorized_signatory', 'commencement_date',
] as const

/** Private Limited — section 3 ("Basic Company Details Needed"); shareholding lives on each person. */
const PVT_DETAIL_TEXT_FIELDS = ['name_significance', 'main_objective', 'authorized_capital', 'paid_up_capital'] as const

/** LLP Registration Details — section 3 of the LLP source ("Basic Business Details Needed"). */
const LLP_DETAIL_TEXT_FIELDS = ['main_objective', 'total_contribution'] as const

function parseDetails(raw: unknown, kind: RegistrationKind = 'PARTNERSHIP') {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (kind === 'GST') return {} // the GST source asks for documents only; business type and premises live on the case
  if (kind === 'PRIVATE_LIMITED') {
    const out: Record<string, unknown> = {}
    for (const f of PVT_DETAIL_TEXT_FIELDS) out[f] = typeof b[f] === 'string' ? (b[f] as string).slice(0, 4000) : ''
    // "2 unique names in order of preference"
    out.company_names = (Array.isArray(b.company_names) ? b.company_names : []).slice(0, 2).map((x) => (typeof x === 'string' ? x.slice(0, 200) : ''))
    return out
  }
  if (kind === 'LLP') {
    const out: Record<string, unknown> = {}
    for (const f of LLP_DETAIL_TEXT_FIELDS) out[f] = typeof b[f] === 'string' ? (b[f] as string).slice(0, 4000) : ''
    // "2 unique names in order of preference"
    out.llp_names = (Array.isArray(b.llp_names) ? b.llp_names : []).slice(0, 2).map((x) => (typeof x === 'string' ? x.slice(0, 200) : ''))
    return out
  }
  const out: Record<string, unknown> = {}
  for (const f of DETAIL_TEXT_FIELDS) out[f] = typeof b[f] === 'string' ? (b[f] as string).slice(0, 4000) : ''
  const list = (v: unknown, n: number) => (Array.isArray(v) ? v : []).slice(0, n)
  out.firm_names = list(b.firm_names, 3).map((x) => (typeof x === 'string' ? x.slice(0, 200) : ''))
  out.deed_witnesses = list(b.deed_witnesses, 2).map((w) => {
    const o = (w ?? {}) as Record<string, unknown>
    return { name: String(o.name ?? '').slice(0, 200), address: String(o.address ?? '').slice(0, 1000) }
  })
  out.application_witnesses = list(b.application_witnesses, 2).map((w) => {
    const o = (w ?? {}) as Record<string, unknown>
    return {
      name: String(o.name ?? '').slice(0, 200),
      occupation: String(o.occupation ?? '').slice(0, 200),
      pan_aadhaar: String(o.pan_aadhaar ?? '').slice(0, 50),
    }
  })
  return out
}

function versionToApi(v: {
  id: string; version: number; originalName: string | null; mimeType: string | null; sizeBytes: number
  uploadedBy: string; uploadedAt: Date; reviewStatus: string | null; reviewedByEmployeeId: string | null
  reviewedAt: Date | null; reviewNote: string | null; notes: string | null
  documentType: string | null; documentDate: string | null
}, m: EmployeeLookup) {
  return {
    id: v.id,
    version: v.version,
    original_name: v.originalName,
    mime_type: v.mimeType,
    size_bytes: v.sizeBytes,
    uploaded_by: ref(m, v.uploadedBy),
    uploaded_at: v.uploadedAt,
    review_status: (v.reviewStatus ?? 'uploaded').toUpperCase(),
    reviewed_by: ref(m, v.reviewedByEmployeeId),
    reviewed_at: v.reviewedAt,
    review_note: v.reviewNote,
    notes: v.notes,
    document_type: v.documentType,
    document_date: v.documentDate,
  }
}

// ── Overview ───────────────────────────────────────────────────────────────

// GET /api/partnership/overview — the dashboard cards.
partnershipRouter.get('/overview', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const base = { deletedAt: null, kind: kindOf(res), ...(await clientScopeWhere(session, scope)) }
  const open = { ...base, status: { not: 'COMPLETED' } }
  const [total, inProgress, docsPending, pendingItems, completed, overdue] = await Promise.all([
    prisma.partnershipCase.count({ where: base }),
    prisma.partnershipCase.count({ where: { ...base, status: { in: ['IN_PROGRESS', 'DOCUMENTS_PENDING', 'UNDER_REVIEW', 'SUBMITTED', 'QUERY'] } } }),
    prisma.partnershipCase.count({ where: { ...open, docsUploaded: { lt: prisma.partnershipCase.fields.docsRequired } } }),
    prisma.partnershipCase.aggregate({ where: open, _sum: { itemsTotal: true, itemsDone: true } }),
    prisma.partnershipCase.count({ where: { ...base, status: 'COMPLETED' } }),
    prisma.partnershipCase.count({ where: { ...open, dueDate: { lt: today() } } }),
  ])
  ok(res, {
    total_clients: total,
    in_progress: inProgress,
    documents_pending: docsPending,
    checklist_items_pending: (pendingItems._sum.itemsTotal ?? 0) - (pendingItems._sum.itemsDone ?? 0),
    completed,
    overdue,
    today: today(),
  })
}))

// ── Cases ──────────────────────────────────────────────────────────────────

// GET /api/partnership/cases — filtered, searched and sorted in the database.
partnershipRouter.get('/cases', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const q = req.query as Record<string, string | undefined>
  const t = today()

  const kind = kindOf(res)
  const and: Prisma.PartnershipCaseWhereInput[] = [{ deletedAt: null, kind }, await clientScopeWhere(session, scope)]
  if (q.status && (CASE_STATUSES as readonly string[]).includes(q.status)) and.push({ status: q.status })
  if (q.stage && KINDS[kind].stages.includes(q.stage)) and.push({ stage: q.stage })
  if (q.assignee) and.push({ assignedEmployeeId: q.assignee === 'unassigned' ? null : q.assignee })
  if (q.reviewer) and.push({ reviewerEmployeeId: q.reviewer })
  if (q.client_id) and.push({ clientId: q.client_id })
  const pmin = Number(q.progress_min); const pmax = Number(q.progress_max)
  if (q.progress_min && Number.isFinite(pmin)) and.push({ progressPct: { gte: pmin } })
  if (q.progress_max && Number.isFinite(pmax)) and.push({ progressPct: { lte: pmax } })
  switch (q.due) {
    case 'overdue': and.push({ dueDate: { lt: t }, status: { not: 'COMPLETED' } }); break
    case 'today': and.push({ dueDate: t, status: { not: 'COMPLETED' } }); break
    case 'soon': and.push({ dueDate: { gt: t, lte: addDays(t, 3) }, status: { not: 'COMPLETED' } }); break
    case 'none': and.push({ dueDate: null }); break
  }
  const f = prisma.partnershipCase.fields
  switch (q.doc_status) {
    case 'pending': and.push({ docsUploaded: { lt: f.docsRequired } }); break
    case 'awaiting_verification': and.push({ docsUploaded: { equals: f.docsRequired }, docsVerified: { lt: f.docsRequired } }); break
    case 'verified': and.push({ docsVerified: { equals: f.docsRequired } }); break
  }
  const search = str(q.q)
  if (search) {
    const emps = await prisma.employee.findMany({
      where: { fullName: { contains: search, mode: 'insensitive' } }, select: { id: true }, take: 50,
    })
    const empIds = emps.map((e) => e.id)
    and.push({
      OR: [
        { caseCode: { contains: search, mode: 'insensitive' } },
        // Proposed firm / LLP names live in the details form.
        { detailsJson: { contains: search, mode: 'insensitive' } },
        { client: { companyName: { contains: search, mode: 'insensitive' } } },
        { client: { clientCode: { contains: search, mode: 'insensitive' } } },
        ...(empIds.length ? [{ assignedEmployeeId: { in: empIds } }, { reviewerEmployeeId: { in: empIds } }] : []),
        { requirements: { some: { deletedAt: null, name: { contains: search, mode: 'insensitive' } } } },
        { requirements: { some: { deletedAt: null, clientDocument: { versions: { some: { originalName: { contains: search, mode: 'insensitive' } } } } } } },
      ],
    })
  }

  const dir = q.dir === 'desc' ? 'desc' : 'asc'
  const orderBy: Prisma.PartnershipCaseOrderByWithRelationInput[] =
    q.sort === 'client' ? [{ client: { companyName: dir } }]
    : q.sort === 'due' ? [{ dueDate: { sort: dir, nulls: 'last' } }]
    : q.sort === 'progress' ? [{ progressPct: dir }]
    : q.sort === 'status' ? [{ status: dir }]
    : [{ createdAt: 'desc' }]

  const page = Math.max(1, Number(q.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(q.page_size) || 50))
  const where = { AND: and }
  const [rows, count] = await Promise.all([
    prisma.partnershipCase.findMany({ where, include: { client: true }, orderBy, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.partnershipCase.count({ where }),
  ])
  const m = await employeeMap(rows.flatMap(caseEmployeeIds))
  ok(res, { items: rows.map((r) => caseSummary(r, m)), count, page, page_size: pageSize })
}))

// POST /api/partnership/cases — enrol an EXISTING client and open its case.
partnershipRouter.post('/cases', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const b = body(req)
  const e = new FieldErrors()
  const clientId = e.str('client_id', b.client_id)
  const assigned = await employeeField(e, 'assigned_employee_id', b.assigned_employee_id)
  const reviewer = await employeeField(e, 'reviewer_employee_id', b.reviewer_employee_id)
  const approver = await employeeField(e, 'approver_employee_id', b.approver_employee_id)
  const dueDate = e.date('due_date', b.due_date)
  e.throwIfAny()

  const client = await prisma.client.findFirst({ where: { id: clientId!, deletedAt: null } })
  if (!client) throw ApiError.notFound('Client not found.')
  await assertCanSeeClient(session, scope, client.id)

  const kind = kindOf(res)
  const live = await prisma.partnershipCase.findFirst({
    where: { clientId: client.id, kind, deletedAt: null, status: { not: 'COMPLETED' } },
    select: { caseCode: true, id: true },
  })
  if (live) throw ApiError.conflict('case_exists', `${client.companyName} already has an open case (${live.caseCode}).`, { case_id: live.id })

  const c = await openCase(session, kind, {
    clientId: client.id,
    assignedEmployeeId: assigned ?? null,
    reviewerEmployeeId: reviewer ?? null,
    approverEmployeeId: approver ?? null,
    dueDate: dueDate ?? null,
  })
  await recompute(c.id)
  const counts = await prisma.partnershipCaseItem.count({ where: { caseId: c.id } })
  await logActivity(c.id, session, 'case.created', `Registration case ${c.caseCode} opened`)
  await logActivity(c.id, session, 'checklist.initialized', `Checklist initialised from the master template (${counts} items)`)
  if (assigned) await logActivity(c.id, session, 'case.assigned', 'Employee assigned', { type: 'employee', id: assigned })
  await writeActivity({
    session, subjectType: 'client', subjectId: client.id, action: `${kind.toLowerCase()}_registration.opened`,
    description: `${KINDS[kind].label} opened (${c.caseCode})`, entityType: 'partnership_case', entityId: c.id,
  })
  await writeAudit({ actorUserId: session.userId, action: 'partnership_case.create', entityType: 'partnership_case', entityId: c.id, after: { caseCode: c.caseCode, clientId: client.id }, req })
  ok(res, { id: c.id, case_code: c.caseCode }, 201)
}))

// GET /api/partnership/cases/:id — everything the workspace shows.
partnershipRouter.get('/cases/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const c = await loadCase(session, scope, req.params.id, kindOf(res))

  const [categories, partners, reqs] = await Promise.all([
    prisma.partnershipCaseCategory.findMany({
      where: { caseId: c.id, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
      include: { items: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' }, include: { partner: { select: { id: true, name: true, deletedAt: true } } } } },
    }),
    prisma.partnershipPartner.findMany({ where: { caseId: c.id, deletedAt: null }, orderBy: { sortOrder: 'asc' } }),
    prisma.partnershipDocRequirement.findMany({
      where: { caseId: c.id, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
      include: { ...requirementInclude, item: { select: { id: true, name: true } } },
    }),
  ])

  const ids = [
    ...caseEmployeeIds(c),
    ...categories.flatMap((cat) => cat.items.flatMap((i) => [i.assignedEmployeeId, i.completedByEmployeeId])),
    ...reqs.flatMap((r) => (r.clientDocument?.versions ?? []).flatMap((v) => [v.uploadedBy, v.reviewedByEmployeeId])),
  ]
  const m = await employeeMap(ids)

  const reqApi = reqs.map((r) => {
    const v = latestVersion(r)
    return {
      id: r.id,
      name: r.name,
      category_name: r.categoryName,
      requirement: r.requirement,
      condition: r.condition,
      doc_key: r.docKey,
      doc_type_options: r.docTypeOptions ? r.docTypeOptions.split('|') : null,
      max_age_days: r.maxAgeDays,
      status: requirementStatus(r, c),
      not_applicable: r.notApplicable,
      due_date: r.dueDate,
      due_state: dueState(r.dueDate, !!v && v.reviewStatus === 'verified'),
      item: r.item ? { id: r.item.id, name: r.item.name } : null,
      partner: r.partner && !r.partner.deletedAt ? { id: r.partner.id, name: r.partner.name } : null,
      current_version: v ? versionToApi(v, m) : null,
      versions: v ? r.clientDocument!.versions.map((x) => versionToApi(x, m)) : [],
    }
  })

  // Rows a case keeps only to clone for future partners are not checklist items.
  const visible = categories.map((cat) => ({
    ...cat,
    items: cat.items.filter((i) => !isPartnerTemplateRow({ partnerId: i.partnerId, category: cat }) && !i.partner?.deletedAt),
  }))
  const counted = (i: (typeof visible)[number]['items'][number]) =>
    i.status !== 'NOT_APPLICABLE' && conditionApplies(i.condition, c)
  const tally = (list: (typeof visible)[number]['items']) => {
    const n = list.filter(counted)
    return { done: n.filter((i) => i.status === 'COMPLETED').length, total: n.length }
  }

  ok(res, {
    ...caseSummary(c, m),
    stages: KINDS[c.kind as RegistrationKind].stages,
    // Stage progress: the items in the categories mapped to each stage.
    stage_progress: KINDS[c.kind as RegistrationKind].stages.map((st) => ({
      stage: st, ...tally(visible.filter((cat) => cat.stage === st).flatMap((cat) => cat.items)),
    })),
    // Per-partner KYC progress: every item carrying that partner.
    partner_progress: partners.map((p) => ({
      partner_id: p.id, name: p.name,
      ...tally(visible.flatMap((cat) => cat.items).filter((i) => i.partnerId === p.id)),
      docs_pending: reqApi.filter((r) => r.partner?.id === p.id && r.requirement !== 'OPTIONAL' && r.status === 'PENDING').length,
    })),
    details: c.detailsJson ? JSON.parse(c.detailsJson) : parseDetails({}, c.kind as RegistrationKind),
    partners: partners.map((p) => ({
      id: p.id, name: p.name, father_name: p.fatherName, address: p.address, mobile: p.mobile,
      email: p.email, pan: p.pan, aadhaar: p.aadhaar, capital: p.capital, profit_share: p.profitShare, remuneration: p.remuneration, role: p.role, shares: p.shares,
    })),
    categories: visible.map((cat) => ({
      id: cat.id,
      name: cat.name,
      description: cat.description,
      stage: cat.stage,
      is_custom: cat.isCustom,
      per_partner: cat.perPartner,
      items: cat.items.map((i) => ({
        id: i.id,
        name: i.name,
        description: i.description,
        requirement: i.requirement,
        kind: i.kind,
        per_partner: i.perPartner,
        partner: i.partner ? { id: i.partner.id, name: i.partner.name } : null,
        doc_type_options: i.docTypeOptions ? i.docTypeOptions.split('|') : null,
        max_age_days: i.maxAgeDays,
        condition: i.condition,
        applicable: conditionApplies(i.condition, c),
        status: i.status,
        assigned: ref(m, i.assignedEmployeeId),
        due_date: i.dueDate,
        due_state: dueState(i.dueDate, i.status === 'COMPLETED' || i.status === 'NOT_APPLICABLE'),
        priority: i.priority,
        notes: i.notes,
        is_custom: i.isCustom,
        completed_at: i.completedAt,
        completed_by: ref(m, i.completedByEmployeeId),
        created_at: i.createdAt,
        updated_at: i.updatedAt,
        documents: reqApi
          .filter((r) => r.item?.id === i.id || (!!i.docKey && r.doc_key === i.docKey))
          .map((r) => ({ requirement_id: r.id, name: r.name, status: r.status, partner: r.partner })),
      })),
    })),
    requirements: reqApi,
    permissions: {
      manage: can(session, 'workstation.service.manage'),
      upload: can(session, 'workstation.document.manage'),
      verify: can(session, 'workstation.document.verify'),
    },
  })
}))

// PATCH /api/partnership/cases/:id — status, stage, people, due date, premises.
partnershipRouter.patch('/cases/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const c = await loadCase(session, scope, req.params.id, kindOf(res))
  const b = body(req)
  const e = new FieldErrors()
  const status = oneOf(e, 'status', b.status, CASE_STATUSES)
  const stages = KINDS[c.kind as RegistrationKind].stages
  const stage = oneOf(e, 'stage', b.stage, stages)
  const entity = b.entity_type === null || b.entity_type === '' ? null : oneOf(e, 'entity_type', b.entity_type, ['PROPRIETORSHIP', 'PARTNERSHIP', 'LLP_COMPANY'] as const)
  const premises = b.premises_type === null || b.premises_type === '' ? null : oneOf(e, 'premises_type', b.premises_type, PREMISES)
  const assigned = await employeeField(e, 'assigned_employee_id', b.assigned_employee_id)
  const reviewer = await employeeField(e, 'reviewer_employee_id', b.reviewer_employee_id)
  const approver = await employeeField(e, 'approver_employee_id', b.approver_employee_id)
  const dueDate = b.due_date === null || b.due_date === '' ? null : e.date('due_date', b.due_date)
  e.throwIfAny()
  if (status === 'COMPLETED') mustCan(session, 'workstation.document.verify')

  const data: Prisma.PartnershipCaseUpdateInput = { updatedBy: session.userId }
  const log: [string, string][] = []
  if (status && status !== c.status) {
    data.status = status
    data.completedAt = status === 'COMPLETED' ? new Date() : null
    if (status === 'COMPLETED') data.stage = stages[stages.length - 1]
    log.push([status === 'SUBMITTED' ? 'case.submitted' : status === 'QUERY' ? 'case.query' : status === 'COMPLETED' ? 'case.completed' : 'case.status_changed', `Status changed from ${c.status} to ${status}`])
  }
  if (stage && stage !== c.stage) { data.stage = stage; log.push(['case.stage_changed', `Stage changed from ${c.stage} to ${stage}`]) }
  if (b.premises_type !== undefined && premises !== c.premisesType) {
    data.premisesType = premises ?? null
    log.push(['case.premises_changed', `Premises set to ${premises ?? 'not specified'}`])
  }
  if (b.entity_type !== undefined && entity !== c.entityType) {
    data.entityType = entity ?? null
    log.push(['case.entity_changed', `Business type set to ${entity ?? 'not specified'}`])
  }
  const m = await employeeMap([assigned, reviewer, approver])
  const name = (id: string | null | undefined) => (id ? m.get(id)?.full_name ?? id : 'nobody')
  if (assigned !== undefined && assigned !== c.assignedEmployeeId) { data.assignedEmployeeId = assigned; log.push(['case.assigned', `Assigned to ${name(assigned)}`]) }
  if (reviewer !== undefined && reviewer !== c.reviewerEmployeeId) { data.reviewerEmployeeId = reviewer; log.push(['case.reviewer_assigned', `Reviewer set to ${name(reviewer)}`]) }
  if (approver !== undefined && approver !== c.approverEmployeeId) { data.approverEmployeeId = approver; log.push(['case.approver_assigned', `Approver set to ${name(approver)}`]) }
  if (b.due_date !== undefined && (dueDate ?? null) !== c.dueDate) { data.dueDate = dueDate ?? null; log.push(['case.due_changed', `Due date ${c.dueDate ?? '—'} → ${dueDate ?? '—'}`]) }

  const updated = await prisma.partnershipCase.update({ where: { id: c.id }, data })
  if (c.clientServiceId) {
    await prisma.clientService.update({
      where: { id: c.clientServiceId },
      data: {
        status: serviceStatusFor(updated.status),
        dueDate: updated.dueDate,
        ...(updated.assignedEmployeeId ? { assignedEmployeeId: updated.assignedEmployeeId } : {}),
        managerId: updated.reviewerEmployeeId,
        completedAt: updated.completedAt,
      },
    })
  }
  if (data.premisesType !== undefined || data.entityType !== undefined) await recompute(c.id)
  for (const [action, detail] of log) await logActivity(c.id, session, action, detail)
  if (log.length) {
    await writeAudit({
      actorUserId: session.userId, action: 'partnership_case.update', entityType: 'partnership_case', entityId: c.id,
      before: { status: c.status, stage: c.stage, assignedEmployeeId: c.assignedEmployeeId, reviewerEmployeeId: c.reviewerEmployeeId, dueDate: c.dueDate, premisesType: c.premisesType },
      after: { status: updated.status, stage: updated.stage, assignedEmployeeId: updated.assignedEmployeeId, reviewerEmployeeId: updated.reviewerEmployeeId, dueDate: updated.dueDate, premisesType: updated.premisesType },
      req,
    })
  }
  if (status && status !== c.status) {
    await writeActivity({
      session, subjectType: 'client', subjectId: c.clientId, action: 'partnership_registration.status',
      description: `Partnership registration ${c.caseCode}: ${status}`, entityType: 'partnership_case', entityId: c.id,
    })
  }
  ok(res, { id: c.id })
}))

// PUT /api/partnership/cases/:id/details — Registration Details (PDF Part A).
partnershipRouter.put('/cases/:id/details', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const c = await loadCase(session, scope, req.params.id, kindOf(res))
  const details = parseDetails(body(req).details, c.kind as RegistrationKind)
  await prisma.partnershipCase.update({ where: { id: c.id }, data: { detailsJson: JSON.stringify(details), updatedBy: session.userId } })
  await logActivity(c.id, session, 'details.updated', 'Registration details updated')
  await writeAudit({ actorUserId: session.userId, action: 'partnership_case.details', entityType: 'partnership_case', entityId: c.id, before: c.detailsJson ? JSON.parse(c.detailsJson) : null, after: details, req })
  ok(res, { details })
}))

// ── Partners ───────────────────────────────────────────────────────────────

function aadhaar(e: FieldErrors, v: unknown): string | null {
  const raw = e.str('aadhaar', v, { max: 20, required: false })
  if (!raw) return null
  const digits = raw.replace(/\s/g, '')
  if (!/^\d{12}$/.test(digits)) { e.add('aadhaar', 'Aadhaar is 12 digits.'); return null }
  return digits
}

const PERSON_ROLES = ['DIRECTOR', 'SHAREHOLDER', 'BOTH'] as const
function shareCount(e: FieldErrors, v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(String(v).replace(/,/g, ''))
  if (!Number.isInteger(n) || n < 0) { e.add('shares', 'Enter a whole number of shares.'); return null }
  return n
}

function partnerFields(b: Record<string, unknown>) {
  const e = new FieldErrors()
  const out = {
    name: e.str('name', b.name, { max: 200 }),
    fatherName: e.str('father_name', b.father_name, { max: 200, required: false }) ?? null,
    address: e.str('address', b.address, { max: 1000, required: false }) ?? null,
    mobile: e.str('mobile', b.mobile, { max: 20, required: false }) ?? null,
    email: e.email('email', b.email) ?? null,
    pan: e.pan('pan', b.pan) ?? null,
    aadhaar: aadhaar(e, b.aadhaar),
    capital: e.str('capital', b.capital, { max: 50, required: false }) ?? null,
    profitShare: e.str('profit_share', b.profit_share, { max: 20, required: false }) ?? null,
    remuneration: e.str('remuneration', b.remuneration, { max: 200, required: false }) ?? null,
    // Private Limited: director, shareholder or both, and the shares allotted.
    role: b.role ? oneOf(e, 'role', b.role, PERSON_ROLES) ?? null : null,
    shares: shareCount(e, b.shares),
  }
  e.throwIfAny()
  return out as typeof out & { name: string }
}

partnershipRouter.post('/cases/:id/partners', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const c = await loadCase(session, scope, req.params.id, kindOf(res))
  const data = partnerFields(body(req))
  const n = await prisma.partnershipPartner.count({ where: { caseId: c.id } })
  const p = await prisma.partnershipPartner.create({ data: { ...data, caseId: c.id, sortOrder: (n + 1) * 10 } })
  await addPartnerRequirements(c.id, p, session)
  await recompute(c.id)
  await logActivity(c.id, session, 'partner.added', `Partner ${p.name} added`, { type: 'partner', id: p.id })
  await writeAudit({ actorUserId: session.userId, action: 'partnership_partner.create', entityType: 'partnership_partner', entityId: p.id, after: data, req })
  ok(res, { id: p.id }, 201)
}))

partnershipRouter.patch('/cases/:id/partners/:pid', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const c = await loadCase(session, scope, req.params.id, kindOf(res))
  const p = await prisma.partnershipPartner.findFirst({ where: { id: req.params.pid, caseId: c.id, deletedAt: null } })
  if (!p) throw ApiError.notFound('Partner not found.')
  const data = partnerFields(body(req))
  await prisma.partnershipPartner.update({ where: { id: p.id }, data })
  if (data.name !== p.name) {
    // Keep the per-partner requirement names in step with the partner's name.
    const reqs = await prisma.partnershipDocRequirement.findMany({ where: { caseId: c.id, partnerId: p.id } })
    for (const r of reqs) {
      await prisma.partnershipDocRequirement.update({ where: { id: r.id }, data: { name: r.name.replace(` — ${p.name}`, ` — ${data.name}`) } })
    }
  }
  await logActivity(c.id, session, 'partner.updated', `Partner ${data.name} updated`, { type: 'partner', id: p.id })
  await writeAudit({ actorUserId: session.userId, action: 'partnership_partner.update', entityType: 'partnership_partner', entityId: p.id, before: p, after: data, req })
  ok(res, { id: p.id })
}))

// DELETE — a partner whose files were uploaded keeps them; their open
// requirements drop out of the counts.
partnershipRouter.delete('/cases/:id/partners/:pid', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const c = await loadCase(session, scope, req.params.id, kindOf(res))
  const p = await prisma.partnershipPartner.findFirst({ where: { id: req.params.pid, caseId: c.id, deletedAt: null } })
  if (!p) throw ApiError.notFound('Partner not found.')
  const now = new Date()
  await prisma.$transaction([
    prisma.partnershipPartner.update({ where: { id: p.id }, data: { deletedAt: now } }),
    prisma.partnershipCaseItem.updateMany({ where: { caseId: c.id, partnerId: p.id }, data: { deletedAt: now } }),
    prisma.partnershipDocRequirement.updateMany({ where: { caseId: c.id, partnerId: p.id, clientDocumentId: null }, data: { deletedAt: now } }),
    prisma.partnershipDocRequirement.updateMany({ where: { caseId: c.id, partnerId: p.id, clientDocumentId: { not: null } }, data: { notApplicable: true } }),
  ])
  await recompute(c.id)
  await logActivity(c.id, session, 'partner.removed', `Partner ${p.name} removed`, { type: 'partner', id: p.id })
  await writeAudit({ actorUserId: session.userId, action: 'partnership_partner.delete', entityType: 'partnership_partner', entityId: p.id, before: p, req })
  ok(res, { id: p.id })
}))

// ── Checklist: custom categories and items (this case only) ────────────────

partnershipRouter.post('/cases/:id/categories', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const c = await loadCase(session, scope, req.params.id, kindOf(res))
  const b = body(req)
  const e = new FieldErrors()
  const name = e.str('name', b.name, { max: 200 })
  const description = e.str('description', b.description, { max: 1000, required: false })
  e.throwIfAny()
  const last = await prisma.partnershipCaseCategory.findFirst({ where: { caseId: c.id }, orderBy: { sortOrder: 'desc' } })
  const cat = await prisma.partnershipCaseCategory.create({
    data: { caseId: c.id, name: name!, description: description ?? null, isCustom: true, sortOrder: (last?.sortOrder ?? 0) + 10, createdBy: session.userId },
  })
  await logActivity(c.id, session, 'category.added', `Category "${cat.name}" added`, { type: 'category', id: cat.id })
  await writeAudit({ actorUserId: session.userId, action: 'partnership_category.create', entityType: 'partnership_case_category', entityId: cat.id, after: { name: cat.name, caseId: c.id }, req })
  ok(res, { id: cat.id }, 201)
}))

partnershipRouter.post('/cases/:id/items', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const c = await loadCase(session, scope, req.params.id, kindOf(res))
  const b = body(req)
  const e = new FieldErrors()
  const categoryId = e.str('category_id', b.category_id)
  const name = e.str('name', b.name, { max: 300 })
  const description = e.str('description', b.description, { max: 2000, required: false })
  const requirement = oneOf(e, 'requirement', b.requirement, REQUIREMENT_TYPES) ?? 'REQUIRED'
  const kind = oneOf(e, 'kind', b.kind, ITEM_KINDS) ?? 'ACTION'
  const priority = oneOf(e, 'priority', b.priority, PRIORITIES) ?? 'MEDIUM'
  const assigned = await employeeField(e, 'assigned_employee_id', b.assigned_employee_id)
  const dueDate = e.date('due_date', b.due_date)
  const notes = e.str('notes', b.notes, { max: 4000, required: false })
  e.throwIfAny()
  const cat = await prisma.partnershipCaseCategory.findFirst({ where: { id: categoryId!, caseId: c.id, deletedAt: null } })
  if (!cat) throw ApiError.notFound('Category not found on this case.')
  // In a per-partner category a custom item belongs to one partner.
  let partner: { id: string; name: string } | null = null
  if (cat.perPartner) {
    partner = await prisma.partnershipPartner.findFirst({ where: { id: String(b.partner_id ?? ''), caseId: c.id, deletedAt: null }, select: { id: true, name: true } })
    if (!partner) throw ApiError.badRequest('Choose the partner this item is for.', { partner_id: 'Choose the partner this item is for.' })
  }
  const last = await prisma.partnershipCaseItem.findFirst({ where: { categoryId: cat.id }, orderBy: { sortOrder: 'desc' } })
  const item = await prisma.partnershipCaseItem.create({
    data: {
      caseId: c.id, categoryId: cat.id, name: name!, description: description ?? null,
      requirement, kind, priority, assignedEmployeeId: assigned ?? null, dueDate: dueDate ?? null,
      notes: notes ?? null, isCustom: true, sortOrder: (last?.sortOrder ?? 0) + 10, createdBy: session.userId,
      partnerId: partner?.id ?? null,
    },
  })
  if (kind === 'DOCUMENT') {
    const n = await prisma.partnershipDocRequirement.count({ where: { caseId: c.id } })
    await prisma.partnershipDocRequirement.create({
      data: { caseId: c.id, itemId: item.id, partnerId: partner?.id ?? null, name: partner ? `${item.name} — ${partner.name}` : item.name, categoryName: cat.name, requirement, dueDate: dueDate ?? null, sortOrder: (n + 1) * 10, createdBy: session.userId },
    })
  }
  await recompute(c.id)
  await logActivity(c.id, session, 'item.added', `Checklist item "${item.name}" added to ${cat.name}`, { type: 'item', id: item.id })
  await writeAudit({ actorUserId: session.userId, action: 'partnership_item.create', entityType: 'partnership_case_item', entityId: item.id, after: { name: item.name, caseId: c.id }, req })
  ok(res, { id: item.id }, 201)
}))

// PATCH /cases/:id/items/:itemId — tick, reopen, assign, reschedule, note.
partnershipRouter.patch('/cases/:id/items/:itemId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const c = await loadCase(session, scope, req.params.id, kindOf(res))
  const item = await prisma.partnershipCaseItem.findFirst({ where: { id: req.params.itemId, caseId: c.id, deletedAt: null } })
  if (!item) throw ApiError.notFound('Checklist item not found on this case.')
  const b = body(req)
  const e = new FieldErrors()
  const status = oneOf(e, 'status', b.status, ITEM_STATUSES)
  const priority = oneOf(e, 'priority', b.priority, PRIORITIES)
  const assigned = await employeeField(e, 'assigned_employee_id', b.assigned_employee_id)
  const dueDate = b.due_date === null || b.due_date === '' ? null : e.date('due_date', b.due_date)
  const notes = b.notes === undefined ? undefined : (e.str('notes', b.notes, { max: 4000, required: false }) ?? null)
  e.throwIfAny()

  const data: Prisma.PartnershipCaseItemUpdateInput = { updatedBy: session.userId }
  const log: [string, string][] = []
  if (status && status !== item.status) {
    data.status = status
    if (status === 'COMPLETED') {
      data.completedAt = new Date()
      data.completedByEmployeeId = session.employeeId
      data.completedByUserId = session.userId
      log.push(['item.completed', `"${item.name}" completed`])
    } else {
      data.completedAt = null
      data.completedByEmployeeId = null
      data.completedByUserId = null
      log.push([item.status === 'COMPLETED' ? 'item.reopened' : 'item.status_changed', `"${item.name}": ${item.status} → ${status}`])
    }
  }
  if (priority && priority !== item.priority) { data.priority = priority; log.push(['item.priority_changed', `"${item.name}" priority ${priority}`]) }
  if (assigned !== undefined && assigned !== item.assignedEmployeeId) {
    data.assignedEmployeeId = assigned
    const m = await employeeMap([assigned])
    log.push(['item.assigned', `"${item.name}" assigned to ${assigned ? m.get(assigned)?.full_name ?? assigned : 'nobody'}`])
  }
  if (b.due_date !== undefined && (dueDate ?? null) !== item.dueDate) { data.dueDate = dueDate ?? null; log.push(['item.due_changed', `"${item.name}" due ${item.dueDate ?? '—'} → ${dueDate ?? '—'}`]) }
  if (notes !== undefined && notes !== item.notes) { data.notes = notes; log.push(['item.notes', `"${item.name}" notes updated`]) }

  await prisma.partnershipCaseItem.update({ where: { id: item.id }, data })
  await recompute(c.id)
  // The first tick moves a fresh case out of NOT_STARTED.
  if (c.status === 'NOT_STARTED' && status && status !== 'PENDING') {
    await prisma.partnershipCase.update({ where: { id: c.id }, data: { status: 'IN_PROGRESS' } })
    log.push(['case.status_changed', 'Status changed from NOT_STARTED to IN_PROGRESS'])
  }
  for (const [action, detail] of log) await logActivity(c.id, session, action, detail, { type: 'item', id: item.id })
  if (log.length) {
    await writeAudit({
      actorUserId: session.userId, action: 'partnership_item.update', entityType: 'partnership_case_item', entityId: item.id,
      before: { status: item.status, assignedEmployeeId: item.assignedEmployeeId, dueDate: item.dueDate, priority: item.priority },
      after: { status: status ?? item.status, assignedEmployeeId: assigned ?? item.assignedEmployeeId, dueDate: dueDate ?? item.dueDate, priority: priority ?? item.priority },
      req,
    })
  }
  ok(res, { id: item.id })
}))

// DELETE /cases/:id/items/:itemId — custom items only; template items are marked N/A instead.
partnershipRouter.delete('/cases/:id/items/:itemId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const c = await loadCase(session, scope, req.params.id, kindOf(res))
  const item = await prisma.partnershipCaseItem.findFirst({ where: { id: req.params.itemId, caseId: c.id, deletedAt: null } })
  if (!item) throw ApiError.notFound('Checklist item not found on this case.')
  if (!item.isCustom) throw ApiError.unprocessable('template_item', 'Items from the master checklist cannot be removed — mark them Not Applicable.')
  await prisma.partnershipCaseItem.update({ where: { id: item.id }, data: { deletedAt: new Date() } })
  await prisma.partnershipDocRequirement.updateMany({ where: { caseId: c.id, itemId: item.id, clientDocumentId: null }, data: { deletedAt: new Date() } })
  await recompute(c.id)
  await logActivity(c.id, session, 'item.removed', `Checklist item "${item.name}" removed`, { type: 'item', id: item.id })
  await writeAudit({ actorUserId: session.userId, action: 'partnership_item.delete', entityType: 'partnership_case_item', entityId: item.id, before: item, req })
  ok(res, { id: item.id })
}))

// ── Documents ──────────────────────────────────────────────────────────────

/**
 * POST /cases/:id/documents (multipart)
 *   file              the file
 *   requirement_id    upload against this requirement (new version if one exists)
 *   OR name, category_name, item_id   an ad-hoc document, optionally linked
 *   notes
 */
partnershipRouter.post('/cases/:id/documents',
  (req, res, next) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (!err) return next()
      if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
        return next(ApiError.unprocessable('too_large', `File is larger than the ${MAX_UPLOAD_MB} MB limit.`))
      }
      next(ApiError.badRequest('Upload could not be read.'))
    })
  },
  handler(async (req, res) => {
    const session = requireSession(req)
    const scope = requireWorkstation(session, 'workstation.document.manage')
    const c = await loadCase(session, scope, req.params.id, kindOf(res))
    const file = req.file
    if (!file) throw ApiError.badRequest('Choose a file to upload.', { file: 'Choose a file to upload.' })
    const ext = (file.originalname.split('.').pop() ?? '').toLowerCase()
    if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
      throw ApiError.unprocessable('file_type', `Allowed types: ${ALLOWED_EXTENSIONS.join(', ').toUpperCase()}.`)
    }
    const b = body(req)
    const notes = str(b.notes)?.slice(0, 2000) ?? null

    let r
    if (str(b.requirement_id)) {
      r = await loadRequirement(c.id, str(b.requirement_id)!)
    } else {
      let itemId: string | null = null
      let categoryName = str(b.category_name)?.slice(0, 200) ?? 'Additional Documents'
      if (str(b.item_id)) {
        const item = await prisma.partnershipCaseItem.findFirst({ where: { id: str(b.item_id)!, caseId: c.id, deletedAt: null }, include: { category: true } })
        if (!item) throw ApiError.notFound('Checklist item not found on this case.')
        itemId = item.id
        categoryName = item.category.name
      }
      const n = await prisma.partnershipDocRequirement.count({ where: { caseId: c.id } })
      const created = await prisma.partnershipDocRequirement.create({
        data: {
          caseId: c.id, itemId, name: str(b.name)?.slice(0, 300) ?? file.originalname.replace(/\.[^.]+$/, ''),
          categoryName, requirement: 'OPTIONAL', sortOrder: (n + 1) * 10, createdBy: session.userId,
        },
      })
      r = await loadRequirement(c.id, created.id)
    }

    // "Any one" requirements: the uploader says which option this file is.
    const options = r.docTypeOptions ? r.docTypeOptions.split('|') : null
    const documentType = str(b.document_type) ?? null
    if (options && (!documentType || !options.includes(documentType))) {
      throw ApiError.badRequest(`Choose which document this is: ${options.join(', ')}.`, { document_type: 'Choose the document type.' })
    }
    const fe = new FieldErrors()
    const documentDate = fe.date('document_date', b.document_date) ?? null
    fe.throwIfAny()

    const uploader = session.employeeId ?? session.userId
    const categoryId = await registrationCategoryId()
    const doc = r.clientDocument && !r.clientDocument.deletedAt
      ? r.clientDocument
      : await prisma.clientDocument.create({
          data: {
            clientId: c.clientId, categoryId, name: `${r.name} (${c.caseCode})`, status: 'requested',
            requestedByEmployeeId: session.employeeId, requestedAt: new Date(), createdBy: session.userId,
          },
          include: { versions: true },
        })
    const prev = doc.versions.find((v) => v.version === doc.currentVersion) ?? null
    const version = doc.currentVersion + 1
    const key = fileKey(c.id, doc.id, version, file.originalname)
    await partnershipStorage.put(key, file.buffer)

    const v = await prisma.$transaction(async (tx) => {
      const created = await tx.clientDocumentVersion.create({
        data: {
          documentId: doc.id, version, fileKey: key, uploadedBy: uploader, sizeBytes: file.size,
          notes, previousVersionId: prev?.id ?? null, originalName: file.originalname,
          mimeType: MIME_BY_EXT[ext] ?? file.mimetype, reviewStatus: 'uploaded',
          documentType: options ? documentType : null, documentDate,
        },
      })
      await tx.clientDocument.update({
        where: { id: doc.id },
        data: { currentVersion: version, status: 'uploaded', rejectionReason: null, verifiedAt: null, verifiedByEmployeeId: null, updatedBy: session.userId },
      })
      await tx.partnershipDocRequirement.update({ where: { id: r.id }, data: { clientDocumentId: doc.id, notApplicable: false } })
      return created
    })

    await recompute(c.id)
    const replaced = version > 1
    await logActivity(c.id, session, replaced ? 'document.replaced' : 'document.uploaded',
      `${r.name}: ${file.originalname}${options ? ` (${documentType})` : ''} ${replaced ? `uploaded as version ${version}` : 'uploaded'}`,
      { type: 'requirement', id: r.id }, { version, file: file.originalname })
    await writeAudit({
      actorUserId: session.userId, action: replaced ? 'partnership_document.replace' : 'partnership_document.upload',
      entityType: 'client_document', entityId: doc.id, after: { requirementId: r.id, version, file: file.originalname, sizeBytes: file.size }, req,
    })
    ok(res, { requirement_id: r.id, version_id: v.id, version }, 201)
  }))

// PATCH /cases/:id/requirements/:rid — link to an item, mark N/A, due date, rename.
partnershipRouter.patch('/cases/:id/requirements/:rid', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const c = await loadCase(session, scope, req.params.id, kindOf(res))
  const r = await loadRequirement(c.id, req.params.rid)
  const b = body(req)
  const e = new FieldErrors()
  const dueDate = b.due_date === null || b.due_date === '' ? null : e.date('due_date', b.due_date)
  const name = b.name === undefined ? undefined : e.str('name', b.name, { max: 300 })
  const requirement = oneOf(e, 'requirement', b.requirement, REQUIREMENT_TYPES)
  e.throwIfAny()
  const data: Prisma.PartnershipDocRequirementUpdateInput = {}
  const log: string[] = []
  if (b.item_id !== undefined) {
    if (b.item_id === null || b.item_id === '') {
      data.item = { disconnect: true }
      log.push(`${r.name} unlinked from checklist`)
    } else {
      const item = await prisma.partnershipCaseItem.findFirst({ where: { id: String(b.item_id), caseId: c.id, deletedAt: null }, include: { category: true } })
      if (!item) throw ApiError.notFound('Checklist item not found on this case.')
      data.item = { connect: { id: item.id } }
      data.categoryName = item.category.name
      log.push(`${r.name} linked to "${item.name}"`)
    }
  }
  if (typeof b.not_applicable === 'boolean' && b.not_applicable !== r.notApplicable) {
    data.notApplicable = b.not_applicable
    log.push(`${r.name} marked ${b.not_applicable ? 'Not Applicable' : 'applicable'}`)
  }
  if (b.due_date !== undefined && (dueDate ?? null) !== r.dueDate) { data.dueDate = dueDate ?? null; log.push(`${r.name} due ${dueDate ?? '—'}`) }
  if (name && name !== r.name) { data.name = name; log.push(`Document renamed to ${name}`) }
  if (requirement && requirement !== r.requirement) { data.requirement = requirement; log.push(`${r.name} is now ${requirement}`) }
  if (b.category_name !== undefined && str(b.category_name)) { data.categoryName = str(b.category_name)!.slice(0, 200); log.push(`${r.name} moved to ${data.categoryName}`) }
  await prisma.partnershipDocRequirement.update({ where: { id: r.id }, data })
  await recompute(c.id)
  for (const l of log) await logActivity(c.id, session, 'document.updated', l, { type: 'requirement', id: r.id })
  if (log.length) await writeAudit({ actorUserId: session.userId, action: 'partnership_requirement.update', entityType: 'partnership_requirement', entityId: r.id, before: { itemId: r.itemId, notApplicable: r.notApplicable, dueDate: r.dueDate }, after: b, req })
  ok(res, { id: r.id })
}))

// POST /cases/:id/requirements/:rid/review — review the LATEST version.
//   { status: under_review | verified | rejected | replacement_required, note }
partnershipRouter.post('/cases/:id/requirements/:rid/review', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const c = await loadCase(session, scope, req.params.id, kindOf(res))
  const r = await loadRequirement(c.id, req.params.rid)
  const b = body(req)
  const e = new FieldErrors()
  const status = oneOf(e, 'status', b.status, ['under_review', 'verified', 'rejected', 'replacement_required'] as const)
  if (!status) e.add('status', 'Choose a review outcome.')
  const note = e.str('note', b.note, { max: 2000, required: status === 'rejected' || status === 'replacement_required' })
  e.throwIfAny()
  if (status === 'under_review') requireWorkstation(session, 'workstation.document.manage')
  else mustCan(session, 'workstation.document.verify')

  const v = latestVersion(r)
  if (!v || !r.clientDocument) throw ApiError.unprocessable('nothing_uploaded', 'Nothing has been uploaded for this document yet.')
  const now = new Date()
  await prisma.$transaction([
    prisma.clientDocumentVersion.update({
      where: { id: v.id },
      data: { reviewStatus: status!, reviewedByEmployeeId: session.employeeId, reviewedAt: now, reviewNote: note ?? null },
    }),
    prisma.clientDocument.update({
      where: { id: r.clientDocument.id },
      data: {
        status: status === 'replacement_required' ? 'rejected' : status!,
        verifiedByEmployeeId: status === 'verified' ? session.employeeId : null,
        verifiedAt: status === 'verified' ? now : null,
        rejectionReason: status === 'rejected' || status === 'replacement_required' ? note ?? null : null,
        updatedBy: session.userId,
      },
    }),
  ])
  await recompute(c.id)
  const label = { under_review: 'sent for review', verified: 'verified', rejected: 'rejected', replacement_required: 'marked replacement required' }[status!]
  await logActivity(c.id, session, `document.${status}`, `${r.name} v${v.version} ${label}${note ? ` — ${note}` : ''}`, { type: 'requirement', id: r.id })
  await writeAudit({ actorUserId: session.userId, action: `partnership_document.${status}`, entityType: 'client_document', entityId: r.clientDocument.id, before: { version: v.version, reviewStatus: v.reviewStatus }, after: { version: v.version, reviewStatus: status, note }, req })
  ok(res, { id: r.id, status: status!.toUpperCase() })
}))

// DELETE /cases/:id/requirements/:rid — remove the uploaded file set.
// Verifiers only. The ClientDocument is soft-deleted and the bytes are kept,
// so the audit trail can always say what was there.
partnershipRouter.delete('/cases/:id/requirements/:rid', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  mustCan(session, 'workstation.document.verify')
  const c = await loadCase(session, scope, req.params.id, kindOf(res))
  const r = await loadRequirement(c.id, req.params.rid)
  const adhoc = !r.docKey && !r.partnerId && (!r.itemId || r.requirement === 'OPTIONAL')
  await prisma.$transaction(async (tx) => {
    if (r.clientDocument) await tx.clientDocument.update({ where: { id: r.clientDocument.id }, data: { deletedAt: new Date(), updatedBy: session.userId } })
    await tx.partnershipDocRequirement.update({
      where: { id: r.id },
      data: adhoc ? { deletedAt: new Date(), clientDocument: { disconnect: true } } : { clientDocument: { disconnect: true } },
    })
  })
  await recompute(c.id)
  await logActivity(c.id, session, 'document.deleted', `${r.name}: uploaded file${(r.clientDocument?.versions.length ?? 0) > 1 ? 's' : ''} deleted`, { type: 'requirement', id: r.id })
  await writeAudit({ actorUserId: session.userId, action: 'partnership_document.delete', entityType: 'client_document', entityId: r.clientDocument?.id ?? r.id, before: { requirement: r.name, versions: r.clientDocument?.versions.map((v) => ({ version: v.version, file: v.originalName, key: v.fileKey })) }, req })
  ok(res, { id: r.id })
}))

// GET /cases/:id/requirements/:rid/versions/:versionId/link — short-lived signed URL.
partnershipRouter.get('/cases/:id/requirements/:rid/versions/:versionId/link', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const c = await loadCase(session, scope, req.params.id, kindOf(res))
  const r = await loadRequirement(c.id, req.params.rid)
  const v = r.clientDocument?.versions.find((x) => x.id === req.params.versionId)
  if (!v || !v.mimeType) throw ApiError.notFound('File not found.')
  const link = signedLink(`/api/partnership-files/${v.id}`, `pfr-file:${v.id}`, session.userId)
  ok(res, { ...link, mime_type: v.mimeType, original_name: v.originalName, size_bytes: v.sizeBytes })
}))

// GET /api/partnership-files/:versionId?t=…[&inline=1] — the bytes. Unauthenticated; the token is the check.
partnershipSignedRouter.get('/partnership-files/:versionId', handler(async (req, res) => {
  const id = req.params.versionId
  verifyResourceToken(`pfr-file:${id}`, typeof req.query.t === 'string' ? req.query.t : undefined)
  const v = await prisma.clientDocumentVersion.findUnique({ where: { id } })
  if (!v || !v.mimeType) throw ApiError.notFound('File not found.')
  const bytes = await partnershipStorage.get(v.fileKey)
  const nameOut = v.originalName ?? `document-v${v.version}`
  const inline = req.query.inline === '1'
  res.setHeader('Content-Type', v.mimeType)
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${nameOut.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(nameOut)}`)
  res.send(bytes)
}))

// ── Activity ───────────────────────────────────────────────────────────────

partnershipRouter.get('/cases/:id/activity', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const c = await loadCase(session, scope, req.params.id, kindOf(res))
  const rows = await prisma.partnershipActivity.findMany({ where: { caseId: c.id }, orderBy: { createdAt: 'desc' }, take: 500 })
  const m = await employeeMap(rows.map((r) => r.actorEmployeeId))
  ok(res, {
    items: rows.map((r) => ({
      id: r.id, action: r.action, detail: r.detail, entity_type: r.entityType, entity_id: r.entityId,
      actor: ref(m, r.actorEmployeeId), created_at: r.createdAt,
    })),
  })
}))

// ── Master template (admin) ────────────────────────────────────────────────

function requireTemplateAdmin(session: Session) {
  requireWorkstation(session, ...READ)
  mustCan(session, 'workstation.registration.template.manage')
}

partnershipRouter.get('/template', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, ...READ)
  const cats = await prisma.partnershipTemplateCategory.findMany({
    where: { kind: kindOf(res), deletedAt: null }, orderBy: { sortOrder: 'asc' },
    include: { items: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } } },
  })
  ok(res, {
    can_manage: can(session, 'workstation.registration.template.manage', 'organisation'),
    stages: KINDS[kindOf(res)].stages,
    categories: cats.map((cat) => ({
      id: cat.id, name: cat.name, description: cat.description, stage: cat.stage, sort_order: cat.sortOrder,
      per_partner: cat.perPartner,
      items: cat.items.map((i) => ({
        id: i.id, name: i.name, description: i.description, requirement: i.requirement, kind: i.kind,
        per_partner: i.perPartner, doc_key: i.docKey, condition: i.condition,
        doc_type_options: i.docTypeOptions ? i.docTypeOptions.split('|') : null, max_age_days: i.maxAgeDays,
        default_due_days: i.defaultDueDays, default_assignee: i.defaultAssignee, sort_order: i.sortOrder,
      })),
    })),
  })
}))

function templateItemFields(b: Record<string, unknown>, partial: boolean) {
  const e = new FieldErrors()
  const out: Prisma.PartnershipTemplateItemUncheckedUpdateInput = {}
  if (!partial || b.name !== undefined) out.name = e.str('name', b.name, { max: 300 })
  if (b.description !== undefined) out.description = e.str('description', b.description, { max: 2000, required: false }) ?? null
  if (!partial || b.requirement !== undefined) out.requirement = oneOf(e, 'requirement', b.requirement, REQUIREMENT_TYPES) ?? 'REQUIRED'
  if (!partial || b.kind !== undefined) out.kind = oneOf(e, 'kind', b.kind, ITEM_KINDS) ?? 'ACTION'
  if (b.per_partner !== undefined) out.perPartner = !!b.per_partner
  if (b.doc_key !== undefined) out.docKey = str(b.doc_key)?.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 40) ?? null
  if (b.condition !== undefined) out.condition = b.condition ? oneOf(e, 'condition', b.condition, CONDITIONS) ?? null : null
  if (b.default_due_days !== undefined) {
    const n = b.default_due_days === null || b.default_due_days === '' ? null : Number(b.default_due_days)
    if (n !== null && (!Number.isInteger(n) || n < 0 || n > 365)) e.add('default_due_days', 'Whole days, 0–365.')
    out.defaultDueDays = n
  }
  if (b.doc_type_options !== undefined) {
    const list = (Array.isArray(b.doc_type_options) ? b.doc_type_options : String(b.doc_type_options ?? '').split(/[|,]/))
      .map((x) => String(x).trim()).filter(Boolean).slice(0, 10)
    out.docTypeOptions = list.length ? list.join('|') : null
  }
  if (b.max_age_days !== undefined) {
    const n = b.max_age_days === null || b.max_age_days === '' ? null : Number(b.max_age_days)
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 3650)) e.add('max_age_days', 'Whole days, 1–3650.')
    out.maxAgeDays = n
  }
  if (b.default_assignee !== undefined) out.defaultAssignee = b.default_assignee ? oneOf(e, 'default_assignee', b.default_assignee, ['ASSIGNEE', 'REVIEWER'] as const) ?? null : null
  if (b.sort_order !== undefined && Number.isFinite(Number(b.sort_order))) out.sortOrder = Number(b.sort_order)
  e.throwIfAny()
  return out
}

partnershipRouter.post('/template/categories', handler(async (req, res) => {
  const session = requireSession(req)
  requireTemplateAdmin(session)
  const b = body(req)
  const e = new FieldErrors()
  const name = e.str('name', b.name, { max: 200 })
  const kind = kindOf(res)
  const stage = oneOf(e, 'stage', b.stage, KINDS[kind].stages) ?? KINDS[kind].stages[0]
  const description = e.str('description', b.description, { max: 1000, required: false })
  e.throwIfAny()
  const last = await prisma.partnershipTemplateCategory.findFirst({ where: { kind, deletedAt: null }, orderBy: { sortOrder: 'desc' } })
  const cat = await prisma.partnershipTemplateCategory.create({ data: { kind, perPartner: !!b.per_partner, name: name!, stage, description: description ?? null, sortOrder: (last?.sortOrder ?? 0) + 10, createdBy: session.userId } })
  await writeAudit({ actorUserId: session.userId, action: 'partnership_template.category_create', entityType: 'partnership_template_category', entityId: cat.id, after: cat, req })
  ok(res, { id: cat.id }, 201)
}))

partnershipRouter.patch('/template/categories/:cid', handler(async (req, res) => {
  const session = requireSession(req)
  requireTemplateAdmin(session)
  const cat = await prisma.partnershipTemplateCategory.findFirst({ where: { id: req.params.cid, kind: kindOf(res), deletedAt: null } })
  if (!cat) throw ApiError.notFound('Category not found.')
  const b = body(req)
  const e = new FieldErrors()
  const data: Prisma.PartnershipTemplateCategoryUpdateInput = { updatedBy: session.userId }
  if (b.name !== undefined) data.name = e.str('name', b.name, { max: 200 })
  if (b.description !== undefined) data.description = e.str('description', b.description, { max: 1000, required: false }) ?? null
  if (b.stage !== undefined) data.stage = oneOf(e, 'stage', b.stage, KINDS[kindOf(res)].stages)
  if (b.sort_order !== undefined && Number.isFinite(Number(b.sort_order))) data.sortOrder = Number(b.sort_order)
  e.throwIfAny()
  const after = await prisma.partnershipTemplateCategory.update({ where: { id: cat.id }, data })
  await writeAudit({ actorUserId: session.userId, action: 'partnership_template.category_update', entityType: 'partnership_template_category', entityId: cat.id, before: cat, after, req })
  ok(res, { id: cat.id })
}))

partnershipRouter.delete('/template/categories/:cid', handler(async (req, res) => {
  const session = requireSession(req)
  requireTemplateAdmin(session)
  const cat = await prisma.partnershipTemplateCategory.findFirst({ where: { id: req.params.cid, kind: kindOf(res), deletedAt: null } })
  if (!cat) throw ApiError.notFound('Category not found.')
  const now = new Date()
  await prisma.$transaction([
    prisma.partnershipTemplateItem.updateMany({ where: { categoryId: cat.id, deletedAt: null }, data: { deletedAt: now } }),
    prisma.partnershipTemplateCategory.update({ where: { id: cat.id }, data: { deletedAt: now, updatedBy: session.userId } }),
  ])
  await writeAudit({ actorUserId: session.userId, action: 'partnership_template.category_delete', entityType: 'partnership_template_category', entityId: cat.id, before: cat, req })
  ok(res, { id: cat.id })
}))

partnershipRouter.post('/template/items', handler(async (req, res) => {
  const session = requireSession(req)
  requireTemplateAdmin(session)
  const b = body(req)
  const cat = await prisma.partnershipTemplateCategory.findFirst({ where: { id: String(b.category_id ?? ''), kind: kindOf(res), deletedAt: null } })
  if (!cat) throw ApiError.badRequest('Choose a category.', { category_id: 'Choose a category.' })
  const fields = templateItemFields(b, false)
  const last = await prisma.partnershipTemplateItem.findFirst({ where: { categoryId: cat.id, deletedAt: null }, orderBy: { sortOrder: 'desc' } })
  const item = await prisma.partnershipTemplateItem.create({
    data: { ...(fields as Prisma.PartnershipTemplateItemUncheckedCreateInput), categoryId: cat.id, sortOrder: (fields.sortOrder as number | undefined) ?? (last?.sortOrder ?? 0) + 10, createdBy: session.userId },
  })
  await writeAudit({ actorUserId: session.userId, action: 'partnership_template.item_create', entityType: 'partnership_template_item', entityId: item.id, after: item, req })
  ok(res, { id: item.id }, 201)
}))

partnershipRouter.patch('/template/items/:iid', handler(async (req, res) => {
  const session = requireSession(req)
  requireTemplateAdmin(session)
  const item = await prisma.partnershipTemplateItem.findFirst({ where: { id: req.params.iid, deletedAt: null, category: { kind: kindOf(res) } } })
  if (!item) throw ApiError.notFound('Item not found.')
  const after = await prisma.partnershipTemplateItem.update({ where: { id: item.id }, data: { ...templateItemFields(body(req), true), updatedBy: session.userId } })
  await writeAudit({ actorUserId: session.userId, action: 'partnership_template.item_update', entityType: 'partnership_template_item', entityId: item.id, before: item, after, req })
  ok(res, { id: item.id })
}))

partnershipRouter.delete('/template/items/:iid', handler(async (req, res) => {
  const session = requireSession(req)
  requireTemplateAdmin(session)
  const item = await prisma.partnershipTemplateItem.findFirst({ where: { id: req.params.iid, deletedAt: null, category: { kind: kindOf(res) } } })
  if (!item) throw ApiError.notFound('Item not found.')
  await prisma.partnershipTemplateItem.update({ where: { id: item.id }, data: { deletedAt: new Date(), updatedBy: session.userId } })
  await writeAudit({ actorUserId: session.userId, action: 'partnership_template.item_delete', entityType: 'partnership_template_item', entityId: item.id, before: item, req })
  ok(res, { id: item.id })
}))
