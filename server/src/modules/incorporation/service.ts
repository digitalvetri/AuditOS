import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import { nextIncorporationCaseCode } from '../../platform/workstation/codes.js'
import { CHECKLIST_TEMPLATE, isQueryOverdue, rolesOf, statusForStage } from './validate.js'

type Tx = PrismaClient | Prisma.TransactionClient

export const today = () => new Date().toISOString().slice(0, 10)

export const addDays = (iso: string, days: number): string => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/**
 * CASE PROGRESS. Computed here, on the server, from the case's checklist —
 * never sent up from the browser and never cached in a column, so it cannot
 * drift away from the items it describes. `not_applicable` rows leave the
 * denominator, because a percentage that punishes you for correctly marking
 * something irrelevant is a broken percentage.
 */
export interface Progress {
  total: number
  completed: number
  pending: number
  blocked: number
  percent: number
}

export function progressFrom(items: { status: string }[]): Progress {
  const counted = items.filter((i) => i.status !== 'not_applicable')
  const total = counted.length
  const completed = counted.filter((i) => i.status === 'completed').length
  const blocked = counted.filter((i) => i.status === 'blocked').length
  return {
    total,
    completed,
    pending: total - completed,
    blocked,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
  }
}

/** Progress for many cases in one query rather than N. */
export async function progressByCase(caseIds: string[]): Promise<Map<string, Progress>> {
  const out = new Map<string, Progress>()
  if (caseIds.length === 0) return out
  const rows = await prisma.incorporationChecklistItem.findMany({
    where: { caseId: { in: caseIds } },
    select: { caseId: true, status: true },
  })
  const grouped = new Map<string, { status: string }[]>()
  for (const id of caseIds) grouped.set(id, [])
  for (const r of rows) grouped.get(r.caseId)?.push({ status: r.status })
  for (const [id, items] of grouped) out.set(id, progressFrom(items))
  return out
}

/**
 * The checklist templates that apply to an entity type: the baseline rows
 * (entityTypeId = null) plus that type's own, in category order. Templates
 * are DATA — this function is the only thing that knows how to combine them,
 * and no component branches on an entity type code.
 */
export async function templatesFor(db: Tx, entityTypeId: string) {
  const rows = await db.incorporationChecklistTemplate.findMany({
    where: { deletedAt: null, isActive: true, OR: [{ entityTypeId: null }, { entityTypeId }] },
    orderBy: [{ sortOrder: 'asc' }],
  })
  return rows
}

/**
 * Creating a case allocates its code, lays down its parties and instantiates
 * its checklist IN ONE TRANSACTION. A case without its checklist is not a
 * state we want reachable, least of all halfway through a failed request.
 */
export async function createCaseWithChecklist(
  db: Tx,
  input: {
    organisationId: string
    clientId: string
    entityTypeId: string
    clientServiceId?: string | null
    proposedName: string
    alternateName?: string | null
    businessActivity?: string | null
    businessCategory?: string | null
    state?: string | null
    city?: string | null
    registeredOfficeInfo?: string | null
    incorporationObjective?: string | null
    assignedEmployeeId: string
    priority: string
    targetDate?: string | null
    internalNotes?: string | null
    parties: {
      role: string; name: string; contactNumber?: string | null; email?: string | null
      address?: string | null; clientContactId?: string | null; dscRequired: boolean
    }[]
    documentRequests: { category: string; documentType: string; description?: string | null }[]
    createdBy?: string | null
    isDemo?: boolean
  },
) {
  const entityType = await db.incorporationEntityType.findFirst({
    where: { id: input.entityTypeId, deletedAt: null },
  })
  if (!entityType) throw ApiError.badRequest('Choose an entity type.', { entity_type_id: 'Unknown entity type.' })

  // Party roles are validated against THIS entity type's list, so an LLP
  // cannot acquire a director.
  const roles = rolesOf(entityType)
  for (const [i, p] of input.parties.entries()) {
    if (!roles.includes(p.role)) {
      throw ApiError.badRequest('Please correct the highlighted fields.', {
        [`parties.${i}.role`]: `${entityType.name} does not use that role.`,
      })
    }
  }
  if (input.parties.length < entityType.minParties) {
    throw ApiError.badRequest('Please correct the highlighted fields.', {
      parties: `${entityType.name} needs at least ${entityType.minParties} ${entityType.minParties === 1 ? 'person' : 'people'}.`,
    })
  }
  if (entityType.maxParties !== null && input.parties.length > entityType.maxParties) {
    throw ApiError.badRequest('Please correct the highlighted fields.', {
      parties: `${entityType.name} takes at most ${entityType.maxParties} people.`,
    })
  }

  const year = Number(today().slice(0, 4))
  const caseCode = await nextIncorporationCaseCode(db, year)
  const templates = await templatesFor(db, input.entityTypeId)

  return db.incorporationCase.create({
    data: {
      organisationId: input.organisationId,
      caseCode,
      clientId: input.clientId,
      entityTypeId: input.entityTypeId,
      clientServiceId: input.clientServiceId ?? null,
      proposedName: input.proposedName,
      alternateName: input.alternateName ?? null,
      businessActivity: input.businessActivity ?? null,
      businessCategory: input.businessCategory ?? null,
      state: input.state ?? null,
      city: input.city ?? null,
      registeredOfficeInfo: input.registeredOfficeInfo ?? null,
      incorporationObjective: input.incorporationObjective ?? null,
      stage: 'new',
      status: 'active',
      priority: input.priority,
      assignedEmployeeId: input.assignedEmployeeId,
      targetDate: input.targetDate ?? addDays(today(), entityType.defaultTargetDays),
      internalNotes: input.internalNotes ?? null,
      createdBy: input.createdBy ?? null,
      isDemo: input.isDemo ?? false,
      parties: {
        create: input.parties.map((p, i) => ({
          role: p.role,
          name: p.name,
          contactNumber: p.contactNumber ?? null,
          email: p.email ?? null,
          address: p.address ?? null,
          clientContactId: p.clientContactId ?? null,
          dscRequired: p.dscRequired,
          sortOrder: i,
          createdBy: input.createdBy ?? null,
        })),
      },
      checklistItems: {
        create: templates.map((t, i) => ({
          templateId: t.id,
          category: t.category,
          label: t.label,
          stage: t.stage,
          sortOrder: i,
        })),
      },
      documentRequests: {
        create: input.documentRequests.map((d) => ({
          clientId: input.clientId,
          category: d.category,
          documentType: d.documentType,
          description: d.description ?? null,
          status: 'required',
          createdBy: input.createdBy ?? null,
        })),
      },
    },
    include: {
      client: true,
      entityType: true,
      parties: { orderBy: { sortOrder: 'asc' } },
      checklistItems: { orderBy: { sortOrder: 'asc' } },
      documentRequests: true,
    },
  })
}

/**
 * Append-only per-case trail (AuditLog stays the compliance record). Never
 * lets its own failure take down the operation it was describing.
 */
export async function writeCaseActivity(input: {
  caseId: string
  actorUserId: string | null
  action: string
  detail?: string | null
}): Promise<void> {
  try {
    await prisma.incorporationActivity.create({
      data: {
        caseId: input.caseId,
        actorUserId: input.actorUserId,
        action: input.action,
        detail: input.detail ?? null,
      },
    })
  } catch (err) {
    console.error('[incorporation] activity write failed', err instanceof Error ? err.message : err)
  }
}

/** The `where` fragment that scopes any case-hung table to visible clients. */
export function caseScope(clientWhere: { clientId?: { in: string[] } }) {
  return clientWhere.clientId ? { case: { clientId: clientWhere.clientId } } : {}
}

/**
 * OVERVIEW KPIs (§6.1). Every number below is a database aggregate over the
 * caller's visible clients. There is no hard-coded figure anywhere here, and
 * each one has a matching Cases filter so the tile can be clicked through.
 */
export async function overviewKpis(clientWhere: { clientId?: { in: string[] } }) {
  const t = today()
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

  const cw = clientWhere.clientId ? { clientId: clientWhere.clientId } : {}
  const sub = caseScope(clientWhere)

  const [
    activeCases, newCases, documentsPending, dscPending, namePending, filingPending,
    governmentQueries, resubmissionRequired, approvalPending, overdueTasks, completedThisMonth,
  ] = await Promise.all([
    prisma.incorporationCase.count({ where: { ...alive, ...cw, status: 'active' } }),
    prisma.incorporationCase.count({ where: { ...alive, ...cw, stage: 'new' } }),
    prisma.incorporationCase.count({ where: { ...alive, ...cw, stage: { in: ['documents_pending', 'information_collection'] } } }),
    prisma.incorporationCase.count({ where: { ...alive, ...cw, stage: 'dsc_pending' } }),
    prisma.incorporationCase.count({ where: { ...alive, ...cw, stage: { in: ['name_preparation', 'name_submitted', 'name_rework'] } } }),
    prisma.incorporationCase.count({ where: { ...alive, ...cw, stage: { in: ['filing_preparation', 'filing_submitted'] } } }),
    prisma.incorporationQuery.count({ where: { ...alive, ...sub, status: { not: 'resolved' } } }),
    prisma.incorporationCase.count({ where: { ...alive, ...cw, stage: { in: ['government_query', 'resubmission'] } } }),
    prisma.incorporationCase.count({ where: { ...alive, ...cw, stage: { in: ['government_processing', 'approved'] } } }),
    prisma.task.count({
      where: {
        ...alive, ...cw,
        incorporationCaseId: { not: null },
        dueDate: { lt: t },
        status: { not: 'done' },
      },
    }),
    prisma.incorporationCase.count({ where: { ...alive, ...cw, status: 'completed', completedAt: { gte: monthStart } } }),
  ])

  return {
    active_cases: activeCases,
    new_cases: newCases,
    documents_pending: documentsPending,
    dsc_pending: dscPending,
    name_pending: namePending,
    filing_pending: filingPending,
    government_queries: governmentQueries,
    resubmission_required: resubmissionRequired,
    approval_pending: approvalPending,
    overdue_tasks: overdueTasks,
    completed_this_month: completedThisMonth,
  }
}

/**
 * PENDING ITEMS (§6.5) — one cross-case work queue assembled from the five
 * things a case actually waits on. Each row carries the case tab it
 * deep-links to, so the queue is navigation, not a report.
 */
export async function pendingItems(clientWhere: { clientId?: { in: string[] } }, take = 200) {
  const t = today()
  const cw = clientWhere.clientId ? { clientId: clientWhere.clientId } : {}
  const sub = caseScope(clientWhere)
  const caseSel = { select: { id: true, caseCode: true, proposedName: true, clientId: true, client: { select: { companyName: true } } } }

  const [docs, dsc, names, queries, tasks] = await Promise.all([
    prisma.incorporationDocumentRequest.findMany({
      where: { ...alive, ...cw, status: { in: ['required', 'requested', 'under_review'] } },
      include: { case: caseSel },
      orderBy: [{ dueDate: 'asc' }],
      take,
    }),
    prisma.incorporationDsc.findMany({
      where: { ...alive, ...sub, required: true, status: { in: ['pending', 'requested', 'issue', 'expired'] } },
      include: { case: caseSel, party: { select: { name: true, role: true } } },
      orderBy: [{ createdAt: 'asc' }],
      take,
    }),
    prisma.incorporationName.findMany({
      where: { ...alive, ...sub, status: { in: ['submitted', 'rework'] } },
      include: { case: caseSel },
      orderBy: [{ submissionDate: 'asc' }],
      take,
    }),
    prisma.incorporationQuery.findMany({
      where: { ...alive, ...sub, status: { not: 'resolved' } },
      include: { case: caseSel },
      orderBy: [{ responseDueDate: 'asc' }],
      take,
    }),
    prisma.task.findMany({
      where: { ...alive, ...cw, incorporationCaseId: { not: null }, dueDate: { lt: t }, status: { not: 'done' } },
      include: { incorporationCase: caseSel.select ? { select: caseSel.select } : undefined },
      orderBy: [{ dueDate: 'asc' }],
      take,
    }),
  ])

  const row = (
    kind: string, tab: string, c: { id: string; caseCode: string; proposedName: string; client?: { companyName: string } | null } | null,
    title: string, detail: string | null, due: string | null, overdue: boolean,
  ) => ({
    kind,
    tab,
    case_id: c?.id ?? null,
    case_code: c?.caseCode ?? null,
    client_name: c?.client?.companyName ?? null,
    proposed_name: c?.proposedName ?? null,
    title,
    detail,
    due_date: due,
    overdue,
  })

  return [
    ...docs.map((d) => row('document', 'documents', d.case, d.documentType,
      d.description, d.dueDate, !!d.dueDate && d.dueDate < t)),
    ...dsc.map((d) => row('dsc', 'dsc', d.case, `DSC — ${d.party.name}`,
      `Status as recorded by employee: ${d.status.replace(/_/g, ' ')}`, d.expiryDate, false)),
    ...names.map((n) => row('name', 'names', n.case, `Name — ${n.proposedName}`,
      `Awaiting a recorded response (priority ${n.priority})`, null, false)),
    ...queries.map((q) => row('query', 'queries', q.case, 'Government query',
      q.description.slice(0, 140), q.responseDueDate, isQueryOverdue(q, t))),
    ...tasks.map((k) => row('task', 'tasks', k.incorporationCase, k.title,
      k.description, k.dueDate, true)),
  ]
}

/** Marking a case complete/cancelled keeps `status` and `stage` in step. */
export function stageSideEffects(stage: string, from: string, reason: string | null) {
  return {
    stage,
    status: statusForStage(stage),
    heldFromStage: stage === 'on_hold' ? from : null,
    completedAt: stage === 'completed' ? new Date() : null,
    cancelledReason: stage === 'cancelled' ? reason : null,
  }
}
