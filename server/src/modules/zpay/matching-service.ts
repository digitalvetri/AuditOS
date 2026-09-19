/**
 * Matching-service — actions on a payment's match state that need more
 * than a pure classify() call (audit fields, cross-table lookups, safety
 * checks). The queue UI calls these.
 *
 *   manuallyMatch    unmatched | exact → manual (invoice ref + optional
 *                    client). Records confirmedBy / confirmedAt so the
 *                    audit trail shows who made the call.
 *
 *   unmatch          any matched state → unmatched. Clears the invoice
 *                    ref and client. Spec §4.2: "Unmatching is permitted
 *                    and recomputes immediately" — the next sync (or the
 *                    matcher, if invoked) will re-run classify.
 */
import { ApiError } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'

export interface ManuallyMatchInput {
  paymentId: string
  organisationId: string
  actorUserId: string
  invoiceRef: string
  clientId?: string | null
}

export async function manuallyMatch(input: ManuallyMatchInput): Promise<void> {
  const payment = await prisma.zpayPayment.findFirst({
    where: {
      id: input.paymentId,
      account: { connection: { organisationId: input.organisationId, deletedAt: null } },
    },
    select: { id: true },
  })
  if (!payment) throw ApiError.notFound('No such payment.')

  const ref = input.invoiceRef.trim()
  if (!ref) throw ApiError.badRequest('invoiceRef is required.')

  if (input.clientId) {
    const client = await prisma.client.findFirst({
      where: {
        id: input.clientId,
        organisationId: input.organisationId,
        deletedAt: null,
      },
      select: { id: true },
    })
    if (!client) throw ApiError.badRequest('clientId does not belong to this organisation.')
  }

  await prisma.zpayPayment.update({
    where: { id: payment.id },
    data: {
      matchType: 'manual',
      matchedInvoiceRef: ref,
      matchedClientId: input.clientId ?? null,
      matchConfirmedBy: input.actorUserId,
      matchConfirmedAt: new Date(),
    },
  })
}

export interface UnmatchInput {
  paymentId: string
  organisationId: string
  actorUserId: string
}

export async function unmatch(input: UnmatchInput): Promise<void> {
  const payment = await prisma.zpayPayment.findFirst({
    where: {
      id: input.paymentId,
      account: { connection: { organisationId: input.organisationId, deletedAt: null } },
    },
    select: { id: true, matchType: true },
  })
  if (!payment) throw ApiError.notFound('No such payment.')

  if (payment.matchType === 'unmatched') {
    // Idempotent — a double click on Unmatch should not throw.
    return
  }

  await prisma.zpayPayment.update({
    where: { id: payment.id },
    data: {
      matchType: 'unmatched',
      matchedInvoiceRef: null,
      matchedClientId: null,
      matchConfirmedBy: input.actorUserId, // record who unmatched, for audit
      matchConfirmedAt: new Date(),
    },
  })
}
