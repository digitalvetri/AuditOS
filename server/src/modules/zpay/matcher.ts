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
 * of two digits keeps trivial fragments like `INV/2026/1` from matching,
 * since a real invoice number has at least a 4-digit sequence.
 *
 * Never returns `matchType: 'probable'` — probable-tier matching needs
 * an external invoice source (spec §4.2) and lands whenever the invoice
 * import mechanism does.
 *
 * NEVER call this on a payment whose match_type is `manual` — the
 * matcher must not overwrite a human decision. `applyMatcherToPayment`
 * enforces that; direct callers do the same check.
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
