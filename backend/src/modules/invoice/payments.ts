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
import { lockSequence } from '../../lib/sequence.js'
import { nextReceiptNumber } from '../../platform/workstation/codes.js'

export const PAYMENT_MODES = ['bank_transfer', 'upi', 'cash', 'cheque', 'card', 'other'] as const
export type PaymentMode = (typeof PAYMENT_MODES)[number]

/** Sections a client deducts TDS under on our professional fee. 194J is the usual one. */
export const TDS_SECTIONS = ['194J', '194C', '194H', '194I', '194-O', 'other'] as const
export type TdsSection = (typeof TDS_SECTIONS)[number]

export interface PaymentInput {
  amountPaise: number
  paidOn: string
  mode: PaymentMode
  reference?: string | null
  note?: string | null
  /** Tax the client deducted at source. Settles the invoice with amountPaise. */
  tdsPaise?: number
  tdsSection?: string | null
  tdsCertificateReceived?: boolean
  /** Set by the Zoho Payments posting, so one collection is never recorded twice. */
  externalPaymentId?: string | null
}

type Tx = Prisma.TransactionClient

const boolish = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])

export const paymentBodySchema = z.object({
  /* Zero is allowed only when the whole settlement is TDS (the client paid
     nothing in cash because the entire balance was deducted) — checked below. */
  amount_paise: z.coerce.number().int().nonnegative('Enter an amount.'),
  tds_paise: z.coerce.number().int().nonnegative().max(1_000_000_000_0).optional(),
  tds_section: z.enum(TDS_SECTIONS).optional(),
  tds_certificate_received: boolish.optional(),
  paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick the date the payment was received.').optional(),
  mode: z.enum(PAYMENT_MODES).optional(),
  reference: z.string().trim().max(120).nullish(),
  note: z.string().trim().max(500).nullish(),
})

export function toPaymentInput(b: z.infer<typeof paymentBodySchema>): PaymentInput {
  const paidOn = b.paid_on ?? istToday()
  if (paidOn > istToday()) throw ApiError.badRequest('A payment cannot be dated in the future.')
  const tds = b.tds_paise ?? 0
  if (b.amount_paise + tds <= 0) throw ApiError.badRequest('Enter an amount.')
  return {
    amountPaise: b.amount_paise, paidOn, mode: b.mode ?? 'bank_transfer', reference: b.reference, note: b.note,
    tdsPaise: tds,
    // 194J (fees for professional services) is what a client deducts on a CA's fee.
    tdsSection: tds > 0 ? (b.tds_section ?? '194J') : null,
    tdsCertificateReceived: tds > 0 ? (b.tds_certificate_received ?? false) : false,
  }
}

/**
 * The receipt number for a payment row. Stored since receipt numbers became
 * a real sequence (nextReceiptNumber); a row the backfill has not reached yet
 * falls back to the old DERIVED number — its position among every payment
 * ever recorded (removed ones included), oldest first — which is exactly the
 * number the backfill will store for it.
 */
export async function receiptNumberFor(p: { id: string; createdAt: Date; receiptNumber?: string | null }): Promise<string> {
  if (p.receiptNumber) return p.receiptNumber
  return derivedReceiptNumber(prisma, p)
}

async function derivedReceiptNumber(db: Pick<PrismaClient, 'invoicePayment'> | Tx, p: { id: string; createdAt: Date }): Promise<string> {
  const n = await db.invoicePayment.count({
    where: { OR: [{ createdAt: { lt: p.createdAt } }, { createdAt: p.createdAt, id: { lte: p.id } }] },
  })
  return `RCT-${String(n).padStart(6, '0')}`
}

/**
 * Store a receipt number on every payment that has none, oldest first
 * (removed rows included, as the derived numbering always counted them).
 * Each row gets its derived number — the one already printed on its receipt —
 * unless that number is somehow taken, in which case it gets the next one.
 * Idempotent: a second run finds nothing to do. Called from prisma/seed.ts.
 */
export async function backfillReceiptNumbers(db: PrismaClient): Promise<number> {
  const rows = await db.invoicePayment.findMany({
    where: { receiptNumber: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, createdAt: true },
  })
  let done = 0
  for (const r of rows) {
    await db.$transaction(async (tx) => {
      await lockSequence(tx, 'code:RCT')
      const fresh = await tx.invoicePayment.findUnique({ where: { id: r.id }, select: { receiptNumber: true } })
      if (!fresh || fresh.receiptNumber) return
      let number = await derivedReceiptNumber(tx, r)
      if (await tx.invoicePayment.findUnique({ where: { receiptNumber: number }, select: { id: true } })) {
        number = await nextReceiptNumber(tx)
      }
      await tx.invoicePayment.update({ where: { id: r.id }, data: { receiptNumber: number } })
      done++
    })
  }
  return done
}

export function paymentToApi(p: {
  id: string; invoiceId: string; clientId: string; amountPaise: number; paidOn: string; mode: string
  reference: string | null; note: string | null; createdAt: Date; createdBy: string | null
  tdsPaise?: number; tdsSection?: string | null; tdsCertificateReceived?: boolean; externalPaymentId?: string | null
}) {
  return {
    id: p.id,
    invoice_id: p.invoiceId,
    client_id: p.clientId,
    amount_paise: p.amountPaise,
    tds_paise: p.tdsPaise ?? 0,
    tds_section: p.tdsSection ?? null,
    tds_certificate_received: p.tdsCertificateReceived ?? false,
    /** Cash + TDS — what this row settles on the invoice. */
    settled_paise: p.amountPaise + (p.tdsPaise ?? 0),
    external_payment_id: p.externalPaymentId ?? null,
    paid_on: p.paidOn,
    mode: p.mode,
    reference: p.reference,
    note: p.note,
    created_at: p.createdAt.toISOString(),
    created_by: p.createdBy,
  }
}

/**
 * The money behind an invoice, from the LIVE rows (never the stored columns):
 * cash received, TDS deducted, issued credit notes and refunds paid back.
 *
 *   settled     = cash + TDS + issued credits − refunds
 *   balance due = max(0, total − settled)
 *   refund due  = max(0, settled − total)
 *
 * A credit note may go up to the invoice total (less earlier credits) even
 * after the invoice is paid, so settled can pass the total: the excess is
 * money the firm owes back to the client until a refund is recorded.
 * `excludeCreditNoteId` leaves one credit note out (the one being issued).
 */
export async function liveSettlement(tx: Tx | PrismaClient, invoiceId: string, excludeCreditNoteId?: string) {
  const [inv, agg, credits, refunds] = await Promise.all([
    tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { totalPaise: true } }),
    tx.invoicePayment.aggregate({
      where: { invoiceId, deletedAt: null }, _sum: { amountPaise: true, tdsPaise: true }, _max: { paidOn: true },
    }),
    tx.creditNote.aggregate({
      where: { invoiceId, deletedAt: null, status: 'issued', ...(excludeCreditNoteId ? { id: { not: excludeCreditNoteId } } : {}) },
      _sum: { totalPaise: true },
    }),
    tx.invoiceRefund.aggregate({ where: { invoiceId, deletedAt: null }, _sum: { amountPaise: true } }),
  ])
  const paid = agg._sum.amountPaise ?? 0
  const tds = agg._sum.tdsPaise ?? 0
  const credited = credits._sum.totalPaise ?? 0
  const refunded = refunds._sum.amountPaise ?? 0
  const settled = paid + tds + credited - refunded
  return {
    totalPaise: inv.totalPaise, paid, tds, credited, refunded, settled,
    lastPaidOn: agg._max.paidOn ?? null,
    balanceDue: Math.max(0, inv.totalPaise - settled),
    refundDue: Math.max(0, settled - inv.totalPaise),
  }
}

/**
 * Paid / TDS / credited / refunded / balance / status from the live rows.
 *
 * An invoice is SETTLED by cash received (amountPaise), tax the client
 * deducted at source (tdsPaise — the client pays it to the government on our
 * behalf and we claim it via 26AS) and credit notes issued against it, less
 * any refund paid back. amountPaidPaise stays CASH ONLY — backfillInvoicePayments
 * compares it with the sum of amountPaise at every boot, and folding TDS in
 * would make it invent a phantom history row on each restart.
 *
 * Exported and tx-aware so credit notes, refunds and the Zoho posting
 * recompute inside their own transaction.
 */
export async function recomputeInvoice(tx: Tx, invoiceId: string, userId: string | null) {
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
  const m = await liveSettlement(tx, invoiceId)
  const state = paymentState(inv.totalPaise, m.settled)
  // A cancelled invoice keeps its status; everything else follows the money.
  const status = inv.status === 'cancelled' ? 'cancelled'
    : state === 'paid' ? 'paid'
    : m.settled > 0 ? 'partially_paid'
    : inv.status === 'draft' ? 'draft' : 'sent'
  // The paid date follows the MONEY RECEIVED: the latest payment (cash or
  // TDS) date. Credit notes and refunds never move it — a credit settles the
  // balance without anything being received, and a refund pays money back —
  // so an invoice cleared only by credits has no paid date.
  await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      amountPaidPaise: m.paid,
      tdsDeductedPaise: m.tds,
      creditedPaise: m.credited,
      refundedPaise: m.refunded,
      balanceDuePaise: m.balanceDue,
      status,
      paidAt: state === 'paid' && m.lastPaidOn ? new Date(`${m.lastPaidOn}T00:00:00Z`) : null,
      ...(userId ? { updatedBy: userId } : {}),
    },
  })
}

/**
 * What is still owed on an invoice, from the LIVE rows rather than the stored
 * balanceDuePaise: total − (cash + TDS + issued credits − refunds). Payments
 * settle against this figure, so a payment can never take the invoice past
 * zero (money owed back is a refund, not a negative balance).
 */
export async function liveBalanceDue(tx: Tx | PrismaClient, invoiceId: string, excludeCreditNoteId?: string): Promise<number> {
  return (await liveSettlement(tx, invoiceId, excludeCreditNoteId)).balanceDue
}

/**
 * Removing a payment or cancelling a credit note must not leave refunds
 * larger than what the client ever settled — the refund would then have paid
 * back money that was never received. Call inside the transaction, after the
 * change and before recomputeInvoice.
 */
export async function assertRefundsCovered(tx: Tx, invoiceId: string) {
  const m = await liveSettlement(tx, invoiceId)
  if (m.settled < 0) {
    throw ApiError.conflict(
      'refunds_exceed_settlement',
      `Refunds of ${formatINR(m.refunded)} have been recorded against this invoice. Delete the refund first.`,
    )
  }
}

/**
 * Record one payment (or one instalment of a split). Draft and cancelled
 * invoices take no payments; overpayment is refused — money owed back to the
 * client comes from a credit note and leaves through a refund.
 */
export async function addPayment(invoiceId: string, input: PaymentInput, userId: string) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } })
  if (!inv || inv.deletedAt) throw ApiError.notFound('Invoice not found.')
  if (inv.status === 'draft') {
    throw ApiError.conflict('invoice_not_sent', 'Send the invoice before recording a payment against it.')
  }
  if (inv.status === 'cancelled') throw ApiError.conflict('invoice_cancelled', 'This invoice has been cancelled.')
  const tds = input.tdsPaise ?? 0
  if (input.amountPaise < 0 || tds < 0 || input.amountPaise + tds <= 0) throw ApiError.badRequest('A payment must be more than zero.')
  return prisma.$transaction(async (tx) => {
    // Re-read the balance under a per-invoice lock: two payments recorded at
    // once must not both pass the balance check.
    await lockSequence(tx, `invoice:${invoiceId}`)
    const balance = await liveBalanceDue(tx, invoiceId)
    if (input.amountPaise + tds > balance) {
      throw ApiError.badRequest(
        `That is more than the balance due. At most ${(balance / 100).toFixed(2)} (amount + TDS) can be recorded.`,
      )
    }
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
        tdsPaise: tds,
        tdsSection: tds > 0 ? (input.tdsSection ?? '194J') : null,
        tdsCertificateReceived: tds > 0 ? Boolean(input.tdsCertificateReceived) : false,
        externalPaymentId: input.externalPaymentId ?? null,
        // Taken last, under its own lock, after the invoice lock above.
        receiptNumber: await nextReceiptNumber(tx),
        createdBy: userId,
        updatedBy: userId,
      },
    })
    await recomputeInvoice(tx, invoiceId, userId)
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
    await lockSequence(tx, `invoice:${invoiceId}`)
    // externalPaymentId is released so the same collection can be linked again.
    await tx.invoicePayment.update({ where: { id: row.id }, data: { deletedAt: new Date(), externalPaymentId: null, updatedBy: userId } })
    await assertRefundsCovered(tx, invoiceId)
    await recomputeInvoice(tx, invoiceId, userId)
  })
  return row
}

export async function listPayments(invoiceId: string) {
  const rows = await prisma.invoicePayment.findMany({
    where: { invoiceId, deletedAt: null }, orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }],
  })
  return Promise.all(rows.map(async (r) => ({ ...paymentToApi(r), receipt_number: await receiptNumberFor(r) })))
}

/**
 * Form 16A arrives quarterly, long after the payment — so whether the TDS
 * certificate is in hand is updated on its own.
 */
export async function setTdsCertificate(invoiceId: string, paymentId: string, received: boolean, userId: string) {
  const row = await prisma.invoicePayment.findFirst({ where: { id: paymentId, invoiceId, deletedAt: null } })
  if (!row) throw ApiError.notFound('Payment not found.')
  if (row.tdsPaise <= 0) throw ApiError.badRequest('No TDS was recorded on this payment.')
  return prisma.invoicePayment.update({ where: { id: row.id }, data: { tdsCertificateReceived: received, updatedBy: userId } })
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
    await db.$transaction(async (tx) => {
      await tx.invoicePayment.create({
        data: {
          organisationId: inv.organisationId,
          invoiceId: inv.id,
          clientId: inv.clientId,
          amountPaise: missing,
          paidOn: inv.paidAt ? inv.paidAt.toISOString().slice(0, 10) : inv.invoiceDate,
          mode: 'other',
          note: 'Recorded before payment history was kept',
          receiptNumber: await nextReceiptNumber(tx),
        },
      })
    })
    created++
  }
  return created
}
