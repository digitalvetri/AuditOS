/**
 * Razorpay and Cashfree payment-link adapters. Pure HTTP + crypto: no
 * database. Every call goes through an injectable fetch so tests never touch
 * the network. Verified against the official docs on 2026-11-16:
 *
 * RAZORPAY (https://razorpay.com/docs/api/payments/payment-links/create-standard/,
 *   …/fetch-id-standard/, https://razorpay.com/docs/webhooks/validate-test/,
 *   https://razorpay.com/docs/webhooks/payloads/payment-links/)
 *   POST https://api.razorpay.com/v1/payment_links   Basic key_id:key_secret
 *        { amount (paise, min 100), currency, accept_partial, description,
 *          reference_id (≤40, unique per link), customer {name,email,contact 8–14},
 *          notify {sms,email}, notes } → { id: plink_…, short_url, status, … }
 *   GET  /v1/payment_links/:id → { status, amount_paid, payments: null |
 *          [{ payment_id, amount, method, status, created_at }] }
 *   Webhook: X-Razorpay-Signature = hex HMAC-SHA256(raw body, webhook secret).
 *          payment_link.paid / .partially_paid carry
 *          payload.payment_link.entity {id,status} and payload.payment.entity
 *          {id, amount, method, status 'captured', created_at}.
 *
 * CASHFREE (https://www.cashfree.com/docs/api-reference/payments/latest/payment-links/create,
 *   …/payment-links/fetch-payment-link-details, …/payment-links/get-orders-for-a-payment-link,
 *   …/payment-links/webhooks, https://www.cashfree.com/docs/payments/online/webhooks/signature-verification)
 *   Base: live https://api.cashfree.com/pg, test https://sandbox.cashfree.com/pg
 *   Headers x-client-id, x-client-secret, x-api-version (2026-01-01, the current one).
 *   POST /links { link_id (≤50, [A-Za-z0-9_-]), link_amount (RUPEES), link_currency,
 *          link_purpose (≤500), customer_details {customer_phone REQUIRED, …},
 *          link_partial_payments, link_notify, link_meta {notify_url (https)} }
 *          → { cf_link_id, link_id, link_status, link_url, … }
 *   GET  /links/{link_id} → { link_status ACTIVE|PAID|PARTIALLY_PAID|EXPIRED|CANCELLED, … }
 *   GET  /links/{link_id}/orders?status=PAID → [{ order_id, order_amount, order_status, created_at }]
 *   Webhook PAYMENT_LINK_EVENT: x-webhook-signature = base64 HMAC-SHA256(
 *          x-webhook-timestamp + raw body, secret key). data.link_id,
 *          data.link_status, data.order {order_id, order_amount "22.00",
 *          transaction_id, transaction_status 'SUCCESS'}.
 *
 * ONE KEY PER PAYMENT, BOTH PATHS: a Razorpay payment is keyed by its pay_…
 * id (webhook payment.entity.id = payments[].payment_id). A Cashfree payment
 * is keyed by its ORDER id: the orders API has no transaction id, and a PAID
 * order has exactly one successful transaction.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { istDateOf, istToday } from '../../lib/dates.js'
import type { PaymentMode } from '../invoice/payments.js'

export const GATEWAYS = ['razorpay', 'cashfree'] as const
export type Gateway = (typeof GATEWAYS)[number]
export const GATEWAY_MODES = ['live', 'test'] as const
export type GatewayMode = (typeof GATEWAY_MODES)[number]
export const isGateway = (v: unknown): v is Gateway => typeof v === 'string' && (GATEWAYS as readonly string[]).includes(v)

export const GATEWAY_INFO: Record<Gateway, { label: string; dashboardUrl: string; keyIdLabel: string }> = {
  razorpay: { label: 'Razorpay', dashboardUrl: 'https://dashboard.razorpay.com/app/website-app-settings/api-keys', keyIdLabel: 'Key ID' },
  cashfree: { label: 'Cashfree', dashboardUrl: 'https://merchant.cashfree.com/merchants/pg/developers/api-keys', keyIdLabel: 'App ID' },
}

export const CASHFREE_API_VERSION = '2026-01-01'
const RAZORPAY_BASE = 'https://api.razorpay.com/v1'
const cashfreeBase = (mode: GatewayMode) => (mode === 'test' ? 'https://sandbox.cashfree.com/pg' : 'https://api.cashfree.com/pg')

export type LinkStatus = 'created' | 'partially_paid' | 'paid' | 'expired' | 'cancelled'

export interface GatewayCreds {
  gateway: Gateway
  mode: GatewayMode
  keyId: string
  secret: string
}

/** One successful payment at the gateway, normalised. */
export interface GatewayPayment {
  /** Idempotency key: Razorpay pay_… id, Cashfree order_id. */
  paymentKey: string
  /** What goes in the payment row's reference (the gateway's payment id). */
  reference: string
  amountPaise: number
  paidOn: string
  mode: PaymentMode
}

export interface LinkSnapshot {
  status: LinkStatus | null
  payments: GatewayPayment[]
}

let fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a)
/** Tests swap the outbound fetch; pass null to restore the real one. */
export function __setGatewayFetchForTests(f: typeof fetch | null): void {
  fetchImpl = f ?? ((...a) => globalThis.fetch(...a))
}

/** A gateway answered with an error (or not at all). `status` is the HTTP status, 0 for a network failure. */
export class GatewayError extends Error {
  constructor(public gateway: Gateway, public status: number, message: string) {
    super(message)
  }
}

/** "22.00" / 22 / 1.1 → paise, exactly (no float multiply). null when not a non-negative amount. */
export function rupeesToPaise(v: unknown): number | null {
  const s = typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(2) : '') : typeof v === 'string' ? v.trim() : ''
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) return null
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
}
const paiseToRupees = (p: number) => Number((p / 100).toFixed(2))

/** A payment's date as the IST day, never in the future. */
function paidOnOf(input: Date | string | null | undefined): string {
  const today = istToday()
  if (!input) return today
  const d = typeof input === 'string' ? new Date(input) : input
  if (Number.isNaN(d.getTime())) return today
  const day = istDateOf(d)
  return day > today ? today : day
}

const METHOD_MODE: Record<string, PaymentMode> = { upi: 'upi', card: 'card', netbanking: 'bank_transfer', net_banking: 'bank_transfer', emandate: 'bank_transfer', nach: 'bank_transfer' }
const modeOf = (method: unknown): PaymentMode => METHOD_MODE[String(method ?? '').toLowerCase()] ?? 'other'

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function verifyRazorpaySignature(raw: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false
  return safeEqual(createHmac('sha256', secret).update(raw).digest('hex'), signature.trim())
}

/**
 * Cashfree: base64(HMAC-SHA256(timestamp + rawBody, secretKey)). The docs'
 * pseudocode shows "$timestamp.$payload" but their Node sample concatenates
 * with no separator — we follow the sample.
 */
export function verifyCashfreeSignature(raw: Buffer, signature: string | undefined, timestamp: string | undefined, secret: string): boolean {
  if (!signature || !timestamp || !secret) return false
  const mac = createHmac('sha256', secret).update(timestamp).update(raw).digest('base64')
  return safeEqual(mac, signature.trim())
}

async function call(gateway: Gateway, url: string, init: RequestInit): Promise<any> {
  let res: Response
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) })
  } catch (e) {
    throw new GatewayError(gateway, 0, e instanceof Error ? e.message : 'network error')
  }
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!res.ok) {
    const msg = body?.error?.description ?? body?.message ?? (typeof body === 'string' && body ? body.slice(0, 200) : `HTTP ${res.status}`)
    throw new GatewayError(gateway, res.status, String(msg))
  }
  return body
}

function razorpayHeaders(c: GatewayCreds) {
  return { Authorization: `Basic ${Buffer.from(`${c.keyId}:${c.secret}`).toString('base64')}`, 'Content-Type': 'application/json' }
}
function cashfreeHeaders(c: GatewayCreds) {
  return { 'x-client-id': c.keyId, 'x-client-secret': c.secret, 'x-api-version': CASHFREE_API_VERSION, 'Content-Type': 'application/json' }
}

export interface CreateLinkArgs {
  invoiceNumber: string
  amountPaise: number
  description: string
  customer: { name: string; email: string | null; phone: string | null }
  /** Cashfree per-link webhook URL (https only). */
  notifyUrl?: string | null
}

/** Our id for the link at the gateway: Razorpay reference_id (≤40) / Cashfree link_id (≤50, [A-Za-z0-9_-]). */
function merchantLinkId(gateway: Gateway, invoiceNumber: string): string {
  const inv = invoiceNumber.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)
  const rand = randomBytes(5).toString('hex')
  return gateway === 'razorpay' ? `${inv}-${rand}` : `AOS_${inv}_${rand}`
}

export async function createPaymentLink(c: GatewayCreds, a: CreateLinkArgs): Promise<{ gatewayLinkId: string; url: string; status: LinkStatus }> {
  const ref = merchantLinkId(c.gateway, a.invoiceNumber)
  if (c.gateway === 'razorpay') {
    const contact = a.customer.phone?.replace(/[\s-]/g, '') ?? ''
    const body = {
      amount: a.amountPaise,
      currency: 'INR',
      accept_partial: false,
      description: a.description.slice(0, 2048),
      reference_id: ref,
      customer: {
        name: a.customer.name,
        ...(a.customer.email ? { email: a.customer.email } : {}),
        // Razorpay wants 8–14 characters; drop rather than fail the link.
        ...(contact.length >= 8 && contact.length <= 14 ? { contact } : {}),
      },
      // The firm shares the link itself (copy / open), so Razorpay sends nothing.
      notify: { sms: false, email: false },
      notes: { invoice: a.invoiceNumber },
    }
    const r = await call('razorpay', `${RAZORPAY_BASE}/payment_links`, { method: 'POST', headers: razorpayHeaders(c), body: JSON.stringify(body) })
    if (!r?.id || !r?.short_url) throw new GatewayError('razorpay', 502, 'No link id in the response.')
    return { gatewayLinkId: String(r.id), url: String(r.short_url), status: razorpayStatus(r.status) ?? 'created' }
  }
  const body = {
    link_id: ref,
    link_amount: paiseToRupees(a.amountPaise),
    link_currency: 'INR',
    link_purpose: a.description.slice(0, 500),
    customer_details: {
      customer_phone: a.customer.phone,
      ...(a.customer.email ? { customer_email: a.customer.email } : {}),
      customer_name: a.customer.name,
    },
    link_partial_payments: false,
    link_notify: { send_sms: false, send_email: false },
    link_notes: { invoice: a.invoiceNumber },
    ...(a.notifyUrl ? { link_meta: { notify_url: a.notifyUrl } } : {}),
  }
  const r = await call('cashfree', `${cashfreeBase(c.mode)}/links`, { method: 'POST', headers: cashfreeHeaders(c), body: JSON.stringify(body) })
  if (!r?.link_url) throw new GatewayError('cashfree', 502, 'No link URL in the response.')
  return { gatewayLinkId: String(r.link_id ?? ref), url: String(r.link_url), status: cashfreeStatus(r.link_status) ?? 'created' }
}

function razorpayStatus(s: unknown): LinkStatus | null {
  return s === 'created' || s === 'partially_paid' || s === 'paid' || s === 'expired' || s === 'cancelled' ? s : null
}
function cashfreeStatus(s: unknown): LinkStatus | null {
  switch (String(s ?? '').toUpperCase()) {
    case 'ACTIVE': return 'created'
    case 'PARTIALLY_PAID': return 'partially_paid'
    case 'PAID': return 'paid'
    case 'EXPIRED': return 'expired'
    case 'CANCELLED': return 'cancelled'
    default: return null
  }
}

/** The link's status and every successful payment on it, from the gateway. */
export async function fetchPaymentLink(c: GatewayCreds, gatewayLinkId: string): Promise<LinkSnapshot> {
  const id = encodeURIComponent(gatewayLinkId)
  if (c.gateway === 'razorpay') {
    const r = await call('razorpay', `${RAZORPAY_BASE}/payment_links/${id}`, { method: 'GET', headers: razorpayHeaders(c) })
    const payments: GatewayPayment[] = []
    for (const p of Array.isArray(r?.payments) ? r.payments : []) {
      const amount = Number(p?.amount)
      if (p?.status !== 'captured' || !p?.payment_id || !Number.isInteger(amount) || amount <= 0) continue
      payments.push({
        paymentKey: String(p.payment_id), reference: String(p.payment_id), amountPaise: amount,
        paidOn: paidOnOf(typeof p.created_at === 'number' ? new Date(p.created_at * 1000) : null), mode: modeOf(p.method),
      })
    }
    return { status: razorpayStatus(r?.status), payments }
  }
  const base = cashfreeBase(c.mode)
  const link = await call('cashfree', `${base}/links/${id}`, { method: 'GET', headers: cashfreeHeaders(c) })
  const orders = await call('cashfree', `${base}/links/${id}/orders?status=PAID`, { method: 'GET', headers: cashfreeHeaders(c) })
  const payments: GatewayPayment[] = []
  for (const o of Array.isArray(orders) ? orders : []) {
    const amount = rupeesToPaise(o?.order_amount)
    if (String(o?.order_status ?? '').toUpperCase() !== 'PAID' || !o?.order_id || !amount) continue
    payments.push({
      paymentKey: String(o.order_id), reference: String(o.order_id), amountPaise: amount,
      // The orders API gives no payment time or method.
      paidOn: paidOnOf(o.created_at ?? null), mode: 'other',
    })
  }
  return { status: cashfreeStatus(link?.link_status), payments }
}

/**
 * Prove the keys with an authenticated read. Razorpay: list payment links.
 * Cashfree has no cheap list call, so fetch a link that cannot exist: 404
 * means the keys passed authentication, 401/403 means they did not.
 */
export async function testCredentials(c: GatewayCreds): Promise<void> {
  if (c.gateway === 'razorpay') {
    await call('razorpay', `${RAZORPAY_BASE}/payment_links`, { method: 'GET', headers: razorpayHeaders(c) })
    return
  }
  try {
    await call('cashfree', `${cashfreeBase(c.mode)}/links/auditos_keycheck_${randomBytes(6).toString('hex')}`, { method: 'GET', headers: cashfreeHeaders(c) })
  } catch (e) {
    if (e instanceof GatewayError && e.status === 404) return
    throw e
  }
}

/** What a webhook body says, before we know whose it is. */
export interface WebhookEvent {
  /** The gateway's link id we store (Razorpay plink_… / Cashfree link_id), if any. */
  linkId: string | null
  linkStatus: LinkStatus | null
  /** Set only for a successful payment we should record. */
  payment: GatewayPayment | null
  /** Short label for logs / the ignored response. */
  kind: string
}

export function parseRazorpayEvent(body: any): WebhookEvent {
  const event = String(body?.event ?? '')
  const link = body?.payload?.payment_link?.entity
  const linkId = link?.id ? String(link.id) : null
  if (!event.startsWith('payment_link.')) return { linkId, linkStatus: null, payment: null, kind: event || 'unknown' }
  const p = body?.payload?.payment?.entity
  let payment: GatewayPayment | null = null
  const amount = Number(p?.amount)
  if ((event === 'payment_link.paid' || event === 'payment_link.partially_paid') && p?.id && p?.status === 'captured' && Number.isInteger(amount) && amount > 0) {
    payment = {
      paymentKey: String(p.id), reference: String(p.id), amountPaise: amount,
      paidOn: paidOnOf(typeof p.created_at === 'number' ? new Date(p.created_at * 1000) : null), mode: modeOf(p.method),
    }
  }
  return { linkId, linkStatus: razorpayStatus(link?.status), payment, kind: event }
}

export function parseCashfreeEvent(body: any): WebhookEvent {
  const d = body?.data
  const linkId = d?.link_id ? String(d.link_id) : null
  const o = d?.order
  let payment: GatewayPayment | null = null
  const amount = rupeesToPaise(o?.order_amount)
  if (String(body?.type ?? '') === 'PAYMENT_LINK_EVENT' && o?.order_id && String(o?.transaction_status ?? '').toUpperCase() === 'SUCCESS' && amount) {
    payment = {
      paymentKey: String(o.order_id),
      reference: o.transaction_id != null ? String(o.transaction_id) : String(o.order_id),
      amountPaise: amount,
      paidOn: paidOnOf(body?.event_time ?? null),
      mode: 'other',
    }
  }
  return { linkId, linkStatus: cashfreeStatus(d?.link_status), payment, kind: String(body?.type ?? 'unknown') }
}
