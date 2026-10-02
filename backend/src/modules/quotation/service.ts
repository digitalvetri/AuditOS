import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import type { Session } from '../../platform/auth.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { assignedClientIds, assertCanSeeClient, assertCanSeeLead } from '../../platform/workstation/scope.js'
import { nextQuotationCode } from '../../platform/workstation/codes.js'
import { employeeMap, type EmployeeLookup } from '../../api/workstation.serialize.js'
import { computeTotals, type LineInput } from './totals.js'

/**
 * QUOTATION SERVICE — Workstation → Quotation.
 *
 * The one writer of Quotation and QuotationItem rows. Three properties hold
 * here rather than in the UI, because a rule the UI is trusted to keep is not
 * a rule:
 *
 *  1. TOTALS ARE DERIVED. Every write recomputes them from the items via
 *     totals.ts. A request body carrying `total_paise` is ignored, not
 *     honoured — there is no code path that trusts a client-supplied figure.
 *  2. A SENT QUOTATION IS FROZEN. Once it leaves draft, its lines and money
 *     cannot change; you revise it, which creates a new draft that remembers
 *     what it came from. That is what makes "the quote we sent" a fact.
 *  3. THE STATUS FLOW IS A MACHINE, not a settable field (see TRANSITIONS).
 */

// ── Status ────────────────────────────────────────────────────────────────

export const QUOTATION_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired'] as const
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number]

/**
 * Who may follow whom. `expired` is DERIVED on read (validUntil in the past)
 * and never stored, so a quotation accepted on its last valid day is not
 * retroactively expired by a later read.
 */
const TRANSITIONS: Record<QuotationStatus, QuotationStatus[]> = {
  draft: ['sent'],
  sent: ['accepted', 'rejected'],
  accepted: [],
  rejected: [],
  expired: [],
}

/** The stored status, with expiry applied for display only. */
function effectiveStatus(row: { status: string; validUntil: string }, today: string): string {
  if (row.status === 'sent' && row.validUntil < today) return 'expired'
  return row.status
}

const todayISO = (now = new Date()): string => now.toISOString().slice(0, 10)

// ── Reads ─────────────────────────────────────────────────────────────────

const INCLUDE = {
  items: { orderBy: { sortOrder: 'asc' } },
  workSections: {
    orderBy: { sortOrder: 'asc' },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  },
  client: { select: { id: true, clientCode: true, companyName: true, gstin: true, address: true, email: true, contactNumber: true } },
  lead: { select: { id: true, leadCode: true, name: true, email: true, contactNumber: true } },
} satisfies Prisma.QuotationInclude

type Row = Prisma.QuotationGetPayload<{ include: typeof INCLUDE }>

/**
 * Rows the caller may see. At `self` scope that is: quotations I prepared,
 * plus quotations on a client I am assigned to, plus quotations on a lead I
 * own — the same union followUpScopeWhere uses, for the same reason.
 */
export async function quotationScopeWhere(session: Session, scope: Scope): Promise<Prisma.QuotationWhereInput> {
  if (scope === 'organisation' || scope === 'department') return {}
  const me = session.employeeId ?? '__none__'
  const ids = await assignedClientIds(session, scope)
  const clientIds = ids === 'ALL' ? [] : ids
  return {
    OR: [
      { preparedById: me },
      { clientId: { in: clientIds } },
      { lead: { assignedEmployeeId: me } },
    ],
  }
}

export interface QuotationFilters {
  status?: string
  clientId?: string
  leadId?: string
  dateFrom?: string
  dateTo?: string
  q?: string
  limit?: number
  offset?: number
}

// ── Serialisation (the API boundary: snake_case, _paise money) ────────────

function itemToApi(i: Row['items'][number]) {
  return {
    id: i.id,
    service_id: i.serviceId,
    description: i.description,
    /* Centi-units on the wire too, so the UI never has to guess a scale. */
    quantity_centi: i.quantityCenti,
    unit_rate_paise: i.unitRatePaise,
    discount_percent: i.discountPercent,
    gst_rate_percent: i.gstRatePercent,
    frequency: i.frequency,
    category: i.category,
    detail: i.detail,
    amount_paise: i.amountPaise,
    tax_paise: i.taxPaise,
    sort_order: i.sortOrder,
  }
}

export function quotationToApi(q: Row, m: EmployeeLookup, now = new Date()) {
  const today = todayISO(now)
  return {
    id: q.id,
    organisation_id: q.organisationId,
    quotation_code: q.quotationCode,

    lead_id: q.leadId,
    client_id: q.clientId,
    /* One field the UI can print regardless of which side it came from. */
    party_name: q.client?.companyName ?? q.lead?.name ?? null,
    party_kind: q.clientId ? 'client' : q.leadId ? 'lead' : null,
    party_email: q.client?.email ?? q.lead?.email ?? null,
    party_contact_number: q.client?.contactNumber ?? q.lead?.contactNumber ?? null,
    party_gstin: q.client?.gstin ?? null,
    party_address: q.client?.address ?? null,

    subject: q.subject,
    quote_date: q.quoteDate,
    valid_until: q.validUntil,
    /* The stored value AND the display value. A UI that only reads `status`
       still behaves correctly; `stored_status` is for the audit trail. */
    status: effectiveStatus(q, today),
    stored_status: q.status,
    is_expired: effectiveStatus(q, today) === 'expired',
    /* Whether this row may still be edited — computed here so three screens
       do not each re-derive it. */
    is_editable: q.status === 'draft',

    place_of_supply: q.placeOfSupply,
    is_inter_state: q.isInterState,

    subtotal_paise: q.subtotalPaise,
    discount_paise: q.discountPaise,
    taxable_paise: q.taxablePaise,
    cgst_paise: q.cgstPaise,
    sgst_paise: q.sgstPaise,
    igst_paise: q.igstPaise,
    total_paise: q.totalPaise,

    notes: q.notes,
    terms: q.terms,

    prepared_by_id: q.preparedById,
    prepared_by: q.preparedById ? m.get(q.preparedById) ?? null : null,

    sent_at: q.sentAt?.toISOString() ?? null,
    accepted_at: q.acceptedAt?.toISOString() ?? null,
    rejected_at: q.rejectedAt?.toISOString() ?? null,
    rejection_reason: q.rejectionReason,
    converted_task_id: q.convertedTaskId,
    converted_at: q.convertedAt?.toISOString() ?? null,

    // ── Document composition ──────────────────────────────────────────
    template_id: q.templateId,
    introduction: q.introduction,
    closing_text: q.closingText,
    prepared_by_name: q.preparedByName,
    prepared_by_designation: q.preparedByDesignation,
    layout_config: q.layoutConfig ?? null,
    block_config: q.blockConfig ?? null,
    client_snapshot: q.clientSnapshot ?? null,

    items: q.items.map(itemToApi),
    work_sections: q.workSections.map((w) => ({
      id: w.id,
      sort_order: w.sortOrder,
      title: w.title,
      description: w.description,
      items: w.items.map((it) => ({ id: it.id, sort_order: it.sortOrder, content: it.content })),
    })),

    created_at: q.createdAt.toISOString(),
    updated_at: q.updatedAt.toISOString(),
    created_by: q.createdBy,
    updated_by: q.updatedBy,
  }
}

async function serialise(rows: Row[], now = new Date()) {
  const m = await employeeMap(rows.map((r) => r.preparedById))
  return rows.map((r) => quotationToApi(r, m, now))
}

// ── Writes ────────────────────────────────────────────────────────────────

export interface ItemInput {
  serviceId?: string | null
  description: string
  quantityCenti: number
  unitRatePaise: number
  discountPercent: number
  gstRatePercent: number
  frequency?: string | null
  category?: string | null
  detail?: string | null
}

/** One Nature-of-Work section, with its bullets, as the builder sends it. */
export interface WorkSectionInput {
  title: string
  description?: string | null
  items: string[]
}

export interface QuotationInput {
  leadId?: string | null
  clientId?: string | null
  subject: string
  quoteDate: string
  validUntil: string
  placeOfSupply?: string | null
  isInterState?: boolean
  discountPaise?: number
  notes?: string | null
  terms?: string | null
  items: ItemInput[]

  // ── Document composition. All optional: a caller that knows nothing about
  // templates (the old builder, a script) still writes a valid quotation. ──
  templateId?: string | null
  introduction?: string | null
  closingText?: string | null
  preparedByName?: string | null
  preparedByDesignation?: string | null
  layoutConfig?: unknown
  blockConfig?: unknown
  clientSnapshot?: unknown
  workSections?: WorkSectionInput[]
}

/**
 * The document fields, shaped for Prisma. `undefined` means "leave alone",
 * which is what lets the same helper serve create and update.
 *
 * The Json columns are handled by OMITTING them when there is no value:
 * Prisma rejects a bare `null` for a Json field (it wants Prisma.JsonNull to
 * mean "the JSON value null" and DbNull to mean "the column is NULL"), and
 * passing one fails the whole write. Clearing a config is done by sending an
 * empty object, not null.
 */
function documentData(input: QuotationInput) {
  const json: Record<string, Prisma.InputJsonValue> = {}
  if (input.layoutConfig != null) json.layoutConfig = input.layoutConfig as Prisma.InputJsonValue
  if (input.blockConfig != null) json.blockConfig = input.blockConfig as Prisma.InputJsonValue
  if (input.clientSnapshot != null) json.clientSnapshot = input.clientSnapshot as Prisma.InputJsonValue
  return {
    templateId: input.templateId ?? undefined,
    introduction: input.introduction ?? null,
    closingText: input.closingText ?? null,
    preparedByName: input.preparedByName ?? null,
    preparedByDesignation: input.preparedByDesignation ?? null,
    ...json,
  }
}

/** Nested create for the work sections and their bullets. */
function workSectionCreate(input: QuotationInput) {
  return (input.workSections ?? []).map((w, i) => ({
    sortOrder: i,
    title: w.title,
    description: w.description ?? null,
    items: { create: w.items.map((content, n) => ({ sortOrder: n, content })) },
  }))
}

/** Exactly one party, and the caller must be allowed to see it. */
async function assertParty(session: Session, scope: Scope, input: { leadId?: string | null; clientId?: string | null }) {
  const hasLead = !!input.leadId
  const hasClient = !!input.clientId
  if (hasLead === hasClient) {
    throw ApiError.badRequest('A quotation belongs to exactly one party — choose a client or a lead, not both.')
  }
  if (hasClient) await assertCanSeeClient(session, scope, input.clientId!)
  else await assertCanSeeLead(session, scope, input.leadId!)
}

function toLineInputs(items: ItemInput[]): LineInput[] {
  return items.map((i) => ({
    quantityCenti: i.quantityCenti,
    unitRatePaise: i.unitRatePaise,
    discountPercent: i.discountPercent,
    gstRatePercent: i.gstRatePercent,
  }))
}

function assertDates(quoteDate: string, validUntil: string) {
  if (validUntil < quoteDate) {
    throw ApiError.badRequest('The validity date cannot fall before the quotation date.')
  }
}

async function loadOrThrow(id: string, where: Prisma.QuotationWhereInput): Promise<Row> {
  const row = await prisma.quotation.findFirst({ where: { id, deletedAt: null, ...where }, include: INCLUDE })
  // Not-found and not-yours are answered identically, as everywhere in
  // Workstation — the caller learns nothing from the difference.
  if (!row) throw ApiError.notFound('Quotation not found.')
  return row
}

/**
 * The two templates that exist. Seeded on first read so a database that
 * pre-dates the builder answers correctly; a user-added template is never
 * overwritten because the seed only runs when the table is empty.
 */
const SEED_TEMPLATES = [
  {
    slug: 'jns-compliance',
    name: 'Compliance Quotation',
    description:
      'Professional-fee proposal: client particulars, a fee table by frequency, and Nature of Work sections. No tax table.',
    sortOrder: 0,
    configuration: {
      pricing: 'professional-fees',
      blocks: [
        'company_header', 'quotation_title', 'quotation_meta', 'client_information',
        'subject', 'introduction', 'fee_table', 'nature_of_work', 'terms',
        'payment_details', 'notes', 'closing',
      ],
    },
  },
  {
    slug: 'gst-line-item',
    name: 'GST Line-item Quotation',
    description:
      'Priced lines with quantity, rate and GST, totalled into CGST/SGST or IGST. The original Audit OS quotation.',
    sortOrder: 1,
    configuration: { pricing: 'gst-line-item' },
  },
]

export const QuotationService = {
  async templates() {
    const org = (await prisma.organisation.findFirst({ select: { id: true } }))?.id ?? 'org-audit-os'
    if ((await prisma.quotationTemplate.count({ where: { organisationId: org } })) === 0) {
      for (const t of SEED_TEMPLATES) {
        await prisma.quotationTemplate.upsert({
          where: { organisationId_slug: { organisationId: org, slug: t.slug } },
          update: {},
          create: { organisationId: org, ...t },
        })
      }
    }
    const rows = await prisma.quotationTemplate.findMany({
      where: { organisationId: org, deletedAt: null, active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
    return {
      items: rows.map((t) => ({
        id: t.slug,
        name: t.name,
        description: t.description,
        configuration: t.configuration ?? null,
      })),
    }
  },

  async list(session: Session, scope: Scope, f: QuotationFilters) {
    const where: Prisma.QuotationWhereInput = {
      deletedAt: null,
      ...(await quotationScopeWhere(session, scope)),
    }
    const and: Prisma.QuotationWhereInput[] = []

    // `expired` is not a stored value, so it is asked for as "sent, and past
    // its date" — and asking for `sent` correctly excludes those.
    const today = todayISO()
    if (f.status === 'expired') and.push({ status: 'sent', validUntil: { lt: today } })
    else if (f.status === 'sent') and.push({ status: 'sent', validUntil: { gte: today } })
    else if (f.status) and.push({ status: f.status })

    if (f.clientId) and.push({ clientId: f.clientId })
    if (f.leadId) and.push({ leadId: f.leadId })
    if (f.dateFrom) and.push({ quoteDate: { gte: f.dateFrom } })
    if (f.dateTo) and.push({ quoteDate: { lte: f.dateTo } })
    if (f.q) {
      and.push({
        OR: [
          { quotationCode: { contains: f.q, mode: 'insensitive' } },
          { subject: { contains: f.q, mode: 'insensitive' } },
          { client: { companyName: { contains: f.q, mode: 'insensitive' } } },
          { lead: { name: { contains: f.q, mode: 'insensitive' } } },
        ],
      })
    }
    if (and.length) where.AND = and

    const [rows, total] = await Promise.all([
      prisma.quotation.findMany({
        where,
        include: INCLUDE,
        orderBy: [{ quoteDate: 'desc' }, { createdAt: 'desc' }],
        take: Math.min(f.limit ?? 50, 200),
        skip: f.offset ?? 0,
      }),
      prisma.quotation.count({ where }),
    ])
    return { items: await serialise(rows), total }
  },

  /** Counts for the list header, computed over the caller's scope only. */
  async summary(session: Session, scope: Scope) {
    const where: Prisma.QuotationWhereInput = {
      deletedAt: null,
      ...(await quotationScopeWhere(session, scope)),
    }
    const today = todayISO()
    const [draft, sent, expired, accepted, rejected, acceptedValue] = await Promise.all([
      prisma.quotation.count({ where: { ...where, status: 'draft' } }),
      prisma.quotation.count({ where: { ...where, status: 'sent', validUntil: { gte: today } } }),
      prisma.quotation.count({ where: { ...where, status: 'sent', validUntil: { lt: today } } }),
      prisma.quotation.count({ where: { ...where, status: 'accepted' } }),
      prisma.quotation.count({ where: { ...where, status: 'rejected' } }),
      prisma.quotation.aggregate({ where: { ...where, status: 'accepted' }, _sum: { totalPaise: true } }),
    ])
    return {
      draft, sent, expired, accepted, rejected,
      accepted_value_paise: acceptedValue._sum.totalPaise ?? 0,
    }
  },

  async get(session: Session, scope: Scope, id: string) {
    const row = await loadOrThrow(id, await quotationScopeWhere(session, scope))
    const m = await employeeMap([row.preparedById])
    return quotationToApi(row, m)
  },

  async create(session: Session, scope: Scope, input: QuotationInput) {
    await assertParty(session, scope, input)
    assertDates(input.quoteDate, input.validUntil)
    if (input.items.length === 0) throw ApiError.badRequest('A quotation needs at least one line.')

    const totals = computeTotals(toLineInputs(input.items), {
      discountPaise: input.discountPaise,
      isInterState: input.isInterState,
    })

    const created = await prisma.$transaction(async (tx) => {
      const year = Number(input.quoteDate.slice(0, 4))
      const code = await nextQuotationCode(tx, year)
      const organisationId =
        (await tx.organisation.findFirst({ select: { id: true } }))?.id ?? 'org-audit-os'

      return tx.quotation.create({
        data: {
          organisationId,
          quotationCode: code,
          leadId: input.leadId ?? null,
          clientId: input.clientId ?? null,
          subject: input.subject,
          quoteDate: input.quoteDate,
          validUntil: input.validUntil,
          status: 'draft',
          placeOfSupply: input.placeOfSupply ?? null,
          isInterState: input.isInterState ?? false,
          subtotalPaise: totals.subtotalPaise,
          discountPaise: totals.discountPaise,
          taxablePaise: totals.taxablePaise,
          cgstPaise: totals.cgstPaise,
          sgstPaise: totals.sgstPaise,
          igstPaise: totals.igstPaise,
          totalPaise: totals.totalPaise,
          notes: input.notes ?? null,
          terms: input.terms ?? null,
          ...documentData(input),
          workSections: { create: workSectionCreate(input) },
          preparedById: session.employeeId ?? null,
          createdBy: session.userId,
          updatedBy: session.userId,
          items: {
            create: input.items.map((i, idx) => ({
              serviceId: i.serviceId ?? null,
              description: i.description,
              quantityCenti: i.quantityCenti,
              unitRatePaise: i.unitRatePaise,
              discountPercent: i.discountPercent,
              gstRatePercent: i.gstRatePercent,
              frequency: i.frequency ?? null,
              category: i.category ?? null,
              detail: i.detail ?? null,
              amountPaise: totals.lines[idx].amountPaise,
              taxPaise: totals.lines[idx].taxPaise,
              sortOrder: idx,
            })),
          },
        },
        include: INCLUDE,
      })
    })

    const m = await employeeMap([created.preparedById])
    return quotationToApi(created, m)
  },

  /**
   * Replace a DRAFT's contents. Items are replaced wholesale rather than
   * diffed: a quotation is a document, and half-applying an edit to one is
   * worse than rewriting it.
   */
  async update(session: Session, scope: Scope, id: string, input: QuotationInput) {
    const existing = await loadOrThrow(id, await quotationScopeWhere(session, scope))
    if (existing.status !== 'draft') {
      throw ApiError.badRequest(`A ${existing.status} quotation cannot be edited. Revise it instead.`)
    }
    await assertParty(session, scope, input)
    assertDates(input.quoteDate, input.validUntil)
    if (input.items.length === 0) throw ApiError.badRequest('A quotation needs at least one line.')

    const totals = computeTotals(toLineInputs(input.items), {
      discountPaise: input.discountPaise,
      isInterState: input.isInterState,
    })

    const updated = await prisma.$transaction(async (tx) => {
      await tx.quotationItem.deleteMany({ where: { quotationId: id } })
      // Sections are replaced wholesale like the lines, for the same reason:
      // a document half-edited is worse than one rewritten. The bullets go
      // with them by cascade.
      await tx.quotationWorkSection.deleteMany({ where: { quotationId: id } })
      return tx.quotation.update({
        where: { id },
        data: {
          leadId: input.leadId ?? null,
          clientId: input.clientId ?? null,
          subject: input.subject,
          quoteDate: input.quoteDate,
          validUntil: input.validUntil,
          placeOfSupply: input.placeOfSupply ?? null,
          isInterState: input.isInterState ?? false,
          subtotalPaise: totals.subtotalPaise,
          discountPaise: totals.discountPaise,
          taxablePaise: totals.taxablePaise,
          cgstPaise: totals.cgstPaise,
          sgstPaise: totals.sgstPaise,
          igstPaise: totals.igstPaise,
          totalPaise: totals.totalPaise,
          notes: input.notes ?? null,
          terms: input.terms ?? null,
          ...documentData(input),
          workSections: { create: workSectionCreate(input) },
          updatedBy: session.userId,
          items: {
            create: input.items.map((i, idx) => ({
              serviceId: i.serviceId ?? null,
              description: i.description,
              quantityCenti: i.quantityCenti,
              unitRatePaise: i.unitRatePaise,
              discountPercent: i.discountPercent,
              gstRatePercent: i.gstRatePercent,
              frequency: i.frequency ?? null,
              category: i.category ?? null,
              detail: i.detail ?? null,
              amountPaise: totals.lines[idx].amountPaise,
              taxPaise: totals.lines[idx].taxPaise,
              sortOrder: idx,
            })),
          },
        },
        include: INCLUDE,
      })
    })

    const m = await employeeMap([updated.preparedById])
    return quotationToApi(updated, m)
  },

  /**
   * Move along the status machine. The timestamps come from the server clock,
   * never from a request body — the same rule the Task engine follows.
   */
  async transition(
    session: Session,
    scope: Scope,
    id: string,
    to: QuotationStatus,
    opts: { reason?: string | null } = {},
  ) {
    const existing = await loadOrThrow(id, await quotationScopeWhere(session, scope))
    const from = existing.status as QuotationStatus
    if (!TRANSITIONS[from]?.includes(to)) {
      throw ApiError.badRequest(`A ${from} quotation cannot become ${to}.`)
    }
    if (to === 'sent' && existing.items.length === 0) {
      throw ApiError.badRequest('An empty quotation cannot be sent.')
    }
    if (to === 'rejected' && !opts.reason?.trim()) {
      throw ApiError.badRequest('Record why the quotation was rejected.')
    }

    const now = new Date()
    const updated = await prisma.quotation.update({
      where: { id },
      data: {
        status: to,
        sentAt: to === 'sent' ? now : existing.sentAt,
        acceptedAt: to === 'accepted' ? now : existing.acceptedAt,
        rejectedAt: to === 'rejected' ? now : existing.rejectedAt,
        rejectionReason: to === 'rejected' ? opts.reason!.trim() : existing.rejectionReason,
        updatedBy: session.userId,
      },
      include: INCLUDE,
    })
    const m = await employeeMap([updated.preparedById])
    return quotationToApi(updated, m)
  },

  /**
   * Copy a quotation into a fresh draft. This is how a sent quotation is
   * "edited": the original stays exactly as it went out.
   */
  async revise(session: Session, scope: Scope, id: string) {
    const src = await loadOrThrow(id, await quotationScopeWhere(session, scope))
    return this.create(session, scope, {
      leadId: src.leadId,
      clientId: src.clientId,
      subject: src.subject,
      quoteDate: todayISO(),
      validUntil: src.validUntil,
      placeOfSupply: src.placeOfSupply,
      isInterState: src.isInterState,
      discountPaise: src.discountPaise,
      notes: src.notes,
      terms: src.terms,
      items: src.items.map((i) => ({
        serviceId: i.serviceId,
        description: i.description,
        quantityCenti: i.quantityCenti,
        unitRatePaise: i.unitRatePaise,
        discountPercent: i.discountPercent,
        gstRatePercent: i.gstRatePercent,
        frequency: i.frequency,
        category: i.category,
        detail: i.detail,
      })),
      // A revision is the same DOCUMENT with a new date — template, prose,
      // layout, blocks and work sections all come across, or the revised copy
      // would silently fall back to the default template.
      templateId: src.templateId,
      introduction: src.introduction,
      closingText: src.closingText,
      preparedByName: src.preparedByName,
      preparedByDesignation: src.preparedByDesignation,
      layoutConfig: src.layoutConfig ?? undefined,
      blockConfig: src.blockConfig ?? undefined,
      clientSnapshot: src.clientSnapshot ?? undefined,
      workSections: src.workSections.map((w) => ({
        title: w.title,
        description: w.description,
        items: w.items.map((it) => it.content),
      })),
    })
  },

  /**
   * Turn an ACCEPTED quotation into work. `convertedTaskId` is @unique, so a
   * second conversion fails at the database rather than in a handler — the
   * same guarantee Lead → Client relies on.
   */
  async convertToTask(session: Session, scope: Scope, id: string, assignedEmployeeId: string, dueDate?: string) {
    const q = await loadOrThrow(id, await quotationScopeWhere(session, scope))
    if (q.status !== 'accepted') throw ApiError.badRequest('Only an accepted quotation becomes work.')
    if (q.convertedTaskId) throw ApiError.badRequest('This quotation has already been converted.')
    if (!q.clientId) throw ApiError.badRequest('Convert the lead to a client first — a task belongs to a client.')

    const employee = await prisma.employee.findFirst({ where: { id: assignedEmployeeId, deletedAt: null }, select: { id: true } })
    if (!employee) throw ApiError.badRequest('Assign the work to an employee who exists.')

    const task = await prisma.$transaction(async (tx) => {
      const t = await tx.task.create({
        data: {
          clientId: q.clientId,
          title: q.subject,
          description: `Raised from quotation ${q.quotationCode}.`,
          assignedEmployeeId,
          assignedById: session.employeeId ?? null,
          dueDate: dueDate ?? null,
          status: 'pending',
          createdBy: session.userId,
          updatedBy: session.userId,
        },
        select: { id: true },
      })
      await tx.quotation.update({
        where: { id },
        data: { convertedTaskId: t.id, convertedAt: new Date(), updatedBy: session.userId },
      })
      return t
    })

    return { task_id: task.id, quotation: await this.get(session, scope, id) }
  },

  /** Soft delete, drafts only — a sent quotation is a record of what was said. */
  async remove(session: Session, scope: Scope, id: string) {
    const existing = await loadOrThrow(id, await quotationScopeWhere(session, scope))
    if (existing.status !== 'draft') {
      throw ApiError.badRequest('Only a draft can be deleted. A sent quotation is part of the record.')
    }
    await prisma.quotation.update({
      where: { id },
      data: { deletedAt: new Date(), updatedBy: session.userId },
    })
  },
}
