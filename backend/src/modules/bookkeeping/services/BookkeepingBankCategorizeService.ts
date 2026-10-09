import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { BookkeepingCompanyService } from './BookkeepingCompanyService.js'
import { postVoucher } from '../engine/posting.js'
import { statementLineNums } from '../engine/paise.js'

/**
 * BookkeepingBankCategorizeService — auto-categorize unmatched statement
 * lines into Receipt / Payment vouchers.
 *
 * Flow:
 *   1. proposeForLedger walks every unmatched statement line on a bank ledger
 *      and tries to resolve a counter-ledger. Order of resolution per line:
 *        a. First DB rule whose matchPattern tests true against description.
 *        b. First DEFAULT_RULE (hard-coded, below) that tests true.
 *        c. Fuzzy party-token match against existing party ledgers
 *           (Sundry Debtors / Sundry Creditors).
 *        d. Fallback: a "Suspense" ledger under Indirect Expenses — lazily
 *           created on first use so a committed proposal never fails for
 *           lack of a target.
 *      The proposal records which path matched, so the UI can show the
 *      source and let the operator override before commit.
 *   2. commitForLedger posts each proposal via postVoucher — the single
 *      writer that enforces balance / FY / uniqueness — and marks the
 *      corresponding statement line matched by linking it to the created
 *      bank entry (same contract match() uses).
 *
 * Idempotency: the status check is re-read inside the per-line transaction;
 * a second commit after a partial failure skips lines that are already
 * matched instead of double-posting.
 */

const ACTIVE = { status: 'active', ...alive }

/** Rules shipped in code. A follow-up PR adds a CRUD UI for user rules;
 *  user rows (source='user') win over these when both match a line. */
export interface DefaultRule {
  pattern: string
  label: string
  ledgerName: string
  ledgerGroup: string
  /** When set, FORCES receipt or payment regardless of debit/credit. Otherwise
   *  the posting direction is inferred from the statement line. */
  direction?: 'receipt' | 'payment'
}

export const DEFAULT_RULES: DefaultRule[] = [
  // Charges & bank-side movements.
  { pattern: 'bank\\s*charg|service\\s*charge',   label: 'Bank charges',        ledgerName: 'Bank Charges',       ledgerGroup: 'Indirect Expenses', direction: 'payment' },
  { pattern: 'interest\\s*(cred|received|earn)',  label: 'Interest income',     ledgerName: 'Interest Income',    ledgerGroup: 'Indirect Income',   direction: 'receipt' },
  { pattern: 'interest\\s*(debit|charged|paid)',  label: 'Interest paid',       ledgerName: 'Interest Paid',      ledgerGroup: 'Indirect Expenses', direction: 'payment' },
  // Statutory outflows.
  { pattern: 'gst\\s*(payment|pmt|paid)|gstr\\s*3b', label: 'GST payment',      ledgerName: 'GST Clearing',       ledgerGroup: 'Current Liabilities', direction: 'payment' },
  { pattern: 'tds\\s*(payment|pmt|paid)',         label: 'TDS payment',         ledgerName: 'TDS Payable',        ledgerGroup: 'Current Liabilities', direction: 'payment' },
  { pattern: 'advance\\s*tax|income\\s*tax',      label: 'Income tax',          ledgerName: 'Income Tax',         ledgerGroup: 'Indirect Expenses', direction: 'payment' },
  // Overheads.
  { pattern: 'rent\\b',                           label: 'Rent',                ledgerName: 'Rent',               ledgerGroup: 'Indirect Expenses', direction: 'payment' },
  { pattern: 'salary|payroll|wages',              label: 'Salary / payroll',    ledgerName: 'Salary',             ledgerGroup: 'Indirect Expenses', direction: 'payment' },
  { pattern: 'electricity|eb\\s*bill|tneb|bescom|mseb', label: 'Electricity',   ledgerName: 'Electricity',        ledgerGroup: 'Indirect Expenses', direction: 'payment' },
  { pattern: 'internet|broadband|airtel|jio|bsnl', label: 'Internet / telecom', ledgerName: 'Internet & Telephone', ledgerGroup: 'Indirect Expenses', direction: 'payment' },
  { pattern: 'water\\s*(bill|charges|supply)',    label: 'Water',               ledgerName: 'Water Charges',      ledgerGroup: 'Indirect Expenses', direction: 'payment' },
  { pattern: 'petrol|diesel|fuel',                label: 'Fuel',                ledgerName: 'Fuel Expenses',      ledgerGroup: 'Indirect Expenses', direction: 'payment' },
  { pattern: 'freight|courier|logistics|shipping', label: 'Freight / courier',  ledgerName: 'Freight & Courier',  ledgerGroup: 'Indirect Expenses', direction: 'payment' },
  { pattern: 'office\\s*(exp|supply|supplies)|stationery', label: 'Office supplies', ledgerName: 'Office Expenses', ledgerGroup: 'Indirect Expenses', direction: 'payment' },
]

/** The counter-ledger of last resort — created on demand. */
const SUSPENSE_LEDGER = { name: 'Suspense', group: 'Indirect Expenses' } as const

export type ProposalSource = 'db_rule' | 'default_rule' | 'party_match' | 'suspense'

export interface Proposal {
  lineId: string
  date: string
  description: string
  debitPaise: number
  creditPaise: number
  voucherType: 'receipt' | 'payment'
  counterLedgerId: string
  counterLedgerName: string
  source: ProposalSource
  /** Human-friendly reason — "Rule: Rent" or "Party: ACME Traders". */
  matchedBy: string
}

interface RuleRow {
  id: string
  pattern: string
  compiled: RegExp
  counterLedgerId: string
  counterLedgerName: string
  direction: 'auto' | 'receipt' | 'payment'
  priority: number
  source: 'seed' | 'user'
  label: string | null
}

/** Case-insensitive regex. Returns null if the pattern is unparseable so one
 *  bad user row cannot kill a propose() run. */
function compileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}

function validateRegex(pattern: string): void {
  try {
    new RegExp(pattern, 'i')
  } catch (e) {
    throw ApiError.badRequest(`matchPattern is not a valid regex: ${(e as Error).message}`)
  }
}

async function loadDbRules(companyId: string): Promise<RuleRow[]> {
  const rows = await prisma.bookkeepingBankCategorizeRule.findMany({
    where: { tallyCompanyId: companyId, enabled: true, ...alive },
    include: { counterLedger: { select: { id: true, name: true } } },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  })
  return rows
    .map((r): RuleRow | null => {
      const compiled = compileRegex(r.matchPattern)
      if (!compiled) return null
      return {
        id: r.id,
        pattern: r.matchPattern,
        compiled,
        counterLedgerId: r.counterLedger.id,
        counterLedgerName: r.counterLedger.name,
        direction: r.direction as 'auto' | 'receipt' | 'payment',
        priority: r.priority,
        source: r.source as 'seed' | 'user',
        label: r.label,
      }
    })
    .filter((r): r is RuleRow => r !== null)
}

async function groupIdByName(companyId: string, name: string): Promise<string | null> {
  const g = await prisma.bookkeepingGroup.findFirst({
    where: { tallyCompanyId: companyId, name, ...alive },
    select: { id: true },
  })
  return g?.id ?? null
}

async function findOrCreateLedger(
  companyId: string,
  ledgerName: string,
  groupName: string,
): Promise<{ id: string; name: string } | null> {
  const existing = await prisma.bookkeepingLedger.findFirst({
    where: { tallyCompanyId: companyId, name: ledgerName, ...alive },
    select: { id: true, name: true },
  })
  if (existing) return existing
  const groupId = await groupIdByName(companyId, groupName)
  if (!groupId) return null
  try {
    const created = await prisma.bookkeepingLedger.create({
      data: { tallyCompanyId: companyId, name: ledgerName, groupId },
      select: { id: true, name: true },
    })
    return created
  } catch {
    // Race: another request created the ledger between find and create.
    const after = await prisma.bookkeepingLedger.findFirst({
      where: { tallyCompanyId: companyId, name: ledgerName, ...alive },
      select: { id: true, name: true },
    })
    return after
  }
}

/** Tokenise a bank-statement description for party-name matching. Strips
 *  common transfer prefixes (NEFT, RTGS, IMPS, UPI, …) and reference-looking
 *  tokens (all-digit, alphanumeric-with-digits) that would otherwise pollute
 *  the match. */
function descriptionTokens(desc: string): string[] {
  const STOP = new Set([
    'neft', 'rtgs', 'imps', 'upi', 'ach', 'ecs', 'nach', 'inw', 'out',
    'tr', 'trf', 'txn', 'ref', 'inv', 'bill', 'chq', 'cheque', 'cash',
    'to', 'from', 'by', 'via', 'the', 'a', 'an',
  ])
  return desc
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t) && !/^[a-z]*\d/.test(t))
}

async function loadPartyLedgers(companyId: string): Promise<{ id: string; name: string; tokens: string[] }[]> {
  const debtorId = await groupIdByName(companyId, 'Sundry Debtors')
  const creditorId = await groupIdByName(companyId, 'Sundry Creditors')
  const groupIds = [debtorId, creditorId].filter((v): v is string => Boolean(v))
  if (groupIds.length === 0) return []
  const rows = await prisma.bookkeepingLedger.findMany({
    where: { tallyCompanyId: companyId, groupId: { in: groupIds }, ...alive },
    select: { id: true, name: true },
  })
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    tokens: r.name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3),
  }))
}

/** Count how many party-ledger tokens appear in the description tokens. */
function partyMatchScore(partyTokens: string[], descTokens: Set<string>): number {
  let hits = 0
  for (const t of partyTokens) if (descTokens.has(t)) hits++
  return hits
}

function voucherDirectionFor(line: { debitPaise: number; creditPaise: number }, hint?: 'receipt' | 'payment' | 'auto'): 'receipt' | 'payment' {
  if (hint && hint !== 'auto') return hint
  return line.creditPaise > 0 ? 'receipt' : 'payment'
}

export const BookkeepingBankCategorizeService = {
  // ── Rules CRUD ──────────────────────────────────────────────────────

  async listRules(session: Session, companyId: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const rows = await prisma.bookkeepingBankCategorizeRule.findMany({
      where: { tallyCompanyId: companyId, ...alive },
      include: { counterLedger: { select: { id: true, name: true } } },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    })
    return rows.map((r) => ({
      id: r.id,
      match_pattern: r.matchPattern,
      counter_ledger_id: r.counterLedger.id,
      counter_ledger_name: r.counterLedger.name,
      direction: r.direction,
      priority: r.priority,
      source: r.source,
      enabled: r.enabled,
      label: r.label,
      created_at: r.createdAt.toISOString(),
    }))
  },

  async createRule(
    session: Session,
    companyId: string,
    input: { matchPattern: string; counterLedgerId: string; direction?: 'auto' | 'receipt' | 'payment'; priority?: number; label?: string | null },
  ) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    validateRegex(input.matchPattern)
    const ledger = await prisma.bookkeepingLedger.findFirst({
      where: { id: input.counterLedgerId, tallyCompanyId: companyId, ...alive }, select: { id: true },
    })
    if (!ledger) throw ApiError.notFound('No such counter ledger on this company.')
    const row = await prisma.bookkeepingBankCategorizeRule.create({
      data: {
        tallyCompanyId: companyId,
        matchPattern: input.matchPattern,
        counterLedgerId: input.counterLedgerId,
        direction: input.direction ?? 'auto',
        priority: input.priority ?? 100,
        source: 'user',
        label: input.label ?? null,
      },
      select: { id: true },
    })
    return { id: row.id }
  },

  async updateRule(
    session: Session,
    companyId: string,
    ruleId: string,
    patch: { matchPattern?: string; counterLedgerId?: string; direction?: 'auto' | 'receipt' | 'payment'; priority?: number; label?: string | null; enabled?: boolean },
  ) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const existing = await prisma.bookkeepingBankCategorizeRule.findFirst({
      where: { id: ruleId, tallyCompanyId: companyId, ...alive }, select: { id: true },
    })
    if (!existing) throw ApiError.notFound('No such rule.')
    if (patch.matchPattern !== undefined) validateRegex(patch.matchPattern)
    if (patch.counterLedgerId !== undefined) {
      const l = await prisma.bookkeepingLedger.findFirst({
        where: { id: patch.counterLedgerId, tallyCompanyId: companyId, ...alive }, select: { id: true },
      })
      if (!l) throw ApiError.notFound('No such counter ledger on this company.')
    }
    await prisma.bookkeepingBankCategorizeRule.update({
      where: { id: ruleId },
      data: {
        ...(patch.matchPattern !== undefined ? { matchPattern: patch.matchPattern } : {}),
        ...(patch.counterLedgerId !== undefined ? { counterLedgerId: patch.counterLedgerId } : {}),
        ...(patch.direction !== undefined ? { direction: patch.direction } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      },
    })
    return { id: ruleId }
  },

  async deleteRule(session: Session, companyId: string, ruleId: string) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const existing = await prisma.bookkeepingBankCategorizeRule.findFirst({
      where: { id: ruleId, tallyCompanyId: companyId, ...alive }, select: { id: true },
    })
    if (!existing) throw ApiError.notFound('No such rule.')
    await prisma.bookkeepingBankCategorizeRule.update({ where: { id: ruleId }, data: { deletedAt: new Date() } })
    return { id: ruleId }
  },

  // ── Propose + Commit ────────────────────────────────────────────────

  /** Build a proposal per unmatched line on this bank ledger. */
  async proposeForLedger(session: Session, companyId: string, bankLedgerId: string): Promise<{ proposals: Proposal[]; unresolvedCount: number }> {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const bank = await prisma.bookkeepingLedger.findFirst({
      where: { id: bankLedgerId, tallyCompanyId: companyId, ...alive },
      select: { id: true },
    })
    if (!bank) throw ApiError.notFound('No such bank ledger.')

    const lines = (await prisma.bookkeepingBankStatementLine.findMany({
      where: { tallyCompanyId: companyId, bankLedgerId, status: 'unmatched', ...alive },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    })).map(statementLineNums)
    if (lines.length === 0) return { proposals: [], unresolvedCount: 0 }

    const dbRules = await loadDbRules(companyId)
    const defaultRules = DEFAULT_RULES.map((r) => ({ ...r, compiled: compileRegex(r.pattern) })).filter((r) => r.compiled)
    const parties = await loadPartyLedgers(companyId)

    // Resolve each default-rule ledger lazily — but only when we actually
    // need it. Cache keyed by ledger name to avoid repeated DB lookups.
    const ledgerCache = new Map<string, { id: string; name: string } | null>()
    const resolveLedger = async (name: string, group: string): Promise<{ id: string; name: string } | null> => {
      if (ledgerCache.has(name)) return ledgerCache.get(name) ?? null
      const l = await findOrCreateLedger(companyId, name, group)
      ledgerCache.set(name, l)
      return l
    }

    const proposals: Proposal[] = []
    let unresolved = 0

    for (const line of lines) {
      const desc = line.description ?? ''
      let counter: { id: string; name: string } | null = null
      let source: ProposalSource = 'suspense'
      let matchedBy = ''
      let directionHint: 'auto' | 'receipt' | 'payment' = 'auto'

      // 1) DB rules (user rules win over seeds; seeds win over defaults).
      for (const r of dbRules) {
        if (!r.compiled.test(desc)) continue
        counter = { id: r.counterLedgerId, name: r.counterLedgerName }
        directionHint = r.direction
        source = 'db_rule'
        matchedBy = r.label ?? `Rule: ${r.pattern}`
        break
      }

      // 2) Hard-coded default rules.
      if (!counter) {
        for (const r of defaultRules) {
          if (!r.compiled!.test(desc)) continue
          const l = await resolveLedger(r.ledgerName, r.ledgerGroup)
          if (!l) continue // group doesn't exist on this company — try next rule
          counter = l
          directionHint = r.direction ?? 'auto'
          source = 'default_rule'
          matchedBy = `Default: ${r.label}`
          break
        }
      }

      // 3) Party-token fuzzy match.
      if (!counter && parties.length > 0) {
        const descTokens = new Set(descriptionTokens(desc))
        if (descTokens.size > 0) {
          let bestScore = 0
          let best: typeof parties[number] | null = null
          for (const p of parties) {
            const score = partyMatchScore(p.tokens, descTokens)
            if (score > bestScore) { bestScore = score; best = p }
          }
          if (best && bestScore >= 1) {
            counter = { id: best.id, name: best.name }
            source = 'party_match'
            matchedBy = `Party: ${best.name}`
          }
        }
      }

      // 4) Suspense fallback — create on first hit.
      if (!counter) {
        const l = await resolveLedger(SUSPENSE_LEDGER.name, SUSPENSE_LEDGER.group)
        if (l) {
          counter = l
          source = 'suspense'
          matchedBy = 'Unmatched — review and re-categorize'
        } else {
          // Indirect Expenses group doesn't exist on this company; cannot
          // post without a counter-ledger. Mark unresolved and move on.
          unresolved++
          continue
        }
      }

      proposals.push({
        lineId: line.id,
        date: line.date,
        description: desc,
        debitPaise: line.debitPaise,
        creditPaise: line.creditPaise,
        voucherType: voucherDirectionFor(line, directionHint),
        counterLedgerId: counter.id,
        counterLedgerName: counter.name,
        source,
        matchedBy,
      })
    }

    return { proposals, unresolvedCount: unresolved }
  },

  /** Post the given proposals, one voucher per line, inside its own transaction. */
  async commitProposals(
    session: Session,
    companyId: string,
    bankLedgerId: string,
    proposals: { lineId: string; counterLedgerId: string; voucherType: 'receipt' | 'payment' }[],
  ) {
    await BookkeepingCompanyService.requireOwned(session, companyId)
    const bank = await prisma.bookkeepingLedger.findFirst({
      where: { id: bankLedgerId, tallyCompanyId: companyId, ...alive },
      select: { id: true, name: true },
    })
    if (!bank) throw ApiError.notFound('No such bank ledger.')

    let posted = 0
    let skipped = 0
    const errors: { lineId: string; message: string }[] = []

    for (const p of proposals) {
      try {
        // 1) Pre-flight read. Re-check status so a second commit skips lines
        //    already matched by a prior partial run.
        const row = await prisma.bookkeepingBankStatementLine.findFirst({
          where: { id: p.lineId, tallyCompanyId: companyId, bankLedgerId, ...alive },
        })
        const line = row && statementLineNums(row)
        if (!line) throw ApiError.notFound('No such statement line.')
        if (line.status === 'matched') { skipped++; continue }
        const counter = await prisma.bookkeepingLedger.findFirst({
          where: { id: p.counterLedgerId, tallyCompanyId: companyId, ...alive }, select: { id: true },
        })
        if (!counter) throw ApiError.notFound('Counter ledger not on this company.')

        // 2) Direction mapping:
        //      Receipt — bank credit, money in.  Dr Bank, Cr Counter.
        //      Payment — bank debit,  money out. Dr Counter, Cr Bank.
        const isReceipt = p.voucherType === 'receipt'
        const amountPaise = isReceipt ? line.creditPaise : line.debitPaise
        if (amountPaise <= 0) {
          throw ApiError.unprocessable('direction_mismatch', `Statement line direction does not match ${p.voucherType}.`)
        }
        const bankEntry = { ledgerId: bankLedgerId, entryType: (isReceipt ? 'dr' : 'cr') as 'dr' | 'cr', amountPaise }
        const counterEntry = { ledgerId: p.counterLedgerId, entryType: (isReceipt ? 'cr' : 'dr') as 'dr' | 'cr', amountPaise }

        // 3) Post via the single writer. postVoucher wraps its own
        //    transaction and enforces balance / FY / numbering.
        const voucher = await postVoucher(
          companyId,
          {
            voucherTypeCode: p.voucherType,
            date: line.date,
            referenceNumber: line.refNumber,
            narration: `Auto-categorized from bank statement: ${line.description}`,
            entries: [bankEntry, counterEntry],
          },
          session.userId,
        )

        // 4) Link the bank-side voucher entry to the statement line so the
        //    reconciliation UI shows it matched. Same contract as match().
        await prisma.$transaction(async (tx) => {
          const bankSide = await tx.bookkeepingVoucherEntry.findFirst({
            where: { voucherId: voucher.id, ledgerId: bankLedgerId },
            select: { id: true },
          })
          if (bankSide) {
            await tx.bookkeepingVoucherEntry.update({
              where: { id: bankSide.id },
              data: {
                bankStatementLineId: p.lineId,
                bankDate: line.date,
                reconciledAt: new Date(),
                reconciledByUserId: session.userId,
              },
            })
          }
          await tx.bookkeepingBankStatementLine.update({
            where: { id: p.lineId },
            data: { status: 'matched', matchedAt: new Date(), matchedByUserId: session.userId },
          })
        })

        posted++
      } catch (e) {
        errors.push({ lineId: p.lineId, message: (e as Error).message })
      }
    }

    return { posted, skipped, errorCount: errors.length, errors: errors.slice(0, 20) }
  },
}
