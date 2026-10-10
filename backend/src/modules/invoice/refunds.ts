/**
 * REFUNDS — money paid back to a client against one invoice.
 *
 * A refund becomes due when an invoice is settled beyond its total: typically
 * a credit note issued after the client has already paid (settled = cash +
 * TDS + credits − refunds; refund due = settled − total). Each refund is one
 * InvoiceRefund row with a voucher number ('RFD-000001'); the invoice's
 * refundedPaise / balance / status are RECOMPUTED from the live rows in the
 * same transaction, so removing a wrong entry puts the invoice back exactly
 * where it was. A refund never moves the invoice's paid date.
 */
import { z } from 'zod'
import { istToday } from '../../lib/dates.js'
import { ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { formatINR } from '../../lib/money.js'
import { lockSequence } from '../../lib/sequence.js'
import { nextRefundNumber } from '../../platform/workstation/codes.js'
import { liveSettlement, recomputeInvoice } from './payments.js'

export const REFUND_MODES = ['bank_transfer', 'upi', 'cheque', 'cash', 'other'] as const
export type RefundMode = (typeof REFUND_MODES)[number]

export const refundBodySchema = z.object({
  amount_paise: z.coerce.number().int().positive('Enter the amount refunded.').max(1_000_000_000_0),
  refunded_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick the date the refund was paid.').optional(),
  mode: z.enum(REFUND_MODES).optional(),
  reference: z.string().trim().max(120).nullish(),
  note: z.string().trim().max(500).nullish(),
  credit_note_id: z.string().max(64).nullish(),
})

export interface RefundInput {
  amountPaise: number
  refundedOn: string
  mode: RefundMode
  reference?: string | null
  note?: string | null
  creditNoteId?: string | null
}

export function toRefundInput(b: z.infer<typeof refundBodySchema>): RefundInput {
  const refundedOn = b.refunded_on ?? istToday()
  if (refundedOn > istToday()) throw ApiError.badRequest('A refund cannot be dated in the future.')
  return {
    amountPaise: b.amount_paise, refundedOn, mode: b.mode ?? 'bank_transfer',
    reference: b.reference, note: b.note, creditNoteId: b.credit_note_id ?? null,
  }
}

export function refundToApi(r: {
  id: string; refundNumber: string | null; invoiceId: string; clientId: string; creditNoteId: string | null
  amountPaise: number; refundedOn: string; mode: string; reference: string | null; note: string | null
  createdAt: Date; createdBy: string | null
}) {
  return {
    id: r.id,
    refund_number: r.refundNumber,
    invoice_id: r.invoiceId,
    client_id: r.clientId,
    credit_note_id: r.creditNoteId,
    amount_paise: r.amountPaise,
    refunded_on: r.refundedOn,
    mode: r.mode,
    reference: r.reference,
    note: r.note,
    created_at: r.createdAt.toISOString(),
    created_by: r.createdBy,
  }
}
export type SerializedRefund = ReturnType<typeof refundToApi>

/** "Refund is more than the amount due back to the client (₹ X)." — 422. */
function overRefundDue(due: number) {
  return ApiError.unprocessable(
    'refund_exceeds_due',
    `Refund is more than the amount due back to the client (${formatINR(due)}).`,
    { refund_due_paise: due },
  )
}

/**
 * Record one refund. The cap (the current refund due) is re-read under the
 * per-invoice lock — the same lock payments and credit notes take — so a
 * refund racing a payment, a credit-note cancel or another refund cannot pay
 * back more than is owed. The voucher number is taken last, under its own lock.
 */
export async function addRefund(invoiceId: string, input: RefundInput, userId: string) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } })
  if (!inv || inv.deletedAt) throw ApiError.notFound('Invoice not found.')
  if (inv.status === 'draft' || inv.status === 'cancelled') {
    throw ApiError.conflict('invoice_not_refundable', 'Only a sent invoice can have a refund recorded against it.')
  }
  if (input.amountPaise <= 0) throw ApiError.badRequest('Enter the amount refunded.')
  if (input.creditNoteId) {
    const cn = await prisma.creditNote.findFirst({
      where: { id: input.creditNoteId, invoiceId, deletedAt: null, status: 'issued' }, select: { id: true },
    })
    if (!cn) throw ApiError.badRequest('That credit note is not an issued credit note on this invoice.')
  }
  return prisma.$transaction(async (tx) => {
    await lockSequence(tx, `invoice:${invoiceId}`)
    const m = await liveSettlement(tx, invoiceId)
    if (input.amountPaise > m.refundDue) throw overRefundDue(m.refundDue)
    const row = await tx.invoiceRefund.create({
      data: {
        organisationId: inv.organisationId,
        invoiceId,
        clientId: inv.clientId,
        creditNoteId: input.creditNoteId ?? null,
        amountPaise: input.amountPaise,
        refundedOn: input.refundedOn,
        mode: input.mode,
        reference: input.reference?.trim() || null,
        note: input.note?.trim() || null,
        refundNumber: await nextRefundNumber(tx),
        createdBy: userId,
        updatedBy: userId,
      },
    })
    await recomputeInvoice(tx, invoiceId, userId)
    return row
  })
}

/** Remove a wrongly-entered refund; the invoice is recomputed from the rest. */
export async function removeRefund(invoiceId: string, refundId: string, userId: string) {
  const row = await prisma.invoiceRefund.findFirst({ where: { id: refundId, invoiceId, deletedAt: null } })
  if (!row) throw ApiError.notFound('Refund not found.')
  await prisma.$transaction(async (tx) => {
    await lockSequence(tx, `invoice:${invoiceId}`)
    const r = await tx.invoiceRefund.updateMany({ where: { id: row.id, deletedAt: null }, data: { deletedAt: new Date(), updatedBy: userId } })
    if (r.count === 0) throw ApiError.notFound('Refund not found.')
    await recomputeInvoice(tx, invoiceId, userId)
  })
  return row
}

export async function listRefunds(invoiceId: string) {
  const rows = await prisma.invoiceRefund.findMany({
    where: { invoiceId, deletedAt: null }, orderBy: [{ refundedOn: 'asc' }, { createdAt: 'asc' }],
  })
  return rows.map(refundToApi)
}
