/**
 * Exact-tier matcher for Zoho Payments (docs/zoho-payments/README.md §4.2).
 *
 * `classify(payment, account)` looks at `reference_number` and
 * `description` for a substring matching the account's invoice-series
 * prefix followed by a numeric tail — e.g. an account with prefix
 * `INV/2026/` will exact-match a reference of `INV/2026/0412` or a
 * description like `Payment for INV/2026/0412 — Sept fees`.
 *
 * The prefix is escaped so a `.` in the prefix is a literal, not a
 * regex any-char. The numeric tail is greedy but stops at the first
 * non-digit, so `INV/2026/0412-supplement` still yields `0412`. A minimum
 * of three digits keeps trivial fragments like `INV/2026/12` from
 * matching, since a real invoice number has at least a 3-4 digit
 * sequence.
 *
 * Probable-tier matching is separate — see proposeProbable() below,
 * which needs an external invoice table (populated by the CSV importer).
 *
 * NEVER call classify on a payment whose match_type is `manual` — the
 * matcher must not overwrite a human decision. The sync path is
 * conditional on match_type='unmatched' via updateMany.
 */

export interface MatcherPayment {
  referenceNumber: string | null
  description: string | null
}

export interface MatcherAccount {
  invoiceSeriesPrefix: string
}

export interface MatcherOutcome {
  matchType: 'exact' | 'unmatched'
  matchedInvoiceRef: string | null
}

/** Only lift a match if the tail has this many digits, so junk doesn't
 *  count. Real firm-standard series have at least 3-4 sequential digits. */
const MIN_TAIL_DIGITS = 3

export function classify(
  payment: MatcherPayment,
  account: MatcherAccount,
): MatcherOutcome {
  const prefix = account.invoiceSeriesPrefix.trim()
  if (!prefix) return unmatched()
  const pattern = new RegExp(escapeRegex(prefix) + '(\\d{' + MIN_TAIL_DIGITS + ',})', 'i')
  const fields = [payment.referenceNumber, payment.description]
  for (const field of fields) {
    if (!field) continue
    const hit = field.match(pattern)
    if (hit) {
      return {
        matchType: 'exact',
        matchedInvoiceRef: prefix + hit[1],
      }
    }
  }
  return unmatched()
}

function unmatched(): MatcherOutcome {
  return { matchType: 'unmatched', matchedInvoiceRef: null }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Probable-tier matcher (spec §4.2) ────────────────────────────────

import { prisma } from '../../lib/prisma.js'

/** ±15 days is the spec's default window. Kept configurable for tests. */
const PROBABLE_WINDOW_DAYS = 15

/**
 * Consider one payment for probable-tier auto-proposal.
 *
 * Rules (§4.2):
 *   • Only touches an `unmatched` payment (never overwrites manual/exact).
 *   • Looks in open invoices from the SAME billing account, whose
 *     amountPaise equals the payment's, within ±15 days of paidAt.
 *   • If there is exactly ONE candidate → mark match_type=probable
 *     with matchedInvoiceRef and matchedClientId (if the invoice
 *     carries one).
 *   • Zero candidates or multiple candidates → leave as unmatched.
 *     The spec is explicit that we NEVER auto-confirm a probable
 *     match; the queue's Confirm button is what promotes it to
 *     `manual`.
 */
export async function proposeProbableForPayment(paymentId: string): Promise<void> {
  const payment = await prisma.zpayPayment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      accountRowId: true,
      amountPaise: true,
      paidAt: true,
      matchType: true,
    },
  })
  if (!payment || payment.matchType !== 'unmatched') return

  const winStart = new Date(payment.paidAt.getTime() - PROBABLE_WINDOW_DAYS * 86_400_000)
  const winEnd = new Date(payment.paidAt.getTime() + PROBABLE_WINDOW_DAYS * 86_400_000)

  // issuedOn is stored as ISO YYYY-MM-DD strings so the range compare uses
  // string comparison, which is lexicographically equivalent to date
  // ordering for that format.
  const candidates = await prisma.zpayExternalInvoice.findMany({
    where: {
      billingAccountId: payment.accountRowId,
      status: 'open',
      amountPaise: payment.amountPaise,
      deletedAt: null,
      issuedOn: {
        gte: winStart.toISOString().slice(0, 10),
        lte: winEnd.toISOString().slice(0, 10),
      },
    },
    select: { id: true, invoiceNumber: true, clientId: true },
    take: 2, // we only care about "exactly one" — stop at 2
  })

  if (candidates.length !== 1) return
  const invoice = candidates[0]

  await prisma.zpayPayment.updateMany({
    where: { id: payment.id, matchType: 'unmatched' },
    data: {
      matchType: 'probable',
      matchedInvoiceRef: invoice.invoiceNumber,
      matchedClientId: invoice.clientId,
    },
  })
}

/**
 * Run the probable-tier matcher across every unmatched payment on an
 * account. Called after a sync (so a fresh CSV import + a subsequent
 * sync both trigger auto-proposals), and standalone when the operator
 * imports invoices and wants to re-classify existing payments without
 * a full sync.
 */
export async function runProbableForAccount(accountRowId: string): Promise<{ proposed: number }> {
  const targets = await prisma.zpayPayment.findMany({
    where: { accountRowId, matchType: 'unmatched' },
    select: { id: true },
    take: 5_000, // safety cap
  })
  let proposed = 0
  for (const t of targets) {
    const before = await prisma.zpayPayment.findUnique({ where: { id: t.id }, select: { matchType: true } })
    if (before?.matchType !== 'unmatched') continue
    await proposeProbableForPayment(t.id)
    const after = await prisma.zpayPayment.findUnique({ where: { id: t.id }, select: { matchType: true } })
    if (after?.matchType === 'probable') proposed++
  }
  return { proposed }
}
