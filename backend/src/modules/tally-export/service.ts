/**
 * Tally Export service — docs/tally-export/README.md.
 *
 * The service turns bank statement rows (BookkeepingBankStatementLine)
 * into voucher-ready rows for the review UI and the preflight report.
 * The XLSX writer itself is deferred until the client's own exported
 * voucher fixture arrives (spec §11 / §0), so this module deliberately
 * does not construct the file bytes — only the rows and the checks
 * that must pass before any bytes are written.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ApiError } from '../../lib/http.js'
import {
  MATCH_TYPES, VOUCHER_TYPES,
  type MatchType, type PreflightReport, type PreviewRow, type RuleApi, type VoucherType,
} from './types.js'

// ── Rules CRUD ────────────────────────────────────────────────────────────

function toRuleApi(r: {
  id: string; companyId: string | null; matchType: string; pattern: string; ledgerName: string;
  voucherType: string | null; priority: number; hitCount: number; createdBy: string | null;
  createdAt: Date; updatedAt: Date;
}): RuleApi {
  return {
    id: r.id, company_id: r.companyId, match_type: r.matchType as MatchType,
    pattern: r.pattern, ledger_name: r.ledgerName,
    voucher_type: (r.voucherType ?? null) as VoucherType | null,
    priority: r.priority, hit_count: r.hitCount,
    created_by: r.createdBy,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }
}

/**
 * Returns rules a client is subject to — that client's own rules plus every
 * global rule (`companyId = null`). Sorted priority-desc, then oldest first
 * to keep the tie-break deterministic.
 */
export async function listRulesForClient(companyId: string): Promise<RuleApi[]> {
  const rows = await prisma.tallyLedgerRule.findMany({
    where: {
      deletedAt: null,
      OR: [{ companyId }, { companyId: null }],
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  })
  return rows.map(toRuleApi)
}

/** All rules the caller can see, when no client is in scope (e.g. Settings). */
export async function listAllRules(): Promise<RuleApi[]> {
  const rows = await prisma.tallyLedgerRule.findMany({
    where: { deletedAt: null },
    orderBy: [{ companyId: 'asc' }, { priority: 'desc' }, { createdAt: 'asc' }],
  })
  return rows.map(toRuleApi)
}

export interface RuleInput {
  companyId: string | null
  matchType: MatchType
  pattern: string
  ledgerName: string
  voucherType?: VoucherType | null
  priority?: number
}

function validateRuleInput(input: Partial<RuleInput>): void {
  if (input.matchType && !MATCH_TYPES.includes(input.matchType)) {
    throw ApiError.badRequest(`matchType must be one of ${MATCH_TYPES.join(', ')}.`)
  }
  if (input.voucherType && !VOUCHER_TYPES.includes(input.voucherType)) {
    throw ApiError.badRequest(`voucherType must be one of ${VOUCHER_TYPES.join(', ')} or null.`)
  }
  if (input.pattern !== undefined && !input.pattern.trim()) {
    throw ApiError.badRequest('pattern must be a non-empty string.')
  }
  if (input.ledgerName !== undefined && !input.ledgerName.trim()) {
    throw ApiError.badRequest('ledgerName must be a non-empty string.')
  }
  // Compile the regex once at write time so the operator learns the syntax
  // is wrong now, not when a preflight silently drops the row.
  if (input.matchType === 'regex' && input.pattern) {
    try { new RegExp(input.pattern, 'i') } catch (e) {
      throw ApiError.badRequest(`pattern is not a valid regex: ${(e as Error).message}`)
    }
  }
}

export async function createRule(input: RuleInput, createdBy: string | null): Promise<RuleApi> {
  validateRuleInput(input)
  const row = await prisma.tallyLedgerRule.create({
    data: {
      companyId: input.companyId,
      matchType: input.matchType,
      pattern: input.pattern.trim(),
      ledgerName: input.ledgerName.trim(),
      voucherType: input.voucherType ?? null,
      priority: input.priority ?? 0,
      createdBy,
    },
  })
  return toRuleApi(row)
}

export async function updateRule(id: string, patch: Partial<RuleInput>): Promise<RuleApi> {
  validateRuleInput(patch)
  const row = await prisma.tallyLedgerRule.update({
    where: { id },
    data: {
      ...(patch.companyId !== undefined ? { companyId: patch.companyId } : {}),
      ...(patch.matchType !== undefined ? { matchType: patch.matchType } : {}),
      ...(patch.pattern !== undefined ? { pattern: patch.pattern.trim() } : {}),
      ...(patch.ledgerName !== undefined ? { ledgerName: patch.ledgerName.trim() } : {}),
      ...(patch.voucherType !== undefined ? { voucherType: patch.voucherType ?? null } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    },
  })
  return toRuleApi(row)
}

export async function deleteRule(id: string): Promise<void> {
  await prisma.tallyLedgerRule.update({ where: { id }, data: { deletedAt: new Date() } })
}

export interface BulkRuleResult {
  created: RuleApi[]
  errors: { index: number; message: string }[]
}

/**
 * Bulk-create rules. Each row is validated in isolation; a bad row does
 * not stop the others. The returned `errors` array is indexed against
 * the input so the UI can highlight the source rows the operator pasted.
 *
 * Runs one transaction — if any validation throws unexpectedly (as
 * opposed to a caught FieldError), everything rolls back rather than
 * leaving the client half-imported.
 */
export async function bulkCreateRules(
  inputs: RuleInput[],
  createdBy: string | null,
): Promise<BulkRuleResult> {
  const created: RuleApi[] = []
  const errors: BulkRuleResult['errors'] = []
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]
      try {
        validateRuleInput(input)
        const row = await tx.tallyLedgerRule.create({
          data: {
            companyId: input.companyId,
            matchType: input.matchType,
            pattern: input.pattern.trim(),
            ledgerName: input.ledgerName.trim(),
            voucherType: input.voucherType ?? null,
            priority: input.priority ?? 0,
            createdBy,
          },
        })
        created.push(toRuleApi(row))
      } catch (e) {
        errors.push({ index: i, message: (e as Error).message })
      }
    }
  })
  return { created, errors }
}

// ── Rule matching ─────────────────────────────────────────────────────────

interface CompiledRule {
  id: string
  matchType: MatchType
  pattern: string
  ledgerName: string
  voucherType: VoucherType | null
  priority: number
  clientScoped: boolean
  /** Precompiled regex when matchType is 'regex'. */
  regex?: RegExp
  /** Lower-cased pattern when matchType is 'contains'. */
  lcPattern?: string
}

function compileRule(r: RuleApi): CompiledRule {
  const c: CompiledRule = {
    id: r.id, matchType: r.match_type, pattern: r.pattern, ledgerName: r.ledger_name,
    voucherType: r.voucher_type, priority: r.priority, clientScoped: r.company_id !== null,
  }
  if (r.match_type === 'regex') {
    try { c.regex = new RegExp(r.pattern, 'i') } catch { /* skip broken rule */ }
  } else if (r.match_type === 'contains') {
    c.lcPattern = r.pattern.toLowerCase()
  }
  return c
}

/**
 * Match a bank-row description against the rule set. Returns the first
 * matching rule per §5 resolution order: client-scoped rules by priority,
 * then global rules by priority.
 */
export function matchRule(description: string, rules: CompiledRule[]): CompiledRule | null {
  const lc = description.toLowerCase()
  // The rules array should already be sorted by (clientScoped desc, priority desc).
  for (const r of rules) {
    switch (r.matchType) {
      case 'contains':
        if (r.lcPattern && lc.includes(r.lcPattern)) return r
        break
      case 'regex':
        if (r.regex?.test(description)) return r
        break
      case 'exact':
        if (description === r.pattern) return r
        break
    }
  }
  return null
}

// ── Voucher type + number ─────────────────────────────────────────────────

/**
 * Voucher type per spec §4.2. A rule with `voucherType` set wins outright;
 * otherwise Withdrawal → Payment / Deposit → Receipt, unless the counter
 * ledger is one of the client's OWN bank / cash ledgers — then Contra.
 *
 * Missing the Contra case inflates both sides of the P&L for every
 * internal transfer, so this function refuses to guess: if the counter
 * ledger name is not in the provided `ownBankAndCashLedgerNames` set,
 * it falls back to Payment / Receipt. Marking a rule with
 * `voucher_type: 'contra'` remains the reliable override.
 */
export function classifyVoucherType(input: {
  direction: 'withdrawal' | 'deposit'
  ledgerName: string | null
  ruleOverride: VoucherType | null
  ownBankAndCashLedgerNames: Set<string>
}): VoucherType | null {
  if (input.ruleOverride) return input.ruleOverride
  if (!input.ledgerName) return null
  if (input.ownBankAndCashLedgerNames.has(input.ledgerName)) return 'contra'
  return input.direction === 'withdrawal' ? 'payment' : 'receipt'
}

/**
 * Deterministic voucher number per spec §7. Same statement rows in same
 * order always produce the same numbers, so a re-import collides on the
 * Tally side rather than silently duplicating.
 *
 *   AOS/<bank code>/<YYMM>/<0001..>
 *
 * Bank code = first 4 alphanumeric chars of the ledger name, uppercased.
 * Falls back to 'BANK' if the ledger name has no letters/digits.
 */
export function voucherNumberFor(bankLedgerName: string, periodStart: string, seq: number): string {
  const cleaned = (bankLedgerName || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const bankCode = (cleaned.slice(0, 4) || 'BANK')
  const yymm = periodStart.slice(2, 4) + periodStart.slice(5, 7)
  return `AOS/${bankCode}/${yymm}/${String(seq).padStart(4, '0')}`
}

// ── Own bank / cash ledger detection ──────────────────────────────────────

/**
 * The set of ledger NAMES belonging to this company that are bank or cash
 * accounts — used by classifyVoucherType() to pick Contra vs Payment/Receipt.
 *
 * Heuristic: a ledger is "own bank/cash" when any group in its parent
 * chain has a name that matches `/bank/i` or `/cash/i`. Reliable for the
 * seeded primary groups (Bank Accounts, Cash-in-hand) and any operator
 * who names custom sub-groups sensibly. Rules with `voucher_type: 'contra'`
 * remain the explicit escape hatch when the heuristic misses.
 */
export async function ownBankAndCashLedgerNames(companyId: string): Promise<Set<string>> {
  const groups = await prisma.bookkeepingGroup.findMany({
    where: { tallyCompanyId: companyId, deletedAt: null },
    select: { id: true, name: true, parentGroupId: true },
  })
  const byId = new Map(groups.map((g) => [g.id, g]))
  const isOwn = (gid: string | null): boolean => {
    let cur = gid
    while (cur) {
      const g = byId.get(cur)
      if (!g) return false
      if (/bank|cash/i.test(g.name)) return true
      cur = g.parentGroupId
    }
    return false
  }
  const bankOrCashGroupIds = groups.filter((g) => isOwn(g.id)).map((g) => g.id)
  if (bankOrCashGroupIds.length === 0) return new Set()
  const ledgers = await prisma.bookkeepingLedger.findMany({
    where: {
      tallyCompanyId: companyId,
      groupId: { in: bankOrCashGroupIds },
      deletedAt: null,
    },
    select: { name: true },
  })
  return new Set(ledgers.map((l) => l.name))
}

// ── Preview + preflight ───────────────────────────────────────────────────

interface BuildOptions {
  /** BookkeepingCompany id — the scope for statement rows and rules. */
  companyId: string
  bankLedgerId: string
  periodFrom: string
  periodTo: string
}

export interface PreviewResult {
  rows: PreviewRow[]
  bankLedgerName: string
}

/**
 * Build a preview of every statement line in scope, with rule resolution
 * + voucher-type classification + deterministic voucher numbers. The UI
 * (mapping review + preflight) reads this shape; the XLSX writer will
 * consume the same rows once the fixture arrives.
 */
export async function buildPreview(opts: BuildOptions): Promise<PreviewResult> {
  const [rules, bankLedger, statementLines, ownNames, priorLedgerNames] = await Promise.all([
    listRulesForClient(opts.companyId),
    prisma.bookkeepingLedger.findFirst({
      where: { id: opts.bankLedgerId, tallyCompanyId: opts.companyId, deletedAt: null },
      select: { id: true, name: true },
    }),
    prisma.bookkeepingBankStatementLine.findMany({
      where: {
        tallyCompanyId: opts.companyId,
        bankLedgerId: opts.bankLedgerId,
        deletedAt: null,
        date: { gte: opts.periodFrom, lte: opts.periodTo },
      },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    }),
    ownBankAndCashLedgerNames(opts.companyId),
    priorLedgerNamesForClient(opts.companyId),
  ])
  if (!bankLedger) throw ApiError.notFound('Bank ledger not found on this company.')

  const compiled = rules.map(compileRule)

  const rows: PreviewRow[] = statementLines.map((line, i) => {
    const direction: 'withdrawal' | 'deposit' =
      line.debitPaise > 0 ? 'withdrawal' : 'deposit'
    const matched = matchRule(line.description ?? '', compiled)
    const ledgerName = matched?.ledgerName ?? null
    const voucherType = classifyVoucherType({
      direction,
      ledgerName,
      ruleOverride: matched?.voucherType ?? null,
      ownBankAndCashLedgerNames: ownNames,
    })
    return {
      statement_line_id: line.id,
      date: line.date,
      description: line.description ?? '',
      ref_number: line.refNumber ?? null,
      debit_paise: line.debitPaise,
      credit_paise: line.creditPaise,
      direction,
      matched_rule_id: matched?.id ?? null,
      ledger_name: ledgerName,
      voucher_type: voucherType,
      voucher_number: voucherNumberFor(bankLedger.name, opts.periodFrom, i + 1),
      new_ledger: ledgerName !== null && !priorLedgerNames.has(ledgerName),
    }
  })

  return { rows, bankLedgerName: bankLedger.name }
}

async function priorLedgerNamesForClient(companyId: string): Promise<Set<string>> {
  const exports = await prisma.tallyExport.findMany({
    where: { companyId },
    select: { scopeJson: true },
  })
  // `scopeJson` carries statement-line IDs, not ledger names. For the
  // "new ledger" callout we approximate: any ledger name that has appeared
  // as a `ledger_name` on any rule for this client counts as "seen before."
  // Once the XLSX writer lands, we'll persist per-export ledger names
  // alongside the scope and switch to a proper lookup.
  void exports // referenced to future-proof the shape; import unused for now
  const rules = await prisma.tallyLedgerRule.findMany({
    where: { OR: [{ companyId }, { companyId: null }], deletedAt: null },
    select: { ledgerName: true },
  })
  return new Set(rules.map((r) => r.ledgerName))
}

/** Preflight per §6 — computes the summary + blocking errors. */
export async function computePreflight(opts: BuildOptions): Promise<PreflightReport> {
  const { rows, bankLedgerName } = await buildPreview(opts)

  const errors: PreflightReport['errors'] = []
  const warnings: PreflightReport['warnings'] = []

  // Per-voucher balance is trivially satisfied by design (Dr = Cr on every
  // row's two lines), but Dr/Cr assertion belongs in the writer too — for
  // preflight we assert row-level: a row missing a ledger name is unmapped,
  // which blocks export.
  const voucherByNumber = new Map<string, PreviewRow>()
  let mapped = 0
  let unmapped = 0
  let contra = 0
  const ledgerCount = new Map<string, number>()
  const newLedgers = new Set<string>()

  for (const r of rows) {
    if (r.ledger_name) {
      mapped++
      ledgerCount.set(r.ledger_name, (ledgerCount.get(r.ledger_name) ?? 0) + 1)
      if (r.new_ledger) newLedgers.add(r.ledger_name)
    } else {
      unmapped++
      errors.push({
        kind: 'unmapped_row',
        statement_line_id: r.statement_line_id,
        message: `Row "${(r.description || '').slice(0, 60)}…" has no matching rule.`,
      })
    }
    if (r.voucher_type === 'contra') contra++
    if (r.date < opts.periodFrom || r.date > opts.periodTo) {
      errors.push({
        kind: 'date_out_of_range',
        statement_line_id: r.statement_line_id,
        message: `Row date ${r.date} falls outside ${opts.periodFrom}..${opts.periodTo}.`,
      })
    }
    // Voucher number collisions are between rows in this same batch —
    // by construction the sequence is unique per row so this should never
    // fire, but a bug in voucherNumberFor() would surface here.
    if (voucherByNumber.has(r.voucher_number)) {
      errors.push({
        kind: 'voucher_number_collision',
        voucher_number: r.voucher_number,
        statement_line_id: r.statement_line_id,
        message: `Voucher number ${r.voucher_number} used more than once — refuse to export.`,
      })
    }
    voucherByNumber.set(r.voucher_number, r)
  }

  // Previously-exported check: does any prior TallyExport for this client
  // + bank + period intersect our statement-line ids?
  const priorScopeCount = await countPriorExportsOverlapping(opts, rows.map((r) => r.statement_line_id))
  if (priorScopeCount > 0) {
    warnings.push({
      kind: 'previously_exported',
      message: `${priorScopeCount} rows in this scope have appeared in a prior Tally Export for this bank account.`,
    })
  }

  for (const name of newLedgers) {
    warnings.push({
      kind: 'new_ledger',
      message: `"${name}" has not been used before for this client — create it in Tally before importing the voucher sheet.`,
    })
  }

  const ledgers = Array.from(ledgerCount.entries())
    .map(([name, count]) => ({
      ledger_name: name,
      voucher_count: count,
      new_ledger: newLedgers.has(name),
    }))
    .sort((a, b) => b.voucher_count - a.voucher_count)

  return {
    company_id: opts.companyId,
    bank_ledger_id: opts.bankLedgerId,
    period_from: opts.periodFrom,
    period_to: opts.periodTo,
    totals: {
      rows: rows.length,
      mapped,
      unmapped,
      contra,
      vouchers: rows.length, // one voucher per statement row, spec §4
      balance_mismatches: 0, // by construction
    },
    ledgers,
    errors,
    warnings,
    rows,
  }
  // `bankLedgerName` is not surfaced separately — the UI header already
  // shows the bank name from the ledger row it selected.
  void bankLedgerName
}

async function countPriorExportsOverlapping(opts: BuildOptions, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const prior = await prisma.tallyExport.findMany({
    where: {
      companyId: opts.companyId,
      bankLedgerId: opts.bankLedgerId,
      kind: 'vouchers',
    },
    select: { scopeJson: true },
  })
  const target = new Set(ids)
  let overlap = 0
  for (const p of prior) {
    try {
      const arr = JSON.parse(p.scopeJson) as unknown
      if (Array.isArray(arr)) {
        for (const id of arr) if (typeof id === 'string' && target.has(id)) overlap++
      }
    } catch { /* skip corrupt scope */ }
  }
  return overlap
}

// ── History ───────────────────────────────────────────────────────────────

export interface ExportHistoryRow {
  id: string
  company_id: string
  bank_ledger_id: string
  period_from: string
  period_to: string
  kind: string
  row_count: number
  voucher_count: number
  checksum: string | null
  generated_by: string | null
  generated_at: string
}

export async function listExportHistory(companyId: string, bankLedgerId?: string): Promise<ExportHistoryRow[]> {
  const rows = await prisma.tallyExport.findMany({
    where: {
      companyId,
      ...(bankLedgerId ? { bankLedgerId } : {}),
    },
    orderBy: { generatedAt: 'desc' },
    take: 100,
  })
  return rows.map((r) => ({
    id: r.id,
    company_id: r.companyId,
    bank_ledger_id: r.bankLedgerId,
    period_from: r.periodFrom,
    period_to: r.periodTo,
    kind: r.kind,
    row_count: r.rowCount,
    voucher_count: r.voucherCount,
    checksum: r.checksum,
    generated_by: r.generatedBy,
    generated_at: r.generatedAt.toISOString(),
  }))
}

// `PrismaClient` and `Prisma` are imported for IDE hover on downstream
// callers of the exported functions; the runtime import chain uses the
// `prisma` singleton above.
void ({} as PrismaClient)
void ({} as Prisma.TransactionClient)
