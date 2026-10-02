/**
 * Shared shapes for the Tally Export feature — docs/tally-export/README.md.
 *
 * Kept in a leaf module so the frontend can re-declare matching types
 * without pulling in the Prisma client, and the service + routes both
 * import from one place.
 */

export type MatchType = 'contains' | 'regex' | 'exact'
export const MATCH_TYPES: readonly MatchType[] = ['contains', 'regex', 'exact']

export type VoucherType = 'payment' | 'receipt' | 'contra' | 'journal'
export const VOUCHER_TYPES: readonly VoucherType[] = ['payment', 'receipt', 'contra', 'journal']

/** Serialisable snapshot of a TallyLedgerRule row for the API. */
export interface RuleApi {
  id: string
  company_id: string | null
  match_type: MatchType
  pattern: string
  ledger_name: string
  voucher_type: VoucherType | null
  priority: number
  hit_count: number
  created_by: string | null
  created_at: string
  updated_at: string
}

/** Statement row enriched with resolved mapping — one per bank line. */
export interface PreviewRow {
  statement_line_id: string
  date: string
  description: string
  ref_number: string | null
  debit_paise: number
  credit_paise: number
  /** `withdrawal` when debit > 0, `deposit` when credit > 0. */
  direction: 'withdrawal' | 'deposit'

  /** Rule that matched, or null when the row is unmapped. */
  matched_rule_id: string | null
  /** The counter-ledger name to write into the voucher, per the matched rule. */
  ledger_name: string | null
  /** The voucher type after applying rule override + Contra detection. */
  voucher_type: VoucherType | null
  /** Deterministic voucher number computed from bank code + period + row order. */
  voucher_number: string
  /** True when this row's target ledger has never been used before for this client. */
  new_ledger: boolean
}

/** Preflight response shape — spec §4 / §6. */
export interface PreflightReport {
  company_id: string
  bank_ledger_id: string
  period_from: string
  period_to: string

  totals: {
    rows: number
    mapped: number
    unmapped: number
    contra: number
    vouchers: number
    balance_mismatches: number
  }

  /** Per-ledger summary. `new_ledger` flags ledgers not used before for this client. */
  ledgers: {
    ledger_name: string
    voucher_count: number
    new_ledger: boolean
  }[]

  /** Blocking errors — export must not run while any are present. */
  errors: {
    kind: 'unmapped_row' | 'balance_mismatch' | 'date_out_of_range' | 'voucher_number_collision'
    statement_line_id?: string
    voucher_number?: string
    message: string
  }[]

  /** Non-blocking callouts — new ledgers, previously-exported rows, etc. */
  warnings: {
    kind: 'new_ledger' | 'previously_exported'
    message: string
  }[]

  rows: PreviewRow[]
}
