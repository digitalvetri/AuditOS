/**
 * CREDIT NOTES (s.34 CGST Act) — Workstation → Invoice → Credit note.
 *
 * A credit note reduces what a client owes on ONE issued invoice: a fee
 * reduced after the fact, a deficiency in service, a post-sale discount. It
 * follows the invoice rules:
 *
 *  - DRAFT → ISSUED → CANCELLED. A draft has no number; CN-000001 is taken
 *    when it is issued, under the sequence lock, so an abandoned draft leaves
 *    no gap in the series (same rule as invoice numbers).
 *  - Only against a sent / partially paid / paid invoice. The GST split
 *    MIRRORS the invoice (isInterState, place of supply) — a credit note
 *    cannot reverse IGST on an invoice that charged CGST+SGST.
 *  - The total can never exceed the invoice's BALANCE DUE (total − cash paid
 *    − TDS − credit notes already issued): AuditOS does not record refunds,
 *    so a credit may only reduce what is still owed. Checked on save and
 *    again at ISSUE under the per-invoice lock, so two concurrent issues (or
 *    an issue racing a payment) cannot both pass. 422 when it does not fit.
 *  - Issuing never moves the invoice's paid date — that follows payments.
 *  - Issuing and cancelling recompute the invoice (payments.ts), so the
 *    balance due and status always follow cash + TDS + issued credits.
 */
import type { Prisma } from '@prisma/client'
import { ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { lockSequence } from '../../lib/sequence.js'
import type { Session } from '../../platform/auth.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { InvoiceService } from '../invoice/service.js'
import { liveBalanceDue, recomputeInvoice } from '../invoice/payments.js'
import { computeTotals } from '../invoice/totals.js'

export const CREDIT_NOTE_REASONS = ['rate_change', 'deficiency', 'discount', 'return', 'fee_reduction', 'other'] as const
export type CreditNoteReason = (typeof CREDIT_NOTE_REASONS)[number]

/** Invoice states a credit note may be raised against. */
const CREDITABLE = ['sent', 'partially_paid', 'paid']

export interface CreditLineInput {
  description: string
  sacCode?: string | null
  taxablePaise: number
  gstRate: number
}

export interface CreditNoteInput {
  noteDate: string
  reason: CreditNoteReason
  reasonNote?: string | null
  lines: CreditLineInput[]
}

type Tx = Prisma.TransactionClient

/**
 * Line and document totals, by the INVOICE's own engine (one unit at the
 * line's taxable value), so the split and rounding match the invoice it
 * corrects. The grand total is rounded to the rupee like an invoice; the
 * round-off is the difference and is printed, never stored separately.
 */
export function creditTotals(lines: CreditLineInput[], isInterState: boolean) {
  const t = computeTotals(
    lines.map((l) => ({ quantityCenti: 100, ratePaise: l.taxablePaise, discountPercent: 0, gstRatePercent: l.gstRate })),
    { isInterState },
  )
  return {
    lines: lines.map((l, i) => ({
      description: l.description,
      sac_code: l.sacCode ?? null,
      taxable_paise: t.lines[i].taxableAmountPaise,
      gst_rate: l.gstRate,
      cgst_paise: t.lines[i].cgstAmountPaise,
      sgst_paise: t.lines[i].sgstAmountPaise,
      igst_paise: t.lines[i].igstAmountPaise,
      total_paise: t.lines[i].totalAmountPaise,
    })),
    taxablePaise: t.taxablePaise,
    cgstPaise: t.cgstPaise,
    sgstPaise: t.sgstPaise,
    igstPaise: t.igstPaise,
    totalPaise: t.totalPaise,
  }
}

/** 'CN-000001' — flat, gapless, allocated at issue. Soft-deleted rows count. */
export async function nextCreditNoteNumber(tx: Tx): Promise<string> {
  await lockSequence(tx, 'code:CN')
  const prefix = 'CN-'
  const rows = await tx.creditNote.findMany({
    where: { creditNoteNumber: { startsWith: prefix } },
    select: { creditNoteNumber: true },
  })
  let max = 0
  for (const r of rows) {
    const n = Number((r.creditNoteNumber ?? '').slice(prefix.length))
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(6, '0')}`
}

type Row = Prisma.CreditNoteGetPayload<{ include: { invoice: { select: { invoiceNumber: true; invoiceDate: true; client: { select: { companyName: true } } } } } }>
const INCLUDE = { invoice: { select: { invoiceNumber: true, invoiceDate: true, client: { select: { companyName: true } } } } } as const

function serialize(n: Row) {
  return {
    id: n.id,
    credit_note_number: n.creditNoteNumber,
    display_number: n.creditNoteNumber ?? 'Draft',
    invoice_id: n.invoiceId,
    invoice_number: n.invoice.invoiceNumber,
    invoice_date: n.invoice.invoiceDate,
    client_id: n.clientId,
    client_name: n.invoice.client.companyName,
    note_date: n.noteDate,
    reason: n.reason,
    reason_note: n.reasonNote,
    status: n.status,
    is_inter_state: n.isInterState,
    place_of_supply: n.placeOfSupply,
    taxable_paise: n.taxablePaise,
    cgst_paise: n.cgstPaise,
    sgst_paise: n.sgstPaise,
    igst_paise: n.igstPaise,
    total_paise: n.totalPaise,
    lines: Array.isArray(n.linesJson) ? n.linesJson : [],
    issued_at: n.issuedAt?.toISOString() ?? null,
    cancelled_at: n.cancelledAt?.toISOString() ?? null,
    created_at: n.createdAt.toISOString(),
    updated_at: n.updatedAt.toISOString(),
  }
}
export type SerializedCreditNote = ReturnType<typeof serialize>

async function creditedSoFar(tx: Tx | typeof prisma, invoiceId: string, excludeId?: string) {
  const agg = await tx.creditNote.aggregate({
    where: { invoiceId, deletedAt: null, status: 'issued', ...(excludeId ? { id: { not: excludeId } } : {}) },
    _sum: { totalPaise: true },
  })
  return agg._sum.totalPaise ?? 0
}

function assertLines(lines: CreditLineInput[]) {
  if (lines.length === 0) throw ApiError.badRequest('A credit note needs at least one line.')
  if (lines.some((l) => l.taxablePaise <= 0)) throw ApiError.badRequest('Each line must credit more than zero.')
}

export const CreditNoteService = {
  /** Visibility follows the invoice: InvoiceService.get applies the client scope. */
  async list(session: Session, scope: Scope, f: { invoiceId?: string; clientId?: string; status?: string; q?: string } = {}) {
    if (f.invoiceId) await InvoiceService.get(session, scope, f.invoiceId)
    const visibleInvoiceIds = scope === 'organisation' || scope === 'department' || f.invoiceId
      ? null
      : (await InvoiceService.list(session, scope, { limit: 10_000 })).items.map((i) => i.id)
    const rows = await prisma.creditNote.findMany({
      where: {
        deletedAt: null,
        ...(f.invoiceId ? { invoiceId: f.invoiceId } : {}),
        ...(visibleInvoiceIds ? { invoiceId: { in: visibleInvoiceIds } } : {}),
        ...(f.clientId ? { clientId: f.clientId } : {}),
        ...(f.status ? { status: f.status } : {}),
        ...(f.q ? {
          OR: [
            { creditNoteNumber: { contains: f.q, mode: 'insensitive' } },
            { invoice: { invoiceNumber: { contains: f.q, mode: 'insensitive' } } },
            { invoice: { client: { companyName: { contains: f.q, mode: 'insensitive' } } } },
          ],
        } : {}),
      },
      include: INCLUDE,
      orderBy: [{ noteDate: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    })
    const items = rows.map(serialize)
    return { items, total: items.length }
  },

  async get(session: Session, scope: Scope, id: string): Promise<SerializedCreditNote> {
    const n = await prisma.creditNote.findFirst({ where: { id, deletedAt: null }, include: INCLUDE })
    if (!n) throw ApiError.notFound('No such credit note.')
    await InvoiceService.get(session, scope, n.invoiceId) // scope check
    return serialize(n)
  },

  /** What can still be credited on an invoice (its balance due), plus its lines as a starting point. */
  async creditable(session: Session, scope: Scope, invoiceId: string) {
    const inv = await InvoiceService.get(session, scope, invoiceId)
    const [credited, balance] = await Promise.all([creditedSoFar(prisma, invoiceId), liveBalanceDue(prisma, invoiceId)])
    return {
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      total_paise: inv.total_paise,
      credited_paise: credited,
      creditable_paise: balance,
      is_inter_state: inv.is_inter_state,
      place_of_supply: inv.place_of_supply,
      suggested_lines: inv.items.map((i) => ({
        description: i.description ? `${i.item_name} — ${i.description}` : i.item_name,
        sac_code: i.hsn_sac,
        taxable_paise: i.taxable_amount_paise,
        gst_rate: i.gst_rate_percent,
      })),
    }
  },

  async create(session: Session, scope: Scope, invoiceId: string, input: CreditNoteInput): Promise<SerializedCreditNote> {
    const inv = await InvoiceService.get(session, scope, invoiceId)
    if (!CREDITABLE.includes(inv.stored_status)) {
      throw ApiError.conflict('invoice_not_creditable', 'A credit note can only be raised against a sent, partially paid or paid invoice.')
    }
    assertLines(input.lines)
    const t = creditTotals(input.lines, inv.is_inter_state)
    const remaining = await liveBalanceDue(prisma, invoiceId)
    if (t.totalPaise > remaining) throw overLimit(remaining)
    const org = (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { organisationId: true } })).organisationId
    const row = await prisma.creditNote.create({
      data: {
        organisationId: org,
        invoiceId,
        clientId: inv.client_id,
        noteDate: input.noteDate,
        reason: input.reason,
        reasonNote: input.reasonNote ?? null,
        status: 'draft',
        isInterState: inv.is_inter_state,
        placeOfSupply: inv.place_of_supply,
        taxablePaise: t.taxablePaise,
        cgstPaise: t.cgstPaise,
        sgstPaise: t.sgstPaise,
        igstPaise: t.igstPaise,
        totalPaise: t.totalPaise,
        linesJson: t.lines as unknown as Prisma.InputJsonValue,
        createdBy: session.userId,
        updatedBy: session.userId,
      },
    })
    return this.get(session, scope, row.id)
  },

  async update(session: Session, scope: Scope, id: string, input: CreditNoteInput): Promise<SerializedCreditNote> {
    const n = await this.get(session, scope, id)
    if (n.status !== 'draft') throw ApiError.conflict('credit_note_not_editable', `Credit note ${n.display_number} has been issued and cannot be edited.`)
    assertLines(input.lines)
    const t = creditTotals(input.lines, n.is_inter_state)
    const remaining = await liveBalanceDue(prisma, n.invoice_id)
    if (t.totalPaise > remaining) throw overLimit(remaining)
    await prisma.creditNote.update({
      where: { id },
      data: {
        noteDate: input.noteDate,
        reason: input.reason,
        reasonNote: input.reasonNote ?? null,
        taxablePaise: t.taxablePaise,
        cgstPaise: t.cgstPaise,
        sgstPaise: t.sgstPaise,
        igstPaise: t.igstPaise,
        totalPaise: t.totalPaise,
        linesJson: t.lines as unknown as Prisma.InputJsonValue,
        updatedBy: session.userId,
      },
    })
    return this.get(session, scope, id)
  },

  /** draft → issued: number, limit check and invoice recompute in one transaction. */
  async issue(session: Session, scope: Scope, id: string): Promise<SerializedCreditNote> {
    const n = await this.get(session, scope, id)
    if (n.status !== 'draft') throw ApiError.conflict('invalid_transition', `Credit note ${n.display_number} has already been ${n.status}.`)
    await prisma.$transaction(async (tx) => {
      // Lock order matches addPayment: the invoice first, then the CN series.
      await lockSequence(tx, `invoice:${n.invoice_id}`)
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: n.invoice_id }, select: { status: true, deletedAt: true } })
      if (inv.deletedAt || !CREDITABLE.includes(inv.status)) {
        throw ApiError.conflict('invoice_not_creditable', 'The invoice is no longer open to credit (it was cancelled or deleted).')
      }
      const remaining = await liveBalanceDue(tx, n.invoice_id, id)
      if (n.total_paise > remaining) throw overLimit(remaining)
      const number = await nextCreditNoteNumber(tx)
      const r = await tx.creditNote.updateMany({
        where: { id, status: 'draft', deletedAt: null },
        data: { status: 'issued', creditNoteNumber: number, issuedAt: new Date(), updatedBy: session.userId },
      })
      if (r.count === 0) throw ApiError.conflict('invalid_transition', 'This credit note has already been issued.')
      await recomputeInvoice(tx, n.invoice_id, session.userId)
    })
    return this.get(session, scope, id)
  },

  /** issued → cancelled. The number stays used; the invoice balance is restored. */
  async cancel(session: Session, scope: Scope, id: string, reason?: string): Promise<SerializedCreditNote> {
    const n = await this.get(session, scope, id)
    if (n.status !== 'issued') throw ApiError.conflict('invalid_transition', 'Only an issued credit note can be cancelled. Delete a draft instead.')
    await prisma.$transaction(async (tx) => {
      await lockSequence(tx, `invoice:${n.invoice_id}`)
      const r = await tx.creditNote.updateMany({
        where: { id, status: 'issued' },
        data: {
          status: 'cancelled', cancelledAt: new Date(), updatedBy: session.userId,
          ...(reason ? { reasonNote: `${n.reason_note ? `${n.reason_note}\n` : ''}Cancelled: ${reason}` } : {}),
        },
      })
      if (r.count === 0) throw ApiError.conflict('invalid_transition', 'This credit note is no longer issued.')
      await recomputeInvoice(tx, n.invoice_id, session.userId)
    })
    return this.get(session, scope, id)
  },

  async remove(session: Session, scope: Scope, id: string): Promise<SerializedCreditNote> {
    const n = await this.get(session, scope, id)
    if (n.status !== 'draft') throw ApiError.conflict('credit_note_not_editable', 'An issued credit note cannot be deleted — cancel it instead.')
    await prisma.creditNote.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: session.userId } })
    return n
  },
}

export const OVER_BALANCE_MESSAGE =
  'This credit is more than the balance due on the invoice. Refunds are not recorded in AuditOS yet — reduce the credit to the balance due.'

/** 422 — the credit does not fit in the balance due. The ceiling rides in details. */
function overLimit(remaining: number) {
  return ApiError.unprocessable('credit_exceeds_balance', OVER_BALANCE_MESSAGE, { creditable_paise: Math.max(0, remaining) })
}
