import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import type { Session } from '../../platform/auth.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { assignedClientIds, assertCanSeeClient, assertCanSeeLead } from '../../platform/workstation/scope.js'
import { nextWorkstationDocCode } from '../../platform/workstation/codes.js'
import type { DocType } from './types.js'

/**
 * WORKSTATION DOCS — the statutory / secretarial documents.
 *
 * The sibling of Quotation and Engagement Letter, and deliberately the
 * thinnest of the three: those two own money and a client commitment, this
 * one owns paper. The body is the editor's `blockConfig`, stored verbatim and
 * walked unchanged by the PDF, so what was composed is what prints.
 *
 * What the server owns, and never trusts from the browser: the code, the type
 * (validated against the canonical list), the party link and the status
 * clock. A document may also belong to NO party — a consent letter is often
 * drafted before the client record exists.
 */

export const INCLUDE = {
  client: { select: { id: true, clientCode: true, companyName: true, address: true, email: true, contactNumber: true, contactPerson: true } },
  lead: { select: { id: true, leadCode: true, name: true, email: true, contactNumber: true } },
} satisfies Prisma.WorkstationDocInclude

export type Row = Prisma.WorkstationDocGetPayload<{ include: typeof INCLUDE }>

/** Rows the caller may see — the rule the other two Workstation documents use. */
async function scopeWhere(session: Session, scope: Scope): Promise<Prisma.WorkstationDocWhereInput> {
  if (scope === 'organisation' || scope === 'department') return {}
  const me = session.employeeId ?? '__none__'
  const ids = await assignedClientIds(session, scope)
  return {
    OR: [
      { preparedById: me },
      { clientId: { in: ids === 'ALL' ? [] : ids } },
      { lead: { assignedEmployeeId: me } },
    ],
  }
}

export interface DocInput {
  docType: DocType
  title: string
  clientId?: string | null
  leadId?: string | null
  docDate: string
  fieldValues?: Record<string, unknown> | null
  blockConfig?: Record<string, unknown>[] | null
  layoutConfig?: Record<string, unknown> | null
}

export function toApi(r: Row) {
  return {
    id: r.id,
    doc_code: r.docCode,
    doc_type: r.docType,
    title: r.title,
    client_id: r.clientId,
    lead_id: r.leadId,
    party_name: r.client?.companyName ?? r.lead?.name ?? null,
    party_kind: r.clientId ? 'client' : r.leadId ? 'lead' : null,
    party_email: r.client?.email ?? r.lead?.email ?? null,
    party_contact_number: r.client?.contactNumber ?? r.lead?.contactNumber ?? null,
    party_address: r.client?.address ?? null,
    party_contact_person: r.client?.contactPerson ?? null,
    doc_date: r.docDate,
    status: r.status,
    is_editable: r.status === 'draft',
    field_values: r.fieldValues,
    block_config: r.blockConfig,
    layout_config: r.layoutConfig,
    finalised_at: r.finalisedAt,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }
}

/** A party is OPTIONAL here, but never both at once. */
async function assertParty(session: Session, scope: Scope, input: Pick<DocInput, 'clientId' | 'leadId'>) {
  if (input.clientId && input.leadId) {
    throw ApiError.badRequest('A document belongs to one party — choose a client or a lead, not both.')
  }
  if (input.clientId) await assertCanSeeClient(session, scope, input.clientId)
  else if (input.leadId) await assertCanSeeLead(session, scope, input.leadId)
}

function columns(input: DocInput) {
  return {
    docType: input.docType,
    title: input.title.trim(),
    clientId: input.clientId ?? null,
    leadId: input.leadId ?? null,
    docDate: input.docDate,
    fieldValues: (input.fieldValues ?? undefined) as Prisma.InputJsonValue | undefined,
    blockConfig: (input.blockConfig ?? undefined) as Prisma.InputJsonValue | undefined,
    layoutConfig: (input.layoutConfig ?? undefined) as Prisma.InputJsonValue | undefined,
  }
}

async function load(session: Session, scope: Scope, id: string): Promise<Row> {
  const where = await scopeWhere(session, scope)
  const row = await prisma.workstationDoc.findFirst({ where: { id, deletedAt: null, ...where }, include: INCLUDE })
  // Not-found and not-yours read the same, as everywhere in Workstation.
  if (!row) throw ApiError.notFound('Document not found.')
  return row
}

function assertEditable(row: Row) {
  if (row.status !== 'draft') {
    throw ApiError.badRequest('This document is final and is frozen. Reopen it, or duplicate it, to make changes.')
  }
}

export const DocService = {
  async list(session: Session, scope: Scope, f: { docType?: string; status?: string; clientId?: string; q?: string; limit?: number; offset?: number }) {
    const where: Prisma.WorkstationDocWhereInput = {
      deletedAt: null,
      ...(await scopeWhere(session, scope)),
      ...(f.docType && f.docType !== 'all' ? { docType: f.docType } : {}),
      ...(f.status && f.status !== 'all' ? { status: f.status } : {}),
      ...(f.clientId ? { clientId: f.clientId } : {}),
      ...(f.q ? {
        AND: [{ OR: [
          { docCode: { contains: f.q, mode: 'insensitive' } },
          { title: { contains: f.q, mode: 'insensitive' } },
          { client: { companyName: { contains: f.q, mode: 'insensitive' } } },
          { lead: { name: { contains: f.q, mode: 'insensitive' } } },
        ] }],
      } : {}),
    }
    const take = Math.min(Math.max(f.limit ?? 50, 1), 200)
    const [rows, total] = await Promise.all([
      prisma.workstationDoc.findMany({ where, include: INCLUDE, orderBy: { createdAt: 'desc' }, take, skip: f.offset ?? 0 }),
      prisma.workstationDoc.count({ where }),
    ])
    return { items: rows.map(toApi), total }
  },

  /** How many documents exist of each type — the count on the Doc cards. */
  async counts(session: Session, scope: Scope) {
    const rows = await prisma.workstationDoc.groupBy({
      by: ['docType'],
      where: { deletedAt: null, ...(await scopeWhere(session, scope)) },
      _count: { _all: true },
    })
    return Object.fromEntries(rows.map((r) => [r.docType, r._count._all]))
  },

  async get(session: Session, scope: Scope, id: string) {
    return toApi(await load(session, scope, id))
  },

  async row(session: Session, scope: Scope, id: string): Promise<Row> {
    return load(session, scope, id)
  },

  async create(session: Session, scope: Scope, input: DocInput) {
    await assertParty(session, scope, input)
    const year = Number(input.docDate.slice(0, 4)) || new Date().getFullYear()
    const row = await prisma.$transaction(async (tx) => {
      const docCode = await nextWorkstationDocCode(tx, year)
      const organisationId = (await tx.organisation.findFirst({ select: { id: true } }))?.id ?? 'org-audit-os'
      return tx.workstationDoc.create({
        data: { ...columns(input), organisationId, docCode, preparedById: session.employeeId ?? null, createdBy: session.userId },
        include: INCLUDE,
      })
    })
    return toApi(row)
  },

  async update(session: Session, scope: Scope, id: string, input: DocInput) {
    const existing = await load(session, scope, id)
    assertEditable(existing)
    await assertParty(session, scope, input)
    // The type is fixed at creation: a consent letter cannot become an LLP
    // agreement, because its stored blocks are the consent letter's.
    if (input.docType !== existing.docType) {
      throw ApiError.badRequest('A document cannot change its type. Create the other type instead.')
    }
    const row = await prisma.workstationDoc.update({
      where: { id },
      data: { ...columns(input), updatedBy: session.userId },
      include: INCLUDE,
    })
    return toApi(row)
  },

  async setStatus(session: Session, scope: Scope, id: string, to: 'draft' | 'final' | 'archived') {
    const row = await load(session, scope, id)
    const allowed: Record<string, string[]> = {
      // A FINAL document may be reopened: statutory paper gets corrected
      // before it is filed, and the alternative is a stack of duplicates.
      draft: ['final', 'archived'],
      final: ['draft'],
      archived: ['draft', 'final'],
    }
    if (!allowed[to].includes(row.status)) {
      throw ApiError.badRequest(`A ${row.status} document cannot be marked ${to}.`)
    }
    const updated = await prisma.workstationDoc.update({
      where: { id },
      data: {
        status: to,
        updatedBy: session.userId,
        ...(to === 'final' ? { finalisedAt: new Date() } : {}),
        ...(to === 'draft' ? { finalisedAt: null } : {}),
      },
      include: INCLUDE,
    })
    return toApi(updated)
  },

  /** A new DRAFT from any document — the same paper for the next director. */
  async duplicate(session: Session, scope: Scope, id: string) {
    const src = await load(session, scope, id)
    return this.create(session, scope, {
      docType: src.docType as DocType,
      title: `${src.title} (copy)`,
      clientId: src.clientId,
      leadId: src.leadId,
      docDate: new Date().toISOString().slice(0, 10),
      fieldValues: (src.fieldValues as Record<string, unknown> | null) ?? null,
      blockConfig: (src.blockConfig as Record<string, unknown>[] | null) ?? null,
      layoutConfig: (src.layoutConfig as Record<string, unknown> | null) ?? null,
    })
  },

  async remove(session: Session, scope: Scope, id: string) {
    await load(session, scope, id)
    await prisma.workstationDoc.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: session.userId } })
  },
}
