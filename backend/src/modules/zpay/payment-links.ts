/**
 * The collect-payment step: a Zoho Payments payment link for an imported
 * invoice, sent to the client, and the payments made through it tied back
 * to that invoice.
 *
 * Zoho Payments (payment-links.yml):
 *   POST /api/v1/paymentlinks?account_id=…      scope ZohoPay.payments.CREATE
 *        { amount, currency, description, reference_id, email, phone,
 *          expires_at (yyyy-MM-dd), notify_customer: { email, sms } }
 *        → 201 { payment_links: { payment_link_id, url, status, amount, amount_paid, expires_at, … } }
 *   GET  /api/v1/paymentlinks/{id}?account_id=… scope ZohoPay.payments.READ
 *        → { payment_links: { …, payments: [{ payment_id, amount, status, date }] } }
 *
 * Zoho does not document that a link's reference_id is copied onto the
 * payment, so a link's payments are matched to the invoice from the link's
 * own payments list, not from the reference.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import { writeAudit } from '../../platform/audit.js'
import { zpayConfig } from './config.js'
import { ensureFreshAccessToken } from './sync.js'
import { collectedWhere } from './statuses.js'
import type { FetchLike } from './oauth.js'

const MATCHED = ['exact', 'manual'] as const

export interface CreateLinkInput {
  invoiceId: string
  organisationId: string
  userId: string
  email?: string | null
  phone?: string | null
  /** yyyy-mm-dd; Zoho's default is 30 days. */
  expiresAt?: string | null
  notify?: { email?: boolean; sms?: boolean }
  fetchImpl?: FetchLike
}

async function loadInvoice(invoiceId: string, organisationId: string) {
  const inv = await prisma.zpayExternalInvoice.findFirst({
    where: { id: invoiceId, organisationId, deletedAt: null },
    include: {
      billingAccount: { include: { connection: true } },
      client: { select: { companyName: true, email: true, contactNumber: true } },
    },
  })
  if (!inv) throw ApiError.notFound('No such invoice.')
  return inv
}

/** Collected (net of nothing) against this invoice so far, in paise. */
async function paidAgainst(accountRowId: string, invoiceNumber: string): Promise<number> {
  const agg = await prisma.zpayPayment.aggregate({
    where: { accountRowId, matchedInvoiceRef: invoiceNumber, matchType: { in: [...MATCHED] }, ...collectedWhere },
    _sum: { amountPaise: true },
  })
  return agg._sum.amountPaise ?? 0
}

/** Zoho's reference_id is alphanumeric, ≤100: keep letters, digits, - and _. */
const referenceFor = (invoiceNumber: string) => invoiceNumber.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100)

async function zoho(
  method: 'GET' | 'POST',
  path: string,
  account: { accountId: string; connectionId: string },
  body: unknown,
  fetchImpl?: FetchLike,
): Promise<Record<string, unknown>> {
  const cfg = zpayConfig()
  const token = await ensureFreshAccessToken(account.connectionId, cfg, fetchImpl)
  const url = new URL(`${cfg.paymentsBase}/api/v1/${path}`)
  url.searchParams.set('account_id', account.accountId)
  const impl: FetchLike = fetchImpl ?? (fetch as unknown as FetchLike)
  const res = await impl(url.toString(), {
    method,
    headers: { Authorization: `Zoho-oauthtoken ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  } as never)
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || (typeof payload.code === 'number' && payload.code !== 0)) {
    const msg = typeof payload.message === 'string' ? payload.message : `Zoho Payments returned ${res.status}`
    if (res.status === 401 || res.status === 403) {
      throw new ApiError(409, 'zpay_permission', `${msg} — reconnect this Zoho Payments account so it can create payment links.`)
    }
    throw new ApiError(502, 'zpay_rejected', `Zoho Payments: ${msg}`)
  }
  return payload
}

const rupees = (paise: number) => Math.round(paise) / 100
const toPaise = (v: unknown) => Math.round((Number(v) || 0) * 100)

/**
 * A payment link for what is still owed on the invoice. An active link for
 * the same amount is returned as-is, so asking again (or re-importing the
 * invoice) never raises a second link.
 */
export async function createPaymentLink(input: CreateLinkInput) {
  const inv = await loadInvoice(input.invoiceId, input.organisationId)
  const acc = inv.billingAccount
  if (acc.deletedAt || !acc.isActive) throw ApiError.badRequest('This Zoho Payments account is not active.')
  if (acc.connection.status !== 'connected') {
    throw new ApiError(409, 'zpay_not_connected', 'Connect this Zoho Payments account first (Integrations → Zoho Payments).')
  }
  const owed = inv.amountPaise - (await paidAgainst(acc.id, inv.invoiceNumber))
  if (owed <= 0) throw new ApiError(409, 'invoice_paid', `${inv.invoiceNumber} is already paid in full.`)

  const existing = await prisma.zpayPaymentLink.findFirst({
    where: { invoiceId: inv.id, status: { in: ['active', 'partially_paid'] }, amountPaise: owed },
    orderBy: { createdAt: 'desc' },
  })
  if (existing) return { link: existing, reused: true }

  const email = (input.email ?? inv.client?.email ?? '').trim() || undefined
  const phone = (input.phone ?? inv.client?.contactNumber ?? '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '') || undefined
  if (input.expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(input.expiresAt)) throw ApiError.badRequest('Expiry must be a date (yyyy-mm-dd).')
  const referenceId = referenceFor(inv.invoiceNumber)

  const payload = await zoho('POST', 'paymentlinks', { accountId: acc.accountId, connectionId: acc.connectionId }, {
    amount: rupees(owed),
    currency: 'INR',
    description: `Invoice ${inv.invoiceNumber}${inv.client?.companyName ? ` — ${inv.client.companyName}` : ''}`.slice(0, 500),
    reference_id: referenceId || undefined,
    email,
    phone,
    ...(phone ? { phone_country_code: 'IN' } : {}),
    ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
    notify_customer: { email: Boolean(input.notify?.email && email), sms: Boolean(input.notify?.sms && phone) },
  }, input.fetchImpl)

  const pl = (payload.payment_links ?? payload.payment_link) as Record<string, unknown> | undefined
  if (!pl?.payment_link_id || !pl.url) throw new ApiError(502, 'zpay_rejected', 'Zoho Payments did not return a payment link.')
  const link = await prisma.zpayPaymentLink.create({
    data: {
      accountRowId: acc.id,
      invoiceId: inv.id,
      zohoLinkId: String(pl.payment_link_id),
      url: String(pl.url),
      amountPaise: owed,
      amountPaidPaise: toPaise(pl.amount_paid),
      status: String(pl.status ?? 'active'),
      referenceId: referenceId || null,
      email: email ?? null,
      phone: phone ?? null,
      expiresAt: pl.expires_at != null ? String(pl.expires_at) : input.expiresAt ?? null,
      raw: pl as Prisma.InputJsonValue,
      createdBy: input.userId,
    },
  })
  await writeAudit({
    actorUserId: input.userId, action: 'zpay.payment_link.created', entityType: 'zpay.invoice', entityId: inv.id,
    after: { invoice: inv.invoiceNumber, amount_paise: owed, zoho_link_id: link.zohoLinkId },
  })
  return { link, reused: false }
}

/**
 * Re-read a link from Zoho: status, amount paid, and its payments. Payments
 * already synced are matched to the invoice (never overriding a human's
 * match); ones not synced yet are counted so the screen can say "Sync".
 */
export async function refreshPaymentLink(linkId: string, organisationId: string, fetchImpl?: FetchLike) {
  const link = await prisma.zpayPaymentLink.findFirst({
    where: { id: linkId, invoice: { organisationId } },
    include: { invoice: true, account: true },
  })
  if (!link) throw ApiError.notFound('No such payment link.')
  const payload = await zoho('GET', `paymentlinks/${encodeURIComponent(link.zohoLinkId)}`, { accountId: link.account.accountId, connectionId: link.account.connectionId }, null, fetchImpl)
  const pl = (payload.payment_links ?? payload.payment_link ?? {}) as Record<string, unknown>
  const payments = ((pl.payments as Array<Record<string, unknown>> | undefined) ?? [])
  let matched = 0
  let unsynced = 0
  for (const p of payments) {
    if (!['succeeded', 'refunded', 'partially_refunded'].includes(String(p.status))) continue
    const row = await prisma.zpayPayment.findUnique({
      where: { accountRowId_zohoPaymentId: { accountRowId: link.accountRowId, zohoPaymentId: String(p.payment_id) } },
      select: { id: true, matchType: true },
    })
    if (!row) { unsynced++; continue }
    if (row.matchType === 'unmatched' || row.matchType === 'probable') {
      await prisma.zpayPayment.update({
        where: { id: row.id },
        data: { matchType: 'exact', matchedInvoiceRef: link.invoice.invoiceNumber, matchedClientId: link.invoice.clientId },
      })
      matched++
    }
  }
  const updated = await prisma.zpayPaymentLink.update({
    where: { id: link.id },
    data: {
      status: pl.status != null ? String(pl.status) : link.status,
      amountPaidPaise: pl.amount_paid != null ? toPaise(pl.amount_paid) : link.amountPaidPaise,
      lastCheckedAt: new Date(),
      raw: pl as Prisma.InputJsonValue,
    },
  })
  return { link: updated, matched, unsynced }
}

/** Refresh every open link of an account — run after a sync so link payments match themselves. */
export async function refreshOpenLinksForAccount(accountRowId: string, organisationId: string, fetchImpl?: FetchLike): Promise<void> {
  const open = await prisma.zpayPaymentLink.findMany({ where: { accountRowId, status: { in: ['active', 'partially_paid'] } }, select: { id: true } })
  for (const l of open) await refreshPaymentLink(l.id, organisationId, fetchImpl).catch(() => undefined)
}

/** Where an invoice stands: owed, paid, its links and the payments matched to it. */
export async function invoicePaymentState(invoiceId: string, organisationId: string) {
  const inv = await loadInvoice(invoiceId, organisationId)
  const paid = await paidAgainst(inv.billingAccountId, inv.invoiceNumber)
  const links = await prisma.zpayPaymentLink.findMany({ where: { invoiceId: inv.id }, orderBy: { createdAt: 'desc' } })
  const payments = await prisma.zpayPayment.findMany({
    where: { accountRowId: inv.billingAccountId, matchedInvoiceRef: inv.invoiceNumber, matchType: { in: [...MATCHED] }, ...collectedWhere },
    select: { id: true, zohoPaymentId: true, amountPaise: true, paidAt: true, paymentMode: true, status: true },
    orderBy: { paidAt: 'desc' },
  })
  const owed = Math.max(0, inv.amountPaise - paid)
  return {
    invoice: {
      id: inv.id, invoice_number: inv.invoiceNumber, issued_on: inv.issuedOn, due_date: inv.dueDate,
      amount_paise: inv.amountPaise, client_name: inv.client?.companyName ?? null,
      client_email: inv.client?.email ?? null, client_phone: inv.client?.contactNumber ?? null,
    },
    paid_paise: paid,
    owed_paise: owed,
    state: owed === 0 ? 'paid' : paid > 0 ? 'part_paid' : 'unpaid',
    connected: inv.billingAccount.connection.status === 'connected',
    links: links.map((l) => ({
      id: l.id, url: l.url, status: l.status, amount_paise: l.amountPaise, amount_paid_paise: l.amountPaidPaise,
      expires_at: l.expiresAt, email: l.email, phone: l.phone, created_at: l.createdAt, last_checked_at: l.lastCheckedAt,
    })),
    payments: payments.map((p) => ({ id: p.id, zoho_payment_id: p.zohoPaymentId, amount_paise: p.amountPaise, paid_at: p.paidAt, mode: p.paymentMode, status: p.status })),
  }
}
