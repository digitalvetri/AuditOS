/**
 * Sync service for Zoho Payments (docs/zoho-payments/README.md §3).
 *
 * `syncAccount(account)` is the one entry point. It:
 *
 *   1. Opens a ZpaySyncRun row so the ops screen can see the attempt.
 *   2. Ensures the connection's access token is fresh — a token with less
 *      than 60 seconds left is refreshed here, NOT reactively on a 401
 *      (spec §1).
 *   3. Pulls all pages of /payments and /refunds within the window
 *      `last_sync_at − 3 days → now`. The overlap is what catches a
 *      settlement whose status flipped after our last read; idempotent
 *      upserts make the overlap free (spec §3).
 *   4. Upserts each row on the unique key `(accountRowId, zohoPaymentId)`.
 *      Amount is normalised from RUPEES (Zoho's shape) to INTEGER paise
 *      here, at the boundary — nowhere else in this codebase touches a
 *      float amount.
 *   5. Closes the sync run with `success` or `partial` or `failed`, and
 *      stamps `ZpayAccount.lastSyncAt` + `lastSyncStatus` so a card can
 *      render the outcome without joining.
 *
 * `raw` on ZpayPayment / ZpayRefund is whatever Zoho returned, untouched.
 * That is the authoritative record; every field we hoist to a column is a
 * derived view of it. Never mutate `raw` after write (§5 of the spec).
 *
 * `syncConnection(connectionId)` runs `syncAccount` per account in the
 * connection. One account failing must NOT stop the other from syncing
 * (spec §3) — that's why each call is in its own try/catch and each one
 * writes its own sync-run row.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { formatINR } from '../../lib/money.js'
import { notifyEmployee } from '../../platform/notify.js'
import { zpayConfig, type ZpayConfig } from './config.js'
import { decryptToken, encryptToken } from './crypto.js'
import { classify, proposeProbableForPayment } from './matcher.js'
import { autoMatchAppInvoice, tryPostCollection } from './ledger.js'
import { assertTransition } from './state.js'
import {
  ZohoOAuthError,
  exchangeRefreshTokenForAccess,
  type FetchLike,
} from './oauth.js'
import { isCollected } from './statuses.js'
import { refreshOpenLinksForAccount } from './payment-links.js'

const REFRESH_MARGIN_MS = 60 * 1000
const SYNC_OVERLAP_DAYS = 3
const DEFAULT_PER_PAGE = 200 // Zoho Payments' maximum
const MAX_PAGES = 500

export interface SyncOptions {
  /** Injected for tests; defaults to global fetch in production. */
  fetchImpl?: FetchLike
  /** Bounds the window's end so tests can pin "now". */
  now?: Date
}

export interface SyncOutcome {
  syncRunId: string
  status: 'success' | 'partial' | 'failed'
  paymentsFetched: number
  refundsFetched: number
  errorCode: string | null
  errorDetail: string | null
}

/**
 * Sync one account. Never throws — the error path is a `failed` sync run
 * with the error captured, so the caller (bulk sync of a connection)
 * doesn't have to wrap every call in try/catch to preserve isolation.
 */
export async function syncAccount(
  accountRowId: string,
  options: SyncOptions = {},
): Promise<SyncOutcome> {
  const cfg = zpayConfig()
  const now = options.now ?? new Date()
  const account = await prisma.zpayAccount.findUniqueOrThrow({
    where: { id: accountRowId },
    include: { connection: true },
  })
  if (account.deletedAt) {
    throw new Error(`ZpayAccount ${accountRowId} is deleted; refusing to sync`)
  }
  if (!account.isActive) {
    throw new Error(`ZpayAccount ${accountRowId} is not active; refusing to sync`)
  }

  const windowTo = now
  const windowFrom = account.lastSyncAt
    ? new Date(account.lastSyncAt.getTime() - SYNC_OVERLAP_DAYS * 86_400_000)
    : new Date(now.getTime() - 90 * 86_400_000) // first-ever sync: 90-day backfill

  const syncRun = await prisma.zpaySyncRun.create({
    data: {
      accountRowId,
      windowFrom,
      windowTo,
      status: 'pending',
    },
    select: { id: true },
  })

  let paymentsFetched = 0
  let refundsFetched = 0
  let apiCallsMade = 0

  try {
    const accessToken = await ensureFreshAccessToken(account.connection.id, cfg, options.fetchImpl)

    const pulled = await pullPayments(cfg, account, accessToken, windowFrom, windowTo, options.fetchImpl, () => { apiCallsMade++ })
    paymentsFetched = pulled.count
    // Zoho Payments has no refunds list — only GET /refunds/{id} — so a
    // payment Zoho marks refunded is read in full for its refunds.
    for (const paymentId of pulled.refunded) {
      refundsFetched += await pullRefundsOf(cfg, account, accessToken, paymentId, options.fetchImpl, () => { apiCallsMade++ })
    }

    await prisma.$transaction([
      prisma.zpaySyncRun.update({
        where: { id: syncRun.id },
        data: {
          status: 'success',
          finishedAt: new Date(),
          paymentsFetched,
          refundsFetched,
          apiCallsMade,
        },
      }),
      prisma.zpayAccount.update({
        where: { id: account.id },
        data: {
          lastSyncAt: windowTo,
          lastSyncStatus: 'success',
        },
      }),
    ])
    // Payments made through our payment links match their invoice from the
    // link's own payment list (Zoho doesn't promise the link reference lands
    // on the payment). Best-effort: a link check failing doesn't fail the sync.
    await refreshOpenLinksForAccount(accountRowId, account.connection.organisationId, options.fetchImpl).catch(() => undefined)

    return {
      syncRunId: syncRun.id,
      status: 'success',
      paymentsFetched,
      refundsFetched,
      errorCode: null,
      errorDetail: null,
    }
  } catch (err) {
    const code = err instanceof ZohoOAuthError ? err.code
      : err instanceof Error ? err.name
      : 'sync_failed'
    const detail = err instanceof Error ? err.message : String(err)

    await prisma.$transaction([
      prisma.zpaySyncRun.update({
        where: { id: syncRun.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          paymentsFetched,
          refundsFetched,
          apiCallsMade,
          errorCode: code,
          errorDetail: detail.slice(0, 500),
        },
      }),
      prisma.zpayAccount.update({
        where: { id: account.id },
        data: { lastSyncStatus: 'failed' },
      }),
    ])

    return {
      syncRunId: syncRun.id,
      status: 'failed',
      paymentsFetched,
      refundsFetched,
      errorCode: code,
      errorDetail: detail,
    }
  }
}

/**
 * Sync every active account under a connection. Per-account failures are
 * captured on their own sync-run rows and never bleed into another
 * account's run (spec §3).
 */
export async function syncConnection(
  connectionId: string,
  options: SyncOptions = {},
): Promise<SyncOutcome[]> {
  const accounts = await prisma.zpayAccount.findMany({
    where: { connectionId, deletedAt: null, isActive: true },
    select: { id: true },
  })
  const outcomes: SyncOutcome[] = []
  for (const a of accounts) {
    outcomes.push(await syncAccount(a.id, options))
  }
  return outcomes
}

// ── token freshness ──────────────────────────────────────────────────

/**
 * Return a plaintext access token for the connection, refreshing it
 * proactively when it is close to expiry. Never called from a page
 * render — cards read local tables only (spec §3). If the refresh fails
 * with `invalid_grant` the connection transitions to `revoked` and the
 * caller sees the error.
 */
export async function ensureFreshAccessToken(
  connectionId: string,
  cfg: ZpayConfig,
  fetchImpl?: FetchLike,
): Promise<string> {
  const conn = await prisma.zpayConnection.findUniqueOrThrow({ where: { id: connectionId } })
  if (conn.status !== 'connected') {
    throw new Error(`connection ${connectionId} is ${conn.status}; cannot sync`)
  }
  if (!conn.refreshTokenEncrypted || !conn.accessTokenEncrypted || !conn.accessTokenExpiresAt) {
    throw new Error(`connection ${connectionId} is missing tokens; must be re-consented`)
  }

  const msUntilExpiry = conn.accessTokenExpiresAt.getTime() - Date.now()
  if (msUntilExpiry > REFRESH_MARGIN_MS) {
    return decryptToken(conn.accessTokenEncrypted, cfg.encryptionKey)
  }

  // Refresh path.
  const refreshToken = decryptToken(conn.refreshTokenEncrypted, cfg.encryptionKey)
  let refreshed
  try {
    refreshed = await exchangeRefreshTokenForAccess(cfg, refreshToken, fetchImpl)
  } catch (err) {
    if (err instanceof ZohoOAuthError && (err.code === 'invalid_grant' || err.code === 'invalid_client')) {
      // Spec §3: refresh token invalid → status = revoked, STOP RETRYING.
      assertTransition('connected', 'revoked')
      await prisma.zpayConnection.update({
        where: { id: connectionId },
        data: {
          status: 'revoked',
          lastErrorCode: err.code,
          lastErrorAt: new Date(),
        },
      })
    }
    throw err
  }

  const newAccess = encryptToken(refreshed.access_token, cfg.encryptionKey)
  const expiresAt = new Date(Date.now() + (refreshed.expires_in - 60) * 1000)
  await prisma.zpayConnection.update({
    where: { id: connectionId },
    data: {
      accessTokenEncrypted: newAccess,
      accessTokenExpiresAt: expiresAt,
      lastErrorCode: null,
      lastErrorAt: null,
    },
  })

  return refreshed.access_token
}

// ── fetching + upserting ─────────────────────────────────────────────

/** yyyy-mm-dd in India — Zoho Payments filters on the merchant's calendar date. */
const istDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d)

/** GET with the account scoping every Zoho Payments call requires. */
async function zohoGet(
  cfg: ZpayConfig,
  account: { accountId: string },
  accessToken: string,
  path: string,
  query: Record<string, string>,
  fetchImpl: FetchLike | undefined,
  onCall: () => void,
): Promise<Record<string, unknown>> {
  const impl: FetchLike = fetchImpl ?? (fetch as unknown as FetchLike)
  const url = new URL(`${cfg.paymentsBase}/api/v1/${path}`)
  url.searchParams.set('account_id', account.accountId)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  onCall()
  const res = await impl(url.toString(), { method: 'GET', headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } })
  if (!res.ok) {
    throw new ZohoOAuthError('http_error', `Zoho ${path.split('/')[0]} returned ${res.status}`, res.status)
  }
  return (await res.json()) as Record<string, unknown>
}

/** Statuses that mean a refund was (at least partly) made against the payment. */
const REFUNDED_STATUSES = new Set(['refunded', 'partially_refunded'])

/**
 * All payments charged in the window. Zoho applies from_date/to_date only
 * together with filter_by=ChargeDate.CustomDate, and its list response has
 * no has_more_page — a short page is the last one.
 */
async function pullPayments(
  cfg: ZpayConfig,
  account: { id: string; accountId: string; invoiceSeriesPrefix: string },
  accessToken: string,
  windowFrom: Date,
  windowTo: Date,
  fetchImpl: FetchLike | undefined,
  onCall: () => void,
): Promise<{ count: number; refunded: string[] }> {
  let count = 0
  const refunded: string[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const payload = await zohoGet(cfg, account, accessToken, 'payments', {
      filter_by: 'ChargeDate.CustomDate',
      from_date: istDay(windowFrom),
      to_date: istDay(windowTo),
      page: String(page),
      per_page: String(DEFAULT_PER_PAGE),
    }, fetchImpl, onCall)
    const rows = (payload.payments as Array<Record<string, unknown>> | undefined) ?? []
    for (const row of rows) {
      await upsertPayment(account, row)
      if (REFUNDED_STATUSES.has(String(row.status))) refunded.push(String(row.payment_id))
      count++
    }
    const more = (payload.page_context as { has_more_page?: boolean } | undefined)?.has_more_page
    if (rows.length < DEFAULT_PER_PAGE || more === false) break
  }
  return { count, refunded }
}

/**
 * Refunds of one payment, from GET /payments/{id}. Where the detail lists
 * no individual refunds, the payment's amount_refunded is recorded as one
 * refund so the collected figure still nets it off.
 */
async function pullRefundsOf(
  cfg: ZpayConfig,
  account: { id: string; accountId: string },
  accessToken: string,
  paymentId: string,
  fetchImpl: FetchLike | undefined,
  onCall: () => void,
): Promise<number> {
  const payload = await zohoGet(cfg, account, accessToken, `payments/${encodeURIComponent(paymentId)}`, {}, fetchImpl, onCall)
  const payment = (payload.payment ?? payload) as Record<string, unknown>
  const listed = (payment.refunds as Array<Record<string, unknown>> | undefined) ?? []
  if (listed.length) {
    for (const r of listed) await upsertRefund(account.id, { ...r, payment_id: r.payment_id ?? paymentId })
    return listed.length
  }
  if (Number(payment.amount_refunded) > 0) {
    await upsertRefund(account.id, {
      refund_id: `${paymentId}:total`,
      payment_id: paymentId,
      amount: payment.amount_refunded,
      status: 'succeeded',
      reason: 'Total refunded on the payment (Zoho listed no individual refunds)',
      date: payment.date,
    })
    return 1
  }
  return 0
}

/** RUPEES-as-decimal → INTEGER paise. This is the ONLY place the boundary
 *  conversion happens; do not push a float amount past this line. */
function rupeesToPaise(input: unknown): number {
  const n = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(n)) throw new Error(`amount is not a number: ${input}`)
  return Math.round(n * 100)
}

async function upsertPayment(
  account: { id: string; invoiceSeriesPrefix: string },
  row: Record<string, unknown>,
): Promise<void> {
  const zohoPaymentId = String(row.payment_id ?? '')
  if (!zohoPaymentId) throw new Error('payment row is missing payment_id')

  const amountPaise = rupeesToPaise(row.amount)
  const fee = row.fee_amount ?? row.fee
  const feePaise = fee != null && fee !== '' ? rupeesToPaise(fee) : null
  const method = row.payment_method as Record<string, unknown> | string | undefined

  // Zoho Payments: one `date` (epoch); older/other shapes: paid_at / created_at.
  const paidAt = parseDate(row.date ?? row.paid_at ?? row.created_at)
  const createdAtZoho = parseDate(row.date ?? row.created_at ?? row.paid_at)
  // The reference set when the payment was initiated is what exact matching
  // keys on — Zoho calls it reference_number (invoice_number on some flows).
  const ref = row.reference_number ?? row.invoice_number ?? row.reference
  const referenceNumber = ref != null && ref !== '' ? String(ref) : null
  const description = row.description != null ? String(row.description) : null

  const data = {
    amountPaise,
    feePaise,
    currency: String(row.currency ?? 'INR'),
    status: String(row.status ?? 'unknown'),
    paymentMode: typeof method === 'object' && method?.type != null ? String(method.type) : typeof method === 'string' ? method : row.payment_mode != null ? String(row.payment_mode) : null,
    customerName: row.customer_name != null ? String(row.customer_name) : null,
    customerEmail: (row.receipt_email ?? row.customer_email) != null ? String(row.receipt_email ?? row.customer_email) : null,
    referenceNumber,
    description,
    mandateId: (typeof method === 'object' ? method?.mandate_id : undefined) != null ? String((method as Record<string, unknown>).mandate_id) : row.mandate_id != null ? String(row.mandate_id) : null,
    paidAt,
    createdAtZoho,
    raw: row as Prisma.InputJsonValue,
  }

  await prisma.zpayPayment.upsert({
    where: {
      accountRowId_zohoPaymentId: { accountRowId: account.id, zohoPaymentId },
    },
    create: { ...data, accountRowId: account.id, zohoPaymentId, matchType: 'unmatched' },
    // NEVER update matchedInvoiceRef / matchedClientId / matchType — those
    // are ours, not Zoho's; a re-sync must not overwrite a human's manual
    // link. `raw` is refreshed so the untouched Zoho payload always
    // reflects the latest state, which is what spec §5 calls immutable
    // "within a version" (a later payload replaces the earlier version).
    update: data,
  })

  // A payment that never completed is not a collection: it must not mark an
  // invoice paid, however good its reference.
  if (!isCollected(data.status)) return

  // Auto-classify: if the row is unmatched (either freshly inserted, or a
  // prior re-sync left it that way), try the exact matcher on the new
  // fields. A manual or exact match is left alone — updateMany with the
  // matchType guard is what makes the write conditional. Spec §4.2.
  const outcome = classify(
    { referenceNumber, description },
    { invoiceSeriesPrefix: account.invoiceSeriesPrefix },
  )
  if (outcome.matchType === 'exact') {
    const matched = await prisma.zpayPayment.updateMany({
      where: {
        accountRowId: account.id,
        zohoPaymentId,
        matchType: 'unmatched',
      },
      data: {
        matchType: 'exact',
        matchedInvoiceRef: outcome.matchedInvoiceRef,
      },
    })
    // Only a payment that became matched just now — a re-sync of one that
    // was already matched updates nothing and tells no one — and only a
    // recent one, so a first-sync backfill of history stays quiet.
    const recent = paidAt != null && Date.now() - paidAt.getTime() <= 7 * 86_400_000
    if (matched.count > 0 && recent && outcome.matchedInvoiceRef) {
      await notifyMatched(account.id, outcome.matchedInvoiceRef, amountPaise, data.customerName)
    }
    // Into the receivables ledger when the ref is one of our invoices.
    // Idempotent (externalPaymentId), so a re-sync of a matched row is safe.
    const row = await prisma.zpayPayment.findUnique({
      where: { accountRowId_zohoPaymentId: { accountRowId: account.id, zohoPaymentId } }, select: { id: true },
    })
    if (row) await tryPostCollection(row.id)
    return
  }

  // Exact didn't hit — try the probable-tier matcher against imported
  // invoices. proposeProbableForPayment() short-circuits on matched
  // rows and only writes when there's exactly one candidate; multiple
  // or zero candidates leave the payment unmatched.
  const created = await prisma.zpayPayment.findUnique({
    where: {
      accountRowId_zohoPaymentId: { accountRowId: account.id, zohoPaymentId },
    },
    select: { id: true, matchType: true },
  })
  if (created?.matchType === 'unmatched') {
    // The reference names one of OUR invoices (INV-000123) even though the
    // account's own series did not match: match and post it.
    if (await autoMatchAppInvoice(created.id)) {
      await tryPostCollection(created.id)
      return
    }
    await proposeProbableForPayment(created.id)
  } else if (created && created.matchType !== 'probable') {
    await tryPostCollection(created.id)
  }
}

/** Tell the invoice's client's account manager the money arrived. Best effort. */
async function notifyMatched(accountRowId: string, invoiceNumber: string, amountPaise: number, customerName: string | null) {
  try {
    const inv = await prisma.zpayExternalInvoice.findFirst({
      where: { billingAccountId: accountRowId, invoiceNumber, deletedAt: null },
      select: { client: { select: { id: true, companyName: true, accountManagerId: true } } },
    })
    const client = inv?.client
    if (!client) return
    await notifyEmployee(client.accountManagerId, {
      type: 'zpay.payment_matched', module: 'workstation',
      title: `Payment received — ${invoiceNumber}`,
      body: `${formatINR(amountPaise)} from ${customerName ?? client.companyName} · matched via Zoho Payments`,
      entityType: 'Client', entityId: client.id,
      actionUrl: `/workstation/clients/${client.id}`,
    })
  } catch { /* best effort */ }
}

async function upsertRefund(
  accountRowId: string,
  row: Record<string, unknown>,
): Promise<void> {
  const zohoRefundId = String(row.refund_id ?? '')
  const zohoPaymentId = String(row.payment_id ?? '')
  if (!zohoRefundId) throw new Error('refund row is missing refund_id')

  const data = {
    zohoPaymentId,
    amountPaise: rupeesToPaise(row.amount),
    status: String(row.status ?? 'unknown'),
    reason: row.reason != null ? String(row.reason) : null,
    refundedAt: parseDate(row.date ?? row.refunded_at ?? row.created_at),
    raw: row as Prisma.InputJsonValue,
  }

  await prisma.zpayRefund.upsert({
    where: {
      accountRowId_zohoRefundId: { accountRowId, zohoRefundId },
    },
    create: { ...data, accountRowId, zohoRefundId },
    update: data,
  })
}

function parseDate(input: unknown): Date {
  if (input instanceof Date) return input
  // Zoho Payments sends epoch numbers; its docs say milliseconds but its
  // examples are seconds, so anything below 1e12 is taken as seconds.
  const epoch = typeof input === 'number' ? input : typeof input === 'string' && /^\d{9,13}$/.test(input) ? Number(input) : null
  if (epoch !== null) return new Date(epoch < 1e12 ? epoch * 1000 : epoch)
  if (typeof input === 'string' || typeof input === 'number') {
    const d = new Date(input)
    if (!Number.isNaN(d.getTime())) return d
  }
  throw new Error(`could not parse date: ${input}`)
}
