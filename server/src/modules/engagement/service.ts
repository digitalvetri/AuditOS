import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import type { Session } from '../../platform/auth.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { assignedClientIds, assertCanSeeClient, assertCanSeeLead } from '../../platform/workstation/scope.js'
import { nextEngagementCode } from '../../platform/workstation/codes.js'

/**
 * ENGAGEMENT LETTERS — the sibling of Quotation.
 *
 * Same visibility rule, same party XOR, same per-year code, same "a sent
 * document is frozen" stance. What differs is the body: a quotation is lines
 * with money the server computes; a letter is prose the user composes. So the
 * server stores the composition verbatim (`blockConfig`) and owns only what
 * must not be trusted from a browser — the code, the party, the status clock.
 */

export const INCLUDE = {
  feeItems: { orderBy: { sortOrder: 'asc' } },
  client: { select: { id: true, clientCode: true, companyName: true, address: true, email: true, contactNumber: true, contactPerson: true } },
  lead: { select: { id: true, leadCode: true, name: true, email: true, contactNumber: true } },
} satisfies Prisma.EngagementLetterInclude

export type Row = Prisma.EngagementLetterGetPayload<{ include: typeof INCLUDE }>

/** Rows the caller may see — the rule quotationScopeWhere uses, unchanged. */
async function scopeWhere(session: Session, scope: Scope): Promise<Prisma.EngagementLetterWhereInput> {
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

export interface FeeInput {
  service: string
  description?: string | null
  frequency?: string | null
  amountPaise: number
  billingBasis?: string | null
  notes?: string | null
}

export interface LetterInput {
  clientId?: string | null
  leadId?: string | null
  subject: string
  letterDate: string
  effectiveFrom?: string | null
  effectiveUntil?: string | null
  financialYear?: string | null
  recipientSnapshot?: Record<string, unknown> | null
  templateId?: string
  blockConfig?: Record<string, unknown>[] | null
  layoutConfig?: Record<string, unknown> | null
  signatoryName?: string | null
  signatoryDesignation?: string | null
  clientSignatoryName?: string | null
  clientSignatoryDesignation?: string | null
  feeItems: FeeInput[]
}

export function toApi(r: Row) {
  return {
    id: r.id,
    letter_code: r.letterCode,
    client_id: r.clientId,
    lead_id: r.leadId,
    party_name: r.client?.companyName ?? r.lead?.name ?? null,
    party_kind: r.clientId ? 'client' : r.leadId ? 'lead' : null,
    party_email: r.client?.email ?? r.lead?.email ?? null,
    party_contact_number: r.client?.contactNumber ?? r.lead?.contactNumber ?? null,
    party_address: r.client?.address ?? null,
    party_contact_person: r.client?.contactPerson ?? null,
    subject: r.subject,
    letter_date: r.letterDate,
    effective_from: r.effectiveFrom,
    effective_until: r.effectiveUntil,
    financial_year: r.financialYear,
    status: r.status,
    is_editable: r.status === 'draft',
    recipient_snapshot: r.recipientSnapshot,
    template_id: r.templateId,
    block_config: r.blockConfig,
    layout_config: r.layoutConfig,
    signatory_name: r.signatoryName,
    signatory_designation: r.signatoryDesignation,
    client_signatory_name: r.clientSignatoryName,
    client_signatory_designation: r.clientSignatoryDesignation,
    sent_at: r.sentAt,
    accepted_at: r.acceptedAt,
    fee_items: r.feeItems.map((f) => ({
      id: f.id,
      sort_order: f.sortOrder,
      service: f.service,
      description: f.description,
      frequency: f.frequency,
      amount_paise: f.amountPaise,
      billing_basis: f.billingBasis,
      notes: f.notes,
    })),
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }
}

async function assertParty(session: Session, scope: Scope, input: Pick<LetterInput, 'clientId' | 'leadId'>) {
  const hasClient = Boolean(input.clientId)
  const hasLead = Boolean(input.leadId)
  if (hasClient === hasLead) {
    throw ApiError.badRequest('An engagement letter belongs to exactly one party — choose a client or a lead, not both.')
  }
  if (hasClient) await assertCanSeeClient(session, scope, input.clientId!)
  else await assertCanSeeLead(session, scope, input.leadId!)
}

const fees = (items: FeeInput[]) =>
  items.map((f, i) => ({
    sortOrder: i,
    service: f.service.trim(),
    description: f.description ?? null,
    frequency: f.frequency ?? null,
    amountPaise: Math.max(0, Math.round(f.amountPaise)),
    billingBasis: f.billingBasis ?? null,
    notes: f.notes ?? null,
  }))

/** The columns a create or update writes — everything but code and status. */
function columns(input: LetterInput) {
  return {
    clientId: input.clientId ?? null,
    leadId: input.leadId ?? null,
    subject: input.subject.trim(),
    letterDate: input.letterDate,
    effectiveFrom: input.effectiveFrom ?? null,
    effectiveUntil: input.effectiveUntil ?? null,
    financialYear: input.financialYear ?? null,
    recipientSnapshot: (input.recipientSnapshot ?? undefined) as Prisma.InputJsonValue | undefined,
    templateId: input.templateId ?? 'jns-accounting',
    blockConfig: (input.blockConfig ?? undefined) as Prisma.InputJsonValue | undefined,
    layoutConfig: (input.layoutConfig ?? undefined) as Prisma.InputJsonValue | undefined,
    signatoryName: input.signatoryName ?? null,
    signatoryDesignation: input.signatoryDesignation ?? null,
    clientSignatoryName: input.clientSignatoryName ?? null,
    clientSignatoryDesignation: input.clientSignatoryDesignation ?? null,
  }
}

async function load(session: Session, scope: Scope, id: string): Promise<Row> {
  const where = await scopeWhere(session, scope)
  const row = await prisma.engagementLetter.findFirst({ where: { id, deletedAt: null, ...where }, include: INCLUDE })
  // Not-found and not-yours read the same, as everywhere in Workstation.
  if (!row) throw ApiError.notFound('Engagement letter not found.')
  return row
}

function assertEditable(row: Row) {
  if (row.status !== 'draft') {
    throw ApiError.badRequest('This letter has been sent and is frozen. Duplicate it to change the terms.')
  }
}

export const EngagementService = {
  async list(session: Session, scope: Scope, f: { status?: string; clientId?: string; q?: string; limit?: number; offset?: number }) {
    const where: Prisma.EngagementLetterWhereInput = {
      deletedAt: null,
      ...(await scopeWhere(session, scope)),
      ...(f.status && f.status !== 'all' ? { status: f.status } : {}),
      ...(f.clientId ? { clientId: f.clientId } : {}),
      ...(f.q ? {
        AND: [{ OR: [
          { letterCode: { contains: f.q, mode: 'insensitive' } },
          { subject: { contains: f.q, mode: 'insensitive' } },
          { client: { companyName: { contains: f.q, mode: 'insensitive' } } },
          { lead: { name: { contains: f.q, mode: 'insensitive' } } },
        ] }],
      } : {}),
    }
    const take = Math.min(Math.max(f.limit ?? 50, 1), 200)
    const [rows, total] = await Promise.all([
      prisma.engagementLetter.findMany({
        where, include: INCLUDE, orderBy: { createdAt: 'desc' }, take, skip: f.offset ?? 0,
      }),
      prisma.engagementLetter.count({ where }),
    ])
    return { items: rows.map(toApi), total }
  },

  async get(session: Session, scope: Scope, id: string) {
    return toApi(await load(session, scope, id))
  },

  async row(session: Session, scope: Scope, id: string): Promise<Row> {
    return load(session, scope, id)
  },

  async create(session: Session, scope: Scope, input: LetterInput) {
    await assertParty(session, scope, input)
    const year = Number(input.letterDate.slice(0, 4)) || new Date().getFullYear()
    const row = await prisma.$transaction(async (tx) => {
      const letterCode = await nextEngagementCode(tx, year)
      const organisationId =
        (await tx.organisation.findFirst({ select: { id: true } }))?.id ?? 'org-audit-os'
      return tx.engagementLetter.create({
        data: {
          ...columns(input),
          organisationId,
          letterCode,
          preparedById: session.employeeId ?? null,
          createdBy: session.userId,
          feeItems: { create: fees(input.feeItems) },
        },
        include: INCLUDE,
      })
    })
    return toApi(row)
  },

  async update(session: Session, scope: Scope, id: string, input: LetterInput) {
    assertEditable(await load(session, scope, id))
    await assertParty(session, scope, input)
    const row = await prisma.$transaction(async (tx) => {
      // Replace the fee lines wholesale: the editor owns their order, and
      // diffing a reorderable list buys nothing but bugs.
      await tx.engagementFeeItem.deleteMany({ where: { letterId: id } })
      return tx.engagementLetter.update({
        where: { id },
        data: { ...columns(input), updatedBy: session.userId, feeItems: { create: fees(input.feeItems) } },
        include: INCLUDE,
      })
    })
    return toApi(row)
  },

  async setStatus(session: Session, scope: Scope, id: string, to: 'draft' | 'sent' | 'accepted' | 'archived') {
    const row = await load(session, scope, id)
    const allowed: Record<string, string[]> = {
      // Reopening: a SENT letter may go back to draft to be corrected and
      // re-sent. An ACCEPTED one may not — the client has agreed to those
      // exact terms, so changing them means a new letter (Duplicate).
      draft: ['sent'],
      sent: ['draft'],
      accepted: ['sent'],
      archived: ['draft', 'sent', 'accepted'],
    }
    if (!allowed[to].includes(row.status)) {
      throw ApiError.badRequest(`A ${row.status} letter cannot be marked ${to}.`)
    }
    const now = new Date()
    const updated = await prisma.engagementLetter.update({
      where: { id },
      data: {
        status: to,
        updatedBy: session.userId,
        ...(to === 'sent' ? { sentAt: now } : {}),
        ...(to === 'draft' ? { sentAt: null } : {}),
        ...(to === 'accepted' ? { acceptedAt: now } : {}),
      },
      include: INCLUDE,
    })
    return toApi(updated)
  },

  /**
   * A new DRAFT from any letter — how a sent letter changes, and how last
   * year's terms become this year's. The original stays exactly as it went.
   */
  async duplicate(session: Session, scope: Scope, id: string) {
    const src = await load(session, scope, id)
    return this.create(session, scope, {
      clientId: src.clientId,
      leadId: src.leadId,
      subject: src.subject,
      letterDate: new Date().toISOString().slice(0, 10),
      effectiveFrom: src.effectiveFrom,
      effectiveUntil: src.effectiveUntil,
      financialYear: src.financialYear,
      recipientSnapshot: (src.recipientSnapshot as Record<string, unknown> | null) ?? null,
      templateId: src.templateId,
      blockConfig: (src.blockConfig as Record<string, unknown>[] | null) ?? null,
      layoutConfig: (src.layoutConfig as Record<string, unknown> | null) ?? null,
      signatoryName: src.signatoryName,
      signatoryDesignation: src.signatoryDesignation,
      clientSignatoryName: src.clientSignatoryName,
      clientSignatoryDesignation: src.clientSignatoryDesignation,
      feeItems: src.feeItems.map((f) => ({
        service: f.service, description: f.description, frequency: f.frequency,
        amountPaise: f.amountPaise, billingBasis: f.billingBasis, notes: f.notes,
      })),
    })
  },

  async remove(session: Session, scope: Scope, id: string) {
    await load(session, scope, id)
    await prisma.engagementLetter.update({
      where: { id }, data: { deletedAt: new Date(), updatedBy: session.userId },
    })
  },
}
