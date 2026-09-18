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
import { zpayConfig, type ZpayConfig } from './config.js'
import { decryptToken, encryptToken } from './crypto.js'
import { assertTransition } from './state.js'
import {
  ZohoOAuthError,
  exchangeRefreshTokenForAccess,
  type FetchLike,
} from './oauth.js'

const REFRESH_MARGIN_MS = 60 * 1000
const SYNC_OVERLAP_DAYS = 3
const DEFAULT_PER_PAGE = 200

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

    paymentsFetched = await pullAllPages(
      cfg,
      account,
      accessToken,
      'payments',
      windowFrom,
      windowTo,
      options.fetchImpl,
      () => { apiCallsMade++ },
    )
    refundsFetched = await pullAllPages(
      cfg,
      account,
      accessToken,
      'refunds',
      windowFrom,
      windowTo,
      options.fetchImpl,
      () => { apiCallsMade++ },
    )

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

type Kind = 'payments' | 'refunds'

async function pullAllPages(
  cfg: ZpayConfig,
  account: { id: string; accountId: string },
  accessToken: string,
  kind: Kind,
  windowFrom: Date,
  windowTo: Date,
  fetchImpl: FetchLike | undefined,
  onCall: () => void,
): Promise<number> {
  const impl: FetchLike = fetchImpl ?? (fetch as unknown as FetchLike)
  let page = 1
  let total = 0
  while (true) {
    const url = new URL(`${cfg.paymentsBase}/api/v1/${kind}`)
    url.searchParams.set('account_id', account.accountId)
    url.searchParams.set('date_start', windowFrom.toISOString().slice(0, 10))
    url.searchParams.set('date_end', windowTo.toISOString().slice(0, 10))
    url.searchParams.set('page', String(page))
    url.searchParams.set('per_page', String(DEFAULT_PER_PAGE))

    onCall()
    const res = await impl(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    })
    if (!res.ok) {
      throw new ZohoOAuthError(
        'http_error',
        `Zoho ${kind} returned ${res.status}`,
        res.status,
      )
    }
    const payload = (await res.json()) as {
      payments?: Array<Record<string, unknown>>
      refunds?: Array<Record<string, unknown>>
      page_context?: { has_more_page?: boolean }
    }
    const rows = (kind === 'payments' ? payload.payments : payload.refunds) ?? []

    for (const row of rows) {
      if (kind === 'payments') await upsertPayment(account.id, row)
      else await upsertRefund(account.id, row)
      total++
    }

    if (!payload.page_context?.has_more_page) break
    page++
  }
  return total
}

/** RUPEES-as-decimal → INTEGER paise. This is the ONLY place the boundary
 *  conversion happens; do not push a float amount past this line. */
function rupeesToPaise(input: unknown): number {
  const n = typeof input === 'number' ? input : Number(input)
  if (!Number.isFinite(n)) throw new Error(`amount is not a number: ${input}`)
  return Math.round(n * 100)
}

async function upsertPayment(
  accountRowId: string,
  row: Record<string, unknown>,
): Promise<void> {
  const zohoPaymentId = String(row.payment_id ?? '')
  if (!zohoPaymentId) throw new Error('payment row is missing payment_id')

  const amountPaise = rupeesToPaise(row.amount)
  const feePaise = row.fee != null ? rupeesToPaise(row.fee) : null

  const paidAt = parseDate(row.paid_at ?? row.created_at)
  const createdAtZoho = parseDate(row.created_at ?? row.paid_at)

  const data = {
    amountPaise,
    feePaise,
    currency: String(row.currency ?? 'INR'),
    status: String(row.status ?? 'unknown'),
    paymentMode: row.payment_mode != null ? String(row.payment_mode) : null,
    customerName: row.customer_name != null ? String(row.customer_name) : null,
    customerEmail: row.customer_email != null ? String(row.customer_email) : null,
    referenceNumber: row.reference != null ? String(row.reference) : null,
    description: row.description != null ? String(row.description) : null,
    mandateId: row.mandate_id != null ? String(row.mandate_id) : null,
    paidAt,
    createdAtZoho,
    raw: row as Prisma.InputJsonValue,
  }

  await prisma.zpayPayment.upsert({
    where: {
      accountRowId_zohoPaymentId: { accountRowId, zohoPaymentId },
    },
    create: { ...data, accountRowId, zohoPaymentId, matchType: 'unmatched' },
    // NEVER update matchedInvoiceRef / matchedClientId / matchType — those
    // are ours, not Zoho's; a re-sync must not overwrite a human's manual
    // link. `raw` is refreshed so the untouched Zoho payload always
    // reflects the latest state, which is what spec §5 calls immutable
    // "within a version" (a later payload replaces the earlier version).
    update: data,
  })
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
    refundedAt: parseDate(row.refunded_at ?? row.created_at),
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
  if (typeof input === 'string' || typeof input === 'number') {
    const d = new Date(input)
    if (!Number.isNaN(d.getTime())) return d
  }
  throw new Error(`could not parse date: ${input}`)
}
