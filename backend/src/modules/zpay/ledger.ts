/**
 * ONE RECEIVABLES LEDGER — a Zoho Payments collection that is matched to one
 * of OUR invoices becomes an InvoicePayment on it, so the invoice, the
 * payment summary and the ageing all see the money without anyone typing it
 * in again.
 *
 * Which app invoice: an explicit link (the queue's "Link to invoice"), else
 * the payment's matchedInvoiceRef when it IS an app invoice number, else an
 * `INV-000123` found in the payment's reference / description. (The exact
 * matcher matches the Zoho ACCOUNT's own series prefix, which need not be
 * ours, so the app number is resolved separately.)
 *
 * NEVER TWICE: the row carries externalPaymentId = ZpayPayment.id, which is
 * @unique. A re-sync, a second click or a concurrent post all hit the same
 * key; the loser's insert fails and is reported as "already posted".
 * Unmatching soft-deletes the posted row, recomputes the invoice and RELEASES
 * the key, so the collection can be linked again.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { istDateOf } from '../../lib/dates.js'
import { lockSequence } from '../../lib/sequence.js'
import { recomputeInvoice } from '../invoice/payments.js'
import { nextReceiptNumber } from '../../platform/workstation/codes.js'
import { isCollected } from './statuses.js'

const APP_INVOICE_RE = /\bINV-\d{6}\b/i

export interface PostOutcome {
  posted: boolean
  invoiceId: string | null
  invoiceNumber: string | null
  reason: string | null
}

const MODE: Record<string, string> = { upi: 'upi', card: 'card', net_banking: 'bank_transfer', netbanking: 'bank_transfer', bank_transfer: 'bank_transfer' }

/** Find the app invoice a collection pays, by explicit id, matched ref or reference text. */
async function resolveInvoice(p: { matchedInvoiceRef: string | null; referenceNumber: string | null; description: string | null }, explicitInvoiceId?: string) {
  if (explicitInvoiceId) return prisma.invoice.findFirst({ where: { id: explicitInvoiceId, deletedAt: null } })
  const candidates = [
    p.matchedInvoiceRef?.trim() || null,
    p.referenceNumber?.match(APP_INVOICE_RE)?.[0] ?? null,
    p.description?.match(APP_INVOICE_RE)?.[0] ?? null,
  ].filter((x): x is string => Boolean(x))
  for (const ref of candidates) {
    const inv = await prisma.invoice.findFirst({ where: { invoiceNumber: { equals: ref, mode: 'insensitive' }, deletedAt: null } })
    if (inv) return inv
  }
  return null
}

/**
 * Post one collected Zoho payment to the app invoice it pays. Never throws
 * for business reasons — the sync must keep going — it returns why not.
 */
export async function postCollectionToInvoice(zpayPaymentId: string, opts: { invoiceId?: string; actorUserId?: string | null } = {}): Promise<PostOutcome> {
  const p = await prisma.zpayPayment.findUnique({ where: { id: zpayPaymentId } })
  if (!p) return { posted: false, invoiceId: null, invoiceNumber: null, reason: 'No such payment.' }
  if (!isCollected(p.status)) return { posted: false, invoiceId: null, invoiceNumber: null, reason: `The payment is "${p.status}" — no money was received.` }
  if (p.matchType === 'unmatched' || p.matchType === 'probable') {
    if (!opts.invoiceId) return { posted: false, invoiceId: null, invoiceNumber: null, reason: 'The payment is not matched yet.' }
  }

  const already = await prisma.invoicePayment.findUnique({ where: { externalPaymentId: p.id }, include: { invoice: { select: { invoiceNumber: true } } } })
  if (already && !already.deletedAt) {
    return { posted: false, invoiceId: already.invoiceId, invoiceNumber: already.invoice.invoiceNumber, reason: 'Already posted.' }
  }

  const inv = await resolveInvoice(p, opts.invoiceId)
  if (!inv) return { posted: false, invoiceId: null, invoiceNumber: null, reason: 'No app invoice matches this payment.' }
  if (inv.status === 'draft' || inv.status === 'cancelled') {
    return { posted: false, invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, reason: `Invoice ${inv.invoiceNumber ?? 'draft'} is ${inv.status}.` }
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await lockSequence(tx, `invoice:${inv.id}`)
      // Automatic posting only: the same money may already have been typed
      // in by hand (same amount, same day, no external id). Skip rather than
      // count it twice — an explicit "Link to invoice" is the operator's call.
      if (!opts.invoiceId) {
        const manual = await tx.invoicePayment.findFirst({
          where: { invoiceId: inv.id, deletedAt: null, externalPaymentId: null, amountPaise: p.amountPaise, paidOn: istDateOf(p.paidAt) },
          select: { id: true },
        })
        if (manual) {
          return { posted: false, invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, reason: 'A payment of the same amount on the same day is already recorded by hand. Link it explicitly if it is a separate payment.' }
        }
      }
      const fresh = await tx.invoice.findUniqueOrThrow({ where: { id: inv.id }, select: { balanceDuePaise: true } })
      if (p.amountPaise > fresh.balanceDuePaise) {
        return { posted: false, invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, reason: `The payment is more than the invoice's balance due (${(fresh.balanceDuePaise / 100).toFixed(2)}). Record it by hand.` }
      }
      await tx.invoicePayment.create({
        data: {
          organisationId: inv.organisationId,
          invoiceId: inv.id,
          clientId: inv.clientId,
          amountPaise: p.amountPaise,
          paidOn: istDateOf(p.paidAt),
          mode: MODE[(p.paymentMode ?? '').toLowerCase()] ?? 'other',
          reference: (p.referenceNumber ?? p.zohoPaymentId).slice(0, 120),
          note: 'Collected via Zoho Payments',
          externalPaymentId: p.id,
          receiptNumber: await nextReceiptNumber(tx),
          createdBy: opts.actorUserId ?? null,
          updatedBy: opts.actorUserId ?? null,
        },
      })
      await recomputeInvoice(tx, inv.id, opts.actorUserId ?? null)
      return { posted: true, invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, reason: null }
    })
  } catch (e) {
    // Caught OUTSIDE the transaction: a unique violation aborts it in Postgres.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { posted: false, invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, reason: 'Already posted.' }
    }
    throw e
  }
}

/** Undo a posting (on unmatch): soft-delete, recompute, release the key. */
export async function unpostCollection(zpayPaymentId: string, actorUserId: string | null): Promise<boolean> {
  const row = await prisma.invoicePayment.findUnique({ where: { externalPaymentId: zpayPaymentId } })
  if (!row || row.deletedAt) return false
  await prisma.$transaction(async (tx) => {
    await lockSequence(tx, `invoice:${row.invoiceId}`)
    await tx.invoicePayment.update({ where: { id: row.id }, data: { deletedAt: new Date(), externalPaymentId: null, updatedBy: actorUserId } })
    await recomputeInvoice(tx, row.invoiceId, actorUserId)
  })
  return true
}

/** Best-effort wrapper for the sync path: log and carry on. */
export async function tryPostCollection(zpayPaymentId: string): Promise<void> {
  try {
    const r = await postCollectionToInvoice(zpayPaymentId)
    if (r.posted) console.log(`[zpay] collection posted to ${r.invoiceNumber}`)
  } catch (e) {
    console.warn('[zpay] posting failed', zpayPaymentId, e instanceof Error ? e.message : e)
  }
}

/** Posted invoice per payment id, for the matching queue. */
export async function postedInvoices(zpayPaymentIds: string[]): Promise<Map<string, { id: string; number: string | null }>> {
  if (zpayPaymentIds.length === 0) return new Map()
  const rows = await prisma.invoicePayment.findMany({
    where: { externalPaymentId: { in: zpayPaymentIds }, deletedAt: null },
    select: { externalPaymentId: true, invoiceId: true, invoice: { select: { invoiceNumber: true } } },
  })
  return new Map(rows.map((r) => [r.externalPaymentId!, { id: r.invoiceId, number: r.invoice.invoiceNumber }]))
}

/**
 * When the account's series matcher found nothing but the payment names one
 * of OUR invoice numbers, match it to that invoice (exact) — only an
 * unmatched row, never over a human decision. Returns true when it matched.
 */
export async function autoMatchAppInvoice(zpayPaymentId: string): Promise<boolean> {
  const p = await prisma.zpayPayment.findUnique({ where: { id: zpayPaymentId } })
  if (!p || p.matchType !== 'unmatched' || !isCollected(p.status)) return false
  const ref = p.referenceNumber?.match(APP_INVOICE_RE)?.[0] ?? p.description?.match(APP_INVOICE_RE)?.[0]
  if (!ref) return false
  const inv = await prisma.invoice.findFirst({ where: { invoiceNumber: { equals: ref, mode: 'insensitive' }, deletedAt: null }, select: { invoiceNumber: true, clientId: true } })
  if (!inv?.invoiceNumber) return false
  const r = await prisma.zpayPayment.updateMany({
    where: { id: p.id, matchType: 'unmatched' },
    data: { matchType: 'exact', matchedInvoiceRef: inv.invoiceNumber, matchedClientId: inv.clientId },
  })
  return r.count > 0
}
