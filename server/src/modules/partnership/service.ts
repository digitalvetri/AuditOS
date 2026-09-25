/**
 * Partnership Firm Registration — the logic that must not live in a route.
 *
 * MASTER vs CASE. `openCase` copies the master template into case-owned rows
 * (categories, items, document requirements). After that the case never reads
 * the template again: editing the master changes only cases opened later.
 *
 * APPLICABILITY. An item or requirement counts only when it is applicable:
 *   - not marked NOT_APPLICABLE / notApplicable, and
 *   - its premises condition (RENTED/OWNED, PDF section B3) matches the case,
 *     or it has no condition.
 * Until the premises type is chosen, BOTH office-proof sets are left out of
 * the counts rather than both being demanded.
 *
 * PROGRESS (stored on the case so the list filters/sorts in the database):
 *   checklist % = completed applicable items ÷ applicable items
 *   document %  = verified applicable required docs ÷ applicable required docs
 *   progressPct = checklist %. Documents are shown beside it, never averaged in.
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import type { Session } from '../../platform/auth.js'
import { KINDS, PFR_DOC_CATEGORY_CODE, type RegistrationKind } from './constants.js'

type Tx = Prisma.TransactionClient

export const ITEM_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'NOT_APPLICABLE', 'BLOCKED'] as const
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const
export const REQUIREMENT_TYPES = ['REQUIRED', 'OPTIONAL', 'CONDITIONAL'] as const
export const ITEM_KINDS = ['INFO', 'DOCUMENT', 'ACTION'] as const
export const PREMISES = ['RENTED', 'OWNED'] as const
/** Entity types a GST Registration case can be scoped to (spec §7.1). */
export const ENTITY_TYPES = ['PROPRIETORSHIP', 'PARTNERSHIP', 'LLP', 'PVT_LTD'] as const
/** Anything an item's own `condition` may name: premises, or an entity type. */
export const CONDITIONS = [...PREMISES, ...ENTITY_TYPES] as const
/** Per-version review outcome. */
export const REVIEW_STATUSES = ['uploaded', 'under_review', 'verified', 'rejected', 'replacement_required'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

/** IST calendar date — these are Indian filings. */
export function today(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 'PFR-2026-0001' / 'LLP-2026-0001'. Soft-deleted rows included so a code is never reissued. */
export async function nextCaseCode(tx: Tx, codePrefix: string, year: number): Promise<string> {
  const prefix = `${codePrefix}-${year}-`
  const rows = await tx.partnershipCase.findMany({
    where: { caseCode: { startsWith: prefix } },
    select: { caseCode: true },
  })
  let max = 0
  for (const r of rows) {
    const n = Number(r.caseCode.slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

/** What decides applicability on a case: premises type, and (GST) business type. */
export interface CaseConditions { premisesType: string | null; entityType: string | null }

export function conditionApplies(condition: string | null, c: CaseConditions): boolean {
  if (!condition) return true
  if (condition === 'RENTED' || condition === 'OWNED') return condition === c.premisesType
  return condition === c.entityType
}

/**
 * True when an entity-scoped row applies to a case whose client is of the
 * given entity type. Null condition means "all entity types", so it always
 * applies. `LLP_OR_PVT_LTD` matches either LLP or PVT_LTD (used at the
 * category level; item-level conditions are single entity types).
 *
 * Until an entity type is chosen on the case, entity-scoped rows are
 * PENDING — the case still shows every category so the operator can see
 * what the checklist will look like once they pick the entity type.
 */
export function entityConditionApplies(condition: string | null, entityType: string | null): boolean {
  if (!condition) return true
  if (!entityType) return true
  if (condition === 'LLP_OR_PVT_LTD') return entityType === 'LLP' || entityType === 'PVT_LTD'
  return condition === entityType
}

/** Append to the case trail and bump lastActivityAt. Never throws into the request. */
export async function logActivity(
  caseId: string, session: Session, action: string, detail: string,
  entity?: { type: string; id: string }, meta?: unknown,
): Promise<void> {
  try {
    await prisma.$transaction([
      prisma.partnershipActivity.create({
        data: {
          caseId,
          actorUserId: session.userId,
          actorEmployeeId: session.employeeId,
          action,
          detail,
          entityType: entity?.type ?? null,
          entityId: entity?.id ?? null,
          metaJson: meta === undefined ? null : JSON.stringify(meta),
        },
      }),
      prisma.partnershipCase.update({ where: { id: caseId }, data: { lastActivityAt: new Date() } }),
    ])
  } catch (err) {
    console.error('[partnership] activity write failed', err instanceof Error ? err.message : err)
  }
}

/**
 * Open a case for an existing client: enrol (ClientService), snapshot the
 * master template, create the non-partner document requirements.
 *
 * `period` and `periodType` only apply to return kinds (GSTR1/2B/3B) and
 * bind the case to a specific tax cycle. Registration kinds pass them as
 * null. The (clientId, kind, period) uniqueness index on PartnershipCase
 * catches accidental duplicates at the DB layer; the route-level idempotent
 * upsert is what callers should reach for.
 *
 * Return kinds skip the ClientService enrolment: their "sellable" ancestor
 * is the GST Compliance enrolment, not a new service per return type. That
 * mirrors the seed's hasCaseFlow=false choice on the GSTR kinds.
 */
export async function openCase(session: Session, kind: RegistrationKind, input: {
  clientId: string
  assignedEmployeeId: string | null
  reviewerEmployeeId: string | null
  approverEmployeeId: string | null
  dueDate: string | null
  entityType?: string | null
  period?: string | null
  periodType?: string | null
}) {
  const start = today()
  return prisma.$transaction(async (tx) => {
    const cfg = KINDS[kind]

    const owner = input.assignedEmployeeId ?? session.employeeId
    const enrolment = cfg.hasCaseFlow && owner
      ? await (async () => {
          const service = await tx.service.findUnique({ where: { code: cfg.serviceCode } })
          if (!service) throw new Error(`${cfg.label} service is not seeded.`)
          return tx.clientService.create({
            data: {
              clientId: input.clientId,
              serviceId: service.id,
              assignedEmployeeId: owner,
              managerId: input.reviewerEmployeeId,
              dueDate: input.dueDate,
              status: 'not_started',
              createdBy: session.userId,
            },
          })
        })()
      : null

    const caseCode = await nextCaseCode(tx, cfg.codePrefix, Number(start.slice(0, 4)))
    const c = await tx.partnershipCase.create({
      data: {
        caseCode,
        kind,
        stage: cfg.stages[0],
        clientId: input.clientId,
        clientServiceId: enrolment?.id ?? null,
        entityType: input.entityType ?? null,
        assignedEmployeeId: input.assignedEmployeeId,
        reviewerEmployeeId: input.reviewerEmployeeId,
        approverEmployeeId: input.approverEmployeeId,
        dueDate: input.dueDate,
        period: input.period ?? null,
        periodType: input.periodType ?? null,
        createdBy: session.userId,
        lastActivityAt: new Date(),
      },
    })

    const template = await tx.partnershipTemplateCategory.findMany({
      where: { kind, deletedAt: null },
      orderBy: { sortOrder: 'asc' },
      include: { items: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } } },
    })

    // One requirement per docKey — PAN and ID proof are asked for in both
    // parts of the PDF but are one file. Per-partner keys wait for partners.
    const docsByKey = new Map<string, { itemId: string; name: string; categoryName: string; requirement: string; condition: string | null; dueDate: string | null; docTypeOptions: string | null; maxAgeDays: number | null }>()
    let reqOrder = 0

    for (const cat of template) {
      const cc = await tx.partnershipCaseCategory.create({
        data: {
          caseId: c.id, sourceCategoryId: cat.id, name: cat.name,
          description: cat.description, stage: cat.stage, sortOrder: cat.sortOrder,
          perPartner: cat.perPartner, entityCondition: cat.entityCondition,
          createdBy: session.userId,
        },
      })
      for (const it of cat.items) {
        const due = it.defaultDueDays != null ? addDays(start, it.defaultDueDays) : null
        const assignee = it.defaultAssignee === 'REVIEWER' ? input.reviewerEmployeeId
          : it.defaultAssignee === 'ASSIGNEE' ? input.assignedEmployeeId : null
        const ci = await tx.partnershipCaseItem.create({
          data: {
            caseId: c.id, categoryId: cc.id, sourceItemId: it.id,
            name: it.name, description: it.description, requirement: it.requirement,
            kind: it.kind, perPartner: it.perPartner, docKey: it.docKey, condition: it.condition,
            entityCondition: it.entityCondition,
            docTypeOptions: it.docTypeOptions, maxAgeDays: it.maxAgeDays,
            gateRule: it.gateRule,
            assignedEmployeeId: assignee, dueDate: due, sortOrder: it.sortOrder,
            createdBy: session.userId,
          },
        })
        // A per-partner category's rows are the case's copy for future
        // partners; their documents are created per partner, not here.
        if (it.kind === 'DOCUMENT' && !it.perPartner && !cat.perPartner) {
          const key = it.docKey ?? `item:${ci.id}`
          if (!docsByKey.has(key)) {
            docsByKey.set(key, {
              itemId: ci.id, name: it.name, categoryName: cat.name,
              requirement: it.requirement, condition: it.condition, dueDate: due,
              docTypeOptions: it.docTypeOptions, maxAgeDays: it.maxAgeDays,
            })
          }
        }
      }
    }

    for (const [key, d] of docsByKey) {
      await tx.partnershipDocRequirement.create({
        data: {
          caseId: c.id, itemId: d.itemId, docKey: key.startsWith('item:') ? null : key,
          name: d.name, categoryName: d.categoryName, requirement: d.requirement,
          condition: d.condition, dueDate: d.dueDate, sortOrder: (reqOrder += 10),
          docTypeOptions: d.docTypeOptions, maxAgeDays: d.maxAgeDays,
          createdBy: session.userId,
        },
      })
    }
    return c
  })
}

/**
 * A partner was added: give them one requirement per per-partner docKey,
 * named after the case's LAST item carrying that key (Part B's wording is the
 * broader one — it adds Driving License to the ID proofs).
 */
export async function addPartnerRequirements(caseId: string, partner: { id: string; name: string }, session: Session) {
  await clonePartnerCategories(caseId, partner, session)
  const items = await prisma.partnershipCaseItem.findMany({
    where: { caseId, deletedAt: null, kind: 'DOCUMENT', perPartner: true, partnerId: null, category: { perPartner: false } },
    include: { category: true },
    orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
  })
  const byKey = new Map<string, (typeof items)[number]>()
  for (const it of items) byKey.set(it.docKey ?? `item:${it.id}`, it)
  const base = await prisma.partnershipDocRequirement.count({ where: { caseId } })
  let order = base * 10
  for (const [key, it] of byKey) {
    await prisma.partnershipDocRequirement.create({
      data: {
        caseId, itemId: it.id, partnerId: partner.id,
        docKey: key.startsWith('item:') ? null : key,
        name: `${it.name} — ${partner.name}`, categoryName: it.category.name,
        requirement: it.requirement, condition: it.condition, dueDate: it.dueDate,
        sortOrder: (order += 10), createdBy: session.userId,
      },
    })
  }
}

/**
 * LLP-style KYC: a per-partner category gets its own copy of every item for
 * this partner ("Ravi — PAN Card"), each DOCUMENT item with its own file.
 * Copied from the CASE's rows, never the master, so a template edit after the
 * case opened cannot change what a new partner is asked for.
 */
async function clonePartnerCategories(caseId: string, partner: { id: string; name: string }, session: Session) {
  const cats = await prisma.partnershipCaseCategory.findMany({
    where: { caseId, deletedAt: null, perPartner: true },
    include: { items: { where: { deletedAt: null, partnerId: null }, orderBy: { sortOrder: 'asc' } } },
  })
  let order = (await prisma.partnershipDocRequirement.count({ where: { caseId } })) * 10
  for (const cat of cats) {
    for (const it of cat.items) {
      const copy = await prisma.partnershipCaseItem.create({
        data: {
          caseId, categoryId: cat.id, sourceItemId: it.sourceItemId, partnerId: partner.id,
          name: it.name, description: it.description, requirement: it.requirement, kind: it.kind,
          condition: it.condition, docTypeOptions: it.docTypeOptions, maxAgeDays: it.maxAgeDays,
          assignedEmployeeId: it.assignedEmployeeId, dueDate: it.dueDate, priority: it.priority,
          isCustom: it.isCustom, sortOrder: it.sortOrder, createdBy: session.userId,
        },
      })
      if (it.kind === 'DOCUMENT') {
        await prisma.partnershipDocRequirement.create({
          data: {
            caseId, itemId: copy.id, partnerId: partner.id, name: `${it.name} — ${partner.name}`,
            categoryName: cat.name, requirement: it.requirement, condition: it.condition,
            docTypeOptions: it.docTypeOptions, maxAgeDays: it.maxAgeDays, dueDate: it.dueDate,
            sortOrder: (order += 10), createdBy: session.userId,
          },
        })
      }
    }
  }
}

/** Rows that are a per-partner category's copy-for-future-partners — never shown or counted. */
export const isPartnerTemplateRow = (i: { partnerId: string | null; category: { perPartner: boolean } }) =>
  i.category.perPartner && !i.partnerId

type ReqWithDoc = Prisma.PartnershipDocRequirementGetPayload<{
  include: { clientDocument: { include: { versions: true } } }
}>

/** The latest version of a requirement's file, or null when nothing is uploaded. */
export function latestVersion(r: ReqWithDoc) {
  const d = r.clientDocument
  if (!d || d.deletedAt || d.currentVersion === 0) return null
  return d.versions.reduce<(typeof d.versions)[number] | null>((a, v) => (!a || v.version > a.version ? v : a), null)
}

/** PENDING | UPLOADED | UNDER_REVIEW | VERIFIED | REJECTED | REPLACEMENT_REQUIRED | NOT_APPLICABLE */
export function requirementStatus(r: ReqWithDoc & ReqEntityScope, c: CaseConditions): string {
  if (r.notApplicable || !conditionApplies(r.condition, c)) return 'NOT_APPLICABLE'
  // GST Registration: a document belongs to a checklist item, whose own entity
  // condition and its category's decide whether this entity type needs it
  // (e.g. Partner KYC only for a Partnership). Same rule as the items.
  if (r.item && (
    !entityConditionApplies(r.item.entityCondition ?? null, c.entityType)
    || !entityConditionApplies(r.item.category?.entityCondition ?? null, c.entityType)
  )) return 'NOT_APPLICABLE'
  const v = latestVersion(r)
  if (!v) return 'PENDING'
  return (v.reviewStatus ?? 'uploaded').toUpperCase()
}

export const requirementInclude = {
  clientDocument: { include: { versions: { orderBy: { version: 'desc' as const } } } },
  partner: true,
  item: { select: { entityCondition: true, category: { select: { entityCondition: true } } } },
} satisfies Prisma.PartnershipDocRequirementInclude

/** The entity scope a document requirement inherits from its checklist item. */
type ReqEntityScope = { item?: { entityCondition: string | null; category: { entityCondition: string | null } | null } | null }

/** Recompute and store the case's progress counters. Call after every write. */
export async function recompute(caseId: string) {
  const c = await prisma.partnershipCase.findUnique({ where: { id: caseId } })
  if (!c) return
  const [items, reqs] = await Promise.all([
    prisma.partnershipCaseItem.findMany({
      where: { caseId, deletedAt: null, category: { deletedAt: null } },
      select: {
        status: true, requirement: true, condition: true, entityCondition: true, partnerId: true,
        category: { select: { perPartner: true, entityCondition: true } },
      },
    }),
    prisma.partnershipDocRequirement.findMany({
      where: { caseId, deletedAt: null },
      include: requirementInclude,
    }),
  ])
  const applicable = items.filter((i) => (
    !isPartnerTemplateRow(i)
    && i.status !== 'NOT_APPLICABLE'
    && conditionApplies(i.condition, c)
    && entityConditionApplies(i.category.entityCondition ?? null, c.entityType)
    && entityConditionApplies(i.entityCondition ?? null, c.entityType)
  ))
  const done = applicable.filter((i) => i.status === 'COMPLETED')
  const required = applicable.filter((i) => i.requirement !== 'OPTIONAL')
  const requiredDone = required.filter((i) => i.status === 'COMPLETED')

  const reqStatuses = reqs
    .filter((r) => r.requirement !== 'OPTIONAL')
    .map((r) => requirementStatus(r, c))
    .filter((s) => s !== 'NOT_APPLICABLE')
  const uploaded = reqStatuses.filter((s) => s !== 'PENDING').length
  const verified = reqStatuses.filter((s) => s === 'VERIFIED').length

  await prisma.partnershipCase.update({
    where: { id: caseId },
    data: {
      itemsTotal: applicable.length,
      itemsDone: done.length,
      itemsRequired: required.length,
      itemsRequiredDone: requiredDone.length,
      docsRequired: reqStatuses.length,
      docsUploaded: uploaded,
      docsVerified: verified,
      progressPct: applicable.length ? Math.round((done.length / applicable.length) * 100) : 0,
    },
  })
}

/** The case status mirrored onto the ClientService enrolment row. */
export function serviceStatusFor(status: string): string {
  switch (status) {
    case 'NOT_STARTED': return 'not_started'
    case 'DOCUMENTS_PENDING': return 'documents_pending'
    case 'UNDER_REVIEW': return 'under_review'
    case 'SUBMITTED': return 'submitted'
    case 'COMPLETED': return 'completed'
    case 'ON_HOLD': return 'on_hold'
    default: return 'in_progress'
  }
}

export async function registrationCategoryId(): Promise<string> {
  const cat = await prisma.documentCategory.findUnique({ where: { code: PFR_DOC_CATEGORY_CODE } })
  if (!cat) throw new Error('Registration document category is not seeded.')
  return cat.id
}
