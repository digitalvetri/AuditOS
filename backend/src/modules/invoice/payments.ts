/**
 * Payment history for invoices.
 *
 * Every amount recorded against an invoice is one InvoicePayment row, so a
 * client paying in instalments ("split") keeps each instalment with its date,
 * mode and reference. The invoice's amountPaidPaise / balanceDuePaise / status
 * are always RECOMPUTED from the live rows — never incremented — so removing a
 * wrongly-entered payment puts the invoice back exactly where it was.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { istToday } from '../../lib/dates.js'
import { ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { formatINR } from '../../lib/money.js'
import { notifyEmployees } from '../../platform/notify.js'
import { paymentState } from './totals.js'

export const PAYMENT_MODES = ['bank_transfer', 'upi', 'cash', 'cheque', 'card', 'other'] as const
export type PaymentMode = (typeof PAYMENT_MODES)[number]

export interface PaymentInput {
  amountPaise: number
  paidOn: string
  mode: PaymentMode
  reference?: string | null
  note?: string | null
}

type Tx = Prisma.TransactionClient

export const paymentBodySchema = z.object({
  amount_paise: z.coerce.number().int().positive('Enter an amount.'),
  paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick the date the payment was received.').optional(),
  mode: z.enum(PAYMENT_MODES).optional(),
  reference: z.string().trim().max(120).nullish(),
  note: z.string().trim().max(500).nullish(),
})

export function toPaymentInput(b: z.infer<typeof paymentBodySchema>): PaymentInput {
  const paidOn = b.paid_on ?? istToday()
  if (paidOn > istToday()) throw ApiError.badRequest('A payment cannot be dated in the future.')
  return { amountPaise: b.amount_paise, paidOn, mode: b.mode ?? 'bank_transfer', reference: b.reference, note: b.note }
}

export function paymentToApi(p: {
  id: string; invoiceId: string; clientId: string; amountPaise: number; paidOn: string; mode: string
  reference: string | null; note: string | null; createdAt: Date; createdBy: string | null
}) {
  return {
    id: p.id,
    invoice_id: p.invoiceId,
    client_id: p.clientId,
    amount_paise: p.amountPaise,
    paid_on: p.paidOn,
    mode: p.mode,
    reference: p.reference,
    note: p.note,
    created_at: p.createdAt.toISOString(),
    created_by: p.createdBy,
  }
}

/** Paid / balance / status from the live payment rows. */
async function recompute(tx: Tx, invoiceId: string, userId: string) {
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
  const agg = await tx.invoicePayment.aggregate({
    where: { invoiceId, deletedAt: null }, _sum: { amountPaise: true }, _max: { paidOn: true },
  })
  const paid = agg._sum.amountPaise ?? 0
  const state = paymentState(inv.totalPaise, paid)
  // A cancelled invoice keeps its status; everything else follows the money.
  const status = inv.status === 'cancelled' ? 'cancelled'
    : state === 'paid' ? 'paid'
    : paid > 0 ? 'partially_paid'
    : inv.status === 'draft' ? 'draft' : 'sent'
  await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      amountPaidPaise: paid,
      balanceDuePaise: Math.max(0, inv.totalPaise - paid),
      status,
      paidAt: state === 'paid' ? new Date(`${agg._max.paidOn}T00:00:00Z`) : null,
      updatedBy: userId,
    },
  })
}

/**
 * Record one payment (or one instalment of a split). Draft and cancelled
 * invoices take no payments; overpayment is refused because the schema does
 * not model credit.
 */
export async function addPayment(invoiceId: string, input: PaymentInput, userId: string) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } })
  if (!inv || inv.deletedAt) throw ApiError.notFound('Invoice not found.')
  if (inv.status === 'draft') {
    throw ApiError.conflict('invoice_not_sent', 'Send the invoice before recording a payment against it.')
  }
  if (inv.status === 'cancelled') throw ApiError.conflict('invoice_cancelled', 'This invoice has been cancelled.')
  if (input.amountPaise <= 0) throw ApiError.badRequest('A payment must be more than zero.')
  if (input.amountPaise > inv.balanceDuePaise) {
    throw ApiError.badRequest(
      `That is more than the balance due. At most ${(inv.balanceDuePaise / 100).toFixed(2)} can be recorded.`,
    )
  }
  return prisma.$transaction(async (tx) => {
    const row = await tx.invoicePayment.create({
      data: {
        organisationId: inv.organisationId,
        invoiceId,
        clientId: inv.clientId,
        amountPaise: input.amountPaise,
        paidOn: input.paidOn,
        mode: input.mode,
        reference: input.reference?.trim() || null,
        note: input.note?.trim() || null,
        createdBy: userId,
        updatedBy: userId,
      },
    })
    await recompute(tx, invoiceId, userId)
    return row
  })
}

/**
 * Tell the invoice's preparer and the client's account manager that money
 * came in (never the person who recorded it). Call after addPayment has
 * committed. Best effort — never throws.
 */
export async function notifyPaymentRecorded(invoiceId: string, amountPaise: number, actor: { employeeId: string | null; userId: string }) {
  try {
    const inv = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { invoiceNumber: true, preparedById: true, balanceDuePaise: true, client: { select: { companyName: true, accountManagerId: true } } },
    })
    if (!inv) return
    await notifyEmployees([inv.preparedById, inv.client.accountManagerId], {
      type: 'invoice.payment_recorded', module: 'workstation',
      title: `Payment received — ${inv.invoiceNumber}`,
      body: `${formatINR(amountPaise)} from ${inv.client.companyName}${inv.balanceDuePaise > 0 ? ` · ${formatINR(inv.balanceDuePaise)} still due` : ' · fully paid'}`,
      entityType: 'Invoice', entityId: invoiceId,
      actionUrl: `/workstation/invoices/${invoiceId}`,
    }, actor)
  } catch { /* best effort */ }
}

/** Remove a wrongly-entered payment; the invoice is recomputed from the rest. */
export async function removePayment(invoiceId: string, paymentId: string, userId: string) {
  const row = await prisma.invoicePayment.findFirst({ where: { id: paymentId, invoiceId, deletedAt: null } })
  if (!row) throw ApiError.notFound('Payment not found.')
  await prisma.$transaction(async (tx) => {
    await tx.invoicePayment.update({ where: { id: row.id }, data: { deletedAt: new Date(), updatedBy: userId } })
    await recompute(tx, invoiceId, userId)
  })
  return row
}

export async function listPayments(invoiceId: string) {
  const rows = await prisma.invoicePayment.findMany({
    where: { invoiceId, deletedAt: null }, orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }],
  })
  return rows.map(paymentToApi)
}

/**
 * Invoices paid before payment history existed carry an amountPaidPaise with
 * no rows behind it. Give each one a single row for the difference, so the
 * history adds up and a later removal can't wipe the older money. Idempotent.
 */
export async function backfillInvoicePayments(db: PrismaClient): Promise<number> {
  const invoices = await db.invoice.findMany({
    where: { amountPaidPaise: { gt: 0 }, deletedAt: null },
    select: { id: true, organisationId: true, clientId: true, amountPaidPaise: true, paidAt: true, invoiceDate: true },
  })
  let created = 0
  for (const inv of invoices) {
    const agg = await db.invoicePayment.aggregate({
      where: { invoiceId: inv.id, deletedAt: null }, _sum: { amountPaise: true },
    })
    const missing = inv.amountPaidPaise - (agg._sum.amountPaise ?? 0)
    if (missing <= 0) continue
    await db.invoicePayment.create({
      data: {
        organisationId: inv.organisationId,
        invoiceId: inv.id,
        clientId: inv.clientId,
        amountPaise: missing,
        paidOn: inv.paidAt ? inv.paidAt.toISOString().slice(0, 10) : inv.invoiceDate,
        mode: 'other',
        note: 'Recorded before payment history was kept',
      },
    })
    created++
  }
  return created
}
