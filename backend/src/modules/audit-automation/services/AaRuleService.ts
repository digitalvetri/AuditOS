import { prisma } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'

/**
 * Narration → Tally ledger rules for bank transactions.
 *
 * A client's own rules are tried before firm-wide ones (clientId null),
 * each group in priority order (lower first). Matching is
 * case-insensitive: `contains` (the everyday case — "AIRTEL" → Telephone
 * Expenses), `exact`, or `regex`. A rule may be limited to withdrawals or
 * deposits and may fix the voucher type (e.g. Contra for cash).
 */

export type Direction = 'withdrawal' | 'deposit'
export interface RuleRow {
  id: string
  clientId: string | null
  matchType: string
  pattern: string
  direction: string
  ledgerName: string
  voucherType: string | null
  priority: number
}

export const VOUCHER_TYPES = ['payment', 'receipt', 'contra', 'journal'] as const

export function defaultVoucherType(direction: Direction): string {
  return direction === 'withdrawal' ? 'payment' : 'receipt'
}

/**
 * Contra-aware voucher classifier (REPOTIC-MODULE.md §1 / TALLY-EXPORT.md §4.1).
 *
 * A transfer between two of the client's OWN bank or cash accounts is
 * neither income nor expense; recording it as Payment/Receipt inflates
 * both sides of the P&L. If the counter-ledger looks like another of the
 * client's own bank/cash ledgers, pick Contra. Fall back to the
 * direction-based default otherwise.
 *
 * The caller resolves `ownBankCashLedgers` from the client's other
 * approved statements (their bank ledger names) and the operator's
 * manually-maintained cash ledgers. `currentBankLedger` is the ledger
 * attached to the statement being exported — we must NOT self-contra.
 * Match is case-insensitive and trimmed.
 */
export function classifyVoucherType(input: {
  direction: Direction
  counterLedger: string | null
  ownBankCashLedgers: Set<string>
  currentBankLedger: string | null
}): string {
  const name = (input.counterLedger ?? '').trim().toLowerCase()
  if (!name) return defaultVoucherType(input.direction)
  const current = (input.currentBankLedger ?? '').trim().toLowerCase()
  if (name === current) return defaultVoucherType(input.direction)  // self-contra, impossible
  const own = new Set([...input.ownBankCashLedgers].map((l) => l.trim().toLowerCase()))
  if (own.has(name)) return 'contra'
  // Heuristic fallback — the client picked a ledger that *looks* like
  // cash or a second bank account even though we haven't seen it on
  // another approved statement yet. The operator can always override via
  // the dropdown; the audit log records every explicit choice.
  if (/^(cash|petty\s*cash|cash in hand)\b/.test(name)) return 'contra'
  return defaultVoucherType(input.direction)
}

function compile(r: RuleRow): ((narration: string) => boolean) | null {
  const p = r.pattern.trim()
  if (!p) return null
  if (r.matchType === 'regex') {
    try { const re = new RegExp(p, 'i'); return (n) => re.test(n) } catch { return null }
  }
  const up = p.toUpperCase()
  if (r.matchType === 'exact') return (n) => n.trim().toUpperCase() === up
  return (n) => n.toUpperCase().includes(up)
}

export const AaRuleService = {
  async forClient(organisationId: string, clientId: string): Promise<RuleRow[]> {
    const rows = await prisma.aaLedgerRule.findMany({
      where: { organisationId, deletedAt: null, OR: [{ clientId }, { clientId: null }] },
      select: { id: true, clientId: true, matchType: true, pattern: true, direction: true, ledgerName: true, voucherType: true, priority: true },
    })
    // Client rules first, then firm-wide; each by priority, then longest pattern (most specific).
    return rows.sort((a, b) => Number(a.clientId === null) - Number(b.clientId === null) || a.priority - b.priority || b.pattern.length - a.pattern.length)
  },

  match(rules: RuleRow[], narration: string, direction: Direction): RuleRow | null {
    for (const r of rules) {
      if (r.direction !== 'any' && r.direction !== direction) continue
      const test = compile(r)
      if (test?.(narration)) return r
    }
    return null
  },

  validate(input: { match_type?: string; pattern?: string; direction?: string; ledger_name?: string; voucher_type?: string | null }) {
    const matchType = input.match_type ?? 'contains'
    if (!['contains', 'exact', 'regex'].includes(matchType)) throw ApiError.badRequest('match_type is contains, exact or regex.')
    const pattern = (input.pattern ?? '').trim()
    if (!pattern || pattern.length > 200) throw ApiError.badRequest('Pattern is required (up to 200 characters).')
    if (matchType === 'regex') { try { new RegExp(pattern, 'i') } catch { throw ApiError.badRequest('That regular expression is not valid.') } }
    const direction = input.direction ?? 'any'
    if (!['any', 'withdrawal', 'deposit'].includes(direction)) throw ApiError.badRequest('direction is any, withdrawal or deposit.')
    const ledgerName = (input.ledger_name ?? '').trim()
    if (!ledgerName || ledgerName.length > 120) throw ApiError.badRequest('Ledger name is required (up to 120 characters).')
    const voucherType = input.voucher_type ?? null
    if (voucherType !== null && !(VOUCHER_TYPES as readonly string[]).includes(voucherType)) throw ApiError.badRequest('voucher_type is payment, receipt, contra or journal.')
    return { matchType, pattern, direction, ledgerName, voucherType }
  },
}
