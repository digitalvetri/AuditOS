/**
 * Invoice payment links through the firm's Razorpay / Cashfree account, and
 * recording the money they collect on the invoice.
 *
 * RECORDING (webhook and "Check status" share applyGatewayPayment):
 *   one transaction, under the invoice lock addPayment / cancel / credit
 *   notes take —
 *     1. already handled? (the link's recordedPaymentIds, then the payment
 *        row's externalPaymentId `${gateway}:${key}`) → nothing to do;
 *     2. record min(amount, live balance due) through addPaymentLocked — the
 *        same core as the manual "Record payment";
 *     3. anything above the balance (or all of it, for a cancelled invoice)
 *        is NOT recorded: it is added to the link's excessPaise and audited,
 *        for the firm to refund or account for by hand;
 *     4. the key joins recordedPaymentIds, so a replay — even after someone
 *        removes the recorded row — never records it again.
 *   A unique violation on externalPaymentId (two deliveries racing) is
 *   caught outside the transaction and reported as a duplicate.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { env } from '../../lib/env.js'
import { ApiError } from '../../lib/http.js'
import { formatINR } from '../../lib/money.js'
import { lockSequence } from '../../lib/sequence.js'
import { writeAudit } from '../../platform/audit.js'
import { decryptPortalSecret } from '../../platform/portalCrypto.js'
import { addPaymentLocked, liveBalanceDue, notifyPaymentRecorded } from '../invoice/payments.js'
import { billingContactOf, CLIENT_WITH_ORGANIZATION } from '../invoice/party.js'
import {
  GATEWAY_INFO, GatewayError, cancelPaymentLink, createPaymentLink, fetchPaymentLink,
  type Gateway, type GatewayCreds, type GatewayMode, type GatewayPayment, type LinkStatus,
} from './gateways.js'

export const secretContext = (gateway: Gateway) => `payment_gateway.${gateway}.secret`
export const webhookSecretContext = (gateway: Gateway) => `payment_gateway.${gateway}.webhookSecret`

export function webhookUrl(gateway: Gateway): string {
  return `${env.publicAppUrl ?? ''}/api/payments/webhooks/${gateway}`
}

type ConfigRow = Prisma.PaymentGatewayConfigGetPayload<object>

export function credsOf(row: ConfigRow): GatewayCreds {
  const gateway = row.gateway as Gateway
  const secret = decryptPortalSecret(row.secretCiphertext, secretContext(gateway))
  if (!secret) throw new ApiError(500, 'gateway_secret_unreadable', `The saved ${GATEWAY_INFO[gateway].label} secret could not be decrypted. Save the keys again.`)
  return { gateway, mode: row.mode as GatewayMode, keyId: row.keyId, secret }
}

/** The config a link is created with: the named gateway, else the firm's default. */
async function configFor(organisationId: string, gateway?: Gateway): Promise<ConfigRow> {
  const row = gateway
    ? await prisma.paymentGatewayConfig.findFirst({ where: { organisationId, gateway, active: true } })
    : await prisma.paymentGatewayConfig.findFirst({ where: { organisationId, active: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] })
  if (!row) {
    throw ApiError.badRequest(gateway
      ? `${GATEWAY_INFO[gateway].label} is not set up. Add its keys under Integrations → Payment gateways.`
      : 'No payment gateway is set up. Add Razorpay or Cashfree keys under Integrations → Payment gateways.')
  }
  return row
}

export function linkToApi(l: Prisma.InvoicePaymentLinkGetPayload<object>) {
  return {
    id: l.id,
    invoice_id: l.invoiceId,
    gateway: l.gateway,
    gateway_label: GATEWAY_INFO[l.gateway as Gateway]?.label ?? l.gateway,
    gateway_link_id: l.gatewayLinkId,
    url: l.url,
    amount_paise: l.amountPaise,
    status: l.status,
    paid_paise: l.paidPaise,
    excess_paise: l.excessPaise,
    payments_recorded: l.recordedPaymentIds.length,
    last_checked_at: l.lastCheckedAt?.toISOString() ?? null,
    created_at: l.createdAt.toISOString(),
  }
}

/** Links on one invoice, newest first, and what the "Payment link" button can offer. */
export async function listInvoiceLinks(invoiceId: string, organisationId: string) {
  const [links, configs] = await Promise.all([
    prisma.invoicePaymentLink.findMany({ where: { invoiceId }, orderBy: { createdAt: 'desc' } }),
    prisma.paymentGatewayConfig.findMany({ where: { organisationId, active: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }),
  ])
  return {
    items: links.map(linkToApi),
    gateways: configs.map((c) => ({ gateway: c.gateway, label: GATEWAY_INFO[c.gateway as Gateway]?.label ?? c.gateway, mode: c.mode, is_default: c.isDefault })),
    default_gateway: configs[0]?.gateway ?? null,
  }
}

const REUSE_WITHIN_MS = 20 * 24 * 3600 * 1000

/**
 * A link for the invoice's balance due. An open link at the same gateway for
 * exactly that amount (made in the last 20 days) is returned instead of a
 * new one, so pressing the button twice does not create two payable links.
 */
export async function createInvoiceLink(invoiceId: string, opts: { gateway?: Gateway; userId: string }) {
  const inv = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { client: CLIENT_WITH_ORGANIZATION },
  })
  if (!inv || inv.deletedAt) throw ApiError.notFound('No such invoice.')
  if (inv.status === 'draft' || !inv.invoiceNumber) throw ApiError.conflict('invoice_not_sent', 'Send the invoice before creating a payment link.')
  if (inv.status === 'cancelled') throw ApiError.conflict('invoice_cancelled', 'This invoice has been cancelled.')
  const balance = await liveBalanceDue(prisma, invoiceId)
  if (balance <= 0) throw ApiError.conflict('invoice_settled', 'Nothing is due on this invoice.')
  if (balance < 100) throw ApiError.conflict('balance_too_small', 'The balance due is under ₹1 — too small for a payment link.')

  const config = await configFor(inv.organisationId, opts.gateway)
  const org = await prisma.organisation.findUnique({ where: { id: inv.organisationId }, select: { name: true } })
  const gateway = config.gateway as Gateway

  const open = await prisma.invoicePaymentLink.findFirst({
    where: { invoiceId, gateway, status: 'created', amountPaise: balance, createdAt: { gte: new Date(Date.now() - REUSE_WITHIN_MS) } },
    orderBy: { createdAt: 'desc' },
  })
  if (open) return { link: linkToApi(open), reused: true }

  // A client under an organization is billed in the organization's name, so
  // the link goes to the organization's contact (the client's only if it has none).
  const contact = billingContactOf(inv.client)
  const phone = contact.contactNumber?.trim() || null
  if (gateway === 'cashfree' && !phone) {
    throw ApiError.badRequest('Cashfree needs the client\'s phone number. Add one to the client and try again.')
  }
  const notifyUrl = gateway === 'cashfree' && env.publicAppUrl?.startsWith('https://') ? webhookUrl('cashfree') : null
  let created: Awaited<ReturnType<typeof createPaymentLink>>
  try {
    created = await createPaymentLink(credsOf(config), {
      invoiceNumber: inv.invoiceNumber,
      amountPaise: balance,
      description: `Invoice ${inv.invoiceNumber}${org?.name ? ` — ${org.name}` : ''}`,
      customer: { name: inv.billingName?.trim() || contact.name, email: contact.email?.trim() || null, phone },
      notifyUrl,
    })
  } catch (e) {
    if (e instanceof GatewayError) {
      throw new ApiError(502, 'gateway_error', `${GATEWAY_INFO[gateway].label} could not create the link: ${e.message}`)
    }
    throw e
  }
  const row = await prisma.invoicePaymentLink.create({
    data: {
      organisationId: inv.organisationId, invoiceId, gateway, gatewayLinkId: created.gatewayLinkId,
      url: created.url, amountPaise: balance, status: created.status, createdBy: opts.userId,
    },
  })
  await writeAudit({
    actorUserId: opts.userId, action: 'invoice_payment_link.created', entityType: 'Invoice', entityId: invoiceId,
    after: { gateway, gateway_link_id: created.gatewayLinkId, amount_paise: balance },
  })
  return { link: linkToApi(row), reused: false }
}

export type ApplyResult = 'recorded' | 'duplicate' | 'flagged'

/** Record one gateway payment on the link's invoice — see the header for the rules. */
export async function applyGatewayPayment(linkId: string, p: GatewayPayment, source: 'webhook' | 'check', actorUserId: string | null): Promise<ApplyResult> {
  const link0 = await prisma.invoicePaymentLink.findUniqueOrThrow({ where: { id: linkId } })
  const gateway = link0.gateway as Gateway
  const label = GATEWAY_INFO[gateway]?.label ?? gateway
  const externalId = `${gateway}:${p.paymentKey}`
  let outcome: { result: ApplyResult; recorded: number; excess: number }
  try {
    outcome = await prisma.$transaction(async (tx) => {
      await lockSequence(tx, `invoice:${link0.invoiceId}`)
      const link = await tx.invoicePaymentLink.findUniqueOrThrow({ where: { id: linkId } })
      if (link.recordedPaymentIds.includes(p.paymentKey)) return { result: 'duplicate' as const, recorded: 0, excess: 0 }
      const existing = await tx.invoicePayment.findUnique({ where: { externalPaymentId: externalId }, select: { id: true } })
      if (existing) {
        await tx.invoicePaymentLink.update({ where: { id: linkId }, data: { recordedPaymentIds: { push: p.paymentKey } } })
        return { result: 'duplicate' as const, recorded: 0, excess: 0 }
      }
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: link.invoiceId }, select: { status: true, deletedAt: true } })
      const open = !inv.deletedAt && inv.status !== 'cancelled' && inv.status !== 'draft'
      const recordable = open ? Math.min(p.amountPaise, await liveBalanceDue(tx, link.invoiceId)) : 0
      const excess = p.amountPaise - recordable
      if (recordable > 0) {
        await addPaymentLocked(tx, link.invoiceId, {
          amountPaise: recordable,
          paidOn: p.paidOn,
          mode: p.mode,
          reference: p.reference.slice(0, 120),
          note: excess > 0
            ? `Paid via ${label} payment link. ${formatINR(excess)} above the balance due was not recorded.`
            : `Paid via ${label} payment link`,
          externalPaymentId: externalId,
        }, actorUserId)
      }
      await tx.invoicePaymentLink.update({
        where: { id: linkId },
        data: { recordedPaymentIds: { push: p.paymentKey }, paidPaise: { increment: recordable }, excessPaise: { increment: excess } },
      })
      return { result: recordable > 0 ? ('recorded' as const) : ('flagged' as const), recorded: recordable, excess }
    })
  } catch (e) {
    // Outside the transaction: a unique violation aborts it in Postgres.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return 'duplicate'
    throw e
  }
  if (outcome.recorded > 0) {
    await writeAudit({
      actorUserId, action: 'invoice_payment.recorded', entityType: 'Invoice', entityId: link0.invoiceId,
      after: { amount_paise: outcome.recorded, gateway, gateway_payment_id: p.paymentKey, reference: p.reference, paid_on: p.paidOn, mode: p.mode, via: source },
    })
    await notifyPaymentRecorded(link0.invoiceId, outcome.recorded, { employeeId: null, userId: actorUserId })
  }
  // The link that paid is closed by the gateway itself; any other open one is cancelled.
  if (outcome.recorded > 0) await closeStaleInvoiceLinks(link0.invoiceId, actorUserId, linkId)
  if (outcome.excess > 0) {
    console.warn(`[payment-links] ${label} payment ${p.paymentKey}: ${outcome.excess} paise not recorded on invoice ${link0.invoiceId} (above the balance due or invoice closed)`)
    await writeAudit({
      actorUserId, action: 'invoice_payment_link.excess', entityType: 'Invoice', entityId: link0.invoiceId,
      after: { gateway, gateway_payment_id: p.paymentKey, paid_paise: p.amountPaise, recorded_paise: outcome.recorded, excess_paise: outcome.excess, via: source },
    })
  }
  return outcome.result
}

const STATUS_RANK: Record<string, number> = { created: 0, partially_paid: 1, paid: 2 }

/**
 * Move the link to the gateway's status. Webhooks may arrive out of order,
 * so a paid link never goes back to partly paid / created (expired and
 * cancelled always apply).
 */
export async function setLinkStatus(linkId: string, status: LinkStatus | null, checked = false) {
  if (!status && !checked) return
  let next: LinkStatus | null = status
  if (status && status in STATUS_RANK) {
    const cur = await prisma.invoicePaymentLink.findUnique({ where: { id: linkId }, select: { status: true } })
    if (cur && cur.status in STATUS_RANK && STATUS_RANK[cur.status] > STATUS_RANK[status]) next = null
  }
  if (!next && !checked) return
  await prisma.invoicePaymentLink.update({
    where: { id: linkId },
    data: { ...(next ? { status: next } : {}), ...(checked ? { lastCheckedAt: new Date() } : {}) },
  })
}

/** "Check status": fetch the link from the gateway and record any new payments. */
export async function checkInvoiceLink(invoiceId: string, linkId: string, userId: string) {
  const link = await prisma.invoicePaymentLink.findFirst({ where: { id: linkId, invoiceId } })
  if (!link) throw ApiError.notFound('No such payment link.')
  const gateway = link.gateway as Gateway
  const config = await prisma.paymentGatewayConfig.findFirst({ where: { organisationId: link.organisationId, gateway } })
  if (!config) throw ApiError.badRequest(`${GATEWAY_INFO[gateway].label} keys have been removed — add them again to check this link.`)
  let snap: Awaited<ReturnType<typeof fetchPaymentLink>>
  try {
    snap = await fetchPaymentLink(credsOf(config), link.gatewayLinkId)
  } catch (e) {
    if (e instanceof GatewayError) throw new ApiError(502, 'gateway_error', `${GATEWAY_INFO[gateway].label} could not be reached: ${e.message}`)
    throw e
  }
  let recorded = 0
  for (const p of snap.payments) {
    if ((await applyGatewayPayment(link.id, p, 'check', userId)) === 'recorded') recorded++
  }
  await setLinkStatus(link.id, snap.status, true)
  return { link: linkToApi(await prisma.invoicePaymentLink.findUniqueOrThrow({ where: { id: link.id } })), recorded }
}

/**
 * Once an invoice is paid, cancelled or fully credited, its still-open links
 * are cancelled at the gateway so the client cannot pay a stale link (the
 * excess would only be "flagged"). Best-effort and after the invoice change
 * has committed: a gateway outage never blocks the payment, cancel or credit
 * — the link stays "created" here and the failure is logged and audited.
 */
export async function closeStaleInvoiceLinks(invoiceId: string, actorUserId: string | null, exceptLinkId?: string): Promise<{ cancelled: number; failed: number }> {
  const result = { cancelled: 0, failed: 0 }
  try {
    const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { status: true, deletedAt: true } })
    if (!inv) return result
    const closed = Boolean(inv.deletedAt) || inv.status === 'cancelled' || (await liveBalanceDue(prisma, invoiceId)) <= 0
    if (!closed) return result
    const open = await prisma.invoicePaymentLink.findMany({ where: { invoiceId, status: { in: ['created', 'partially_paid'] }, ...(exceptLinkId ? { id: { not: exceptLinkId } } : {}) } })
    for (const link of open) {
      const gateway = link.gateway as Gateway
      const config = await prisma.paymentGatewayConfig.findFirst({ where: { organisationId: link.organisationId, gateway } })
      try {
        if (!config) throw new GatewayError(gateway, 0, 'gateway keys removed')
        await cancelPaymentLink(credsOf(config), link.gatewayLinkId)
        await prisma.invoicePaymentLink.update({ where: { id: link.id }, data: { status: 'cancelled' } })
        await writeAudit({
          actorUserId, action: 'invoice_payment_link.cancelled', entityType: 'Invoice', entityId: invoiceId,
          after: { gateway, gateway_link_id: link.gatewayLinkId, why: inv.status === 'cancelled' ? 'invoice_cancelled' : 'nothing_due' },
        })
        result.cancelled++
      } catch (e) {
        result.failed++
        console.warn(`[payment-links] could not cancel ${gateway} link ${link.gatewayLinkId} on invoice ${invoiceId}:`, e instanceof Error ? e.message : e)
        await writeAudit({
          actorUserId, action: 'invoice_payment_link.cancel_failed', entityType: 'Invoice', entityId: invoiceId,
          after: { gateway, gateway_link_id: link.gatewayLinkId, error: e instanceof Error ? e.message.slice(0, 200) : String(e) },
        }).catch(() => undefined)
      }
    }
  } catch (e) {
    console.warn('[payment-links] closing stale links failed for invoice', invoiceId, e instanceof Error ? e.message : e)
  }
  return result
}
