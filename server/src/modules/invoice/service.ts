import { Prisma } from '@prisma/client'  // value import: Prisma.DbNull clears a Json column
import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import type { Session } from '../../platform/auth.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { assignedClientIds, assertCanSeeClient } from '../../platform/workstation/scope.js'
import { nextInvoiceNumber } from '../../platform/workstation/codes.js'
import { employeeMap } from '../../api/workstation.serialize.js'
import { computeTotals, invoiceAmountInWords, paymentState, type LineInput } from './totals.js'

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

/** Editable only while nothing has been issued (§40). */
function assertEditable(inv: { status: string; invoiceNumber: string }) {
  if (inv.status !== 'draft') {
    throw ApiError.conflict(
      'invoice_not_editable',
      `Invoice ${inv.invoiceNumber} has been issued and cannot be edited. ` +
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
  items: ItemInput[]
}

// ── Serialisation ─────────────────────────────────────────────────────────

const ITEM_SELECT = { orderBy: { sortOrder: 'asc' } } as const

type Row = Prisma.InvoiceGetPayload<{
  include: { items: true; client: true; bankAccount: true }
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

function serialize(inv: Row, emp: Map<string, { id: string; full_name: string; employee_code: string }>) {
  const today = new Date().toISOString().slice(0, 10)
  const status = effectiveStatus(inv, today)
  return {
    id: inv.id,
    invoice_number: inv.invoiceNumber,
    client_id: inv.clientId,
    client_name: inv.client?.companyName ?? null,
    // Contact fields for share-as-PDF via WhatsApp/email on InvoiceDetail —
    // read from the client master, not the invoice snapshot, because these
    // are how to REACH the client today, not what was on the invoice.
    client_email: inv.client?.email ?? null,
    client_contact_number: inv.client?.contactNumber ?? null,
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
    amount_paid_paise: inv.amountPaidPaise,
    balance_due_paise: inv.balanceDuePaise,
    payment_state: paymentState(inv.totalPaise, inv.amountPaidPaise),
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
    // `overdue` is derived, so it cannot be a database filter. Ask the
    // database for what it can answer and narrow the derived status after.
    const storedStatus = f.status && f.status !== 'overdue' ? f.status : undefined
    if (storedStatus) and.push({ status: storedStatus })

    const rows = await prisma.invoice.findMany({
      where: { AND: and },
      include: { items: ITEM_SELECT, client: true, bankAccount: true },
      orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }],
      take: f.status === 'overdue' ? undefined : f.limit ?? 50,
      skip: f.status === 'overdue' ? undefined : f.offset ?? 0,
    })
    const emp = await employeeMap(rows.map((r) => r.preparedById).filter(Boolean) as string[])
    let items = rows.map((r) => serialize(r, emp))
    if (f.status === 'overdue') {
      items = items.filter((i) => i.status === 'overdue').slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 50))
    }
    return { items, total: items.length }
  },

  async get(session: Session, scope: Scope, id: string): Promise<SerializedInvoice> {
    const where = await visibleWhere(session, scope)
    const inv = await prisma.invoice.findFirst({
      where: { AND: [where, { id }] },
      include: { items: ITEM_SELECT, client: true, bankAccount: true },
    })
    if (!inv) throw ApiError.notFound('No such invoice.')
    const emp = await employeeMap(inv.preparedById ? [inv.preparedById] : [])
    return serialize(inv, emp)
  },

  async summary(session: Session, scope: Scope) {
    const where = await visibleWhere(session, scope)
    const rows = await prisma.invoice.findMany({
      where,
      select: { status: true, dueDate: true, totalPaise: true, balanceDuePaise: true },
    })
    const today = new Date().toISOString().slice(0, 10)
    const counts: Record<string, number> = {}
    let outstandingPaise = 0
    let overduePaise = 0
    for (const r of rows) {
      const s = effectiveStatus(r, today)
      counts[s] = (counts[s] ?? 0) + 1
      if (s !== 'cancelled' && s !== 'draft') outstandingPaise += r.balanceDuePaise
      if (s === 'overdue') overduePaise += r.balanceDuePaise
    }
    return { counts, outstanding_paise: outstandingPaise, overdue_paise: overduePaise, total: rows.length }
  },

  /**
   * Create a DRAFT. The invoice number is allocated inside the transaction
   * (see codes.ts) and the party/bank snapshots are taken now, so the
   * document is reproducible from this row alone.
   */
  async create(session: Session, scope: Scope, input: InvoiceInput): Promise<SerializedInvoice> {
    await assertCanSeeClient(session, scope, input.clientId)
    const client = await prisma.client.findFirst({
      where: { id: input.clientId, deletedAt: null },
    })
    if (!client) throw ApiError.notFound('No such client.')

    /* Three cases, and they are not the same:
         a chosen id  -> that account
         undefined    -> nothing was said, so the firm's default applies
         null         -> "None" was chosen, so no bank block prints
       Treating null as "unspecified" is what made None fall back to the
       default and print a bank block the user had switched off. */
    const bank = input.bankAccountId
      ? await prisma.firmBankAccount.findFirst({ where: { id: input.bankAccountId, organisationId: await orgId() } })
      : input.bankAccountId === undefined
        ? await prisma.firmBankAccount.findFirst({ where: { organisationId: await orgId(), isActive: true, isDefault: true } })
        : null

    const totals = computeTotals(toLineInputs(input.items), {
      invoiceDiscountPaise: input.discountPaise,
      isInterState: input.isInterState,
      amountPaidPaise: 0,
    })
    const dueDate = dueDateFor(input.invoiceDate, input.terms, input.dueDate)

    const org = await orgId()
    const id = await prisma.$transaction(async (tx) => {
      const invoiceNumber = await nextInvoiceNumber(tx)
      const created = await tx.invoice.create({
        data: {
          organisationId: org,
          invoiceNumber,
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
          preparedById: session.employeeId ?? null,
          createdBy: session.userId,
          updatedBy: session.userId,
          items: { create: itemRows(input.items, totals) },
        },
      })
      return created.id
    })
    return this.get(session, scope, id)
  },

  /** Replace a DRAFT's contents. Items are replaced wholesale — the builder
   *  sends the whole document, and reconciling row-by-row would be a second
   *  source of truth for order. */
  async update(session: Session, scope: Scope, id: string, input: InvoiceInput): Promise<SerializedInvoice> {
    const existing = await this.get(session, scope, id)
    assertEditable({ status: existing.stored_status, invoiceNumber: existing.invoice_number })
    await assertCanSeeClient(session, scope, input.clientId)
    const client = await prisma.client.findFirst({
      where: { id: input.clientId, deletedAt: null },
    })
    if (!client) throw ApiError.notFound('No such client.')

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
          updatedBy: session.userId,
          items: { create: itemRows(input.items, totals) },
        },
      })
    })
    return this.get(session, scope, id)
  },

  /** draft → sent. The document is frozen from here (§40). */
  async send(session: Session, scope: Scope, id: string): Promise<SerializedInvoice> {
    const inv = await this.get(session, scope, id)
    assertTransition(inv.stored_status as InvoiceStatus, 'sent', inv.invoice_number)
    if (inv.items.length === 0) throw ApiError.badRequest('An invoice needs at least one item before it is sent.')
    await prisma.invoice.update({
      where: { id },
      data: { status: 'sent', sentAt: new Date(), updatedBy: session.userId },
    })
    return this.get(session, scope, id)
  },

  /**
   * Record a payment. The STATUS FOLLOWS THE MONEY rather than being chosen:
   * paying the balance in full marks it paid, anything less marks it
   * partially paid. Overpayment is refused because the schema does not model
   * credit (§22).
   */
  async recordPayment(session: Session, scope: Scope, id: string, amountPaise: number): Promise<SerializedInvoice> {
    const inv = await this.get(session, scope, id)
    if (inv.stored_status === 'draft') {
      throw ApiError.conflict('invoice_not_sent', 'Send the invoice before recording a payment against it.')
    }
    if (inv.stored_status === 'cancelled') {
      throw ApiError.conflict('invoice_cancelled', 'This invoice has been cancelled.')
    }
    if (amountPaise <= 0) throw ApiError.badRequest('A payment must be more than zero.')
    if (amountPaise > inv.balance_due_paise) {
      throw ApiError.badRequest(
        `That is more than the balance due. At most ${(inv.balance_due_paise / 100).toFixed(2)} can be recorded.`,
      )
    }
    const paid = inv.amount_paid_paise + amountPaise
    const state = paymentState(inv.total_paise, paid)
    await prisma.invoice.update({
      where: { id },
      data: {
        amountPaidPaise: paid,
        balanceDuePaise: Math.max(0, inv.total_paise - paid),
        status: state === 'paid' ? 'paid' : 'partially_paid',
        paidAt: state === 'paid' ? new Date() : null,
        updatedBy: session.userId,
      },
    })
    return this.get(session, scope, id)
  },

  async cancel(session: Session, scope: Scope, id: string, reason?: string): Promise<SerializedInvoice> {
    const inv = await this.get(session, scope, id)
    assertTransition(inv.stored_status as InvoiceStatus, 'cancelled', inv.invoice_number)
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

function assertTransition(from: InvoiceStatus, to: InvoiceStatus, number: string) {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw ApiError.conflict('invalid_transition', `Invoice ${number} cannot go from ${from} to ${to}.`)
  }
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
