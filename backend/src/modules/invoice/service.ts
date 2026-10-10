import { Prisma } from '@prisma/client'  // value import: Prisma.DbNull clears a Json column
import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import type { Session } from '../../platform/auth.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { assignedClientIds, assertCanSeeClient } from '../../platform/workstation/scope.js'
import { nextInvoiceNumber } from '../../platform/workstation/codes.js'
import { employeeMap } from '../../api/workstation.serialize.js'
import { computeTotals, invoiceAmountInWords, paymentState, type LineInput } from './totals.js'
import { addPayment, removePayment, type PaymentInput } from './payments.js'
import { addRefund, refundToApi, removeRefund, type RefundInput } from './refunds.js'
import { resolveInterState } from './supply.js'
import { istToday } from '../../lib/dates.js'

/**
 * INVOICE SERVICE — Workstation → Invoice.
 *
 * The one writer of Invoice and InvoiceItem rows. The same three properties
 * the quotation service holds, held here for the same reason — a rule the UI
 * is trusted to keep is not a rule:
 *
 *  1. TOTALS ARE DERIVED. Every write recomputes them from the items via
 *     totals.ts. A request body carrying `total_paise` is ignored, not
 *     honoured. This is also what makes the builder's live preview safe: it
 *     may compute figures to SHOW, but what gets STORED is computed here.
 *  2. A SENT INVOICE IS FROZEN (§40). Once it leaves draft its lines, money
 *     and party snapshot cannot change. Payments and cancellation are the
 *     only writes a sent invoice accepts, because a tax invoice that can be
 *     quietly edited after issue is not a tax invoice.
 *  3. THE PARTY IS SNAPSHOTTED (§39). Name, addresses, GSTIN, company block
 *     and bank details are copied onto the row, and the document reads the
 *     snapshot — so editing a client master never rewrites an invoice that
 *     has already gone out.
 */

// ── Status ────────────────────────────────────────────────────────────────

export const INVOICE_STATUSES = [
  'draft', 'sent', 'partially_paid', 'paid', 'overdue', 'cancelled',
] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

/**
 * Stored transitions. `partially_paid` / `paid` are reached by RECORDING A
 * PAYMENT rather than by setting a field, and `overdue` is derived on read
 * from the due date — never stored, so an invoice paid on its due date is not
 * retroactively marked late by a later read.
 */
const TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ['sent', 'cancelled'],
  sent: ['partially_paid', 'paid', 'cancelled'],
  partially_paid: ['paid', 'cancelled'],
  paid: [],
  overdue: ['partially_paid', 'paid', 'cancelled'],
  cancelled: [],
}

/** How a number reads in a message: a draft has none until it is sent. */
export function invoiceLabel(invoiceNumber: string | null | undefined): string {
  return invoiceNumber ?? 'Draft'
}

/** Editable only while nothing has been issued (§40). */
function assertEditable(inv: { status: string; invoiceNumber: string | null }) {
  if (inv.status !== 'draft') {
    throw ApiError.conflict(
      'invoice_not_editable',
      `Invoice ${invoiceLabel(inv.invoiceNumber)} has been issued and cannot be edited. ` +
      'Record a payment or cancel it instead.',
    )
  }
}

// ── Terms → due date ──────────────────────────────────────────────────────

/** What the payment QR encodes. `none` omits it entirely. */
export const QR_MODES = ['upi_amount', 'upi_only', 'custom', 'image', 'none'] as const
export type QrMode = (typeof QR_MODES)[number]

export const TERMS = ['due_on_receipt', 'net_7', 'net_15', 'net_30', 'net_45', 'custom'] as const
export type Term = (typeof TERMS)[number]

const TERM_DAYS: Record<Exclude<Term, 'custom'>, number> = {
  due_on_receipt: 0, net_7: 7, net_15: 15, net_30: 30, net_45: 45,
}

/**
 * The due date a term implies. 'custom' means the caller supplies it, which
 * is also the manual override §24 asks for. Date-only arithmetic in UTC so a
 * timezone can never shift an invoice a day either way.
 */
export function dueDateFor(invoiceDate: string, term: Term, explicit?: string | null): string {
  if (term === 'custom') return explicit || invoiceDate
  const d = new Date(`${invoiceDate}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return invoiceDate
  d.setUTCDate(d.getUTCDate() + TERM_DAYS[term])
  return d.toISOString().slice(0, 10)
}

// ── Input ─────────────────────────────────────────────────────────────────

export interface ItemInput {
  serviceId?: string | null
  itemName: string
  description?: string | null
  hsnSac?: string | null
  quantityCenti: number
  unit?: string | null
  ratePaise: number
  discountPercent: number
  gstRatePercent: number
}

export interface InvoiceInput {
  clientId: string
  invoiceDate: string
  terms: Term
  dueDate?: string | null
  placeOfSupply?: string | null
  isInterState?: boolean
  discountPaise?: number
  notes?: string | null
  billingName?: string | null
  billingAddress?: string | null
  shipSameAsBill?: boolean
  shippingName?: string | null
  shippingAddress?: string | null
  customerGstin?: string | null
  bankAccountId?: string | null
  templateId?: string | null
  layoutConfig?: Prisma.InputJsonValue | null
  blockConfig?: Prisma.InputJsonValue | null
  signatoryName?: string | null
  signatoryDesignation?: string | null
  footerNote?: string | null
  qrMode?: QrMode | null
  qrValue?: string | null
  qrImage?: string | null
  /** What the invoice bills, for fee-vs-time profitability. Optional. */
  clientServiceId?: string | null
  auditEngagementId?: string | null
  items: ItemInput[]
}

// ── Serialisation ─────────────────────────────────────────────────────────

const ITEM_SELECT = { orderBy: { sortOrder: 'asc' } } as const
const REFUND_SELECT = { where: { deletedAt: null }, orderBy: [{ refundedOn: 'asc' as const }, { createdAt: 'asc' as const }] }

type Row = Prisma.InvoiceGetPayload<{
  include: { items: true; client: true; bankAccount: true; refunds: true }
}>

/**
 * `overdue` is computed here rather than stored: it is a function of the
 * clock, and a stored copy would be wrong the moment the day turned. Nothing
 * that has been paid or cancelled can be overdue.
 */
function effectiveStatus(inv: { status: string; dueDate: string; balanceDuePaise: number }, today: string): InvoiceStatus {
  const s = inv.status as InvoiceStatus
  if (s === 'paid' || s === 'cancelled' || s === 'draft') return s
  if (inv.balanceDuePaise > 0 && inv.dueDate < today) return 'overdue'
  return s
}

/** Cash + TDS + issued credits − refunds, from the stored (recomputed) columns. */
function settledOf(inv: { amountPaidPaise: number; tdsDeductedPaise: number; creditedPaise: number; refundedPaise: number }) {
  return inv.amountPaidPaise + inv.tdsDeductedPaise + inv.creditedPaise - inv.refundedPaise
}

function refundDueOf(inv: { totalPaise: number; amountPaidPaise: number; tdsDeductedPaise: number; creditedPaise: number; refundedPaise: number; status: string }) {
  if (inv.status === 'draft' || inv.status === 'cancelled') return 0
  return Math.max(0, settledOf(inv) - inv.totalPaise)
}

function serialize(inv: Row, emp: Map<string, { id: string; full_name: string; employee_code: string }>) {
  // The firm's calendar day, not UTC's: before 05:30 IST the UTC date is
  // still yesterday, and an invoice due today would not yet read as late.
  const status = effectiveStatus(inv, istToday())
  return {
    id: inv.id,
    /** Null while a draft — the number is taken when it is sent. */
    invoice_number: inv.invoiceNumber,
    /** What to print where the number goes: the number, or 'Draft'. */
    display_number: invoiceLabel(inv.invoiceNumber),
    client_id: inv.clientId,
    client_name: inv.client?.companyName ?? null,
    // For sharing the invoice with the client (WhatsApp / email).
    party_email: inv.client?.email ?? null,
    party_contact_number: inv.client?.contactNumber ?? null,
    invoice_date: inv.invoiceDate,
    terms: inv.terms,
    due_date: inv.dueDate,
    place_of_supply: inv.placeOfSupply,
    is_inter_state: inv.isInterState,
    /** What the UI shows. `stored_status` is what the row holds. */
    status,
    stored_status: inv.status,
    is_overdue: status === 'overdue',
    /** Draft only — mirrors assertEditable so the UI need not re-derive it. */
    is_editable: inv.status === 'draft',
    billing_name: inv.billingName,
    billing_address: inv.billingAddress,
    ship_same_as_bill: inv.shipSameAsBill,
    shipping_name: inv.shippingName,
    shipping_address: inv.shippingAddress,
    customer_gstin: inv.customerGstin,
    subtotal_paise: inv.subtotalPaise,
    discount_paise: inv.discountPaise,
    taxable_paise: inv.taxablePaise,
    cgst_paise: inv.cgstPaise,
    sgst_paise: inv.sgstPaise,
    igst_paise: inv.igstPaise,
    round_off_paise: inv.roundOffPaise,
    total_paise: inv.totalPaise,
    /** Cash received. TDS and credit notes are separate — all three settle it; refunds reverse it. */
    amount_paid_paise: inv.amountPaidPaise,
    tds_deducted_paise: inv.tdsDeductedPaise,
    credited_paise: inv.creditedPaise,
    /** Money paid back to the client (sum of live refunds). */
    refunded_paise: inv.refundedPaise,
    balance_due_paise: inv.balanceDuePaise,
    /** Settled beyond the total (e.g. a credit note after payment) and not yet refunded. */
    refund_due_paise: refundDueOf(inv),
    payment_state: paymentState(inv.totalPaise, settledOf(inv)),
    refunds: inv.refunds.map(refundToApi),
    recurring_profile_id: inv.recurringProfileId,
    client_service_id: inv.clientServiceId,
    audit_engagement_id: inv.auditEngagementId,
    /** Generated server-side so the document and the PDF cannot disagree. */
    total_in_words: invoiceAmountInWords(inv.totalPaise),
    notes: inv.notes,
    template_id: inv.templateId,
    layout_config: inv.layoutConfig,
    block_config: inv.blockConfig,
    bank_account_id: inv.bankAccountId,
    bank_snapshot: inv.bankSnapshot,
    signatory_name: inv.signatoryName,
    signatory_designation: inv.signatoryDesignation,
    footer_note: inv.footerNote,
    qr_mode: inv.qrMode,
    qr_value: inv.qrValue,
    qr_image: inv.qrImage,
    prepared_by_id: inv.preparedById,
    prepared_by: inv.preparedById ? emp.get(inv.preparedById) ?? null : null,
    sent_at: inv.sentAt?.toISOString() ?? null,
    paid_at: inv.paidAt?.toISOString() ?? null,
    cancelled_at: inv.cancelledAt?.toISOString() ?? null,
    created_at: inv.createdAt.toISOString(),
    updated_at: inv.updatedAt.toISOString(),
    items: inv.items.map((i) => ({
      id: i.id,
      service_id: i.serviceId,
      sort_order: i.sortOrder,
      item_name: i.itemName,
      description: i.description,
      hsn_sac: i.hsnSac,
      quantity_centi: i.quantityCenti,
      unit: i.unit,
      rate_paise: i.ratePaise,
      discount_percent: i.discountPercent,
      /** The slab. The editor works in slabs, so this is what it reads back. */
      gst_rate_percent: i.gstRatePercent,
      /* The printed rates, derived. Half of a 5% slab is 2.5% and says so,
         rather than being rounded into a rate nobody is charged. */
      cgst_rate_percent: inv.isInterState ? 0 : i.gstRatePercent / 2,
      sgst_rate_percent: inv.isInterState ? 0 : i.gstRatePercent / 2,
      igst_rate_percent: inv.isInterState ? i.gstRatePercent : 0,
      taxable_amount_paise: i.taxableAmountPaise,
      cgst_amount_paise: i.cgstAmountPaise,
      sgst_amount_paise: i.sgstAmountPaise,
      igst_amount_paise: i.igstAmountPaise,
      total_amount_paise: i.totalAmountPaise,
    })),
  }
}

export type SerializedInvoice = ReturnType<typeof serialize>

// ── Scope ─────────────────────────────────────────────────────────────────

/**
 * An invoice is visible exactly when its client is. Reusing the client scope
 * rather than inventing an invoice one means a staff member cannot reach a
 * client's money through a module that forgot to ask.
 */
/**
 * An invoice may be linked to an engagement (client service) and/or an audit
 * file only of its own client; profitability reports trust these links.
 */
async function assertInvoiceLinks(clientId: string, clientServiceId?: string | null, auditEngagementId?: string | null) {
  if (clientServiceId) {
    const cs = await prisma.clientService.findFirst({ where: { id: clientServiceId, deletedAt: null }, select: { clientId: true } })
    if (!cs || cs.clientId !== clientId) {
      throw ApiError.badRequest('That engagement is not one of this client\'s services.', { client_service_id: 'Not for this client.' })
    }
  }
  if (auditEngagementId) {
    const a = await prisma.auditEngagement.findFirst({ where: { id: auditEngagementId, deletedAt: null }, select: { clientId: true } })
    if (!a || a.clientId !== clientId) {
      throw ApiError.badRequest('That audit file is not for this client.', { audit_engagement_id: 'Not for this client.' })
    }
  }
}

async function visibleWhere(session: Session, scope: Scope): Promise<Prisma.InvoiceWhereInput> {
  const base: Prisma.InvoiceWhereInput = { deletedAt: null }
  if (scope === 'organisation' || scope === 'department') return base
  const me = session.employeeId ?? '__none__'
  const ids = await assignedClientIds(session, scope)
  const clientIds = ids === 'ALL' ? [] : ids
  // Mirrors quotationScopeWhere: yours if you raised it, or if the client is
  // one you are assigned. Reusing the client scope rather than inventing an
  // invoice one means nobody reaches a client's money through a module that
  // forgot to ask.
  return { ...base, OR: [{ preparedById: me }, { clientId: { in: clientIds } }] }
}

/**
 * The firm's organisation id. Single-tenant in practice, resolved the same
 * way QuotationService.templates() resolves it rather than being threaded
 * through every call — Session does not carry it.
 */
async function orgId(): Promise<string> {
  return (await prisma.organisation.findFirst({ select: { id: true } }))?.id ?? 'org-audit-os'
}

function toLineInputs(items: ItemInput[]): LineInput[] {
  return items.map((i) => ({
    quantityCenti: i.quantityCenti,
    ratePaise: i.ratePaise,
    discountPercent: i.discountPercent,
    gstRatePercent: i.gstRatePercent,
  }))
}

// ── Service ───────────────────────────────────────────────────────────────

export const InvoiceService = {
  async list(
    session: Session,
    scope: Scope,
    f: {
      status?: string
      clientId?: string
      dateFrom?: string
      dateTo?: string
      q?: string
      limit?: number
      offset?: number
    } = {},
  ) {
    const where = await visibleWhere(session, scope)
    const and: Prisma.InvoiceWhereInput[] = [where]
    if (f.clientId) and.push({ clientId: f.clientId })
    if (f.dateFrom) and.push({ invoiceDate: { gte: f.dateFrom } })
    if (f.dateTo) and.push({ invoiceDate: { lte: f.dateTo } })
    if (f.q) {
      and.push({
        OR: [
          { invoiceNumber: { contains: f.q, mode: 'insensitive' } },
          { billingName: { contains: f.q, mode: 'insensitive' } },
          { client: { companyName: { contains: f.q, mode: 'insensitive' } } },
        ],
      })
    }
    // `overdue` is derived rather than stored, but it is still a plain
    // predicate on stored columns — the same one effectiveStatus applies —
    // so the database answers it and pages it like any other filter.
    if (f.status === 'overdue') and.push(overdueWhere(istToday()))
    else if (f.status === 'refund_due') and.push({ id: { in: await refundDueIds() } })
    else if (f.status) and.push({ status: f.status })

    const rows = await prisma.invoice.findMany({
      where: { AND: and },
      include: { items: ITEM_SELECT, client: true, bankAccount: true, refunds: REFUND_SELECT },
      orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }],
      take: f.limit ?? 50,
      skip: f.offset ?? 0,
    })
    const emp = await employeeMap(rows.map((r) => r.preparedById).filter(Boolean) as string[])
    const items = rows.map((r) => serialize(r, emp))
    return { items, total: items.length }
  },

  async get(session: Session, scope: Scope, id: string): Promise<SerializedInvoice> {
    const where = await visibleWhere(session, scope)
    const inv = await prisma.invoice.findFirst({
      where: { AND: [where, { id }] },
      include: { items: ITEM_SELECT, client: true, bankAccount: true, refunds: REFUND_SELECT },
    })
    if (!inv) throw ApiError.notFound('No such invoice.')
    const emp = await employeeMap(inv.preparedById ? [inv.preparedById] : [])
    return serialize(inv, emp)
  },

  async summary(session: Session, scope: Scope) {
    const where = await visibleWhere(session, scope)
    const rows = await prisma.invoice.findMany({
      where,
      select: {
        status: true, dueDate: true, totalPaise: true, balanceDuePaise: true,
        amountPaidPaise: true, tdsDeductedPaise: true, creditedPaise: true, refundedPaise: true,
      },
    })
    const today = istToday()
    const counts: Record<string, number> = {}
    let outstandingPaise = 0
    let overduePaise = 0
    let refundDuePaise = 0
    for (const r of rows) {
      const s = effectiveStatus(r, today)
      counts[s] = (counts[s] ?? 0) + 1
      if (s !== 'cancelled' && s !== 'draft') outstandingPaise += r.balanceDuePaise
      if (s === 'overdue') overduePaise += r.balanceDuePaise
      // Not a status of its own — a paid invoice can also owe money back.
      const due = refundDueOf(r)
      if (due > 0) {
        counts.refund_due = (counts.refund_due ?? 0) + 1
        refundDuePaise += due
      }
    }
    return { counts, outstanding_paise: outstandingPaise, overdue_paise: overduePaise, refund_due_paise: refundDuePaise, total: rows.length }
  },

  /**
   * Create a DRAFT. It has NO number yet — the number is allocated when it
   * is sent (see send()), so a draft that is abandoned or deleted never
   * leaves a gap in the GST series. The party/bank snapshots are taken now,
   * so the document is reproducible from this row alone.
   */
  async create(session: Session, scope: Scope, input: InvoiceInput): Promise<SerializedInvoice> {
    await assertCanSeeClient(session, scope, input.clientId)
    await assertInvoiceLinks(input.clientId, input.clientServiceId, input.auditEngagementId)
    const id = await prisma.$transaction((tx) => createInvoiceRecord(tx, input, {
      userId: session.userId, employeeId: session.employeeId ?? null,
    }))
    return this.get(session, scope, id)
  },

  /** Replace a DRAFT's contents. Items are replaced wholesale — the builder
   *  sends the whole document, and reconciling row-by-row would be a second
   *  source of truth for order. */
  async update(session: Session, scope: Scope, id: string, input: InvoiceInput): Promise<SerializedInvoice> {
    input = withDerivedSplit(input)
    const existing = await this.get(session, scope, id)
    assertEditable({ status: existing.stored_status, invoiceNumber: existing.invoice_number })
    await assertCanSeeClient(session, scope, input.clientId)
    const client = await prisma.client.findFirst({
      where: { id: input.clientId, deletedAt: null },
    })
    if (!client) throw ApiError.notFound('No such client.')
    // The links kept (or newly set) must belong to the invoice's client —
    // including when only the client changed.
    await assertInvoiceLinks(
      input.clientId,
      input.clientServiceId !== undefined ? input.clientServiceId : existing.client_service_id,
      input.auditEngagementId !== undefined ? input.auditEngagementId : existing.audit_engagement_id,
    )

    const bank = input.bankAccountId
      ? await prisma.firmBankAccount.findFirst({ where: { id: input.bankAccountId, organisationId: await orgId() } })
      : null

    const totals = computeTotals(toLineInputs(input.items), {
      invoiceDiscountPaise: input.discountPaise,
      isInterState: input.isInterState,
      amountPaidPaise: 0,
    })
    const dueDate = dueDateFor(input.invoiceDate, input.terms, input.dueDate)

    await prisma.$transaction(async (tx) => {
      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } })
      await tx.invoice.update({
        where: { id },
        data: {
          clientId: input.clientId,
          invoiceDate: input.invoiceDate,
          terms: input.terms,
          dueDate,
          placeOfSupply: input.placeOfSupply ?? null,
          isInterState: input.isInterState ?? false,
          ...partySnapshot(input, client),
          ...totalsData(totals),
          notes: input.notes ?? null,
          templateId: input.templateId ?? 'tax-invoice',
          layoutConfig: (input.layoutConfig ?? undefined) as Prisma.InputJsonValue,
          blockConfig: (input.blockConfig ?? undefined) as Prisma.InputJsonValue,
          bankAccountId: bank?.id ?? null,
          /* Prisma reads `undefined` as "leave this column alone", which is
             exactly wrong when clearing: the previous snapshot would survive
             being switched to None. DbNull writes an actual NULL. */
          bankSnapshot: bank ? (bankSnapshotOf(bank) as Prisma.InputJsonValue) : Prisma.DbNull,
          signatoryName: input.signatoryName ?? null,
          signatoryDesignation: input.signatoryDesignation ?? null,
          footerNote: input.footerNote ?? null,
          qrMode: input.qrMode ?? 'upi_amount',
          qrValue: input.qrValue ?? null,
          qrImage: input.qrImage ?? null,
          ...(input.clientServiceId !== undefined ? { clientServiceId: input.clientServiceId } : {}),
          ...(input.auditEngagementId !== undefined ? { auditEngagementId: input.auditEngagementId } : {}),
          updatedBy: session.userId,
          items: { create: itemRows(input.items, totals) },
        },
      })
    })
    return this.get(session, scope, id)
  },

  /**
   * draft → sent. The document is frozen from here (§40), and this is where
   * it gets its number: allocated under the sequence lock in the same
   * transaction that flips the status, so the series has no gaps and two
   * sends of one draft (a double-click) cannot take two numbers. A legacy
   * draft that was numbered at creation keeps the number it has.
   */
  async send(session: Session, scope: Scope, id: string): Promise<SerializedInvoice> {
    const inv = await this.get(session, scope, id)
    assertTransition(inv.stored_status as InvoiceStatus, 'sent', inv.invoice_number)
    if (inv.items.length === 0) throw ApiError.badRequest('An invoice needs at least one item before it is sent.')
    await prisma.$transaction((tx) => sendInvoiceTx(tx, id, session.userId))
    return this.get(session, scope, id)
  },

  /**
   * Record a payment. The STATUS FOLLOWS THE MONEY rather than being chosen:
   * paying the balance in full marks it paid, anything less marks it
   * partially paid. Overpayment is refused: money owed back to a client comes
   * from a credit note and leaves through a refund (recordRefund).
   */
  async recordPayment(session: Session, scope: Scope, id: string, input: PaymentInput): Promise<SerializedInvoice> {
    await this.get(session, scope, id) // visibility check
    await addPayment(id, input, session.userId)
    return this.get(session, scope, id)
  },

  async removePayment(session: Session, scope: Scope, id: string, paymentId: string): Promise<SerializedInvoice> {
    await this.get(session, scope, id)
    await removePayment(id, paymentId, session.userId)
    return this.get(session, scope, id)
  },

  /** Money paid back to the client — at most the refund due (refunds.ts). */
  async recordRefund(session: Session, scope: Scope, id: string, input: RefundInput): Promise<{ invoice: SerializedInvoice; refund: ReturnType<typeof refundToApi> }> {
    await this.get(session, scope, id) // visibility check
    const row = await addRefund(id, input, session.userId)
    return { invoice: await this.get(session, scope, id), refund: refundToApi(row) }
  },

  async removeRefund(session: Session, scope: Scope, id: string, refundId: string): Promise<SerializedInvoice> {
    await this.get(session, scope, id)
    await removeRefund(id, refundId, session.userId)
    return this.get(session, scope, id)
  },

  async cancel(session: Session, scope: Scope, id: string, reason?: string): Promise<SerializedInvoice> {
    const inv = await this.get(session, scope, id)
    assertTransition(inv.stored_status as InvoiceStatus, 'cancelled', inv.invoice_number)
    // Cancelling would leave money received against an invoice nobody owes.
    // The amount check also covers legacy rows paid before payment rows existed.
    const payments = await prisma.invoicePayment.count({ where: { invoiceId: id, deletedAt: null } })
    if (payments > 0 || inv.amount_paid_paise > 0) {
      throw ApiError.conflict(
        'invoice_has_payments',
        'This invoice has payments recorded. Remove the payments first, or issue a credit note.',
      )
    }
    const credits = await prisma.creditNote.count({ where: { invoiceId: id, deletedAt: null, status: 'issued' } })
    if (credits > 0) {
      throw ApiError.conflict(
        'invoice_has_credit_notes',
        'Credit notes have been issued against this invoice. Cancel them first.',
      )
    }
    await prisma.invoice.update({
      where: { id },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        notes: reason ? `${inv.notes ? `${inv.notes}\n\n` : ''}Cancelled: ${reason}` : inv.notes,
        updatedBy: session.userId,
      },
    })
    return this.get(session, scope, id)
  },

  /** Soft-delete, drafts only. An issued invoice is cancelled, never removed —
   *  the number must stay accounted for. */
  async remove(session: Session, scope: Scope, id: string): Promise<void> {
    const inv = await this.get(session, scope, id)
    assertEditable({ status: inv.stored_status, invoiceNumber: inv.invoice_number })
    await prisma.invoice.update({
      where: { id },
      data: { deletedAt: new Date(), updatedBy: session.userId },
    })
  },

  /**
   * Add an account the firm can print on an invoice.
   *
   * Making one the default CLEARS the previous default in the same
   * transaction: two defaults would make "the default account" ambiguous, and
   * create() picks by that flag. Existing invoices are untouched — they carry
   * their own bank snapshot, so a new account never rewrites a document that
   * has already gone out.
   */
  async createBankAccount(session: Session, input: {
    label: string; accountNumber: string; accountType: string; accountHolder: string
    bankName: string; branchName?: string | null; ifscCode: string; upiId?: string | null
    isDefault?: boolean
  }) {
    const org = await orgId()
    const makeDefault = input.isDefault ?? (await prisma.firmBankAccount.count({ where: { organisationId: org } })) === 0
    const row = await prisma.$transaction(async (tx) => {
      if (makeDefault) {
        await tx.firmBankAccount.updateMany({ where: { organisationId: org }, data: { isDefault: false } })
      }
      return tx.firmBankAccount.create({
        data: {
          organisationId: org,
          label: input.label,
          accountNumber: input.accountNumber,
          accountType: input.accountType,
          accountHolder: input.accountHolder,
          bankName: input.bankName,
          branchName: input.branchName ?? null,
          ifscCode: input.ifscCode,
          upiId: input.upiId ?? null,
          isDefault: makeDefault,
          isActive: true,
        },
      })
    })
    return bankSnapshotOf(row)
  },

  /** Retire an account. Soft — `isActive: false` — because invoices already
   *  issued reference it, and a hard delete would break that link. */
  async deactivateBankAccount(_session: Session, id: string) {
    const org = await orgId()
    const row = await prisma.firmBankAccount.findFirst({ where: { id, organisationId: org } })
    if (!row) throw ApiError.notFound('No such bank account.')
    await prisma.firmBankAccount.update({ where: { id }, data: { isActive: false, isDefault: false } })
  },

  async bankAccounts(_session: Session) {
    const rows = await prisma.firmBankAccount.findMany({
      where: { organisationId: await orgId(), isActive: true },
      orderBy: [{ isDefault: 'desc' }, { label: 'asc' }],
    })
    return { items: rows.map(bankSnapshotOf) }
  },
}


// ── Internal writers (no session) ─────────────────────────────────────────

/**
 * Insert a DRAFT inside the caller's transaction. The one place an invoice
 * row is created — InvoiceService.create, the recurring scheduler and the
 * quotation conversion all come through here, so totals, snapshots and the
 * default bank account are applied the same way every time. Visibility is
 * the CALLER's job (create() checks the client scope first).
 */
export async function createInvoiceRecord(
  tx: Prisma.TransactionClient,
  rawInput: InvoiceInput,
  meta: {
    userId: string | null
    employeeId: string | null
    recurringProfileId?: string | null
    clientServiceId?: string | null
    auditEngagementId?: string | null
  },
): Promise<string> {
  const input = withDerivedSplit(rawInput)
  const client = await tx.client.findFirst({ where: { id: input.clientId, deletedAt: null } })
  if (!client) throw ApiError.notFound('No such client.')
  const org = await orgId()

  /* Three cases, and they are not the same:
       a chosen id  -> that account
       undefined    -> nothing was said, so the firm's default applies
       null         -> "None" was chosen, so no bank block prints
     Treating null as "unspecified" is what made None fall back to the
     default and print a bank block the user had switched off. */
  const bank = input.bankAccountId
    ? await tx.firmBankAccount.findFirst({ where: { id: input.bankAccountId, organisationId: org } })
    : input.bankAccountId === undefined
      ? await tx.firmBankAccount.findFirst({ where: { organisationId: org, isActive: true, isDefault: true } })
      : null

  const totals = computeTotals(toLineInputs(input.items), {
    invoiceDiscountPaise: input.discountPaise,
    isInterState: input.isInterState,
    amountPaidPaise: 0,
  })
  const dueDate = dueDateFor(input.invoiceDate, input.terms, input.dueDate)

  const created = await tx.invoice.create({
    data: {
      organisationId: org,
      invoiceNumber: null,
      clientId: input.clientId,
      invoiceDate: input.invoiceDate,
      terms: input.terms,
      dueDate,
      placeOfSupply: input.placeOfSupply ?? null,
      isInterState: input.isInterState ?? false,
      status: 'draft',
      ...partySnapshot(input, client),
      ...totalsData(totals),
      notes: input.notes ?? null,
      templateId: input.templateId ?? 'tax-invoice',
      layoutConfig: (input.layoutConfig ?? undefined) as Prisma.InputJsonValue,
      blockConfig: (input.blockConfig ?? undefined) as Prisma.InputJsonValue,
      bankAccountId: bank?.id ?? null,
      /* Prisma reads `undefined` as "leave this column alone", which is
         exactly wrong when clearing: the previous snapshot would survive
         being switched to None. DbNull writes an actual NULL. */
      bankSnapshot: bank ? (bankSnapshotOf(bank) as Prisma.InputJsonValue) : Prisma.DbNull,
      signatoryName: input.signatoryName ?? null,
      signatoryDesignation: input.signatoryDesignation ?? null,
      footerNote: input.footerNote ?? null,
      qrMode: input.qrMode ?? 'upi_amount',
      qrValue: input.qrValue ?? null,
      qrImage: input.qrImage ?? null,
      recurringProfileId: meta.recurringProfileId ?? null,
      clientServiceId: meta.clientServiceId ?? input.clientServiceId ?? null,
      auditEngagementId: meta.auditEngagementId ?? input.auditEngagementId ?? null,
      preparedById: meta.employeeId,
      createdBy: meta.userId,
      updatedBy: meta.userId,
      items: { create: itemRows(input.items, totals) },
    },
  })
  return created.id
}

/**
 * draft → sent inside the caller's transaction: the number is allocated under
 * the sequence lock in the same transaction that flips the status, so the
 * series has no gaps and two sends of one draft cannot take two numbers.
 */
export async function sendInvoiceTx(tx: Prisma.TransactionClient, id: string, userId: string | null): Promise<string> {
  const inv = await tx.invoice.findFirst({ where: { id, deletedAt: null }, select: { invoiceNumber: true, status: true } })
  if (!inv) throw ApiError.notFound('No such invoice.')
  const invoiceNumber = inv.invoiceNumber ?? await nextInvoiceNumber(tx)
  // Conditional on still being a draft: a concurrent send that got here
  // first has already numbered it, and this one must not renumber it.
  const r = await tx.invoice.updateMany({
    where: { id, status: 'draft', deletedAt: null },
    data: { status: 'sent', invoiceNumber, sentAt: new Date(), updatedBy: userId },
  })
  if (r.count === 0) {
    throw ApiError.conflict('invalid_transition', 'This invoice has already been sent.')
  }
  return invoiceNumber
}

function assertTransition(from: InvoiceStatus, to: InvoiceStatus, number: string | null) {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw ApiError.conflict('invalid_transition', `Invoice ${invoiceLabel(number)} cannot go from ${from} to ${to}.`)
  }
}

/** effectiveStatus's `overdue`, as a database predicate. */
/**
 * Invoices settled beyond their total and not yet refunded. A comparison of
 * column sums, which Prisma's where cannot express — so the ids come from SQL
 * and the caller still applies the visibility scope.
 */
async function refundDueIds(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Invoice"
    WHERE "deletedAt" IS NULL AND "status" NOT IN ('draft', 'cancelled')
      AND "amountPaidPaise" + "tdsDeductedPaise" + "creditedPaise" - "refundedPaise" > "totalPaise"`
  return rows.map((r) => r.id)
}

function overdueWhere(today: string): Prisma.InvoiceWhereInput {
  return {
    status: { notIn: ['draft', 'paid', 'cancelled'] },
    balanceDuePaise: { gt: 0 },
    dueDate: { lt: today },
  }
}

/** The tax split follows the place of supply when the server can tell (supply.ts). */
function withDerivedSplit(input: InvoiceInput): InvoiceInput {
  return { ...input, isInterState: resolveInterState(input.placeOfSupply, input.layoutConfig, input.isInterState) }
}

function bankSnapshotOf(b: {
  id: string; label: string; accountNumber: string; accountType: string; accountHolder: string
  bankName: string; branchName: string | null; ifscCode: string; upiId: string | null
}) {
  return {
    id: b.id,
    label: b.label,
    account_number: b.accountNumber,
    account_type: b.accountType,
    account_holder: b.accountHolder,
    bank_name: b.bankName,
    branch_name: b.branchName,
    ifsc_code: b.ifscCode,
    upi_id: b.upiId,
  }
}

/**
 * §39 — what the document reads instead of the live client row. Falls back to
 * the client master only to FILL a blank, never to overwrite what the builder
 * sent, so an invoice-specific billing address stays invoice-specific.
 */
function partySnapshot(input: InvoiceInput, client: { companyName: string; address: string | null; gstin: string | null }) {
  const billingName = input.billingName || client.companyName
  const billingAddress = input.billingAddress ?? client.address ?? null
  const same = input.shipSameAsBill ?? true
  return {
    billingName,
    billingAddress,
    shipSameAsBill: same,
    shippingName: same ? billingName : input.shippingName || billingName,
    shippingAddress: same ? billingAddress : input.shippingAddress ?? null,
    customerGstin: input.customerGstin ?? client.gstin ?? null,
  }
}

function totalsData(t: ReturnType<typeof computeTotals>) {
  return {
    subtotalPaise: t.subtotalPaise,
    discountPaise: t.discountPaise,
    taxablePaise: t.taxablePaise,
    cgstPaise: t.cgstPaise,
    sgstPaise: t.sgstPaise,
    igstPaise: t.igstPaise,
    roundOffPaise: t.roundOffPaise,
    totalPaise: t.totalPaise,
    amountPaidPaise: 0,
    balanceDuePaise: t.balanceDuePaise,
  }
}

function itemRows(items: ItemInput[], t: ReturnType<typeof computeTotals>) {
  return items.map((i, idx) => {
    const line = t.lines[idx]
    return {
      serviceId: i.serviceId ?? null,
      sortOrder: idx,
      itemName: i.itemName,
      description: i.description ?? null,
      hsnSac: i.hsnSac ?? null,
      quantityCenti: i.quantityCenti,
      unit: i.unit ?? 'Nos',
      ratePaise: i.ratePaise,
      discountPercent: i.discountPercent,
      gstRatePercent: i.gstRatePercent,
      taxableAmountPaise: line.taxableAmountPaise,
      cgstAmountPaise: line.cgstAmountPaise,
      sgstAmountPaise: line.sgstAmountPaise,
      igstAmountPaise: line.igstAmountPaise,
      totalAmountPaise: line.totalAmountPaise,
    }
  })
}

/**
 * The firm's house style for an invoice raised WITHOUT the builder (recurring
 * retainers, quotation conversion): the letterhead, block layout, signatory,
 * footer and QR mode of the most recent invoice. The builder snapshots the
 * company block onto every invoice, so this is the firm's current letterhead;
 * with no prior invoice the document falls back to the firm record.
 */
export async function invoiceHouseStyle(tx: Prisma.TransactionClient): Promise<Partial<InvoiceInput>> {
  const last = await tx.invoice.findFirst({
    where: { deletedAt: null, layoutConfig: { not: Prisma.DbNull } },
    orderBy: { createdAt: 'desc' },
    select: { layoutConfig: true, blockConfig: true, signatoryName: true, signatoryDesignation: true, footerNote: true, qrMode: true, qrValue: true, qrImage: true, templateId: true },
  })
  if (!last) return {}
  return {
    layoutConfig: (last.layoutConfig ?? null) as Prisma.InputJsonValue | null,
    blockConfig: (last.blockConfig ?? null) as Prisma.InputJsonValue | null,
    signatoryName: last.signatoryName,
    signatoryDesignation: last.signatoryDesignation,
    footerNote: last.footerNote,
    qrMode: last.qrMode as QrMode,
    qrValue: last.qrValue,
    qrImage: last.qrImage,
    templateId: last.templateId,
  }
}
